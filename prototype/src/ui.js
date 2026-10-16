/**
 * DOM 界面层
 *
 * 为什么 UI 用 DOM 而不是 Canvas：
 *   三选一卡片需要文字换行、滚动、悬停反馈、无障碍点击区——这些用 DOM 成本几乎为零，
 *   用 Canvas 手搓要写一套文字排版与命中检测。灰盒阶段「改文案要几秒」比「渲染一致性」重要得多。
 *   战场用 Canvas（每帧重绘），菜单用 DOM（按需重绘），各取所长。
 *
 * 本文件不包含任何游戏规则：它只把 core 的状态翻译成像素与文字。
 */

import { isRestOption } from '../../core/src/deck.js';
import { isSurvivalCard } from '../../core/src/stats.js';
import { breakthroughCost, clearRate, isMaxRealm, realmName } from '../../core/src/meta.js';

/** 按 id 取元素 */
const el = (id) => document.getElementById(id);

/** 效果类型 -> 中文可读文案 */
const EFFECT_FORMATTERS = {
  atkPct: (v) => `攻击 +${pct(v)}`,
  spdPct: (v) => `攻速 +${pct(v)}`,
  chain: (v) => `同时命中 +${v} 目标`,
  critRate: (v) => `暴击率 +${pct(v)}`,
  critDmg: (v) => `暴击伤害 +${pct(v)}`,
  flatDps: (v) => `固定伤害 +${v}/秒`,
  hpPct: (v) => `生命上限 +${pct(v)}`,
  dmgReduce: (v) => `受到伤害 -${pct(v)}`,
  healOnKill: (v) => `击杀回复 +${(v * 100).toFixed(1)}%`,
};

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

/** 把一组效果翻译成标签数组 */
function effectTags(card) {
  return (card.effects ?? []).map((e) => ({
    text: (EFFECT_FORMATTERS[e.type] ?? ((v) => `${e.type} ${v}`))(e.value),
    survival: isSurvivalCard({ effects: [e] }),
  }));
}

/** 稀有度文案 */
function tierLabel(tier) {
  return tier >= 2 ? '稀有' : '常见';
}

