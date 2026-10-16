/**
 * 入口与总调度
 *
 * 职责：
 *   1. 装配 core（纯逻辑）与 prototype（渲染 / 输入 / UI）
 *   2. 维护应用层状态机：大世界 → 战斗 → 三选一 → 结算 → 大世界
 *   3. 主循环：固定以真实时间驱动 core.step，并把「战斗速度」作为倍率叠加
 *
 * 明确不做的事：
 *   - 不实现任何游戏规则（全在 core）
 *   - 不直接读写 localStorage（全走 storage.js）
 *   - 不拼接任何 HTML（全走 ui.js）
 * 这样的分层让「上微信小游戏」时只需要替换 render / input / storage 三个文件。
 */

import CARDS_DATA from '../../core/src/data.generated.js';
import { PHASE, createBattle } from '../../core/src/battle.js';
import { buildCardIndex, createOwned, marginalGain, scoreBuild } from '../../core/src/stats.js';
import { breakthrough, metaBonus, realmName, settleRun } from '../../core/src/meta.js';
import { seedFromTime } from '../../core/src/rng.js';

import { createRenderer } from './render.js';
import { createInput } from './input.js';
import * as storage from './storage.js';
import * as ui from './ui.js';

const DATA = CARDS_DATA;
const CARD_INDEX = buildCardIndex(DATA.cards);

// ============================================================
// 应用状态
// ============================================================

/** 存档（含局外成长与设置） */
const loaded = storage.load();
let save = loaded.save;

/** 当前这一局的战斗实例；null 表示没在局内 */
let battle = null;
/** 应用层界面状态 */
let screen = 'world';
/** 战斗速度倍率（Debug 用） */
let speed = save.settings.speed ?? 1;
/** 是否暂停 */
let paused = false;
/** 是否无敌（Debug 用） */
let godMode = false;
/** 当前这一局的种子，方便复现 */
let currentSeed = save.lastSeed;
/** 本次三选一是否为开局选择（决定横幅文案） */
let upgradeIsOpening = false;
/** 评估「这张卡值多少」时对生存属性的权重。0.35 与模拟里的「新手」模型接近 */
const SURVIVAL_WEIGHT = 0.35;

/** 存档恢复提示只需弹一次 */
if (loaded.recovered) {
  setTimeout(() => ui.banner('存档损坏，已重置为初始进度', 'calm'), 400);
}

// ============================================================
// 装配渲染与输入
// ============================================================

const canvas = document.getElementById('game');
const stage = document.getElementById('stage');
const renderer = createRenderer(canvas);

/** 主循环外只有这里需要 resize 逻辑 */
function resize() {
  // 舞台被隐藏或还没布局时尺寸为 0，此时跳过，否则会算出 NaN 变换
  if (stage.clientWidth < 2 || stage.clientHeight < 2) return;
  renderer.resize({ width: DATA.arena.width, height: DATA.arena.height });
}
new ResizeObserver(resize).observe(stage);
resize();

const input = createInput(stage, {
  onPause: () => {
    if (screen !== 'battle') return;
    paused = !paused;
    document.getElementById('screen-pause').classList.toggle('hidden', !paused);
    if (!paused) lastTs = performance.now(); // 恢复时重置计时，避免累积一个巨大的 dt
  },
  onToggleDebug: () => openDebug(),
});

// ============================================================
// 存档读写
// ============================================================

function persist() {
  save.settings.speed = speed;
  storage.save(save);
}

// ============================================================
// 界面切换
// ============================================================

function enterWorld() {
  screen = 'world';
  paused = false;
  ui.showHud(false);
  ui.showScreen('screen-world');
  ui.renderWorld({ meta: save.meta, data: DATA }, {
    onStart: startRun,
    onBreakthrough: doBreakthrough,
    onCodex: openCodex,
    onDebug: openDebug,
  });
  refreshSide();
}

function refreshSide() {
  ui.renderSide(battle ? battle.getState() : null, save.meta, DATA);
}

/** 用当前存档的局外加成开一局新游戏 */
function startRun(seed) {
  currentSeed = seed ?? seedFromTime();
  save.lastSeed = currentSeed;
  battle = createBattle({
    data: DATA,
    seed: currentSeed,
    metaBonus: metaBonus(save.meta, DATA),
  });
  godMode = false;
  battle.debugSetGodMode(false);
  paused = false;
  screen = 'battle';
  ui.showHud(true);
  ui.hideScreens();
  ui.banner('第 一 波 · 来 袭', 'calm');
  enterUpgrade(true);
  refreshSide();
}

