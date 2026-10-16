/**
 * 局外成长（境界）测试
 *
 * 局外成长是留存的核心抓手，也是「玩家能不能感到自己在变强」的唯一凭证。
 * 这里重点验证：成本递增曲线、加成幅度温和、以及结算统计不会被早死局污染。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  breakthrough,
  breakthroughCost,
  canBreakthrough,
  clearRate,
  createMetaState,
  isMaxRealm,
  metaBonus,
  realmName,
  settleRun,
} from '../src/meta.js';
import CARDS_DATA from '../src/data.generated.js';

const DATA = CARDS_DATA;

/** 造一个指定境界与灵石的局外状态 */
function mkMeta(realm = 0, spirit = 0) {
  return { ...createMetaState(), realm, spirit };
}

describe('境界基础', () => {
  test('初始状态为炼气（第 0 阶），无灵石无记录', () => {
    const m = createMetaState();
    assert.equal(m.realm, 0);
    assert.equal(m.spirit, 0);
    assert.equal(m.stats.runs, 0);
    assert.equal(m.stats.clears, 0);
  });

  test('境界名按表返回', () => {
    assert.equal(realmName(0, DATA), DATA.meta.realmNames[0]);
    assert.equal(realmName(1, DATA), DATA.meta.realmNames[1]);
  });

  test('超出表长时用兜底名而不是崩溃或 undefined', () => {
    const name = realmName(99, DATA);
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 0);
  });

  test('满境界判定与最高境界一致', () => {
    const max = DATA.meta.realmNames.length - 1;
    assert.equal(isMaxRealm(mkMeta(max), DATA), true);
    assert.equal(isMaxRealm(mkMeta(max - 1), DATA), false);
  });
});

describe('突破成本', () => {
  test('成本随境界递增', () => {
    for (let r = 1; r < DATA.meta.realmNames.length - 1; r++) {
      assert.ok(breakthroughCost(mkMeta(r), DATA) > breakthroughCost(mkMeta(r - 1), DATA));
    }
  });

  test('成本按配置的增长倍率递增', () => {
    const c0 = breakthroughCost(mkMeta(0), DATA);
    const c1 = breakthroughCost(mkMeta(1), DATA);
    assert.ok(Math.abs(c1 - Math.round(c0 * DATA.meta.realmCostGrowth)) <= 1);
  });

  test('满境界时成本为无穷大（无法继续突破）', () => {
    assert.equal(breakthroughCost(mkMeta(DATA.meta.realmNames.length - 1), DATA), Infinity);
  });

  test('灵石不足时不能突破', () => {
    const poor = mkMeta(0, breakthroughCost(mkMeta(0), DATA) - 1);
    assert.equal(canBreakthrough(poor, DATA), false);
    const result = breakthrough(poor, DATA);
    assert.equal(result.ok, false);
    assert.equal(result.state, poor, '失败的突破不应产生新状态');
  });

  test('灵石充足时突破成功：扣钱、进境', () => {
    const cost = breakthroughCost(mkMeta(0), DATA);
    const rich = mkMeta(0, cost + 50);
    const { state, ok } = breakthrough(rich, DATA);
    assert.equal(ok, true);
    assert.equal(state.realm, 1);
    assert.equal(state.spirit, 50);
  });

  test('突破不修改传入的状态（纯函数）', () => {
    const cost = breakthroughCost(mkMeta(0), DATA);
    const before = mkMeta(0, cost);
    const snapshot = JSON.parse(JSON.stringify(before));
    breakthrough(before, DATA);
    assert.deepEqual(before, snapshot);
  });
});

