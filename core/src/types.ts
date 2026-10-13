/**
 * 纯逻辑层类型定义
 *
 * 约束：本目录不得 import 任何引擎 API（cc.*、wx.*、tt.*）
 * 目的：逻辑层可脱离引擎单测、可批跑 Monte Carlo，这是开发期能否快速测试的前提
 */

export type EffectType =
  | 'atkPct'
  | 'spdPct'
  | 'chain'
  | 'critRate'
  | 'critDmg'
  | 'flatDps'
  | 'hpPct'
  | 'dmgReduce'
  | 'healOnKill';

export interface Effect {
  type: EffectType;
  value: number;
}

export interface Card {
  id: string;
  name: string;
  school: string;
  tier: number;
  maxStack: number;
  effects: Effect[];
  tags: string[];
  rationale: string;
}

export interface BaseStats {
  atk: number;
  spd: number;
  assumedWaveSize: number;
  upgradeStepsPerRun: number;
}

/** Build 聚合后的战斗属性 */
export interface BuildStats {
  /** 每秒总伤害 */
  offense: number;
  /** 生存乘区（1 = 无提升） */
  survivalMul: number;
  /** 实际命中目标数（已按波次人数封顶） */
  targets: number;
  atkMul: number;
  spdMul: number;
  critRate: number;
  critDmg: number;
  flatDps: number;
  hpPct: number;
  dmgReduce: number;
  healOnKill: number;
}

/** 玩家模型：同一张卡在不同风格玩家手里的价值不同 */
export interface PlayerProfile {
  name: string;
  /** 生存属性的权重，0 = 只看输出，0.6 = 明显偏保守 */
  survivalWeight: number;
  /** 决策噪声：有多大概率不选最优而选次优（模拟真人） */
  noise: number;
  /** 一局内的强化次数 */
  steps: number;
}

/** 一次三选一 offer */
export interface Offer {
  cards: Card[];
}
