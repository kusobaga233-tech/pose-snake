/**
 * 结算舞台：把「长度排名」演成一场比高
 * ------------------------------------------------------------
 * 时间到之后，8 位玩家（1 真人 + 7 AI）横向按名次排开，
 * 每条蛇从同一条地平线出发，按「结束瞬间的实际长度」等比例向上生长。
 * 高度 = 节数 × 每节像素，同一局里所有蛇共用同一把尺，名次一眼可见。
 *
 * 镜头：初始贴着地平线；当最高的蛇长到接近屏幕顶部时，
 * 相机开始跟着蛇头往上升，刻度线、视野节数、镜头高度同步变化，
 * 于是「不断突破屏幕高度」这件事本身变成可见的演出。
 *
 * 工程约束：
 *  1) 不消耗 Math.random()：AI 自撞率 32.9% 的 20 种子统计依赖固定随机流，
 *     结算演出若抢随机数会污染后续统计；星点与摆动全部用确定性正弦生成。
 *  2) 不修改 Game / Snake 实例：结算态世界已冻结，舞台用鸭子类型的「假蛇」
 *     复用 render.js 的 drawSnake，保证 Q 版卡通观感与局内完全一致。
 *  3) 生长进度用 0~1 的 progress 表示，窗口 resize 时只重算每节像素，
 *     不会因为换了屏幕尺寸而把已长好的蛇突然拉长或缩回。
 */

import { clamp } from './utils.js';
import { drawSnake } from './render.js';

/** 舞台演出参数（长度单位 px，时间单位 s） */
export const STAGE = {
  introSec: 0.45,        // 入场停顿：先看清 8 条蛇站在起跑线
  growSec: 4.6,          // 最长的一条长满所需时间
  pointGap: 13,          // 蛇身渲染点间距（越小越顺滑，越大越省）
  waveAmp: 8,            // S 形摆动幅度，让静止的比高也有活蛇感
  // 蛇身是连续路径，不是「一节一个圆点」，所以每节像素可以很小也不会断裂，
  // 它只决定总高度这把尺。
  // 下限只能留一个很小的兜底：一旦设大（早期是 6），长局（300 节以上）
  // 会被硬拉成 3~4 屏，镜头升得离谱，连冠军的头都追不上。
  minUnit: 1.2,
  maxUnit: 46,           // 短局的上限：全员都很短时不至于把画面撑炸
  // 冠军蛇的目标高度（屏高倍数）——1.55 屏即「突破屏幕」演出本身：
  // 最长的那条一定会长出屏幕，镜头随蛇头升高，刻度线滚动、顶部金闪。
  // （曾试过压到 0.70 屏让 8 条全部同框，但那等于把这段演出整个删掉，已回退。
  //  代价是长度差距悬殊时短蛇会掉到画面下方，见下面的说明。）
  targetScreens: 1.55,
  // 镜头跟随时，蛇头停在屏幕顶部往下这个比例处。
  // 顶部标题带压成一条窄带（约 0.09 屏）后，0.22 就够蛇头露在它下方，
  // 又不会浪费生长高度——数值越大，能看到的蛇身越少。
  headMargin: 0.22,
  follow: 9.0,           // 镜头跟随的指数平滑系数（越大越紧跟）
  rulerStepSeg: 10,      // 每 10 节画一条水平刻度
  // 蛇柱粗细 = 列距 × girthRatio（再按长度微调），两端钳住。
  // 用列距而不是「节数曲线」：舞台里每条蛇的点数 ≈ 身高/13，长蛇会粗到
  // 把相邻两列连成一堵墙，看着就不再是 8 条蛇了。
  girthRatio: 0.19,
  minRadius: 12,
  maxRadius: 40,
  // 8 条蛇的「最左列心 → 最右列心」总跨度占屏宽的比例。
  // 全宽等分时首末两列紧贴屏幕边缘，大屏上会显得散；压在 60% 并整体居中后
  // 视线集中，两侧也留出了标题与镜头读数的安全区。
  // 任何窗口宽度都用这个值（不按屏宽分档）：跨度是玩家看到的「蛇排多宽」，
  // 忽宽忽窄会让人以为改了没生效。
  laneSpan: 0.60
};

