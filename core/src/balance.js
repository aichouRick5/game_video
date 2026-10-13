/**
 * 解析式波次评估（纯函数）
 *
 * 用途：Monte Carlo 批量跑——一万局只需几百毫秒，用来暴露结构性问题（死亡卡 / 主导卡 / 方差过窄）。
 * 边界：不含走位、不含技能释放时机、不含操作水平，因此比真实战斗乐观。
 *      它只用于比较不同 Build 之间的相对强弱，不能用来预测绝对通关时间。
 *
 * v0.2 关键改动：引入死亡判定。v0.1 没有死亡风险，导致所有生存卡在模型里价值为零
 * （心法流被选中率仅 3.6%），这是模型缺陷而不是设计缺陷。
 */

/**
 * 逐波结算一局
 *
 * 模型逻辑：
 *   1. 每波持续固定时长（base.waveDuration），波内敌人总血量随波次指数增长
 *   2. 玩家的输出能否在波次时长内清光敌人，用 overflow 表示「清不动」的程度
 *   3. 承受伤害 = 敌人 DPS × 波次时长 × 减伤 ×（1 + 清不动惩罚）
 *   4. 血量归零即失败；每波结束有基础回复（回血泉），避免跨波累计伤害过于严苛
 *
 * @param {import('./types.js').BuildStats} stats
 * @param {{ base: import('./types.js').BaseStats, enemy: import('./types.js').EnemyConfig }} data
 * @returns {{ dead: boolean, clearedWave: number, hp: number, totalDamage: number, runSeconds: number, waveLogs: Array<{wave:number, waveHp:number, dealt:number, overflow:number, taken:number, hp:number}> }}
 */
export function evaluateRun(stats, data) {
  const { base, enemy } = data;
  const waveSeconds = base.waveDuration;
  const upgradePause = enemy.upgradePauseSec ?? 3;

  let hp = stats.maxHp;
  let totalDamage = 0;
  /** @type {Array<{wave:number, waveHp:number, dealt:number, overflow:number, taken:number, hp:number}>} */
  const waveLogs = [];

  for (let wave = 1; wave <= base.waves; wave++) {
    const isBoss = wave === enemy.bossWave;
    const count = isBoss ? 1 : enemy.perWave;
    const hpGrowth = Math.pow(enemy.hpGrowth, wave - 1);
    const waveHp = enemy.hpBase * hpGrowth * count * (isBoss ? enemy.bossHpMul : 1);
    const incoming = count * enemy.dpsBase * Math.pow(enemy.dpsGrowth, wave - 1) * (isBoss ? enemy.bossDpsMul : 1);

    const dealt = stats.dps * waveSeconds;
    // 接触时长 = 清光这波敌人所需的时间（有上限）。输出越高 → 暴露时间越短 → 挨打越少，
    // 这是本模型的核心自我平衡机制；v0.2 初版错误地把敌人当成全程满员输出 30 秒，导致通关率 0%
    const exposure = Math.min(waveHp / stats.dps, waveSeconds);
    // overflow: 0 = 波末清光有余力；>0 = 没打完，残余敌人持续输出并惩罚加倍
    const overflow = Math.max(0, (waveHp - dealt) / waveHp);
    const taken = incoming * exposure * stats.damageTakenMul * (1 + overflow * 1.5);
    const healed = count * stats.healPerKill + stats.maxHp * (enemy.waveClearHealPct ?? 0);

    hp = Math.min(stats.maxHp, hp - taken + healed);
    totalDamage += taken;
    waveLogs.push({ wave, waveHp, dealt, overflow, taken, hp });

    if (hp <= 0) {
      return {
        dead: true,
        clearedWave: wave - 1,
        hp: 0,
        totalDamage,
        runSeconds: (wave - 1) * (waveSeconds + upgradePause),
        waveLogs,
      };
    }
  }

  return {
    dead: false,
    clearedWave: base.waves,
    hp,
    totalDamage,
    // 单局时长由波次时长决定（12 × 33 秒 ≈ 6.6 分钟），DPS 只影响通关与否与剩余血量
    runSeconds: base.waves * (waveSeconds + upgradePause),
    waveLogs,
  };
}

/**
 * 给定波次，返回该波的敌人总血量与敌人 DPS（供 Debug 面板与设计文档引用）
 * @param {number} wave
 * @param {{ base: import('./types.js').BaseStats, enemy: import('./types.js').EnemyConfig }} data
 */
export function waveStats(wave, data) {
  const { enemy } = data;
  const isBoss = wave === enemy.bossWave;
  const count = isBoss ? 1 : enemy.perWave;
  return {
    isBoss,
    count,
    totalHp: enemy.hpBase * Math.pow(enemy.hpGrowth, wave - 1) * count * (isBoss ? enemy.bossHpMul : 1),
    incomingDps: count * enemy.dpsBase * Math.pow(enemy.dpsGrowth, wave - 1) * (isBoss ? enemy.bossDpsMul : 1),
    requiredDps: (enemy.hpBase * Math.pow(enemy.hpGrowth, wave - 1) * count * (isBoss ? enemy.bossHpMul : 1)) / data.base.waveDuration,
  };
}
