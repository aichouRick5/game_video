/**
 * 解析式波次模型测试
 *
 * 这个模型是「万局模拟」的地基。它算错的时候不会崩溃，只会安静地
 * 给出「所有生存卡都是废卡」这种结论——v0.2 初版就踩过这个坑。
 * 因此这里用显式的期望值把它的行为钉死。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRun, waveStats } from '../src/balance.js';
import CARDS_DATA from '../src/data.generated.js';

const DATA = CARDS_DATA;

/** 构造一份战斗属性，只填 evaluateRun 真正会读的字段 */
function mkStats(over = {}) {
  return {
    dps: 10,
    maxHp: 100,
    damageTakenMul: 1,
    healPerKill: 0,
    survivalMul: 1,
    ...over,
  };
}

describe('waveStats 波次预算', () => {
  test('第 1 波：普通波，6 个单位，总血量 = 6 × hpBase', () => {
    const w = waveStats(1, DATA);
    assert.equal(w.isBoss, false);
    assert.equal(w.count, DATA.enemy.perWave);
    assert.equal(w.totalHp, DATA.enemy.hpBase * DATA.enemy.perWave);
  });

  test(`Boss 波（第 ${CARDS_DATA.enemy.bossWave} 波）只有 1 个单位，血量乘以 Boss 倍率`, () => {
    const w = waveStats(DATA.enemy.bossWave, DATA);
    assert.equal(w.isBoss, true);
    assert.equal(w.count, 1);
    const expected =
      DATA.enemy.hpBase * Math.pow(DATA.enemy.hpGrowth, DATA.enemy.bossWave - 1) * DATA.enemy.bossHpMul;
    assert.ok(Math.abs(w.totalHp - expected) < 1e-6);
  });

  test('总血量随波次指数增长（后期必须显著更难）', () => {
    const hp = (n) => waveStats(n, DATA).totalHp;
    for (let n = 2; n < DATA.enemy.bossWave; n++) {
      assert.ok(hp(n) > hp(n - 1), `第 ${n} 波不比第 ${n - 1} 波难`);
    }
  });

  test('requiredDps = 总血量 / 可用战斗时间（已扣除进场开销）', () => {
    const w = waveStats(3, DATA);
    assert.ok(
      Math.abs(w.requiredDps - w.totalHp / w.combatWindow) < 1e-9,
      'requiredDps 必须与 combatWindow 同口径，否则和 evaluateRun 会各算各的',
    );
    // 可用窗口一定短于波次总时长，因为它扣掉了敌人进场的那段空转
    assert.ok(w.combatWindow > 0 && w.combatWindow < DATA.base.waveDuration);
  });

  test('敌人 DPS 随波次增长', () => {
    assert.ok(waveStats(10, DATA).incomingDps > waveStats(1, DATA).incomingDps);
  });
});

