/**
 * Canvas 渲染层
 *
 * 职责边界（非常重要）：本文件**只读** core 的状态，从不写入。
 * 所有游戏规则都在 core 里，因此「画面和逻辑不一致」这类 bug 在结构上就不可能发生。
 *
 * 性能取向：每帧只做一次全屏清屏 + 若干次简单描边填充。
 * 刻意不用 ctx.shadowBlur（每个单位一次模糊在大屏手机上会直接掉帧），
 * 改用「多层半透明圆形」模拟辉光，成本恒定。
 *
 * 坐标系：core 用 720×1280 的逻辑坐标；本层负责缩放并居中（letterbox），
 * 逻辑层因此完全不需要知道屏幕尺寸与像素比。
 */

/** 主题色板。集中在一处，方便整体调风格 */
const PALETTE = {
  bgTop: '#070b12',
  bgBottom: '#0e1725',
  floor: 'rgba(28, 44, 64, 0.55)',
  floorEdge: 'rgba(120, 200, 220, 0.28)',
  grid: 'rgba(110, 190, 215, 0.055)',
  aura: 'rgba(90, 210, 235, 0.10)',
  player: '#6fe9ff',
  playerCore: '#eafcff',
  slash: 'rgba(175, 240, 255, 0.55)',
  enemy: '#c2475f',
  enemyDeep: '#7c2338',
  enemyHit: '#ffffff',
  boss: '#c9a227',
  bossBody: '#8b2f52',
  hpBack: 'rgba(0,0,0,0.55)',
  hpGood: '#5fd39a',
  hpWarn: '#e8c34a',
  hpBad: '#d9506a',
  dmg: '#ffffff',
  crit: '#ffd76a',
  ink: 'rgba(10, 16, 24, 0.72)',
  gold: 'rgba(201, 162, 39, 0.85)',
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  /** 逻辑坐标 -> 屏幕坐标的变换参数 */
  let view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0 };
  /** 预渲染的静态背景（地板 + 网格），避免每帧重画 */
  let backdrop = null;

  /** 按设备像素比重设画布尺寸，并重算 letterbox 变换 */
  function resize(arena) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // 限制到 2，避免高分辨率手机上过度绘制
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const scale = Math.min(cssW / arena.width, cssH / arena.height);
    view = {
      scale,
      ox: (cssW - arena.width * scale) / 2,
      oy: (cssH - arena.height * scale) / 2,
      w: cssW,
      h: cssH,
    };
    backdrop = buildBackdrop(arena);
  }

  /** 把静态背景画到离屏 canvas 上，之后每帧只 drawImage 一次 */
  function buildBackdrop(arena) {
    const off = document.createElement('canvas');
    off.width = arena.width;
    off.height = arena.height;
    const c = off.getContext('2d');

    // 地板底色
    const g = c.createLinearGradient(0, 0, 0, arena.height);
    g.addColorStop(0, '#111d2b');
    g.addColorStop(0.5, '#16283a');
    g.addColorStop(1, '#101a26');
    c.fillStyle = g;
    c.fillRect(0, 0, arena.width, arena.height);

    // 中央灵气光晕：给玩家一个视觉锚点，也让画面中心更亮
    const glow = c.createRadialGradient(
      arena.width / 2,
      arena.height / 2,
      40,
      arena.width / 2,
      arena.height / 2,
      arena.height * 0.55,
    );
    glow.addColorStop(0, 'rgba(110, 220, 245, 0.10)');
    glow.addColorStop(1, 'rgba(110, 220, 245, 0)');
    c.fillStyle = glow;
    c.fillRect(0, 0, arena.width, arena.height);

    // 网格：制造「法阵」质感，同时让玩家能感知移动速度
    c.strokeStyle = PALETTE.grid;
    c.lineWidth = 1;
    const step = 64;
    c.beginPath();
    for (let x = step; x < arena.width; x += step) {
      c.moveTo(x, 0);
      c.lineTo(x, arena.height);
    }
    for (let y = step; y < arena.height; y += step) {
      c.moveTo(0, y);
      c.lineTo(arena.width, y);
    }
    c.stroke();

    // 中央法阵环
    c.strokeStyle = 'rgba(120, 200, 225, 0.13)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(arena.width / 2, arena.height / 2, 220, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.arc(arena.width / 2, arena.height / 2, 300, 0, Math.PI * 2);
    c.stroke();

    return off;
  }

  /** 逻辑坐标 -> 屏幕坐标 */
  function sx(x) {
    return view.ox + x * view.scale;
  }
  function sy(y) {
    return view.oy + y * view.scale;
  }

  /**
   * 画一帧
   * @param {any} state core/battle.js 的 getState() 结果
   * @param {{ stick?: any }} [extras] 输入层的摇杆可视化数据
   */
  function draw(state, extras = {}) {
    const { arena } = state;

    // 1. 全屏底色
    const bg = ctx.createLinearGradient(0, 0, 0, view.h);
    bg.addColorStop(0, PALETTE.bgTop);
    bg.addColorStop(1, PALETTE.bgBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, view.w, view.h);

    // 2. 战场
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    ctx.beginPath();
    ctx.rect(0, 0, arena.width, arena.height);
    ctx.clip();

    ctx.drawImage(backdrop, 0, 0);

    // 3. 敌人
    for (const e of state.enemies) drawEnemy(e, state.runTime);

    // 4. 玩家
    drawPlayer(state, extras);

    // 5. 特效（伤害数字）
    drawEffects(state);

    ctx.restore();

    // 6. 战场边框（画在裁剪之外，形成画框感）
    //    双线 + 内发光：当设备不是 9:16 时战场两侧/上下会有留白，
    //    明确的画框能让留白看起来是刻意的构图，而不是「页面没铺满」
    const fw = arena.width * view.scale;
    const fh = arena.height * view.scale;
    ctx.strokeStyle = 'rgba(120, 200, 220, 0.16)';
    ctx.lineWidth = 6;
    ctx.strokeRect(view.ox - 3, view.oy - 3, fw + 6, fh + 6);
    ctx.strokeStyle = PALETTE.floorEdge;
    ctx.lineWidth = 2;
    ctx.strokeRect(view.ox, view.oy, fw, fh);

    // 7. 虚拟摇杆
    if (extras.stick) drawStick(extras.stick);
  }

  /** 敌人：普通单位是菱形，Boss 是带旋转外环的六边形 */
  function drawEnemy(e, now) {
    const r = e.r;
    const hpRatio = Math.max(0, e.hp / e.maxHp);
    const flash = e.flash > 0;

    if (e.isBoss) {
      // 外环
      ctx.strokeStyle = PALETTE.boss;
      ctx.lineWidth = 5;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r + 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // 本体
      ctx.fillStyle = PALETTE.bossBody;
      polygon(e.x, e.y, r, 6, 0);
      ctx.fill();
      // 受击表现：只把描边点亮成白色，保留本体颜色。
      // 整只填充白色会让体积最大的 Boss 变成一坨白光斑，反而看不出它是什么
      ctx.strokeStyle = flash ? '#ffffff' : PALETTE.boss;
      ctx.lineWidth = flash ? 5 : 3;
      ctx.stroke();
    } else {
      // 辉光层（用两次半透明扩散代替 shadowBlur）
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = PALETTE.enemy;
      polygon(e.x, e.y, r * 1.7, 4, Math.PI / 4);
      ctx.fill();
      ctx.globalAlpha = 1;

      // 本体
      ctx.fillStyle = PALETTE.enemy;
      polygon(e.x, e.y, r, 4, Math.PI / 4);
      ctx.fill();

      // 受击：同样只描边，本体始终是可辨认的妖红
      if (flash) {
        ctx.strokeStyle = PALETTE.enemyHit;
        ctx.lineWidth = 2.5;
        polygon(e.x, e.y, r * 1.15, 4, Math.PI / 4);
        ctx.stroke();
      }

      // 内芯：深色小菱形，让密集的敌群有层次而不糊成一片
      ctx.fillStyle = PALETTE.enemyDeep;
      polygon(e.x, e.y, r * 0.42, 4, Math.PI / 4);
      ctx.fill();
    }

    // 破空而来：出生后 0.4 秒内画一圈扩散的法阵。
    // 敌人是在玩家附近的圆环上生成的（见 battle.js 的 randomSpawnPos 注释），
    // 这圈特效负责把「凭空出现」解释成「妖物破空而至」，否则玩家只会觉得画面跳了一下
    const age = e.bornAt === undefined ? Infinity : now - e.bornAt;
    if (age >= 0 && age < 0.4) {
      const t = age / 0.4;
      ctx.strokeStyle = e.isBoss ? PALETTE.boss : PALETTE.enemy;
      ctx.globalAlpha = (1 - t) * 0.75;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r + t * r * 2.4, 0, Math.PI * 2);
      ctx.stroke();
      // 内圈反向收缩，形成「撕裂空间」的错觉
      ctx.globalAlpha = (1 - t) * 0.4;
      ctx.beginPath();
      ctx.arc(e.x, e.y, Math.max(1, r * (1 - t)), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 血条：只在掉血后显示，避免开局满屏色块
    if (hpRatio < 0.999) {
      const w = r * 1.9;
      const h = e.isBoss ? 6 : 4;
      const y = e.y - r - (e.isBoss ? 20 : 12);
      ctx.fillStyle = PALETTE.hpBack;
      ctx.fillRect(e.x - w / 2, y, w, h);
      // 敌人血条统一用妖红：玩家血条才使用绿→黄→红的三段语义，
      // 敌方如果也用绿色会让人误以为是友军
      ctx.fillStyle = PALETTE.hpBad;
      ctx.fillRect(e.x - w / 2, y, w * hpRatio, h);
    }
  }

  /** 玩家：多层扩散的辉光 + 朝向线 + 攻击范围提示 */
  function drawPlayer(state, extras) {
    const p = state.player;
    const range = 240;

    // 攻击范围提示：极淡的一圈。灰盒阶段它比好看更重要——
    // 玩家需要知道「为什么这刀打到了/没打到」，否则无法判断自己该站多远
    ctx.strokeStyle = 'rgba(111, 233, 255, 0.10)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 10]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, range, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 辉光：收敛到 2.4 倍半径。之前铺到 3.4 倍时玩家看起来是一团模糊的光斑，
    // 在密集敌群里反而更难辨认自己的位置
    ctx.fillStyle = PALETTE.player;
    ctx.globalAlpha = 0.09;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 朝向线：指向最近的敌人。让「自动攻击」不是黑箱——
    // 玩家能看出自己正在锁定谁
    const target = nearest(state.enemies, p);
    if (target) {
      const a = Math.atan2(target.y - p.y, target.x - p.x);
      ctx.strokeStyle = 'rgba(200, 245, 255, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(a) * (p.r * 1.2), p.y + Math.sin(a) * (p.r * 1.2));
      ctx.lineTo(p.x + Math.cos(a) * (p.r * 3.6), p.y + Math.sin(a) * (p.r * 3.6));
      ctx.stroke();
    }

    // 剑气挥砍：攻击后短暂画一道弧
    const sinceAttack = state.runTime - (state.lastAttackAt ?? -9);
    if (sinceAttack >= 0 && sinceAttack < 0.18) {
      const t = sinceAttack / 0.18;
      ctx.strokeStyle = PALETTE.slash;
      ctx.lineWidth = 6 * (1 - t * 0.5);
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.beginPath();
      const start = -Math.PI * 0.5 + t * Math.PI * 0.9;
      ctx.arc(p.x, p.y, range * 0.94, start, start + Math.PI * 0.65);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 本体：实心圆 + 描边环 + 高光芯。三层保证在任何底色上都醒目
    ctx.fillStyle = PALETTE.player;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(234, 252, 255, 0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = PALETTE.playerCore;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 0.42, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 找出离玩家最近的敌人（用于朝向指示） */
  function nearest(enemies, p) {
    let best = null;
    let bestSq = Infinity;
    for (const e of enemies) {
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const d = dx * dx + dy * dy;
      if (d < bestSq) {
        bestSq = d;
        best = e;
      }
    }
    return best;
  }

  /** 伤害数字：向上飘并淡出。暴击更大更亮 */
  function drawEffects(state) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of state.effects) {
      const t = 1 - f.ttl / f.life; // 0 -> 1
      const crit = f.kind === 'crit';
      const rise = 26 * t;
      ctx.globalAlpha = Math.max(0, 1 - t * t);
      ctx.font = `${crit ? 'bold 22px' : '16px'} "Noto Sans SC", system-ui, sans-serif`;
      ctx.fillStyle = crit ? PALETTE.crit : PALETTE.dmg;
      ctx.fillText(f.text, f.x, f.y - rise);
      ctx.globalAlpha = 1;
    }
  }

  /** 虚拟摇杆 */
  function drawStick(stick) {
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#eafcff';
    ctx.beginPath();
    ctx.arc(stick.ox, stick.oy, 64, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = stick.active ? 0.5 : 0.28;
    ctx.fillStyle = '#eafcff';
    ctx.beginPath();
    ctx.arc(stick.knobX, stick.knobY, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** 画一个正多边形（菱形 = 4 边旋转 45°） */
  function polygon(cx, cy, radius, sides, rotation) {
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = rotation + (i / sides) * Math.PI * 2;
      const x = cx + Math.cos(a) * radius;
      const y = cy + Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  return { resize, draw, palette: PALETTE };
}
