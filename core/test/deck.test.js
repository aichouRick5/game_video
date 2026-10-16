/**
 * 卡池与三选一测试
 *
 * 这一层的 bug 表现是「玩家看到了不该看到的选项」或「永远是同三个流派」，
 * 都属于在真机上才会被发现、但在这里能被 3 毫秒抓住的问题。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCHOOL_BIAS,
  REST_OPTION,
  cardCandidates,
  cardWeight,
  findChoice,
  isRestOption,
  offerChoices,
  schoolInvest,
} from '../src/deck.js';
import { buildCardIndex, createOwned, withCard } from '../src/stats.js';
import { createRng } from '../src/rng.js';
import CARDS_DATA from '../src/data.generated.js';

const CARDS = CARDS_DATA.cards;
const INDEX = buildCardIndex(CARDS);

/** 快捷构造持有表 */
function owned(pairs = []) {
  let o = createOwned();
  for (const [id, n] of pairs) for (let i = 0; i < n; i++) o = withCard(o, id);
  return o;
}

/** 出一次三选一 */
function offer(o, seed = 1, extra = {}) {
  return offerChoices({ owned: o, cards: CARDS, cardIndex: INDEX, rng: createRng(seed), ...extra });
}

describe('候选池', () => {
  test('开局时全部 20 张卡都是候选', () => {
    assert.equal(cardCandidates(createOwned(), CARDS).length, CARDS.length);
  });

  test('拿满的卡退出候选池', () => {
    const c = CARDS.find((x) => x.maxStack === 1); // 顿悟
    const pool = cardCandidates(owned([[c.id, c.maxStack]]), CARDS);
    assert.ok(!pool.some((x) => x.id === c.id), '已满层的卡仍在候选池里');
    assert.equal(pool.length, CARDS.length - 1);
  });

  test('schoolInvest 正确统计各流派层数', () => {
    const sword = CARDS.filter((c) => c.school === '御剑').slice(0, 2);
    const invest = schoolInvest(owned([[sword[0].id, 3], [sword[1].id, 1]]), INDEX);
    assert.equal(invest.get('御剑'), 4);
  });
});

describe('出牌正确性', () => {
  test('始终返回 3 个选项', () => {
    assert.equal(offer(createOwned()).length, 3);
  });

  test('同一轮内不出现重复卡', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const choices = offer(owned([['jian_spd', 2]]), seed);
      const ids = choices.filter((c) => !isRestOption(c)).map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length, `种子 ${seed} 出现了重复选项：${ids}`);
    }
  });

  test('已满层的卡永不出现在选项里', () => {
    const dunwu = CARDS.find((c) => c.id === 'xin_insight'); // maxStack = 1
    const o = owned([['xin_insight', dunwu.maxStack]]);
    for (let seed = 1; seed <= 300; seed++) {
      const choices = offer(o, seed);
      assert.ok(
        !choices.some((c) => c.id === 'xin_insight'),
        `种子 ${seed} 让已满层的顿悟再次出现`,
      );
    }
  });

  test('全部卡拿满时，三个格子都退化为兜底选项（UI 不塌陷）', () => {
    const maxed = owned(CARDS.map((c) => [c.id, c.maxStack]));
    const choices = offer(maxed, 5);
    assert.equal(choices.length, 3);
    assert.ok(choices.every(isRestOption));
  });

  test('兜底选项不会被误认为真卡', () => {
    assert.equal(isRestOption(REST_OPTION), true);
    assert.equal(isRestOption(CARDS[0]), false);
    assert.equal(isRestOption(null), false);
    // 兜底项不进入卡牌索引，因此不可能被 findChoice 从真卡池里找到
    assert.equal(INDEX.has(REST_OPTION.id), false);
  });

  test('findChoice 按 id 命中，未命中返回 null', () => {
    const choices = offer(createOwned(), 3);
    assert.equal(findChoice(choices, choices[1].id), choices[1]);
    assert.equal(findChoice(choices, '不存在的卡'), null);
  });

  test('候选不足 3 张时用兜底项补满', () => {
    // 只留 1 张未满层的卡
    const only = CARDS[0];
    const o = owned(CARDS.filter((c) => c.id !== only.id).map((c) => [c.id, c.maxStack]));
    const choices = offer(o, 11);
    assert.equal(choices.length, 3);
    assert.equal(choices.filter((c) => !isRestOption(c)).length, 1);
    assert.equal(choices.filter(isRestOption).length, 2);
  });
});

describe('权重与流派抱团', () => {
  test('tier1 卡的权重高于 tier2（稀有度生效）', () => {
    const t1 = CARDS.find((c) => c.tier === 1);
    const t2 = CARDS.find((c) => c.tier === 2);
    const invest = new Map();
    assert.ok(cardWeight(t1, invest, 0) > cardWeight(t2, invest, 0));
  });

  test('开局（无任何投入）时流派不偏袒：五流派出现频次接近', () => {
    const counts = new Map(CARDS_DATA.schools.map((s) => [s, 0]));
    for (let seed = 1; seed <= 600; seed++) {
      for (const c of offer(createOwned(), seed)) {
        if (isRestOption(c)) continue;
        counts.set(c.school, counts.get(c.school) + 1);
      }
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const share = [...counts.values()].map((v) => v / total);
    // 每流派理论占比 20%，允许 4 个百分点波动
    for (const s of share) {
      assert.ok(Math.abs(s - 0.2) < 0.04, `流派占比 ${(s * 100).toFixed(1)}% 偏离 20% 过多`);
    }
  });

  test('深度投入某一流派后，该流派每次都能出现在选项里（抱团保证）', () => {
    // 堆 6 层御剑，占全部投入
    const o = owned([['jian_spd', 3], ['jian_atk', 3]]);
    for (let seed = 1; seed <= 300; seed++) {
      const choices = offer(o, seed);
      const hasSword = choices.some((c) => !isRestOption(c) && c.school === '御剑');
      assert.ok(hasSword, `种子 ${seed} 的三选一里没有御剑卡，玩家想走御剑却无卡可选`);
    }
  });

  test('抱团系数越高，主修流派在选项中的占比越高', () => {
    // 注意：抱团「保证」（至少出现一张主修卡）是独立于权重的机制，任何时候都生效；
    // 这里验证的是权重维度——系数越大，主修卡被抽中的**比例**越高。
    const o = owned([['jian_spd', 3], ['jian_atk', 3]]);
    const shareOf = (bias) => {
      let sword = 0;
      let all = 0;
      for (let seed = 1; seed <= 400; seed++) {
        for (const c of offer(o, seed, { bias })) {
          if (isRestOption(c)) continue;
          all++;
          if (c.school === '御剑') sword++;
        }
      }
      return sword / all;
    };
    const low = shareOf(0);
    const high = shareOf(2);
    assert.ok(high > low, `高抱团占比 ${high} 应大于低抱团占比 ${low}`);
  });

  test('默认抱团系数是一个合理的正数', () => {
    assert.ok(DEFAULT_SCHOOL_BIAS > 0 && DEFAULT_SCHOOL_BIAS <= 2);
  });

  test('出牌是确定性的：同种子同状态 → 同结果', () => {
    const o = owned([['lei_atk', 2]]);
    assert.deepEqual(
      offer(o, 4242).map((c) => c.id),
      offer(o, 4242).map((c) => c.id),
    );
  });
});