/** 秒数 -> mm:ss */
export function mmss(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 切换屏幕：同一时刻只有一个 .screen 可见 */
export function showScreen(id) {
  const screens = document.querySelectorAll('.screen');
  screens.forEach((s) => s.classList.toggle('hidden', s.id !== id));
}

/** 隐藏所有覆盖层（回到纯战斗画面） */
export function hideScreens() {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
}

/** HUD 显隐 */
export function showHud(on) {
  el('hud').classList.toggle('hidden', !on);
}

// ============================================================
// HUD
// ============================================================

/**
 * 刷新战斗 HUD
 * @param {any} state battle.getState()
 * @param {{ realm: number }} meta
 * @param {any} data
 */
export function renderHud(state, meta, data) {
  el('hud-realm').textContent = realmName(meta.realm, data);
  el('hud-wave').textContent = String(state.wave);
  // 波次总数一律从数值表读，不要在 HTML 或这里写死——写死过一次，HUD 显示成「第 18 / 12 波」
  el('hud-waves-total').textContent = `/ ${state.wavesTotal} 波`;
  el('hud-spirit').textContent = String(state.spirit);

  const ratio = state.maxHp > 0 ? Math.max(0, state.hp / state.maxHp) : 0;
  const fill = el('hud-hp');
  fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  fill.classList.toggle('warn', ratio <= 0.5 && ratio > 0.22);
  fill.classList.toggle('bad', ratio <= 0.22);
  el('hud-hptext').textContent = `${Math.ceil(state.hp)} / ${Math.round(state.maxHp)}`;

  // 本波残余：以剩余血量占比近似「还剩多少要打」
  const left = state.waveTotal > 0 ? state.waveHpLeft / state.waveTotal : 0;
  el('hud-waveprog').style.width = `${(left * 100).toFixed(1)}%`;
  el('hud-wavelabel').textContent =
    state.isBossWave && state.waveTotal > 0
      ? `秘境之主 · 残余 ${Math.round(left * 100)}%`
      : `本波残余 ${Math.round(left * 100)}%`;

  const timer = el('hud-timer');
  timer.textContent = state.waveTimeLeft.toFixed(1);
  timer.classList.toggle('urgent', state.waveTimeLeft <= 5);
}

/** 弹一条居中横幅（Boss 警告 / 过关） */
export function banner(text, variant = '') {
  const node = document.createElement('div');
  node.className = `banner ${variant}`;
  node.textContent = text;
  el('stage').appendChild(node);
  setTimeout(() => node.remove(), 1600);
}

// ============================================================
// 右侧信息栏
// ============================================================

export function renderSide(state, meta, data) {
  if (!state) {
    el('side-status').textContent = '未开局';
  } else {
    el('side-status').innerHTML = [
      `第 <b>${state.wave}</b> / ${state.wavesTotal} 波${state.isBossWave ? '（秘境之主）' : ''}`,
      `生命 ${Math.ceil(state.hp)} / ${Math.round(state.maxHp)}`,
      `击杀 ${state.kills} · 灵石 ${state.spirit}`,
    ].join('<br />');
  }

  // 构筑：按流派聚合层数
  if (state && state.owned.length > 0) {
    const bySchool = new Map();
    for (const [id, n] of state.owned) {
      const card = data.cards.find((c) => c.id === id);
      if (!card) continue;
      bySchool.set(card.school, (bySchool.get(card.school) ?? 0) + n);
    }
    const total = [...bySchool.values()].reduce((a, b) => a + b, 0);
    el('side-build').innerHTML = [...bySchool.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(
        ([school, n]) =>
          `<div class="sb-row"><span>${school}</span><b>${n} 层 · ${Math.round((n / total) * 100)}%</b></div>`,
      )
      .join('');
  } else {
    el('side-build').textContent = '—';
  }

  // 属性
  const s = state?.stats;
  el('side-stats').innerHTML = s
    ? [
        ['每秒伤害', s.dps.toFixed(1)],
        ['同时目标', String(s.targets)],
        ['攻击倍率', `${s.atkMul.toFixed(2)}×`],
        ['攻速倍率', `${s.spdMul.toFixed(2)}×`],
        ['暴击率 / 暴伤', `${pct(s.critRate)} / ${pct(s.critDmg)}`],
        ['固定伤害', s.flatDps.toFixed(1)],
        ['减伤', pct(s.dmgReduce)],
        ['生命上限', Math.round(s.maxHp).toString()],
      ]
        .map(([k, v]) => `<div class="ss-row"><span>${k}</span><span>${v}</span></div>`)
        .join('')
    : '—';
}

// ============================================================
// 大世界
// ============================================================

/**
 * 渲染大世界（壳）界面
 * @param {{ meta: any, data: any }} ctx
 * @param {{ onStart: Function, onBreakthrough: Function, onCodex: Function, onDebug: Function }} handlers
 */
export function renderWorld({ meta, data }, handlers) {
  // 版本号从数值表读，而不是写死在 HTML 里——否则每次改数值都会留下一句过期的副标题
  // 「怎么玩」里的波数同样按数值表生成，避免和 HUD 说的不是一回事
  const howtoWaves = el('howto-waves');
  if (howtoWaves) {
    howtoWaves.innerHTML = `<b>一局 ${data.base.waves} 波</b>，每清空一波可以选一门功法，第 ${data.enemy.bossWave} 波是秘境之主`;
  }
  // 副标题里报的是**设计目标区间**，不是「波数 × 波次上限」那个理论上限。
  // 之前报的是后者（9.9 分钟），而真实一局是 7 分钟左右——UI 上出现了一个
  // 和实际体验对不上的数字，玩家第一次通关就会发现。
  el('world-subtitle').textContent = `灰盒试玩版 v${data.version} · 一局 6-10 分钟 · 单局 Roguelike`;

  el('world-realm').textContent = realmName(meta.realm, data);
  el('world-spirit').textContent = String(meta.spirit);

  const st = meta.stats;
  el('world-stats').textContent =
    st.runs === 0
      ? '尚未出过手'
      : `${st.runs} 局 · 通关 ${st.clears} 局（${Math.round(clearRate(meta) * 100)}%）· 最远第 ${st.bestWave} 波${st.bestRunSeconds > 0 ? ` · 最快 ${mmss(st.bestRunSeconds)}` : ''}`;

  const cost = breakthroughCost(meta, data);
  const maxed = isMaxRealm(meta, data);
  const affordable = meta.spirit >= cost;

  el('world-nodes').innerHTML = '';
  el('world-nodes').append(
    makeNode({
      icon: '境',
      name: '秘 境',
      desc: `${data.base.waves} 波敌人，波间三选一强化。`,
      tail: st.bestWave > 0 ? `最远 ${st.bestWave} / ${data.base.waves} 波` : '尚未进入',
      primary: true,
      onClick: handlers.onStart,
    }),
    makeNode({
      icon: '坊',
      name: '坊 市',
      desc: maxed
        ? '已至大乘，此界再无可破之关。'
        : `${realmName(meta.realm, data)} → ${realmName(meta.realm + 1, data)}：永久 +${pct(
            data.meta.realmAtkBonus,
          )} 攻击 / +${pct(data.meta.realmHpBonus)} 生命。`,
      tail: maxed ? '已至极境' : `需 ${cost} 灵石`,
      gold: true,
      disabled: maxed || !affordable,
      onClick: handlers.onBreakthrough,
    }),
  );

  el('btn-codex').onclick = handlers.onCodex;
  el('btn-debug').onclick = handlers.onDebug;
}

function makeNode({ icon, name, desc, tail, onClick, disabled = false, gold = false, primary = false }) {
  const btn = document.createElement('button');
  btn.className = 'node';
  btn.disabled = disabled;
  btn.innerHTML = `
    <div class="node-icon ${gold ? 'gold' : ''}">${icon}</div>
    <div class="node-body">
      <div class="node-name">${name}</div>
      <div class="node-desc">${desc}</div>
    </div>
    <div class="node-tail">${tail}</div>
  `;
  if (!disabled) btn.onclick = onClick;
  // primary 目前只是语义标记，样式与普通节点一致
  if (primary) btn.dataset.primary = '1';
  return btn;
}

// ============================================================
// 三选一
// ============================================================

/**
 * 渲染三选一
 * @param {any[]} choices
 * @param {{ owned: Array<[string, number]>, isOpening: boolean, wave: number, data: any }} ctx
 * @param {(id: string) => void} onPick
 */
export function renderUpgrade(choices, ctx, onPick) {
  const { owned, isOpening, wave, data } = ctx;

  el('upgrade-title').textContent = isOpening ? '入 门 功 法' : '择 一 而 修';
  el('upgrade-sub').textContent = isOpening
    ? '第一波之前 · 选一门功法起手，本次选择决定这一局的底子'
    : `第 ${wave} 波清空后 · 你已经做了 ${owned.reduce((n, [, c]) => n + c, 0)} 次选择`;

  const gains = ctx.gains ?? {};

  const box = el('upgrade-cards');
  box.innerHTML = '';
  for (const card of choices) {
    box.append(makeCard(card, data, owned, gains[card.id], onPick));
  }

  el('upgrade-current').textContent = summarizeBuild(owned, data);
}

function makeCard(card, data, owned, gainText, onPick) {
  const btn = document.createElement('button');
  const rest = isRestOption(card);
  btn.className = `card${rest ? ' rest' : ''}`;

  const tags = rest ? [] : effectTags(card);
  const stack = rest ? 0 : owned.find(([id]) => id === card.id)?.[1] ?? 0;

  btn.innerHTML = `
    <div class="card-top">
      <div class="card-name">${card.name}</div>
      ${rest ? '' : `<div class="card-school">${card.school}</div>`}
      ${rest ? '' : `<div class="card-tier">${tierLabel(card.tier)}</div>`}
    </div>
    ${
      rest
        ? '<div class="card-rationale">候选功法已经拿满了。回复 15% 生命，继续下一波。</div>'
        : `<div class="card-effects">${tags
            .map((t) => `<span class="eff ${t.survival ? 'survival' : ''}">${t.text}</span>`)
            .join('')}</div>
           <div class="card-rationale">${card.rationale}</div>
           <div class="card-stack">已持有 ${stack} / ${card.maxStack} 层${
             gainText ? ` · 预计提升 ${gainText}` : ''
           }</div>`
    }
  `;
  btn.onclick = () => onPick(card.id, btn);
  return btn;
}

/** 把持有表汇总成一句可读的构筑描述 */
function summarizeBuild(owned, data) {
  if (!owned || owned.length === 0) return '当前：尚未习得功法';
  const bySchool = new Map();
  for (const [id, n] of owned) {
    const card = data.cards.find((c) => c.id === id);
    if (!card) continue;
    bySchool.set(card.school, (bySchool.get(card.school) ?? 0) + n);
  }
  const parts = [...bySchool.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s} ${n} 层`)
    .join(' · ');
  return `当前：${parts}`;
}

// ============================================================
// 结算
// ============================================================

/**
 * 渲染结算面板
 * @param {any} result battle.result()
 * @param {{ meta: any, data: any, earnedSpirit: number }} ctx
 * @param {{ onAgain: Function, onWorld: Function }} handlers
 */
export function renderResult(result, ctx, handlers) {
  const { data, meta, earnedSpirit } = ctx;
  const win = result.cleared;

  el('result-title').textContent = win ? '破 境 而 出' : '道 消 身 殒';
  el('result-title').className = `result-title ${win ? 'win' : 'lose'}`;
  el('result-sub').textContent = win
    ? `秘境之主已伏诛 · 用时 ${mmss(result.runTime)}`
    : `倒在第 ${result.reachedWave} 波 · 距秘境之主还有 ${data.base.waves - result.reachedWave} 波`;

  const stats = [
    ['推进波次', `${result.reachedWave} / ${result.wavesTotal}`],
    ['击杀', String(result.kills)],
    ['用时', mmss(result.runTime)],
    ['本局灵石', `+${earnedSpirit}`],
    ['残余生命', `${result.maxHp > 0 ? Math.round((result.hp / result.maxHp) * 100) : 0}%`],
    ['强化次数', String(result.picks.length)],
  ];
  el('result-grid').innerHTML = stats
    .map(
      ([k, v]) =>
        `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v ${
          k === '本局灵石' ? 'gold' : ''
        }">${v}</div></div>`,
    )
    .join('');

  // 构筑：按卡牌聚合层数
  const counts = new Map();
  for (const p of result.picks) {
    counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
  }
  el('result-build').innerHTML =
    counts.size === 0
      ? '<span class="dim">本局没有习得任何功法</span>'
      : [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id, n]) => {
            const card = data.cards.find((c) => c.id === id);
            if (!card) return '';
            return `<span class="build-tag">${card.name}<b>${n} 层</b></span>`;
          })
          .join('');

  el('result-reward').textContent = `灵石 ${meta.spirit} · 境界 ${realmName(meta.realm, data)} · 共 ${meta.stats.runs} 局`;

  el('btn-result-again').onclick = handlers.onAgain;
  el('btn-result-world').onclick = handlers.onWorld;
}

