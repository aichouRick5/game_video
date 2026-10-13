/**
 * Build 评分模型（纯函数，无副作用，无引擎依赖）
 *
 * 模型职责：把「已持有的卡牌组合」折算成一个可比大小的强度值，供贪心 AI 或玩家模型做决策。
 * 模型边界：只算期望强度，不算手感、不算站位、不算技能释放时机。
 */

import type { Card, BaseStats, BuildStats } from './types.ts';

/** 击杀回血折算为生存乘区的系数 [PLACEHOLDER · 依据‘每波击杀约 6 个目标’的粗估，需用真实波次数据替换] */
const HEAL_ON_KILL_FACTOR = 2;

export function createOwned(): Map<string, number> {
  return new Map<string, number>();
}

/** 按卡牌持有数聚合出战斗属性 */
export function computeStats(
  owned: Map<string, number>,
  cards: Card[],
  base: BaseStats,
): BuildStats {
  const byId = new Map<string, Card>();
  for (const c of cards) byId.set(c.id, c);

  let atkPct = 0;
  let spdPct = 0;
  let chain = 0;
  let critRate = 0;
  let critDmg = 0;
  let flatDps = 0;
  let hpPct = 0;
  let dmgReduce = 0;
  let healOnKill = 0;

  for (const [id, count] of owned) {
    const card = byId.get(id);
    if (!card) continue;
    for (const e of card.effects) {
      const v = e.value * count;
      switch (e.type) {
        case 'atkPct': atkPct += v; break;
        case 'spdPct': spdPct += v; break;
        case 'chain': chain += v; break;
        case 'critRate': critRate += v; break;
        case 'critDmg': critDmg += v; break;
        case 'flatDps': flatDps += v; break;
        case 'hpPct': hpPct += v; break;
        case 'dmgReduce': dmgReduce += v; break;
        case 'healOnKill': healOnKill += v; break;
      }
    }
  }

  const atkMul = 1 + atkPct;
  const spdMul = 1 + spdPct;
  // 连锁收益按同屏人数封顶：超过 6 目标的连锁在这个波次模型里没有价值
  const targets = Math.min(1 + chain, base.assumedWaveSize);
  const cr = Math.min(Math.max(critRate, 0), 1);

  // 输出乘区：攻击 × 攻速 × 命中目标数 × 暴击期望，固定伤害不参与乘区（这是刻意的：flat 卡应前中期强后期弱）
  const offense = base.atk * atkMul * base.spd * spdMul * targets * (1 + cr * critDmg) + flatDps;

  // 生存乘区：生命、减伤、击杀回血三者各自相乘
  const survivalMul = (1 + hpPct) * (1 + dmgReduce + HEAL_ON_KILL_FACTOR * healOnKill);

  return {
    offense,
    survivalMul,
    targets,
    atkMul,
    spdMul,
    critRate: cr,
    critDmg,
    flatDps,
    hpPct,
    dmgReduce,
    healOnKill,
  };
}

/** 把属性折算为单一分值；survivalWeight 决定这个玩家有多看重生存 */
export function scoreFromStats(s: BuildStats, survivalWeight: number): number {
  return s.offense * (1 + survivalWeight * (s.survivalMul - 1));
}

export function scoreBuild(
  owned: Map<string, number>,
  cards: Card[],
  base: BaseStats,
  survivalWeight: number,
): number {
  return scoreFromStats(computeStats(owned, cards, base), survivalWeight);
}