describe('境界加成', () => {
  test('炼气期无加成', () => {
    const b = metaBonus(mkMeta(0), DATA);
    assert.equal(b.atkMul, 1);
    assert.equal(b.hpMul, 1);
  });

  test('加成随境界线性累加', () => {
    const b = metaBonus(mkMeta(3), DATA);
    assert.ok(Math.abs(b.atkMul - (1 + 3 * DATA.meta.realmAtkBonus)) < 1e-9);
    assert.ok(Math.abs(b.hpMul - (1 + 3 * DATA.meta.realmHpBonus)) < 1e-9);
  });

  test('加成幅度克制：满境界也不应超过 2 倍（否则局内决策会被局外数值淹没）', () => {
    const max = DATA.meta.realmNames.length - 1;
    const b = metaBonus(mkMeta(max), DATA);
    assert.ok(b.atkMul < 2, `满境界攻击加成 ${b.atkMul} 倍过高`);
    assert.ok(b.hpMul < 2, `满境界生命加成 ${b.hpMul} 倍过高`);
  });
});

describe('结算', () => {
  const run = (over = {}) => ({
    cleared: false,
    reachedWave: 5,
    kills: 42,
    runTime: 180,
    spirit: 100,
    ...over,
  });

  test('灵石入账、局数递增', () => {
    const m = settleRun(createMetaState(), run(), DATA);
    assert.equal(m.spirit, 100);
    assert.equal(m.stats.runs, 1);
    assert.equal(m.stats.totalSpirit, 100);
  });

  test('未通关不计入通关数，但记录最远波次', () => {
    const m = settleRun(createMetaState(), run({ cleared: false, reachedWave: 7 }), DATA);
    assert.equal(m.stats.clears, 0);
    assert.equal(m.stats.bestWave, 7);
  });

  test('最远波次只增不减', () => {
    let m = settleRun(createMetaState(), run({ reachedWave: 9 }), DATA);
    m = settleRun(m, run({ reachedWave: 3 }), DATA);
    assert.equal(m.stats.bestWave, 9);
  });

  test('未通关不记录最快用时（否则早死会霸榜）', () => {
    const m = settleRun(createMetaState(), run({ cleared: false, runTime: 12 }), DATA);
    assert.equal(m.stats.bestRunSeconds, 0);
  });

  test('通关记录用时，并保留更快的成绩', () => {
    let m = settleRun(createMetaState(), run({ cleared: true, runTime: 400 }), DATA);
    assert.equal(m.stats.bestRunSeconds, 400);
    m = settleRun(m, run({ cleared: true, runTime: 350 }), DATA);
    assert.equal(m.stats.bestRunSeconds, 350);
    m = settleRun(m, run({ cleared: true, runTime: 500 }), DATA);
    assert.equal(m.stats.bestRunSeconds, 350, '较慢的通关覆盖了更快的记录');
  });

  test('通关数累加', () => {
    let m = settleRun(createMetaState(), run({ cleared: true }), DATA);
    m = settleRun(m, run({ cleared: true }), DATA);
    assert.equal(m.stats.clears, 2);
    assert.equal(m.stats.runs, 2);
  });

  test('击杀数累加', () => {
    let m = settleRun(createMetaState(), run({ kills: 30 }), DATA);
    m = settleRun(m, run({ kills: 12 }), DATA);
    assert.equal(m.stats.totalKills, 42);
  });

  test('负数灵石被夹到 0（防止异常数据污染局外进度）', () => {
    const m = settleRun(createMetaState(), run({ spirit: -500 }), DATA);
    assert.equal(m.spirit, 0);
  });

  test('不修改传入状态（纯函数）', () => {
    const before = createMetaState();
    const snapshot = JSON.parse(JSON.stringify(before));
    settleRun(before, run(), DATA);
    assert.deepEqual(before, snapshot);
  });

  test('通关率在零局数时返回 0，而不是 NaN', () => {
    const rate = clearRate(createMetaState());
    assert.equal(rate, 0);
    assert.ok(!Number.isNaN(rate));
  });

  test('通关率计算正确', () => {
    let m = createMetaState();
    m = settleRun(m, run({ cleared: true }), DATA);
    m = settleRun(m, run({ cleared: false }), DATA);
    assert.equal(clearRate(m), 0.5);
  });
});
