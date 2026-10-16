/**
 * 无头浏览器视觉核查（零依赖，用 Chrome DevTools Protocol）
 *
 * 与 smoke-prototype.mjs 的分工：
 *   - smoke-prototype 验证「接线与流程」：点击有没有接上、阶段切换对不对、存档能不能往返。
 *     它用 DOM 替身，跑得极快，但看不到任何像素。
 *   - 本脚本验证「真实浏览器里长什么样」：布局有没有塌、对比度够不够、文字会不会溢出、
 *     有没有只在真实 Canvas 上才暴露的报错。它把关键界面截成 PNG，供人眼复核。
 *
 * 两者都需要，因为它们抓的是完全不同类别的问题。
 *
 * 运行：node tools/browser-check.mjs [输出目录]
 * 前置：本机装有 Chrome；脚本会自动拉起静态服务器与无头 Chrome，并自己清理。
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(process.argv[2] ?? join(ROOT, 'prototype', 'shots'));
const PORT = 5311;
const CDP_PORT = 9333;

/** 常见 Chrome 安装位置 */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    console.error('未找到 Chrome / Edge，跳过视觉核查。');
    console.error('已尝试：');
    CHROME_CANDIDATES.forEach((p) => console.error('  ' + p));
    process.exit(0); // 不算失败：这是环境问题，不是代码问题
  }
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待某个 HTTP 端点可用 */
async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(150);
  }
  throw new Error(`等待 ${url} 超时`);
}

// ============================================================
// 极简 CDP 客户端
// ============================================================

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    /** 页面控制台里的错误与警告 */
    this.consoleErrors = [];
    /** 全部控制台与网络日志（诊断用） */
    this.allConsole = [];
    /** 未捕获异常 */
    this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
        return;
      }
      this.onEvent(msg);
    });
  }

  onEvent(msg) {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const type = msg.params.type;
      const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      this.allConsole.push(`[${type}] ${text}`);
      if (type === 'error' || type === 'warning') this.consoleErrors.push(`[${type}] ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.exceptions.push(d.exception?.description ?? d.text);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      // 带上 url：光知道「有个 404」没用，必须知道是哪个文件
      this.allConsole.push(`[log:${e.level}] ${e.text}${e.url ? ` <${e.url}>` : ''}`);
      if (e.level === 'error') this.consoleErrors.push(`[network] ${e.text}${e.url ? ` <${e.url}>` : ''}`);
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 20000);
    });
  }

  /** 在页面里执行一段表达式并取回结果 */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`页面内执行失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  /** 截图并写盘 */
  async shoot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(OUT_DIR, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    return file;
  }
}

// ============================================================
// 主流程
// ============================================================

const browserPath = findBrowser();
await mkdir(OUT_DIR, { recursive: true });

console.log(`浏览器：${browserPath}`);
console.log(`输出目录：${OUT_DIR}`);

// 1) 静态服务器
const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), String(PORT)], {
  stdio: 'ignore',
  detached: false,
});
await waitFor(`http://127.0.0.1:${PORT}/`);
console.log('✓ 静态服务器已就绪');

// 2) 无头浏览器
const profileDir = join(OUT_DIR, '__profile');
await rm(profileDir, { recursive: true, force: true });
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=430,932', // 竖屏手机尺寸：小游戏的主战场
    '--force-device-scale-factor=2',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let cdp;
