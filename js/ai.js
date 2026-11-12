/**
 * AI 对手的大脑
 * ------------------------------------------------------------
 * 决策流程（每帧）：
 *   1. 选目标食物（难度低时会挑错、锁定得更久）
 *   2. 前方探路：撞墙 / 撞别人身体 / 迎面别的蛇头 → 生成避让向量
 *   3. 目标方向 + 避让向量 合成期望朝向
 *   4. 如果自己明显更长，且附近有对手蛇头 → 主动冲撞（难度低时几乎不冲）
 *   5. 叠加缓慢的正弦摆动（wobble），让蛇走 S 形航线
 *
 * 关于体感改造：玩家侧已删除手肘控制，方向只认手腕角度。
 * AI 不接收体感输入，这里把旧版 extend/bend 的影响数值等价地折算成
 * turnEase（转向倍率）与 wobble（航线摆动），保证 AI 行为、
 * 难度模型与约 30% 自撞率基线完全不变。
 *
 * 「难度系数」不是单纯调速度，而是同时削弱 5 个能力维度：
 *   转向能力 / 反应间隔 / 感知与避让 / 进攻欲望 / 觅食精度
 * 另外有独立的「失误频率」：AI 会随机短暂走神，期间完全不避让、
 * 朝打偏的方向直走，蛇头会冒一个 "?" 让玩家看得出它失误了。
 *
 * 「自体避让」：AI 绕小圈时会把头撞到自己的身体上，旧版探路完全跳过
 * 自己的身体节点。现在沿目标方向短前瞻，近处有自己的身体就改选一条
 * 不撞的航线，降低频率但不禁止自撞（详见 CONFIG.ai.selfAvoid）。
 *
 * 「压迫模式」（2026-11-09）：难度 > 0.5 且 TUNING.aiPressure > 0 时，
 * 额外获得 4 项能力，强度统一由 pressure 控制：
 *   1) 自体避让随难度增强（旧模型 guard = 1 - level，拉满反而疯狂自撞）
 *   2) 更远的墙体探路 / 更大的危险感知半径 → 少撞墙、少撞别人身体
 *   3) 更低的进攻门槛、更远的追击距离、更强的冲撞权重
 *   4) 拦截点预判：追对手「前方」而不是当前蛇头，并带侧偏横身封路；
 *      对玩家另有仇恨倍率，形成被围攻的压迫感
 * 重要约束：难度 ≤ 0.5（或压迫强度 = 0）时 pressure ≡ 0，所有派生系数
 * 与旧版严格一致，30% 自撞率基线与全套回归都能随时对照复现。
 *
 * 注意：AI 只输出"想往哪走"，真正的转向限速在 Snake.update 里，
 * 所以它和玩家受同一套物理约束，不会出现瞬移转向。
 */

import { CONFIG, TUNING, computeAiPressure, snakeRadius } from './config.js';
import { clamp, normAngle, randRange, dist2 } from './utils.js';

/**
 * 没分配到风格时的中性参数。全 1 = 完全不改变原决策；
 * foodWeight 0.55 是旧版合成方向时「追食物」的固定权重。
 * 风格只在 Brain 里改「意图」，不改 Snake 的物理上限。
 */
const NEUTRAL_STYLE = {
  attackMul: 1, aggressionMul: 1, avoidMul: 1, senseMul: 1,
  sloppyMul: 1, lapseMul: 1, foodWeight: 0.55, bigFoodBias: 1, fleeMul: 1
};

// AI 内部中性参数：数值等价于改造前的「手肘」链路，用来锁住基线。
// 旧版 AI 的 extend 固定 0.62 → 转向倍率 lerp(0.72, 1.32, 0.62) = 1.092
const AI_TURN_EASE = 0.72 + (1.32 - 0.72) * 0.62;
// 旧版 bias = bend × elbowWeight(1) × elbowBiasGain(0.30)；
// bendAmp ≤ 0.75，偏置 ≤ 0.225。
// 2026-11-11：幅度再砍一半 —— 0.30 的常驻摆动在 3 米视距下看起来像「蛇头一直在抖」，
// 减半后仍有蛇形，但不再是主要视觉噪声。
const AI_WOBBLE_GAIN = 0.15;

