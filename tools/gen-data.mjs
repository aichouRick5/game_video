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
