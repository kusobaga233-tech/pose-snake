/**
 * 蛇实体（玩家与 AI 共用）
 * ------------------------------------------------------------
 * 运动模型：
 *   1) 方向：手腕相对圆心的角度（玩家）或 AI 的目标角 → 以受限角速度追过去。
 *      上限 = tuning.turnRate × 个体技能倍率；体感侧不再有手肘参与方向运算。
 *      AI 内部另有一条中性的 wobble（航线摆动）与 turnEase（转向倍率），
 *      数值等价于改造前的 bend/extend，用来保住 AI 难度与自撞率基线。
 *   2) 速度：手腕离圆心的距离 → 0.65~1.40 倍率（仅玩家，带低通 + 变化率限制）。
 *   3) 身体是一串跟随链，每节被前一节拖着走，天然平滑；
 *      视觉摆动由「本帧实际转过的角度」驱动，转弯时摆得更明显。
 *   4) 「越大越慢」：速度每帧按当前节数重算，玩家与 AI 共用同一条曲线。
 */

import { CONFIG, WORLD, snakeRadius } from './config.js';
import { clamp, normAngle, dist2 } from './utils.js';

export class Snake {
  /**
   * @param {object} o
   *   id, isPlayer, color, name
   */
  constructor(o) {
    this.id = o.id;
    this.isPlayer = !!o.isPlayer;
    this.color = o.color;
    this.name = o.name || '';
    // 真人玩家序号：0 = 玩家 1、1 = 玩家 2，AI 为 -1。
    // 双人分屏时配色、名字、镜头、HUD、结算头像全按它区分，不再用 isPlayer 一刀切。
    this.playerIndex = Number.isFinite(o.playerIndex)
      ? o.playerIndex
      : (this.isPlayer ? 0 : -1);
    // 玩家身体的四段渐变色 / 头部底色（AI 不填，走 lighten/darken(color) 自动计算）
    this.grad = Array.isArray(o.grad) ? o.grad : null;
    this.headColor = o.headColor || null;

    // 每个个体的转向能力（AI 用来做难度差异，玩家固定 1）
    this.turnMul = o.turnMul ?? 1;
    // 速度随机浮动，避免所有 AI 完全同步
    this.speedMul = o.speedMul ?? 1;

    this.body = [];
    this.pulse = [];
    // 小数成长累积器：AI 领跑压制的加成不足一节时先攒着，
    // 攒满 1 节才追加身体，避免「吃了却没长」的观感断裂
    this.growthCarry = 0;

    this.heading = 0;
    this.speed = CONFIG.snake.baseSpeed;
    this.alive = false;
    this.respawnTimer = 0;
    this.immuneUntil = 0;
    // 复活 / 开局的「静止保护期」截止时刻（performance.now() 毫秒）。
    // 用真实时钟而不是模拟 dt：主循环会把 dt 钳在 0.05 内、还会被击杀顿帧缩放，
    // 用 dt 计时 0.3 秒会被拉长，玩家看到的"承诺时长"就不准了。
    this.freezeUntil = 0;

    // 道具增益：存的是「剩余秒数」，由 Game.update 每帧用真实 dt 递减。
    // 不用 performance.now() 截止时刻：暂停时游戏不调 update，剩余时间
    // 就自然冻结，符合"持续 5 秒"的直觉（墙上时钟会在暂停时偷偷流逝）。
    this.buffs = { boost: 0, magnet: 0 };

    // 体感距离→速度倍率（只作用于玩家；AI 恒为 1，确保统计基线不动）
    this.poseSpeed = 1;
    // 本帧实际转过的角度（弧度，取绝对值），用于驱动蛇身视觉摆动
    this.turnAmount = 0;
    // AI 当前是否处于「走神失误」：Brain 每帧写入，渲染据此在蛇头画 "?" 提示
    this.mistake = false;

    // 渲染用的身体摆动相位（幅度比之前小，因为轨迹本身已经会弯）
    this.wavePhase = 0;

    // 眼睛看向的点
    this.lookAt = null;

    // 统计
    this.kills = 0;
    this.foodEaten = 0;

    // ---- 单局统计（结算页 / 同长度裁决用）----
    // 由 Game.reset() 每局清零；Snake.reset() 是复活用的，不能清，
    // 否则玩家死一次后「本局死亡次数 / 峰值长度」会被抹掉。
    this.peakLength = 0;   // 本局到过的最大节数
    this.deaths = 0;        // 本局死亡次数
    this.style = null;      // 本局随机分配的游戏风格对象（玩家为 null）
    // 本局随机分配的蛇头造型 key（见 js/heads.js）；玩家恒为 null = 原版头。
    // 由 Game.assignHeadStyles() 每局洗牌写入，一局之内 7 只 AI 互不重复。
    this.headStyle = null;
  }

