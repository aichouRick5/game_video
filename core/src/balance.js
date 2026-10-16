/**
 * 解析式波次评估（纯函数）
 *
 * 用途：Monte Carlo 批量跑——一万局只需几百毫秒，用来暴露结构性问题（死亡卡 / 主导卡 / 方差过窄）。
 * 边界：不含走位、不含技能释放时机、不含操作水平，因此比真实战斗乐观。
 *      它只用于比较不同 Build 之间的相对强弱，不能用来预测绝对通关时间。
 *
 * v0.2 关键改动：引入死亡判定。v0.1 没有死亡风险，导致所有生存卡在模型里价值为零
 * （心法流被选中率仅 3.6%），这是模型缺陷而不是设计缺陷。
 *
 * v0.3.1 两处修正（均由 tools/wave-conformance.mjs 对照真实战斗时发现）：
 *   1. Boss 波只有 1 个单位，连锁/多目标卡的收益在这一波完全失效。
 *      原模型仍按常态目标数计算 DPS，把 Boss 波的输出高估了 targets 倍，
 *      于是预测「能打过」，实测每一局都在 Boss 波超时。
 *   2. 「30 秒」原本被当成纯战斗时间，但真实战斗里敌人生成后还要走位、分批进场。
 *      现在用 enemy.approachOverheadSec 把这段固定开销显式扣掉，
 *      否则模型的难度结论会系统性偏乐观。
 *
 * v0.3.2 修正一处更严重的建模错误：**成长曲线**。
 *   在此之前，本函数只接受「一份最终的 Build 属性」，等于假设玩家从第 1 波开始
 *   就已经拿满了 18 张卡。实测下来中位局第 1 波的 DPS 就是 149（游戏里第 1 波只有 1 张卡），
 *   于是每波都在 3 秒内清光，一局只有 4-5 分钟——而设计目标是 6-10 分钟。
 *   更糟的是，这个错误会让「难度曲线」整体消失：真实的 Roguelike 难度来自
 *   「成长速度能否跟上敌人成长速度」，而模型把成长完全抹平了。
 *   现在改为接受逐波属性时间线（timeline），复用同一条评估逻辑。
 */

/**
 * 把「单个属性对象」或「逐波属性时间线」统一成按波取值的函数
 *
 * 兼容单对象是为了让「固定 Build 对比不同波次」这类诊断（以及一致性核对脚本）
 * 仍然能用同一个函数，避免出现两份平行逻辑各自演化。
 *
 * @param {import('./types.js').BuildStats | import('./types.js').BuildStats[]} source
 */
function normalizeTimeline(source) {
  if (Array.isArray(source)) {
    return (wave) => source[Math.min(wave - 1, source.length - 1)];
  }
  return () => source;
}

/**
 * 逐波结算一局
 *
 * 模型逻辑：
 *   1. 每波可用时间 = 波次时长 - 进场开销（敌人生成后走到攻击范围的时间）
 *   2. 波内敌人总血量随波次指数增长；Boss 波是单个高血量单位
 *   3. 玩家的输出能否在可用时间内清光敌人，用 overflow 表示「清不动」的程度
 *   4. 承受伤害 = 敌人 DPS × 接触时长 × 减伤 ×（1 + 清不动惩罚）
 *   5. 血量归零即失败；每波结束有基础回复（回血泉）
 *
 * 血量用「比例」而不是绝对值来跨波传递：中途拿到 +生命 的卡会让上限变化，
 * 当前血量必须按比例跟着走（与 battle.js 的 applyStats 同一约定），
 * 否则要么白送一口血，要么变相掉血。
 *
 * @param {import('./types.js').BuildStats | import('./types.js').BuildStats[]} statsOrTimeline
 *        单个属性 = 全程固定 Build（诊断用）；数组 = 第 w 波用 timeline[w-1]（模拟用）
 * @param {{ base: import('./types.js').BaseStats, enemy: import('./types.js').EnemyConfig }} data
 * @returns {{ dead: boolean, clearedWave: number, hp: number, hpRatio: number, maxHp: number, totalDamage: number, runSeconds: number, waveLogs: Array<{wave:number, waveHp:number, dealt:number, overflow:number, taken:number, hp:number, seconds:number}> }}
 */
