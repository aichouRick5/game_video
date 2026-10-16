/**
 * 单局战斗状态机（纯逻辑，无渲染、无引擎依赖、无平台 API）
 *
 * 职责：把「一局 6-10 分钟的快节奏割草 Roguelike」完整跑起来——
 *   开局三选一 → 12 波实时战斗（波间三选一） → 通关 / 阵亡结算
 *
 * 为什么战斗逻辑和渲染要彻底分开：
 *   core 里跑 1000 局只需几百毫秒，因此「改一个数值要等 3 分钟编译」这件事不会发生。
 *   渲染层（浏览器 Canvas / 未来的 Cocos）只读 state，永不写 state。
 *
 * 与 tools/sim 的解析式模型（balance.js）的关系：
 *   解析式模型用于万局量级的**相对强度**对比，故意忽略走位与操作；
 *   本文件是带走位、带刷怪节奏的**绝对**过程。两者的波次血量与敌人 DPS 完全同源
 *   （都调用 balance.js 的 waveStats），所以模拟结论可以直接指导本文件的数值。
 *
 * 一处刻意的差异（已记录在 README 的「已知简化」）：
 *   balance.js 里「扛过 30 秒」即视为通关，本文件沿用同一规则——所以 Boss 有两种过法：
 *   输出流把它打死，生存流扛到它力竭退去。这是设计选择，不是漏洞。
 */

import { buildCardIndex, computeStats, createOwned, withCard } from './stats.js';
import { findChoice, isRestOption, offerChoices, REST_OPTION } from './deck.js';
import { createRng } from './rng.js';
import { createWallet, earn, spiritFromClear, spiritFromKill, spiritFromWave } from './economy.js';
import { waveStats } from './balance.js';

/** 单局阶段 */
export const PHASE = Object.freeze({
  /** 暂停中，等待玩家三选一（开局与每次波间都会进入） */
  UPGRADE: 'upgrade',
  /** 战斗中 */
  FIGHTING: 'fighting',
  /** 已通关 */
  CLEARED: 'cleared',
  /** 已阵亡 */
  DEAD: 'dead',
});

/** 单帧最大步长。切后台再回来会产生几秒的 dt，不设上限会瞬间清空血条 */
const MAX_STEP = 1 / 20;

/** 伤害数字的存活时间（秒），与渲染层共用 */
const DAMAGE_NUMBER_TTL = 0.55;

/** 特效数组上限：防止极端情况下无限增长 */
const MAX_EFFECTS = 80;

/** 把数值夹到区间内 */
function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * 创建一局
 *
 * @param {Object} params
 * @param {any} params.data 数值表（core/src/data.generated.js 的 CARDS_DATA）
 * @param {number} [params.seed=20261013] 随机种子。同一个种子必然跑出同一局，便于复现 bug
 * @param {{ atkMul?: number, hpMul?: number }} [params.metaBonus] 局外成长的永久加成
 */
