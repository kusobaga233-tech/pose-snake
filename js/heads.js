/**
 * NPC 蛇头造型库
 * ============================================================
 * 玩家蛇头仍由 render.js 的 drawSnakeHead 画（原版：跟着食物转的眼睛、
 * 周期性吐信、张嘴）。这里只负责 AI 的「造型」——让 7 条 NPC 一局里
 * 各长一张脸，靠脸认人，而不是只能看颜色。
 *
 * 坐标约定（很重要）：
 *   每个造型函数都按「头半径 = 50 的基准坐标」绘制，原点在头心、朝 +x。
 *   drawNpcHead() 里用 ctx.scale(hr / 50, hr / 50) 统一缩放，
 *   所以造型里的数值就是设计稿上的数值，改比例不用动这里。
 *   —— 这样从 preview/heads.js 移植过来几乎零改动，也不会出现
 *   「大头线条过细 / 小头线条过粗」的问题（线宽同样被缩放）。
 *
 * 俯视角的三条硬约束（决定了造型能怎么设计）：
 *   1. 眼睛只能长在头的两侧（±y），不能像正面像那样并排放在脸上；
 *   2. 嘴在正前方（+x），「上下颚」在画面上其实是左右两侧的颚；
 *   3. 角、刺、耳朵这类朝「上」的东西看不见，只能往侧面和后方伸。
 *
 * 当前启用 9 款（用户两批筛选后的结果）：
 *   搞笑 googly 斗鸡眼 / bucktooth 大板牙 / moustache 小胡子 / shocked 震惊
 *   抽象 glitch 故障 / lowpoly 几何 / pixel 像素 / neon 霓虹 / block 方头
 * 已被否决、不再使用的：歪舌 / 多眼怪 / 爆眼 / 暴怒 / 棘冠 / 骨面 / 恶魔 /
 *   困倦 / 独眼海盗 / 晕眩 / 剪影 / 阴险 / 冷面 / 疫医 / 眼镜蛇。
 */

const HD_TAU = Math.PI * 2;

/** 造型的基准头半径：所有造型内部都按这个尺寸写死数值 */
export const HEAD_BASE_R = 50;

// ============================================================
// 颜色工具（要同时吃得下 '#RRGGBB' 和 'rgb(r,g,b)'）
// 游戏里 AI 头色是 lighten(snake.color, 0.26)，返回的是 rgb() 字符串，
// 所以不能直接用 utils.js 里只认 hex 的 hexToRgba。
// ============================================================