export class Brain {
  /**
   * @param {import('./snake.js').Snake} snake
   */
  constructor(snake) {
    this.snake = snake;

    // 个体差异：技能决定转向能力，速度倍率在 spawn 时已定
    this.skill = randRange(CONFIG.ai.skillMin, CONFIG.ai.skillMax);
    // 难度会再乘一个倍率；每帧 think() 都会重算，拖滑块下一帧就生效
    snake.turnMul = this.skill * this.turnFactor(TUNING.aiLevel);

    this.target = null;       // 当前锁定的食物
    this.retargetAt = 0;      // 下次重新选目标的时间
    this.wanderAngle = randRange(0, Math.PI * 2);
    // 航线摆动相位 / 幅度（旧名 bendPhase/bendAmp，去掉「手肘」语义）
    this.wobblePhase = randRange(0, Math.PI * 2);
    this.wobbleAmp = randRange(0.35, 0.75);

    // ---- 难度 / 失误相关状态（时间都用游戏模拟时间 game.time，单位秒）----
    this.lastControl = null;  // 反应间隔内沿用的上一次决策
    this.nextDecisionAt = 0;  // 下次允许重新决策的时刻
    this.aimBias = 0;         // 低频瞄准抖动（每 0.45~1.1s 换一次，不会被转向控制器平均掉）
    this.biasAt = 0;
    this.lapseUntil = 0;      // 走神结束时刻，>0 表示正在失误
    this.lapseControl = null; // 走神期间固定的错误指令
    this.nextLapseAt = 0;     // 走神冷却，避免刚回神又立刻发作
    this.nearest = [];        // findFood 复用的最近食物候选表

    // 累计统计：调试 / 事后分析用，重开一局不清零
    this.lapses = 0;          // 走神次数
    this.mistakeFrames = 0;  // 处于走神状态的帧数
    this.escapeHits = 0;     // 自体避让改写方向的次数
    this.escapeStuck = 0;    // 其中「两侧都堵、无路可走」的次数
    this.loopTriggers = 0;   // 判出「在绕圈」的次数

    // ---- 防绕圈 / 意图平滑（2026-11-11）----
    // 现场问题：AI 会绕着一个够不着的食物越绕越小，最后咬到自己。
    // 这里记录窗口内的位移与累计转角，用来识别「在原地转圈」。
    this.smoothAngle = null;  // 低通后的指令角（意图层平滑，物理限速仍在 Snake.update）
    this.loopTurn = 0;        // 窗口内累计转角（绝对值，抢左抢右都算）
    this.loopPath = 0;        // 窗口内走过的路程（用来算「位移 / 路程」）
    this.loopSigned = 0;      // 窗口内有符号转角 → 决定往哪边脱离
    this.loopRef = null;      // 窗口起点的头部位置
    this.loopCheckAt = 0;     // 下次结算窗口的时刻
    this.prevHeading = null;  // 上一帧航向（算每帧转角增量）
    this.escapeUntil = 0;     // 脱离绕圈的结束时刻（这段时间近似直行）
    this.escapeDir = 1;       // 脱离方向（+1 / -1）
    this.escapeSide = 1;      // 自避让的偏向（滞回用，避免左右来回挑）
    this.avoidFood = null;    // 刚被判定「追不到」而放弃的食物
    this.avoidFoodUntil = 0;  // 该食物进黑名单的截止时刻
    this.aimBiasTarget = 0;   // 瞄准偏置的目标值（再插值成 aimBias，避免阶跃）

    // 本局随机分配的游戏风格（Game.reset 里洗牌后调 setStyle）
    this.style = null;
  }

  /**
   * 设置本局游戏风格。同时写回 snake.style，
   * 让 HUD 排行榜 / 结算页能直接读出「这条蛇是什么性格」。
   */
  setStyle(style) {
    this.style = style || null;
    this.snake.style = this.style;
    return this.style;
  }

  /**
   * 难度 → 转向能力倍率。level=1 返回 1（与旧版完全一致）
   * @param {number} level 0~1
   */
  turnFactor(level) {
    const D = CONFIG.ai.difficulty;
    const lv = clamp(Number.isFinite(level) ? level : D.level, D.levelMin, D.levelMax);
    return D.turnFloor + (1 - D.turnFloor) * lv;
  }

  /**
   * 量一个朝向前方「离自己身体多近」：返回沿航线范围内最近身体点的垂距，
   * 没有身体点则返回 Infinity。数值越小越危险。
   * 与旧的 blocked() 不同，它不短路返回，而是给出可以互相比较的裕量，
   * 用来在几条候选航线里挑「比较不危险」的那条，而不是硬掰到某个方向。
   * @param {import('./snake.js').Snake} snake
   * @param {number} angle 待检查的绝对朝向
   */
  selfClearance(snake, angle) {
    const G = CONFIG.ai.selfAvoid;
    const b = snake.body;
    const hx = b[0].x, hy = b[0].y;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let best = Infinity;
    for (let k = G.skip; k < b.length; k += G.step) {
      const vx = b[k].x - hx;
      const vy = b[k].y - hy;
      const along = vx * dx + vy * dy;            // 沿朝向的投影
      if (along < 0 || along > G.lookAhead) continue;
      const side = Math.abs(vx * dy - vy * dx);   // 到航线的垂距
      if (side < best) best = side;
    }
    return best;
  }

