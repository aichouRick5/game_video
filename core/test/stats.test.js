/**
 * 属性聚合与评分测试
 *
 * 重点覆盖「边界」而不是「正常值」：所有数值 bug 都出在边界上
 * （上限封顶、下限保护、多效果叠加、固定伤害是否吃乘区）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCardIndex,
  cloneOwned,
  computeStats,
  createOwned,
  isSurvivalCard,
  marginalGain,
  scoreBuild,
  scoreFromStats,
  totalStacks,
  withCard,
} from '../src/stats.js';
import { HEAL_ON_KILL_FACTOR, MIN_DAMAGE_TAKEN } from '../src/types.js';

/** 测试用基准：刻意用整数，方便手算期望值 */
const BASE = {
  atk: 10,
  spd: 1,
  hp: 100,
  assumedWaveSize: 6,
  waveDuration: 30,
  waves: 12,
};

/** 造一张测试卡 */
function card(id, effects, extra = {}) {
  return {
    id,
    name: id,
    school: '测试',
    tier: 1,
    maxStack: 5,
    effects,
    tags: [],
    rationale: '测试卡，用于单测构造特定属性组合',
    ...extra,
  };
}

/** 用一组卡与持有表算出属性 */
function statsWith(cards, ownedPairs) {
  const index = buildCardIndex(cards);
  const owned = createOwned();
  for (const [id, n] of ownedPairs) owned.set(id, n);
  return computeStats(owned, index, BASE);
}

describe('computeStats 基础口径', () => {
  test('空 Build：DPS = 攻击 × 攻速，目标数为 1', () => {
    const s = statsWith([], []);
    assert.equal(s.dps, 10);
    assert.equal(s.maxHp, 100);
    assert.equal(s.targets, 1);
    assert.equal(s.damageTakenMul, 1);
    assert.equal(s.healPerKill, 0);
  });

  test('固定伤害不受任何乘区影响（这是刻意约束，防止 flat 卡后期不衰减）', () => {
    const cards = [
      card('flat', [{ type: 'flatDps', value: 5 }]),
      card('atk', [{ type: 'atkPct', value: 1.0 }]),
    ];
    // 攻击翻倍后：10 × 2 = 20，固定 5 原样加上 → 25，而不是 (10+5)×2 = 30
    const s = statsWith(cards, [['flat', 1], ['atk', 1]]);
    assert.equal(s.dps, 25);
  });

  test('多张同类型卡的百分比相加后统一乘算，而不是逐级复利', () => {
    const cards = [card('atk', [{ type: 'atkPct', value: 0.2 }])];
    // 5 层：1 + 0.2×5 = 2.0 倍，若是复利则会是 1.2^5 ≈ 2.49
    const s = statsWith(cards, [['atk', 5]]);
    assert.equal(s.atkMul, 2);
    assert.equal(s.dps, 20);
  });

  test('层数按 count 线性叠加', () => {
    const cards = [card('spd', [{ type: 'spdPct', value: 0.5 }])];
    assert.equal(statsWith(cards, [['spd', 2]]).spdMul, 2);
  });
});

describe('computeStats 上限与下限保护', () => {
  test('连锁目标数封顶于 assumedWaveSize', () => {
    const cards = [card('chain', [{ type: 'chain', value: 1 }], { maxStack: 20 })];
    // 10 层连锁 → 理论 11 个目标，但模型只认 6 个目标，因此封顶为 6
    const s = statsWith(cards, [['chain', 10]]);
    assert.equal(s.targets, BASE.assumedWaveSize);
  });

  test('连锁为 0 时目标数为 1（只打单体）', () => {
    assert.equal(statsWith([], []).targets, 1);
  });

  test('暴击率被夹到 100% 以内', () => {
    const cards = [card('crit', [{ type: 'critRate', value: 0.5 }], { maxStack: 10 })];
    // 6 层 = 300%，必须夹到 1，否则期望伤害会荒谬地膨胀
    const s = statsWith(cards, [['crit', 6]]);
    assert.equal(s.critRate, 1);
  });

  test('暴击率不会被负数拉成负值', () => {
    const cards = [card('neg', [{ type: 'critRate', value: -1 }])];
    assert.equal(statsWith(cards, [['neg', 1]]).critRate, 0);
  });

  test('减伤下限保护：至少承受 10% 伤害，避免出现无敌 Build', () => {
    const cards = [card('dr', [{ type: 'dmgReduce', value: 0.5 }], { maxStack: 10 })];
    // 4 层 = 200% 减伤，必须被夹到「至少承受 10%」
    const s = statsWith(cards, [['dr', 4]]);
    assert.equal(s.damageTakenMul, MIN_DAMAGE_TAKEN);
  });

  test('减伤在未触底时按 1 - reduce 线性计算', () => {
    const cards = [card('dr', [{ type: 'dmgReduce', value: 0.2 }])];
    const s = statsWith(cards, [['dr', 2]]); // 40%
    assert.ok(Math.abs(s.damageTakenMul - 0.6) < 1e-9);
  });
});

