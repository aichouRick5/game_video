/**
 * 数值参数搜索器（开发者工具，只在本地调参时使用）
 *
 * 解决的问题：
 *   「通关率」和「单局时长」这两个目标互相拉扯。波次太软 → 每波几秒清光 → 一局只有 3 分钟；
 *   波次太硬 → 玩家在第 6 波就死 → 一局又太短。手改一次数值、跑一遍模拟、看一眼结果，
 *   一个循环要一分钟，靠直觉试十几轮就是十几分钟，而且找不到全局最优。
 *
 * 做法：
 *   把敌人侧参数当成搜索空间，遍历网格，对每一组算「与目标的距离」，按距离排序。
 *
 * 关键性能技巧：
 *   玩家在一局里抽到哪套 Build，只由「卡牌数值 + 随机种子」决定，与敌人参数无关。
 *   所以同一套 Build 可以对所有候选参数复用——先预生成 Build（贵），再反复评估（便宜）。
 *   直接暴力重跑的话，每个组合都要重新抽 18 次三选一，是这条路径的几十倍开销。
 *
 * 用法：node tools/sim/tune-grid.mjs
 * 输出：控制台表格（不修改任何文件）；选定参数后手动写回 design/numbers/cards.json
 */

import { CARDS_DATA } from '../../core/src/data.generated.js';
import { buildCardIndex, computeStats, scoreFromStats, withCard } from '../../core/src/stats.js';
import { evaluateRun } from '../../core/src/balance.js';

// ---------------------------------------------------------------------------
// 目标：调参的唯一依据。改这里就是改「什么叫好玩」
// ---------------------------------------------------------------------------

/**
 * 每种玩家风格的通关率目标区间（闭区间，百分比）
 *
 * 这三个区间不是拍脑袋定的，它们来自一条设计意图：
 *   「纯输出流应该处在『后半程血量吃紧』的边缘，补一两张生存卡就能显著变稳。」
 * 因此三种风格的期望难度是**阶梯式**的，而不是「大家差不多」：
 *   - 强度党（全场只拿输出卡）应该是危险的那一档，但也不能变成陷阱选项
 *   - 稳健党（生存权重 0.6）拿全部身家换生存，通关率高是应该的——
 *     这不是平衡失败，是「把资源全押在防御上」的合理回报
 *   - 新手（随机偏多）落在中间
 *
 * 区间的下限曾经定得更高（稳健党 70-88%），但网格搜索证明那组目标
 * 在这一套战斗模型下**无解**：生存流的有效血量是输出流的三倍以上，
 * 任何能压低稳健党的全局加压都会先把强度党打到 20% 以下。
 * 与其为了一个数字把输出流做成陷阱，不如承认这条阶梯。
 */
const PASS_TARGET = {
  '强度党': [35, 55],
  '稳健党': [80, 93],
  '新手': [55, 78],
};

/** 单局时长目标（分钟） */
const RUN_MINUTES = [6.0, 10.0];

/**
 * Boss 击杀率目标（只针对「强度党」这种纯输出流）。
 * 不强求所有人能打死 Boss——「打不过就扛过去」是有意的双解设计。
 * 但如果连纯输出流都打不死，那这个 Boss 就只是块背景板。
 */
const BOSS_KILL_TARGET = [30, 75];

/** 每套 Build 的抽样局数。越多越准，但预生成越慢；1000 局的标准误差约 ±1.5% */
const RUNS = 1000;
const SEED = 20261013;

// ---------------------------------------------------------------------------
// 搜索空间：只放「真正影响难度」的旋钮
// ---------------------------------------------------------------------------

const GRID = {
  // 敌人血量成长：决定波次曲线有多陡，是难度的一阶旋钮
  hpGrowth: [1.187, 1.2, 1.21, 1.22],
  // 敌人基础 DPS：决定「挨打」这件事本身有多痛
  dpsBase: [0.05, 0.07, 0.09, 0.12],
  // 敌人 DPS 成长：决定后期压力是否跟得上玩家成长。
  // 它比 hpGrowth 更针对「肉盾流」——血量与减伤是乘算的，只有让敌人伤害的
  // 成长速度超过玩家生存属性的成长速度，堆血这一条路才会开始吃力。
  dpsGrowth: [1.076, 1.095, 1.11, 1.125],
  // 每波结束的回血泉。注意它按「生命上限的百分比」结算，
  // 于是对高血量的肉盾流是双重收益（血多 → 回得也多）。
  waveClearHealPct: [0.06, 0.04, 0.025, 0.015],
  // Boss 血量倍率。当前值 5 让 Boss 成了一个谁都打不死的摆设（清空率 0%），
  // 所有人都是靠「扛过 30 秒」过的——「击杀秘境之主」这个高潮体验从未发生过。
  bossHpMul: [1.8, 1.4, 1.1, 0.85],
};