  /**
   * 自体避让：沿 angle 方向做一次短前瞻，若近处有自己的身体，就在
   * 左转 / 右转两条候选里挑一条更空的航线。
   *
   * 与旧版的三点差异（都是为了消除「突然拐弯」和「越绕越紧」）：
   *   1. 判据用 selfClearance 的裕量，而不是 blocked() 的布尔短路；
   *   2. 两侧都通时选偏离当前航向更小的一侧，避免左右来回摆；
   *   3. 两侧都堵时只取偏转的一半 ——
   *      旧版这里恒定向 + 方向 2×turn（最多 180°），长蛇一旦进圈就会被
   *      「永远同向满舵」锁死；宁可小幅让开，让上层去直行脱离。
   * @param {import('./snake.js').Snake} snake
   * @param {number} angle 待检查的绝对朝向
   * @param {number} guard 避让强度 0~1（0 = 完全不避让）
   * @returns {number} 修正后的绝对朝向
   */
  selfEscape(snake, angle, guard) {
    const G = CONFIG.ai.selfAvoid;
    if (!G.enabled || guard <= 0) return angle;
    // 危险半径随身体粗细缩放：细蛇不必为几十像素外的身体急转，
    // 粗蛇则需要更早开始让（52px 固定值对 44px 半径的长蛇只有 8px 余量）
    const dangerR = Math.max(G.dangerRMin, snakeRadius(snake.length) * G.dangerMul);
    // 前方够空：原样放行
    if (this.selfClearance(snake, angle) >= dangerR) return angle;
    this.escapeHits++;

    const turn = G.escapeTurn * guard;
    const cw = normAngle(angle + turn);
    const ccw = normAngle(angle - turn);
    const clrCw = this.selfClearance(snake, cw);
    const clrCcw = this.selfClearance(snake, ccw);
    const cwOk = clrCw >= dangerR;
    const ccwOk = clrCcw >= dangerR;
    const side = this.escapeSide || 1;   // 上次偏向哪一侧

    if (cwOk && ccwOk) {
      // 滞回：上次往那边躲、且那侧还有七成余量，就继续躲。
      // 没有滞回时两侧「差不多空」会逐帧来回挑，实测每秒反转 7~9 次，
      // 视觉上就是蛇头左右抽搐。
      if (side > 0 && clrCw >= clrCcw * 0.7) return cw;
      if (side < 0 && clrCcw >= clrCw * 0.7) return ccw;
      // 两侧差太多：重新选，仍优先偏向更接近当前航向的一侧
      const dCw = Math.abs(normAngle(cw - snake.heading));
      const dCcw = Math.abs(normAngle(ccw - snake.heading));
      const goCw = dCw <= dCcw;
      this.escapeSide = goCw ? 1 : -1;
      return goCw ? cw : ccw;
    }
    if (cwOk) { this.escapeSide = 1; return cw; }
    if (ccwOk) { this.escapeSide = -1; return ccw; }

    // 两侧都堵：只有这一条路。偏转砍到 35% 并记住方向，
    // 不在这里做大角度掉头（旧版恒定向 + 方向 2×turn，最多 180°，
    // 长蛇一旦进圈会被这个「永远同向满舵」锁死，越转越紧）。
    const goCw = clrCw >= clrCcw;
    this.escapeSide = goCw ? 1 : -1;
    this.escapeStuck++;
    return normAngle(angle + normAngle((goCw ? cw : ccw) - angle) * 0.35);
  }

  /**
   * 防绕圈检测：每帧累计航向变化，每个窗口结算一次。
   * 判定条件 —— 窗口内累计转角很大（一直在转），但位移很小（没离开原地）。
   * 命中后：放弃当前食物（进黑名单）、进入一段近似直行的脱离期。
   * 这是「AI 绕着一个够不着的食物打转」的直接解法：
   * 上层不再追它，蛇就会沿切线跑出去，圈自然破了。
   * @param {{x:number,y:number}} head 蛇头
   * @param {import('./snake.js').Snake} s
   * @param {number} now 游戏时间（秒）
   */
  updateLoopGuard(head, s, now, dt) {
    const L = CONFIG.ai.antiLoop;
    if (!L.enabled) return;

    // 累计本帧实际转过的角（绝对值用于判绕圈，带符号用于决定脱离方向）
    if (this.prevHeading !== null) {
      const d = normAngle(s.heading - this.prevHeading);
      this.loopTurn += Math.abs(d);
      this.loopSigned += d;
    }
    this.prevHeading = s.heading;
    // 累计走过的路程：绕圈的本质是「路程很长但位移很短」，
    // 只用位移或只用转角都抓不住长蛇的大半径绕圈。
    this.loopPath += (s.speed || 0) * dt;

    // 窗口初始化
    if (!this.loopRef) {
      this.loopRef = { x: head.x, y: head.y };
      this.loopTurn = 0;
      this.loopSigned = 0;
      this.loopPath = 0;
      this.loopCheckAt = now + L.windowSec;
      return;
    }
    if (now < this.loopCheckAt) return;

    const moved = Math.hypot(head.x - this.loopRef.x, head.y - this.loopRef.y);
    const turnedDeg = (this.loopTurn * 180) / Math.PI;
    const ratio = this.loopPath > 1 ? moved / this.loopPath : 1;
    if (turnedDeg > L.turnDeg && ratio < L.pathRatio) {
      // 确实在绕圈：松手，别再追那个吃不到的目标
      this.loopTriggers++;
      this.escapeUntil = now + L.escapeSec;
      // 顺着原来转的方向脱离（顺时针绕就顺时针放大半径），
      // 避免「先猛回头」那种突兀动作
      this.escapeDir = this.loopSigned >= 0 ? 1 : -1;
      if (this.target) {
        this.avoidFood = this.target;
        this.avoidFoodUntil = now + L.blacklistSec;
        this.target = null;
        this.retargetAt = 0;
      }
    }
    // 重新开窗
    this.loopRef = { x: head.x, y: head.y };
    this.loopTurn = 0;
    this.loopSigned = 0;
    this.loopPath = 0;
    this.loopCheckAt = now + L.windowSec;
  }

