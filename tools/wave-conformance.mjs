/**
 * 一致性核对：真实战斗 vs 解析式模型
 *
 * 存在的理由（这是本项目踩过的最贵的一个坑）：
 *   工程里有两套战斗模型——core/balance.js 的解析式模型（万局模拟用）和
 *   core/battle.js 的实时战斗（玩家真正在玩的）。它们必须给出**一致**的难度结论，
 *   否则就会出现「模拟说通关率 40%，实际玩起来每一波都打不完」这种自欺欺人的局面。
 *
 *   曾经真实发生过：实时战斗按「一次出手一份伤害」结算，而模型把一波敌人当成一个血量池。
 *   出手 1 次/秒 × 10 点伤害打在 3.5 血的单位上时，超过 90% 的伤害被溢出吃掉，
 *   第 1 波实际清空耗时 30 秒（直接超时），模型却预测 8.4 秒——偏差 257%。
 *   更隐蔽的是刷怪节奏：4 批 × 7.5 秒间隔让最后一批第 29 秒才到场，每波必然超时。
 *
 *   两个 bug 都不是「算错」，而是「两套模型各自都对，但互不相容」。
 *   因此必须有一个自动化的对照工具，把偏差钉在阈值内。
 *
 * 做法：跑一局真实战斗（用「追向最近敌人」的简单 AI 模拟真人走位），
 *      用每波的 waveLogs.seconds 与 waveHp/dps 逐波对比。
 *
 * 运行：node tools/wave-conformance.mjs
 */

import CARDS_DATA from '../core/src/data.generated.js';
import { PHASE, createBattle } from '../core/src/battle.js';
import { buildCardIndex, createOwned, marginalGain } from '../core/src/stats.js';
import { waveStats } from '../core/src/balance.js';

const DATA = CARDS_DATA;
const INDEX = buildCardIndex(DATA.cards);
const DT = 1 / 30;

/** 允许的偏差上限。真实战斗包含走位、进场时间、溢出浪费，比模型慢是正常的，但不能失控 */
const MAX_DEVIATION = 0.4;

/**
 * 模型对「这一波真实耗时」的预测
 *   = 进场开销（敌人生成 → 进入攻击范围，玩家这段时间既不输出也不挨打）
 *   + 清空所需时间（受可用窗口上限约束）
 *
 * 注意 Boss 波要除以目标数：Boss 只有一个单位，连锁/多目标卡的收益在那里完全失效。
 * 这条修正之前缺失，导致模型认为 Boss 波能打过、实测每一局都在 Boss 波超时。
 */
function predictSeconds(wave, dps, targets, data) {
  const ws = waveStats(wave, data);
  // Boss 波只有一个单位：连锁/多目标卡的收益在那里完全失效，必须按单目标折算
  const effectiveDps = ws.isBoss ? dps / Math.max(1, targets ?? 1) : dps;
  const kill = Math.min(ws.totalHp / effectiveDps, ws.combatWindow);
  const overhead = Math.min(data.base.waveDuration * 0.5, data.enemy.approachOverheadSec ?? 0);
  return { predicted: overhead + kill, kill, effectiveDps, ws };
}

/** 从状态里还原持有表 */
function ownedOf(state) {
  const owned = createOwned();
  for (const [id, n] of state.owned) owned.set(id, n);
  return owned;
}

/**
 * 简单 AI：朝最近的敌人移动。
 * 这不是要模拟高手，只是为了让玩家不要站着不动——
 * 站着不动时敌人要走七八秒才能进攻击范围，测出来的耗时不能反映真实战斗。
 */
