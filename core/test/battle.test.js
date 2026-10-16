/**
 * 单局战斗状态机测试
 *
 * 这是整个工程里最贵的一组测试：它把「一局游戏从头跑到尾」当作一个断言单元。
 * 好处是任何一处数值或流程被改坏（波次不推进、卡池给出满层的卡、
 * 经济算重、死亡后还在跑），都会在这里被抓住，而不需要打开浏览器试玩。
 *
 * 为了跑得快，驱动帧率用 1/30 秒（引擎实际是 1/60），
 * 这不影响任何断言——所有断言针对的是流程与数值，不是帧率。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, createBattle } from '../src/battle.js';
import { buildCardIndex, createOwned, marginalGain, withCard } from '../src/stats.js';
import { spiritFromClear, spiritFromKill, spiritFromWave } from '../src/economy.js';
import { REST_OPTION, isRestOption } from '../src/deck.js';
import CARDS_DATA from '../src/data.generated.js';

const DATA = CARDS_DATA;
const INDEX = buildCardIndex(DATA.cards);
const DT = 1 / 30;
/** 一局最长 396 秒游戏时间；按 30 帧/秒折算再留一倍余量 */
const MAX_FRAMES = 30000;

/** 把 getState 里的持有表转回 Map，供边际收益计算使用 */
function ownedFromState(state) {
  const owned = createOwned();
  for (const [id, n] of state.owned) owned.set(id, n);
  return owned;
}

/**
 * 从三个选项里挑边际收益最高的
 * @param {any} battle
 * @param {any[]} choices
 * @param {number} survivalWeight 0 = 只看输出，越大越重视保命
 */
function bestChoice(battle, choices, survivalWeight) {
  const owned = ownedFromState(battle.getState());
  let best = null;
  let bestGain = -Infinity;
  for (const c of choices) {
    if (isRestOption(c)) continue; // 兜底项不计分，只在没有真卡可选时才会被用到
    const gain = marginalGain(owned, c, INDEX, battle.base, survivalWeight);
    if (gain > bestGain) {
      bestGain = gain;
      best = c;
    }
  }
  return best ?? choices[0];
}

/**
 * 一局的击杀收益（解析式口径）
 *
 * 必须用 result.killUnits 而不是 result.kills：
 * kills 是屏幕上打死的敌人个数（一波 24 个小怪），killUnits 才折算回
 * 模型口径的单位数。用错的话算出来的期望值会比实际高好几倍。
 */
function expectedKillSpirit(result) {
  const bossKills = result.bossKills ?? 0;
  const normalUnits = Math.max(0, (result.killUnits ?? result.kills) - bossKills);
  return normalUnits * spiritFromKill(false, DATA) + bossKills * spiritFromKill(true, DATA);
}

/**
 * 自动跑完一局
 * @param {{ seed?: number, god?: boolean, survivalWeight?: number, skipUpgrades?: boolean }} opts
 */
function autoRun(opts = {}) {
  const { seed = 1, god = true, survivalWeight = 0.35, skipUpgrades = false } = opts;
  const battle = createBattle({ data: DATA, seed });
  battle.debugSetGodMode(god);

  let frames = 0;
  let upgrades = 0;
  while (frames < MAX_FRAMES) {
    const st = battle.getState();
    if (st.phase === PHASE.CLEARED || st.phase === PHASE.DEAD) break;

    if (st.phase === PHASE.UPGRADE) {
      if (skipUpgrades) battle.debugSkipUpgrade();
      else battle.choose(bestChoice(battle, battle.getChoices(), survivalWeight).id);
      upgrades++;
    } else {
      battle.step(DT, { dx: 0, dy: 0 });
      frames++;
    }
  }
  return { battle, frames, upgrades, state: battle.getState(), result: battle.result() };
}