/** 任意颜色字符串 → [r, g, b] */
function hdParseColor(c) {
  if (c[0] === '#') {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = String(c).match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
  if (!m) return [180, 220, 200];
  return [Number(m[1]) | 0, Number(m[2]) | 0, Number(m[3]) | 0];
}

/** 调亮 / 调暗：amt > 0 向白色靠，amt < 0 向黑色靠 */
function hdShade(c, amt) {
  const [r, g, b] = hdParseColor(c);
  const f = (v) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/** 同色 + 透明度 */
function hdWithA(c, a) {
  const [r, g, b] = hdParseColor(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** 圆角矩形路径（只建路径，调用方自己 fill / stroke） */
function hdRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 画一只眼睛：眼白椭圆 + 瞳孔椭圆 + 高光
 * 全部用椭圆表达，方便直接做「圆眼 / 眯眼 / 斜眼 / 竖瞳」各种变形。
 * @param {number} rot 整体旋转（做斜眼用）
 */
function hdDrawEye(ctx, x, y, rx, ry, rot, px, py, prx, pry, pupilColor = '#101A16') {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, HD_TAU);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = 'rgba(10,30,20,0.45)';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(x + px, y + py, prx, pry, rot, 0, HD_TAU);
  ctx.fillStyle = pupilColor;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x + px + prx * 0.38, y + py - pry * 0.42, Math.min(prx, pry) * 0.42, 0, HD_TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();
}

/**
 * 头部主体：椭圆 + 描边 + 一层顶部高光
 * @param {{rx?:number, ry?:number, ox?:number}} o 外形微调系数（相对 hr）
 */
function hdHeadShape(ctx, hr, color, o = {}) {
  const rx = hr * (o.rx ?? 1.06);
  const ry = hr * (o.ry ?? 1.0);
  const ox = hr * (o.ox ?? 0.06);

  ctx.beginPath();
  ctx.ellipse(ox, 0, rx, ry, 0, 0, HD_TAU);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(6,20,14,0.5)';
  ctx.lineWidth = 3.5;
  ctx.stroke();

  const g = ctx.createRadialGradient(-hr * 0.3, -hr * 0.55, hr * 0.08, 0, 0, hr * 1.2);
  g.addColorStop(0, 'rgba(255,255,255,0.48)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(ox, 0, rx * 0.96, ry * 0.96, 0, 0, HD_TAU);
  ctx.fill();
}

// ============================================================
// 造型实现
// 统一签名 (ctx, hr, t, color, dyn)
//   hr    = 50（基准半径）
//   t     = 累计时间（秒），驱动各自的固有动画
//   color = 本蛇头色（已提亮）
//   dyn   = { detail:boolean, k:number }  detail=false 时少画几层，k = 实际 hr/50
// 注意：这些造型不跟随 lookAt（不盯着食物），它们靠自身动画保持生动；
// 玩家蛇头仍有完整的跟随 / 吐信 / 张嘴反馈，两套观感并存不冲突。
// ============================================================
export const HEAD_STYLES = {
  // ---------------- 搞笑 ----------------

  /** 斗鸡眼：两只眼白挤在一起，瞳孔各自往中间怼 */
  googly(ctx, hr, t, color) {
    hdHeadShape(ctx, hr, color);

    // 小波浪嘴
    ctx.strokeStyle = 'rgba(12,45,30,0.8)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hr * 0.64, -hr * 0.24);
    ctx.quadraticCurveTo(hr * 0.76, -hr * 0.06, hr * 0.88, -hr * 0.22);
    ctx.quadraticCurveTo(hr * 0.99, -hr * 0.36, hr * 1.08, -hr * 0.18);
    ctx.stroke();

    // 两只大眼几乎贴在一起，瞳孔向内侧偏，还各晃各的
    for (const s of [-1, 1]) {
      const ex = hr * 0.40;
      const ey = s * hr * 0.32;
      const wob = Math.sin(t * 4.4 + (s > 0 ? 0 : 2.1)) * hr * 0.06;
      hdDrawEye(ctx, ex, ey, hr * 0.40, hr * 0.40, 0,
        -hr * 0.12, -s * hr * 0.14 + wob, hr * 0.17, hr * 0.18);
    }
  },

  /** 大板牙：眯眼笑 + 两片门板牙从两侧颚顶到最前 */
  bucktooth(ctx, hr, t, color) {
    hdHeadShape(ctx, hr, color);

    // 腮红
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(-hr * 0.10, s * hr * 0.66, hr * 0.22, hr * 0.14, 0, 0, HD_TAU);
      ctx.fillStyle = 'rgba(255,120,160,0.30)';
      ctx.fill();
    }

    // 笑眼：两侧各一条上凸弧
    ctx.strokeStyle = '#132A1C';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      const ex = hr * 0.34;
      const ey = s * hr * 0.44;
      ctx.beginPath();
      ctx.moveTo(ex - hr * 0.20, ey + s * hr * 0.06);
      ctx.quadraticCurveTo(ex, ey - s * hr * 0.22, ex + hr * 0.20, ey + s * hr * 0.06);
      ctx.stroke();
    }

    // 咧开的嘴（口腔）
    ctx.beginPath();
    ctx.moveTo(hr * 0.46, -hr * 0.40);
    ctx.quadraticCurveTo(hr * 1.14, 0, hr * 0.46, hr * 0.40);
    ctx.quadraticCurveTo(hr * 0.82, 0, hr * 0.46, -hr * 0.40);
    ctx.closePath();
    ctx.fillStyle = '#4A0E22';
    ctx.fill();
    ctx.strokeStyle = 'rgba(12,40,25,0.8)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 两片大板牙：并排在正前方，中间留一条缝，明显超出头部轮廓
    for (const s of [-1, 1]) {
      const y0 = s > 0 ? hr * 0.03 : -hr * 0.31;
      hdRoundRect(ctx, hr * 0.58, y0, hr * 0.58, hr * 0.28, hr * 0.09);
      ctx.fillStyle = '#FFFDF0';
      ctx.fill();
      ctx.strokeStyle = 'rgba(30,55,40,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  },

  /** 小胡子 + 香肠嘴：一本正经的滑稽 */
  moustache(ctx, hr, t, color) {
    hdHeadShape(ctx, hr, color);

    // 小圆眼 + 高挑眉
    for (const s of [-1, 1]) {
      hdDrawEye(ctx, hr * 0.20, s * hr * 0.44, hr * 0.20, hr * 0.22, 0,
        hr * 0.07, s * hr * 0.02, hr * 0.10, hr * 0.11);
      ctx.strokeStyle = '#241A12';
      ctx.lineWidth = 5.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(hr * 0.02, s * hr * 0.68);
      ctx.quadraticCurveTo(hr * 0.26, s * hr * 0.84, hr * 0.44, s * hr * 0.62);
      ctx.stroke();
    }

    // 八字胡：从唇边往斜后方掠，末端收在眼睛外面，别盖住眼
    ctx.fillStyle = '#2B1C14';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(hr * 0.96, s * hr * 0.06);
      ctx.quadraticCurveTo(hr * 0.94, s * hr * 0.54, hr * 0.40, s * hr * 0.80);
      ctx.quadraticCurveTo(hr * 0.62, s * hr * 0.54, hr * 0.44, s * hr * 0.12);
      ctx.closePath();
      ctx.fill();
    }

    // 香肠嘴：正前方一个厚唇椭圆
    ctx.beginPath();
    ctx.ellipse(hr * 0.88, 0, hr * 0.18, hr * 0.28, 0, 0, HD_TAU);
    ctx.fillStyle = '#D6427A';
    ctx.fill();
    ctx.strokeStyle = 'rgba(90,15,45,0.75)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 唇缝
    ctx.beginPath();
    ctx.moveTo(hr * 0.74, 0);
    ctx.lineTo(hr * 1.03, 0);
    ctx.strokeStyle = 'rgba(90,15,45,0.6)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  },

  /** 震惊：瞳孔缩成小点，嘴张成 O 型，眉毛挑到最高 */
  shocked(ctx, hr, t, color) {
    hdHeadShape(ctx, hr, color);

    // 大眼白 + 极小瞳孔
    for (const s of [-1, 1]) {
      hdDrawEye(ctx, hr * 0.30, s * hr * 0.42, hr * 0.33, hr * 0.34, 0,
        hr * 0.05, 0, hr * 0.07, hr * 0.08);
    }

    // 高挑眉（挂在眼睛外侧，不能被眼盖住）
    ctx.strokeStyle = '#16281C';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(hr * 0.06, s * hr * 0.80);
      ctx.quadraticCurveTo(hr * 0.28, s * hr * 0.99, hr * 0.50, s * hr * 0.80);
      ctx.stroke();
    }

    // O 型嘴
    ctx.beginPath();
    ctx.ellipse(hr * 0.88, 0, hr * 0.15, hr * 0.18, 0, 0, HD_TAU);
    ctx.fillStyle = '#3B0F22';
    ctx.fill();
    ctx.strokeStyle = 'rgba(12,40,25,0.8)';
    ctx.lineWidth = 3;
    ctx.stroke();
  },

  // ---------------- 抽象 ----------------

  /** 故障：头部横切成条随机错位，青 / 品红只描边做色散 */
  glitch(ctx, hr, t, color, dyn) {
    const bands = dyn && dyn.detail === false ? 3 : 5;
    const top = -hr * 1.2;
    const bh = (hr * 2.4) / bands;

    // 一条横带里的完整造型（会被裁切）
    // fill 为空时只描边，用来做色散通道，不会把颜色糊成一团
    const paint = (c, fill, stroke, lw = 3) => {
      c.beginPath();
      c.ellipse(hr * 0.06, 0, hr * 1.04, hr * 0.98, 0, 0, HD_TAU);
      if (fill) {
        c.fillStyle = fill;
        c.fill();
      }
      if (stroke) {
        c.strokeStyle = stroke;
        c.lineWidth = lw;
        c.stroke();
      }
      // 方块眼
      for (const s of [-1, 1]) {
        c.fillStyle = '#FFFFFF';
        c.fillRect(hr * 0.16, s * hr * 0.46 - hr * 0.18, hr * 0.38, hr * 0.36);
        c.fillStyle = '#0B1013';
        c.fillRect(hr * 0.32, s * hr * 0.46 - hr * 0.09, hr * 0.18, hr * 0.18);
      }
      // 锯齿嘴
      c.beginPath();
      c.moveTo(hr * 0.70, -hr * 0.30);
      for (let i = 0; i < 3; i++) {
        c.lineTo(hr * (0.84 + i * 0.09), 0);
        c.lineTo(hr * (0.78 + i * 0.09), hr * 0.26);
      }
      c.strokeStyle = '#0B1013';
      c.lineWidth = 3.5;
      c.lineJoin = 'miter';
      c.stroke();
    };

    for (let i = 0; i < bands; i++) {
      const y0 = top + i * bh;
      const j = Math.sin(t * 6.5 + i * 2.1) * hr * 0.22;
      ctx.save();
      ctx.beginPath();
      ctx.rect(-hr * 2, y0, hr * 4.4, bh);
      ctx.clip();

      // 青色 / 品红只描边，错开画成两个通道
      ctx.save();
      ctx.translate(j - hr * 0.08, 0);
      paint(ctx, null, 'rgba(0,255,225,0.85)', 3);
      ctx.restore();

      ctx.save();
      ctx.translate(j + hr * 0.08, 0);
      paint(ctx, null, 'rgba(255,0,200,0.80)', 3);
      ctx.restore();

      ctx.save();
      ctx.translate(j, 0);
      paint(ctx, color, 'rgba(6,20,14,0.5)', 3);
      ctx.restore();

      ctx.restore();
    }

    // 几粒游离的像素
    for (let i = 0; i < 3; i++) {
      const px = hr * (0.55 + 0.45 * Math.sin(t * 3 + i * 1.7));
      const py = hr * (1.05 + 0.28 * Math.cos(t * 2 + i));
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = ['#00FFE1', '#FF00C8', '#FFF45C'][i % 3];
      ctx.fillRect(px, py, hr * 0.10, hr * 0.10);
    }
    ctx.globalAlpha = 1;
  },

  /** 几何：八边形头 + 菱形眼 + 折线嘴，全部硬边 */
  lowpoly(ctx, hr, t, color) {
    const N = 8;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * HD_TAU;
      const rr = 1.02 + (i % 2 ? 0.05 : -0.03);
      pts.push([Math.cos(a) * hr * 1.08 * rr, Math.sin(a) * hr * 1.0 * rr]);
    }
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < N; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(6,20,14,0.55)';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'miter';
    ctx.stroke();

    // 亮面 / 暗面两块三角
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(-hr, -hr);
    ctx.lineTo(hr * 1.3, -hr);
    ctx.lineTo(-hr, hr * 0.16);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hr * 1.3, hr * 0.28);
    ctx.lineTo(hr * 1.3, hr * 1.3);
    ctx.lineTo(hr * 0.05, hr * 1.3);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fill();
    ctx.restore();

    // 菱形眼
    for (const s of [-1, 1]) {
      const ex = hr * 0.28;
      const ey = s * hr * 0.44;
      const d = hr * 0.31;
      ctx.beginPath();
      ctx.moveTo(ex + d, ey);
      ctx.lineTo(ex, ey + d);
      ctx.lineTo(ex - d, ey);
      ctx.lineTo(ex, ey - d);
      ctx.closePath();
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,30,20,0.5)';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      const pd = hr * 0.16;
      ctx.beginPath();
      ctx.moveTo(ex + pd * 1.3, ey);
      ctx.lineTo(ex, ey + pd);
      ctx.lineTo(ex - pd * 0.4, ey);
      ctx.lineTo(ex, ey - pd);
      ctx.closePath();
      ctx.fillStyle = '#0B1013';
      ctx.fill();
    }

    // Z 字嘴
    ctx.beginPath();
    ctx.moveTo(hr * 0.70, -hr * 0.26);
    ctx.lineTo(hr * 0.92, 0);
    ctx.lineTo(hr * 0.70, hr * 0.26);
    ctx.strokeStyle = '#0B1013';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'miter';
    ctx.stroke();
  },

  /** 像素：整个头由方块拼成，边缘用深色格做描边 */
  pixel(ctx, hr, t, color) {
    const px = hr * 0.165;      // 一个像素格
    const dark = hdShade(color, -0.42);
    const ox = hr * 0.06;

    // 按椭圆范围逐格填方块，越靠边越暗
    for (let gy = -6; gy <= 6; gy++) {
      for (let gx = -6; gx <= 6; gx++) {
        const cx = ox + gx * px;
        const cy = gy * px;
        const d = Math.pow(cx / (hr * 1.02), 2) + Math.pow(cy / (hr * 0.98), 2);
        if (d > 1) continue;
        ctx.fillStyle = d > 0.55 ? dark : color;
        ctx.fillRect(cx - px * 0.52, cy - px * 0.52, px * 1.04, px * 1.04);
      }
    }

    // 方块眼：2×2 白 + 1×1 黑，中心对齐到像素网格（第 2 列 / 上下各 2 行）
    for (const s of [-1, 1]) {
      const bx = ox + px * 2;
      const by = s * px * 2;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(bx - px, by - px, px * 2, px * 2);
      ctx.fillStyle = '#0B1013';
      ctx.fillRect(bx, by, px, px);
    }

    // 嘴：中线上两格宽的深色块，放在眼睛前面
    ctx.fillStyle = '#0B1013';
    ctx.fillRect(ox + px * 3.5, -px * 0.5, px * 2, px * 1.02);
  },

  /** 霓虹：只画发光轮廓，内部压暗，像电子宠物 */
  neon(ctx, hr, t, color, dyn) {
    const pulse = 0.78 + 0.22 * Math.sin(t * 3);
    // shadowBlur 不受 CTM 缩放影响，得按实际尺寸补一个系数，
    // 否则小头上的辉光会糊成一团（基准 50 时系数为 1）。
    const k = (dyn && dyn.k) || 1;

    // 暗底 + 三层辉光描边
    // 底色用「本蛇色压深」而不是接近纯黑：纯黑在小尺寸 + 暗背景上会变成
    // 一个黑洞，玩家会以为是没画出来的 bug。压深的本蛇色既保留霓虹感，
    // 又能让人读出这是哪条蛇。
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(hr * 0.06, 0, hr * 1.04, hr * 0.98, 0, 0, HD_TAU);
    ctx.fillStyle = hdShade(color, -0.66);
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    for (const pair of [[16, 0.09], [8, 0.20], [3, 1.0]]) {
      ctx.strokeStyle = hdWithA(color, pair[1] * pulse);
      ctx.lineWidth = pair[0];
      ctx.stroke();
    }
    ctx.restore();

    // 发光眼（比设计稿略大：游戏里头只有 50~98px，太小就只剩两个点）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of [-1, 1]) {
      const ex = hr * 0.34;
      const ey = s * hr * 0.44;
      const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, hr * 0.40);
      g.addColorStop(0, 'rgba(255,255,255,0.98)');
      g.addColorStop(0.32, hdWithA(color, 0.9));
      g.addColorStop(1, hdWithA(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ex, ey, hr * 0.40, 0, HD_TAU);
      ctx.fill();
    }

    // 发光嘴线
    ctx.strokeStyle = hdWithA(color, 0.95);
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 14 * k;
    ctx.beginPath();
    ctx.moveTo(hr * 0.72, -hr * 0.20);
    ctx.lineTo(hr * 0.98, 0);
    ctx.lineTo(hr * 0.72, hr * 0.20);
    ctx.stroke();
    ctx.restore();
  },

  /** 方头：圆角方脑袋 + 两只小圆眼 + 一字嘴，极简 */
  block(ctx, hr, t, color) {
    // 方头
    hdRoundRect(ctx, -hr * 0.98, -hr * 0.92, hr * 2.10, hr * 1.84, hr * 0.46);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(6,20,14,0.5)';
    ctx.lineWidth = 3.5;
    ctx.stroke();

    // 上半部一块亮面
    ctx.save();
    hdRoundRect(ctx, -hr * 0.98, -hr * 0.92, hr * 2.10, hr * 1.84, hr * 0.46);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(-hr, -hr, hr * 2.2, hr * 0.72);
    ctx.restore();

    // 小圆眼
    for (const s of [-1, 1]) {
      hdDrawEye(ctx, hr * 0.30, s * hr * 0.44, hr * 0.26, hr * 0.28, 0,
        hr * 0.08, 0, hr * 0.11, hr * 0.12);
    }

    // 一字嘴
    ctx.beginPath();
    ctx.moveTo(hr * 0.62, 0);
    ctx.lineTo(hr * 0.96, 0);
    ctx.strokeStyle = 'rgba(12,40,25,0.8)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
};

