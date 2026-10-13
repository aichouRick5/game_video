/**
 * Monte Carlo 抽卡模拟器
 *
 * 用途：在写任何战斗表现之前，用一万局批量模拟回答三个问题
 *   1. 有没有「死亡卡」——一万局里几乎没人选，说明它的收益在模型里不存在
 *   2. 有没有「主导卡」——被选中率远超均值，说明它有上位替代所有卡的强度
 *   3. 一局的终局强度分布有多窄——太窄意味着每一局都长一个样，Roguelike 的重玩价值是假的
 *
 * 运行：node --experimental-strip-types tools/sim/card-sim.ts
 * 注意：数值全部来自 design/numbers/cards.json 的 PLACEHOLDER 表，本工具找的是结构问题，不是平衡终值
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card, BaseStats, PlayerProfile } from '../../core/src/types.ts';
import { computeStats, scoreFromStats } from '../../core/src/score.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '..', '..', 'design', 'numbers', 'cards.json');
const REPORT_PATH = join(__dirname, '..', '..', 'design', 'numbers', 'sim-report.md');

interface CardTable {
  version: string;
  status: string;
  base: BaseStats;
  schools: string[];
  cards: Card[];
}

const table = JSON.parse(readFileSync(DATA_PATH, 'utf-8')) as CardTable;
const { cards, base } = table;

/** 固定种子的伪随机，保证任何人任何时间跑出的报告一致（便于 diff 与复现） */
function mulberry32(seed: number): () => number {
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
function tierWeight(c: Card): number {
  return c.tier === 1 ? 1.0 : 0.45;
}

function weightedSampleDistinct(pool: Card[], count: number, rng: () => number): Card[] {
  const bag = pool.slice();
  const picked: Card[] = [];
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

interface SimResult {
  pickCount: Map<string, number>;
  offerCount: Map<string, number>;
  schoolPicks: Map<string, number>;
  finalScores: number[];
  totalPicks: number;
}

function simulate(profile: PlayerProfile, runs: number, rng: () => number): SimResult {
  const pickCount = new Map<string, number>();
  const offerCount = new Map<string, number>();
  const schoolPicks = new Map<string, number>();
  const finalScores: number[] = [];
  let totalPicks = 0;

  for (let run = 0; run < runs; run++) {
    const owned = new Map<string, number>();

    for (let step = 0; step < profile.steps; step++) {
      const pool = cards.filter((c) => (owned.get(c.id) ?? 0) < c.maxStack);
      if (pool.length === 0) break;

      const offer = weightedSampleDistinct(pool, 3, rng);
      for (const c of offer) offerCount.set(c.id, (offerCount.get(c.id) ?? 0) + 1);

      // 用「边际增益」而不是「最终分值」排序，逼近真人的直觉判断
      const baseScore = scoreOf(owned, profile.survivalWeight);
      const ranked = offer
        .map((c) => {
          const trial = new Map(owned);
          trial.set(c.id, (trial.get(c.id) ?? 0) + 1);
          return { card: c, gain: scoreOf(trial, profile.survivalWeight) - baseScore };
        })
        .sort((a, b) => b.gain - a.gain);

      // 决策噪声：模拟真人不总选最优（噪声越高，Build 越发散，越接近真人）
      const useSecond = ranked.length > 1 && rng() < profile.noise;
      const chosen = useSecond ? ranked[1].card : ranked[0].card;

      owned.set(chosen.id, (owned.get(chosen.id) ?? 0) + 1);
      pickCount.set(chosen.id, (pickCount.get(chosen.id) ?? 0) + 1);
      schoolPicks.set(chosen.school, (schoolPicks.get(chosen.school) ?? 0) + 1);
      totalPicks++;
    }

    finalScores.push(scoreOf(owned, profile.survivalWeight));
  }

  return { pickCount, offerCount, schoolPicks, finalScores, totalPicks };
}

function scoreOf(owned: Map<string, number>, survivalWeight: number): number {
  return scoreFromStats(computeStats(owned, cards, base), survivalWeight);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

const RUNS = 10000;

const profiles: PlayerProfile[] = [
  { name: '强度党（只看输出）', survivalWeight: 0.1, noise: 0.08, steps: base.upgradeStepsPerRun },
  { name: '稳健党（看重生存）', survivalWeight: 0.6, noise: 0.3, steps: base.upgradeStepsPerRun },
];

const lines: string[] = [];
const say = (s: string) => { lines.push(s); console.log(s); };

say('# Monte Carlo 抽卡模拟报告');
say('');
say(`- 数据表版本：${table.version}（${table.status}）`);
say(`- 模拟局数：${RUNS} 局 / 每局 ${base.upgradeStepsPerRun} 次三选一 / 固定种子 20261013`);
say('- 模型：边际增益贪心 + 决策噪声，只算期望强度，不含手感与操作');
say('');

for (const profile of profiles) {
  const rng = mulberry32(20261013);
  const res = simulate(profile, RUNS, rng);
  const sorted = [...res.finalScores].sort((a, b) => a - b);

  say(`## 玩家模型：${profile.name}（生存权重 ${profile.survivalWeight} / 噪声 ${pct(profile.noise)}）`);
  say('');
  say(`终局强度：P10 ${percentile(sorted, 10).toFixed(0)} / P50 ${percentile(sorted, 50).toFixed(0)} / P90 ${percentile(sorted, 90).toFixed(0)}`);
  const spread = percentile(sorted, 90) / Math.max(1, percentile(sorted, 10));
  say(`强弱差距（P90÷P10）：${spread.toFixed(2)}× —— ${spread < 1.25 ? '**过窄，每局长得一个样，重玩价值不足**' : spread < 1.8 ? '偏窄，建议拉开卡牌间的收益差异' : '健康区间'}`);
  say('');
  say('| 卡牌 | 流派 | 层数 | 被选中占比 | 出现在选项中的比例 | 判定 |');
  say('|---|---|---|---|---|---|');

  const rows = cards
    .map((c) => {
      const picked = res.pickCount.get(c.id) ?? 0;
      const offered = res.offerCount.get(c.id) ?? 0;
      const share = res.totalPicks ? picked / res.totalPicks : 0;
      const conv = offered ? picked / offered : 0;
      let verdict = '正常';
      if (share < 0.02) verdict = '**死亡卡**：一万局几乎无人选';
      else if (share > 0.12) verdict = '**主导卡**：挤掉了其他选项';
      return { c, picked, offered, share, conv, verdict };
    })
    .sort((a, b) => b.share - a.share);

  const uniform = 1 / cards.length;
  for (const r of rows) {
    say(`| ${r.c.name} | ${r.c.school} | ${r.c.tier} | ${pct(r.share)} | ${pct(r.conv)} | ${r.verdict} |`);
  }
  say('');
  say(`> 均匀分布基准为 ${pct(uniform)}；显著高于基准 = 该卡在所有 Build 里都是最优解，显著低于 = 数值没意义。`);
  say('');

  const schoolRows = table.schools
    .map((s) => ({ s, n: res.schoolPicks.get(s) ?? 0 }))
    .sort((a, b) => b.n - a.n);
  say('**流派占比**：' + schoolRows.map((r) => `${r.s} ${pct(r.n / res.totalPicks)}`).join(' / '));
  say('');
}

mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, lines.join('\n'), 'utf-8');
console.log('');
console.log('报告已写入：' + REPORT_PATH);
