/**
 * 原型接线冒烟测试（零依赖，不需要浏览器）
 *
 * 为什么需要它：
 *   原型的绝大多数 bug 不是算法错误，而是**接线错误**——元素 id 拼错、
 *   某个 UI 函数的参数签名对不上、core 改了接口但 UI 没跟着改。
 *   这类问题在浏览器里表现为「点了一下没反应」或者干脆白屏，
 *   排查一次要开 DevTools、翻控制台、加断点，成本很高。
 *
 *   本脚本用一套最小 DOM 替身把 prototype/src/main.js 完整装配一遍，
 *   并且**真正驱动 requestAnimationFrame 主循环**，模拟
 *   「进秘境 → 选卡 → 打到波间 → 通关 → 结算」，所有点击都走真实事件回调。
 *   任何一步抛异常都会带着真实堆栈直接失败。跑一次不到两秒。
 *
 * 边界（诚实说明）：它验证的是**接线与流程**，不是视觉。样式错位、颜色不对、
 *   字太小这类问题它抓不到——那部分仍然需要人眼看截图。
 *
 * 运行：node tools/smoke-prototype.mjs
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

// ============================================================
// 虚拟时钟 + 最小 DOM 替身
// ============================================================

let clock = 0;
const rafQueue = [];

/**
 * 推进虚拟时间并执行排队中的 rAF 回调
 * @param {number} frames 推进多少帧
 * @param {number} dtMs 每帧的虚拟毫秒数
 * @returns {number} 实际执行的帧数（主循环停掉后不再排队，所以可能少于请求值）
 */
function pump(frames, dtMs = 1000 / 60) {
  let done = 0;
  for (let i = 0; i < frames; i++) {
    if (rafQueue.length === 0) break;
    const callbacks = rafQueue.splice(0);
    clock += dtMs;
    for (const cb of callbacks) cb(clock);
    done++;
  }
  return done;
}

/**
 * 事件监听记录：input.js 通过 addEventListener 注册键盘与指针事件，
 * 这里把回调存下来，测试就能像真实浏览器一样「按下按键」。
 * 不记录的话，输入相关的接线错误（比如把 onPause 拼错）就完全测不到。
 */
const keyHandlers = new Map();
const pointerHandlers = new Map();

function on(store, type, fn) {
  if (!store.has(type)) store.set(type, []);
  store.get(type).push(fn);
}
function fire(store, type, event = {}) {
  const list = store.get(type) ?? [];
  for (const fn of list) fn({ preventDefault() {}, ...event });
  return list.length;
}

class FakeClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    names.forEach((n) => this.set.add(n));
  }
  remove(...names) {
    names.forEach((n) => this.set.delete(n));
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
}

class FakeNode {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.textContent = '';
    this._html = '';
    this.className = '';
    this.classList = new FakeClassList();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.disabled = false;
    this.value = '';
    this.clientWidth = 430;
    this.clientHeight = 932;
    this.onclick = null;
    this.oninput = null;
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
    this.children = []; // 真实 DOM 的 innerHTML 赋值同样清空子节点
  }
  append(...nodes) {
    nodes.forEach((n) => this.children.push(n));
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  remove() {}
  addEventListener(type, fn) {
    on(pointerHandlers, type, fn);
  }
  removeEventListener() {}
  setPointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  getContext() {
    return makeContext2d();
  }
}

/** 用 Proxy 造一个「什么绘图 API 都接受」的 2D 上下文，避免为每个 API 写桩 */
function makeContext2d() {
  const gradient = { addColorStop() {} };
  const target = {
    canvas: { width: 720, height: 1280 },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: () => ({ width: 10 }),
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop] : () => {}),
    set: (t, prop, value) => {
      t[prop] = value;
      return true;
    },
  });
}