// ============================================================
// 功法录
// ============================================================

export function renderCodex(data) {
  el('codex-sub').textContent = `${data.cards.length} 张功法 · 数值版本 ${data.version} · 全部为占位值，待试玩校准`;

  const bySchool = new Map();
  for (const s of data.schools) bySchool.set(s, []);
  for (const c of data.cards) {
    if (!bySchool.has(c.school)) bySchool.set(c.school, []);
    bySchool.get(c.school).push(c);
  }

  el('codex-body').innerHTML = [...bySchool.entries()]
    .map(
      ([school, cards]) => `
      <div class="codex-school">
        <div class="codex-school-head">${school} · ${cards.length} 门</div>
        ${cards
          .map(
            (c) => `
          <div class="codex-card">
            <div class="codex-head">
              <span class="codex-name">${c.name}</span>
              <span class="codex-meta">${tierLabel(c.tier)} · 上限 ${c.maxStack} 层</span>
            </div>
            <div class="card-effects">${effectTags(c)
              .map((t) => `<span class="eff ${t.survival ? 'survival' : ''}">${t.text}</span>`)
              .join('')}</div>
            <div class="codex-why">${c.rationale}</div>
          </div>`,
          )
          .join('')}
      </div>`,
    )
    .join('');
}

// ============================================================
// 开发者面板
// ============================================================

