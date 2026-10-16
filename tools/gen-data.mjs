/**
 * 数据生成器：design/numbers/cards.json -> core/src/data.generated.js
 *
 * 为什么需要它：
 *   数值表必须能手改（JSON 最合适），但浏览器与 Cocos 都不能直接引用 JSON 模块。
 *   把它转成 ESM 模块后，Node / 浏览器 / Cocos 三端就能用同一条代码路径读同一份数值，
 *   既保证「数值只有一个来源」，又不需要引入任何构建工具。
 *
 * 运行：node tools/gen-data.mjs（或 npm run gen）
 * 副作用：覆盖 core/src/data.generated.js；校验失败时不写文件并以非零码退出
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFECT_TYPES } from '../core/src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'design', 'numbers', 'cards.json');
const OUT = join(ROOT, 'core', 'src', 'data.generated.js');

const raw = JSON.parse(readFileSync(SRC, 'utf-8'));

/** 数值表结构校验：坏数据绝不能流进引擎 */
const errors = [];
if (!raw.base) errors.push('缺少 base 段');
if (!raw.enemy) errors.push('缺少 enemy 段');
if (!Array.isArray(raw.cards) || raw.cards.length === 0) errors.push('缺少 cards 数组');

const seenIds = new Set();
for (const card of raw.cards ?? []) {
  if (!card.id) errors.push(`存在缺少 id 的卡牌：${JSON.stringify(card).slice(0, 60)}`);
  if (seenIds.has(card.id)) errors.push(`卡牌 id 重复：${card.id}`);
  seenIds.add(card.id);
  if (!card.name || !card.school) errors.push(`卡牌 ${card.id} 缺少 name 或 school`);
  if (!Number.isInteger(card.tier) || card.tier < 1) errors.push(`卡牌 ${card.id} 的 tier 必须是 >=1 的整数`);
  if (!Number.isInteger(card.maxStack) || card.maxStack < 1) errors.push(`卡牌 ${card.id} 的 maxStack 必须是 >=1 的整数`);
  if (!Array.isArray(card.effects) || card.effects.length === 0) errors.push(`卡牌 ${card.id} 没有 effects`);
  for (const effect of card.effects ?? []) {
    if (!EFFECT_TYPES.includes(effect.type)) errors.push(`卡牌 ${card.id} 使用了未知效果类型：${effect.type}`);
    if (typeof effect.value !== 'number' || !Number.isFinite(effect.value)) errors.push(`卡牌 ${card.id} 的 ${effect.type} 数值非法`);
  }
  if (!card.rationale || card.rationale.length < 10) errors.push(`卡牌 ${card.id} 缺少足够的设计依据（rationale）`);
}

const schools = new Set((raw.cards ?? []).map((c) => c.school));
if (schools.size < 2) errors.push('至少需要两个流派，否则流派平衡无从谈起');

/**
 * 战斗 / 经济 / 局外成长参数的校验
 * 这些数值直接决定手感与产出口径，缺一个字段就会在运行时得到 NaN，
 * 所以在这里一次性拦掉，而不是等到画面里出现「NaN 伤害」再回头找。
 */
const requiredSections = {
  arena: ['width', 'height', 'playerSpeed', 'playerRadius', 'attackRange'],
  combat: ['baseAttacksPerSecond'],
  enemyMotion: ['speed', 'bossSpeed', 'radius', 'bossRadius', 'separation'],
  spawn: [
    'swarmPerWave',
    'groups',
    'groupInterval',
    'ringMin',
    'ringMax',
    'bossRingMin',
    'bossRingMax',
    'wallInset',
  ],
  economy: [
    'spiritPerNormalKill',
    'spiritPerBossKill',
    'waveClearBonusBase',
    'waveClearBonusPerWave',
    'clearBonus',
  ],
  meta: ['realmNames', 'realmCostBase', 'realmCostGrowth', 'realmAtkBonus', 'realmHpBonus'],
};
// enemy 段的数值字段单独校验（它同时含 note 这类说明字段）
const enemyNumbers = [
  'perWave',
  'hpBase',
  'hpGrowth',
  'dpsBase',
  'dpsGrowth',
  'bossWave',
  'bossHpMul',
  'bossDpsMul',
  'waveClearHealPct',
  'upgradePauseSec',
  'approachOverheadSec',
];

