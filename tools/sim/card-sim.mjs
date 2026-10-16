/**
 * Monte Carlo 抽卡与通关模拟器
 *
 * 它回答四个结构性问题（而不是给出平衡终值）：
 *   1. 死亡卡：一万局里几乎没人选，说明这张卡的收益在模型里不存在
 *   2. 主导卡：被选中率远超均匀基准，说明它有上位替代所有卡的强度
 *   3. 通关率：纯输出流 / 稳健流 / 新手乱选分别能不能过，死亡压力是否合理
 *   4. 方差：终局强度 P90÷P10——太窄意味着每局长一个样，Roguelike 的重玩价值是假的
 *
 * 运行：node tools/sim/card-sim.mjs（或 npm run sim）
 * 输出：控制台报告 + design/numbers/sim-report.md（固定随机种子，任何人任何时间跑结果一致）
 * 注意：数值全部来自 design/numbers/cards.json，状态为 PLACEHOLDER；本工具找的是结构问题
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARDS_DATA } from '../../core/src/data.generated.js';
import { buildCardIndex, computeStats, scoreFromStats, withCard, totalStacks } from '../../core/src/stats.js';
import { evaluateRun, waveStats } from '../../core/src/balance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORT_PATH = join(ROOT, 'design', 'numbers', 'sim-report.md');

const RUNS = 10000;
const SEED = 20261013;
const OFFERS_PER_STEP = 3;

const data = CARDS_DATA;
const cards = data.cards;
const cardIndex = buildCardIndex(cards);
const base = data.base;

/** 固定种子的伪随机，保证报告可复现（改动数值后可直接对比前后差异） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** tier2 更稀有：用权重让高阶卡出现频率低于地基卡 */
function tierWeight(card) {
  return card.tier === 1 ? 1.0 : 0.45;
}

/** 按权重不重复抽样，模拟三选一的候选池 */
function sampleDistinct(pool, count, rng) {
  const bag = pool.slice();
  const picked = [];
  while (picked.length < count && bag.length > 0) {
    let total = 0;
    for (const c of bag) total += tierWeight(c);
    let r = rng() * total;
    let idx = bag.length - 1;
    for (let i = 0; i < bag.length; i++) {
      r -= tierWeight(bag[i]);
      if (r <= 0) { idx = i; break; }
    }
    picked.push(bag[idx]);
    bag.splice(idx, 1);
  }
  return picked;
}

/**
 * 模拟一种玩家风格
 * @param {import('../../core/src/types.js').PlayerProfile} profile
 * @param {number} runs
 * @param {() => number} rng
 */