/**
 * 渲染开发者面板
 * @param {{
 *   data: any, battle: any, state: any,
 *   settings: any, persistent: boolean, seed: number,
 *   speed: number, godMode: boolean,
 * }} ctx
 * @param {Record<string, Function>} handlers
 */
export function renderDebug(ctx, handlers) {
  const { data, state, settings, persistent, seed, speed, godMode, battle } = ctx;

  const s = state?.stats;
  const info = state
    ? `
      波次 <b>${state.wave}</b> / ${state.wavesTotal}　阶段 <b>${state.phase}</b><br />
      生命 <b>${Math.ceil(state.hp)}</b> / ${Math.round(state.maxHp)}　场上敌人 <b>${state.enemies.length}</b><br />
      DPS <b>${s.dps.toFixed(1)}</b>　目标数 <b>${s.targets}</b>　减伤 <b>${pct(s.dmgReduce)}</b><br />
      种子 <b>${seed}</b>`
    : `未开局　种子 <b>${seed}</b>`;

  const cardOptions = data.cards
    .map((c) => `<option value="${c.id}">${c.school} · ${c.name}（上限 ${c.maxStack}）</option>`)
    .join('');

  el('debug-body').innerHTML = `
    <div class="debug-group">
      <h3>当前状态</h3>
      <div class="debug-kv">${info}</div>
    </div>

    <div class="debug-group">
      <h3>手感验证</h3>
      <div class="debug-row">
        <span class="debug-kv">战斗速度</span>
        <input type="range" id="dbg-speed" min="0.5" max="3" step="0.25" value="${speed}" />
        <span class="debug-kv" id="dbg-speed-v"><b>${speed}×</b></span>
      </div>
      <div class="debug-row">
        <button class="btn tiny" id="dbg-god">${godMode ? '关闭无敌' : '开启无敌'}</button>
        <button class="btn tiny" id="dbg-heal">回满血</button>
        <button class="btn tiny" id="dbg-skipwave">跳过本波</button>
        <button class="btn tiny" id="dbg-timeout">强制超时本波</button>
      </div>
      <div class="debug-row">
        <span class="debug-kv">跳到波次</span>
        <input type="number" id="dbg-wave" min="1" max="${data.base.waves}" value="${state?.wave ?? 1}" style="width:80px" />
        <button class="btn tiny" id="dbg-jump">跳转</button>
      </div>
    </div>

    <div class="debug-group">
      <h3>构造 Build</h3>
      <div class="debug-row">
        <select id="dbg-card" style="flex:1">${cardOptions}</select>
        <button class="btn tiny" id="dbg-grant">发一张</button>
      </div>
      <div class="debug-row">
        <button class="btn tiny" id="dbg-maxall">一键满配（测试上限）</button>
        <button class="btn tiny" id="dbg-reset">清空构筑</button>
      </div>
    </div>

    <div class="debug-group">
      <h3>存档</h3>
      <div class="debug-row">
        <span class="debug-kv">落盘方式：<b>${persistent ? 'localStorage（真实持久化）' : '内存兜底（关闭页面即丢失）'}</b></span>
      </div>
      <div class="debug-row">
        <button class="btn tiny" id="dbg-clearsave">清空存档</button>
        <button class="btn tiny" id="dbg-resetsave">重置为初始进度</button>
      </div>
    </div>

    <div class="debug-group">
      <h3>数值表</h3>
      <div class="debug-kv">
        版本 <b>${data.version}</b>　卡牌 <b>${data.cards.length}</b> 张 / <b>${data.schools.length}</b> 流派<br />
        波次 <b>${data.base.waves}</b>　每波 <b>${data.base.waveDuration}s</b> + 升级暂停 <b>${data.enemy.upgradePauseSec}s</b>
        → 单局 <b>${((data.base.waves * (data.base.waveDuration + data.enemy.upgradePauseSec)) / 60).toFixed(1)} 分钟</b><br />
        改数值：编辑 <code>design/numbers/cards.json</code> 后执行 <code>npm run gen</code>
      </div>
    </div>
  `;

  // ---- 事件绑定 ----
  el('dbg-speed').oninput = (e) => {
    el('dbg-speed-v').innerHTML = `<b>${e.target.value}×</b>`;
    handlers.onSpeed(Number(e.target.value));
  };
  el('dbg-god').onclick = handlers.onToggleGod;
  el('dbg-heal').onclick = handlers.onHeal;
  el('dbg-skipwave').onclick = () => handlers.onSkipWave(true);
  el('dbg-timeout').onclick = () => handlers.onSkipWave(false);
  el('dbg-jump').onclick = () => handlers.onJump(Number(el('dbg-wave').value));
  el('dbg-grant').onclick = () => handlers.onGrant(el('dbg-card').value);
  el('dbg-maxall').onclick = handlers.onMaxAll;
  el('dbg-reset').onclick = handlers.onResetBuild;
  el('dbg-clearsave').onclick = handlers.onClearSave;
  el('dbg-resetsave').onclick = handlers.onResetSave;
}
