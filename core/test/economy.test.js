/**
 * 灵石经济测试
 *
 * 经济系统的 bug 通常表现为「玩家能刷出无限资源」或「余额变成负数」，
 * 两者都会毁掉局外成长的可信度，所以这里把守恒与下限都钉死。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canAfford,
  createWallet,
  earn,
  expectedEarnings,
  spiritFromClear,
  spiritFromKill,
  spiritFromWave,
  spend,
} from '../src/economy.js';
import CARDS_DATA from '../src/data.generated.js';

const DATA = CARDS_DATA;

describe('产出公式', () => {
  test('普通单位与 Boss 的灵石单价不同', () => {
    assert.equal(spiritFromKill(false, DATA), DATA.economy.spiritPerNormalKill);
    assert.equal(spiritFromKill(true, DATA), DATA.economy.spiritPerBossKill);
    assert.ok(spiritFromKill(true, DATA) > spiritFromKill(false, DATA));
  });

  test('波次奖励随波次递增（鼓励打得更远）', () => {
    for (let w = 2; w <= DATA.base.waves; w++) {
      assert.ok(spiritFromWave(w, DATA) > spiritFromWave(w - 1, DATA));
    }
  });

  test('通关奖励显著高于单波收益，是主要的灵石来源', () => {
    const lastWave = spiritFromWave(DATA.base.waves, DATA);
    assert.ok(spiritFromClear(DATA) > lastWave * 5);
  });
});

describe('钱包操作', () => {
  test('初始余额被规整为非负整数', () => {
    assert.equal(createWallet().amount, 0);
    assert.equal(createWallet(-50).amount, 0);
    assert.equal(createWallet(10.9).amount, 10);
  });

  test('入账累加，非法金额被忽略', () => {
    const w = createWallet(0);
    earn(w, 10);
    earn(w, 5);
    assert.equal(w.amount, 15);
    earn(w, -100);
    earn(w, NaN);
    earn(w, Infinity);
    assert.equal(w.amount, 15, '非法入账被接受了');
  });

  test('扣款成功后余额减少', () => {
    const w = createWallet(100);
    assert.equal(spend(w, 30), true);
    assert.equal(w.amount, 70);
  });

  test('余额不足时扣款失败且余额不变（绝不出现负余额）', () => {
    const w = createWallet(20);
    assert.equal(spend(w, 50), false);
    assert.equal(w.amount, 20);
    assert.equal(canAfford(w, 50), false);
    assert.equal(canAfford(w, 20), true);
  });

  test('刚好够也能扣成 0', () => {
    const w = createWallet(20);
    assert.equal(spend(w, 20), true);
    assert.equal(w.amount, 0);
  });

  test('不允许扣除负数（那等于凭空加钱）', () => {
    const w = createWallet(20);
    assert.equal(spend(w, -100), false);
    assert.equal(w.amount, 20);
  });
});

describe('经济守恒', () => {
  test('expectedEarnings 不把 Boss 同时按普通价与 Boss 价重复计价', () => {
    const summary = { kills: 10, bossKills: 1, wavesCleared: 0, cleared: false };
    const expected =
      9 * spiritFromKill(false, DATA) + 1 * spiritFromKill(true, DATA);
    assert.equal(expectedEarnings(summary, DATA), expected);
  });

  test('波次奖励按 1..N 逐个累加', () => {
    const summary = { kills: 0, bossKills: 0, wavesCleared: 3, cleared: false };
    assert.equal(
      expectedEarnings(summary, DATA),
      spiritFromWave(1, DATA) + spiritFromWave(2, DATA) + spiritFromWave(3, DATA),
    );
  });

  test('通关会额外加上通关奖励', () => {
    const without = expectedEarnings({ kills: 0, bossKills: 0, wavesCleared: 0, cleared: false }, DATA);
    const withClear = expectedEarnings({ kills: 0, bossKills: 0, wavesCleared: 0, cleared: true }, DATA);
    assert.equal(withClear - without, spiritFromClear(DATA));
  });

  test('通关一局的产出落在 300-400 灵石的设计区间内', () => {
    // 通关 = 打完 12 波（含一波 Boss，Boss 波有 1 个 Boss 单位）
    const waves = DATA.base.waves;
    let kills = 0;
    for (let w = 1; w <= waves; w++) {
      if (w === DATA.enemy.bossWave) kills += 1;
      else kills += DATA.enemy.perWave;
    }
    const total = expectedEarnings(
      { kills, bossKills: 1, wavesCleared: waves, cleared: true },
      DATA,
    );
    assert.ok(
      total >= 250 && total <= 500,
      `通关产出 ${total} 灵石，偏离 300-400 的设计目标过多（影响首次突破的节奏）`,
    );
  });

  test('首通产出足以支撑第一次境界突破（即时正反馈）', () => {
    const firstCost = Math.round(DATA.meta.realmCostBase);
    const waves = DATA.base.waves;
    let kills = 0;
    for (let w = 1; w <= waves; w++) {
      kills += w === DATA.enemy.bossWave ? 1 : DATA.enemy.perWave;
    }
    const total = expectedEarnings({ kills, bossKills: 1, wavesCleared: waves, cleared: true }, DATA);
    assert.ok(total >= firstCost, `首通 ${total} 灵石买不起首次突破（${firstCost}）`);
  });
});