// ---------------------------------------------------------------------------
// 玩家模型：与 tools/sim/card-sim.mjs 保持同一套定义，否则两个工具会给出矛盾的结论
// ---------------------------------------------------------------------------

const PROFILES = [
  { name: '强度党', survivalWeight: 0.1, noise: 0.08 },
  { name: '稳健党', survivalWeight: 0.6, noise: 0.3 },
  { name: '新手', survivalWeight: 0.3, noise: 0.6 },
];

/** 与 card-sim.mjs 完全相同的伪随机（mulberry32），保证两个工具口径一致 */
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

const data = CARDS_DATA;
const cards = data.cards;
const cardIndex = buildCardIndex(cards);
const base = data.base;

/** tier2 更稀有（与 card-sim.mjs 一致） */
const tierWeight = (card) => (card.tier === 1 ? 1.0 : 0.45);

/** 按权重不重复抽样（与 card-sim.mjs 一致） */
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
 * 预生成一批「逐波属性时间线」。
 *
 * 这是本工具的加速核心：抽卡过程只依赖卡牌数值，不依赖敌人数值，
 * 因此整个搜索过程只需要跑一次。
 *
 * 注意返回的是时间线（每波一套属性）而不是最后一套属性——真实游戏是
 * 「先三选一，再打一波」，第 1 波只有 1 张卡。传最后一套属性会抹平难度曲线，
 * 搜索出来的参数在实机上完全不成立。
 * @param {{name:string, survivalWeight:number, noise:number}} profile
 */
function buildSample(profile) {
  const rng = mulberry32(SEED);
  const out = [];
  for (let run = 0; run < RUNS; run++) {
    let owned = new Map();
    const timeline = [];
    for (let step = 0; step < base.upgradeStepsPerRun; step++) {
      const pool = cards.filter((c) => (owned.get(c.id) ?? 0) < c.maxStack);
      if (pool.length === 0) break;
      const offer = sampleDistinct(pool, 3, rng);
      const before = scoreFromStats(computeStats(owned, cardIndex, base), profile.survivalWeight);
      const ranked = offer
        .map((card) => ({
          card,
          gain: scoreFromStats(computeStats(withCard(owned, card.id), cardIndex, base), profile.survivalWeight) - before,
        }))
        .sort((a, b) => b.gain - a.gain);
      const chosen = ranked.length > 1 && rng() < profile.noise ? ranked[1].card : ranked[0].card;
      owned = withCard(owned, chosen.id);
      timeline.push(computeStats(owned, cardIndex, base));
    }
    out.push(timeline);
  }
  return out;
}

/** 用候选参数评估一批已生成的时间线，返回通关率、Boss 击杀率与平均单局分钟数 */
function evaluate(samples, override) {
  const patched = {
    ...data,
    enemy: { ...data.enemy, ...override },
  };
  let wins = 0;
  let seconds = 0;
  let cleared = 0;
  let bossKilled = 0;
  for (const timeline of samples) {
    const r = evaluateRun(timeline, patched);
    if (!r.dead) wins++;
    seconds += r.runSeconds;
    cleared += r.clearedWave;
    // Boss 波有没有被打空，和「有没有活下来」是两件事。
    // 只统计通关率的话，「扛过 30 秒」和「把秘境之主打死」会被混为一谈。
    const bossLog = r.waveLogs.find((l) => l.wave === data.enemy.bossWave);
    if (bossLog && bossLog.overflow <= 0) bossKilled++;
  }
  return {
    passRate: wins / samples.length,
    bossKillRate: bossKilled / samples.length,
    minutes: seconds / samples.length / 60,
    clearedWave: cleared / samples.length,
  };
}

