/**
 * 卡池与三选一（纯函数，无副作用）
 *
 * 设计目标（对应 GDD 里「每 30 秒做一次有意义的选择」这条支柱）：
 *   1. 每次给 3 个不重复的选项，其中至少 1 个属于玩家已投入的流派 → 让流派身份能被强化
 *   2. 但不 100% 抱团 → 保留中途转向的可能，否则 Roguelike 的重玩价值会被「开局定流派」吃掉
 *   3. 尊重 maxStack → 拿满的卡不再出现，避免选项被污染
 *   4. 候选不足 3 个时补「小憩」→ 保证 UI 永远是 3 个格子，不出现 2 选 1 的尴尬界面
 */

/**
 * 兜底选项：候选卡池不足 3 张时填充用
 * 它不是 cards.json 里的真卡，只作为一个「保底补血」按钮存在。
 * 之所以做成数据而不是 if 分支，是为了让原型、测试、以及未来的 Cocos 版共用同一套渲染逻辑。
 */
export const REST_OPTION = Object.freeze({
  id: '__xin_rest',
  name: '小憩',
  school: '心法',
  tier: 0,
  maxStack: 99,
  effects: [],
  tags: ['保底'],
  rationale: '候选卡池不足 3 张时的兜底选项：回复 15% 最大生命。它不进入持有表，因此不参与任何属性聚合。',
  healPct: 0.15,
});

/**
 * 该选项是否为兜底项
 * 必须返回严格的 boolean：调用方会在 assert 与条件分支里依赖它，
 * 返回 null / undefined 这类「假值但不是 false」会让类型判断失效。
 * @param {any} card
 * @returns {boolean}
 */
export function isRestOption(card) {
  return !!card && card.id === REST_OPTION.id;
}

/** tier 稀有度权重：数字越大越常见。tier2 是「本局值得期待的转折点」，不该每轮刷屏 */
const TIER_WEIGHT = { 0: 0, 1: 3, 2: 1.2 };

/** 流派抱团系数：0 = 完全无视已有流派，1 = 强烈倾向已有流派 */
export const DEFAULT_SCHOOL_BIAS = 0.9;

/**
 * 列出「还能再叠」的卡
 * @param {Map<string, number>} owned 持有表（卡牌 id -> 层数）
 * @param {import('./types.js').Card[]} cards
 * @returns {import('./types.js').Card[]}
 */
export function cardCandidates(owned, cards) {
  return cards.filter((card) => (owned.get(card.id) ?? 0) < card.maxStack);
}

/**
 * 统计各流派已投入层数
 * @param {Map<string, number>} owned
 * @param {Map<string, import('./types.js').Card>} cardIndex
 * @returns {Map<string, number>}
 */
export function schoolInvest(owned, cardIndex) {
  const invest = new Map();
  for (const [id, count] of owned) {
    const card = cardIndex.get(id);
    if (!card) continue;
    invest.set(card.school, (invest.get(card.school) ?? 0) + count);
  }
  return invest;
}

/**
 * 计算某张候选卡的抽取权重
 *
 * 权重 = tier 稀有度权重 × (1 + 抱团系数 × 该卡所属流派的投入占比)
 * 例：开局的第 1 次选择，投入占比为 0 → 五流派等概率，玩家自由定调
 *     第 6 次选择时若已堆了 3 层御剑（占 3/6 = 0.5）→ 御剑卡权重 ×1.45
 *
 * @param {import('./types.js').Card} card
 * @param {Map<string, number>} invest
 * @param {number} totalStacks
 * @param {number} bias
 */
export function cardWeight(card, invest, totalStacks, bias = DEFAULT_SCHOOL_BIAS) {
  const base = TIER_WEIGHT[card.tier] ?? 1;
  if (totalStacks <= 0) return base;
  const share = (invest.get(card.school) ?? 0) / totalStacks;
  return base * (1 + bias * share);
}

/**
 * 生成一次三选一的候选列表
 *
 * @param {Object} params
 * @param {Map<string, number>} params.owned
 * @param {import('./types.js').Card[]} params.cards
 * @param {Map<string, import('./types.js').Card>} params.cardIndex
 * @param {ReturnType<import('./rng.js').createRng>} params.rng
 * @param {number} [params.count=3] 选项数量
 * @param {number} [params.bias] 流派抱团系数
 * @returns {import('./types.js').Card[]}
 */
export function offerChoices({ owned, cards, cardIndex, rng, count = 3, bias = DEFAULT_SCHOOL_BIAS }) {
  const candidates = cardCandidates(owned, cards);
  const invest = schoolInvest(owned, cardIndex);
  const total = candidates.reduce((n, c) => n + (owned.get(c.id) ?? 0), 0);

  // 候选不足：直接补兜底项，不走权重逻辑
  if (candidates.length === 0) {
    return Array.from({ length: count }, () => REST_OPTION);
  }

  const pool = candidates.slice();
  const weights = pool.map((c) => cardWeight(c, invest, total, bias));
  const chosen = [];

  // 无放回抽样：每次取走后把权重重置为 0，保证同一轮不出现重复卡
  while (chosen.length < count && pool.some((_, i) => weights[i] > 0)) {
    const idx = rng.weightedIndex(weights);
    chosen.push(pool[idx]);
    weights[idx] = 0;
  }

  // 抱团保证：如果这一轮一张「主修流派」的卡都没有，就拿一张替换掉最后一张
  // 目的不是给玩家好处，而是让「我想练雷法」这件事在选项层面总是可行的
  const mainSchool = [...invest.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (mainSchool && chosen.length > 0) {
    const hasMain = chosen.some((c) => c.school === mainSchool);
    const mainPool = pool.filter(
      (c) => c.school === mainSchool && !chosen.some((x) => x.id === c.id),
    );
    if (!hasMain && mainPool.length > 0) {
      chosen[chosen.length - 1] = mainPool[rng.int(0, mainPool.length - 1)];
    }
  }

  // 候选不足 count 个时用兜底项填满，保证 UI 布局稳定
  while (chosen.length < count) chosen.push(REST_OPTION);

  return chosen;
}

/**
 * 用 id 在候选列表里查卡（结算玩家点击时用）
 * @param {import('./types.js').Card[]} choices
 * @param {string} id
 */
export function findChoice(choices, id) {
  return choices.find((c) => c.id === id) ?? null;
}