describe('开局流程', () => {
  test('创建后停在开局三选一（不是直接开打）', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    const st = b.getState();
    assert.equal(st.phase, PHASE.UPGRADE);
    assert.equal(st.wave, 1);
    assert.equal(st.runTime, 0);
  });

  test('开局给出 3 个互不相同的选项', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    const choices = b.getChoices();
    assert.equal(choices.length, 3);
    assert.equal(new Set(choices.map((c) => c.id)).size, 3);
  });

  test('选了卡之后进入战斗', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    const id = b.getChoices()[0].id;
    assert.equal(b.choose(id), true);
    assert.equal(b.getState().phase, PHASE.FIGHTING);
    assert.equal(b.getState().owned[0][0], id);
  });

  test('选卡后选项被清空，不能重复领取', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    const id = b.getChoices()[0].id;
    b.choose(id);
    assert.equal(b.getChoices(), null);
    assert.equal(b.choose(id), false, '战斗阶段仍然可以领卡');
  });

  test('选择不存在的卡会失败且不改变状态', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    assert.equal(b.choose('这张卡不存在'), false);
    assert.equal(b.getState().phase, PHASE.UPGRADE);
    assert.deepEqual(b.getState().owned, []);
  });

  test('开局时场上没有敌人，时间不流逝', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    assert.equal(b.getState().enemies.length, 0);
    b.step(1, { dx: 1, dy: 0 });
    assert.equal(b.getState().runTime, 0, '升级阶段不应推进时间');
  });
});

describe('波次推进', () => {
  test('进入战斗后敌人会被投放到场上', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    b.choose(b.getChoices()[0].id);
    for (let i = 0; i < 30; i++) b.step(DT, null);
    assert.ok(b.getState().enemies.length > 0, '进入战斗 1 秒后场上仍然没有敌人');
  });

  test('清空一波后重新进入三选一，且波次 +1', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    b.debugSetGodMode(true);
    b.choose(b.getChoices()[0].id);
    let guard = 0;
    while (b.getState().phase === PHASE.FIGHTING && guard < MAX_FRAMES) {
      b.step(DT, null);
      guard++;
    }
    const st = b.getState();
    assert.equal(st.phase, PHASE.UPGRADE);
    assert.equal(st.wave, 2);
    assert.equal(b.getChoices().length, 3);
  });

  test('单帧推进有上限保护：一次巨大 dt 不会瞬间推进整个波次', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    b.choose(b.getChoices()[0].id);
    b.step(5, null); // 模拟从后台切回来产生的 5 秒 dt
    assert.ok(b.getState().waveTime <= 0.05 + 1e-9, `单帧推进了 ${b.getState().waveTime} 秒`);
  });

  test('超时未清空会触发反击并进入下一波（不会卡死）', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    b.debugSetGodMode(false);
    b.choose(b.getChoices()[0].id);
    // 把一整波的时间走完
    const limit = DATA.base.waveDuration / DT + 5;
    for (let i = 0; i < limit && b.getState().phase === PHASE.FIGHTING; i++) b.step(DT, null);
    const st = b.getState();
    assert.notEqual(st.phase, PHASE.FIGHTING, '波次超时后流程卡在战斗阶段');
    if (st.phase === PHASE.UPGRADE) {
      assert.equal(st.wave, 2);
    }
  });
});