  /** 蛇身节数 */
  get length() {
    return this.body.length;
  }

  /**
   * 是否处于「复活静止保护期」：原地不动，只接收方向输入
   * 统一用 performance.now()，避免游戏逻辑和渲染用两套时钟导致状态不一致
   */
  isFrozen() {
    return performance.now() < this.freezeUntil;
  }

  /**
   * 是否处于无敌状态
   * 静止期必然无敌：即便页面把静止期调得比 immunity 还长（或被外部清掉
   * immuneUntil），只要蛇还没起步就不会被撞死，符合"静止且无敌"的承诺。
   */
  isImmune() {
    return this.isFrozen() || performance.now() < this.immuneUntil;
  }

  // ------------------------------------------------------------
  // 道具增益
  // ------------------------------------------------------------
  /** 某类增益剩余秒数（0 = 没生效） */
  buffLeft(type) {
    return Math.max(0, this.buffs[type] || 0);
  }

  /** 某类增益是否正在生效 */
  hasBuff(type) {
    return this.buffLeft(type) > 0;
  }

  /**
   * 拾取道具：同类不叠乘倍率，只把时长刷新到满。
   * 例如剩余 3 秒时又吃到一个加速 → 回到完整 5 秒，而不是变成 8 秒或 1.65²。
   */
  applyBuff(type, sec) {
    if (!(type in this.buffs) || !Number.isFinite(sec)) return;
    this.buffs[type] = Math.max(this.buffs[type], sec);
  }

  /** 每帧递减（真实 dt，暂停时 Game 不调用 update → 自动冻结） */
  tickBuffs(realDt) {
    if (!(realDt > 0)) return;
    for (const k in this.buffs) {
      if (this.buffs[k] > 0) this.buffs[k] = Math.max(0, this.buffs[k] - realDt);
    }
  }

  /** 死亡 / 重开时清空：复活后不带上一局的增益 */
  clearBuffs() {
    this.buffs.boost = 0;
    this.buffs.magnet = 0;
  }

  /**
   * 在指定位置重生
   * @param {number} x 蛇头位置
   * @param {number} y
   * @param {number} heading 初始朝向
   * @param {number} segments 节数
   */
  reset(x, y, heading, segments) {
    this.body.length = 0;
    this.pulse.length = 0;
    this.growthCarry = 0;

    const dx = Math.cos(heading);
    const dy = Math.sin(heading);
    for (let i = 0; i < segments; i++) {
      this.body.push({ x: x - dx * i * CONFIG.snake.segDist, y: y - dy * i * CONFIG.snake.segDist });
      this.pulse.push(0);
    }

    this.heading = heading;
    // 复活 / 重开不带上一局的增益，初始速度也就按无增益算；
    // 本帧 updateSpeed() 还会按当前节数再校准一次。
    this.clearBuffs();
    this.speed = CONFIG.snake.baseSpeed * this.speedMul;
    this.alive = true;
    this.respawnTimer = 0;
    // 默认不冻结；开局 / 复活由 Game 显式设置 freezeUntil
    this.freezeUntil = 0;
    // 复活 / 重开回到基准速度，起步后第一帧再由当前手腕距离重算
    this.poseSpeed = 1;
    this.turnAmount = 0;
    this.wavePhase = Math.random() * 10;
  }

  /**
   * 按当前体型重算速度（「越大越慢」+ 体感距离倍率）
   * ------------------------------------------------------------
   * speed = baseSpeed × speedMul × (1 - strength × (1 - e^(-extra/scale)))
   *         × boost × poseSpeed
   *   extra     = 当前节数 - 初始节数
   *   strength  = 最大减速比例（0 表示关闭该特性）
   *   scale     = 长度尺度，越小减速来得越快
   *   boost     = 加速道具倍率
   *   poseSpeed = 玩家手腕距离映射出的倍率（默认 0.65~1.40，AI 恒为 1）
   * 每帧重算，生长 / 吞并 / 复活都不需要额外手动同步。
   * 倍率只做「最后一乘」，不改「越大越慢」曲线本身，也不影响道具倍率。
   * @param {object} tuning 运行时手感参数
   * @param {number} poseSpeed 体感距离倍率
   */
  updateSpeed(tuning, poseSpeed = 1) {
    const S = CONFIG.slowdown;
    const extra = Math.max(0, this.length - CONFIG.snake.startSegments);
    const strength = clamp(tuning.slowStrength ?? S.strength, 0, 0.95);
    const scale = Math.max(1, tuning.slowScale ?? S.scale);
    const k = 1 - Math.exp(-extra / scale);
    // 加速道具只乘一个倍率，不改「越大越慢」的曲线本身：
    // 大蛇吃了照样比小蛇慢，只是整体快一档。
    const boost = this.hasBuff('boost') ? CONFIG.powerups.boost.speedMul : 1;
    const SP = CONFIG.pose.speed;
    const dist = clamp(poseSpeed, SP.minLimit, SP.maxLimit);
    this.speed = CONFIG.snake.baseSpeed * this.speedMul * (1 - strength * k) * boost * dist;
  }