describe('evaluateRun 通关闭环', () => {
  test('碾压级输出：通关，且打满全部波次', () => {
    const r = evaluateRun(mkStats({ dps: 100000 }), DATA);
    assert.equal(r.dead, false);
    assert.equal(r.clearedWave, DATA.base.waves);
  });

  test('极端弱输出：阵亡，且死在第一波之后', () => {
    const r = evaluateRun(mkStats({ dps: 0.001 }), DATA);
    assert.equal(r.dead, true);
    assert.ok(r.clearedWave < DATA.base.waves);
    assert.ok(r.clearedWave >= 0);
  });

  /**
   * 单局时长的结构性上界。
   *
   * 这组断言的存在本身是一个教训。早期版本把单局时长「算」成
   * `波数 ×（波次时长 + 强化暂停）`，也就是说：一个输出无限的玩家
   * 也要花 9.9 分钟才能通关——因为代码假设每一波都打满 30 秒。
   * 真实情况恰恰相反：输出越高，每波清得越快，一局越短。
   * 所以这里改成钉住「上界」与「实际累加」两件事。
   */
  test('通关用时不会超过「每波都打满」的理论上限', () => {
    const ceiling = DATA.base.waves * (DATA.base.waveDuration + DATA.enemy.upgradePauseSec);
    for (const dps of [1, 10, 100, 100000]) {
      const r = evaluateRun(mkStats({ dps, maxHp: 1e9 }), DATA);
      assert.ok(r.runSeconds <= ceiling + 1e-9, `dps=${dps} 用时 ${r.runSeconds}s 超过上限 ${ceiling}s`);
    }
  });

  test('输出越高，通关越快——用时是逐波真实累加的，不是「波数 × 固定值」', () => {
    const fast = evaluateRun(mkStats({ dps: 100000, maxHp: 1e9 }), DATA).runSeconds;
    const slow = evaluateRun(mkStats({ dps: 12, maxHp: 1e9 }), DATA).runSeconds;
    assert.ok(fast < slow, `碾压局 ${fast}s 竟然不比勉强局 ${slow}s 快`);
    // 碾压局只剩「敌人进场开销 + 强化选择」两块固定成本，清空耗时应趋近于 0
    // （不是严格为 0：每波仍要花掉「该波总血量 ÷ 输出」的一点点时间，这里放宽到 0.5 秒）
    const fixed = DATA.base.waves * (DATA.enemy.approachOverheadSec + DATA.enemy.upgradePauseSec);
    assert.ok(Math.abs(fast - fixed) < 0.5, `碾压局用时 ${fast}s，期望贴近固定成本 ${fixed}s`);
  });

  test('阵亡局的时长记录到死亡波次为止，不会算整局', () => {
    const ceiling = DATA.base.waves * (DATA.base.waveDuration + DATA.enemy.upgradePauseSec);
    const r = evaluateRun(mkStats({ dps: 0.001 }), DATA);
    assert.ok(r.runSeconds < ceiling);
  });
});

describe('evaluateRun 逐波成长（时间线）', () => {
  /**
   * 这一组是 v0.3.2 的核心回归测试。
   *
   * 事故经过：早期版本只接受「一套最终属性」，等于让玩家拿着 18 张卡去打第 1 波。
   * 后果是难度曲线被整体抹平——中位局第 1 波 DPS 149，每波 3-15 秒清完，
   * 单局只有 4-5 分钟，而设计目标是 6-10 分钟。
   * 更糟的是它安静地通过了几十项测试，因为它们全都只喂单个 stats 对象。
   */
  const weak = mkStats({ dps: 10, maxHp: 100 });
  const strong = mkStats({ dps: 200, maxHp: 100 });

  test('传入数组时，第 w 波使用第 w 个属性（而不是最后一个）', () => {
    // 时间线只有第 1 波是弱 Build：它必须比「全程都强」慢，比「全程都弱」快
    const allWeak = evaluateRun(weak, DATA).runSeconds;
    const allStrong = evaluateRun(strong, DATA).runSeconds;
    const onlyFirstWeak = evaluateRun([weak, ...Array(DATA.base.waves - 1).fill(strong)], DATA).runSeconds;

    assert.ok(allStrong < onlyFirstWeak, '第一波拖后腿之后应当比全程碾压慢');
    assert.ok(onlyFirstWeak < allWeak, '只慢第一波应当比全程都慢快');
  });

  test('数组比波数短时，多出来的波次沿用最后一个属性', () => {
    const short = evaluateRun([weak, strong], DATA);
    const long = evaluateRun([weak, ...Array(DATA.base.waves - 1).fill(strong)], DATA);
    assert.equal(short.runSeconds, long.runSeconds);
    assert.equal(short.dead, long.dead);
  });

  test('生命上限中途变化时，当前血量按比例跟随（不会白送一口血）', () => {
    // 第 1 波用 100 血，第 2 波起用 1000 血：若实现是「加最大生命就加当前生命」，
    // 后面的波次会白拿 900 点血量，承受伤害曲线会完全失真。
    const timeline = [mkStats({ dps: 12, maxHp: 100 }), ...Array(DATA.base.waves - 1).fill(mkStats({ dps: 12, maxHp: 1000 }))];
    const grown = evaluateRun(timeline, DATA);
    // 换算过来的血应当是「上限的同一个比例」，因此 1000 血版本的血量比例
    // 不会高于「一开始就是 1000 血」的那个局
    const bornBig = evaluateRun(mkStats({ dps: 12, maxHp: 1000 }), DATA);
    assert.ok(
      grown.hpRatio <= bornBig.hpRatio + 1e-9,
      `中途长血反而更耐打：${grown.hpRatio} > ${bornBig.hpRatio}`,
    );
  });

  test('超时的波次里，击杀回血只按实际打死的比例结算', () => {
    // 同样的输出，把敌人血量堆到打不完 —— 回血应当随之缩水。
    // 早期实现按整波敌人数结算回血，等于「超时」成了回血大户。
    const bigHeal = mkStats({ dps: 12, healPerKill: 3 });
    const normal = evaluateRun(bigHeal, DATA);
    const overwhelmed = evaluateRun(bigHeal, {
      ...DATA,
      enemy: { ...DATA.enemy, hpBase: DATA.enemy.hpBase * 50 },
    });
    // 被压倒的那一局，血量比例不该比正常局更高
    assert.ok(
      overwhelmed.hpRatio <= normal.hpRatio + 1e-9,
      `打不完的时候反而回得更多：${overwhelmed.hpRatio} > ${normal.hpRatio}`,
    );
  });
});

