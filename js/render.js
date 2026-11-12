/**
 * 渲染模块
 * ------------------------------------------------------------
 * 世界很大（4800×2700），相机只显示一块 1600×900 的窗口。
 * 所有绘制都在"世界坐标"下进行，外部先设好相机变换。
 *
 * 性能要点：
 *   - 蛇、食物、背景元素全部按视口裁剪，看不见的不画
 *   - AI 蛇用简化画法（省掉逐节鳞纹和重阴影）
 *   - 背景点阵用预生成图块 + 平移，不每帧重画上千个点
 */

import { CONFIG, WORLD, snakeRadius } from './config.js';
import { clamp, lerp, hexToRgba, lighten, darken } from './utils.js';
import { drawNpcHead } from './heads.js';

const TAU = Math.PI * 2;

/** 圆角矩形路径 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 背景：深蓝黑竞技场 + 冷色点阵 + 世界光斑 + 分屏接缝
 * 与界面层的电光青系统色对齐；蛇与食物仍保持 Q 版卡通画法不变。
 */
export class Background {
  constructor() {
    this.pattern = null;
    this.time = 0;

    // 世界坐标系里的光斑，位置固定，相机移动时产生"穿行感"
    this.blobs = [];
    const rnd = (a, b) => a + Math.random() * (b - a);
    const palette = ['24,116,255', '0,200,255', '96,72,220', '0,235,190', '40,96,210'];
    for (let i = 0; i < 22; i++) {
      this.blobs.push({
        x: rnd(0, WORLD.w),
        y: rnd(0, WORLD.h),
        r: rnd(260, 620),
        c: palette[i % palette.length],
        a: rnd(0.07, 0.15)
      });
    }
  }

  /** 预生成点阵图块 */
  buildPattern() {
    const size = 90;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    // 冷青色小十字：比原来的白点更像竞技场地贴，暗场里也不刺眼
    g.fillStyle = 'rgba(120,220,255,0.075)';
    g.beginPath();
    g.arc(size / 2, size / 2, 2.1, 0, TAU);
    g.fill();
    g.fillRect(size / 2 - 0.5, size / 2 - 7, 1, 14);
    g.fillRect(size / 2 - 7, size / 2 - 0.5, 14, 1);
    this.pattern = c;
    return c;
  }