describe('完整一局：能打通', () => {
  const run = autoRun({ seed: 20261013, god: true });

  test(`无敌模式下能打通全部 ${CARDS_DATA.base.waves} 波`, () => {
    assert.equal(run.result.phase, PHASE.CLEARED, `最终停在阶段 ${run.result.phase}，波次 ${run.result.reachedWave}`);
    assert.equal(run.result.reachedWave, DATA.base.waves);
    assert.equal(run.result.cleared, true);
  });

  // 选择次数 = 波数：开局先三选一，之后每清完一波再三选一。
  // 这里刻意不写死数字（曾经写死 12），而是从数值表读——
  // 波数是会随难度调参变的，写死会让「调整波数」变成一件要改测试的事。
  test('一局的选择次数与数值表的 upgradeStepsPerRun 一致', () => {
    assert.equal(run.upgrades, DATA.base.upgradeStepsPerRun, `实际做了 ${run.upgrades} 次选择`);
    assert.equal(
      DATA.base.upgradeStepsPerRun,
      DATA.base.waves,
      '选择步数应当等于波数，否则最后几波拿不到强化卡',
    );
  });

  test('通关用时落在 6-10 分钟区间内', () => {
    const minutes = run.result.runTime / 60;
    assert.ok(minutes >= 6 && minutes <= 10, `用时 ${minutes.toFixed(2)} 分钟`);
  });

  test('结算数据完整且类型正确', () => {
    const r = run.result;
    assert.equal(typeof r.kills, 'number');
    assert.equal(typeof r.spirit, 'number');
    assert.equal(typeof r.runTime, 'number');
    assert.ok(r.kills > 0, '一局下来一个敌人都没杀');
    assert.ok(Array.isArray(r.picks) && r.picks.length === DATA.base.upgradeStepsPerRun);
    assert.equal(r.waveLogs.length, DATA.base.waves);
    assert.equal(r.maxHp, run.state.maxHp);
  });

  test('每一波都有结算记录，且波次编号连续', () => {
    run.result.waveLogs.forEach((log, i) => {
      assert.equal(log.wave, i + 1, `第 ${i + 1} 条记录的波次编号是 ${log.wave}`);
    });
  });

  test('击杀统计与各波击杀之和一致', () => {
    const sum = run.result.waveLogs.reduce((n, l) => n + l.kills, 0);
    assert.equal(sum, run.result.kills, `各波击杀之和 ${sum} 与总击杀 ${run.result.kills} 不符`);
  });

  test('玩家做出了多种选择，而不是重复拿同一张卡', () => {
    const schools = new Set(run.result.picks.map((p) => p.school));
    const ids = new Set(run.result.picks.map((p) => p.id));
    assert.ok(ids.size >= 4, `${run.result.picks.length} 次选择只用了 ${ids.size} 种卡，Build 多样性不足`);
    assert.ok(schools.size >= 2, `只涉及 ${schools.size} 个流派`);
  });
});

describe('完整一局：不强化必然失败', () => {
  const run = autoRun({ seed: 20250401, god: false, skipUpgrades: true });

  test('一张卡都不拿时会在最终 Boss 之前阵亡', () => {
    assert.equal(run.result.phase, PHASE.DEAD, `没拿卡竟然走到了 ${run.result.phase}`);
    assert.ok(
      run.result.reachedWave < DATA.base.waves,
      `没拿卡竟然撑到第 ${run.result.reachedWave} 波`,
    );
  });

  test('这证明强化选择是必要的（对照局的意义）', () => {
    assert.equal(run.result.cleared, false);
    assert.ok(run.result.waveLogs.length >= 1);
  });

  test('阵亡时血量归零、场上清空', () => {
    assert.equal(run.result.hp, 0);
    assert.equal(run.state.enemies.length, 0);
  });

  test('阵亡后继续 step 不会抛出异常，也不会复活', () => {
    const before = run.result.reachedWave;
    for (let i = 0; i < 100; i++) run.battle.step(DT, { dx: 1, dy: 0 });
    assert.equal(run.battle.getState().phase, PHASE.DEAD);
    assert.equal(run.battle.result().reachedWave, before);
  });

  test('阵亡局不会拿到通关奖励', () => {
    const expectedWaves = run.result.waveLogs.filter((l) => l.inTime).reduce((n, l) => n + spiritFromWave(l.wave, DATA), 0);
    const expectedKills = expectedKillSpirit(run.result);
    // 阵亡局没有通关奖励，所以产出必然低于「一发通关奖金」
    assert.ok(run.result.spirit < spiritFromClear(DATA) + expectedWaves + expectedKills);
    assert.ok(Math.abs(run.result.spirit - (expectedWaves + expectedKills)) <= 1);
  });
});