function enterUpgrade(isOpening = false) {
  screen = 'upgrade';
  upgradeIsOpening = isOpening;
  const state = battle.getState();
  const choices = battle.getChoices() ?? [];

  // 计算每个选项的边际收益，帮玩家（和我们自己）判断这张卡到底值多少。
  // 收益以「相对当前强度的百分比」呈现——绝对数值对玩家没有意义。
  const owned = createOwned();
  for (const [id, n] of state.owned) owned.set(id, n);
  const before = scoreBuild(owned, CARD_INDEX, battle.base, SURVIVAL_WEIGHT);
  const gains = {};
  for (const c of choices) {
    const gain = marginalGain(owned, c, CARD_INDEX, battle.base, SURVIVAL_WEIGHT);
    gains[c.id] = before > 0 ? `+${Math.round((gain / before) * 100)}%` : '+0%';
  }

  ui.renderUpgrade(
    choices,
    {
      owned: state.owned,
      isOpening,
      wave: state.wave,
      data: DATA,
      gains,
    },
    onPick,
  );
  ui.renderHud(state, save.meta, DATA);
  ui.showScreen('screen-upgrade');
}

function onPick(id) {
  if (!battle.choose(id)) return;
  screen = 'battle';
  ui.hideScreens();
  if (upgradeIsOpening) ui.banner('第 一 波 · 来 袭', 'calm');
  else if (battle.getState().isBossWave) ui.banner('秘 境 之 主 · 现 身', '');
  ui.renderHud(battle.getState(), save.meta, DATA);
  refreshSide();
}

function enterResult() {
  screen = 'result';
  ui.showHud(false);
  const result = battle.result();
  const before = save.meta.spirit;
  save.meta = settleRun(save.meta, result, DATA);
  const earned = save.meta.spirit - before;
  persist();

  ui.renderResult(
    result,
    { meta: save.meta, data: DATA, earnedSpirit: earned },
    { onAgain: () => startRun(), onWorld: enterWorld },
  );
  ui.showScreen('screen-result');

  // 通关或阵亡都用横幅强化反馈
  ui.banner(result.cleared ? '破 境 而 出' : '道 消 身 殒', result.cleared ? '' : 'calm');
  refreshSide();
}

function doBreakthrough() {
  const { state, ok } = breakthrough(save.meta, DATA);
  if (!ok) return;
  const nextRealm = realmName(state.realm, DATA);
  save.meta = state;
  persist();
  ui.banner(`境 界 突 破 · ${nextRealm}`, '');
  enterWorld();
}

function openCodex() {
  screen = 'codex';
  ui.renderCodex(DATA);
  ui.showScreen('screen-codex');
}

function openDebug() {
  screen = 'debug';
  refreshDebug();
  ui.showScreen('screen-debug');
}

function refreshDebug() {
  ui.renderDebug(
    {
      data: DATA,
      battle,
      state: battle ? battle.getState() : null,
      settings: save.settings,
      persistent: storage.isPersistent(),
      seed: currentSeed,
      speed,
      godMode,
    },
    {
      onSpeed: (v) => {
        speed = v;
        persist();
      },
      onToggleGod: () => {
        godMode = !godMode;
        battle?.debugSetGodMode(godMode);
        refreshDebug();
      },
      onHeal: () => {
        battle?.debugHeal();
        refreshDebug();
      },
      onSkipWave: (inTime) => {
        if (!battle) return;
        // 升级阶段需要先关掉面板才能继续
        battle.debugEndWave(inTime);
        afterDebugAction();
      },
      onJump: (wave) => {
        if (!battle) return;
        battle.debugJumpToWave(Math.max(1, Math.min(DATA.base.waves, wave)));
        afterDebugAction();
      },
      onGrant: (id) => {
        battle?.debugGrantCard(id);
        refreshDebug();
      },
      onMaxAll: () => {
        if (!battle) return;
        for (const c of DATA.cards) {
          for (let i = 0; i < c.maxStack; i++) battle.debugGrantCard(c.id);
        }
        refreshDebug();
      },
      onResetBuild: () => {
        battle?.debugSetOwned([]);
        refreshDebug();
      },
      onClearSave: () => {
        storage.clear();
        ui.banner('存档已清空（内存与磁盘）', 'calm');
        refreshDebug();
      },
      onResetSave: () => {
        save = { ...save, meta: { ...save.meta, realm: 0, spirit: 0 } };
        persist();
        ui.banner('进度已重置为初始状态', 'calm');
        refreshDebug();
      },
    },
  );
}

/**
 * Debug 操作后同步界面：
 * 如果战斗已经推进到新阶段，就切到对应界面；否则留在面板里继续看数值
 */
