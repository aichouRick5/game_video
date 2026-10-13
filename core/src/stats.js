/**
 * Build 属性聚合与评分（纯函数，无副作用，无引擎依赖）
 *
 * 职责：把「已持有的卡牌组合」折算成可比大小的战斗属性与单一强度分值。
 * 边界：只算期望强度，不算手感、不算站位、不算技能时机。
 */

import { HEAL_ON_KILL_FACTOR, MIN_DAMAGE_TAKEN, SURVIVAL_EFFECTS } from './types.js';

/**
 * 建立卡牌索引，避免每次结算都遍历数组
 * @param {import('./types.js').Card[]} cards
 * @returns {Map<string, import('./types.js').Card>}
 */
export function buildCardIndex(cards) {
  const index = new Map();
  for (const card of cards) index.set(card.id, card);
  return index;
}

/** 创建空的持有表（卡牌 id -> 层数） */
export function createOwned() {
  return new Map();
}

/** 复制持有表（用于试算「拿了这张卡会怎样」而不污染原状态） */
export function cloneOwned(owned) {
  return new Map(owned);
}

/**
 * 增加一层卡牌，返回新的持有表
 * @param {Map<string, number>} owned
 * @param {string} id
 */
export function withCard(owned, id) {
  const next = cloneOwned(owned);
  next.set(id, (next.get(id) ?? 0) + 1);
  return next;
}

/** 已持有卡牌总层数 */
export function totalStacks(owned) {
  let n = 0;
  for (const count of owned.values()) n += count;
  return n;
}

/**
 * 聚合出战斗属性
 * @param {Map<string, number>} owned
 * @param {Map<string, import('./types.js').Card>} cardIndex
 * @param {import('./types.js').BaseStats} base
 * @returns {import('./types.js').BuildStats}
 */
export function computeStats(owned, cardIndex, base) {
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
    const card = cardIndex.get(id);
    if (!card) continue;
    for (const effect of card.effects) {
      const v = effect.value * count;
      switch (effect.type) {
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
  // 连锁收益按同屏目标数封顶：超过 assumedWaveSize 的连锁在这个波次模型里没有价值
  const targets = Math.min(1 + chain, base.assumedWaveSize);
  const crit = Math.min(Math.max(critRate, 0), 1);

  // 输出乘区：攻击 × 攻速 × 命中目标数 × 暴击期望；固定伤害不参与乘区，
  // 这是刻意的设计约束——让 flat 卡前中期强、后期被乘区反超，形成自然的新老交替
  const dps = base.atk * atkMul * base.spd * spdMul * targets * (1 + crit * critDmg) + flatDps;

  const maxHp = base.hp * (1 + hpPct);
  const damageTakenMul = Math.max(MIN_DAMAGE_TAKEN, 1 - dmgReduce);
  const healPerKill = healOnKill * maxHp;
  // 生存乘区：生命、减伤、击杀回血三者相乘（回血按击杀频次折算，见 HEAL_ON_KILL_FACTOR）
  const survivalMul = (1 + hpPct) * (1 + dmgReduce + HEAL_ON_KILL_FACTOR * healOnKill);

  return {
    dps,
    maxHp,
    damageTakenMul,
    healPerKill,
    survivalMul,
    targets,
    atkMul,
    spdMul,
    critRate: crit,
    critDmg,
    flatDps,
    hpPct,
    dmgReduce,
    healOnKill,
  };
}

/**
 * 把属性折算成单一分值；survivalWeight 表示这个玩家有多看重生存
 * @param {import('./types.js').BuildStats} stats
 * @param {number} survivalWeight
 */
export function scoreFromStats(stats, survivalWeight) {
  return stats.dps * (1 + survivalWeight * (stats.survivalMul - 1));
}

/**
 * 直接给一套持有表打分（内部完成属性聚合）
 * @param {Map<string, number>} owned
 * @param {Map<string, import('./types.js').Card>} cardIndex
 * @param {import('./types.js').BaseStats} base
 * @param {number} survivalWeight
 */
export function scoreBuild(owned, cardIndex, base, survivalWeight) {
  return scoreFromStats(computeStats(owned, cardIndex, base), survivalWeight);
}

/**
 * 判断一张卡是否为生存向（用于玩家模型与 Debug 面板分类）
 * @param {import('./types.js').Card} card
 */
export function isSurvivalCard(card) {
  return card.effects.some((e) => SURVIVAL_EFFECTS.includes(e.type));
}

/**
 * 计算「再拿一张某卡」的边际收益
 * @param {Map<string, number>} owned
 * @param {import('./types.js').Card} card
 * @param {Map<string, import('./types.js').Card>} cardIndex
 * @param {import('./types.js').BaseStats} base
 * @param {number} survivalWeight
 */
export function marginalGain(owned, card, cardIndex, base, survivalWeight) {
  const before = scoreBuild(owned, cardIndex, base, survivalWeight);
  const after = scoreBuild(withCard(owned, card.id), cardIndex, base, survivalWeight);
  return after - before;
}