/**
 * index.html 里真实存在的元素 id 清单。
 *
 * 这里刻意**不写成硬编码数组**，而是每次运行时从 index.html 现读。
 * 本项目踩过这个坑：HUD 里的「/ 12 波」在波数改成 18 之后没跟着改，
 * 界面长期显示成「第 18 / 12 波」这种自相矛盾的读数，而当时所有检查全绿——
 * 因为硬编码的 id 清单本身也没更新，它检查的是「我以为的 HTML」而不是「真的 HTML」。
 * 契约测试的价值全部来自「以真实来源为准」这一条。
 */
const INDEX_HTML_PATH = new URL('../prototype/index.html', import.meta.url);
const HTML_IDS = new Set(
  [...readFileSync(INDEX_HTML_PATH, 'utf-8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]),
);
const SCREEN_IDS = ['screen-world', 'screen-upgrade', 'screen-result', 'screen-codex', 'screen-debug', 'screen-pause'];

const nodes = new Map();
const requestedIds = new Set();

function getNode(id) {
  requestedIds.add(id);
  if (!nodes.has(id)) {
    const node = new FakeNode('div', id);
    // 屏幕元素默认带上 hidden，与 HTML 里未显示的覆盖层一致
    if (SCREEN_IDS.includes(id) && id !== 'screen-world') node.classList.add('hidden');
    nodes.set(id, node);
  }
  return nodes.get(id);
}

const documentStub = {
  getElementById: getNode,
  querySelectorAll: (selector) =>
    selector === '.screen' ? SCREEN_IDS.map(getNode) : [],
  createElement: (tag) => new FakeNode(tag),
  addEventListener() {},
  body: new FakeNode('body'),
};

const storeMap = new Map();
const localStorageStub = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};

globalThis.document = documentStub;
globalThis.localStorage = localStorageStub;
globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.window = {
  devicePixelRatio: 1,
  addEventListener: (type, fn) => on(keyHandlers, type, fn),
  removeEventListener() {},
  localStorage: localStorageStub,
  requestAnimationFrame: globalThis.requestAnimationFrame,
};

// ============================================================
// 装配
// ============================================================

const main = await import('../prototype/src/main.js').catch((e) => {
  console.error('❌ 原型装配失败（元素 id 拼错 / 导入路径失效 / 顶层抛错）：');
  console.error(e);
  process.exit(1);
});
const ui = await import('../prototype/src/ui.js');
const storage = await import('../prototype/src/storage.js');
const { CARDS_DATA } = await import('../core/src/data.generated.js');
const game = globalThis.window.__game;

assert.ok(game, 'window.__game 未暴露：main.js 没有执行到底');
console.log('✓ 装配完成：main.js 顶层无异常');

// 元素 id 契约
const missing = [...requestedIds].filter((id) => !HTML_IDS.has(id));
assert.deepEqual(
  missing,
  [],
  `JS 引用了 index.html 里不存在的 id：${missing.join(', ')}。运行时会静默失败（null.textContent）。`,
);
console.log(`✓ 元素 id 契约：JS 请求的 ${requestedIds.size} 个 id 全部存在于 index.html`);

// 主循环必须已经在排队（说明 rAF 被正确启动）
assert.ok(rafQueue.length > 0, 'main.js 没有启动主循环（requestAnimationFrame 未被调用）');
console.log('✓ 主循环：已启动');

// ============================================================
// 链路一：大世界 → 秘境（走真实点击）
// ============================================================

const worldNodes = getNode('world-nodes');
assert.ok(worldNodes.children.length >= 2, `大世界只渲染了 ${worldNodes.children.length} 个节点`);
assert.equal(
  getNode('world-realm').textContent,
  game.data.meta.realmNames[0],
  '大世界没有显示当前境界',
);

const startNode = worldNodes.children[0];
assert.ok(typeof startNode.onclick === 'function', '秘境节点没有绑定点击事件');
startNode.onclick();

assert.ok(game.battle, '点击秘境后没有创建战斗实例');
assert.equal(game.screen, 'upgrade', `开局后应停在升级界面，实际是 ${game.screen}`);
console.log('✓ 大世界 → 秘境：已创建战斗并进入开局三选一');

// ============================================================
// 链路二：开局三选一 → 战斗（走真实点击）
// ============================================================

const cardsBox = getNode('upgrade-cards');
assert.equal(cardsBox.children.length, 3, `开局三选一渲染了 ${cardsBox.children.length} 张卡`);
for (const card of cardsBox.children) {
  assert.ok(card.innerHTML.includes('card-name'), '卡片缺少卡名结构');
  assert.equal(typeof card.onclick, 'function', '卡片没有绑定点击事件');
}
const openingCardId = game.battle.getChoices()[0].id;
cardsBox.children[0].onclick();

assert.equal(game.screen, 'battle', `选卡后应进入战斗，实际是 ${game.screen}`);
assert.ok(
  game.battle.getState().owned.some(([id]) => id === openingCardId),
  '选卡后持有表里没有这张卡，说明点击没有走到 core',
);
console.log('✓ 三选一 → 战斗：选卡已生效并切回战斗画面');

// ============================================================
// 链路三：驱动主循环打到通关（真实 rAF，真实阶段切换）
// ============================================================

game.battle.debugSetGodMode(true); // 关掉死亡判定，专注验证流程
game.setSpeed(6); // 提速，缩短测试耗时（真实玩家当然用 1×）

/** 反复推进主循环，遇到三选一就点第一张，直到结束或超时 */
function playToEnd(maxPumps = 4000) {
  const pickedWaves = new Set();
  for (let i = 0; i < maxPumps; i++) {
    const st = game.battle.getState();
    if (st.phase === 'cleared' || st.phase === 'dead') return { outcome: st.phase, picked: pickedWaves.size };

    if (game.screen === 'upgrade') {
      const st2 = game.battle.getState();
      const cards = getNode('upgrade-cards').children;
      assert.ok(cards.length > 0, `第 ${st2.wave} 波的三选一没有渲染出任何卡片`);
      assert.equal(cards.length, 3, `第 ${st2.wave} 波的三选一只渲染了 ${cards.length} 张卡`);
      const id = game.battle.getChoices()[0].id;
      cards[0].onclick();
      assert.equal(game.screen, 'battle', '点击卡片后没有回到战斗');
      assert.ok(
        game.battle.getState().owned.some(([cid]) => cid === id),
        '波间选卡没有生效',
      );
      pickedWaves.add(st2.wave);
      continue;
    }

    const advanced = pump(40);
    if (advanced === 0) return { outcome: 'stalled', picked: pickedWaves.size };
  }
  return { outcome: 'timeout', picked: pickedWaves.size };
}

const play = playToEnd();
assert.notEqual(play.outcome, 'stalled', '主循环停摆了（rAF 不再排队）——某个回调抛异常后被中断');
assert.notEqual(play.outcome, 'timeout', '主循环跑不完一局，可能是阶段切换逻辑有问题');
assert.equal(play.outcome, 'cleared', `预期通关，实际 ${play.outcome}`);
console.log(`✓ 主循环：完整跑通 ${CARDS_DATA.base.waves} 波并通关（途中做了 ${play.picked} 次波间选择）`);

// 结算界面必须已经被 main.js 自动切过去（而不是靠测试手动调用）
assert.equal(game.screen, 'result', `通关后应显示结算界面，实际是 ${game.screen}`);
assert.ok(getNode('result-grid').innerHTML.includes('stat-k'), '结算面板没有渲染统计格');
assert.ok(getNode('result-title').textContent.length > 0, '结算标题为空');
assert.ok(
  getNode('result-reward').textContent.includes('灵石'),
  '结算面板没有显示累计灵石',
);
console.log('✓ 结算面板：由主循环自动切出，内容渲染正常');

// 局外成长真的入账了
assert.ok(game.save.meta.stats.runs === 1, `生涯局数应为 1，实际 ${game.save.meta.stats.runs}`);
assert.ok(game.save.meta.spirit > 0, '通关后没有获得灵石');
assert.equal(game.save.meta.stats.clears, 1, '通关数没有累加');
console.log(`✓ 局外结算：灵石 +${game.save.meta.spirit}，通关 1 局，最远第 ${game.save.meta.stats.bestWave} 波`);

// ============================================================
// 链路四：结算 → 再来一局 → 返回大世界
// ============================================================

getNode('btn-result-again').onclick();
assert.ok(game.battle, '再来一局没有重建战斗实例');
assert.equal(game.battle.getState().wave, 1, '新一局应从第 1 波开始');
assert.equal(game.battle.getState().owned.length, 0, '新一局不应当保留上一局的构筑');
console.log('✓ 再来一局：状态已完全重置');

// 清掉这一局再回大世界
getNode('btn-result-world')?.onclick?.();
game.enterWorld();
assert.equal(game.screen, 'world', '返回大世界失败');
console.log('✓ 返回大世界');

// ============================================================
// 链路五：坊市突破（走真实点击）
// ============================================================

// 直接把灵石灌够，验证突破按钮的可用性与结算
game.save.meta.spirit = 99999;
game.enterWorld();
const shopNode = getNode('world-nodes').children[1];
assert.equal(shopNode.disabled, false, '灵石充足时坊市节点却是禁用的');
assert.ok(shopNode.innerHTML.includes('坊'), '第二个节点不是坊市');
const realmBefore = game.save.meta.realm;
shopNode.onclick();
assert.equal(game.save.meta.realm, realmBefore + 1, '点击坊市后境界没有提升');
assert.ok(game.save.meta.spirit < 99999, '突破没有扣除灵石');
console.log(`✓ 坊市突破：境界 ${realmBefore} → ${game.save.meta.realm}，灵石已扣除`);

// 突破后的加成必须真的生效（下一局的基准值应更高）
game.startRun(12345);
const baseWithBonus = game.battle.base;
const expectedAtk = game.data.base.atk * (1 + game.save.meta.realm * game.data.meta.realmAtkBonus);
assert.ok(
  Math.abs(baseWithBonus.atk - expectedAtk) < 1e-9,
  `突破后的攻击基准 ${baseWithBonus.atk} 与期望 ${expectedAtk} 不符——局外加成没有接进战斗`,
);
console.log('✓ 局外加成：已正确折算进战斗基准值');

// 把这一局推进到战斗阶段，后面的界面切换测试才有确定的落点
getNode('upgrade-cards').children[0].onclick();
assert.equal(game.screen, 'battle', '选开局卡后没有进入战斗');
assert.equal(game.battle.getState().phase, 'fighting');

// ============================================================
// 链路六：图鉴与开发者面板
// ============================================================

getNode('btn-codex').onclick();
assert.equal(game.screen, 'codex', '点击功法录没有切换界面');
assert.ok(
  getNode('codex-body').innerHTML.includes('codex-school'),
  '功法录没有渲染出流派分组',
);
const schoolCount = (getNode('codex-body').innerHTML.match(/codex-school-head/g) ?? []).length;
assert.equal(schoolCount, game.data.schools.length, `功法录分组数 ${schoolCount} 与流派数不符`);
console.log(`✓ 功法录：${game.data.cards.length} 张卡按 ${schoolCount} 个流派分组渲染`);

getNode('btn-codex-back').onclick();
assert.equal(game.screen, 'world', '从功法录返回失败');

getNode('btn-debug').onclick();
assert.equal(game.screen, 'debug', '点击开发者面板没有切换界面');
const debugHtml = getNode('debug-body').innerHTML;
for (const token of ['dbg-speed', 'dbg-god', 'dbg-jump', 'dbg-card', 'dbg-grant', 'dbg-maxall', 'dbg-clearsave']) {
  assert.ok(debugHtml.includes(token), `开发者面板缺少控件：${token}`);
}
console.log('✓ 开发者面板：控件齐全');

// 面板上的「发一张卡」必须真的改变战斗状态
const beforeDps = game.battle.getState().stats.dps;
getNode('dbg-card').value = 'lei_atk';
getNode('dbg-grant').onclick();
assert.ok(
  game.battle.getState().stats.dps > beforeDps,
  '开发者面板的「发一张卡」没有生效',
);
console.log('✓ 开发者面板：发卡 → 属性即时刷新');

// 战斗速度滑杆：先设速度，再从面板回到战斗验证主循环确实按新速度推进
getNode('dbg-speed').oninput({ target: { value: '2' } });
getNode('btn-debug-back').onclick();
assert.equal(game.screen, 'battle', '从开发者面板返回战斗失败');

const timeAtStart = Number(getNode('hud-timer').textContent);
assert.ok(!Number.isNaN(timeAtStart), 'HUD 计时器不是数字');
pump(60); // 虚拟时间推进 1 秒
const timeAfter = Number(getNode('hud-timer').textContent);
assert.notEqual(timeAfter, timeAtStart, '回到战斗后 HUD 计时器没有变化——主循环没有恢复推进');
assert.ok(timeAfter < timeAtStart, '计时器没有倒数');
console.log('✓ 开发者面板：调速生效，返回战斗后主循环恢复推进');

// ============================================================
// 链路七：输入（键盘暂停 / 虚拟摇杆）
// ============================================================

assert.ok(fire(keyHandlers, 'keydown', { key: 'p' }) > 0, '键盘事件没有注册到 window');
assert.equal(
  getNode('screen-pause').classList.contains('hidden'),
  false,
  '按下 P 后暂停界面没有显示——onPause 回调可能没接上',
);
// 暂停期间主循环必须停止推进
const pausedTimer = getNode('hud-timer').textContent;
pump(60);
assert.equal(getNode('hud-timer').textContent, pausedTimer, '暂停期间 HUD 计时器仍在变化');

fire(keyHandlers, 'keydown', { key: 'p' });
assert.equal(
  getNode('screen-pause').classList.contains('hidden'),
  true,
  '再次按下 P 后没有恢复',
);
pump(30);
assert.notEqual(getNode('hud-timer').textContent, pausedTimer, '恢复后主循环没有继续推进');
console.log('✓ 键盘输入：P 键暂停 / 恢复均生效');

// 虚拟摇杆：按下 → 拖动 → 抬起的完整序列必须被 input.js 接收
assert.ok(fire(pointerHandlers, 'pointerdown', { clientX: 200, clientY: 500, pointerId: 1 }) > 0, '没有注册 pointerdown');
fire(pointerHandlers, 'pointermove', { clientX: 260, clientY: 500, pointerId: 1 });
const movedFrom = { ...game.battle.getState().player };
pump(20);
const movedTo = { ...game.battle.getState().player };
assert.ok(
  Math.abs(movedTo.x - movedFrom.x) > 1,
  `拖动摇杆后角色没有向右移动（x: ${movedFrom.x.toFixed(1)} → ${movedTo.x.toFixed(1)}）`,
);
fire(pointerHandlers, 'pointerup', { pointerId: 1 });
console.log('✓ 触屏输入：虚拟摇杆能驱动角色移动');

// 暂停界面上的「继续」按钮
fire(keyHandlers, 'keydown', { key: 'p' });
getNode('btn-pause-resume').onclick();
assert.equal(getNode('screen-pause').classList.contains('hidden'), true, '「继续」按钮没有生效');
console.log('✓ 暂停界面：继续按钮生效');

// ============================================================
// 链路八：存档往返 + 损坏恢复
// ============================================================

assert.equal(storage.isPersistent(), true, 'localStorage 替身未被识别为可用');
assert.equal(storage.save(game.save), true, '存档写入返回失败');
const reloaded = storage.load();
assert.deepEqual(reloaded.save, game.save, '存档往返后内容不一致');
assert.equal(reloaded.recovered, false);
console.log('✓ 存档：写入 → 读取 往返一致');

localStorageStub.setItem('xiuxian.video_code.save', '{坏掉的存档');
const recovered = storage.load();
assert.equal(recovered.recovered, true, '损坏存档没有被标记为已恢复');
assert.equal(recovered.save.meta.realm, 0, '损坏存档没有退回默认进度');
console.log('✓ 存档容错：损坏存档已退回默认进度，不会白屏');

console.log('\n全部接线与流程检查通过（共 8 条链路）。原型可进入浏览器试玩。');