  /**
   * 每帧更新
   * @param {number} dt 秒
   * @param {object|null} control {angle, speedScale, turnEase?, wobble?}
   *   angle      目标朝向（玩家 = 手腕相对圆心的角度，方向唯一来源）
   *   speedScale 玩家手腕距离映射出的速度倍率（AI 不提供）
   *   turnEase   AI 的转向倍率；wobble 是 AI 内部航线摆动（玩家都没有）
   * @param {object} tuning {turnRate, slowStrength, slowScale}
   */
  update(dt, control, tuning) {
    if (!this.alive) return;

    // 体感距离倍率只认玩家自己的 control；AI 不提供，恒为 1。
    // 没识别到手（control = null）时保持上一帧倍率，速度不会突然跳回 1。
    if (control && Number.isFinite(control.speedScale)) this.poseSpeed = control.speedScale;

    // 先按当前长度刷新速度：吃食物 / 吞并 / 复活后立刻生效
    this.updateSpeed(tuning, this.poseSpeed);

    // ---- 复活 / 开局静止保护期 ----
    // 位置、身体节点、摆动相位全部不动（真的"静止"，不是慢慢爬），
    // 但方向输入照常接收：每帧把朝向直接对齐到玩家此刻给的角度。
    // 这样 0.3 秒结束的瞬间，蛇就朝玩家输入的方向出发，
    // 而不是朝出生点那个随机朝向（inwardHeading）先冲一段再被拉回来。
    // 静止期不吃食物（Game.eatFood 会跳过），连长度都不会变。
    if (this.isFrozen()) {
      if (control && Number.isFinite(control.angle)) {
        // 静止期方向完全等于玩家此刻给的角度，不加任何偏置；
        // 0.3 秒结束的瞬间就朝这个方向出发。
        this.heading = normAngle(control.angle);
      }
      this.turnAmount = 0;
      return;
    }

    const T = CONFIG.turn;
    this.turnAmount = 0;

    if (control) {
      // ---- 1. 方向：目标角 + AI 内部摆动 ----
      // 玩家的 wobble 恒为 0，所以「位移方向只通过手腕与圆心连线的角度控制」。
      // wobble 是 AI 模拟蛇形航线的中性摆动量，数值等价于旧版 bend 偏置。
      const targetAngle = control.angle + (control.wobble ?? 0);
      const diff = normAngle(targetAngle - this.heading);

      // ---- 2. 追目标朝向（受限角速度）----
      // turnEase 只由 AI 提供（等价旧版 extend=0.62 的伸展倍率），玩家缺省 1。
      const rate = tuning.turnRate * (control.turnEase ?? 1) * this.turnMul;
      // 大角度掉头时给一点补偿，否则玩家挥手掉头会很难受
      const boost = 1 + (Math.abs(diff) / Math.PI) * (T.reverseBoost - 1);
      const maxTurn = rate * boost * dt;
      const turned = clamp(diff, -maxTurn, maxTurn);
      this.heading = normAngle(this.heading + turned);
      // 记录本帧实际转过的角度，供蛇身视觉摆动使用（不再是手肘偏移驱动）
      this.turnAmount = Math.abs(turned);
    }

    // ---- 3. 前进 ----
    const head = this.body[0];
    head.x += Math.cos(this.heading) * this.speed * dt;
    head.y += Math.sin(this.heading) * this.speed * dt;

    // ---- 4. 身体跟随链 ----
    const segDist = CONFIG.snake.segDist;
    for (let i = 1; i < this.body.length; i++) {
      const prev = this.body[i - 1];
      const cur = this.body[i];
      let dx = cur.x - prev.x;
      let dy = cur.y - prev.y;
      let d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        dx = 1; dy = 0; d = 1;
      }
      // 只在被拉长时拉回，保持链条不被压缩，形成自然拖拽
      if (d > segDist) {
        const k = segDist / d;
        cur.x = prev.x + dx * k;
        cur.y = prev.y + dy * k;
      }
    }