/**
 * 造一条「假蛇」：只提供 drawSnake / drawSnakeHead 会读到的字段和方法。
 * 真实身体点列每帧由 ResultStage 覆盖，这里只准备静态鸭子类型接口。
 */
function makeStageSnake(row, index) {
  return {
    id: 1000 + index,
    alive: true,
    isPlayer: !!row.isPlayer,
    color: row.color,
    // 直接复用局内造型：AI 的搞怪头（斗鸡眼 / 大板牙 / 霓虹…）原样出现在
    // 比高蛇柱顶端，玩家走原版大头。不复制 key 的话 8 条会全长得一样。
    headStyle: row.headStyle || null,
    // 名字交给舞台自己画（带名次和节数），这里留空避免与 render.js 的
    // AI 名字标签重复叠字；style 同理，信息在底部成绩牌里更清楚。
    name: '',
    style: null,
    heading: -Math.PI / 2,   // 头朝正上方
    lookAt: null,
    mistake: false,
    wavePhase: 0,
    bend: 0,
    body: [],
    pulse: [],
    isFrozen: () => false,
    isImmune: () => false,
    buffLeft: () => 0,
    hasBuff: () => false,
    renderPoints() { return this.body; }
  };
}

export class ResultStage {
  constructor() {
    /** 演出结束时由 main.js 挂回调：淡入标题 / 收起「跳过演出」按钮 */
    this.onSettled = null;
    this.reset();
  }

  /** 清空到未激活状态（重开一局时调用） */
  reset() {
    this.active = false;
    this.phase = 'idle';      // idle | intro | grow | hold
    this.t = 0;               // 当前阶段计时
    this.time = 0;            // 舞台总时长，用于摆动 / 闪烁
    this.rows = [];
    this.lanes = [];
    this.viewW = 0;
    this.viewH = 0;
    this.unit = STAGE.minUnit;
    this.step = 0;            // 相邻两列的像素间距（由 layout 算出）
    this.laneSpan = STAGE.laneSpan;   // 当前屏宽下实际采用的列跨度比例
    this.maxHeight = 0;
    this.progress = 0;        // 生长进度 0~1
    this.camY0 = 0;           // 初始相机中心（世界坐标，y 向上为负）
    this.camY = 0;
    this.lift = 0;            // 相机已抬升的像素
    this.breakFlash = 0;      // 「突破屏幕」闪光强度
    this.broken = false;
    this.settled = false;
  }

  /**
   * 开演
   * @param {Array} ranking Game.rankSnapshot() 的排序结果（已含 rank / length / color ...）
   * @param {number} viewW CSS 像素宽
   * @param {number} viewH CSS 像素高
   */
  begin(ranking, viewW, viewH) {
    this.reset();
    this.active = true;
    this.phase = 'intro';
    this.rows = (ranking || []).map((r) => ({
      rank: r.rank,
      name: r.name,
      color: r.color,
      isPlayer: r.isPlayer,
      style: r.style || '',
      headStyle: r.headStyle || null,
      length: r.length,
      kills: r.kills,
      deaths: r.deaths
    }));
    this.viewW = Math.max(1, viewW);
    this.viewH = Math.max(1, viewH);
    this.layout();
    this.camY0 = -this.viewH / 2;
    this.camY = this.camY0;
  }