export function evaluateRun(statsOrTimeline, data) {
  const { base, enemy } = data;
  const statsAt = normalizeTimeline(statsOrTimeline);
  const waveSeconds = base.waveDuration;
  const upgradePause = enemy.upgradePauseSec ?? 3;
  // 进场开销：这一段时间玩家既不打人也不挨打，因此要从「可用输出时间」里扣掉，
  // 但不应从「接触时长」里扣——它本身就不产生接触
  const overhead = Math.min(waveSeconds * 0.5, enemy.approachOverheadSec ?? 0);
  const combatWindow = Math.max(1, waveSeconds - overhead);

  /** 当前血量占上限的比例（跨波传递真正用的是它，不是绝对血量） */
  let hpRatio = 1;
  let totalDamage = 0;
  /**
   * 真实累计战斗时长。
   *
   * 这里曾经写死成 `waves × (waveDuration + upgradePause)`，也就是「每一波都打满 30 秒」。
   * 那是一句假话——只有打不完的波次才会用满窗口，前期波次几秒就清完了。
   * 结果是模拟报告声称单局 6.6 分钟，真实原型跑出来只有 2.8 分钟，
   * 两者相差一倍以上，设计文档里的时长目标完全失去约束力。
   * 现在改为累加每波的实际清空时长，模拟报告的时长因此可以直接和真人试玩对照。
   */
  let combatSeconds = 0;
  /** @type {Array<{wave:number, waveHp:number, dealt:number, overflow:number, taken:number, hp:number, seconds:number}>} */
  const waveLogs = [];
  let lastStats = statsAt(1);

  for (let wave = 1; wave <= base.waves; wave++) {
    const stats = statsAt(wave);
    lastStats = stats;
    const maxHp = stats.maxHp;
    let hp = hpRatio * maxHp;

    const isBoss = wave === enemy.bossWave;
    const count = isBoss ? 1 : enemy.perWave;
    const hpGrowth = Math.pow(enemy.hpGrowth, wave - 1);
    const waveHp = enemy.hpBase * hpGrowth * count * (isBoss ? enemy.bossHpMul : 1);
    const incoming = count * enemy.dpsBase * Math.pow(enemy.dpsGrowth, wave - 1) * (isBoss ? enemy.bossDpsMul : 1);

    // Boss 战只有一个单位：连锁与多目标卡在这里毫无价值。
    // 这是真实存在的（玩家在 Boss 战会发现连锁卡变成白板），必须在模型里体现，
    // 否则纯输出流会被系统性高估。
    const effectiveDps = isBoss ? stats.dps / Math.max(1, stats.targets ?? 1) : stats.dps;

    const dealt = effectiveDps * combatWindow;
    // 接触时长 = 清光这波敌人所需的时间（有上限）。输出越高 → 暴露时间越短 → 挨打越少，
    // 这是本模型的核心自我平衡机制；v0.2 初版错误地把敌人当成全程满员输出 30 秒，导致通关率 0%
    const clearsIn = waveHp / effectiveDps;
    const exposure = Math.min(clearsIn, combatWindow);

    // overflow: 0 = 波末清光有余力；>0 = 没打完，残余敌人持续输出并惩罚加倍
    const overflow = Math.max(0, (waveHp - dealt) / waveHp);

    // 击杀回血只按「实际打死的那部分」结算：超时的波次里没死的敌人不会给回血。
    // 不区分的话，超时反而成了回血大户，与真实战斗（battle.js 的 killEnemy）完全相反。
    const killFraction = waveHp > 0 ? Math.min(1, dealt / waveHp) : 1;
    const healed = count * killFraction * stats.healPerKill + maxHp * (enemy.waveClearHealPct ?? 0);

    const taken = incoming * exposure * stats.damageTakenMul * (1 + overflow * 1.5);

    let secondsThisWave = overhead + exposure;
    const hpBefore = hp;
    // 血量夹到 [0, maxHp]：日志里的血量必须永远可读，负血量会让结算面板显示 "-37 / 100"。
    // 死亡判定仍然用 hp <= 0，夹到 0 不影响结论。
    hp = Math.max(0, Math.min(maxHp, hp - taken + healed));

    if (hp <= 0 && taken > 0) {
      // 阵亡发生在本波中段，而不是波末。若不计这一段，所有阵亡局都会被记成
      // 打满一整个 30 秒波次，把平均单局时长虚增一大截。
      const lethalSeconds = exposure * Math.min(1, hpBefore / taken);
      secondsThisWave = overhead + Math.max(0, lethalSeconds);
    }

    hpRatio = maxHp > 0 ? hp / maxHp : 0;
    combatSeconds += secondsThisWave;
    totalDamage += taken;
    waveLogs.push({ wave, waveHp, dealt, overflow, taken, hp, seconds: secondsThisWave });

    if (hp <= 0) {
      return {
        dead: true,
        clearedWave: wave - 1,
        hp: 0,
        hpRatio: 0,
        maxHp,
        totalDamage,
        runSeconds: combatSeconds + wave * upgradePause,
        waveLogs,
      };
    }
  }

  return {
    dead: false,
    clearedWave: base.waves,
    hp: hpRatio * lastStats.maxHp,
    hpRatio,
    maxHp: lastStats.maxHp,
    totalDamage,
    // 真实累计时长（不是「波数 × 上限」那个理论上限）
    runSeconds: combatSeconds + base.waves * upgradePause,
    waveLogs,
  };
}

/**
 * 给定波次，返回该波的敌人总血量、敌人 DPS 与清空门槛（供 Debug 面板、设计文档与一致性核对引用）
 * @param {number} wave
 * @param {{ base: import('./types.js').BaseStats, enemy: import('./types.js').EnemyConfig }} data
 */
export function waveStats(wave, data) {
  const { base, enemy } = data;
  const isBoss = wave === enemy.bossWave;
  const count = isBoss ? 1 : enemy.perWave;
  const totalHp =
    enemy.hpBase * Math.pow(enemy.hpGrowth, wave - 1) * count * (isBoss ? enemy.bossHpMul : 1);
  // 可用输出时间与 evaluateRun 保持同一口径，否则两处会各算各的
  const overhead = Math.min(base.waveDuration * 0.5, enemy.approachOverheadSec ?? 0);
  const combatWindow = Math.max(1, base.waveDuration - overhead);

  return {
    isBoss,
    count,
    totalHp,
    incomingDps:
      count * enemy.dpsBase * Math.pow(enemy.dpsGrowth, wave - 1) * (isBoss ? enemy.bossDpsMul : 1),
    /** 实际可用于输出的秒数（已扣除进场开销） */
    combatWindow,
    /** 在可用时间内清空这一波所需的 DPS */
    requiredDps: totalHp / combatWindow,
  };
}