describe('evaluateRun 核心机制：输出越高，挨打越少', () => {
  // 说明：对比「承受伤害」时必须让双方都活满全场。
  // 否则死得早的一方只挨了几波的打，总伤害自然更小，会把结论带反。
  // 这里用极高的血量上限把死亡因素排除掉，只观察暴露时长机制本身。
  const SURVIVOR = { maxHp: 1e9 };

  test('承受伤害随输出单调递减（暴露时长机制）', () => {
    const damages = [15, 25, 40, 60, 90].map(
      (dps) => evaluateRun(mkStats({ dps, ...SURVIVOR }), DATA).totalDamage,
    );
    for (let i = 1; i < damages.length; i++) {
      assert.ok(
        damages[i] < damages[i - 1],
        `输出提高后承受伤害没有下降：${damages[i - 1]} → ${damages[i]}`,
      );
    }
  });

  test('输出达到「每波都能瞬间清空」后，承受伤害趋近于只剩 Boss 那一波', () => {
    const huge = evaluateRun(mkStats({ dps: 1e6, ...SURVIVOR }), DATA).totalDamage;
    const mid = evaluateRun(mkStats({ dps: 25, ...SURVIVOR }), DATA).totalDamage;
    assert.ok(huge < mid * 0.5, `极限输出承受伤害 ${huge} 未显著低于中等输出 ${mid}`);
  });

  test('减伤能线性降低承受伤害', () => {
    const full = evaluateRun(mkStats({ dps: 20, ...SURVIVOR }), DATA).totalDamage;
    const half = evaluateRun(mkStats({ dps: 20, damageTakenMul: 0.5, ...SURVIVOR }), DATA).totalDamage;
    assert.ok(Math.abs(half - full * 0.5) < 1e-6, `${half} 不等于 ${full * 0.5}`);
  });

  test('回血能延长存活：同样的输出下，带回血的局推进得更远', () => {
    const bare = evaluateRun(mkStats({ dps: 20 }), DATA);
    const healer = evaluateRun(mkStats({ dps: 20, healPerKill: 5, maxHp: 200 }), DATA);
    assert.ok(
      healer.clearedWave >= bare.clearedWave,
      `回血没有帮助：${bare.clearedWave} → ${healer.clearedWave}`,
    );
  });

  test('血量上限提高能延长存活', () => {
    const thin = evaluateRun(mkStats({ dps: 25, maxHp: 100 }), DATA);
    const thick = evaluateRun(mkStats({ dps: 25, maxHp: 400 }), DATA);
    assert.ok(thick.clearedWave >= thin.clearedWave);
  });

  test('每波记录条数与实际推进波次一致', () => {
    const r = evaluateRun(mkStats({ dps: 30 }), DATA);
    assert.ok(r.waveLogs.length > 0);
    assert.equal(r.waveLogs[0].wave, 1);
    // 最后一条记录就是阵亡 / 通关的那一波
    assert.equal(r.waveLogs[r.waveLogs.length - 1].wave, r.dead ? r.clearedWave + 1 : r.clearedWave);
  });

  test('血量永远不会是负数', () => {
    const r = evaluateRun(mkStats({ dps: 0.001 }), DATA);
    for (const log of r.waveLogs) assert.ok(log.hp >= 0, `第 ${log.wave} 波血量为负：${log.hp}`);
  });
});