function simulate(profile, runs, rng) {
  const pickCount = new Map();
  const offerCount = new Map();
  const schoolPicks = new Map();
  const stacksAtEnd = new Map();
  const finalScores = [];
  const clearedWaves = [];
  const hpLeftRatios = [];
  let wins = 0;
  let totalPicks = 0;
  let runSeconds = 0;
  /**
   * 逐波难度余量观测。
   *
   * 「通关率」只告诉你会不会死，不告诉你难度曲线是不是合理。
   * 这两个数组回答后一个问题：
   *   - clearRate[w]：打到第 w 波的局里，有多少比例在时限内清空了
   *   - waveSeconds[w]：平均花在这一波的秒数（上限是 combatWindow）
   * 如果前期 clearRate 已经是 100% 且 waveSeconds 只有两三秒，
   * 说明那一波对玩家毫无威胁，属于「走过场」。
   */
  const waveReach = new Array(base.waves).fill(0);
  const waveClear = new Array(base.waves).fill(0);
  const waveSeconds = new Array(base.waves).fill(0);

  for (let run = 0; run < runs; run++) {
    let owned = new Map();
    /**
     * 逐波属性时间线：timeline[w-1] = 打第 w 波时手里那套 Build 的属性。
     *
     * 这个数组是本模拟器最关键的一处建模。真实游戏是「先三选一，再打一波」，
     * 所以第 1 波只有 1 张卡、第 18 波有 18 张卡。
     * 早期版本只把最后一手属性传给评估函数，等于让玩家「拿着 18 张卡打第 1 波」——
     * 难度曲线被整体抹平，模拟出来的单局时长（4-5 分钟）远低于设计目标。
     */
    const timeline = [];

    for (let step = 0; step < profile.steps; step++) {
      const pool = cards.filter((c) => (owned.get(c.id) ?? 0) < c.maxStack);
      if (pool.length === 0) break;

      const offer = sampleDistinct(pool, OFFERS_PER_STEP, rng);
      for (const c of offer) offerCount.set(c.id, (offerCount.get(c.id) ?? 0) + 1);

      // 用「边际增益」排序，逼近真人的直觉判断
      const before = scoreOf(owned, profile.survivalWeight);
      const ranked = offer
        .map((card) => ({ card, gain: scoreOf(withCard(owned, card.id), profile.survivalWeight) - before }))
        .sort((a, b) => b.gain - a.gain);

      const useSecond = ranked.length > 1 && rng() < profile.noise;
      const chosen = useSecond ? ranked[1].card : ranked[0].card;

      owned = withCard(owned, chosen.id);
      pickCount.set(chosen.id, (pickCount.get(chosen.id) ?? 0) + 1);
      schoolPicks.set(chosen.school, (schoolPicks.get(chosen.school) ?? 0) + 1);
      totalPicks++;

      timeline.push(computeStats(owned, cardIndex, base));
    }

    for (const [id, n] of owned) stacksAtEnd.set(id, (stacksAtEnd.get(id) ?? 0) + n / runs);

    const stats = computeStats(owned, cardIndex, base);
    finalScores.push(scoreFromStats(stats, profile.survivalWeight));

    const outcome = evaluateRun(timeline, data);
    clearedWaves.push(outcome.clearedWave);
    hpLeftRatios.push(outcome.hpRatio);
    // 累加求平均——早期版本只保留最后一局的值，于是报告里的时长实际是「某一局的时长」
    runSeconds += outcome.runSeconds;
    if (!outcome.dead) wins++;

    for (const log of outcome.waveLogs) {
      const i = log.wave - 1;
      waveReach[i]++;
      if (log.overflow <= 0) waveClear[i]++;
      waveSeconds[i] += log.seconds;
    }
  }

  return {
    pickCount, offerCount, schoolPicks, stacksAtEnd, finalScores, clearedWaves, hpLeftRatios,
    wins, totalPicks, runSeconds: runSeconds / runs, waveReach, waveClear, waveSeconds,
  };
}