  /** 按当前屏幕尺寸重排：8 列等距铺在屏幕中央，与底部成绩牌的列中心严格对齐 */
  layout() {
    const n = Math.max(1, this.rows.length);
    const maxLen = Math.max(20, ...this.rows.map((r) => r.length));
    // 让冠军蛇大约 1.55 屏高：短局放大每节像素，长局缩小，但两端都钳住，
    // 避免节距远大于蛇身直径时变成一串断开的圆点。
    this.unit = clamp(
      this.viewH * STAGE.targetScreens / maxLen,
      STAGE.minUnit,
      STAGE.maxUnit
    );
    // 列心几何：总跨度 = 屏宽 × laneSpan，整体水平居中。
    // 即首列 x = 屏宽/2 - span/2，末列 x = 屏宽/2 + span/2，
    // 中间 n-2 列按等步长均分；只有 1 列时直接落在正中。
    // 不按屏宽分档：窄屏也照旧，跨度就是玩家看到的那条「蛇排多宽」。
    this.laneSpan = clamp(STAGE.laneSpan, 0.2, 0.95);
    const spanPx = this.viewW * this.laneSpan;
    const step = n > 1 ? spanPx / (n - 1) : 0;
    const x0 = this.viewW / 2 - spanPx / 2;
    this.step = step;
    this.lanes = this.rows.map((r, i) => ({
      x: n > 1 ? x0 + i * step : this.viewW / 2,
      rank: r.rank,
      name: r.name,
      color: r.color,
      isPlayer: r.isPlayer,
      headStyle: r.headStyle,
      length: r.length,
      finalHeight: r.length * this.unit,
      height: 0,
      // 蛇身粗细：跟着列距走（约列距的 19%），再给长一点的蛇多一点点肉，
      // 这样 8 条既不会挤成一排墙，也不会细成一根线；窗口缩放自动适配。
      radius: clamp(
        step * STAGE.girthRatio * (0.88 + 0.24 * Math.min(1, r.length / 120)),
        STAGE.minRadius,
        STAGE.maxRadius
      ),
      seed: i * 1.73,
      snake: makeStageSnake(r, i)
    }));
    this.maxHeight = Math.max(0, ...this.lanes.map((l) => l.finalHeight));
  }

  /** 窗口尺寸变化：保持已抬升的镜头高度，只重算几何 */
  resize(viewW, viewH) {
    if (!this.active) return;
    const oldLift = this.lift;
    this.viewW = Math.max(1, viewW);
    this.viewH = Math.max(1, viewH);
    this.layout();
    this.camY0 = -this.viewH / 2;
    this.camY = this.camY0 - oldLift;
    this.lift = oldLift;
  }

  /** 目标相机中心：蛇头接近屏顶后开始上移，之前一律贴着地平线 */
  cameraTarget(hMax) {
    return Math.min(
      this.camY0,
      -hMax + this.viewH * (0.5 - STAGE.headMargin)
    );
  }

  /** 每帧推进（用 realDt，暂停不影响结算演出） */
  update(realDt) {
    if (!this.active) return;
    const dt = clamp(realDt || 0, 0, 0.05);
    this.time += dt;
    this.t += dt;

    if (this.phase === 'intro' && this.t >= STAGE.introSec) {
      this.phase = 'grow';
      this.t = 0;
    }
    if (this.phase === 'grow') {
      const raw = clamp(this.t / STAGE.growSec, 0, 1);
      // ease-out：起步快、收尾慢，最后几十节冲顶更有仪式感
      this.progress = raw * (2 - raw);
      if (raw >= 1) {
        this.progress = 1;
        this.settle();
      }
    }

    // 所有蛇以同一「像素/秒」生长：短的先到顶停下，长的继续突破屏顶，
    // 这是「不断突破屏幕高度」的观感来源。
    const grown = this.maxHeight * this.progress;
    let hMax = 0;
    for (const lane of this.lanes) {
      lane.height = Math.min(lane.finalHeight, grown);
      if (lane.height > hMax) hMax = lane.height;
    }

    if (!this.broken && hMax > this.viewH) {
      this.broken = true;
      this.breakFlash = 1;
    }
    this.breakFlash = Math.max(0, this.breakFlash - dt * 1.5);

    const target = this.cameraTarget(hMax);
    this.camY += (target - this.camY) * (1 - Math.exp(-STAGE.follow * dt));
    // 硬约束：冠军蛇头永远留在画面内。
    // 低帧率 / 大 realDt 时指数跟随会滞后一截，蛇头会短暂冲出屏顶看不见，
    // 那就失去了「镜头随最高者升高」的主角；这里补一道不可越过的上限。
    // 留出蛇头本身 + 上方名次标签的高度（约 100px），否则头虽然没出屏，
    // 圆脸和标签却被顶部裁掉，只剩几根没头的柱子。
    const minHeadY = Math.max(70, this.viewH * 0.14);
    const headScreenY = -hMax - this.camY + this.viewH / 2;
    if (headScreenY < minHeadY) {
      this.camY = Math.min(this.camY, -hMax + this.viewH / 2 - minHeadY);
    }
    this.lift = Math.max(0, this.camY0 - this.camY);
  }

