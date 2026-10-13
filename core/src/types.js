/**
 * 纯逻辑层：数据契约与常量
 *
 * 硬约束（工程三条约定之一）：本目录禁止出现 cc.* / wx.* / tt.* 等引擎与平台 API。
 * 目的：逻辑层能脱离引擎单元测试、能批量模拟，这是开发期能否快速验证数值的前提。
 *
 * 为什么用 .js + JSDoc 而不是 .ts：
 * 同一份代码要同时被 Node（单测 / Monte Carlo）、浏览器（可试玩原型）、Cocos Creator
 * （正式工程 assets/scripts/core）直接引用。TS 需要编译步骤，而 JSDoc 已能提供完整的
 * 编辑器类型提示与跳转。少一个构建步骤，就少一类环境问题。
 */

/**
 * 效果类型
 * @typedef {'atkPct'|'spdPct'|'chain'|'critRate'|'critDmg'|'flatDps'|'hpPct'|'dmgReduce'|'healOnKill'} EffectType
 */

/**
 * 卡牌效果
 * @typedef {Object} Effect
 * @property {EffectType} type
 * @property {number} value
 */

/**
 * 功法卡
 * @typedef {Object} Card
 * @property {string} id
 * @property {string} name
 * @property {string} school
 * @property {number} tier
 * @property {number} maxStack
 * @property {Effect[]} effects
 * @property {string[]} tags
 * @property {string} rationale
 */

/**
 * 基准与波次参数
 * @typedef {Object} BaseStats
 * @property {number} atk
 * @property {number} spd
 * @property {number} hp
 * @property {number} assumedWaveSize
 * @property {number} waveDuration
 * @property {number} waves
 * @property {number} upgradeStepsPerRun
 */

/**
 * 敌人成长参数
 * @typedef {Object} EnemyConfig
 * @property {number} perWave
 * @property {number} hpBase
 * @property {number} hpGrowth
 * @property {number} dpsBase
 * @property {number} dpsGrowth
 * @property {number} bossWave
 * @property {number} bossHpMul
 * @property {number} bossDpsMul
 * @property {number} waveClearHealPct
 */

/**
 * Build 聚合属性
 * @typedef {Object} BuildStats
 * @property {number} dps
 * @property {number} maxHp
 * @property {number} damageTakenMul
 * @property {number} healPerKill
 * @property {number} survivalMul
 * @property {number} targets
 * @property {number} atkMul
 * @property {number} spdMul
 * @property {number} critRate
 * @property {number} critDmg
 * @property {number} flatDps
 * @property {number} hpPct
 * @property {number} dmgReduce
 * @property {number} healOnKill
 */

/**
 * 玩家模型：同一张卡在不同风格玩家手里价值不同
 * @typedef {Object} PlayerProfile
 * @property {string} name
 * @property {number} survivalWeight 生存属性权重，0 = 只看输出
 * @property {number} noise 决策噪声：有多大概率不选最优而选次优（模拟真人）
 * @property {number} steps 一局内的强化次数
 */

/** 全部效果类型（运行时校验与遍历用） */
export const EFFECT_TYPES = Object.freeze([
  'atkPct',
  'spdPct',
  'chain',
  'critRate',
  'critDmg',
  'flatDps',
  'hpPct',
  'dmgReduce',
  'healOnKill',
]);

/** 生存向效果集合，供玩家模型识别「这张卡是不是保命的」 */
export const SURVIVAL_EFFECTS = Object.freeze(['hpPct', 'dmgReduce', 'healOnKill']);

/**
 * 击杀回血折算为生存乘区的系数
 * [PLACEHOLDER] 依据「每波击杀约 6 个目标」粗估，一旦有真实波次数据必须替换
 */
export const HEAL_ON_KILL_FACTOR = 3;

/** 减伤上限保护：任何情况下至少承受 10% 伤害，避免出现无敌 Build */
export const MIN_DAMAGE_TAKEN = 0.1;
