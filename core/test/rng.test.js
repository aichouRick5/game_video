/**
 * 随机数模块测试
 *
 * 这一层的测试价值在于「可复现性」——如果 RNG 不可复现，
 * 上面所有的数值平衡结论、bug 复现能力都会失效，而且失效得很隐蔽。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, seedFromTime } from '../src/rng.js';

/** 取 n 个采样值，方便对比序列 */
function take(n, rng) {
  return Array.from({ length: n }, () => rng.next());
}

describe('createRng 可复现性', () => {
  test('同一种子产生完全相同的序列', () => {
    const a = take(50, createRng(12345));
    const b = take(50, createRng(12345));
    assert.deepEqual(a, b);
  });

  test('不同种子产生不同序列', () => {
    const a = take(50, createRng(1));
    const b = take(50, createRng(2));
    assert.notDeepEqual(a, b);
  });

  test('每个采样值都落在 [0, 1)', () => {
    const rng = createRng(777);
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      assert.ok(v >= 0 && v < 1, `采样值越界：${v}`);
    }
  });

  test('种子为 0 时不会退化（内部会替换为 1）', () => {
    const a = take(10, createRng(0));
    const b = take(10, createRng(0));
    assert.deepEqual(a, b);
    // 不能全是同一个值
    assert.ok(new Set(a).size > 1);
  });

  test('getState / setState 能恢复到序列中的同一位置', () => {
    const rng = createRng(999);
    take(17, rng);
    const snapshot = rng.getState();
    const expected = take(10, rng);
    rng.setState(snapshot);
    assert.deepEqual(take(10, rng), expected);
  });
});

describe('createRng 便利方法', () => {
  test('int 的两端都能取到', () => {
    const rng = createRng(4242);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(rng.int(1, 6));
    assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  });

  test('int 结果始终是整数且在范围内', () => {
    const rng = createRng(31337);
    for (let i = 0; i < 3000; i++) {
      const v = rng.int(-5, 5);
      assert.ok(Number.isInteger(v) && v >= -5 && v <= 5, `越界：${v}`);
    }
  });

  test('float 落在指定区间内', () => {
    const rng = createRng(555);
    for (let i = 0; i < 3000; i++) {
      const v = rng.float(10, 20);
      assert.ok(v >= 10 && v < 20, `越界：${v}`);
    }
  });

  test('chance(0) 恒为 false，chance(1) 恒为 true', () => {
    const rng = createRng(88);
    for (let i = 0; i < 500; i++) {
      assert.equal(rng.chance(0), false);
      assert.equal(rng.chance(1), true);
    }
  });

  test('chance(p) 的频次接近 p（±3%）', () => {
    const rng = createRng(2026);
    let hits = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) if (rng.chance(0.3)) hits++;
    const rate = hits / n;
    assert.ok(Math.abs(rate - 0.3) < 0.03, `实际频率 ${rate} 偏离 0.3 过多`);
  });

  test('shuffle 不修改入参，且元素集合不变', () => {
    const rng = createRng(12);
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const frozen = input.slice();
    const out = rng.shuffle(input);
    assert.deepEqual(input, frozen, 'shuffle 修改了入参');
    assert.deepEqual([...out].sort((a, b) => a - b), frozen);
  });

  test('shuffle 确实会打乱顺序', () => {
    const rng = createRng(64);
    const input = Array.from({ length: 40 }, (_, i) => i);
    const out = rng.shuffle(input);
    assert.notDeepEqual(out, input);
  });

  test('weightedIndex 尊重权重：权重为 0 的项永不出现', () => {
    const rng = createRng(7);
    const weights = [0, 5, 0];
    for (let i = 0; i < 1000; i++) {
      assert.equal(rng.weightedIndex(weights), 1);
    }
  });

  test('weightedIndex 的分布与权重成比例', () => {
    const rng = createRng(808);
    const weights = [1, 3];
    const counts = [0, 0];
    const n = 20000;
    for (let i = 0; i < n; i++) counts[rng.weightedIndex(weights)]++;
    const ratio = counts[1] / n;
    assert.ok(Math.abs(ratio - 0.75) < 0.03, `实际占比 ${ratio} 偏离 0.75 过多`);
  });

  test('全部权重为 0 时退化为第 0 项而不是崩溃', () => {
    const rng = createRng(1);
    assert.equal(rng.weightedIndex([0, 0, 0]), 0);
  });
});

describe('seedFromTime', () => {
  test('返回 32 位范围内的非负整数', () => {
    const s = seedFromTime(1700000000000);
    assert.ok(Number.isInteger(s) && s >= 0 && s < 2147483647);
  });
});