// 预生成一次，后面所有组合共用
console.log(`预生成 Build 样本：${PROFILES.length} 种风格 × ${RUNS} 局 ...`);
const samples = new Map(PROFILES.map((p) => [p.name, buildSample(p)]));
console.log('完成。开始网格搜索 ...\n');

/** 展开网格为候选参数列表（笛卡尔积） */
function* combinations() {
  for (const hpGrowth of GRID.hpGrowth)
    for (const dpsBase of GRID.dpsBase)
      for (const dpsGrowth of GRID.dpsGrowth)
        for (const waveClearHealPct of GRID.waveClearHealPct)
          for (const bossHpMul of GRID.bossHpMul)
            yield { hpGrowth, dpsBase, dpsGrowth, waveClearHealPct, bossHpMul };
}

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

/**
 * 打分：越小越好。
 *   - 通关率落在目标区间内得 0 分，出区间按百分点的平方惩罚（惩罚「错得离谱」而不是「差一点」）
 *   - 单局时长同理，用分钟偏差
 *   - Boss 击杀率：只要求「输出流有较大机会打死」，不强求每种风格都能打死
 *   - 时长权重略低：时长可以由波数等外围参数补偿，通关率不行
 */
function scoreOf(row) {
  let score = 0;
  for (const p of PROFILES) {
    const [lo, hi] = PASS_TARGET[p.name];
    const v = row[p.name] * 100;
    const dev = v < lo ? lo - v : v > hi ? v - hi : 0;
    score += dev * dev;
  }
  const m = row.minutes;
  const mdev = m < RUN_MINUTES[0] ? RUN_MINUTES[0] - m : m > RUN_MINUTES[1] ? m - RUN_MINUTES[1] : 0;
  score += mdev * mdev * 2;
  const [blo, bhi] = BOSS_KILL_TARGET;
  const bv = row['强度党_boss'] * 100;
  const bdev = bv < blo ? blo - bv : bv > bhi ? bv - bhi : 0;
  score += bdev * bdev;
  return score;
}

const results = [];
for (const override of combinations()) {
  const row = { ...override };
  row.minutes = 0;
  for (const p of PROFILES) {
    const r = evaluate(samples.get(p.name), override);
    row[p.name] = r.passRate;
    row[`${p.name}_boss`] = r.bossKillRate;
    // 时长取三种风格的平均
    row.minutes += r.minutes / PROFILES.length;
  }
  row.score = scoreOf(row);
  results.push(row);
}

results.sort((a, b) => a.score - b.score);

const pctS = (x) => `${(x * 100).toFixed(1)}%`.padStart(6);
console.log(
  'hpGro dpsBase dpsGro heal%  bossHp | 强度党  稳健党   新手  | Boss击杀 | 时长(分) | 距目标',
);
console.log('-'.repeat(94));
for (const r of results.slice(0, 18)) {
  const mark = r.score === 0 ? '  <= 达标' : '';
  console.log(
    `${r.hpGrowth.toFixed(3)} ${r.dpsBase.toFixed(3).padStart(7)} ${r.dpsGrowth
      .toFixed(3)
      .padStart(6)} ${(r.waveClearHealPct * 100).toFixed(1).padStart(5)} ${r.bossHpMul
      .toFixed(1)
      .padStart(6)} | ${pctS(r['强度党'])} ${pctS(r['稳健党'])} ${pctS(r['新手'])} |` +
      ` ${pctS(r['强度党_boss'])}  | ${r.minutes.toFixed(2).padStart(6)}  | ${r.score.toFixed(1).padStart(6)}${mark}`,
  );
}

