/**
 * 可复现伪随机数（mulberry32 算法）
 *
 * 为什么全工程禁止直接使用 Math.random：
 *   1. 数值平衡必须可复现——同一个种子必须跑出同一份模拟报告。
 *      否则「我把数值调好了」这句话无法被验证，也无法回滚到上一版对比。
 *   2. Bug 复现需要固定种子。玩家反馈「第 7 波卡住不动」，我们能原样重跑那一局。
 *   3. 单元测试需要确定性。Math.random 会让测试随机失败，那种失败最消耗信任。
 *
 * 选 mulberry32 而不是更复杂的 xorshift 系列：32 位状态、无需初始化预热、
 * 周期 2^32 对本游戏的调用量（一局约 10^4 次）绰绰有余，且实现只有几行、可被完整审查。
 */

/**
 * 创建一个带种子的小型随机数发生器
 * @param {number} seed 任意整数种子；相同种子 → 相同序列
 */
export function createRng(seed = 1) {
  // 用 |0 保证状态始终是有符号 32 位整数，避免浮点累积误差导致序列漂移
  let state = (seed | 0) || 1;

  /** 返回 [0, 1) 的浮点数 */
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** 原始 [0,1) 采样 */
    next,

    /** 区间浮点数 [min, max) */
    float: (min, max) => min + next() * (max - min),

    /**
     * 区间整数 [min, max]，两端都含
     * 注意与 float 的语义差异：这里 max 是可取到的，方便写 rng.int(1, 6) 表示骰子
     */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),

    /** 以概率 p 返回 true（p <= 0 恒 false，p >= 1 恒 true） */
    chance: (p) => (p <= 0 ? false : p >= 1 ? true : next() < p),

    /** 从数组中等概率取一个元素 */
    pick: (arr) => arr[Math.floor(next() * arr.length)],

    /**
     * 洗牌（返回新数组，不修改入参——纯函数便于测试与回放）
     * 使用 Fisher-Yates，保证每种排列等概率
     */
    shuffle: (arr) => {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },

    /**
     * 按权重取一个下标，权重必须为非负数
     * 用途：三选一里 tier1 与 tier2 的稀有度差异
     */
    weightedIndex: (weights) => {
      let total = 0;
      for (const w of weights) total += Math.max(0, w);
      if (total <= 0) return 0;
      let roll = next() * total;
      for (let i = 0; i < weights.length; i++) {
        roll -= Math.max(0, weights[i]);
        if (roll < 0) return i;
      }
      return weights.length - 1;
    },

    /** 暴露当前状态，便于存档时保存随机流位置 */
    getState: () => state,
    /** 从存档恢复随机流位置 */
    setState: (s) => {
      state = s | 0;
    },
  };
}

/**
 * 生成一个「看起来随机、实际来自种子」的种子值
 * 仅在需要为每局生成独立种子时使用；模拟与测试一律显式传固定种子。
 */
export function seedFromTime(now = Date.now()) {
  return now % 2147483647;
}
