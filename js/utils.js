/**
 * 公共小工具
 * ------------------------------------------------------------
 * 各模块共用的数学与随机函数，集中在这里避免重复定义。
 */

/** 数值裁剪到 [a, b] */
export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** 线性插值 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 从数组中随机取一个 */
export function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

/** 缓出曲线：起步快、末段减速 */
export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** 把角度规范到 -PI..PI */
export function normAngle(a) {
  const TAU = Math.PI * 2;
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

/** 两点距离的平方（比较大小用，省掉开方） */
export function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** [a, b) 区间随机数 */
export function randRange(a, b) {
  return a + Math.random() * (b - a);
}

/**
 * 帧率无关的指数平滑系数
 * 用 1-exp(-k*dt) 而不是固定常数，保证不同帧率下手感一致
 */
export function smoothK(k, dt) {
  return 1 - Math.exp(-k * dt);
}

/** 指数衰减（用于粒子亮度、震动幅度等） */
export function decay(value, k, dt) {
  const v = value * Math.exp(-k * dt);
  return Math.abs(v) < 1e-4 ? 0 : v;
}

/** #RRGGBB -> rgba(r,g,b,a) */
export function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** 颜色整体加减亮度 */
export function shiftColor(hex, delta) {
  const h = hex.replace('#', '');
  const r = clamp(parseInt(h.slice(0, 2), 16) + delta, 0, 255) | 0;
  const g = clamp(parseInt(h.slice(2, 4), 16) + delta, 0, 255) | 0;
  const b = clamp(parseInt(h.slice(4, 6), 16) + delta, 0, 255) | 0;
  return `rgb(${r},${g},${b})`;
}

/** 提亮 */
export function lighten(hex, t) {
  return shiftColor(hex, t * 255);
}

/** 压暗 */
export function darken(hex, t) {
  return shiftColor(hex, -t * 255);
}

/**
 * 永不抛错的本地存储
 * ------------------------------------------------------------
 * 编辑器内置预览的 iframe 沙箱、隐私模式、部分企业策略下，光是读取
 * window.localStorage 就会抛 SecurityError。旧代码在 Game 构造函数里裸读
 * 最高分，异常一路冒泡，整个模块初始化中断 —— 所有按钮的事件监听都没绑上，
 * 表现就是「三个按钮点了全没反应」，而且页面不给任何提示。
 *
 * 这里统一包一层：任何异常都降级到内存 Map，游戏照常可玩，只是设置不落盘。
 */
const memoryStore = new Map();
let storageBacking = null;
try {
  const probe = window.localStorage;
  // 有些环境读属性成功、真正读写时才抛，必须实际试一次
  probe.setItem('__poseSnakeProbe__', '1');
  probe.removeItem('__poseSnakeProbe__');
  storageBacking = probe;
} catch (e) {
  storageBacking = null;
}

export const safeStorage = {
  /** 是否真的能写盘（诊断用） */
  get available() { return storageBacking !== null; },

  getItem(key) {
    try {
      if (storageBacking) return storageBacking.getItem(key);
    } catch (e) { /* 落到内存兜底 */ }
    return memoryStore.has(key) ? memoryStore.get(key) : null;
  },

  setItem(key, value) {
    const v = String(value);
    memoryStore.set(key, v);
    try {
      if (storageBacking) storageBacking.setItem(key, v);
    } catch (e) { /* 配额满 / 被禁用：内存里依然有效 */ }
  },

  removeItem(key) {
    memoryStore.delete(key);
    try {
      if (storageBacking) storageBacking.removeItem(key);
    } catch (e) { /* 忽略 */ }
  }
};
