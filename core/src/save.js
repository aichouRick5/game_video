/**
 * 存档序列化（纯函数）
 *
 * 边界（重要）：本文件**不接触任何存储 API**——没有 localStorage，没有 wx.setStorageSync，
 * 没有任何平台调用。它只负责「状态 <-> 纯字符串」的转换。
 * 真正的落盘由平台适配层负责（浏览器版在 prototype/src/storage.js，Cocos 版用 sys.localStorage）。
 * 这样 core 才能保持零依赖，才能在 Node 里直接跑单测。
 *
 * 为什么要版本号与迁移：
 *   小游戏上线后，玩家手机上一定存在旧版本存档。上线当天最贵的 bug 就是
 *   「更新后所有老玩家存档读不出来」。所以从第 1 版开始就带 version，
 *   并且**反序列化永远不能抛异常**——损坏的存档必须退化成默认值，而不是白屏。
 */

import { createMetaState } from './meta.js';

/** 当前存档格式版本。改动字段语义时必须 +1 并在 migrate 里补一条迁移 */
export const SAVE_VERSION = 1;

/** 存档 key（浏览器与 Cocos 共用同一个 key 名，便于跨端调试） */
export const SAVE_KEY = 'xiuxian.video_code.save';

/**
 * 默认存档
 * 设置项与局外成长放在一起，是因为它们都是「跨局持久」的数据，生命周期一致
 */
export function defaultSave() {
  return {
    version: SAVE_VERSION,
    meta: createMetaState(),
    settings: {
      /** 音效开关（原型阶段先留字段，正式版接入音频系统） */
      sound: true,
      /** 战斗速度倍率，仅 Debug 面板可改 */
      speed: 1,
      /** 是否显示伤害数字 */
      damageNumbers: true,
    },
    /** 上一次使用的随机种子，便于「重开同一局」复现问题 */
    lastSeed: 20261013,
  };
}

/** 深拷贝（存档对象是纯数据，JSON 往返最简单可靠） */
function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 序列化为字符串
 * @param {ReturnType<typeof defaultSave>} save
 */
export function serialize(save) {
  return JSON.stringify(save);
}

/**
 * 把任意输入规整成合法存档。任何非法字段都退化成默认值，绝不抛异常
 * @param {any} raw
 * @returns {ReturnType<typeof defaultSave>}
 */
function coerce(raw) {
  const base = defaultSave();
  if (!raw || typeof raw !== 'object') return base;

  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const stats = meta.stats && typeof meta.stats === 'object' ? meta.stats : {};
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};

  /** 只接受有限非负数，其余一律回退默认值 */
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);

  return {
    version: SAVE_VERSION,
    meta: {
      realm: Math.floor(num(meta.realm, base.meta.realm)),
      spirit: Math.floor(num(meta.spirit, base.meta.spirit)),
      stats: {
        runs: Math.floor(num(stats.runs, 0)),
        clears: Math.floor(num(stats.clears, 0)),
        bestWave: Math.floor(num(stats.bestWave, 0)),
        bestRunSeconds: num(stats.bestRunSeconds, 0),
        totalKills: Math.floor(num(stats.totalKills, 0)),
        totalSpirit: Math.floor(num(stats.totalSpirit, 0)),
      },
    },
    settings: {
      sound: typeof settings.sound === 'boolean' ? settings.sound : base.settings.sound,
      speed: num(settings.speed, base.settings.speed) || 1,
      damageNumbers:
        typeof settings.damageNumbers === 'boolean'
          ? settings.damageNumbers
          : base.settings.damageNumbers,
    },
    lastSeed: Math.floor(num(raw.lastSeed, base.lastSeed)) || base.lastSeed,
  };
}

/**
 * 存档迁移。当前只有 v1，所以没有任何迁移分支；
 * 这个函数存在的意义是**给未来留好插入点**，并让「未知版本」有明确行为。
 *
 * 迁移规则：只向前迁移。读到比当前版本还新的存档（降级安装）时，
 * 我们选择保留能识别的字段、丢弃不认识的——好过直接清空玩家进度。
 *
 * @param {any} raw
 */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return defaultSave();
  const version = typeof raw.version === 'number' ? raw.version : 0;

  // 无版本号：视作最初的手写格式，直接走规整逻辑
  if (version === 0) return coerce(raw);
  if (version === SAVE_VERSION) return coerce(raw);

  // 未来在这里按版本号逐级升级，例如：
  // if (version < 2) { raw.newField = computeFromOld(raw); raw.version = 2; }
  return coerce(raw);
}

/**
 * 反序列化。永不抛异常——这是存档系统的硬约束
 * @param {string|null|undefined} text
 * @returns {{ save: ReturnType<typeof defaultSave>, recovered: boolean }}
 *          recovered=true 表示输入损坏或为空，返回的是默认存档
 */
export function deserialize(text) {
  if (text === null || text === undefined || text === '') {
    return { save: defaultSave(), recovered: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 存档被截断或写坏：退回默认，并让调用方知道发生了恢复
    return { save: defaultSave(), recovered: true };
  }
  return { save: migrate(parsed), recovered: false };
}

/**
 * 导出一份可读的存档副本（调试面板用）
 * @param {ReturnType<typeof defaultSave>} save
 */
export function describe(save) {
  const s = save.meta.stats;
  return `境界 ${save.meta.realm} · 灵石 ${save.meta.spirit} · 局数 ${s.runs} · 通关 ${s.clears} · 最远波次 ${s.bestWave}`;
}

/** 测试与调试用：把存档拷一份，避免共享引用 */
export function cloneSave(save) {
  return deepClone(save);
}