/** 可分配的造型 key 列表（顺序固定，便于调试面板与统计复现） */
export const HEAD_KEYS = Object.keys(HEAD_STYLES);

/** 造型的中文名（HUD / 调试面板用） */
export const HEAD_NAMES = {
  googly: '斗鸡眼',
  bucktooth: '大板牙',
  moustache: '小胡子',
  shocked: '震惊',
  glitch: '故障',
  lowpoly: '几何',
  pixel: '像素',
  neon: '霓虹',
  block: '方头'
};

/**
 * 画一个 NPC 的造型头
 * @param {CanvasRenderingContext2D} ctx 已经处于世界坐标（相机变换已应用）
 * @param {{x:number,y:number}} head 头心世界坐标
 * @param {string} styleKey HEAD_STYLES 的 key
 * @param {number} heading 朝向（弧度）
 * @param {number} hr 头半径（像素，= R × 1.12）
 * @param {number} time 累计时间（秒）
 * @param {string} color 头色（已提亮）
 * @param {boolean} detail 是否高细节（远处简化时少画几层）
 * @returns {boolean} 是否真的画了（key 无效时返回 false，调用方回退到原版头）
 */
export function drawNpcHead(ctx, head, styleKey, heading, hr, time, color, detail = true) {
  const style = HEAD_STYLES[styleKey];
  if (!style) return false;

  const k = hr / HEAD_BASE_R;
  ctx.save();
  ctx.translate(head.x, head.y);
  ctx.rotate(heading);
  // 造型按基准坐标（hr = 50）写死数值，这里整体缩放；
  // 线宽、渐变半径会跟着一起缩，所以小头上不会出现粗黑边。
  ctx.scale(k, k);
  style(ctx, HEAD_BASE_R, time, color, { detail, k });
  ctx.restore();
  return true;
}