  update(dt) {
    this.time += dt;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx 已设为世界坐标
   * @param {{x:number,y:number,w:number,h:number}} view 当前可见的世界矩形
   */
  draw(ctx, view) {
    // ---- 底色（只填可见区域）----
    const g = ctx.createLinearGradient(view.x, view.y, view.x + view.w * 0.5, view.y + view.h);
    g.addColorStop(0, '#081226');
    g.addColorStop(0.55, '#060D1C');
    g.addColorStop(1, '#040914');
    ctx.fillStyle = g;
    ctx.fillRect(view.x, view.y, view.w, view.h);

    // ---- 世界光斑 ----
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const b of this.blobs) {
      // 视口裁剪
      if (b.x + b.r < view.x || b.x - b.r > view.x + view.w) continue;
      if (b.y + b.r < view.y || b.y - b.r > view.y + view.h) continue;
      const rg = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      rg.addColorStop(0, `rgba(${b.c},${b.a})`);
      rg.addColorStop(1, `rgba(${b.c},0)`);
      ctx.fillStyle = rg;
      ctx.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
    }
    ctx.restore();

    // ---- 点阵（跟着相机滚动）----
    if (this.pattern) {
      const p = ctx.createPattern(this.pattern, 'repeat');
      if (p) {
        ctx.save();
        ctx.translate(view.x, view.y);
        ctx.fillStyle = p;
        ctx.fillRect(0, 0, view.w, view.h);
        ctx.restore();
      }
    }

    // ---- 分屏接缝：让玩家感知"这是 3×3 的地图" ----
    ctx.save();
    ctx.strokeStyle = 'rgba(86,232,255,0.11)';
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 18]);
    const { tileW, tileH, tilesX, tilesY } = CONFIG.world;
    for (let i = 1; i < tilesX; i++) {
      const x = i * tileW;
      if (x < view.x || x > view.x + view.w) continue;
      ctx.beginPath();
      ctx.moveTo(x, view.y);
      ctx.lineTo(x, view.y + view.h);
      ctx.stroke();
    }
    for (let j = 1; j < tilesY; j++) {
      const y = j * tileH;
      if (y < view.y || y > view.y + view.h) continue;
      ctx.beginPath();
      ctx.moveTo(view.x, y);
      ctx.lineTo(view.x + view.w, y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * 世界边界墙：只在墙进入视野时画，给"这边是尽头"的强烈提示
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} view
 * @param {object} player
 */
export function drawWorldWalls(ctx, view, player) {
  const W = WORLD.w;
  const H = WORLD.h;
  const pad = 6;

  // 玩家离最近墙的距离 → 决定预警强度
  let near = Infinity;
  if (player && player.alive && player.body.length) {
    const h = player.body[0];
    near = Math.min(h.x, W - h.x, h.y, H - h.y);
  }
  const danger = clamp(1 - near / 320, 0, 1);
  const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 140);

  ctx.save();
  ctx.strokeStyle = `rgba(255,60,110,${0.35 + danger * 0.55 * pulse})`;
  ctx.lineWidth = 14;
  ctx.shadowColor = 'rgba(255,40,90,0.9)';
  ctx.shadowBlur = 40;

  // 逐边判断是否在视野内，只画看得到的
  if (view.x < pad + 40) {
    ctx.beginPath();
    ctx.moveTo(pad, Math.max(view.y, 0));
    ctx.lineTo(pad, Math.min(view.y + view.h, H));
    ctx.stroke();
  }
  if (view.x + view.w > W - pad - 40) {
    ctx.beginPath();
    ctx.moveTo(W - pad, Math.max(view.y, 0));
    ctx.lineTo(W - pad, Math.min(view.y + view.h, H));
    ctx.stroke();
  }
  if (view.y < pad + 40) {
    ctx.beginPath();
    ctx.moveTo(Math.max(view.x, 0), pad);
    ctx.lineTo(Math.min(view.x + view.w, W), pad);
    ctx.stroke();
  }
  if (view.y + view.h > H - pad - 40) {
    ctx.beginPath();
    ctx.moveTo(Math.max(view.x, 0), H - pad);
    ctx.lineTo(Math.min(view.x + view.w, W), H - pad);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 食物：Q 版小怪，有表情、会呼吸
 * 散落的食物（蛇尸体变的）多一圈细边，便于识别来源
 */
export function drawFood(ctx, food, time, detail = true) {
  const bob = Math.sin(time * 3.2 + food.seed) * 3.5;
  const beat = Math.sin(time * 6.5 + food.seed);
  const sx = 1 + beat * 0.06;
  const sy = 1 - beat * 0.06;

  ctx.save();
  ctx.translate(food.x, food.y + bob);
  ctx.scale(sx, sy);

  const r = food.r;

  // 外发光（远景食物省掉，省性能）
  if (detail) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.4);
    glow.addColorStop(0, hexToRgba(food.color, food.big ? 0.45 : 0.3));
    glow.addColorStop(1, hexToRgba(food.color, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(-r * 2.4, -r * 2.4, r * 4.8, r * 4.8);
    ctx.restore();
  }

  // 果冻本体
  const body = ctx.createRadialGradient(-r * 0.32, -r * 0.4, r * 0.15, 0, 0, r);
  body.addColorStop(0, lighten(food.color, 0.5));
  body.addColorStop(0.55, food.color);
  body.addColorStop(1, darken(food.color, 0.3));
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();

  // 描边
  ctx.strokeStyle = 'rgba(28,10,42,0.5)';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  if (detail) {
    // 顶部高光
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.34, -r * 0.42, r * 0.24, r * 0.15, -0.6, 0, TAU);
    ctx.fill();

    // 金果皇冠
    if (food.big) {
      ctx.save();
      ctx.translate(0, -r * 0.95);
      ctx.rotate(Math.sin(time * 4 + food.seed) * 0.12);
      ctx.fillStyle = '#FFE066';
      ctx.strokeStyle = 'rgba(90,50,0,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, 0);
      ctx.lineTo(-r * 0.5, -r * 0.42);
      ctx.lineTo(-r * 0.18, -r * 0.14);
      ctx.lineTo(0, -r * 0.56);
      ctx.lineTo(r * 0.18, -r * 0.14);
      ctx.lineTo(r * 0.5, -r * 0.42);
      ctx.lineTo(r * 0.5, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    drawFoodFace(ctx, food, r, time);
  } else {
    // 远景只用两个小点表示眼睛，够读就行
    ctx.fillStyle = 'rgba(27,10,42,0.8)';
    ctx.beginPath();
    ctx.arc(-r * 0.3, -r * 0.05, r * 0.16, 0, TAU);
    ctx.arc(r * 0.3, -r * 0.05, r * 0.16, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}

/** 食物表情 */
function drawFoodFace(ctx, food, r, time) {
  const blinkCycle = (time * 0.9 + food.seed) % 3.2;
  const blinking = blinkCycle > 3.0;
  const eyeY = -r * 0.05;
  const eyeX = r * 0.34;
  const eyeR = r * 0.25;

  ctx.save();

  const drawEye = (x, mirror) => {
    if (blinking || mirror) {
      ctx.save();
      ctx.strokeStyle = '#1B0A2A';
      ctx.lineWidth = r * 0.09;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(x, eyeY + r * 0.05, eyeR * 0.78, Math.PI * 1.12, Math.PI * 1.88);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.ellipse(x, eyeY, eyeR * 0.92, eyeR, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#1B0A2A';
    ctx.beginPath();
    ctx.arc(x + eyeR * 0.12, eyeY + r * 0.03, eyeR * 0.55, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(x + eyeR * 0.3, eyeY - eyeR * 0.28, eyeR * 0.2, 0, TAU);
    ctx.fill();
  };

  switch (food.face) {
    case 'wink':
      drawEye(-eyeX, false);
      drawEye(eyeX, true);
      break;
    case 'sleepy':
      drawEye(-eyeX, true);
      drawEye(eyeX, true);
      break;
    default:
      drawEye(-eyeX, false);
      drawEye(eyeX, false);
      break;
  }

  // 嘴
  ctx.strokeStyle = '#1B0A2A';
  ctx.lineWidth = r * 0.09;
  ctx.lineCap = 'round';
  const mouthY = r * 0.44;
  const wob = Math.sin(time * 7 + food.seed) * r * 0.05;

  if (food.face === 'wide') {
    ctx.fillStyle = '#3A0A20';
    ctx.beginPath();
    ctx.ellipse(0, mouthY + wob * 0.5, r * 0.34, r * 0.26, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#FF6B8A';
    ctx.beginPath();
    ctx.ellipse(0, mouthY + r * 0.14, r * 0.2, r * 0.11, 0, 0, TAU);
    ctx.fill();
  } else if (food.face === 'tongue') {
    ctx.beginPath();
    ctx.arc(0, mouthY - r * 0.08, r * 0.3, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = '#FF5C8A';
    ctx.beginPath();
    ctx.ellipse(wob * 2, mouthY + r * 0.12, r * 0.16, r * 0.2, 0, 0, TAU);
    ctx.fill();
  } else if (food.face === 'happy') {
    ctx.beginPath();
    ctx.arc(0, mouthY - r * 0.1, r * 0.32, 0.12 * Math.PI, 0.88 * Math.PI);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(-r * 0.22, mouthY);
    ctx.quadraticCurveTo(-r * 0.08, mouthY - r * 0.12 + wob, 0, mouthY);
    ctx.quadraticCurveTo(r * 0.08, mouthY + r * 0.12 + wob, r * 0.22, mouthY);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * 道具：会呼吸的圆形徽章 + 旋转虚线环 + 图标 + 中文标签
 * 加速 = 黄色闪电，磁铁 = 蓝身红头的 U 形磁铁。
 * 画在蛇之上，保证快被拾取时不会被身体挡住。
 */
export function drawPowerup(ctx, p, time) {
  const r = p.r;
  const bob = Math.sin(time * 2.6 + p.seed) * 4;

  ctx.save();
  ctx.translate(p.x, p.y + bob);

  // ---- 外发光 ----
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const glow = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 2.6);
  glow.addColorStop(0, hexToRgba(p.color, 0.45));
  glow.addColorStop(1, hexToRgba(p.color, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(-r * 2.6, -r * 2.6, r * 5.2, r * 5.2);
  ctx.restore();

  // ---- 旋转虚线环 ----
  ctx.save();
  ctx.rotate(time * 0.9 + p.seed);
  ctx.strokeStyle = hexToRgba(p.color, 0.8);
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.35, 0, TAU);
  ctx.stroke();
  ctx.restore();

  // ---- 深色底盘 ----
  ctx.fillStyle = '#1B1030';
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  ctx.stroke();

  if (p.type === 'boost') {
    // 闪电：一个折角多边形，卡通感靠硬边 + 深色描边
    ctx.beginPath();
    ctx.moveTo(-r * 0.10, -r * 0.78);
    ctx.lineTo(r * 0.48, -r * 0.78);
    ctx.lineTo(r * 0.08, -r * 0.06);
    ctx.lineTo(r * 0.42, -r * 0.06);
    ctx.lineTo(-r * 0.36, r * 0.82);
    ctx.lineTo(-r * 0.06, r * 0.12);
    ctx.lineTo(-r * 0.42, r * 0.12);
    ctx.closePath();
    ctx.fillStyle = p.color;
    ctx.strokeStyle = 'rgba(60,30,0,0.7)';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  } else {
    // U 形磁铁：下半圆 + 两根红色极端
    ctx.lineCap = 'butt';
    ctx.lineWidth = r * 0.42;
    ctx.strokeStyle = p.color;
    ctx.beginPath();
    ctx.arc(0, -r * 0.05, r * 0.45, 0, Math.PI);
    ctx.stroke();
    ctx.strokeStyle = '#FF5C7A';
    ctx.beginPath();
    ctx.moveTo(r * 0.45, -r * 0.05);
    ctx.lineTo(r * 0.45, -r * 0.52);
    ctx.moveTo(-r * 0.45, -r * 0.05);
    ctx.lineTo(-r * 0.45, -r * 0.52);
    ctx.stroke();
  }

  // ---- 中文标签 ----
  ctx.font = '800 14px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(8,4,18,0.9)';
  ctx.strokeText(p.label, 0, r * 1.9);
  ctx.fillStyle = '#FFFDF0';
  ctx.fillText(p.label, 0, r * 1.9);

  ctx.restore();
}

/**
 * 画一条蛇
 * @param {import('./snake.js').Snake} snake
 * @param {number} time
 * @param {boolean} detail 是否画细节（玩家和近处 AI 才画）
 * @param {number} radius 指定粗细（px）。>0 时忽略节数曲线：
 *   结算舞台的「比高」蛇柱用它给每条蛇一个随屏宽变化的统一粗细，
 *   否则会按点列长度（≈ 身高 / 13）反推半径，长蛇粗到几乎挨在一起。
 */
export function drawSnake(ctx, snake, time, detail = true, radius = 0) {
  if (!snake.alive || snake.body.length < 2) return;

  const pts = snake.renderPoints();
  const n = pts.length;
  // 越长越粗：头和身体的半径都来自这一条曲线（头是 R × 1.12），
  // 与碰撞判定共用同一个 snakeRadius()，画面和手感不会脱节。
  const R = radius > 0 ? radius : snakeRadius(snake.body.length);
  const head = pts[0];
  const tail = pts[n - 1];

  // ---- 平滑路径 ----
  const path = new Path2D();
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < n - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) * 0.5;
    const my = (pts[i].y + pts[i + 1].y) * 0.5;
    path.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  path.lineTo(tail.x, tail.y);

  const col = snake.color;

  // ---- 1. 外层光晕 ----
  if (detail) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hexToRgba(col, 0.13);
    ctx.lineWidth = R * 2 + 30;
    ctx.stroke(path);
    ctx.restore();
  }

  // ---- 2. 深色描边（卡通硬边）----
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(6,30,34,0.5)';
  ctx.lineWidth = R * 2 + 5;
  ctx.stroke(path);
  ctx.restore();

  // ---- 3. 身体主体 ----
  const grad = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
  if (snake.grad) {
    // 真人玩家：四段渐变由 CONFIG.round.playerColors 给定。
    // 双人分屏时两条蛇必须一眼分得清，所以配色写在数据里而不是这里写死。
    grad.addColorStop(0, snake.grad[0]);
    grad.addColorStop(0.35, snake.grad[1]);
    grad.addColorStop(0.75, snake.grad[2]);
    grad.addColorStop(1, snake.grad[3]);
  } else if (snake.isPlayer) {
    // 兜底：没带 grad 的玩家蛇（例如旧结算舞台的假蛇）沿用绿→青→蓝
    grad.addColorStop(0, '#B6FF57');
    grad.addColorStop(0.35, '#5BEFA0');
    grad.addColorStop(0.75, '#2FD6C8');
    grad.addColorStop(1, '#1FA8D8');
  } else {
    grad.addColorStop(0, lighten(col, 0.3));
    grad.addColorStop(0.5, col);
    grad.addColorStop(1, darken(col, 0.28));
  }

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (detail) {
    ctx.shadowColor = hexToRgba(col, 0.65);
    ctx.shadowBlur = 26;
  }
  ctx.strokeStyle = grad;
  ctx.lineWidth = R * 2;
  ctx.stroke(path);
  ctx.restore();

  // ---- 4. 顶部高光 ----
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.translate(0, -R * 0.36);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = R * 0.6;
  ctx.stroke(path);
  ctx.restore();

  // ---- 5. 吃到时的亮度脉冲 ----
  for (let i = 1; i < n; i++) {
    const p = snake.pulse[i];
    if (!p || p < 0.04) continue;
    const a = Math.min(0.85, p);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,235,${a * 0.7})`;
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, R * (0.55 + a * 0.5), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // ---- 6. 背脊鳞纹（只给玩家和近处 AI）----
  if (detail) {
    ctx.save();
    for (let i = 3; i < n - 1; i += 2) {
      const t = pts[i].t;
      const fade = Math.sin(t * Math.PI * 0.9);
      if (fade <= 0.06) continue;
      const a = pts[i - 1];
      const b = pts[i + 1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const glow = Math.min(0.9, 0.16 + snake.pulse[i] * 0.85);
      ctx.save();
      ctx.translate(pts[i].x, pts[i].y);
      ctx.rotate(ang);
      ctx.strokeStyle = `rgba(235,255,225,${(0.16 + glow * 0.2) * fade})`;
      ctx.lineWidth = R * 0.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.55, -Math.PI * 0.6, Math.PI * 0.6);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // ---- 7. 头 ----
  drawSnakeHead(ctx, head, snake, time, R, detail);

  // ---- 8. 无敌状态闪烁环 ----
  if (snake.isImmune()) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 10]);
    ctx.lineDashOffset = -performance.now() / 40;
    ctx.beginPath();
    ctx.arc(head.x, head.y, R * 1.9, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // ---- 8.5 AI 走神失误标记 ----
  // 头顶一个黄色 "?" 气泡，让玩家直观看到「这只 AI 刚才失误了」，
  // 也方便确认难度 / 失误频率滑块确实生效。只给近处的蛇画，远处简化画法不增加开销。
  if (!snake.isPlayer && snake.mistake && !snake.isFrozen() && detail) {
    const bob = Math.sin(performance.now() / 120) * 3;
    const bx = head.x + R * 1.5;
    const by = head.y - R * 2.1 + bob;
    ctx.save();
    ctx.fillStyle = 'rgba(255,214,80,0.95)';
    ctx.strokeStyle = 'rgba(70,40,0,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bx, by, 13, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#3A2100';
    ctx.font = '800 18px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', bx, by + 1);
    ctx.restore();
  }

  // ---- 9. 静止保护期：只给玩家画亮环 + 待命文字 ----
  // 蛇一动不动容易被误认为"卡住了"，这里明确告诉玩家这是短暂的无敌待命，
  // 并且现在就可以摆方向，时间一到就朝这个方向出发。
  if (snake.isPlayer && snake.isFrozen()) {
    const left = Math.max(0, (snake.freezeUntil - performance.now()) / 1000);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(182,255,87,0.9)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(head.x, head.y, R * 2.4 + Math.sin(performance.now() / 90) * 3, 0, TAU);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.font = '800 20px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(8,4,18,0.85)';
    const label = `待命 ${left.toFixed(1)}s · 给方向`;
    // 放到蛇头下方：开局「GO!」、复活「复活」、击杀飘字都在头上方 y-60~-90，
    // 放上面会直接叠字（实测 63-freeze-hold.png 里 GO! 和待命糊成一团）。
    const labelY = head.y + R * 3.5;
    ctx.strokeText(label, head.x, labelY);
    ctx.fillStyle = '#EAFFC9';
    ctx.fillText(label, head.x, labelY);
    ctx.restore();
  }

  // ---- 10. 道具增益：范围圈 / 发光 / 剩余时间 ----
  const PU = CONFIG.powerups;
  const boostLeft = snake.buffLeft('boost');
  const magnetLeft = snake.buffLeft('magnet');

  if (magnetLeft > 0) {
    // 吸附范围要看得见，否则玩家不知道"多近算附近"。
    // 用很淡的加色渐变 + 缓慢转动的虚线，不抢蛇和食物的视觉。
    const mr = PU.magnet.radius;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // 末端必须回到透明：否则 fillRect 的方形边界会因为渐变延伸
    // 而留下一道明显的矩形亮边（实测 68-powerups-active.png 里可见）。
    const ring = ctx.createRadialGradient(head.x, head.y, mr * 0.35, head.x, head.y, mr);
    ring.addColorStop(0, hexToRgba(PU.magnet.color, 0));
    ring.addColorStop(0.72, hexToRgba(PU.magnet.color, 0.045));
    ring.addColorStop(1, hexToRgba(PU.magnet.color, 0));
    ctx.fillStyle = ring;
    ctx.fillRect(head.x - mr, head.y - mr, mr * 2, mr * 2);
    ctx.strokeStyle = hexToRgba(PU.magnet.color, 0.30);
    ctx.lineWidth = 3;
    ctx.setLineDash([16, 18]);
    ctx.lineDashOffset = -performance.now() / 60;
    ctx.beginPath();
    ctx.arc(head.x, head.y, mr, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  if (boostLeft > 0) {
    // 沿整条蛇身叠一层呼吸的橙色加色光晕（复用前面算好的平滑路径）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = R * 2 + 20;
    ctx.strokeStyle = hexToRgba(PU.boost.color, 0.24 + 0.14 * Math.sin(performance.now() / 110));
    ctx.stroke(path);
    ctx.restore();
  }

  // 剩余时间只给玩家标在蛇头上；HUD 右侧也有更清楚的进度条。
  // 待命文字在蛇头下方、飘字在更上方，所以这里放 -R*3.0 不会叠字。
  if (snake.isPlayer && (boostLeft > 0 || magnetLeft > 0)) {
    const parts = [];
    if (boostLeft > 0) parts.push(`加速 ${boostLeft.toFixed(1)}s`);
    if (magnetLeft > 0) parts.push(`磁铁 ${magnetLeft.toFixed(1)}s`);
    const label = parts.join(' · ');
    ctx.save();
    ctx.font = '800 17px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(8,4,18,0.9)';
    const ly = head.y - R * 3.0;
    ctx.strokeText(label, head.x, ly);
    ctx.fillStyle = '#FFF6C2';
    ctx.fillText(label, head.x, ly);
    ctx.restore();
  }
}

/** 蛇头：大眼睛 + 盯食物 + 张嘴吐信 */
function drawSnakeHead(ctx, head, snake, time, R, detail) {
  // ---- 造型分派（AI 专用）----
  // 本局分配到造型的 AI，整颗头交给 js/heads.js 画：轮廓、眼、嘴全由造型决定。
  // 玩家永远走下面原版逻辑（跟着食物转的眼睛 + 周期性吐信 + 张嘴）。
  // 远处 detail=false 也照样画造型，只是故障款少切几条 —— 否则头型会随
  // 距离在「造型」和「原版」之间突变，看着像 bug。
  if (!snake.isPlayer && snake.headStyle) {
    const drawn = drawNpcHead(
      ctx, head, snake.headStyle, snake.heading, R * 1.12, time,
      lighten(snake.color, 0.26), detail
    );
    if (drawn) {
      if (detail) drawSnakeNameLabel(ctx, snake, head, R);
      return;
    }
    // key 无效（配置被改坏 / 池子里写了不存在的名字）→ 回退到原版头，
    // 绝不出现「有蛇但没头」的空洞。
  }

  const f = snake.lookAt;
  let lookX = 0;
  let lookY = 0;
  if (f) {
    lookX = f.x - head.x;
    lookY = f.y - head.y;
    const l = Math.hypot(lookX, lookY) || 1;
    lookX /= l;
    lookY /= l;
  } else {
    lookX = Math.cos(snake.heading);
    lookY = Math.sin(snake.heading);
  }

  const open = clamp((snake.pulse[0] || 0) * 1.1, 0, 1);

  ctx.save();
  ctx.translate(head.x, head.y);
  ctx.rotate(snake.heading);

  const hr = R * 1.12;
  const base = snake.headColor || (snake.isPlayer ? '#B6FF57' : lighten(snake.color, 0.26));

  // ---- 头部主体 ----
  ctx.fillStyle = base;
  ctx.strokeStyle = 'rgba(10,40,30,0.45)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(hr * 0.06, 0, hr * 1.06, hr * 1.0, 0, 0, TAU);
  ctx.fill();
  ctx.stroke();

  // 头顶高光
  const hgl = ctx.createRadialGradient(-hr * 0.2, -hr * 0.5, hr * 0.1, 0, 0, hr * 1.1);
  hgl.addColorStop(0, 'rgba(255,255,255,0.5)');
  hgl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hgl;
  ctx.beginPath();
  ctx.ellipse(0, 0, hr * 1.02, hr * 0.96, 0, 0, TAU);
  ctx.fill();

  // 舌头
  const tongueCycle = (time % 1.8) / 1.8;
  if (tongueCycle < 0.28 || open > 0.1) {
    const et = tongueCycle < 0.28 ? Math.sin((tongueCycle / 0.28) * Math.PI) : 0;
    const len = hr * (0.55 + et * 0.75 + open * 0.5);
    ctx.save();
    ctx.strokeStyle = '#FF3D6E';
    ctx.lineWidth = 4.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hr * 0.85, 0);
    ctx.lineTo(hr * 0.85 + len * 0.7, 0);
    ctx.stroke();
    const bx = hr * 0.85 + len * 0.7;
    ctx.beginPath();
    ctx.moveTo(bx, 0);
    ctx.lineTo(bx + len * 0.32, -len * 0.22);
    ctx.moveTo(bx, 0);
    ctx.lineTo(bx + len * 0.32, len * 0.22);
    ctx.stroke();
    ctx.restore();
  }

  // ---- 眼睛 ----
  const eyeFwd = hr * 0.32;
  const eyeSide = hr * 0.52;
  const eyeR = hr * 0.34;
  const local = Math.atan2(lookY, lookX) - snake.heading;

  for (const s of [-1, 1]) {
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = 'rgba(10,40,30,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(eyeFwd, s * eyeSide, eyeR * 0.95, eyeR, 0, 0, TAU);
    ctx.fill();
    ctx.stroke();

    const ox = Math.cos(local) * eyeR * 0.34;
    const oy = Math.sin(local) * eyeR * 0.34;
    ctx.fillStyle = '#14210F';
    ctx.beginPath();
    ctx.ellipse(eyeFwd + ox + eyeR * 0.1, s * eyeSide + oy * 0.9, eyeR * 0.55, eyeR * 0.62, 0, 0, TAU);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    ctx.arc(eyeFwd + ox + eyeR * 0.28, s * eyeSide + oy * 0.9 - eyeR * 0.28, eyeR * 0.19, 0, TAU);
    ctx.fill();

    // 张嘴时眯眼
    if (open > 0.3) {
      ctx.fillStyle = hexToRgba(base, clamp((open - 0.3) * 1.6, 0, 0.9));
      ctx.beginPath();
      ctx.ellipse(eyeFwd, s * eyeSide, eyeR * 1.05, eyeR * 1.1, 0, 0, TAU);
      ctx.fill();
    }
  }

  // ---- 嘴 ----
  ctx.strokeStyle = 'rgba(12,60,36,0.85)';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  if (open > 0.12) {
    ctx.fillStyle = '#3B0F22';
    ctx.beginPath();
    ctx.ellipse(hr * 0.78, 0, hr * 0.24, hr * (0.16 + open * 0.3), 0, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#FF6B8A';
    ctx.beginPath();
    ctx.ellipse(hr * 0.82, 0, hr * 0.12, hr * (0.06 + open * 0.14), 0, 0, TAU);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(hr * 0.42, 0, hr * 0.42, -0.55, 0.55);
    ctx.stroke();
  }

  ctx.restore();

  // ---- 名字标签（AI 才显示，方便分辨）----
  if (detail && !snake.isPlayer) drawSnakeNameLabel(ctx, snake, head, R);
}

/**
 * AI 蛇头顶上的名字 + 本局风格
 * ------------------------------------------------------------
 * 用世界坐标直接画（调用前不能有 translate / rotate 残留）。
 * 造型头和原版头共用同一份实现，位置口径不会分叉。
 */
function drawSnakeNameLabel(ctx, snake, head, R) {
  ctx.save();
  ctx.font = '700 15px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(8,4,18,0.85)';
  // 名字后面挂上本局随机分配的风格，玩家在场上就能看出谁好斗、谁畏强
  const label = snake.name + (snake.style ? ' · ' + snake.style.label : '');
  const ly = head.y - R * 2.1;
  ctx.strokeText(label, head.x, ly);
  ctx.fillStyle = hexToRgba(snake.color, 0.95);
  ctx.fillText(label, head.x, ly);
  ctx.restore();
}

/**
 * 小地图（屏幕坐标，调用前 ctx 应已按设备像素比缩放，这里用 CSS 像素）
 * 大地图必须有小地图，否则找不到食物和对手
 */
export function drawMinimap(ctx, game, cssW, cssH, view) {
  const W = 208;
  const H = Math.round(W * (WORLD.h / WORLD.w));
  const x = 22;
  const y = cssH - H - 30;

  const scale = W / WORLD.w;

  ctx.save();
  ctx.translate(x, y);

  // 底板
  // 小地图底板与网格跟着界面层换成深蓝黑 + 电光青，蛇 / 食物点保持原色
  ctx.fillStyle = 'rgba(5,12,24,0.84)';
  roundRect(ctx, -6, -6, W + 12, H + 12, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(86,232,255,0.32)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 世界底图
  ctx.fillStyle = 'rgba(8,22,40,0.86)';
  ctx.fillRect(0, 0, W, H);

  // 分屏网格
  ctx.strokeStyle = 'rgba(86,232,255,0.13)';
  for (let i = 1; i < CONFIG.world.tilesX; i++) {
    const px = (i * CONFIG.world.tileW) * scale;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();
  }
  for (let j = 1; j < CONFIG.world.tilesY; j++) {
    const py = (j * CONFIG.world.tileH) * scale;
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(W, py);
    ctx.stroke();
  }

  // 食物（抽稀，避免 260 个点糊成一片）
  ctx.fillStyle = 'rgba(255,220,140,0.5)';
  for (let i = 0; i < game.foods.length; i += 2) {
    const f = game.foods[i];
    ctx.fillRect(f.x * scale - 0.7, f.y * scale - 0.7, 1.6, 1.6);
  }

  // 道具：比食物大一点的彩色方块，方便在小地图里找
  for (const p of (game.powerups || [])) {
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x * scale - 1.7, p.y * scale - 1.7, 3.4, 3.4);
  }

  // 蛇
  for (const s of game.snakes) {
    if (!s.alive || s.body.length === 0) continue;
    const h = s.body[0];
    const px = h.x * scale;
    const py = h.y * scale;

    if (s.isPlayer) {
      // 玩家：白绿大点 + 呼吸圈
      const r = 3.4 + Math.sin(performance.now() / 260) * 0.7;
      ctx.fillStyle = '#EAFFC9';
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(182,255,87,0.85)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(px, py, r + 3, 0, TAU);
      ctx.stroke();
    } else {
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, TAU);
      ctx.fill();
    }
  }

  // 当前视野框
  if (view) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(view.x * scale, view.y * scale, view.w * scale, view.h * scale);
  }

  // 标题
  ctx.font = '600 10px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = 'rgba(150,210,235,0.65)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${CONFIG.world.tilesX}×${CONFIG.world.tilesY} 地图`, 0, -10);

  ctx.restore();
}

/**
 * 战场带边缘反馈：四角取景框 + 四边暗角 + 缓慢呼吸的顶部光带。
 * 这属于「画面」而不是「界面信息」，画在 canvas 的屏幕空间里，
 * 因此不破坏「界面带 / 战场带分离」：DOM 层一个浮层都没有。
 * @param {CanvasRenderingContext2D} ctx 已 setTransform(dpr,...)，坐标为 CSS 像素
 * @param {number} w 战场宽（CSS px）
 * @param {number} h 战场高（CSS px）
 * @param {number} t 累计时间（秒），用于呼吸
 * @param {number} energy 0/1：吃到加速或磁铁时边缘转绿并变亮
 */
export function drawArenaOverlay(ctx, w, h, t, energy = 0) {
  const rgb = energy ? '182,255,87' : '86,232,255';
  const breathe = 0.5 + 0.5 * Math.sin(t * 1.7);
  const edge = Math.min(96, Math.max(48, h * 0.11)) + energy * 24;

  ctx.save();

  // 四条线性渐变只压边缘，中心战场保持通透
  const bands = [
    { g: ctx.createLinearGradient(0, 0, 0, edge), r: [0, 0, w, edge] },
    { g: ctx.createLinearGradient(0, h, 0, h - edge), r: [0, h - edge, w, edge] },
    { g: ctx.createLinearGradient(0, 0, edge, 0), r: [0, 0, edge, h] },
    { g: ctx.createLinearGradient(w, 0, w - edge, 0), r: [w - edge, 0, edge, h] }
  ];
  for (const b of bands) {
    b.g.addColorStop(0, 'rgba(2,6,14,0.66)');
    b.g.addColorStop(1, 'rgba(2,6,14,0)');
    ctx.fillStyle = b.g;
    ctx.fillRect(b.r[0], b.r[1], b.r[2], b.r[3]);
  }

  // 顶部一道细光带，与上方界面带的能量线呼应
  ctx.fillStyle = `rgba(${rgb},${(0.10 + 0.12 * breathe + energy * 0.18).toFixed(3)})`;
  ctx.fillRect(0, 0, w, 2);

  // 四角 L 形取景框：主机 / 竞技场质感，不含任何文字信息
  const len = 34;
  const pad = 16;
  ctx.strokeStyle = `rgba(${rgb},${(0.30 + 0.26 * breathe + energy * 0.20).toFixed(3)})`;
  ctx.lineWidth = 3;
  ctx.lineCap = 'square';
  ctx.beginPath();
  ctx.moveTo(pad, pad + len); ctx.lineTo(pad, pad); ctx.lineTo(pad + len, pad);
  ctx.moveTo(w - pad - len, pad); ctx.lineTo(w - pad, pad); ctx.lineTo(w - pad, pad + len);
  ctx.moveTo(w - pad, h - pad - len); ctx.lineTo(w - pad, h - pad); ctx.lineTo(w - pad - len, h - pad);
  ctx.moveTo(pad + len, h - pad); ctx.lineTo(pad, h - pad); ctx.lineTo(pad, h - pad - len);
  ctx.stroke();

  ctx.restore();
}