describe('computeStats 暴击期望', () => {
  test('暴击期望 = 1 + 暴击率 × 暴伤', () => {
    const cards = [
      card('crit', [
        { type: 'critRate', value: 0.25 },
        { type: 'critDmg', value: 1.0 },
      ]),
    ];
    // 1 层：1 + 0.25 × 1.0 = 1.25 → DPS 12.5
    const s = statsWith(cards, [['crit', 1]]);
    assert.ok(Math.abs(s.dps - 12.5) < 1e-9);
  });

  test('双暴卡的第二层边际收益高于第一层（越晚拿越强）', () => {
    const c = card('crit', [
      { type: 'critRate', value: 0.15 },
      { type: 'critDmg', value: 0.5 },
    ]);
    const index = buildCardIndex([c]);
    const zero = createOwned();
    const one = withCard(zero, 'crit');

    const first = scoreBuild(one, index, BASE, 0) - scoreBuild(zero, index, BASE, 0);
    const second = scoreBuild(withCard(one, 'crit'), index, BASE, 0) - scoreBuild(one, index, BASE, 0);
    assert.ok(second > first, `第二层边际 ${second} 应大于第一层 ${first}`);
  });
});

describe('computeStats 生存乘区', () => {
  test('生命百分比同时提升上限与生存乘区', () => {
    const cards = [card('hp', [{ type: 'hpPct', value: 0.5 }])];
    const s = statsWith(cards, [['hp', 1]]);
    assert.equal(s.maxHp, 150);
    assert.ok(Math.abs(s.survivalMul - 1.5) < 1e-9);
  });

  test('击杀回血折算进生存乘区，且回血量与生命上限挂钩', () => {
    const cards = [card('heal', [{ type: 'healOnKill', value: 0.05 }])];
    const s = statsWith(cards, [['heal', 2]]); // 10% 击杀回血
    assert.ok(Math.abs(s.healPerKill - 10) < 1e-9, `实际 ${s.healPerKill}`);
    // 生存乘区 = 1 × (1 + 0 + 3 × 0.1) = 1.3
    assert.ok(Math.abs(s.survivalMul - (1 + HEAL_ON_KILL_FACTOR * 0.1)) < 1e-9);
  });
});

describe('持有表操作', () => {
  test('withCard 返回新表，不修改原表（不可变语义）', () => {
    const owned = createOwned();
    const next = withCard(owned, 'a');
    assert.equal(owned.size, 0, '原表被修改了');
    assert.equal(next.get('a'), 1);
  });

  test('withCard 对同一张卡累加层数', () => {
    let owned = createOwned();
    owned = withCard(owned, 'a');
    owned = withCard(owned, 'a');
    assert.equal(owned.get('a'), 2);
  });

  test('totalStacks 统计所有卡的总层数', () => {
    let owned = createOwned();
    owned = withCard(owned, 'a');
    owned = withCard(owned, 'a');
    owned = withCard(owned, 'b');
    assert.equal(totalStacks(owned), 3);
  });

  test('cloneOwned 产生独立的副本', () => {
    const owned = withCard(createOwned(), 'a');
    const copy = cloneOwned(owned);
    copy.set('b', 9);
    assert.equal(owned.has('b'), false);
  });

  test('持有表中出现未知卡 id 时被安全忽略（存档兼容性保护）', () => {
    const index = buildCardIndex([]);
    const owned = createOwned();
    owned.set('已经不存在的卡', 3);
    const s = computeStats(owned, index, BASE);
    assert.equal(s.dps, 10);
  });
});

describe('评分与边际收益', () => {
  test('survivalWeight=0 时评分退化为纯 DPS', () => {
    const s = statsWith([], []);
    assert.equal(scoreFromStats(s, 0), s.dps);
  });

  test('survivalWeight 越高，生存属性带来的分值越高', () => {
    const cards = [card('hp', [{ type: 'hpPct', value: 1.0 }])];
    const index = buildCardIndex(cards);
    const owned = withCard(createOwned(), 'hp');
    const dpsOnly = scoreBuild(owned, index, BASE, 0);
    const survivalFan = scoreBuild(owned, index, BASE, 0.6);
    assert.ok(survivalFan > dpsOnly);
  });

  test('纯生存卡在只看输出的模型里，边际收益为 0（这是模型的已知局限，不是 bug）', () => {
    const cards = [card('hp', [{ type: 'hpPct', value: 0.5 }])];
    const index = buildCardIndex(cards);
    const gain = marginalGain(createOwned(), cards[0], index, BASE, 0);
    assert.equal(gain, 0);
  });

  test('isSurvivalCard 能识别三属性混合卡', () => {
    assert.equal(isSurvivalCard(card('x', [{ type: 'dmgReduce', value: 0.1 }])), true);
    assert.equal(isSurvivalCard(card('y', [{ type: 'healOnKill', value: 0.1 }])), true);
    assert.equal(isSurvivalCard(card('z', [{ type: 'atkPct', value: 0.1 }])), false);
    // 双属性：只要含一个生存属性就算生存卡
    assert.equal(
      isSurvivalCard(
        card('w', [
          { type: 'atkPct', value: 0.1 },
          { type: 'hpPct', value: 0.1 },
        ]),
      ),
      true,
    );
  });
});