function afterDebugAction() {
  const st = battle?.getState();
  if (!st) return;
  if (st.phase === PHASE.UPGRADE) {
    enterUpgrade(false);
  } else if (st.phase === PHASE.CLEARED || st.phase === PHASE.DEAD) {
    enterResult();
  } else {
    screen = 'battle';
    ui.hideScreens();
    refreshDebug();
    ui.showScreen('screen-debug');
  }
}

document.getElementById('btn-codex-back').onclick = () => enterWorld();

/** 从开发者面板回到游戏：按 core 的当前阶段决定落在哪个界面 */
document.getElementById('btn-debug-back').onclick = () => {
  if (!battle) {
    enterWorld();
    return;
  }
  const phase = battle.getState().phase;
  if (phase === PHASE.UPGRADE) enterUpgrade(false);
  else if (phase === PHASE.FIGHTING) {
    screen = 'battle';
    ui.hideScreens();
    ui.showHud(true);
  } else enterWorld();
};

// 暂停界面的「继续」
document.getElementById('btn-pause-resume').onclick = () => {
  paused = false;
  document.getElementById('screen-pause').classList.add('hidden');
  lastTs = performance.now();
};

// ============================================================
// 主循环
// ============================================================

let lastTs = performance.now();
/** 单帧允许推进的最大游戏时间。防止切后台回来后「一帧走完一整波」 */
const MAX_STEP_TOTAL = 0.2;
/** core 内部以 1/60 秒为步长推进，保证不同帧率下的物理结果一致 */
const SUBSTEP = 1 / 60;
/**
 * 侧栏刷新间隔（毫秒）。
 * 侧栏是 innerHTML 全量重建，每帧都刷会在手机上造成持续的样式重算与布局抖动；
 * 每秒 10 次肉眼已经看不出延迟。
 */
const SIDE_REFRESH_MS = 100;
let lastSideRefresh = 0;

function frame(ts) {
  const rawDt = (ts - lastTs) / 1000;
  lastTs = ts;

  if (battle && screen === 'battle' && !paused) {
    let remaining = Math.min(rawDt * speed, MAX_STEP_TOTAL);
    while (remaining > 0) {
      const h = Math.min(remaining, SUBSTEP);
      battle.step(h, input.vector());
      remaining -= h;
      // 阶段发生变化就立刻停止推进，避免「多推几帧」导致玩家错过升级界面
      if (battle.getState().phase !== PHASE.FIGHTING) break;
    }

    const phase = battle.getState().phase;
    if (phase === PHASE.UPGRADE) enterUpgrade(false);
    else if (phase === PHASE.CLEARED || phase === PHASE.DEAD) enterResult();
    else {
      ui.renderHud(battle.getState(), save.meta, DATA);
      if (ts - lastSideRefresh >= SIDE_REFRESH_MS) {
        lastSideRefresh = ts;
        refreshSide();
      }
    }
  }

  // 大世界 / 结算等界面下也让战场继续渲染，作为背景，避免黑屏割裂
  if (battle) {
    renderer.draw(battle.getState(), { stick: screen === 'battle' ? input.stickVisual() : null });
  } else {
    renderer.draw(emptyState(), { stick: null });
  }

  requestAnimationFrame(frame);
}

/** 未开局时给渲染层的占位状态，避免渲染层到处判空 */
function emptyState() {
  return {
    phase: 'idle',
    wave: 1,
    wavesTotal: DATA.base.waves,
    isBossWave: false,
    runTime: 0,
    waveTime: 0,
    waveTimeLeft: DATA.base.waveDuration,
    waveDuration: DATA.base.waveDuration,
    waveHpLeft: 0,
    waveTotal: 0,
    pendingSpawn: 0,
    arena: DATA.arena,
    player: { x: DATA.arena.width / 2, y: DATA.arena.height / 2, r: DATA.arena.playerRadius },
    enemies: [],
    effects: [],
    hp: 0,
    maxHp: 0,
    stats: null,
    owned: [],
    spirit: 0,
    kills: 0,
    bossKills: 0,
    lastAttackAt: -9,
  };
}

// ============================================================
// 启动
// ============================================================

enterWorld();
ui.renderSide(null, save.meta, DATA);
requestAnimationFrame(frame);

// 便于在浏览器控制台里直接调试数值
window.__game = {
  get data() {
    return DATA;
  },
  get battle() {
    return battle;
  },
  get save() {
    return save;
  },
  get screen() {
    return screen;
  },
  startRun,
  enterWorld,
  /** 控制台调速，等价于开发者面板里的滑杆 */
  setSpeed: (v) => {
    speed = v;
  },
};