console.log('');
console.log('当前数值表（对照组）：');
const nowRow = { minutes: 0 };
for (const p of PROFILES) {
  const r = evaluate(samples.get(p.name), {});
  nowRow[p.name] = r.passRate;
  nowRow[`${p.name}_boss`] = r.bossKillRate;
  nowRow.minutes += r.minutes / PROFILES.length;
}
console.log(
  `  hpGrowth ${data.enemy.hpGrowth} / dpsBase ${data.enemy.dpsBase} / dpsGrowth ${data.enemy.dpsGrowth} / heal ${data.enemy.waveClearHealPct} / bossHpMul ${data.enemy.bossHpMul}`,
);
console.log(
  `  → 强度党 ${pctS(nowRow['强度党']).trim()}  稳健党 ${pctS(nowRow['稳健党']).trim()}  新手 ${pctS(nowRow['新手']).trim()}  Boss击杀 ${pctS(nowRow['强度党_boss']).trim()}  时长 ${nowRow.minutes.toFixed(2)} 分钟（score ${scoreOf(nowRow).toFixed(1)}）`,
);
console.log('');
console.log('目标：强度党 ' + PASS_TARGET['强度党'].join('-') + '% / 稳健党 ' + PASS_TARGET['稳健党'].join('-') + '% / 新手 ' + PASS_TARGET['新手'].join('-') + '% / Boss击杀 ' + BOSS_KILL_TARGET.join('-') + '% / 时长 ' + RUN_MINUTES.join('-') + ' 分钟');
console.log(`候选组合数：${results.length}（每种风格各 ${RUNS} 局）`);

// ---------------------------------------------------------------------------
// 决赛对比
//
// 「达标」不等于「好玩」。上面那批组合的通关率与时长都合格，但难度曲线的**形状**
// 可以差很远：有的是「从头紧到尾」，有的是「前八波走过场、后面突然翻脸」。
// 这一段对少数几个入围组合打一局标准样本，把逐波清空率打出来，
// 让选择依据从「一个数字」变成「一条曲线」。
// ---------------------------------------------------------------------------

const FINALIST_BASE = { dpsBase: 0.05, dpsGrowth: 1.095, hpGrowth: 1.19, waveClearHealPct: 0.045 };
const FINALISTS = [];
for (const bossHpMul of [1.2, 1.6, 2.0]) {
  for (const bossDpsMul of [4, 7, 10]) {
    FINALISTS.push({
      label: `Boss血 ×${bossHpMul} / Boss伤 ×${bossDpsMul}`,
      override: { ...FINALIST_BASE, bossHpMul, bossDpsMul },
    });
  }
}

console.log('');
console.log('='.repeat(94));
console.log('决赛对比：逐波清空率（越高越轻松；0% 表示这一波必然超时）');
console.log('='.repeat(94));

for (const f of FINALISTS) {
  const detail = [];
  for (const p of PROFILES) {
    const patched = { ...data, enemy: { ...data.enemy, ...f.override } };
    const reach = new Array(base.waves).fill(0);
    const clear = new Array(base.waves).fill(0);
    const time = new Array(base.waves).fill(0);
    let wins = 0;
    let secs = 0;
    let boss = 0;
    for (const timeline of samples.get(p.name)) {
      const r = evaluateRun(timeline, patched);
      if (!r.dead) wins++;
      secs += r.runSeconds;
      for (const log of r.waveLogs) {
        reach[log.wave - 1]++;
        if (log.overflow <= 0) clear[log.wave - 1]++;
        time[log.wave - 1] += log.seconds;
      }
      const bl = r.waveLogs.find((l) => l.wave === data.enemy.bossWave);
      if (bl && bl.overflow <= 0) boss++;
    }
    detail.push({ name: p.name, pass: wins / RUNS, boss: boss / RUNS, min: secs / RUNS / 60, reach, clear, time });
  }

  console.log('');
  console.log(`【${f.label}】`);
  console.log(
    '  ' +
      JSON.stringify(f.override)
        .replace(/["{}]/g, '')
        .replace(/,/g, '  '),
  );
  for (const d of detail) {
    console.log(
      `  ${d.name}：通关 ${(d.pass * 100).toFixed(1)}%　Boss击杀 ${(d.boss * 100).toFixed(1)}%　时长 ${d.min.toFixed(2)} 分`,
    );
  }
  // 曲线看两种人：输出流（决定上界）与新手（决定中位体验）
  for (const d of [detail[0], detail[2]]) {
    const rate = [];
    const secs = [];
    for (let w = 0; w < base.waves; w++) {
      rate.push(d.reach[w] ? `${Math.round((d.clear[w] / d.reach[w]) * 100)}` : '·');
      secs.push(d.reach[w] ? (d.time[w] / d.reach[w]).toFixed(0) : '·');
    }
    console.log(`  ${d.name} 清空率(%)： ${rate.join(' ')}`);
    console.log(`  ${d.name} 平均秒数 ： ${secs.join(' ')}`);
  }
}