export function createBattle({ data, seed = 20261013, metaBonus = {} }) {
  const rng = createRng(seed);
  const cardIndex = buildCardIndex(data.cards);
  const arena = data.arena;
  const motion = data.enemyMotion;
  const spawnCfg = data.spawn;

  // 把局外加成直接折进基准值：core 里的所有下游公式都不需要知道「境界」的存在。
  // 这样加新的局外成长维度时，只改这一处。
  const base = Object.freeze({
    ...data.base,
    atk: data.base.atk * (metaBonus.atkMul ?? 1),
    hp: data.base.hp * (metaBonus.hpMul ?? 1),
  });

  // ---------- 局内状态 ----------
  /** @type {Map<string, number>} 已持有卡牌 id -> 层数 */
  let owned = createOwned();
  let stats = computeStats(owned, cardIndex, base);
  let hp = stats.maxHp;

  const player = { x: arena.width / 2, y: arena.height / 2, r: arena.playerRadius };
  /** @type {any[]} 场上敌人。渲染层只读 */
  let enemies = [];
  /** @type {any[]} 短生命周期特效（伤害数字 / 命中闪光），供渲染层消费 */
  let effects = [];

  let phase = PHASE.UPGRADE;
  let wave = 1;
  let runTime = 0;
  let waveTime = 0;
  /** @type {any[]} 每波结算记录，用于结算面板与事后分析 */
  const waveLogs = [];
  /** @type {any[]} 玩家这一局做过的所有选择，用于分析 Build 路线 */
  const picks = [];

  // 当前波次的预算
  let waveTotal = 0;
  let waveIncoming = 0;
  let waveHpLeft = 0;
  let waveKills = 0;

  // 刷怪
  let pendingSpawn = 0;
  let spawnTimer = 0;
  let spawnInterval = 1;
  let groupSize = 1;

  // 攻击
  let attackTimer = 0;

  // 统计与结算
  let kills = 0;
  let bossKills = 0;
  /**
   * 击杀数换算成「解析式单位」后的值。
   * 表现层一波是 24 个小怪，模型里一波是 6 个单位；kills 记的是屏幕上的个数，
   * killUnits 记的是折算回模型口径的数量（一个小怪算 6/24 个）。
   * 经济核对必须用后者，否则会得出「实际产出是理论值的四倍」这种假警报。
   */
  let killUnits = 0;
  let nextEnemyId = 1;
  let lastAttackAt = -9;
  const wallet = createWallet(0);

  // 开发期开关，仅供 Debug 面板使用
  let godMode = false;

  // ---------- 内部函数 ----------

  /** 重新聚合属性。生命上限变化时按比例换算当前血量 */
  function applyStats() {
    const prevMax = stats.maxHp;
    stats = computeStats(owned, cardIndex, base);
    if (prevMax > 0 && hp > 0) {
      // 按比例换算：拿到 +生命 的卡不会白送一口血，也不会因为上限提高而变相掉血。
      // 与解析式模型的差异在此，属于刻意的「手感优先」选择。
      hp = hp * (stats.maxHp / prevMax);
    }
    hp = clamp(hp, 0, stats.maxHp);
  }

  /** 计算第 n 波的预算。直接复用解析式模型的公式，保证两份代码不会各算各的 */
  function budgetFor(n) {
    const ws = waveStats(n, data);
    const isBoss = ws.isBoss;
    // 表现层参数：把总血量摊到更多单位上，总血量与总 DPS 不变
    const swarm = isBoss ? 1 : Math.max(1, spawnCfg.swarmPerWave);
    return {
      isBoss,
      swarm,
      totalHp: ws.totalHp,
      incoming: ws.incomingDps,
      perHp: ws.totalHp / swarm,
      perDps: ws.incomingDps / swarm,
      /**
       * 单个敌人的灵石产出。
       *
       * 这里刻意**不**用 spiritFromKill 的原值，而是按「解析式单位占比」折算：
       * swarmPerWave 是表现层参数（把一波摊成几个小怪），它绝不能改变玩家赚多少钱。
       * 若按个头计价，24 个小怪的一波就会比模型里的 6 个单位多赚 4 倍——
       * 实测通关产出会从设计目标 350 冲到 636，而所有单测都不会发现。
       * 折算后「清空一波」拿到的钱恰好等于 perWave × 单位价，与解析式模型完全对齐。
       * 零头由 economy.js 的 wallet.carry 累积，不会丢。
       */
      spiritPerKill: spiritFromKill(isBoss, data) * (isBoss ? 1 : data.enemy.perWave / swarm),
      /** 单个敌人折算回解析式单位后的占比（Boss 就是 1 个） */
      unitsPerEnemy: isBoss ? 1 : data.enemy.perWave / swarm,
    };
  }

  /** 开启第 wave 波 */
  function startWave() {
    const b = budgetFor(wave);
    waveTotal = b.totalHp;
    waveIncoming = b.incoming;
    waveHpLeft = b.totalHp;
    waveKills = 0;
    waveTime = 0;
    pendingSpawn = b.swarm;
    groupSize = Math.max(1, Math.ceil(b.swarm / Math.max(1, spawnCfg.groups)));
    // 批间隔是固定秒数，**不能**由波次时长推导。
    // 曾经写成 waveDuration/groups（7.5 秒），结果最后一批敌人第 29 秒才到场，
    // 而这一波只有 30 秒——真实战斗每一波都必然超时，与模型的 30 秒窗口假设完全脱节。
    spawnInterval = Math.max(0.2, spawnCfg.groupInterval ?? 2);
    spawnTimer = 0;
    attackTimer = 0;
    currentWave = b;
    enemies = [];
    effects = [];
  }

  let currentWave = null;

  /**
   * 取一个刷新点：以玩家为中心、落在攻击范围之外的圆环上。
   *
   * 为什么是「环」而不是「场地边缘」：
   *   从边缘走到玩家面前要 5-7 秒，白占 30 秒波次时长的四分之一，
   *   而且那段时间玩家既不打人也不挨打，纯属空转——灰盒试玩时表现为「进图先干等」。
   *   环上生成把这段压缩到 1-2 秒，代价是敌人会「凭空出现」，
   *   所以渲染层会用一圈扩散的法阵来把它解释成「妖物破空而来」。
   *
   * 采样策略：最多试 8 次，要求刷新点完整落在场地内（留 wallInset 边距）。
   *   玩家贴着墙角时会连续失败，此时退化为「沿玩家到场地中心的方向往外放」，
   *   保证一定能拿到合法点，不会出现敌人刷在墙外永远走不进来。
   */
  function randomSpawnPos() {
    const cfg = spawnCfg;
    const inset = cfg.wallInset ?? 30;
    const isBoss = currentWave?.isBoss;
    const rMin = isBoss ? cfg.bossRingMin ?? 450 : cfg.ringMin ?? 300;
    const rMax = isBoss ? cfg.bossRingMax ?? 560 : cfg.ringMax ?? 440;

    for (let attempt = 0; attempt < 8; attempt++) {
      const r = rng.float(rMin, rMax);
      const a = rng.float(0, Math.PI * 2);
      const x = player.x + Math.cos(a) * r;
      const y = player.y + Math.sin(a) * r;
      if (x >= inset && x <= arena.width - inset && y >= inset && y <= arena.height - inset) {
        return { x, y };
      }
    }

    // 兜底：朝场地中心方向找一条能站住的射线
    const cx = arena.width / 2 - player.x;
    const cy = arena.height / 2 - player.y;
    const len = Math.hypot(cx, cy) || 1;
    const r = Math.min((rMin + rMax) / 2, Math.max(arena.width, arena.height) * 0.4);
    return {
      x: clamp(player.x + (cx / len) * r, inset, arena.width - inset),
      y: clamp(player.y + (cy / len) * r, inset, arena.height - inset),
    };
  }

  /** 投放一批敌人 */
  function spawnGroup() {
    if (!currentWave || pendingSpawn <= 0) return;
    const n = Math.min(groupSize, pendingSpawn);
    for (let i = 0; i < n; i++) {
      const p = randomSpawnPos();
      enemies.push({
        id: nextEnemyId++,
        x: p.x,
        y: p.y,
        hp: currentWave.perHp,
        maxHp: currentWave.perHp,
        r: currentWave.isBoss ? motion.bossRadius : motion.radius,
        dps: currentWave.perDps,
        speed: currentWave.isBoss ? motion.bossSpeed : motion.speed,
        isBoss: currentWave.isBoss,
        flash: 0,
        // 出生时刻：渲染层用它画一圈扩散的法阵，把「凭空出现」解释成「破空而来」
        bornAt: runTime,
        dead: false,
      });
    }
    pendingSpawn -= n;
  }

  /** 推一条伤害数字（渲染层消费） */
  function pushDamageNumber(x, y, amount, crit) {
    if (effects.length >= MAX_EFFECTS) effects.shift();
    effects.push({
      kind: crit ? 'crit' : 'hit',
      x,
      y,
      text: crit ? `${Math.round(amount)}!` : `${Math.round(amount)}`,
      ttl: DAMAGE_NUMBER_TTL,
      life: DAMAGE_NUMBER_TTL,
    });
  }

  /** 敌人掉血。canCrit=false 用于固定 DPS 通道（与解析式模型一致：固定伤害不吃暴击） */
  function hitEnemy(enemy, rawDamage, canCrit) {
    if (enemy.dead) return;
    let dmg = rawDamage;
    let crit = false;
    if (canCrit && stats.critRate > 0 && rng.chance(stats.critRate)) {
      crit = true;
      dmg *= 1 + stats.critDmg;
    }
    enemy.hp -= dmg;
    enemy.flash = 0.12;
    if (canCrit) pushDamageNumber(enemy.x, enemy.y - enemy.r, dmg, crit);
    if (enemy.hp <= 0) killEnemy(enemy);
  }

  /** 击杀结算：经济、回血、波次进度 */
  function killEnemy(enemy) {
    if (enemy.dead) return;
    enemy.dead = true;
    kills++;
    waveKills++;
    if (enemy.isBoss) bossKills++;
    waveHpLeft = Math.max(0, waveHpLeft - enemy.maxHp);
    // 按解析式单位占比计价，而不是按屏幕上的敌人个数（见 budgetFor.spiritPerKill）
    earn(wallet, currentWave?.spiritPerKill ?? 0);
    killUnits += currentWave?.unitsPerEnemy ?? 1;
    if (stats.healPerKill > 0) hp = Math.min(stats.maxHp, hp + stats.healPerKill);
  }

  /** 玩家受伤。godMode 打开时直接忽略（Debug 用） */
  function damagePlayer(amount) {
    if (godMode || amount <= 0) return;
    hp -= amount;
    if (hp <= 0) {
      hp = 0;
      phase = PHASE.DEAD;
      enemies = [];
    }
  }

  /** 取最近的若干个敌人（受攻击范围限制） */
  function nearestEnemies(limit, range) {
    const rangeSq = range * range;
    const found = [];
    for (const e of enemies) {
      if (e.dead) continue;
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      const dsq = dx * dx + dy * dy;
      if (dsq <= rangeSq) found.push({ e, dsq });
    }
    found.sort((a, b) => a.dsq - b.dsq);
    return found.slice(0, limit).map((x) => x.e);
  }

  /** 打开三选一 */
  function openUpgrade() {
    phase = PHASE.UPGRADE;
    choices = offerChoices({ owned, cards: data.cards, cardIndex, rng });
  }

  let choices = null;

  /** 结束当前波次 */
  function endWave(inTime) {
    const overflow = waveTotal > 0 ? clamp(waveHpLeft / waveTotal, 0, 1) : 0;
    let penalty = 0;
    if (!inTime && overflow > 0) {
      // 超时：残余敌人力竭退去，但反噬一次。
      // 系数 1.5 与解析式模型的 overflow 惩罚保持一致，避免两份模型的难度口径分叉。
      penalty = waveIncoming * overflow * data.base.waveDuration * stats.damageTakenMul * 1.5;
      damagePlayer(penalty);
      enemies = [];
    }

    const clearedSquares = inTime;
    waveLogs.push({
      wave,
      inTime: clearedSquares,
      overflow,
      penalty,
      hpAfter: Math.max(0, hp),
      kills: waveKills,
      seconds: waveTime,
      dps: stats.dps,
      // 记录该波的常态目标数：一致性核对脚本需要它来还原 Boss 波的「有效 DPS」。
      // Boss 只有一个单位，连锁/多目标收益在那一波完全失效，若不记录就无法核对。
      targets: stats.targets,
    });

    // 波次奖励：只有「清空」才给奖励。超时给奖励会鼓励故意不打
    if (clearedSquares) earn(wallet, spiritFromWave(wave, data));
    else waveLogs[waveLogs.length - 1].note = '超时未清空：无波次奖励，仅承受反击';

    if (phase === PHASE.DEAD) return;

    // 波间回复（回血泉），避免跨波累计伤害过于严苛
    hp = Math.min(stats.maxHp, hp + stats.maxHp * (data.enemy.waveClearHealPct ?? 0));

    if (wave >= data.base.waves) {
      phase = PHASE.CLEARED;
      earn(wallet, spiritFromClear(data));
      return;
    }

    wave++;
    startWave();
    openUpgrade();
  }

  // ---------- 开局 ----------
  startWave();
  openUpgrade();

  // ---------- 对外接口 ----------
  const api = {
    /** 数值表与种子（结算面板与复现用） */
    data,
    seed,
    base,

    /**
     * 推进一帧
     * @param {number} dt 距上一帧的秒数
     * @param {{ dx: number, dy: number }} [input] 移动输入，未归一化也可以
     */
    step(dt, input) {
      if (phase !== PHASE.FIGHTING) return;
      const h = clamp(dt, 0, MAX_STEP);
      runTime += h;
      waveTime += h;

      // --- 移速 ---
      let dx = input?.dx ?? 0;
      let dy = input?.dy ?? 0;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        // 归一化：否则斜向移动会快 41%
        dx /= len;
        dy /= len;
        player.x = clamp(player.x + dx * arena.playerSpeed * h, player.r, arena.width - player.r);
        player.y = clamp(player.y + dy * arena.playerSpeed * h, player.r, arena.height - player.r);
      }

      // --- 刷怪 ---
      if (pendingSpawn > 0) {
        spawnTimer -= h;
        // 场上已空就立刻投放下一批，不让玩家空等（这是「快节奏」的关键）
        if (enemies.length === 0) spawnTimer = 0;
        if (spawnTimer <= 0) {
          spawnGroup();
          spawnTimer = spawnInterval;
        }
      }

      // --- 敌人移动 / 贴身伤害 / 单位间排斥 ---
      for (const e of enemies) {
        if (e.dead) continue;
        e.flash = Math.max(0, e.flash - h);
        let vx = player.x - e.x;
        let vy = player.y - e.y;
        const d = Math.hypot(vx, vy) || 1;
        const contact = player.r + e.r;
        if (d > contact) {
          e.x += (vx / d) * e.speed * h;
          e.y += (vy / d) * e.speed * h;
        } else {
          // 贴身时持续掉血，速率等于该单位的 dps —— 这是「被围住会死」的来源
          damagePlayer(e.dps * h);
          if (phase === PHASE.DEAD) return;
        }
      }

      // 排斥：防止所有敌人叠成一点，让玩家数不清场上有多少
      const sep = motion.separation;
      for (let i = 0; i < enemies.length; i++) {
        const a = enemies[i];
        if (a.dead) continue;
        for (let j = i + 1; j < enemies.length; j++) {
          const b = enemies[j];
          if (b.dead) continue;
          const ddx = b.x - a.x;
          const ddy = b.y - a.y;
          const dd = Math.hypot(ddx, ddy);
          const minD = a.r + b.r;
          if (dd > 0 && dd < minD) {
            const push = ((minD - dd) / 2) * sep;
            const ux = (ddx / dd) * push;
            const uy = (ddy / dd) * push;
            a.x -= ux;
            a.y -= uy;
            b.x += ux;
            b.y += uy;
          }
        }
      }

      // --- 自动攻击（普通攻击通道，可暴击、吃连锁多目标） ---
      //
      // 关键：出手频率与单次伤害都由「总 DPS」反推，两者相乘恒等于
      //   base.atk × atkMul × base.spd × spdMul × targets ×（1 + 暴击率 × 暴伤）
      // 也就是解析式模型（balance.js）用的那条公式。
      //
      // 为什么要把频率提得比直觉高得多（10 次/秒）：
      //   真实战斗是「一次出手造成一份伤害」，而模型把一波敌人当成一个血量池。
      //   若出手只有 1 次/秒，单次 10 点伤害打在 3.5 血的小兵上，绝大部分伤害被溢出吃掉，
      //   实测第 1 波清空耗时 30 秒（超时）而模型预测 8.4 秒——两份模型会给出相反的难度结论。
      //   提高频率后单次伤害降到 1 点量级，溢出浪费回到 15% 以内，两份模型重新对齐。
      //
      // 出手频率对玩家不可见：挥砍动画另有节流（见下方 slashCooldown），
      // 所以这个数字可以纯粹为「数值一致性」服务，不必迁就手感。
      const aps = Math.max(1, data.combat?.baseAttacksPerSecond ?? 10);
      const interval = 1 / Math.max(0.5, base.spd * stats.spdMul * aps);
      const perHit = (base.atk * stats.atkMul) / aps;

      attackTimer += h;
      if (attackTimer >= interval) {
        const targets = nearestEnemies(Math.max(1, Math.round(stats.targets)), arena.attackRange);
        if (targets.length > 0) {
          attackTimer -= interval;
          // 挥砍动画節流：伤害按 10 次/秒结算，但视觉上每 0.3 秒才画一道弧，
          // 否则那道弧会常亮，看起来像贴图错位而不是攻击
          if (runTime - lastAttackAt >= 0.3) lastAttackAt = runTime;
          for (const t of targets) hitEnemy(t, perHit, true);
        } else {
          // 没有目标时不累积冷却，敌人一进入射程就能立刻出手
          attackTimer = Math.min(attackTimer, interval);
        }
      }

      // --- 固定 DPS 通道（召唤物 / 反伤）。不吃暴击与乘区，与解析式模型一致 ---
      if (stats.flatDps > 0) {
        const t = nearestEnemies(1, arena.attackRange)[0];
        if (t) hitEnemy(t, stats.flatDps * h, false);
      }

      // --- 清理尸体 ---
      if (enemies.some((e) => e.dead)) enemies = enemies.filter((e) => !e.dead);

      // --- 特效计时 ---
      if (effects.length > 0) {
        for (const f of effects) f.ttl -= h;
        effects = effects.filter((f) => f.ttl > 0);
      }

      // --- 波次结束判定 ---
      if (phase === PHASE.DEAD) return;
      if (pendingSpawn === 0 && enemies.length === 0) endWave(true);
      else if (waveTime >= data.base.waveDuration) endWave(false);
    },

    /**
     * 结算一次三选一
     * @param {string} id 选项 id
     * @returns {boolean} 是否成功
     */
    choose(id) {
      if (phase !== PHASE.UPGRADE || !choices) return false;
      const card = findChoice(choices, id);
      if (!card) return false;

      if (isRestOption(card)) {
        hp = Math.min(stats.maxHp, hp + stats.maxHp * REST_OPTION.healPct);
      } else {
        owned = withCard(owned, card.id);
        applyStats();
      }
      picks.push({ wave, id: card.id, name: card.name, school: card.school, at: runTime });
      choices = null;
      phase = PHASE.FIGHTING;
      return true;
    },

    /** 当前的三选一候选（仅在 UPGRADE 阶段非空） */
    getChoices() {
      return choices;
    },

    /**
     * 给渲染层读取的完整状态快照
     * 约定：渲染层只读，禁止写入。enemies / effects 直接返回引用以避免每帧拷贝开销
     */
    getState() {
      return {
        phase,
        wave,
        wavesTotal: data.base.waves,
        isBossWave: wave === data.enemy.bossWave,
        runTime,
        waveTime,
        waveTimeLeft: Math.max(0, data.base.waveDuration - waveTime),
        waveDuration: data.base.waveDuration,
        waveHpLeft,
        waveTotal,
        pendingSpawn,
        arena,
        player,
        enemies,
        effects,
        hp,
        maxHp: stats.maxHp,
        stats,
        owned: [...owned.entries()],
        spirit: wallet.amount,
        kills,
        bossKills,
        lastAttackAt,
      };
    },

    /** 结算数据 */
    result() {
      return {
        phase,
        seed,
        reachedWave: wave,
        wavesTotal: data.base.waves,
        cleared: phase === PHASE.CLEARED,
        kills,
        bossKills,
        /** 折算回解析式单位的击杀数，经济核对用（见 killUnits 的说明） */
        killUnits,
        spirit: wallet.amount,
        runTime,
        hp,
        maxHp: stats.maxHp,
        owned: [...owned.entries()],
        picks,
        waveLogs,
      };
    },

    /** 钱包（只读用途），供 meta 结算扣减 */
    wallet,

    // ---------- 以下仅供 Debug 面板 / 测试使用，正式流程不应调用 ----------

    /** 直接发一张卡（跳过三选一），用于 Debug 与测试中构造特定 Build */
    debugGrantCard(id) {
      const card = cardIndex.get(id);
      if (!card) return false;
      owned = withCard(owned, id);
      applyStats();
      return true;
    },

    /** 立刻结束当前波（inTime=true 表示按清空处理） */
    debugEndWave(inTime = true) {
      if (phase !== PHASE.FIGHTING) return false;
      endWave(inTime);
      return true;
    },

    /**
     * 关闭本次三选一但不发卡。
     * 用于 Debug 面板的「跳过」按钮，以及测试里构造「一张卡都不拿」的对照局——
     * 对照局是验证「强化是否真的有意义」的唯一手段。
     */
    debugSkipUpgrade() {
      if (phase !== PHASE.UPGRADE) return false;
      choices = null;
      phase = PHASE.FIGHTING;
      return true;
    },

    /** 跳到指定波次，并把已跳过的波次按「清空」补记奖励。落点停在升级界面，方便继续选卡 */
    debugJumpToWave(target) {
      if (phase === PHASE.DEAD) return false;
      while (wave < target && phase !== PHASE.DEAD && phase !== PHASE.CLEARED) {
        if (phase === PHASE.UPGRADE) {
          // 卡在升级界面时选第一个，保持流程不中断
          const c = choices?.[0];
          if (c) api.choose(c.id);
          else phase = PHASE.FIGHTING;
        }
        endWave(true);
      }
      return phase === PHASE.UPGRADE;
    },

    /** 打开 / 关闭无敌（Debug） */
    debugSetGodMode(on) {
      godMode = !!on;
    },

    /** 直接把血量补满（Debug） */
    debugHeal() {
      hp = stats.maxHp;
    },

    /** 手动推进随机流的位置校验（测试用） */
    rngState: () => rng.getState(),

    /**
     * 直接替换整张持有表并重算属性。
     * 用途：Debug 面板的「清空构筑」与「一键指定 Build」，以及测试里构造边界状态。
     * @param {Array<[string, number]>} entries
     */
    debugSetOwned(entries) {
      const next = createOwned();
      for (const [id, n] of entries ?? []) {
        if (cardIndex.has(id) && Number.isFinite(n) && n > 0) next.set(id, Math.floor(n));
      }
      owned = next;
      // 这里不做「按比例换算血量」——Debug 换构筑时不希望顺手回血或掉血，
      // 只把超出新上限的部分夹掉
      stats = computeStats(owned, cardIndex, base);
      hp = clamp(hp, 0, stats.maxHp);
      return true;
    },
  };

  return api;
}
