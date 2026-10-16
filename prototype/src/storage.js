/**
 * 存储适配层（浏览器）
 *
 * 这是 core 与平台之间的唯一接缝：core/save.js 只负责「状态 <-> 字符串」，
 * 真正的落盘由本文件负责。换成微信小游戏时，只需要把这里换成 wx.setStorageSync，
 * core 与 UI 一行都不用改。
 *
 * localStorage 的坑（都已处理）：
 *   1. 隐私模式 / 禁用 Cookie 时访问会抛异常 → 全部 try/catch，退化为内存存储
 *   2. 容量约 5MB，写满会抛 QuotaExceededError → 捕获后提示而不是白屏
 *   3. iOS 的某些版本在页面隐藏时才flush → 每次写入都直接落盘，不攒批
 */

import { SAVE_KEY, defaultSave, deserialize, serialize } from '../../core/src/save.js';

/** 内存兜底存储：localStorage 不可用时使用，至少保证本次会话内进度不丢 */
const memory = new Map();

/** localStorage 是否可用（首次访问时探测一次） */
let usable = null;

function probe() {
  if (usable !== null) return usable;
  try {
    const k = '__probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    usable = true;
  } catch {
    usable = false;
    console.warn('[storage] localStorage 不可用，本次会话的进度只保存在内存中');
  }
  return usable;
}

/**
 * 读取存档
 * @returns {{ save: ReturnType<typeof defaultSave>, recovered: boolean }}
 */
export function load() {
  const raw = probe() ? safeGet(SAVE_KEY) : memory.get(SAVE_KEY) ?? null;
  return deserialize(raw);
}

function safeGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    console.warn('[storage] 读取失败', e);
    return null;
  }
}

/**
 * 写入存档
 * @param {ReturnType<typeof defaultSave>} save
 * @returns {boolean} 是否真正落盘（false 表示写进了内存兜底）
 */
export function save(state) {
  const text = serialize(state);
  memory.set(SAVE_KEY, text);
  if (!probe()) return false;
  try {
    window.localStorage.setItem(SAVE_KEY, text);
    return true;
  } catch (e) {
    // 容量超限或其它写入失败：不抛给上层，只记录。游戏必须能继续玩。
    console.warn('[storage] 写入失败（可能是容量超限）', e);
    return false;
  }
}

/** 清档（调试面板用） */
export function clear() {
  memory.delete(SAVE_KEY);
  if (!probe()) return;
  try {
    window.localStorage.removeItem(SAVE_KEY);
  } catch (e) {
    console.warn('[storage] 清档失败', e);
  }
}

/** 当前存档是否真的落到了磁盘上（调试面板展示用） */
export function isPersistent() {
  return probe();
}
