/**
 * 局外成长（元进度）：境界突破
 *
 * 设计意图：局内成长（拿卡）负责「这一局玩得爽」，局外成长负责「明天还想再开一局」。
 * 因此这里的加成必须是**温和且可累加**的——强到能替代局内决策，Roguelike 就退化成刷数值；
 * 弱到感知不到，留存就没有抓手。当前口径：每个境界 +5% 攻击 / +5% 生命。
 *
 * 目前只有「境界」一条成长线。原本还规划了「功法碎片」，但在没有真实留存数据前，
 * 多一条成长线只会让数值校准的变量翻倍，因此**暂不实现**（工程原则：不留空壳功能）。
 *
 * 所有函数为纯函数：接收旧状态，返回新状态，不做原地修改。这样存档、回滚、单测都简单。
 */

/**
 * @typedef {Object} MetaState
 * @property {number} realm 当前境界阶数（0 = 炼气）
 * @property {number} spirit 当前可用灵石
 * @property {Object} stats 生涯统计
 */

/**
 * 创建初始局外状态
 * @returns {MetaState}
 */
export function createMetaState() {
  return {
    realm: 0,
    spirit: 0,
    stats: {
      runs: 0,
      clears: 0,
      bestWave: 0,
      bestRunSeconds: 0,
      totalKills: 0,
      totalSpirit: 0,
    },
  };
}

/** 境界名。超出表长时用「境界 N」兜底，避免因为未来的数值调整而崩溃 */
export function realmName(realm, data) {
  const names = data.meta.realmNames;
  return names[realm] ?? `境界 ${realm + 1}`;
}

/** 是否已达最高境界 */
export function isMaxRealm(meta, data) {
  return meta.realm >= data.meta.realmNames.length - 1;
}

/**
 * 从当前境界突破到下一境界所需灵石
 * 递增曲线 1.75 倍：让第一个境界在第 1-2 局内可达（即时正反馈），
 * 后面的境界逐步变成长期目标
 */
export function breakthroughCost(meta, data) {
  if (isMaxRealm(meta, data)) return Infinity;
  return Math.round(data.meta.realmCostBase * Math.pow(data.meta.realmCostGrowth, meta.realm));
}

/** 是否买得起下一次突破 */
export function canBreakthrough(meta, data) {
  return !isMaxRealm(meta, data) && meta.spirit >= breakthroughCost(meta, data);
}

/**
 * 执行突破，返回新的局外状态
 * @returns {{ state: MetaState, ok: boolean }}
 */
export function breakthrough(meta, data) {
  if (!canBreakthrough(meta, data)) return { state: meta, ok: false };
  const cost = breakthroughCost(meta, data);
  return {
    state: { ...meta, realm: meta.realm + 1, spirit: meta.spirit - cost },
    ok: true,
  };
}

/**
 * 把境界折算成战斗加成。battle.js 通过 metaBonus 接收，自己不关心「境界」这个概念
 * @returns {{ atkMul: number, hpMul: number }}
 */
export function metaBonus(meta, data) {
  return {
    atkMul: 1 + meta.realm * data.meta.realmAtkBonus,
    hpMul: 1 + meta.realm * data.meta.realmHpBonus,
  };
}

/**
 * 一局结束后结算：发放灵石、更新生涯统计
 *
 * @param {MetaState} meta
 * @param {ReturnType<import('./battle.js').createBattle>['result'] extends () => infer R ? R : any} result
 * @param {any} data
 * @returns {MetaState}
 */
export function settleRun(meta, result, data) {
  const earned = Math.max(0, Math.floor(result.spirit ?? 0));
  const totalRuns = meta.stats.runs + 1;
  const clears = meta.stats.clears + (result.cleared ? 1 : 0);

  return {
    ...meta,
    spirit: meta.spirit + earned,
    stats: {
      runs: totalRuns,
      clears,
      // 通关时「到达波次」等于总波数；用 max 记录生涯最远推进
      bestWave: Math.max(meta.stats.bestWave, result.reachedWave ?? 0),
      // 只有通关才记录最快用时，否则「早死」会霸榜
      bestRunSeconds: result.cleared
        ? meta.stats.bestRunSeconds > 0
          ? Math.min(meta.stats.bestRunSeconds, result.runTime)
          : result.runTime
        : meta.stats.bestRunSeconds,
      totalKills: meta.stats.totalKills + (result.kills ?? 0),
      totalSpirit: meta.stats.totalSpirit + earned,
    },
  };
}

/** 通关率，用于结算面板展示（无局数时返回 0，避免 NaN 进入 UI） */
export function clearRate(meta) {
  if (meta.stats.runs <= 0) return 0;
  return meta.stats.clears / meta.stats.runs;
}