  /** 进入定格阶段，并通知 UI 淡入最终结果 */
  settle() {
    if (this.settled) return;
    this.settled = true;
    this.phase = 'hold';
    if (this.onSettled) this.onSettled();
  }

  /** 跳过演出：直接长满、镜头到位、结果立刻可点 */
  skip() {
    if (!this.active) return;
    this.progress = 1;
    for (const lane of this.lanes) lane.height = lane.finalHeight;
    this.camY = this.cameraTarget(this.maxHeight);
    this.lift = Math.max(0, this.camY0 - this.camY);
    this.breakFlash = 0;
    this.settle();
  }

  /** 收起舞台（重开 / 切无尽档时） */
  end() {
    this.reset();
  }

  /** 只读状态，给 Playwright 回归与页面调试用 */
  get debug() {
    return {
      active: this.active,
      phase: this.phase,
      progress: this.progress,
      unit: this.unit,
      maxHeight: this.maxHeight,
      viewW: this.viewW,
      viewH: this.viewH,
      laneSpan: this.laneSpan,
      /** 实际像素跨度（首列心 → 末列心），回归用例按屏宽 60% 校验 */
      spanPx: this.lanes.length > 1
        ? this.lanes[this.lanes.length - 1].x - this.lanes[0].x
        : 0,
      camY: this.camY,
      lift: this.lift,
      liftScreens: this.viewH ? this.lift / this.viewH : 0,
      broken: this.broken,
      settled: this.settled,
      lanes: this.lanes.map((l) => ({
        x: l.x, rank: l.rank, length: l.length,
        height: l.height, finalHeight: l.finalHeight, isPlayer: l.isPlayer
      }))
    };
  }

  // ------------------------------------------------------------
  // 绘制
  // ------------------------------------------------------------