describe('经济守恒（端到端）', () => {
  const run = autoRun({ seed: 777, god: true });

  test('结算灵石 = 击杀收益 + 按时清空的波次奖励 + 通关奖励', () => {
    const r = run.result;
    const killSpirit = expectedKillSpirit(r);
    const waveSpirit = r.waveLogs
      .filter((l) => l.inTime)
      .reduce((n, l) => n + spiritFromWave(l.wave, DATA), 0);
    const clearSpirit = r.cleared ? spiritFromClear(DATA) : 0;
    // 允许 1 点误差：击杀奖励按解析式单位折算后是小数，
    // 钱包会把不足 1 点的零头攒在 carry 里，可能恰好在结算时差一点点。
    assert.ok(
      Math.abs(r.spirit - (killSpirit + waveSpirit + clearSpirit)) <= 1,
      `实际 ${r.spirit} ≠ 期望 ${(killSpirit + waveSpirit + clearSpirit).toFixed(2)}`,
    );
  });

  test('灵石产出与「屏幕上打死多少个小怪」无关（swarmPerWave 是表现参数）', () => {
    // 同一局，只把每波的表现单位数从 24 换成 6 或 48，玩家赚到的灵石必须基本不变。
    // 这是本项目的一条工程约定：表现层参数不得渗进平衡结论。
    //
    // 背景：这条不变量曾经被破坏得很彻底。击杀奖励原本按「屏幕上的敌人个数」发，
    // 一波 24 个小怪就比模型口径的 6 个单位多赚 4 倍——实测通关产出从设计目标
    // 350 冲到 636，而当时所有单测都是绿的，因为它们只验证「实际 = 理论」，
    // 两边用的是同一个错误口径。
    //
    // 容差 10% 而不是严格相等：单位数变少时，场上同时存在的目标会变少，
    // 连锁/多目标卡有时打不满目标数，清空率会掉一两个波次。
    // 这是实时战斗的固有细节，不是经济泄漏——4 倍的泄漏仍然会被这个容差抓死。
    const baseline = autoRun({ seed: 777, god: true }).result.spirit;
    for (const swarmPerWave of [6, 12, 48]) {
      const patched = {
        ...DATA,
        spawn: { ...DATA.spawn, swarmPerWave },
      };
      const battle = createBattle({ data: patched, seed: 777 });
      battle.debugSetGodMode(true);
      let frames = 0;
      while (frames < MAX_FRAMES) {
        const st = battle.getState();
        if (st.phase === PHASE.CLEARED || st.phase === PHASE.DEAD) break;
        if (st.phase === PHASE.UPGRADE) battle.choose(bestChoice(battle, battle.getChoices(), 0.35).id);
        else {
          battle.step(DT, { dx: 0, dy: 0 });
          frames++;
        }
      }
      const got = battle.result().spirit;
      assert.ok(
        Math.abs(got - baseline) <= baseline * 0.1,
        `swarmPerWave=${swarmPerWave} 时产出 ${got}，与基准 ${baseline} 偏差超过 10%——表现参数漏进了经济`,
      );
    }
  });

  test('超时的波次不予奖励（避免鼓励故意不打）', () => {
    const timedOut = run.result.waveLogs.filter((l) => !l.inTime);
    for (const log of timedOut) {
      assert.ok(log.note && log.note.includes('超时'), `第 ${log.wave} 波超时但没有备注`);
    }
  });

  test('灵石余额始终为非负整数，且等于结算值', () => {
    assert.ok(Number.isInteger(run.result.spirit) && run.result.spirit >= 0);
    assert.equal(run.battle.wallet.amount, run.result.spirit);
  });
});

describe('可复现性', () => {
  test('同一种子跑两次，结果完全一致', () => {
    const a = autoRun({ seed: 31415, god: true }).result;
    const b = autoRun({ seed: 31415, god: true }).result;
    assert.deepEqual(
      {
        wave: a.reachedWave,
        kills: a.kills,
        spirit: a.spirit,
        hp: a.hp,
        picks: a.picks,
      },
      {
        wave: b.reachedWave,
        kills: b.kills,
        spirit: b.spirit,
        hp: b.hp,
        picks: b.picks,
      },
    );
  });

  test('不同种子会产生不同的过程（不是伪随机退化）', () => {
    const a = autoRun({ seed: 100, god: true }).result;
    const b = autoRun({ seed: 200, god: true }).result;
    assert.notDeepEqual(a.picks.map((p) => p.id), b.picks.map((p) => p.id));
  });
});