function scoreOf(owned, survivalWeight) {
  return scoreFromStats(computeStats(owned, cardIndex, base), survivalWeight);
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
const pct = (x) => (x * 100).toFixed(1) + '%';

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

const profiles = [
  { name: '强度党（只看输出）', survivalWeight: 0.1, noise: 0.08, steps: base.upgradeStepsPerRun },
  { name: '稳健党（看重生存）', survivalWeight: 0.6, noise: 0.3, steps: base.upgradeStepsPerRun },
  { name: '新手（随机偏多）', survivalWeight: 0.3, noise: 0.6, steps: base.upgradeStepsPerRun },
];

// 先跑完所有玩家模型，再写报告。
// 顺序不能反过来：报告的抬头要给出「真实平均单局时长」，而那个数只有跑完才知道。
// 早期版本在跑之前就写死了 `waves × (waveDuration + upgradePause)`，
// 那是「每一波都打满 30 秒」的理论上限，比真实值高出一倍，直接把时长目标架空了。
const results = profiles.map((profile) => {
  const rng = mulberry32(SEED);
  return { profile, res: simulate(profile, RUNS, rng) };
});
const realMinutes = avg(results.map((r) => r.res.runSeconds)) / 60;
const lengthVerdict =
  realMinutes < 6 ? '**低于目标：一局太快结束，玩家来不及感受到 Build 成型**'
    : realMinutes > 10 ? '**高于目标：超出移动端单次游玩的耐心上限**'
      : '落在目标区间内';

// 单局时长是产品级约束（用户明确要求 6-10 分钟），但它测不到「某一个函数」上，
// 因此不能写成单元测试——它取决于波数、波次时长、敌人数值、玩家成长曲线四者的合力。
// 放在这里强制执行：只要改动任何一处数值把它带出区间，npm run check 就会失败。
const RUN_MINUTES_TARGET = [6, 10];
const lengthOk = realMinutes >= RUN_MINUTES_TARGET[0] && realMinutes <= RUN_MINUTES_TARGET[1];

say('# Monte Carlo 抽卡与通关模拟报告');
say('');
say(`- 数值表版本：**${data.version}**（${data.status}）`);
say(`- 模拟规模：${RUNS} 局 × 每局 ${base.upgradeStepsPerRun} 次三选一 / 固定随机种子 ${SEED}`);
say(`- 单局时长（模拟真实累计）：**${realMinutes.toFixed(2)} 分钟** —— ${lengthVerdict}`);
say(`  - 构成为「各波清空耗时之和 + ${base.waves} × ${data.enemy.upgradePauseSec}s 强化选择」；上限 ${(base.waves * (base.waveDuration + data.enemy.upgradePauseSec) / 60).toFixed(1)} 分钟`);
say(`  - 阵亡局按「血量耗尽的那一刻」计时，不会虚假地按打满整波计算`);
say('- 模型：解析式波次评估（含死亡判定、含 Build 逐波成长），只比较 Build 相对强弱，不含走位与操作');
say('');

// 波次难度基准表：设计文档要用的硬数据
say('## 波次难度基准');
say('');
say('| 波次 | 敌人数量 | 敌人总血量 | 通关所需 DPS | 敌人 DPS |');
say('|---|---|---|---|---|');
for (let w = 1; w <= base.waves; w++) {
  const s = waveStats(w, data);
  say(`| ${w}${s.isBoss ? ' (Boss)' : ''} | ${s.count} | ${Math.round(s.totalHp)} | ${s.requiredDps.toFixed(1)} | ${s.incomingDps.toFixed(1)} |`);
}
say('');
say('> 初始 DPS = 10（攻击 10 × 攻速 1.0）。「通关所需 DPS」是**在波次时限内清空**这一波的门槛，');
say('> 达不到也能活到下一波，只是会挨一次超时反噬并且拿不到波次奖励。');
say('');

const uniform = 1 / cards.length;
let worstSpread = Infinity;

for (const { profile, res } of results) {
  const sorted = [...res.finalScores].sort((a, b) => a - b);
  const spread = percentile(sorted, 90) / Math.max(1, percentile(sorted, 10));
  worstSpread = Math.min(worstSpread, spread);

  say(`## 玩家模型：${profile.name}`);
  say('');
  say(`- 通关率：**${pct(res.wins / RUNS)}**　平均推进到第 ${avg(res.clearedWaves).toFixed(1)} 波（共 ${base.waves} 波）`);
  say(`- 结算时剩余血量：平均 ${pct(avg(res.hpLeftRatios))}`);
  say(`- 平均单局时长：${(res.runSeconds / 60).toFixed(2)} 分钟`);
  say(`- 终局强度：P10 ${percentile(sorted, 10).toFixed(0)} / P50 ${percentile(sorted, 50).toFixed(0)} / P90 ${percentile(sorted, 90).toFixed(0)}`);
  say(`- 强弱差距（P90÷P10）：${spread.toFixed(2)}× —— ${spread < 1.25 ? '**过窄：每局长一个样，重玩价值不足**' : spread < 1.8 ? '偏窄：建议拉开卡牌间的收益差异' : '健康'}`);
  say('');
  say('| 卡牌 | 流派 | 层数 | 被选中占比 | 出现即被选 | 平均终局层数 | 判定 |');
  say('|---|---|---|---|---|---|---|');

  const rows = cards
    .map((c) => {
      const picked = res.pickCount.get(c.id) ?? 0;
      const offered = res.offerCount.get(c.id) ?? 0;
      const share = res.totalPicks ? picked / res.totalPicks : 0;
      const conv = offered ? picked / offered : 0;
      let verdict = '正常';
      if (share < 0.02) verdict = '**死亡卡**';
      else if (share > 0.12) verdict = '**主导卡**';
      return { c, share, conv, stacks: res.stacksAtEnd.get(c.id) ?? 0, verdict };
    })
    .sort((a, b) => b.share - a.share);

  for (const r of rows) {
    say(`| ${r.c.name} | ${r.c.school} | ${r.c.tier} | ${pct(r.share)} | ${pct(r.conv)} | ${r.stacks.toFixed(2)} | ${r.verdict} |`);
  }
  say('');
  say(`> 均匀分布基准 ${pct(uniform)}；显著高于基准 = 在所有 Build 里都是最优解，显著低于 = 数值没有意义。`);
  say('');

  // 难度曲线：只有看到「每波平均花多久、多少比例的局能清空」，才能判断曲线是
  // 单调加压还是中间有断层。只看通关率是看不到这件事的。
  const window = Math.max(1, base.waveDuration - Math.min(base.waveDuration * 0.5, data.enemy.approachOverheadSec ?? 0));
  const curve = [];
  for (let w = 0; w < base.waves; w++) {
    if (!res.waveReach[w]) { curve.push(`${w + 1}:—`); continue; }
    const rate = res.waveClear[w] / res.waveReach[w];
    const secs = res.waveSeconds[w] / res.waveReach[w];
    curve.push(`${w + 1}:${Math.round(rate * 100)}%/${secs.toFixed(1)}s`);
  }
  say(`**逐波清空率 / 平均耗时**（窗口上限 ${window.toFixed(1)}s）：`);
say('');
  say(curve.join('　'));
  say('');

  const schoolRows = data.schools
    .map((s) => ({ s, n: res.schoolPicks.get(s) ?? 0 }))
    .sort((a, b) => b.n - a.n);
  say('**流派占比**：' + schoolRows.map((r) => `${r.s} ${pct(r.n / res.totalPicks)}`).join(' / '));
  say('');
}

// 结构结论：这段是给设计决策用的，不是给机器看的
say('## 结构结论');
say('');
say(`- 真实平均单局时长：${realMinutes.toFixed(2)} 分钟（目标区间 6-10 分钟）`);
say(`- 最窄的强弱差距：${worstSpread.toFixed(2)}×`);
say(`- 均匀基准：${pct(uniform)}；判定阈值：低于 2% 为死亡卡，高于 12% 为主导卡`);
say('- 判定按各玩家模型独立计算。风格专精卡（双暴卡、纯生存卡）在另一种模型下低选率属正常现象，不是设计缺陷；只有**在所有模型下**都低于 2% 才是真正的废卡');
say('- 提醒：本报告的全部数值来源为 PLACEHOLDER 表，结论只用于发现结构问题；据此调整数值后应重跑并对比');

mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, lines.join('\n') + '\n', 'utf-8');
console.log('');
console.log('报告已写入：' + REPORT_PATH);

if (!lengthOk) {
  console.error('');
  console.error(
    `✗ 单局时长 ${realMinutes.toFixed(2)} 分钟，超出设计目标 ${RUN_MINUTES_TARGET.join('-')} 分钟。`,
  );
  console.error('  这是产品级约束，请调整 design/numbers/cards.json 的 base.waves 或 enemy 段。');
  process.exitCode = 1;
}