function seekInput(state) {
  const p = state.player;
  let best = null;
  let bestD = Infinity;
  for (const e of state.enemies) {
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (!best) return { dx: 0, dy: 0 };
  // 已经进入攻击范围就停下输出，不然会一直贴着撞
  if (bestD < 200 * 200) return { dx: 0, dy: 0 };
  return { dx: best.x - p.x, dy: best.y - p.y };
}

/** 跑一局，每波都选边际收益最高的卡 */
function playRun(seed) {
  const battle = createBattle({ data: DATA, seed });
  battle.debugSetGodMode(true); // 只看清空耗时，排除死亡干扰
  let guard = 0;
  while (battle.getState().phase !== PHASE.CLEARED && guard < 60000) {
    const st = battle.getState();
    if (st.phase === PHASE.UPGRADE) {
      const owned = ownedOf(st);
      let best = null;
      let bestGain = -Infinity;
      for (const c of battle.getChoices()) {
        if (c.id.startsWith('__')) continue;
        const g = marginalGain(owned, c, INDEX, battle.base, 0.35);
        if (g > bestGain) {
          bestGain = g;
          best = c;
        }
      }
      battle.choose((best ?? battle.getChoices()[0]).id);
      continue;
    }
    battle.step(DT, seekInput(battle.getState()));
    guard++;
  }
  return battle.result();
}

// ============================================================
// 核对
// ============================================================

const result = playRun(20261013);

console.log(`一致性核对（种子 ${result.seed}，${result.cleared ? '已通关' : '未通关'}）`);
console.log('');
console.log('| 波次 | 该波 DPS | 有效 DPS | 模型预测耗时 | 真实清空 | 偏差 | 超时 |');
console.log('|------|----------|----------|--------------|----------|------|------|');

let maxDeviation = 0;
let timeouts = 0;
/** 模型也预测「这一波清不完」的波次：此情形下真实战斗超时是一致行为，不是缺陷 */
let expectedTimeouts = 0;
const deviations = [];

for (const log of result.waveLogs) {
  const probe = predictSeconds(log.wave, log.dps, log.targets, DATA);
  const modelSaysClearable = probe.ws.totalHp / probe.effectiveDps <= probe.ws.combatWindow;
  const actual = log.seconds;
  // 双方都认为清不完时，比的是「都打满窗口」这件事本身，没有偏差可言
  const dev = modelSaysClearable && probe.predicted > 0 ? actual / probe.predicted - 1 : 0;
  deviations.push({ wave: log.wave, dev, predicted: probe.predicted, actual, modelSaysClearable });
  if (!log.inTime) {
    timeouts++;
    if (!modelSaysClearable) expectedTimeouts++;
  }
  if (modelSaysClearable) maxDeviation = Math.max(maxDeviation, dev);

  console.log(
    `| ${String(log.wave).padStart(4)} | ${log.dps.toFixed(1).padStart(8)} | ${probe.effectiveDps
      .toFixed(1)
      .padStart(8)} | ${probe.predicted.toFixed(1).padStart(12)} | ${actual.toFixed(1).padStart(8)} | ${(
      dev * 100
    ).toFixed(0).padStart(3)}% | ${log.inTime ? '  ' : modelSaysClearable ? ' 是' : '预期'} |`,
  );
}

console.log('');
const avg = deviations.reduce((n, d) => n + d.dev, 0) / Math.max(1, deviations.length);
console.log(`平均偏差：${(avg * 100).toFixed(0)}%　最大偏差（模型认为可清空的波次）：${(maxDeviation * 100).toFixed(0)}%`);
console.log(
  `超时波次：${timeouts} / ${result.waveLogs.length}（其中模型同样预测清不完的：${expectedTimeouts}，属一致行为）`,
);

let failed = false;
if (maxDeviation > MAX_DEVIATION) {
  console.error(
    `\n❌ 偏差过大：${(maxDeviation * 100).toFixed(0)}% > 上限 ${(MAX_DEVIATION * 100).toFixed(0)}%`,
  );
  console.error('   真实战斗与解析式模型的难度结论已经分裂，模拟结果不再可信。');
  console.error('   常见原因：出手频率过低导致溢出浪费、刷怪批次间隔让敌人来不及进场、');
  console.error('   敌人移速过慢导致玩家把时间花在等它走过来、Boss 波误用了多目标收益。');
  console.error('   排查顺序：先看哪一波偏差最大，再看那一波的 DPS 与目标数是否符合预期。');
  failed = true;
}
// 只有「模型认为打得完、真实战斗却超时」才是缺陷。
// 两边都认为清不完时，超时是一致的预期行为（例如纯多目标 Build 打单体 Boss）。
if (timeouts - expectedTimeouts > 0) {
  console.error(
    `\n❌ 有 ${timeouts - expectedTimeouts} 波「模型认为可清空、实际却超时」。`,
  );
  console.error(`   波次时长（${DATA.base.waveDuration}s）装不下清空所需时间，`);
  console.error('   真实体验会是「每一波都在干等」，割草手感消失。');
  failed = true;
}

if (!failed) {
  console.log('\n✓ 真实战斗与解析式模型一致，模拟结论可直接用于指导实时战斗的调参。');
}
process.exit(failed ? 1 : 0);