describe('Debug 接口（试玩面板与测试共用）', () => {
  test('debugGrantCard 直接发卡并刷新属性', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    const before = b.getState().stats.dps;
    assert.equal(b.debugGrantCard('lei_atk'), true); // +22% 攻击
    const after = b.getState().stats.dps;
    assert.ok(after > before, `发卡后 DPS 没有提高：${before} → ${after}`);
  });

  test('debugGrantCard 对不存在的卡返回 false', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    assert.equal(b.debugGrantCard('无此卡'), false);
  });

  test('生命上限提高时血量按比例换算，不会因上限变化而变相掉血', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    b.debugHeal();
    const ratioBefore = b.getState().hp / b.getState().maxHp;
    b.debugGrantCard('ti_hp'); // +28% 生命
    const st = b.getState();
    const ratioAfter = st.hp / st.maxHp;
    assert.ok(
      Math.abs(ratioAfter - ratioBefore) < 1e-9,
      `血量比例从 ${ratioBefore} 变成了 ${ratioAfter}`,
    );
  });

  test('debugHeal 把血量补满', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    b.choose(b.getChoices()[0].id);
    for (let i = 0; i < 300; i++) b.step(DT, null);
    b.debugHeal();
    const st = b.getState();
    assert.equal(st.hp, st.maxHp);
  });

  test('debugJumpToWave 能直接跳到指定波次并停在升级界面', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    b.debugSetGodMode(true);
    const arrived = b.debugJumpToWave(DATA.enemy.bossWave);
    assert.equal(arrived, true);
    const st = b.getState();
    assert.equal(st.wave, DATA.enemy.bossWave);
    assert.equal(st.isBossWave, true);
  });

  test('跳到 Boss 波后场上只有 1 个敌人，且体型更大', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    b.debugSetGodMode(true);
    b.debugJumpToWave(DATA.enemy.bossWave);
    b.choose(b.getChoices()[0].id);
    for (let i = 0; i < 60; i++) b.step(DT, null);
    const st = b.getState();
    assert.equal(st.enemies.length, 1, `Boss 波场上有 ${st.enemies.length} 个敌人`);
    assert.equal(st.enemies[0].isBoss, true);
    assert.ok(st.enemies[0].r > DATA.enemyMotion.radius, 'Boss 的碰撞半径没有比普通单位大');
  });

  test('关闭无敌后 debugEndWave 会正常结算超时反击', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    b.choose(b.getChoices()[0].id);
    const hpBefore = b.getState().hp;
    b.debugEndWave(false);
    const st = b.getState();
    assert.ok(st.hp <= hpBefore, '超时结算后血量反而增加了');
    assert.equal(st.wave, 2);
  });

  test('debugSkipUpgrade 关闭选择但不发卡', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    assert.equal(b.debugSkipUpgrade(), true);
    assert.equal(b.getState().phase, PHASE.FIGHTING);
    assert.deepEqual(b.getState().owned, []);
    assert.equal(b.debugSkipUpgrade(), false, '战斗阶段不应能跳过升级');
  });
});

describe('兜底选项的行为', () => {
  test('小憩会回血且不进入持有表', () => {
    const b = createBattle({ data: DATA, seed: 1 });
    b.choose(b.getChoices()[0].id);
    // 打一会儿掉点血
    for (let i = 0; i < 600 && b.getState().phase === PHASE.FIGHTING; i++) b.step(DT, null);
    const hpLow = b.getState().hp;
    if (b.getState().phase === PHASE.UPGRADE) {
      // 手动构造一次兜底选择：把选项替换成小憩
      const ownedBefore = b.getState().owned.length;
      b.choose(REST_OPTION.id);
      const st = b.getState();
      assert.equal(st.owned.length, ownedBefore, '兜底选项污染了持有表');
      if (hpLow < st.maxHp) assert.ok(st.hp >= hpLow, '小憩没有回血');
    }
  });

  test('兜底项不会出现在卡牌索引里（不可能被抽到）', () => {
    assert.equal(INDEX.has(REST_OPTION.id), false);
  });

  test('withCard 对兜底项无效的语义由上层保证：id 不在索引里时属性不变', () => {
    const owned = withCard(createOwned(), REST_OPTION.id);
    const index = buildCardIndex(DATA.cards);
    assert.equal(marginalGain(owned, REST_OPTION, index, DATA.base, 0.3), 0);
  });
});
