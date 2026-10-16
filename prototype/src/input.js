/**
 * 输入适配层：键盘 + 触屏虚拟摇杆
 *
 * 为什么两套都要：
 *   键盘用于桌面浏览器调参（改一行数值立刻用 WASD 试手感），
 *   虚拟摇杆是微信 / 抖音小游戏的**唯一**真实操作方式。
 *   如果只做键盘，等到上小游戏时会发现「操作手感」这个最贵的变量从没被验证过。
 *
 * 输出统一为一个归一化前的向量 { dx, dy }，由 core/battle.js 自己归一化，
 * 这样斜向移动不会更快。
 */

/**
 * 创建输入系统
 * @param {HTMLElement} surface 接收触屏 / 鼠标事件的元素（一般是游戏舞台）
 * @param {{ onPause?: () => void, onToggleDebug?: () => void }} [hooks]
 */
export function createInput(surface, hooks = {}) {
  // 键盘状态
  const keys = new Set();
  // 摇杆状态：以按下点为中心，拖动方向即移动方向
  let stick = null;

  /** 摇杆最大半径（像素），超出后按满速处理 */
  const STICK_RADIUS = 64;
  /** 触发摇杆所需的最小位移，防止手抖导致角色乱走 */
  const DEAD_ZONE = 8;

  // ---------- 键盘 ----------
  function onKeyDown(e) {
    const k = e.key.toLowerCase();
    keys.add(k);
    // 避免空格 / 方向键把页面滚走
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
    if (k === 'escape' || k === 'p') hooks.onPause?.();
    if (k === '`' || k === '\\') hooks.onToggleDebug?.();
  }
  function onKeyUp(e) {
    keys.delete(e.key.toLowerCase());
  }
  // 失焦时清空按键：否则 Alt+Tab 切走再回来，角色会一直往一个方向跑
  function onBlur() {
    keys.clear();
    stick = null;
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // ---------- 指针（触屏 + 鼠标） ----------
  function localPoint(e) {
    const rect = surface.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e) {
    if (stick) return; // 只支持单指操控，第二根手指忽略
    const p = localPoint(e);
    stick = { ox: p.x, oy: p.y, x: p.x, y: p.y };
    surface.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!stick) return;
    const p = localPoint(e);
    stick.x = p.x;
    stick.y = p.y;
    e.preventDefault();
  }

  function onPointerUp() {
    stick = null;
  }

  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove);
  surface.addEventListener('pointerup', onPointerUp);
  surface.addEventListener('pointercancel', onPointerUp);
  // 阻止移动端的长按选择 / 双指缩放干扰操作
  surface.addEventListener('contextmenu', (e) => e.preventDefault());

  /**
   * 读取当前输入向量（未归一化，允许长度 > 1）
   * @returns {{ dx: number, dy: number }}
   */
  function vector() {
    if (stick) {
      const dx = stick.x - stick.ox;
      const dy = stick.y - stick.oy;
      const len = Math.hypot(dx, dy);
      if (len >= DEAD_ZONE) return { dx, dy };
      return { dx: 0, dy: 0 };
    }

    let dx = 0;
    let dy = 0;
    if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
    if (keys.has('d') || keys.has('arrowright')) dx += 1;
    if (keys.has('w') || keys.has('arrowup')) dy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) dy += 1;
    return { dx, dy };
  }

  /** 摇杆的绘制信息（渲染层画摇杆用），无触摸时返回 null */
  function stickVisual() {
    if (!stick) return null;
    const dx = stick.x - stick.ox;
    const dy = stick.y - stick.oy;
    const len = Math.hypot(dx, dy);
    const clamped = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
    return {
      ox: stick.ox,
      oy: stick.oy,
      knobX: stick.ox + dx * clamped,
      knobY: stick.oy + dy * clamped,
      active: len >= DEAD_ZONE,
    };
  }

  /** 释放所有监听（热重载或切场景时用） */
  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    surface.removeEventListener('pointerdown', onPointerDown);
    surface.removeEventListener('pointermove', onPointerMove);
    surface.removeEventListener('pointerup', onPointerUp);
    surface.removeEventListener('pointercancel', onPointerUp);
  }

  return { vector, stickVisual, dispose };
}