let failed = false;
try {
  await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`);
  // 新建标签页并连上它
  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  // 3) 打开原型
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/prototype/` });
  await sleep(1500);

  // 页面必须装配成功
  const ready = await cdp.evaluate('!!window.__game && !!window.__game.data');
  if (!ready) {
    // 装配失败时把全部日志打出来，否则只有一个「不存在」的结论，无法定位
    console.error('\n页面日志：');
    cdp.allConsole.forEach((l) => console.error('   ' + l));
    const state = await cdp.evaluate(
      `JSON.stringify({ url: location.href, ready: document.readyState, hasGame: !!window.__game, bodyLen: document.body.innerHTML.length })`,
    );
    console.error('页面状态：' + state);
    throw new Error('原型未装配成功：window.__game 不存在（main.js 抛错了？）');
  }
  console.log('✓ 页面装配成功');

  // 3.5) 顶层命中测试：这类 bug 的典型症状是「什么都点不了」
  //
  // 为什么必须单独立一项：本项目所有 .screen 都是 position:absolute; inset:0 的全屏层，
  // 只靠 .hidden 控制显隐。一旦某个层没被正确隐藏，它就会盖在最上面吞掉全部点击，
  // 而 DOM 查询、元素存在性、onclick 绑定全部正常——只有「这个坐标上站的是谁」能发现。
  // 元素存在 ≠ 元素可点。
  const hitTest = `(() => {
    const name = (el) => !el ? 'null'
      : el.id ? '#' + el.id
      : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');

    // 可见的全屏浮层。正常情况有且只有一个，多个叠加必然吞掉点击
    const layers = [...document.querySelectorAll('.screen'), document.getElementById('hud')]
      .filter((e) => e && !e.classList.contains('hidden'));

    const inView = (r) => r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;

    /** 判定「这个坐标上站的确实是它」（允许被自己的子元素命中） */
    const hitsItself = (el) => {
      const r = el.getBoundingClientRect();
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return t === el || el.contains(t) || (t && t.contains(el)) ? null : t;
    };

    const covered = [];      // 被别的元素盖住 —— 真正的 bug
    const unreachable = [];  // 滚动也到不了 —— 真正的 bug
    const neededScroll = []; // 要滚一下才点得到 —— 可用但不理想，只报告

    for (const el of [...document.querySelectorAll('button, .node, .card')]) {
      if (el.offsetParent === null || el.disabled) continue;
      let r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) { unreachable.push(name(el) + '(尺寸为 0)'); continue; }

      if (!inView(r)) {
        // 内容比舞台高时，先滚动到它再判定——「能滚到」算可用，「滚了还够不着」才算坏
        el.scrollIntoView({ block: 'center' });
        r = el.getBoundingClientRect();
        if (!inView(r)) { unreachable.push(name(el) + '(滚动后仍在视口外)'); continue; }
        neededScroll.push(name(el));
      }

      const blocker = hitsItself(el);
      if (blocker) covered.push(name(el) + ' 被 ' + name(blocker) + ' 遮挡');
    }

    // 还原滚动位置，避免影响后面的截图
    document.querySelectorAll('.screen').forEach((e) => { e.scrollTop = 0; });

    return JSON.stringify({
      viewport: innerWidth + 'x' + innerHeight,
      overlays: layers.map(name),
      covered,
      unreachable,
      neededScroll,
      hasGame: !!window.__game,
    });
  })()`;

  /** 在若干种窗口尺寸下各做一次命中测试（预览面板的尺寸千奇百怪） */
  const VIEWPORTS = [
    ['手机竖屏', 430, 932],
    ['矮面板', 420, 620],
    ['很矮的面板', 500, 420],
    ['极端矮', 640, 360],
    ['宽面板', 1024, 640],
  ];
  for (const [label, width, height] of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(250);
    // 回到大世界：命中测试要在最需要交互的那个界面上做
    await cdp.evaluate(`window.__game.enterWorld()`);
    await sleep(150);
    const r = JSON.parse(await cdp.evaluate(hitTest));
    if (!r.hasGame) throw new Error(`${label}(${r.viewport}) 下 window.__game 丢失`);
    if (r.overlays.join(',') !== '#screen-world') {
      throw new Error(
        `${label}(${r.viewport}) 下可见浮层是 [${r.overlays.join(', ')}]，应当只有 #screen-world。` +
          '多个全屏浮层叠加会吞掉全部点击',
      );
    }
    if (r.covered.length > 0) {
      throw new Error(
        `${label}(${r.viewport}) 下有按钮被遮挡：\n    ` + r.covered.join('\n    '),
      );
    }
    if (r.unreachable.length > 0) {
      throw new Error(
        `${label}(${r.viewport}) 下有按钮够不着：\n    ` + r.unreachable.join('\n    '),
      );
    }
    const scrollNote = r.neededScroll.length
      ? `（其中 ${r.neededScroll.join('、')} 需要滚动才可见）`
      : '，无需滚动';
    console.log(`✓ 命中测试：${label} ${r.viewport} —— 唯一浮层 #screen-world，按钮全部可点${scrollNote}`);
  }
  // 顺手把「矮面板」下的大世界也截一张。
  // 紧凑布局（@media max-height）只在这种情况下才生效，默认的手机竖屏截图看不到它，
  // 一旦回归就会静默变回「按钮被挤到画面外」——而那正是用户报的「什么都点不了」。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 500,
    height: 560,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.evaluate(`window.__game.enterWorld()`);
  await sleep(300);
  await cdp.shoot('09-大世界-矮面板');

  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(250);
  await cdp.evaluate(`window.__game.enterWorld()`);
  await sleep(200);

  // 4) 逐屏截图
  //
  // 关键原则：所有操作都走真实 DOM 点击，不直接改 core 的状态。
  // 原因：main.js 维护着自己的界面状态机，绕过它去改 core 会让两边不一致
  // （曾经因此拍到一张「Boss 波却显示着开局三选一」的假图）。
  // 通过 UI 点击驱动，拍到的就一定是玩家真正会看到的东西。
  const shots = [];

  /** 轮询等待界面切到指定屏 */
  async function waitForScreen(name, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cur = await cdp.evaluate('window.__game.screen');
      if (cur === name) return true;
      await sleep(80);
    }
    throw new Error(`等待界面切到 ${name} 超时（当前 ${await cdp.evaluate('window.__game.screen')}）`);
  }

  /** 点三选一里的第一张卡 */
  async function clickFirstCard() {
    const ok = await cdp.evaluate(
      `(() => { const b = document.getElementById('upgrade-cards'); if (!b || !b.children[0]) return false; b.children[0].onclick(); return true; })()`,
    );
    if (!ok) throw new Error('三选一界面里没有可点的卡片');
    await waitForScreen('battle');
  }

  shots.push(await cdp.shoot('01-大世界'));
  console.log('✓ 截图：大世界');

  // 进入秘境 → 开局三选一
  await cdp.evaluate(`document.getElementById('world-nodes').children[0].onclick()`);
  await waitForScreen('upgrade');
  await sleep(250);
  shots.push(await cdp.shoot('02-开局三选一'));
  console.log('✓ 截图：开局三选一');

  // 选卡 → 战斗中
  await clickFirstCard();
  await sleep(2600); // 让敌人刷出来、打出几刀，画面才有内容
  shots.push(await cdp.shoot('03-战斗中'));
  console.log('✓ 截图：战斗中');

  // 波间三选一：只改 core 的波次，界面同步交给主循环完成（这正是要验证的行为）
  await cdp.evaluate(`
    (() => { const b = window.__game.battle; b.debugSetGodMode(true); b.debugEndWave(true); })()
  `);
  await waitForScreen('upgrade');
  await sleep(250);
  shots.push(await cdp.shoot('04-波间三选一'));
  console.log('✓ 截图：波间三选一');

  // Boss 战：回到战斗 → 跳到最后一波 → 从 UI 选卡 → 等 Boss 走进画面
  await clickFirstCard();
  await cdp.evaluate(`window.__game.battle.debugJumpToWave(window.__game.data.base.waves)`);
  await waitForScreen('upgrade');
  await clickFirstCard();
  const isBossWave = await cdp.evaluate('window.__game.battle.getState().isBossWave');
  if (!isBossWave) throw new Error('跳转后不在 Boss 波，截图会失真');
  await sleep(5200); // Boss 从场地边缘走进画面大约需要 8 秒，5 秒时已经清晰可见
  shots.push(await cdp.shoot('05-Boss战'));
  console.log('✓ 截图：Boss 战');

  // 结算
  await cdp.evaluate(`window.__game.battle.debugEndWave(true)`);
  await waitForScreen('result', 10000);
  await sleep(400);
  shots.push(await cdp.shoot('06-结算'));
  console.log('✓ 截图：结算');

  // 功法录
  await cdp.evaluate(`window.__game.enterWorld()`);
  await sleep(300);
  await cdp.evaluate(`document.getElementById('btn-codex').onclick()`);
  await waitForScreen('codex');
  await sleep(350);
  shots.push(await cdp.shoot('07-功法录'));
  console.log('✓ 截图：功法录');

  // 开发者面板
  await cdp.evaluate(`document.getElementById('btn-codex-back').onclick()`);
  await sleep(250);
  await cdp.evaluate(`document.getElementById('btn-debug').onclick()`);
  await waitForScreen('debug');
  await sleep(350);
  shots.push(await cdp.shoot('08-开发者面板'));
  console.log('✓ 截图：开发者面板');

  // 5) 收集报错
  if (cdp.exceptions.length > 0) {
    failed = true;
    console.error('\n❌ 页面抛出未捕获异常：');
    cdp.exceptions.forEach((e) => console.error('   ' + e));
  }
  if (cdp.consoleErrors.length > 0) {
    failed = true;
    console.error('\n❌ 控制台报错：');
    cdp.consoleErrors.forEach((e) => console.error('   ' + e));
  }
  if (!failed) {
    console.log('\n✓ 全程无控制台报错、无未捕获异常');
  }

  console.log('\n截图清单：');
  shots.forEach((f) => console.log('  ' + f));
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  failed = true;
  console.error('❌ 视觉核查失败：', e.message);
  if (cdp?.exceptions.length) cdp.exceptions.forEach((x) => console.error('   ' + x));
  if (cdp?.consoleErrors.length) cdp.consoleErrors.forEach((x) => console.error('   ' + x));
  process.exitCode = 1;
} finally {
  try {
    await cdp?.send('Browser.close').catch(() => {});
  } catch {
    /* 忽略 */
  }
  browser.kill();
  server.kill();
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