  /** 重开一局 / 复活时清掉所有临时状态，避免沿用上一局的方向或走神 */
  resetForNewRound() {
    this.target = null;
    this.retargetAt = 0;
    this.lastControl = null;
    this.nextDecisionAt = 0;
    this.aimBias = 0;
    this.aimBiasTarget = 0;
    this.biasAt = 0;
    this.lapseUntil = 0;
    this.lapseControl = null;
    this.nextLapseAt = 0;
    // 防绕圈 / 平滑状态也要清：上一局的转角与黑名单不能带进新一局
    this.smoothAngle = null;
    this.loopTurn = 0;
    this.loopSigned = 0;
    this.loopPath = 0;
    this.loopRef = null;
    this.loopCheckAt = 0;
    this.prevHeading = null;
    this.escapeUntil = 0;
    this.escapeDir = 1;
    this.escapeSide = 1;
    this.avoidFood = null;
    this.avoidFoodUntil = 0;
    this.snake.mistake = false;
  }

  /** 清空累计统计（自动化用例对比前后差值时用） */
  resetStats() {
    this.lapses = 0;
    this.mistakeFrames = 0;
  }

  /**
   * 找距离头部最近的身体节点，返回它相对头部的方位角（弧度）；没有则返回 null。
   * 脱离绕圈时用它来「背对着自己身体跑」——沿当前航向硬冲很可能正是
   * 冲向自己才收窄的那一圈身体。
   * @param {import('./snake.js').Snake} s
   */
  nearestBodyAngle(s) {
    const b = s.body;
    const hx = b[0].x, hy = b[0].y;
    let best = null;
    let bestD2 = Infinity;
    // 从第 6 节开始找：太靠前的颈部是「必然会跟着自己走」的一小段，
    // 拿它做方位参考会让蛇一直往回缩
    for (let k = 6; k < b.length; k += 2) {
      const dx = b[k].x - hx;
      const dy = b[k].y - hy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = Math.atan2(dy, dx);
      }
    }
    return best;
  }

  /**
   * 指令角一阶低通（τ≈0.09s）。
   * 决策频率约 13Hz、物理角速度上限 297~460°/s，如果指令直接阶跃，
   * 身体就只能长期贴着上限追（实测 60% 的帧如此），看起来就是
   * 「一抖一抖地急转」。低通让意图连续变化，转向自然变顺。
   * 注意：这是意图层平滑，物理限速仍在 Snake.update，不会导致瞬移转向。
   */
  lowpass(angle, dt) {
    if (this.smoothAngle === null) {
      this.smoothAngle = angle;
      return angle;
    }
    const k = 1 - Math.exp(-dt / 0.09);
    this.smoothAngle = normAngle(
      this.smoothAngle + normAngle(angle - this.smoothAngle) * k
    );
    return this.smoothAngle;
  }

  /**
   * 产出一帧的控制指令
   * @param {object} game 用来读 hazards / snakes / foods / tuning
   * @param {number} dt 秒
   * @param {number} now 秒（game.time）
   */
  think(game, dt, now) {
    const s = this.snake;
    if (!s.alive) return null;

    const head = s.body[0];
    // 复活 / 开局静止保护期：身体不动，但 Snake.update 会把 heading 直接
    // 对齐到指令角。这时还照常思考，重生瞬间就会「甩头」。
    // 直接输出当前航向，静止期结束的一刻再开始正常决策。
    if (s.isFrozen && s.isFrozen()) {
      return { angle: s.heading, turnEase: AI_TURN_EASE, wobble: 0 };
    }
    const cfg = CONFIG.ai;
    const D = cfg.difficulty;
    const ST = this.style || NEUTRAL_STYLE;   // 本局风格（中性 = 完全等价原逻辑）
    // Game 保存的就是页面里的 TUNING 对象；用 game.tuning 可以让自建 Game 的用例也生效
    const tune = game.tuning || TUNING;
    const level = clamp(Number.isFinite(tune.aiLevel) ? tune.aiLevel : D.level, D.levelMin, D.levelMax);
    const mistakeRate = clamp(
      Number.isFinite(tune.aiMistake) ? tune.aiMistake : D.mistakeRate,
      D.mistakeMin, D.mistakeMax
    );
    const weak = 1 - level;                                  // 0 = 满强度，1 = 最笨
    // ---- 压迫强度：难度 0.5 以下恒为 0，保证旧版行为逐位可复现 ----
    const pressure = computeAiPressure(tune);
    const hunt = cfg.hunt.enabled ? pressure : 0;
    const surv = cfg.survival.enabled ? pressure : 0;
    // 「大蛇守成」：领跑的长蛇不再冒险冲撞，并进一步强化自体 / 墙体 / 身体避让。
    // 旧版常出现「冠军蛇在最后一秒自爆清零 → 纯吃食物的玩家捡漏夺冠」，
    // 这条机制就是要把领先优势稳定保持到结算，逼玩家用吞并去跨过差距。
    const maturity = clamp((s.length - CONFIG.snake.startSegments) / 60, 0, 1) * surv;
    // 感知 / 避让力度倍率：难度是总开关，风格再乘一层（畏强看得更远、冒险看得更近）
    const sense = (D.senseFloor + (1 - D.senseFloor) * level) * ST.senseMul;
    // 自体避让强度：旧值 1-level 会随难度升高而消失（越聪明越自杀）。
    // 这里用 pressure 把它平滑地拉向 level；在 level = 0.5 处两者相等，
    // 所以低难度档与旧版完全一致，高难度档则越聪明越会保护自己。
    const oldGuard = 1 - level;
    const guard = clamp(oldGuard + (level - oldGuard) * surv + 0.35 * maturity, 0, 1);

// 转向能力每帧写入：难度滑块拖动后无需重开、无需重建 Brain
    // 注意：这里**不要**再按体型压低转向能力。
    // 试过「最小转弯半径 ≥ 身体半径 × 1.5」，结果是长蛇转不动、追不上侧前方
    // 的目标，只能以更大半径绕圈，反而让「绕一圈回到自己身上」更容易发生
    // （小半径快速绕圈时圈闭合点落在碰撞跳过区内，根本不会判死）。
    // 实测 60 节以上自撞率从三成涨到六成 —— 这个方向是错的。
    s.turnMul = this.skill * this.turnFactor(level);
    s.mistake = false;

    // ---------- 0. 走神失误 ----------
    // 失误期间完全跳过探路与觅食，固定沿用一条"打偏"的指令，
    // 于是 AI 会真的撞墙 / 撞身体 / 错过食物，而不是只做做样子。
    if (this.lapseUntil > 0 && now < this.lapseUntil) {
      s.mistake = true;
      this.mistakeFrames++;
      return this.lapseControl;
    }
    if (this.lapseUntil > 0) {
      // 刚回神：立刻重新决策，并给一小段冷却避免连续走神
      this.lapseUntil = 0;
      this.lapseControl = null;
      this.nextLapseAt = now + randRange(0.5, 1.4);
      this.nextDecisionAt = 0;
    }
    // 冒险型更容易走神、畏强/贪吃型更专注（只改频率，不改失误的表现形式）
    if (now >= this.nextLapseAt && mistakeRate > 0 &&
        Math.random() < D.lapsePerSec * mistakeRate * dt * ST.lapseMul) {
      const dur = randRange(D.lapseMinSec, D.lapseMaxSec);
      const dir = Math.random() < 0.5 ? -1 : 1;
      const off = randRange(D.lapseTurnMax * 0.45, D.lapseTurnMax) * dir;
      this.lapseUntil = now + dur;
      this.lapseControl = {
        angle: normAngle(s.heading + off),  // 朝错误方向打一把舵
        turnEase: AI_TURN_EASE,
        wobble: 0                           // 走神期间不摆，等价于旧版 bend: 0
      };
      this.lapses++;
      this.mistakeFrames++;
      s.mistake = true;
      return this.lapseControl;
    }

    // ---------- 0.6 防绕圈 ----------
    // 必须在「反应间隔」之前：反应间隔分支会沿用上一条指令直接 return，
    // 如果绕圈检测放在后面，蛇就可能一直沿用绕圈指令而不自觉。
    this.updateLoopGuard(head, s, now, dt);
    const loopEscaping = now < this.escapeUntil;

    // ---------- 0.5 反应间隔 ----------
    // 旧版每帧都重新决策（60Hz 完美反应）。难度低时隔一段时间才准重新算，
    // 中间沿用上一条指令，看起来就是"反应慢半拍"。
    // 但自体避让每帧都做：反应慢不能成为「一头撞进自己身体」的理由。
    // 脱离绕圈期间不沿用旧指令 —— 旧指令正是让人转圈的那条。
    if (!loopEscaping && now < this.nextDecisionAt && this.lastControl) {
      const base = this.lastControl;
      const safe = this.selfEscape(s, base.angle, guard);
      const a = this.lowpass(safe, dt);
      return a === base.angle ? base : { ...base, angle: a };
    }

    // ---------- 1. 选目标食物 ----------
    // 脱离绕圈期间不选新目标（刚放弃的那个已进黑名单），专心把直线跑出来
    if (!loopEscaping && (!this.target || now >= this.retargetAt)) {
      this.target = this.findFood(game, head, weak);
      // 难度低时锁定同一个目标更久，食物被抢走了也不及时改道
      this.retargetAt = now + randRange(0.4, 0.9) + D.retargetMaxSec * weak;
    }

    // 目标方向；没有食物就随机游走
    let desiredX = 0;
    let desiredY = 0;
    if (loopEscaping) {
      // 脱离期朝「最近身体节点」的反方向跑，而不是沿当前航向硬冲：
      // 绕圈时正前方往往正是自己那一圈身体，直冲等于撞上去。
      // 反方向若与当前航向夹角过大（身体在正后方），退回沿航向直行。
      let a = s.heading;
      const near = this.nearestBodyAngle(s);
      if (near !== null) {
        const away = normAngle(near + Math.PI);
        if (Math.abs(normAngle(away - s.heading)) < 1.2) a = away;
      }
      a = normAngle(a + this.escapeDir * CONFIG.ai.antiLoop.escapeTurn);
      desiredX = Math.cos(a);
      desiredY = Math.sin(a);
    } else if (this.target) {
      desiredX = this.target.x - head.x;
      desiredY = this.target.y - head.y;
    } else {
      this.wanderAngle += randRange(-1, 1) * dt * 1.6;
      desiredX = Math.cos(this.wanderAngle);
      desiredY = Math.sin(this.wanderAngle);
    }
    const dl = Math.hypot(desiredX, desiredY) || 1;
    desiredX /= dl;
    desiredY /= dl;

    // ---------- 2. 前方探路 ----------
    const probeDir = s.heading;
    const ax = Math.cos(probeDir);
    const ay = Math.sin(probeDir);
    // 生存能力：压迫档下探路更长、危险感知半径更大，墙与别人的身体都更早被发现
    const SV = cfg.survival;
    const probeDist = (cfg.probeDist + SV.wallProbeAdd * surv) * sense;
    // 大蛇身体更粗：避让半径按「自己半径多出来的部分」同步外扩，
    // 否则判定变粗了 AI 还按旧距离绕，长蛇会显得突然变笨、频繁擦到别人的身体。
    const girthExtra = snakeRadius(s.body.length) - CONFIG.snake.radius;
    const avoidR = (cfg.avoidRadius + girthExtra) * (1 + SV.senseAdd * surv) * sense;
    const wallPush = sense * (1 + SV.wallPushAdd * surv) * (1 + 0.40 * maturity);

    let avoidX = 0;
    let avoidY = 0;

    // 2.1 撞墙预判：把探针点往世界里"推"回来（难度低时探针更短、推力更弱）
    for (const d of [probeDist * 0.55, probeDist]) {
      const px = head.x + ax * d;
      const py = head.y + ay * d;
      const m = CONFIG.snake.wallPad + 30;
      if (px < m) avoidX += ((m - px) / 60) * wallPush;
      if (px > game.worldW - m) avoidX -= ((px - (game.worldW - m)) / 60) * wallPush;
      if (py < m) avoidY += ((m - py) / 60) * wallPush;
      if (py > game.worldH - m) avoidY -= ((py - (game.worldH - m)) / 60) * wallPush;
    }

    // 2.2 别人的身体 / 蛇头：越近斥力越大（感知半径随难度缩短）
    // 自己的身体不进斥力（会互相抵消），改由 selfEscape() 做航线级避让。
    const avoidR2 = avoidR * avoidR;
    for (const hz of game.hazards) {
      if (hz.owner === s) continue;
      // 只关心前方半圆内的危险，身后的不用管
      const vx = hz.x - head.x;
      const vy = hz.y - head.y;
      const d2 = vx * vx + vy * vy;
      if (d2 > avoidR2 || d2 < 1e-3) continue;
      const d = Math.sqrt(d2);
      if (vx * ax + vy * ay < 0) continue;
      const push = (1 - d / avoidR) / d;
      // 风格两层修正：
      //   avoidMul —— 冒险型敢贴身、稳健型正常避让
      //   fleeMul  —— 「畏强」的直观表现：对方明显比自己长时躲得更远
      const bigger = hz.owner && hz.owner.length > s.length * 1.15;
      const k = 1.6 * sense * ST.avoidMul * (bigger ? ST.fleeMul : 1);
      avoidX -= vx * push * k;
      avoidY -= vy * push * k;
    }

    // ---------- 3. 主动进攻 ----------
    // 难度低时门槛更高、发现距离更短、冲撞意愿更弱
    // 风格决定「敢不敢冲」：冒险 / 好斗门槛低，畏强 / 贪吃门槛高
    // 压迫档下把门槛 / 距离 / 权重整体拉到「敢围杀」的水平，并改用拦截点预判。
    const H = cfg.hunt;
    const baseRatio = cfg.attackRatio + D.attackBonus * weak;
    const attackRatio = (baseRatio + (H.ratio - baseRatio) * hunt) * ST.attackMul;
    const attackRange = 420 * (0.4 + 0.6 * level) + H.rangeAdd * hunt;
    let attackX = 0;
    let attackY = 0;
    for (const other of game.snakes) {
      if (other === s || !other.alive) continue;
      if (s.length < other.length * attackRatio) continue;
      const oh = other.body[0];
      if (dist2(head.x, head.y, oh.x, oh.y) > attackRange * attackRange) continue;

      // 拦截点：按对手当前速度与朝向，追它「将要到的位置」而不是当前蛇头。
      // hunt = 0 时 travel = 0、cut = 0、focus = 1，严格退回旧版追头逻辑。
      const travel = Math.min(
        H.leadMax,
        (other.speed || CONFIG.snake.baseSpeed) * H.leadSec * hunt
      );
      const ox = Math.cos(other.heading);
      const oy = Math.sin(other.heading);
      // 沿对手航线法线侧偏：把身体横在它前面（封路），左右由蛇 id 奇偶决定
      const cut = travel * H.cutIn * (s.id % 2 ? 1 : -1);
      const tx = oh.x + ox * travel - oy * cut;
      const ty = oh.y + oy * travel + ox * cut;
      // 「迎面检查」：从侧后方贴上去容易被判成「主动撞人的一方」而白送人头，
      // 所以正对目标时才全力冲，斜着追时收敛冲撞权重。hunt = 0 时恒为 1。
      const toX = oh.x - head.x;
      const toY = oh.y - head.y;
      const tl = Math.hypot(toX, toY) || 1;
      const facing = (ax * toX + ay * toY) / tl;      // 1 = 正对，-1 = 背对
      const charge = 1 - hunt + hunt * (0.35 + 0.65 * clamp((facing + 1) / 2, 0, 1));
      const vx = tx - head.x;
      const vy = ty - head.y;
      const il = Math.hypot(vx, vy) || 1;
      // 玩家是主要压迫目标：满压迫时 AI 更愿意绕过来堵玩家
      const focus = other.isPlayer ? 1 + (H.playerFocus - 1) * hunt : 1;
      const k = focus * charge * (1 - 0.60 * maturity);  // 大蛇守成：不拿领先去冒险
      attackX += (vx / il) * k;
      attackY += (vy / il) * k;
    }

    // ---------- 4. 合成期望方向 ----------
    const avLen = Math.hypot(avoidX, avoidY);
    let mixX = desiredX;
    let mixY = desiredY;

    if (avLen > 0.05) {
      // 危险越大，避让权重越高；难度低时这份"警觉"整体打折
      // foodWeight 是风格里「追食物」的基础权重：贪吃型几乎不理会避让，
      // 好斗型更愿意为了冲撞偏离食物。
      const w = clamp(avLen, 0, 2.2) * sense * (1 + 0.50 * maturity);
      mixX = desiredX * ST.foodWeight + (avoidX / avLen) * w;
      mixY = desiredY * ST.foodWeight + (avoidY / avLen) * w;
    }
    if (attackX !== 0 || attackY !== 0) {
      const aggression = (0.8 + H.aggressionAdd * hunt) * (0.25 + 0.75 * level) * ST.aggressionMul;
      mixX += attackX * aggression;
      mixY += attackY * aggression;
    }

    const ml = Math.hypot(mixX, mixY) || 1;
    let angle = Math.atan2(mixY / ml, mixX / ml);

    // ---------- 4.5 转向幅度约束 ----------
    // 只做一道很宽的兜底（92°），防止方向在一帧内直接反号。
    // 以前这里是 60°，配合 13Hz 决策其实拦不住「持续单向转」，
    // 反而在目标位于侧后方时把 AI 逼成一圈圈绕 —— 真正的平滑交给 4.7 的低通。
    const maxDelta = 1.6;
    const delta = normAngle(angle - s.heading);
    angle = normAngle(s.heading + clamp(delta, -maxDelta, maxDelta));

    // ---------- 4.6 低频瞄准抖动 ----------
    // 每帧白噪声会被转向控制器平均掉，所以改成 0.45~1.1s 才换一次的偏置，
    // 难度低时 AI 会持续朝偏一点的方向走（"手抖 / 瞄不准"）。
    // 目标值改成插值逼近：原来是阶跃，每 0.45~1.1s 会「啪」地跳一下
    // （低难度下单次可达 31°），这是转身突兀的来源之一。
    if (now >= this.biasAt) {
      this.aimBiasTarget = randRange(-1, 1) * D.aimNoiseMax * weak;
      this.biasAt = now + randRange(0.45, 1.1);
    }
    this.aimBias += (this.aimBiasTarget - this.aimBias) * clamp(dt * 6, 0, 1);
    angle = normAngle(angle + this.aimBias);

    // ---------- 4.7 避让 + 意图低通 ----------
    // 顺序很关键：先让安全兜底即时生效，再统一过一遍低通。
    // 反过来（先低通再避让）会让避让每帧直接跳到另一个方向，
    // 实测方向反转高达 7~9 次/秒 —— 那正是「蛇头抽搐」的观感来源。
    angle = this.selfEscape(s, angle, guard);
    angle = this.lowpass(angle, dt);

    // ---------- 5. 航线摆动（让它也走蛇形）----------
    // 与旧版完全等价：原来 bend 在 Snake.update 里乘 elbowWeight × elbowBiasGain
    // 变成瞄准偏置，这里直接算成同一个弧度值交给 control.wobble。
    // 随机流消耗顺序不变（仍是每帧一次 randRange），保护自撞率统计的可复现性。
    this.wobblePhase += dt * randRange(1.6, 2.6);
    const wobble = Math.sin(this.wobblePhase) * this.wobbleAmp * AI_WOBBLE_GAIN;

    const control = {
      angle,
      // 旧版 extend: 0.62 对应的转向倍率，改成中性命名但数值不变
      turnEase: AI_TURN_EASE,
      wobble
    };
    this.lastControl = control;
    this.nextDecisionAt = now + D.reactionMaxSec * weak;
    return control;
  }

  /**
   * 找最近的食物（在附近没有就直接放弃，交给游走）
   * 难度低时有一定概率故意挑第 2~6 近的，而不是最优解 —— 这是"不聪明"最直观的表现。
   * @param {number} weak 1 - 难度系数
   */
  findFood(game, head, weak) {
    let best = null;
    let bestScore = Infinity;   // 加权距离（贪吃型会把金果「看近」一点）
    let bestD2 = Infinity;       // 真实距离平方，用于「太远就放弃」的判断
    const foods = game.foods;
    const near = this.nearest;
    near.length = 0;
    const D = CONFIG.ai.difficulty;
    const ST = this.style || NEUTRAL_STYLE;

    for (let i = 0; i < foods.length; i++) {
      const f = foods[i];
      // 刚被判定「追不到」而放弃的食物：黑名单期内跳过。
      // 不跳过的话，脱离期一结束它又会成为最近的目标，蛇立刻回到同一个死角。
      if (f === this.avoidFood && game.time < this.avoidFoodUntil) continue;
      const dx = f.x - head.x;
      const dy = f.y - head.y;
      // 只追前方视野内的食物：身后的要掉头，掉头就是绕圈的前奏
      if (Math.abs(normAngle(Math.atan2(dy, dx) - this.snake.heading)) > CONFIG.ai.foodFov) continue;
      const d2 = dx * dx + dy * dy;
      const score = d2 * (f.big ? ST.bigFoodBias : 1);
      if (score < bestScore) {
        bestScore = score;
        bestD2 = d2;
        best = f;
      }
      // near 里的 d2 字段存的是「加权分数」，排序用它，挑错食物也按它
      if (near.length < 6 || score < near[near.length - 1].d2) {
        near.push({ f, d2: score });
        near.sort((a, b) => a.d2 - b.d2);
        if (near.length > 6) near.pop();
      }
    }

    // 最近的食物太远就不追了，改成游走探索，避免全场抢同一个
    if (!best || bestD2 > CONFIG.ai.wanderRadius * CONFIG.ai.wanderRadius) {
      this.wanderAngle = Math.atan2(head.y - game.worldH / 2, head.x - game.worldW / 2) + Math.PI
        + randRange(-0.7, 0.7);
      return null;
    }

    // 难度 1 时概率为 0，严格返回原来的"最近食物"；
    // 风格只调整「挑错食物」的概率，贪吃型几乎不挑错。
    if (weak > 0 && near.length > 1 &&
        Math.random() < D.sloppyFoodMax * weak * ST.sloppyMul) {
      return near[1 + Math.floor(Math.random() * (near.length - 1))].f;
    }
    return best;
  }

  /** 目标被吃掉后清掉引用，下一帧会重新选 */
  forgetTarget(food) {
    if (this.target === food) {
      this.target = null;
      this.retargetAt = 0;
    }
  }
}