    // ---- 5. 身体摆动相位 + 亮度脉冲 ----
    // 摆动由本帧实际转过的角度驱动：转弯时摆得更明显，直行时趋于平缓，
    // 不再依赖手肘横向偏移。
    this.wavePhase += (2.0 + Math.min(3, this.turnAmount * 12)) * dt;
    this.decayPulse(dt);
  }

  /** 脉冲亮度衰减，并从头部向尾部传递 */
  decayPulse(dt) {
    const k = Math.exp(-4.5 * dt);
    for (let i = 0; i < this.pulse.length; i++) this.pulse[i] *= k;
    for (let i = this.pulse.length - 1; i > 0; i--) {
      if (this.pulse[i - 1] > this.pulse[i]) this.pulse[i] = this.pulse[i - 1] * 0.92;
    }
  }

  /** 生长 n 节 */
  grow(n) {
    const segDist = CONFIG.snake.segDist;
    for (let i = 0; i < n; i++) {
      const tail = this.body[this.body.length - 1];
      const prev = this.body[this.body.length - 2] || tail;
      const dx = tail.x - prev.x;
      const dy = tail.y - prev.y;
      const d = Math.hypot(dx, dy) || 1;
      this.body.push({ x: tail.x + (dx / d) * segDist, y: tail.y + (dy / d) * segDist });
      this.pulse.push(0);
    }
    // 峰值长度只增不减，用在本局结算与同长度裁决，不受死亡清空身体影响
    if (this.length > this.peakLength) this.peakLength = this.length;
  }

  /**
   * 小数成长：攒够整节才真正追加身体节点。
   * 供 AI 领跑压制这种「每个食物额外 0.x 节」的连续加成使用，
   * 玩家吃食物仍走 grow(1)，手感完全不变。
   * @param {number} amount 本次要累积的节数（可为小数）
   */
  growFractional(amount) {
    if (!(amount > 0)) return;
    this.growthCarry += amount;
    const whole = Math.floor(this.growthCarry);
    if (whole > 0) {
      this.growthCarry -= whole;
      this.grow(whole);
    }
  }

  /** 头部撞墙判定（只在世界边界内） */
  hitWall() {
    const p = CONFIG.snake.wallPad;
    const h = this.body[0];
    return h.x < p || h.x > WORLD.w - p || h.y < p || h.y > WORLD.h - p;
  }

  /** 把头部夹回世界内，用于死亡瞬间的收束 */
  clampToWorld() {
    const p = CONFIG.snake.wallPad;
    const h = this.body[0];
    h.x = clamp(h.x, p, WORLD.w - p);
    h.y = clamp(h.y, p, WORLD.h - p);
  }

  /**
   * 撞到自己身体（跳过靠近头部的几节）
   * 默认参数 = 玩家的标准判定；AI 可传更宽容的参数（见 CONFIG.ai.selfHit），
   * 让「擦边」不算死、真正缠进身体里才死。玩家始终用默认值。
   * 半径按当前节数取（越长越粗），保证「画出来多粗、判定就多粗」。
   * @param {number} skip 从第几节开始扫（前几节必然贴着头，不算自撞）
   * @param {number} radiusMul 判定半径 = 该蛇当前半径 × 该值
   */
  hitSelf(skip = 9, radiusMul = 0.62) {
    const h = this.body[0];
    const r2 = Math.pow(snakeRadius(this.body.length) * radiusMul, 2);
    for (let i = skip; i < this.body.length; i++) {
      const p = this.body[i];
      if (dist2(h.x, h.y, p.x, p.y) < r2) return true;
    }
    return false;
  }

  /**
   * 渲染用点列：在身体节点上叠加一点点摆动
   * 偏移只作用于渲染，碰撞用原始 body，避免"看着没碰到却死了"
   */
  renderPoints() {
    const n = this.body.length;
    const out = [];
    // 轨迹本身已经会弯，所以这里的视觉摆动幅度收小；
    // 转弯越急幅度越大，直行时只留一点点呼吸感。
    const amp = 0.8 + Math.min(4.5, this.turnAmount * 18);

    for (let i = 0; i < n; i++) {
      const p = this.body[i];
      const t = n > 1 ? i / (n - 1) : 0;

      if (i === 0 || n < 3) {
        out.push({ x: p.x, y: p.y, t });
        continue;
      }

      // 切线方向（用前后节点估算），再取法线
      const a = this.body[i - 1];
      const b = this.body[Math.min(n - 1, i + 1)];
      let tx = b.x - a.x;
      let ty = b.y - a.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;

      // 头尾摆动小、中段大，看起来更像活蛇
      const envelope = Math.sin(t * Math.PI);
      const offset = amp * envelope * Math.sin(this.wavePhase - i * 0.55);

      out.push({ x: p.x - ty * offset, y: p.y + tx * offset, t });
    }
    return out;
  }

  /** 死亡时身体的散落位置（用于生成食物） */
  scatterPositions(max) {
    const n = this.body.length;
    if (n === 0) return [];
    const step = Math.max(1, Math.ceil(n / max));
    const out = [];
    for (let i = 0; i < n; i += step) out.push(this.body[i]);
    return out;
  }
}
