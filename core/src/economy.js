/**
 * 灵石经济（纯函数）
 *
 * 设计意图：灵石是**局外**货币，一局结束才结算，不参与局内 Build 决策。
 * 为什么局内不给可花的钱：局内每次选择必须只有「拿哪张卡」这一个维度，
 * 多一个消费维度会让 30 秒的决策窗口信息过载，也会让数值平衡的变量翻倍。
 *
 * 产出（sources）：
 *   1. 击杀敌人 → 基础灵石
 *   2. 每波结束 → 波次奖励（随波次线性递增，让「打得更远」永远更划算）
 *   3. 通关 Boss → 额外奖励
 * 消耗（sinks）：境界突破（见 meta.js）
 *
 * 所有数值来自 design/numbers/cards.json 的 economy 段，严禁在此硬编码。
 */

/**
 * 单次击杀的灵石产出
 * @param {boolean} isBoss
 * @param {{ economy: { spiritPerNormalKill: number, spiritPerBossKill: number } }} data
 */
export function spiritFromKill(isBoss, data) {
  const eco = data.economy;
  return isBoss ? eco.spiritPerBossKill : eco.spiritPerNormalKill;
}

/**
 * 第 wave 波清空后的灵石奖励
 * @param {number} wave
 * @param {{ economy: { waveClearBonusBase: number, waveClearBonusPerWave: number } }} data
 */
export function spiritFromWave(wave, data) {
  const eco = data.economy;
  return eco.waveClearBonusBase + eco.waveClearBonusPerWave * wave;
}

/**
 * 通关一次性奖励
 * @param {{ economy: { clearBonus: number } }} data
 */
export function spiritFromClear(data) {
  return data.economy.clearBonus;
}

/**
 * 创建一个钱包（可变对象，因为战斗中每帧都可能加钱）
 *
 * carry 是「不足 1 点的零头」。为什么需要它：
 *   击杀奖励按**解析式单位**计价，而不是屏幕上的敌人个数。表现层会把一波
 *   摊成 24 个小怪（spawn.swarmPerWave），于是单个小怪可能只值 0.25 灵石。
 *   如果每次入账都直接取整，四分之三的收入会被悄悄丢掉。
 *   把它攒在 carry 里、攒够 1 点再进余额，既保住收入，又保证 amount 永远是整数。
 * @param {number} [initial=0]
 */
export function createWallet(initial = 0) {
  return { amount: Math.max(0, Math.floor(initial)), carry: 0 };
}

/** 入账（允许小数），返回实际入账后的余额 */
export function earn(wallet, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return wallet.amount;
  const total = (wallet.carry ?? 0) + amount;
  const whole = Math.floor(total);
  wallet.carry = total - whole;
  wallet.amount += whole;
  return wallet.amount;
}

/**
 * 扣款。余额不足时不扣、不出现负数——经济不容许出现负债状态
 * @returns {boolean} 是否扣款成功
 */
export function spend(wallet, amount) {
  const cost = Math.floor(amount);
  if (cost < 0) return false;
  if (wallet.amount < cost) return false;
  wallet.amount -= cost;
  return true;
}

/** 是否买得起 */
export function canAfford(wallet, amount) {
  return wallet.amount >= Math.floor(amount);
}

/**
 * 校验一局的经济守恒：实际余额必须等于各来源之和
 * 只用于测试与开发期断言，正式流程不调用（避免把校验逻辑跑在热路径上）
 *
 * 注意 kills 是含 Boss 的总击杀数，必须先减掉 bossKills 再按普通单位计价，
 * 否则 Boss 会被「按普通价 + 按 Boss 价」重复计一次——这正是本函数要抓的错误类型。
 *
 * 另一个必须说清的坑：这里的 kills 指的是**解析式单位数**，不是屏幕上打死的敌人数。
 * 真实战斗里一波会被摊成 spawn.swarmPerWave 个小怪，直接拿屏幕上的击杀数来算，
 * 产出会被放大 swarmPerWave/perWave 倍（实测通关产出从 350 冲到 636，几乎翻倍）。
 * 调用方要么传解析式口径的击杀数，要么先把屏幕击杀数折算回解析式单位。
 *
 * @param {{ kills:number, bossKills:number, wavesCleared:number, cleared:boolean }} summary
 * @param {{ economy: any }} data
 */
export function expectedEarnings(summary, data) {
  const bossKills = summary.bossKills ?? 0;
  const normalKills = Math.max(0, summary.kills - bossKills);
  let total = 0;
  total += normalKills * spiritFromKill(false, data);
  total += bossKills * spiritFromKill(true, data);
  for (let w = 1; w <= summary.wavesCleared; w++) total += spiritFromWave(w, data);
  if (summary.cleared) total += spiritFromClear(data);
  return total;
}