  /**
   * 接管整块画布：不画游戏世界，也不画小地图。
   * 世界层用 y 向上为负的坐标，屏幕 y = worldY - camY + viewH/2。
   */
  draw(ctx, viewW, viewH, dpr) {
    if (!this.active) return;
    if (viewW !== this.viewW || viewH !== this.viewH) this.resize(viewW, viewH);
    const w = this.viewW;
    const h = this.viewH;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#040912';
    ctx.fillRect(0, 0, Math.ceil(w * dpr), Math.ceil(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ---- 固定背景：不随镜头移动，才衬得出刻度在滚动 ----
    // 与界面层共用「深蓝黑竞技场」配色，紫色只留给蛇身本身
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#0B2140');
    sky.addColorStop(0.5, '#071426');
    sky.addColorStop(1, '#040912');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    this.drawStars(ctx, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    ctx.save();
    ctx.translate(0, -this.camY + h / 2);
    this.drawRuler(ctx, w);
    this.drawGround(ctx, w);
    this.drawSnakes(ctx);
    ctx.restore();

    ctx.restore();

    this.drawScreenHUD(ctx, w, h);
  }

  /** 确定性星点：用正弦散列，不消耗随机数 */
  drawStars(ctx, w, h) {
    ctx.save();
    for (let i = 0; i < 46; i++) {
      const x = ((Math.sin(i * 91.7) * 43758.5453) % 1 + 1) % 1 * w;
      const y = ((Math.sin(i * 37.3) * 24634.6345) % 1 + 1) % 1 * h;
      const a = 0.12 + 0.18 * (0.5 + 0.5 * Math.sin(this.time * 1.3 + i));
      ctx.fillStyle = `rgba(190,230,255,${a})`;
      ctx.beginPath();
      ctx.arc(x, y, i % 7 === 0 ? 1.7 : 1.0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** 水平节数刻度：镜头升高时数字随之滚动，是最直观的「升高」证据 */
  drawRuler(ctx, w) {
    const step = this.unit * STAGE.rulerStepSeg;
    const topWorld = this.camY - this.viewH / 2;
    const bottomWorld = this.camY + this.viewH / 2;
    const maxK = Math.ceil((this.maxHeight + this.viewH * 2) / step);

    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = '700 12px "PingFang SC","Microsoft YaHei",sans-serif';
    // 数字靠右；冠军蛇的头号标签在左侧，放左边会糊成一团
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    for (let k = 1; k <= maxK; k++) {
      const y = -k * step;
      if (y < topWorld - step || y > bottomWorld + step) continue;
      const major = k % 5 === 0;
      ctx.strokeStyle = major ? 'rgba(182,255,87,0.16)' : 'rgba(86,232,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      // 只在每 5 格（= 50 节）标一个数字。以前是每 20 节一个，
      // 长局会冒出七八个数字，和蛇头顶的名次标签糊成一片。
      // 刻度线本身保留，给「高度尺」的感觉，但去掉数字的重复轰炸。
      if (major) {
        ctx.fillStyle = 'rgba(182,255,87,0.55)';
        ctx.fillText(`${k * STAGE.rulerStepSeg} 节`, w - 14, y - 4);
      }
    }
    ctx.restore();
  }

  /** 起跑地平线：8 条蛇的尾巴都锚在这里 */
  drawGround(ctx, w) {
    const g = ctx.createLinearGradient(0, 0, 0, 60);
    g.addColorStop(0, 'rgba(182,255,87,0.16)');
    g.addColorStop(1, 'rgba(182,255,87,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, 60);
    ctx.strokeStyle = 'rgba(182,255,87,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.fillStyle = 'rgba(4,9,18,0.55)';
    ctx.fillRect(0, 2, w, 4000);
  }

  /** 逐条生成竖直蛇身并复用局内绘制函数 */
  drawSnakes(ctx) {
    for (const lane of this.lanes) {
      const R = lane.radius;
      // 结束瞬间在复活倒计时的蛇长度记 0，画一根极矮的灰色标记即可
      if (lane.height < 8) {
        ctx.save();
        ctx.fillStyle = 'rgba(150,210,235,0.3)';
        ctx.fillRect(lane.x - R * 0.5, -6, R, 6);
        ctx.restore();
        continue;
      }

      const n = Math.max(2, Math.ceil(lane.height / STAGE.pointGap) + 1);
      const pts = new Array(n);
      const pulse = new Array(n);
      for (let i = 0; i < n; i++) {
        // 点列首点必须是「头」：render.js 的 drawSnake 拿 pts[0] 画脸，
        // 所以从上往下生成——i=0 在顶端（头），最后一点落在地平线（尾）。
        const t = i / (n - 1);
        const up = 1 - t;
        // 头尾不动、中段摆：像一条立起来的活蛇，而不是一根柱子
        const wob = Math.sin(this.time * 2.1 + i * 0.25 + lane.seed) *
          STAGE.waveAmp * Math.sin(t * Math.PI);
        pts[i] = { x: lane.x + wob, y: -lane.height * up, t };
        pulse[i] = 0;
      }
      const s = lane.snake;
      s.body = pts;
      s.pulse = pulse;
      s.wavePhase = this.time * 3;
      drawSnake(ctx, s, this.time, true, R);

      this.drawHeadTag(ctx, lane, R);
    }
  }

  /** 蛇头上方的小标牌：名次 + 实时节数，冠军额外加金色光环 */
  drawHeadTag(ctx, lane, R) {
    const y = -lane.height;
    // 短蛇的头会落进底部成绩牌区域（生长初期和镜头升高后的定格都会发生），
    // 那里已有完整名次 / 长度数据，标签再画上去只会叠字。
    const headScreenY = y - this.camY + this.viewH / 2;
    if (headScreenY > this.viewH - 150) return;
    const first = lane.rank === 1;
    // 标签默认贴在蛇头上方。但列收窄居中后冠军蛇正对左上角的标题区，
    // 蛇头顶上来时上方那块被标题遮住，标签画了也看不见，
    // 于是判断上方留出的屏幕空间：不够就改贴到蛇头下方。
    const aboveY = y - R * 2.6;
    const aboveScreenY = aboveY - this.camY + this.viewH / 2;
    // 顶部标题带压成一条窄带（实测约 72px），留白按它来算即可；
    // 上方空间不够时标签改贴到蛇头下方。
    const safeTop = Math.max(62, this.viewH * 0.095);
    const tagY = aboveScreenY >= safeTop ? aboveY : y + R * 3.0;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (first && this.phase === 'hold') {
      ctx.globalCompositeOperation = 'lighter';
      const ring = ctx.createRadialGradient(lane.x, y, R, lane.x, y, R * 5.5);
      ring.addColorStop(0, 'rgba(255,220,90,0.42)');
      ring.addColorStop(1, 'rgba(255,220,90,0)');
      ctx.fillStyle = ring;
      ctx.fillRect(lane.x - R * 5.5, y - R * 5.5, R * 11, R * 11);
      ctx.globalCompositeOperation = 'source-over';
    }

    const shown = this.phase === 'hold'
      ? lane.length
      : Math.round(lane.height / this.unit);
    // 标签宽度必须跟着列距走：桌面上 8 列间距 ~137px，固定 14px 的
    // 「1 名 · 11 节」只占 75px，绰绰有余；但手机横屏 844 宽只剩 ~63px、
    // 竖屏 390 宽只剩 ~33px，固定字号会让 8 个标签连成一条糊字。
    // 列距不足 92px 时切紧凑文案「1·11」，字号也按列距收敛（下限 10px）。
    const compact = this.step > 0 && this.step < 92;
    const label = compact
      ? `${first ? '★' : ''}${lane.rank}·${shown}`
      : `${first ? '★ ' : ''}${lane.rank} 名 · ${shown} 节`;
    const sizeCap = compact ? 13 : (first ? 17 : 14);
    const size = this.step > 0
      ? clamp(Math.round(this.step * 0.22), 10, sizeCap)
      : sizeCap;
    ctx.font = `800 ${size}px "PingFang SC","Microsoft YaHei",sans-serif`;
    const tw = ctx.measureText(label).width;
    // 窄屏回到全宽 8 等分后首末列几乎贴着屏幕边，标签居中画会被画布裁掉半截，
    // 这里把标签横向夹进安全区（宽屏首列在 20% 处，不会触发）。
    const tagX = clamp(lane.x, tw / 2 + 10, this.viewW - tw / 2 - 10);
    // 标签被挤到蛇头下方时，它正好压在粗蛇身和头部光晕上：垫一块暗色胶囊底，
    // 保证任何底色下都读得清（上方没有遮挡，保持干净不加底）。
    if (tagY !== aboveY) {
      const padY = Math.round(size * 0.8);
      ctx.fillStyle = 'rgba(4,9,18,0.74)';
      ctx.fillRect(tagX - tw / 2 - 7, tagY - padY, tw + 14, padY * 2);
    }
    ctx.lineWidth = Math.max(3, Math.round(size * 0.34));
    ctx.strokeStyle = 'rgba(8,4,18,0.9)';
    ctx.strokeText(label, tagX, tagY);
    ctx.fillStyle = first ? '#FFE07A' : lane.color;
    ctx.fillText(label, tagX, tagY);
    ctx.restore();
  }

  /** 屏幕空间 HUD：突破闪光、镜头高度、阶段说明 */
  drawScreenHUD(ctx, w, h) {
    // 首次突破一屏：顶部一道金色闪光，明确告诉玩家「镜头要开始升高了」。
    // 文案放在最顶上的标题带里（演出中标题已淡出，这块是空的），
    // 不能压在 0.2 屏——那里正是 8 个蛇头的位置。
    if (this.breakFlash > 0) {
      const f = this.breakFlash;
      const bandH = h * 0.2;
      const g = ctx.createLinearGradient(0, 0, 0, bandH);
      g.addColorStop(0, `rgba(255,225,120,${0.28 * f})`);
      g.addColorStop(1, 'rgba(255,225,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, bandH);
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 24px "PingFang SC","Microsoft YaHei",sans-serif';
      const label = '突破屏幕！';
      const tw = ctx.measureText(label).width;
      const ty = Math.max(26, h * 0.075);
      ctx.fillStyle = `rgba(10,4,22,${0.62 * f})`;
      ctx.fillRect(w / 2 - tw / 2 - 16, ty - 17, tw + 32, 34);
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(10,4,22,0.85)';
      ctx.strokeText(label, w / 2, ty);
      ctx.fillStyle = `rgba(255,226,130,${f})`;
      ctx.fillText(label, w / 2, ty);
      ctx.restore();
    }

    // 右上角原来的「镜头 +X 屏 / 视野 A~B 节」读数已删：
    // 那是调试信息，玩家既看不懂也不关心，还会逼着刻度数字绕开它。
  }
}