for (const [section, fields] of Object.entries(requiredSections)) {
  const node = raw[section];
  if (!node) {
    errors.push(`缺少 ${section} 段`);
    continue;
  }
  for (const field of fields) {
    const value = node[field];
    if (value === undefined || value === null) {
      errors.push(`${section}.${field} 缺失`);
      continue;
    }
    // realmNames 是字符串数组，其余必须是有限数值
    if (Array.isArray(value)) {
      if (value.length === 0) errors.push(`${section}.${field} 不能是空数组`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${section}.${field} 必须是有限数值，实际为 ${JSON.stringify(value)}`);
    }
  }
}

// enemy 段的数值字段
for (const field of enemyNumbers) {
  const value = raw.enemy?.[field];
  if (value === undefined || value === null) {
    errors.push(`enemy.${field} 缺失`);
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`enemy.${field} 必须是有限数值，实际为 ${JSON.stringify(value)}`);
  }
}
if (raw.enemy && raw.base && raw.enemy.bossWave !== raw.base.waves) {
  errors.push(`enemy.bossWave(${raw.enemy.bossWave}) 应等于 base.waves(${raw.base.waves})：最后一波必须是 Boss`);
}

// 跨段一致性：怪物刷新数不能小于每波「逻辑单位数」，否则摊分后单个敌人血量无意义；
// 目标数封顶必须不超过刷新数，否则连锁卡的收益上限会永远吃不满
if (raw.spawn && raw.enemy && raw.spawn.swarmPerWave < raw.enemy.perWave) {
  errors.push(`spawn.swarmPerWave(${raw.spawn.swarmPerWave}) 不应小于 enemy.perWave(${raw.enemy.perWave})`);
}
if (raw.base && raw.spawn && raw.base.assumedWaveSize > raw.spawn.swarmPerWave) {
  errors.push(`base.assumedWaveSize 超过实际刷新数，连锁卡收益会被浪费`);
}

// 跨段一致性：所有批次必须在波次时长的前半段投放完毕。
// 这是被真实试玩打脸过的一条约束——原本 4 批 × 7.5 秒间隔让最后一批第 29 秒才到场，
// 而敌人走到玩家面前还要几秒，于是每一波都必然超时（真实战斗永远打不完）。
if (raw.spawn && raw.base && raw.combat && raw.enemyMotion) {
  const spawnSpan = (raw.spawn.groups - 1) * raw.spawn.groupInterval;
  const budget = raw.base.waveDuration * 0.4;
  if (spawnSpan > budget) {
    errors.push(
      `刷怪节奏不合理：投放跨度 ${spawnSpan.toFixed(1)}s 超过波次时长的 40%（${budget.toFixed(1)}s）——` +
        `最后一批敌人才刚上场这一波就快结束了`,
    );
  }
}

// 跨段一致性：刷新环必须在攻击范围之外。否则敌人一生成就被打死，
// 「走位」这个核心操作就消失了，玩家变成站桩
if (raw.spawn && raw.arena && raw.spawn.ringMin <= raw.arena.attackRange) {
  errors.push(
    `spawn.ringMin(${raw.spawn.ringMin}) 必须大于 arena.attackRange(${raw.arena.attackRange})，` +
      `否则敌人会在攻击范围内生成，玩家无需走位`,
  );
}

// 跨段一致性：单次出手伤害不应过小（否则伤害数字会是小数，且频率无意义地高），
// 也不应过大（否则溢出浪费重新出现，两份模型的清空耗时又会分裂）
if (raw.combat && raw.base && raw.spawn && raw.enemy) {
  const aps = raw.combat.baseAttacksPerSecond;
  const wave1UnitHp = (raw.enemy.hpBase * raw.enemy.perWave) / raw.spawn.swarmPerWave;
  const perHit = raw.base.atk / aps;
  const wasteRatio = perHit / 2 / wave1UnitHp;
  if (wasteRatio > 0.3) {
    errors.push(
      `溢出浪费过高：第 1 波单个敌人 ${wave1UnitHp.toFixed(2)} 血，单次出手 ${perHit.toFixed(2)} 点，` +
        `期望浪费约 ${(wasteRatio * 100).toFixed(0)}%——真实战斗会比解析式模型慢得多。` +
        `请提高 combat.baseAttacksPerSecond 或降低 spawn.swarmPerWave`,
    );
  }
}

// 跨段一致性：进场开销不能大到吃掉整波的输出时间
if (raw.enemy && raw.base && raw.enemy.approachOverheadSec > raw.base.waveDuration * 0.5) {
  errors.push(
    `enemy.approachOverheadSec(${raw.enemy.approachOverheadSec}) 超过波次时长的一半，` +
      `意味着玩家大部分时间在等敌人走过来`,
  );
}

if (errors.length > 0) {
  console.error('数值表校验失败：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

const banner = `/**
 * 本文件由 tools/gen-data.mjs 自动生成，请勿手工修改。
 * 源数据：design/numbers/cards.json（版本 ${raw.version}）
 * 修改数值的正确姿势：改 JSON 后执行 npm run gen
 */

`;

writeFileSync(OUT, banner + `export const CARDS_DATA = ${JSON.stringify(raw, null, 2)};\n\nexport default CARDS_DATA;\n`, 'utf-8');

console.log(`数值表校验通过：${raw.cards.length} 张卡 / ${schools.size} 个流派 / 版本 ${raw.version}`);
console.log(`已生成：${OUT}`);
