/**
 * 存档序列化测试
 *
 * 存档是唯一「错了就无法挽回」的模块：玩家手机上的数据只有一份。
 * 因此这里的核心断言是——**任何输入都不允许抛出异常，也不允许返回半个存档**。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVE_KEY,
  SAVE_VERSION,
  cloneSave,
  defaultSave,
  describe as describeSave,
  deserialize,
  migrate,
  serialize,
} from '../src/save.js';

describe('默认存档', () => {
  test('带版本号与三类字段', () => {
    const s = defaultSave();
    assert.equal(s.version, SAVE_VERSION);
    assert.ok(s.meta && s.settings);
    assert.equal(typeof s.lastSeed, 'number');
  });

  test('每次调用返回独立对象（不会共享引用）', () => {
    const a = defaultSave();
    const b = defaultSave();
    a.meta.spirit = 999;
    assert.equal(b.meta.spirit, 0);
  });

  test('存档 key 是稳定的字符串常量', () => {
    assert.equal(typeof SAVE_KEY, 'string');
    assert.ok(SAVE_KEY.length > 0);
  });
});

describe('往返一致性', () => {
  test('序列化后再反序列化，内容完全相同', () => {
    const original = defaultSave();
    original.meta.realm = 3;
    original.meta.spirit = 420;
    original.meta.stats.runs = 17;
    original.meta.stats.clears = 5;
    original.meta.stats.bestWave = 12;
    original.meta.stats.bestRunSeconds = 372.5;
    original.settings.speed = 2;

    const { save, recovered } = deserialize(serialize(original));
    assert.equal(recovered, false);
    assert.deepEqual(save, original);
  });

  test('cloneSave 产生独立副本', () => {
    const s = defaultSave();
    const c = cloneSave(s);
    c.meta.spirit = 1;
    assert.equal(s.meta.spirit, 0);
  });
});

describe('容错：永不抛异常', () => {
  test('空输入返回默认存档，且不算作「恢复」', () => {
    for (const input of [null, undefined, '']) {
      const { save, recovered } = deserialize(input);
      assert.equal(recovered, false);
      assert.deepEqual(save, defaultSave());
    }
  });

  test('损坏的 JSON 退化为默认存档，并标记为已恢复', () => {
    for (const bad of ['{', 'not json', '{"meta":', '[1,2,3', '\u0000\u0001']) {
      const { save, recovered } = deserialize(bad);
      assert.equal(recovered, true, `输入 ${JSON.stringify(bad)} 未被标记为已恢复`);
      assert.deepEqual(save, defaultSave());
    }
  });

  test('JSON 合法但不是对象时退化为默认存档', () => {
    for (const weird of ['null', '123', '"字符串"', '[]', 'true']) {
      const { save } = deserialize(weird);
      assert.equal(save.version, SAVE_VERSION);
      assert.ok(save.meta && save.settings);
    }
  });

  test('字段类型错误时逐项退化，而不是整份丢弃', () => {
    const broken = {
      version: SAVE_VERSION,
      meta: { realm: '不是数字', spirit: null, stats: { runs: -5, clears: NaN } },
      settings: { sound: 'yes', speed: 0, damageNumbers: 1 },
      lastSeed: 'abc',
    };
    const { save } = deserialize(JSON.stringify(broken));
    assert.equal(save.meta.realm, 0, '非法 realm 未退化');
    assert.equal(save.meta.spirit, 0);
    assert.equal(save.meta.stats.runs, 0, '负数局数未被夹到 0');
    assert.equal(save.meta.stats.clears, 0, 'NaN 未退化');
    assert.equal(save.settings.sound, true, '非布尔的开关未退化');
    assert.equal(save.settings.speed, 1, '速度 0 应退化为 1');
    assert.equal(save.settings.damageNumbers, true);
  });

  test('合法字段在部分损坏时被保留（不因一处错误丢掉全部进度）', () => {
    const partial = {
      version: SAVE_VERSION,
      meta: { realm: 4, spirit: '坏值', stats: { runs: 9 } },
      settings: {},
    };
    const { save } = deserialize(JSON.stringify(partial));
    assert.equal(save.meta.realm, 4, '合法字段被误丢');
    assert.equal(save.meta.stats.runs, 9);
    assert.equal(save.meta.spirit, 0);
  });

  test('无限大 / 负数等异常数值不会进入存档', () => {
    const weird = {
      version: SAVE_VERSION,
      meta: { realm: Infinity, spirit: -1e9, stats: { runs: Infinity } },
      settings: {},
    };
    const { save } = deserialize(JSON.stringify(weird));
    assert.ok(Number.isFinite(save.meta.realm));
    assert.ok(save.meta.spirit >= 0);
    assert.ok(Number.isFinite(save.meta.stats.runs));
  });
});

describe('版本迁移', () => {
  test('无版本号的旧存档（v0）被规整为当前版本', () => {
    const legacy = { meta: { realm: 2, spirit: 300 }, settings: { sound: false } };
    const save = migrate(legacy);
    assert.equal(save.version, SAVE_VERSION);
    assert.equal(save.meta.realm, 2);
    assert.equal(save.meta.spirit, 300);
    assert.equal(save.settings.sound, false);
  });

  test('当前版本的存档原样通过', () => {
    const s = defaultSave();
    s.meta.realm = 5;
    assert.deepEqual(migrate(s), s);
  });

  test('来自更高版本的存档保留可识别字段（降级安装不丢进度）', () => {
    const future = {
      version: SAVE_VERSION + 5,
      meta: { realm: 6, spirit: 800, stats: { runs: 30 } },
      settings: {},
      未来的新字段: { 看不懂: true },
    };
    const save = migrate(future);
    assert.equal(save.meta.realm, 6);
    assert.equal(save.meta.spirit, 800);
    assert.equal(save.meta.stats.runs, 30);
    assert.equal(save.version, SAVE_VERSION);
  });

  test('非对象输入返回默认存档', () => {
    for (const v of [null, undefined, 0, 'x', []]) {
      assert.deepEqual(migrate(v), defaultSave());
    }
  });
});

describe('describe 摘要', () => {
  test('输出包含关键进度信息', () => {
    const s = defaultSave();
    s.meta.realm = 2;
    s.meta.spirit = 150;
    s.meta.stats.runs = 6;
    s.meta.stats.clears = 2;
    s.meta.stats.bestWave = 12;
    const text = describeSave(s);
    assert.ok(text.includes('2'));
    assert.ok(text.includes('150'));
    assert.ok(text.includes('6'));
    assert.ok(text.includes('12'));
  });
});
