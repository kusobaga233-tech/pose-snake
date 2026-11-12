/**
 * 世界与规则
 * ------------------------------------------------------------
 * 负责：蛇的集合、食物池、碰撞裁决、复活计时、单局倒计时与长度排名结算。
 *
 * 碰撞规则（按用户设定）：
 *   - 头撞墙 / 头撞自己身体        → 死
 *   - 头撞别的蛇的躯干            → 死
 *   - 头撞别的蛇的头              → 长的吃掉短的（等长时玩家赢）
 *   - 任何蛇死亡，身体瞬间散落成食物
 *   - 玩家 3 秒复活，AI 3 秒后在远处重生，场上恒定 7 只 AI（合计 8 位玩家）
 *   - 单局 2 分钟：时间到按「结束瞬间的长度」排名，不采用积分制（用户确认）
 *   - 每局给 7 只 AI 随机洗牌分配游戏风格；道具全场可拾取
 *
 * 道具：加速 / 磁铁，全场定时刷新，碰到即拾取（默认只有玩家可拾取）。
 * 详见 CONFIG.powerups 与文件末尾「道具」一节。
 */

import { CONFIG, WORLD, TUNING, computeAiPressure, snakeRadius } from './config.js';
import { Snake } from './snake.js';
import { Brain } from './ai.js';
import { clamp, pick, randRange, dist2, safeStorage } from './utils.js';

// AI 配色：玩家的渐变占据绿→青→蓝（约 70°~205°）这一段，
// 所以 AI 全部落在剩下的 210°~40° 弧上，8 个色相均匀间隔约 26°，
// 远看也不会糊成一片同色。
const AI_COLORS = [
  '#5C8AFF', // 215° 蓝
  '#7F5CFF', // 241° 蓝紫
  '#A55CFF', // 267° 紫
  '#D05CFF', // 293° 紫红
  '#FF5CD0', // 319° 品红
  '#FF5C8A', // 345° 玫红
  '#FF6B5C', // 11°  朱红
  '#FF9E5C'  // 37°  橙
];

const FOOD_COLORS = ['#FF4D9D', '#FFD93D', '#5BC8FF', '#9D6BFF', '#4DEFA8', '#FF8A4D'];
const FOOD_FACES = ['happy', 'wink', 'wide', 'tongue', 'sleepy'];

export class Game {
  /**
   * @param {object} fx 特效系统
   * @param {object} tuning 运行时手感参数（{turnRate, slowStrength, slowScale}）
   */
  constructor(fx, tuning) {
    this.fx = fx;
    this.tuning = tuning;

    this.worldW = WORLD.w;
    this.worldH = WORLD.h;

    this.state = 'ready';       // ready | playing | finished
    this.time = 0;              // 累计游戏时间（秒）
    // 用户确认「去掉积分制」：score 只保留为内部累计统计（体感日志、
    // 自动化用例仍会读它），不再出现在 HUD、也不参与排名 / 胜负。
    this.score = 0;
    this.best = Number(safeStorage.getItem('poseSnakeBest2') || 0); // 旧纪录，不再更新
    // 历史最长长度：取代旧的「最高分」，作为跨局的长期目标
    // 至少是起始节数：新玩家第一次打开 HUD 不该显示「历史最长 0 节」
    this.bestLength = Math.max(
      CONFIG.snake.startSegments,
      Number(safeStorage.getItem(CONFIG.round.bestLengthKey) || 0)
    );
    this.kills = 0;
    this.deaths = 0;

    // ---- 单局：2 分钟限时 + 结束瞬间长度排名 ----
    this.roundIndex = 0;        // 第几局（给风格洗牌一个可复现又每局不同的种子）
    this.roundRnd = 0x51ED270B; // 单局专用随机流，绝不消耗 Math.random()
    this.roundLeft = CONFIG.round.durationSec;
    this.ranking = [];          // 结算时的 8 名快照
    this.roundResult = null;    // 结算结果（玩家名次 / 是否获胜）

    this.snakes = [];
    // 真人玩家数量：1 = 单人（1 真人 + 7 AI），2 = 双人分屏（2 真人 + 6 AI）。
    // 场上总人数恒为 CONFIG.round.totalPlayers，结算永远是 8 列。
    this.playerCount = 1;
    this.players = [];          // 真人蛇数组，players[0] 恒为玩家 1
    this.player = null;         // = players[0]，旧代码（AI / 渲染 / 调试）继续可用
    this.playerSpawns = [];     // 每条真人蛇的固定出生点
    this.camTargets = [];       // 每条真人蛇一个相机注视点（双人分屏各跟各的）
    this.brains = [];
    this.foods = [];
    this.foodSpawnCd = 0;       // 下一批食物的冷却（真实秒，见 ensureFood）
    this.powerups = [];         // 场上的道具（{x,y,type,color,label,...}）
    this.powerupSpawnTimer = 0; // 补下一个道具的倒计时（真实秒）
    // 道具专用的独立随机流（xorshift32）。绝不消耗 Math.random()：
    // 所有 AI 统计脚本都在页面加载前锁定了随机流，多消耗一次就会让
    // 整条模拟轨迹分叉，之前标定好的「自撞占比 30%」会立刻失真。
    this.powerupRnd = 0x9E3779B9;
    this.magnetClaimed = new Set(); // 本帧已被某条磁铁认领的食物下标，避免两条磁铁互相拉扯
    this.hazards = [];          // 每帧重建的"危险点"（身体采样点），供 AI 与刷食物用

    // 相机注视点（玩家头部，死亡时停在原处）
    this.camTarget = { x: WORLD.w / 2, y: WORLD.h / 2 };

    this.buildSnakes();
    this.reset();
  }

  /**
   * 创建真人玩家 + AI（对象复用，重开时只重置状态）
   * ------------------------------------------------------------
   * 场上总人数恒为 CONFIG.round.totalPlayers（8）：
   *   1 人模式 = 1 真人 + 7 AI；2 人模式 = 2 真人 + 6 AI。
   * 所以双人模式不会把 AI 挤多，结算页也永远是 8 列。
   */
  buildSnakes() {
    const C = CONFIG.round;
    const n = clamp(this.playerCount | 0, 1, 2);

    this.players = [];
    this.snakes = [];
    this.brains = [];

    // ---- 真人玩家 ----
    for (let i = 0; i < n; i++) {
      const pc = C.playerColors[i % C.playerColors.length];
      const s = new Snake({
        id: i,
        isPlayer: true,
        playerIndex: i,
        color: pc.color,
        headColor: pc.head,
        grad: pc.grad,
        name: C.playerNames[i] || ('玩家 ' + (i + 1))
      });
      this.players.push(s);
      this.snakes.push(s);
    }
    this.player = this.players[0];

    // ---- AI：补满 totalPlayers ----
    const aiCount = Math.max(0, C.totalPlayers - n);
    for (let i = 0; i < aiCount; i++) {
      const s = new Snake({
        id: n + i,
        isPlayer: false,
        color: AI_COLORS[i % AI_COLORS.length],
        name: 'AI ' + (i + 1),
        speedMul: 1 - randRange(-1, 1) * CONFIG.ai.speedJitter
      });
      this.snakes.push(s);
      this.brains.push(new Brain(s));
    }

    // ---- 出生点：双人模式左右分开，避免开局两条蛇叠在一起 ----
    const px = WORLD.w / 2;
    const py = WORLD.h / 2;
    const gap = n > 1 ? 620 : 0;
    this.playerSpawns = this.players.map((s, i) => ({
      x: px + (i === 0 ? -gap / 2 : gap / 2) * (n > 1 ? 1 : 0),
      y: py
    }));

    // ---- 相机注视点：camTarget 恒等于 players[0] 的那一个（旧代码继续读它） ----
    const first = { x: px, y: py };
    this.camTargets = [first];
    for (let i = 1; i < this.players.length; i++) {
      this.camTargets.push({ x: px, y: py });
    }
    this.camTarget = first;
  }

  /**
   * 切换真人数（1 / 2），会重建蛇群并重置世界。
   * 只允许在「未开局 / 结算后」调用——局内切人数等于换一局。
   * @returns {number} 实际生效的人数
   */
  setPlayerCount(n) {
    const v = n >= 2 ? 2 : 1;
    if (v === this.playerCount && this.players.length === v) return this.playerCount;
    this.playerCount = v;
    this.buildSnakes();
    this.reset();
    return this.playerCount;
  }

  /** 重置到初始状态（不发车，等玩家举手/按键） */
  reset() {
    this.state = 'ready';
    this.time = 0;
    this.score = 0;
    this.kills = 0;
    this.deaths = 0;
    this.foods.length = 0;
    this.powerups.length = 0;

    // ---- 新一局：倒计时 / 排名 / 结算清零 ----
    this.roundLeft = CONFIG.round.durationSec;
    this.ranking = [];
    this.roundResult = null;
    // 局序号递增 → 风格组合每局不同，但同一局序号可复现（统计脚本需要）
    this.roundIndex++;
    this.roundRnd = (0x51ED270B ^ Math.imul(this.roundIndex, 2654435761)) >>> 0;
    // 每条蛇的本局统计归零（Snake.reset 是复活用的，不能清这些）
    for (const s of this.snakes) {
      s.kills = 0;
      s.foodEaten = 0;
      s.deaths = 0;
      s.peakLength = CONFIG.snake.startSegments;
      s.style = null;
      s.mistake = false;
    }

    // 真人玩家：每人一个固定出生点，双人模式左右分开
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      const sp = this.playerSpawns[i] || this.playerSpawns[0];
      p.reset(sp.x, sp.y, 0, CONFIG.snake.startSegments);
      p.immuneUntil = 0;
      p.freezeUntil = 0;
      const t = this.camTargets[i];
      if (t) { t.x = sp.x; t.y = sp.y; }
    }

    // AI 撒在远处。注意要一个个放：s.reset() 之后 alive 才为 true，
    // 后面的 spawnPoint 才能把它算进"要避开的蛇"里。
    for (const s of this.snakes) {
      if (s.isPlayer) continue;
      const p = this.spawnPoint(900);
      // 朝向必须指向世界中心附近，否则随机朝向可能直接朝墙外飞，
      // 出生 1 秒内就撞墙（实测会导致开局 AI 少 2 只）
      s.reset(p.x, p.y, this.inwardHeading(p.x, p.y), CONFIG.snake.startSegments);
      s.kills = 0;
      s.foodEaten = 0;
      s.mistake = false;
    }
    // 新的一局要清掉上一局残留的决策缓存 / 走神状态，
    // 否则 game.time 归零后 nextDecisionAt 还停在上一局的大数值，
    // 开局几秒内 AI 会一直沿用旧方向。
    for (const brain of this.brains) brain.resetForNewRound();
    // 每局随机洗牌分配游戏风格（冒险 / 畏强 / 贪吃 / 好斗 / 稳健）
    this.assignStyles();
    // 每局随机洗牌分配蛇头造型（一局之内不重复，见 js/heads.js）
    this.assignHeadStyles();

    // 铺满食物
    for (let i = 0; i < CONFIG.food.targetCount; i++) this.foods.push(this.randomFood());
    // 开局是满的，冷却归零，第一处缺口出现时可以立刻补一批
    this.foodSpawnCd = 0;

    this.camTarget.x = this.player.body[0].x;
    this.camTarget.y = this.player.body[0].y;
    this.rebuildHazards();
    // 开局直接铺满道具；之后每被拾取一个，隔 spawnSec 秒再补一个。
    // 固定种子让每局道具分布可复现，且只用独立随机流（不碰 Math.random）。
    const P = CONFIG.powerups;
    this.powerupRnd = 0x9E3779B9;
    this.powerupSpawnTimer = P.spawnSec;
    // 关掉道具开关时场上一个都不该有（现场 A/B 对照用）
    if (P.enabled) {
      for (let i = 0; i < P.targetCount; i++) this.powerups.push(this.randomPowerup());
    }
  }

  /**
   * 生成一个"朝世界内部"的朝向，带随机偏转
   * 用于所有出生点，避免一出生就贴着墙往外冲
   */
  inwardHeading(x, y) {
    const toCenter = Math.atan2(this.worldH / 2 - y, this.worldW / 2 - x);
    return toCenter + randRange(-0.85, 0.85);
  }

  /**
   * 静止保护期时长（秒）
   * 由页面滑块 TUNING.respawnFreeze 运行时覆盖，config 里的值只是默认值。
   * 玩家与 AI 共用同一个值，规则统一。
   */
  freezeSec() {
    const F = CONFIG.player;
    const v = Number.isFinite(this.tuning.respawnFreeze)
      ? this.tuning.respawnFreeze
      : F.respawnFreeze;
    return clamp(v, F.respawnFreezeMin, F.respawnFreezeMax);
  }

  /** 给一条刚出生的蛇挂上「静止保护期」（玩家 / AI 通用） */
  applySpawnFreeze(snake) {
    snake.freezeUntil = performance.now() + this.freezeSec() * 1000;
  }

  /** 开局 */
  start() {
    this.reset();
    // 开局给一段无敌，避免刚发车就被附近 AI 撞死（实测约 25% 的开局 1.6 秒内阵亡）。
    // 初次出生也走同一套静止保护：先原地待命 0.3 秒，玩家摆好方向再出发。
    // 双人模式下两位玩家各算各的，互不影响。
    for (const p of this.players) {
      p.immuneUntil = performance.now() + CONFIG.player.immunity * 1000;
      this.applySpawnFreeze(p);
    }
    this.state = 'playing';
  }

  // ------------------------------------------------------------
  // 单局：随机流 / 风格分配 / 排名 / 结算
  // ------------------------------------------------------------
  /**
   * 单局专用随机数（xorshift32）。
   * 与 Math.random 完全隔离：风格洗牌不该改变食物分布、AI 出生点、
   * 粒子特效等既有随机序列，否则所有 20 种子统计对照都会分叉。
   */
  roundRandom() {
    let x = this.roundRnd >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.roundRnd = x >>> 0;
    return this.roundRnd / 4294967296;
  }

  /** 每局给 7 只 AI 洗牌分配风格，保证尽量覆盖到多种性格 */
  assignStyles() {
    const S = CONFIG.ai.styles;
    const pool = S.enabled ? S.pool.slice() : [];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.roundRandom() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    for (let i = 0; i < this.brains.length; i++) {
      this.brains[i].setStyle(pool.length ? pool[i % pool.length] : null);
    }
    this.player.style = null;
    for (const p of this.players) p.style = null;
  }

  /**
   * 每局给 7 只 AI 洗牌分配蛇头造型，一局之内保证不重复
   * ------------------------------------------------------------
   * 池子有 9 款、AI 只有 7 只，所以洗牌后顺次取前 7 个就是「不重复」，
   * 每局还会有 2 款没上场，换局才出现新组合。
   * 随机数走单局专用流 roundRandom()：同一局序号可完整复现，
   * 不回落到 Math.random()（统计脚本锁定随机流后不能被扰动）。
   * 玩家永远是原版蛇头，不参与分配。
   */
  assignHeadStyles() {
    const H = CONFIG.ai.headStyle;
    const on = H.enabled && TUNING.headStyleOn;
    const pool = on ? H.pool.slice() : [];

    // Fisher-Yates 洗牌
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.roundRandom() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }

    // 真人蛇不参与分配；AI 顺次取洗好的前 N 款，一局之内保证不重复
    let k = 0;
    for (const s of this.snakes) {
      if (s.isPlayer) {
        s.headStyle = null;
        continue;
      }
      s.headStyle = k < pool.length ? pool[k] : null;
      k++;
    }
  }

  /**
   * 生成「按长度」的排名快照，游戏中实时榜与结算页共用同一套口径。
   * 结束瞬间处于复活倒计时的蛇长度记 0（死亡时身体已清空），
   * 与 io 类「死亡清零」一致；同长度依次比：死亡少 → 吞并多 → 峰值长 → id。
   * @returns {Array} 已排序并写好 rank 的行
   */
  rankSnapshot() {
    const rows = this.snakes.map((s) => ({
      snake: s,
      id: s.id,
      name: s.name,
      color: s.color,
      isPlayer: s.isPlayer,
      playerIndex: s.playerIndex,
      style: s.style ? s.style.label : '',
      // 结算舞台直接复用局内造型（NPC 的搞怪头），这里把 key 一起带出去
      headStyle: s.headStyle || null,
      length: s.alive ? s.length : 0,
      peakLength: s.peakLength,
      kills: s.kills,
      deaths: s.deaths,
      foodEaten: s.foodEaten
    }));
    rows.sort((a, b) =>
      b.length - a.length ||
      a.deaths - b.deaths ||
      b.kills - a.kills ||
      b.peakLength - a.peakLength ||
      a.id - b.id
    );
    for (let i = 0; i < rows.length; i++) rows[i].rank = i + 1;
    return rows;
  }

  /** 实时榜（HUD 每帧读取；8 行排序开销可忽略） */
  get liveRanking() {
    return this.rankSnapshot();
  }

  /** 玩家当前名次（未结算时按实时榜算）；默认取玩家 1 */
  get playerRank() {
    if (this.state === 'finished' && this.roundResult) return this.roundResult.playerRank;
    return this.rankOf(this.player);
  }

  /** 指定蛇的当前名次（双人模式各自的名次都从这里取） */
  rankOf(snake) {
    const rows = this.rankSnapshot();
    const me = rows.find((r) => r.snake === snake);
    return me ? me.rank : rows.length;
  }

  /**
   * 时间到：冻结世界并生成结算。
   * 不管玩家此刻是在复活倒计时还是 0.3 秒静止保护期，都直接结算，
   * 倒计时不等人（主流限时模式的做法）。
   */
  finishRound() {
    if (this.state === 'finished') return;
    this.state = 'finished';
    this.ranking = this.rankSnapshot();
    // 双人模式：两条真人蛇各有各的名次；player / playerRank / won 仍指玩家 1，
    // 保持既有结算页与调试接口（roundResult.playerRank）向后兼容。
    const mine = this.ranking.filter((r) => r.isPlayer);
    const me = mine[0] || null;
    this.roundResult = {
      total: this.ranking.length,
      playerRank: me ? me.rank : this.ranking.length,
      won: !!(me && me.rank === 1),
      player: me,
      players: mine,
      bestLength: this.bestLength,
      mode: CONFIG.round.mode,
      durationSec: CONFIG.round.durationSec
    };
  }

  // ------------------------------------------------------------
  // 每帧更新
  // ------------------------------------------------------------
  /**
   * @param {number} dt 秒（已应用时间缩放，用于物理模拟）
   * @param {object|object[]} signal 体感信号；双人模式传数组（[P1, P2]）
   * @param {number} realDt 秒（真实流逝时间，用于复活倒计时）
   *   为什么分开：主循环为了防止切标签页回来"瞬移"，把 dt 钳在 0.05 以内。
   *   帧率低于 20fps 时模拟时间会比真实时间慢，倒计时若用 dt 就会被拉长（实测 3s 变 6s）。
   *   倒计时是给玩家看的承诺，必须走真实时间。
   */
  update(dt, signal, realDt = dt) {
    if (this.state !== 'playing') return;

    // 兼容两种调用：单信号（旧的自动化用例）与信号数组（双人分屏）
    const signals = Array.isArray(signal) ? signal : [signal];
    // ---- 0. 单局倒计时（真实秒）----
    // 暂停时主循环不调用 update → 自动冻结；击杀顿帧缩放的是物理 dt，
    // 这里收 realDt，所以「2 分钟」不会被拉长，与复活 / 道具倒计时同口径。
    // 无尽练习档（mode = 'endless'）完全跳过这一段，行为等同旧版。
    if (CONFIG.round.mode === 'timed') {
      this.roundLeft -= realDt;
      if (this.roundLeft <= 0) {
        this.roundLeft = 0;
        this.finishRound();
        return;
      }
    }

    this.time += dt;
    this.rebuildHazards();
    // 道具倒计时走真实时间：暂停时主循环不调用 update，剩余时间自动冻结；
    // 击杀顿帧把 dt 缩到 0.12 倍时也不会把 5 秒悄悄拉长成 40 秒。
    for (const s of this.snakes) s.tickBuffs(realDt);

    // ---- 1. 玩家控制（双人模式各自一份信号）----
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      // 双人模式信号不足时退回玩家 1 的那一份，绝不让 P2 变成 NaN 方向
      const sig = signals[i] || signals[0];
      if (!sig) continue;

      if (p.alive) {
        // 方向只认「手腕相对圆心的角度」；速度倍率由手腕距离单独给出。
        // 没识别到手时不给控制量：保持当前方向与上一帧速度直行，
        // 既不会乱转，也不会突然跳回基准速度。
        const control = (sig.seen || sig.hold)
          ? { angle: sig.angle, speedScale: sig.speedScale ?? 1 }
          : null;
        p.update(dt, control, this.tuning);
        this.updatePlayerLookAt(p);
      } else {
        // 死亡期间只累加复活倒计时（走真实时间）
        p.respawnTimer -= realDt;
        if (p.respawnTimer <= 0) this.respawnPlayer(p);
      }
    }

    // ---- 2. AI ----
    for (let i = 0; i < this.brains.length; i++) {
      const brain = this.brains[i];
      const s = brain.snake;
      if (!s.alive) {
        s.mistake = false;
        s.respawnTimer -= realDt;
        if (s.respawnTimer <= 0) this.respawnAI(s);
        continue;
      }
      const control = brain.think(this, dt, this.time);
      s.update(dt, control, this.tuning);
    }

    // ---- 3. 碰撞 ----
    this.resolveCollisions();

    // ---- 4. 道具 + 食物 ----
    // 顺序有讲究：先把磁铁范围内的食物吸过来，再判定拾取道具，
    // 最后才吃食物 —— 被吸到嘴边的食物当帧就能吃到，不用多等一帧。
    this.applyMagnets(dt);
    this.collectPowerups();
    this.eatFood();
    this.ensureFood(realDt);
    this.ensurePowerups(realDt);

    // ---- 5. 相机注视点（每条真人蛇各一份，双人分屏各跟各的）----
    for (const p of this.players) {
      if (!p.alive || !p.body.length) continue;
      const t = this.camTargets[p.playerIndex];
      if (!t) continue;
      const h = p.body[0];
      t.x = h.x;
      t.y = h.y;
    }

    // ---- 6. 本局统计（峰值长度 / 历史最长长度）----
    // 放在帧末：吃的食物、吞并、碰撞都在前面结算完了，这里读到的是最终长度。
    for (const s of this.snakes) {
      if (s.alive && s.length > s.peakLength) s.peakLength = s.length;
    }
    // 「历史最长」按所有真人蛇里最长的那条记：双人模式谁破纪录都算数
    for (const p of this.players) {
      if (p.peakLength > this.bestLength) {
        this.bestLength = p.peakLength;
        safeStorage.setItem(CONFIG.round.bestLengthKey, String(this.bestLength));
      }
    }
  }

  /** 玩家眼神看向最近的食物，纯表现 */
  updatePlayerLookAt(snake = this.player) {
    if (!snake.body.length) return;
    const h = snake.body[0];
    let best = null;
    let bestD2 = 520 * 520;
    for (let i = 0; i < this.foods.length; i++) {
      const f = this.foods[i];
      const d2 = dist2(h.x, h.y, f.x, f.y);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = f;
      }
    }
    snake.lookAt = best;
  }

  /** 重建危险点表（身体采样，供 AI 避让与食物刷新判重） */
  rebuildHazards() {
    const arr = this.hazards;
    arr.length = 0;
    for (let i = 0; i < this.snakes.length; i++) {
      const s = this.snakes[i];
      if (!s.alive) continue;
      const b = s.body;
      for (let k = 0; k < b.length; k += 2) {
        arr.push({ x: b[k].x, y: b[k].y, owner: s });
      }
    }
  }

  // ------------------------------------------------------------
  // 碰撞裁决
  // ------------------------------------------------------------
  resolveCollisions() {
    const snakes = this.snakes;

    // ---- 1. 墙 + 自身 ----
    // 玩家用标准自撞判定；AI 可略微宽容（擦边不死），见 CONFIG.ai.selfHit。
    // 只放宽判定、不改运动与决策，避免 AI 绕小圈时频繁自己咬死自己。
    const SH = CONFIG.ai.selfHit;
    for (const s of snakes) {
      if (!s.alive || s.isImmune()) continue;
      const selfHit = s.isPlayer ? s.hitSelf() : s.hitSelf(SH.skip, SH.radiusMul);
      if (s.hitWall() || selfHit) {
        s.clampToWorld();
        this.killSnake(s, null);
      }
    }

    // ---- 2. 头撞头：按撞击角度判定（贪吃蛇大作战规则）----
    //
    // 规则原文：「判定是你的正面撞了别人的侧面还是别人撞了你的侧面；
    //            判定死亡的肯定是撞人的一方」
    //          「如果同时两个人是正面相撞，体积大的一方存活」
    //
    // 翻译成几何：
    //   aCharge = a 的朝向 · (a→b 方向)，代表 a"朝着 b 冲"的程度
    //   bCharge = b 的朝向 · (b→a 方向)，代表 b"朝着 a 冲"的程度
    //   - 双方都 >= 阈值 → 正面相撞 → 长的赢，等长双亡
    //   - 否则 → 谁更主动地撞过去，谁就是"撞人的一方"，谁死
    const C = CONFIG.collide;

    for (let i = 0; i < snakes.length; i++) {
      const a = snakes[i];
      if (!a.alive || a.isImmune()) continue;

      for (let j = i + 1; j < snakes.length; j++) {
        const b = snakes[j];
        if (!b.alive || b.isImmune() || !a.alive) continue;

        const ha = a.body[0];
        const hb = b.body[0];
        // 头部判定圈按「双方半径的平均值」取：两条大蛇靠近时判定自然变大，
        // 小蛇穿大蛇旁边时也不会被大蛇的体型单方面放大成必撞。
        const headR = (snakeRadius(a.length) + snakeRadius(b.length)) * 0.5 * C.headRadius;
        if (dist2(ha.x, ha.y, hb.x, hb.y) > headR * headR) continue;

        // a → b 的单位向量
        const dx = hb.x - ha.x;
        const dy = hb.y - ha.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-6) continue;   // 完全重合，交给躯干判定处理
        const nx = dx / d;
        const ny = dy / d;

        // 各自朝对方冲的程度（1=正对，0=横穿，-1=背对）
        const aCharge = Math.cos(a.heading) * nx + Math.sin(a.heading) * ny;
        const bCharge = Math.cos(b.heading) * (-nx) + Math.sin(b.heading) * (-ny);

        if (aCharge >= C.headOnCos && bCharge >= C.headOnCos) {
          // ===== 正面相撞：长度决胜 =====
          if (a.length === b.length) {
            if (C.evenLengthBothDie) {
              // 大作战规则：等长则同归于尽，谁都没吃到
              // 这条规则玩家容易困惑，所以给个明确的提示
              if (a.isPlayer || b.isPlayer) {
                const ph = a.isPlayer ? ha : hb;
                this.fx.floatText(ph.x, ph.y - 80, '同归于尽', '#FFC53D', 44);
              }
              this.killSnake(a, null);
              this.killSnake(b, null);
            }
            // 若关掉了双亡，则视为擦身而过，两边都活着
          } else {
            const winner = a.length > b.length ? a : b;
            const loser = winner === a ? b : a;
            this.headOnEat(winner, loser);
          }
        } else {
          // ===== 侧面相撞：主动撞人的一方死 =====
          // aCharge 更大 → a 是主动方 → a 死
          const victim = aCharge > bCharge ? a : b;
          const survivor = victim === a ? b : a;
          this.killSnake(victim, survivor);
        }
      }
    }

    // ---- 3. 头撞别人躯干 ----
    // 判定半径略小于视觉半径，给体感操作留一点容错；粗细同样按「被撞那条蛇」
    // 的当前半径缩放 —— 大蛇身体更粗，绕过它需要留出更多空间。
    // 对方头部区域内的身体节交给上面的"头撞头"裁决，这里不再重复判定。
    // 之前是从第 8 节开始扫，而第 8 节离头部 144px、头部判定只有 45px，
    // 中间 99px 是一段"撞了也不死"的判定真空。

    for (const s of snakes) {
      if (!s.alive || s.isImmune()) continue;
      const h = s.body[0];

      for (const other of snakes) {
        if (other === s || !other.alive) continue;

        const otherR = snakeRadius(other.length);
        // 我的头已经进入对方头部判定圈 → 这段关系由"头撞头"裁决，这里跳过
        const zoneR = otherR * C.headRadius;
        if (dist2(h.x, h.y, other.body[0].x, other.body[0].y) < zoneR * zoneR) continue;

        const bodyR2 = Math.pow(otherR * 0.78, 2);
        const b = other.body;
        // 从第 2 节开始（第 1 节基本都在头部判定区域内）
        for (let k = 2; k < b.length; k++) {
          if (dist2(h.x, h.y, b[k].x, b[k].y) < bodyR2) {
            this.killSnake(s, other);
            break;
          }
        }
        if (!s.alive) break;
      }
    }
  }

  /**
   * 正面相撞且长短分明：长者吞掉短者
   * 记账与成长统一交给 killSnake → rewardKill，避免正面吞并 / 侧面撞人 /
   * 逼对手撞进自己身体这三种击杀方式出现三套不同的奖励口径。
   */
  headOnEat(winner, loser) {
    // 输家死亡（尸体化作食物）；killSnake 会在清空身体前读出输家长度
    this.killSnake(loser, winner, true);
  }

  /**
   * 统一结算「让对手死亡」的收益
   * ------------------------------------------------------------
   * 以前只有正面相撞长者胜才长 5 节并记功，侧面撞人、围杀（逼对手撞进
   * 自己身体）都不算击杀。现在三种一视同仁，并按输家节数折算成长：
   * 吃食物是线性累积，吞并是跳跃式收益，于是领跑 AI 靠互吞滚雪球，
   * 玩家不击杀就追不上结束瞬间的长度榜 —— 这正是本次难度目标的结构性保证。
   * @param {Snake} winner 击杀者（玩家或 AI）
   * @param {number} loserLen 输家死前的节数（必须在清空身体前读到）
   * @param {boolean} eaten 是否正面吞并（决定飘字用「吞并！」还是「击杀」）
   */
  rewardKill(winner, loserLen, eaten) {
    const K = CONFIG.snake.killReward;
    // 关掉开关就退回旧版的固定 5 节；AI 互吞按 aiMul 打折，给玩家留出追赶空间
    let gain = K.enabled
      ? clamp(Math.round(loserLen * K.absorb), K.minGain, K.maxGain)
      : CONFIG.snake.growPerKill;
    if (winner.isPlayer) gain = Math.round(gain * K.playerMul);
    else gain = Math.max(1, Math.round(gain * K.aiMul));

    winner.grow(gain);
    winner.kills++;
    if (winner.pulse.length) winner.pulse[0] = 1.5;
    // 吃完整条蛇后短暂无敌，避免立刻被别的蛇撞死（时长与旧版一致）
    winner.immuneUntil = performance.now() + (K.enabled ? K.immunityMs : 500);

    if (winner.isPlayer) {
      this.score += 150;   // 仅内部累计统计；排名 / 胜负只看长度（去掉积分制）
      this.kills++;
      // 正面吞并给大字反馈；侧面 / 围杀沿用 killSnake 里的小字「击杀」，画面不变
      if (eaten) {
        this.fx.floatText(
          winner.body[0].x, winner.body[0].y - 70,
          '吞并！', '#B6FF57', 56
        );
      }
    }
  }

  /**
   * 蛇死亡：散落成食物 + 启动复活计时
   * @param {Snake} snake 死者
   * @param {Snake|null} killer 因撞到谁而死（可能是 null，比如撞墙）
   * @param {boolean} eaten 是否被"吞并"（正面相撞长者胜），这种情况分数已在 headOnEat 里结算
   */
  killSnake(snake, killer, eaten = false) {
    if (!snake.alive) return;
    // 输家节数必须在清空身体之前读：击杀收益按体型折算
    const loserLen = snake.length;
    snake.alive = false;
    snake.respawnTimer = snake.isPlayer ? CONFIG.player.respawnDelay : CONFIG.ai.respawnDelay;

    // ---- 身体散落成食物 ----
    const positions = snake.scatterPositions(CONFIG.food.scatterMax);
    for (const p of positions) {
      this.foods.push(this.makeFood(p.x, p.y, false, snake.color, true));
    }

    // ---- 特效 ----
    // 屏幕反馈只给玩家自己的事：
    //   自己死了 → death 档；自己吃掉了别人 → kill 档；AI 互杀 → 只有粒子
    const pts = snake.body.map((b) => ({ x: b.x, y: b.y }));
    this.fx.explodeDeath(pts, snake.color, {
      own: snake.isPlayer,
      killerIsPlayer: !!(killer && killer.isPlayer && !snake.isPlayer)
    });

    snake.deaths++;   // 本局死亡次数：同长度裁决 + 结算页都要用
    if (snake.isPlayer) {
      this.deaths++;
      // 有 killer 说明是被别的蛇弄死的；没有则是撞墙 / 撞自己 / 同归于尽
      const msg = killer ? '被吃掉了' : '阵亡';
      this.fx.floatText(snake.body[0].x, snake.body[0].y - 90, msg, '#FF5C7A', 44);
    } else if (killer && killer.isPlayer && !eaten) {
      // 撞死在玩家身上（侧面相撞时主动撞人的一方死）。
      // 积分制已取消：不再加分、不显示「+60」，只给一个吞并反馈。
      this.fx.floatText(snake.body[0].x, snake.body[0].y - 60, '击杀', '#B6FF57', 34);
    }

    // ---- 统一击杀记账 ----
    // 正面吞并 / 侧面撞人 / 逼对手撞进自己身体，都算一次击杀并给成长；
    // 撞墙 / 自撞 / 同归于尽时 killer 为 null，没有任何奖励。
    if (killer && killer !== snake && killer.alive) {
      this.rewardKill(killer, loserLen, eaten);
    }

    // 清空身体，避免残影
    snake.body.length = 0;
    snake.pulse.length = 0;
    snake.lookAt = null;
  }

  /** 真人复活：保留分数，长度回到初始，站在安全的远处 */
  respawnPlayer(snake = this.player) {
    const p = this.spawnPoint(1100);
    snake.reset(p.x, p.y, this.inwardHeading(p.x, p.y), CONFIG.snake.startSegments);
    snake.immuneUntil = performance.now() + CONFIG.player.immunity * 1000;
    // 复活后先静止不动且无敌 0.3 秒，期间玩家给的方向会被记下，
    // 时间一到直接朝那个方向出发（见 Snake.update 的冻结分支）。
    this.applySpawnFreeze(snake);
    const t = this.camTargets[snake.playerIndex];
    if (t) {
      t.x = p.x;
      t.y = p.y;
    }
    this.fx.floatText(p.x, p.y - 80, '复活', snake.color, 48);
  }

  /** AI 重生：始终维持 7 只（与玩家合计 8 位） */
  respawnAI(snake) {
    const p = this.spawnPoint(1200);
    snake.reset(p.x, p.y, this.inwardHeading(p.x, p.y), CONFIG.snake.startSegments);
    snake.immuneUntil = performance.now() + 900;
    // AI 同样静止 0.3 秒（Brain 照常决策，方向会在起步前对齐），
    // 免得玩家还在待命时 AI 已经冲过来，保护期失去意义。
    this.applySpawnFreeze(snake);
    // 清空目标 / 决策缓存 / 走神状态，让重生的 AI 从干净状态重新找食物
    const brain = this.brains.find((b) => b.snake === snake);
    if (brain) brain.resetForNewRound();
  }

  // ------------------------------------------------------------
  // 道具
  // ------------------------------------------------------------
  /**
   * 道具专用随机数（xorshift32）。
   * 与 Math.random 完全隔离：新增道具不该改变食物分布、AI 出生点、
   * 粒子特效等既有随机序列，否则所有可复现的统计对照都会失效。
   */
  powerupRandom() {
    let x = this.powerupRnd >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.powerupRnd = x >>> 0;
    return this.powerupRnd / 4294967296;
  }

  /** 造一个道具对象 */
  makePowerup(x, y, type) {
    const cfg = CONFIG.powerups[type];
    return {
      x, y, type,
      r: CONFIG.powerups.radius,
      color: cfg.color,
      label: cfg.label,
      seed: this.powerupRandom() * 100
    };
  }

  /** 随机取一个离所有活蛇都远一点的道具位置 */
  randomPowerupPos() {
    const P = CONFIG.powerups;
    const m = P.spawnMargin;
    const minD2 = P.minDistFromSnake * P.minDistFromSnake;
    const randX = () => m + this.powerupRandom() * (this.worldW - m * 2);
    const randY = () => m + this.powerupRandom() * (this.worldH - m * 2);

    for (let t = 0; t < 12; t++) {
      const x = randX();
      const y = randY();
      let ok = true;
      for (const s of this.snakes) {
        if (!s.alive || s.body.length === 0) continue;
        const h = s.body[0];
        if (dist2(x, y, h.x, h.y) < minD2) { ok = false; break; }
      }
      if (ok) return { x, y };
    }
    // 找不到就放宽距离要求，仍然留在世界内
    return { x: randX(), y: randY() };
  }

  /** 随机造一个道具：优先补场上数量较少的那一类，保证两种都能见到 */
  randomPowerup() {
    let nb = 0, nm = 0;
    for (const p of this.powerups) {
      if (p.type === 'boost') nb++;
      else nm++;
    }
    const type = nb < nm ? 'boost'
      : nm < nb ? 'magnet'
        : (this.powerupRandom() < 0.5 ? 'boost' : 'magnet');
    const pos = this.randomPowerupPos();
    return this.makePowerup(pos.x, pos.y, type);
  }

  /**
   * 在指定位置生成一个道具（调试 / 自动化用例入口）。
   * 不传坐标就随机找一个安全位置。
   */
  spawnPowerup(type, x, y) {
    const t = type === 'boost' || type === 'magnet'
      ? type
      : (this.powerupRandom() < 0.5 ? 'boost' : 'magnet');
    const pos = (Number.isFinite(x) && Number.isFinite(y))
      ? { x, y }
      : this.randomPowerupPos();
    const p = this.makePowerup(pos.x, pos.y, t);
    this.powerups.push(p);
    return p;
  }

  /** 被拾取后隔 spawnSec 秒补一个，直到维持 targetCount */
  ensurePowerups(realDt) {
    const P = CONFIG.powerups;
    if (!P.enabled) return;
    if (this.powerups.length >= P.targetCount) {
      this.powerupSpawnTimer = P.spawnSec;
      return;
    }
    this.powerupSpawnTimer -= realDt;
    if (this.powerupSpawnTimer > 0) return;
    this.powerupSpawnTimer = P.spawnSec;
    this.powerups.push(this.randomPowerup());
  }

  /**
   * 拾取判定：蛇头进入「蛇头半径 + pickupRadius」就算吃到。
   * 静止保护期不拾取（和食物一致）；一帧最多吃一个，避免重叠道具被一次吞掉。
   */
  collectPowerups() {
    const P = CONFIG.powerups;
    if (!P.enabled || this.powerups.length === 0) return;

    for (const s of this.snakes) {
      if (!s.alive || s.isFrozen()) continue;
      if (!s.isPlayer && !P.aiCanPickup) continue;
      // 拾取半径同样跟随体型：大蛇的头更宽，不必精确顶到图标中心
      const hit = snakeRadius(s.length) + P.pickupRadius;
      const hit2 = hit * hit;
      const h = s.body[0];
      if (!h) continue;

      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const p = this.powerups[i];
        if (dist2(h.x, h.y, p.x, p.y) > hit2) continue;
        const cfg = P[p.type];
        s.applyBuff(p.type, cfg.durationSec);
        this.fx.pickup(p.x, p.y, {
          color: cfg.color,
          label: `${cfg.label} ${cfg.durationSec}s`,
          own: s.isPlayer
        });
        // 用尾元素填补，O(1) 移除；倒序遍历保证不会漏掉换过来的那个
        this.powerups[i] = this.powerups[this.powerups.length - 1];
        this.powerups.pop();
        break;
      }
    }
  }

  /**
   * 磁铁：把范围内食物朝蛇头拉。
   * 用物理 dt（与蛇运动同一时钟），这样顿帧时食物和蛇一起慢下来，不会"穿模"。
   * 一个食物一帧只被一条蛇认领：两条磁铁同时生效时不会左右拉扯。
   */
  applyMagnets(dt) {
    const P = CONFIG.powerups;
    if (!P.enabled || dt <= 0) return;
    const M = P.magnet;
    const r2 = M.radius * M.radius;
    const claimed = this.magnetClaimed;
    claimed.clear();

    for (const s of this.snakes) {
      if (!s.alive || s.isFrozen() || !s.hasBuff('magnet')) continue;
      const h = s.body[0];
      if (!h) continue;

      for (let i = 0; i < this.foods.length; i++) {
        if (claimed.has(i)) continue;
        const f = this.foods[i];
        const dx = h.x - f.x;
        const dy = h.y - f.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2 || d2 < 1) continue;
        claimed.add(i);

        const d = Math.sqrt(d2);
        // 越靠近吸得越快；给 55% 的保底速度，边缘的食物也会稳稳飘过来
        const speed = M.pullSpeed * (0.55 + 0.45 * (1 - d / M.radius));
        const step = Math.min(d, speed * dt);
        f.x += (dx / d) * step;
        f.y += (dy / d) * step;
      }
    }
  }

  // ------------------------------------------------------------
  // 食物
  // ------------------------------------------------------------
  /** 造一个食物对象 */
  makeFood(x, y, big, color, scattered = false) {
    return {
      x, y,
      r: CONFIG.food.radius * (big ? 1.22 : 1),
      big,
      color: color || (big ? '#FFC53D' : pick(FOOD_COLORS)),
      face: big ? 'wide' : pick(FOOD_FACES),
      seed: Math.random() * 100,
      scattered
    };
  }

  /** 在世界内随机取一个食物的位置（尽量不刷在蛇身上） */
  randomFood() {
    const m = CONFIG.food.spawnMargin;
    const minD2 = CONFIG.food.minDistFromSnake * CONFIG.food.minDistFromSnake;

    for (let t = 0; t < 10; t++) {
      const x = randRange(m, this.worldW - m);
      const y = randRange(m, this.worldH - m);
      let ok = true;
      for (let i = 0; i < this.hazards.length; i++) {
        const hz = this.hazards[i];
        if (dist2(x, y, hz.x, hz.y) < minD2) {
          ok = false;
          break;
        }
      }
      if (ok) return this.makeFood(x, y, Math.random() < CONFIG.food.bigChance);
    }
    // 实在找不到就随便放，反正会被吃掉
    return this.makeFood(
      randRange(m, this.worldW - m),
      randRange(m, this.worldH - m),
      false
    );
  }

  /** 吃食物判定 */
  eatFood() {
    for (const s of this.snakes) {
      // 静止保护期连食物都不吃：否则脚下有食物就会长身体，
      // 与"原地一动不动"的承诺不符（起步瞬间身体会被突然拉长）。
      if (!s.alive || s.isFrozen()) continue;
      const h = s.body[0];
      // 头越大嘴越宽：拾取半径同样跟随「越长越粗」，大蛇不必把嘴对准豆子正中
      const R = snakeRadius(s.length);

      for (let i = this.foods.length - 1; i >= 0; i--) {
        const f = this.foods[i];

        // 便宜的包围盒预筛，避免每个都做开方
        if (Math.abs(f.x - h.x) > 90 || Math.abs(f.y - h.y) > 90) continue;

        const hitR = R + f.r * CONFIG.food.eatPadding;
        if (dist2(h.x, h.y, f.x, f.y) > hitR * hitR) continue;

        // ---- 吃到 ----
        const grow = f.big ? CONFIG.snake.growPerBigFood : CONFIG.snake.growPerFood;
        const L = CONFIG.ai.leader;
        const pr = computeAiPressure(this.tuning);
        if (s.isPlayer) {
          // 玩家保持旧版整数成长，吃食物手感一字未改
          s.grow(grow);
        } else {
          // 压迫档下 AI 吃豆收益打折：成长更多来自围猎 / 吞并，而不是堆豆子。
          // 用小数累积，视觉上只是偶尔少长一节，不会出现「吃了没反应」。
          const mul = 1 - (1 - CONFIG.ai.foodMul) * pr;
          s.growFractional(grow * mul);
          // ---- AI 领跑压制（只在压迫档生效）----
          // 比玩家长的 AI 每吃一个食物额外攒一点长度：纯吃食物只能一路跟在
          // 后面，差距不会消失；吞并的一次性跳跃收益才是玩家跨过门槛的手段。
          if (L.enabled && pr > 0) {
            const base = Math.max(this.player.length, CONFIG.snake.startSegments);
            const edge = clamp((s.length - base) / L.edgeScale, 0, 1);
            s.growFractional(L.maxBonus * pr * edge);
          }
        }
        // 速度由 Snake.updateSpeed 每帧按节数重算（越长越慢），这里不做速度累加
        s.pulse[0] = 1.3;
        s.foodEaten++;

        if (s.isPlayer) {
          // score 只保留为内部累计统计（体感日志 / 旧自动化用例会读），
          // 不再显示、不再写「最高分」，也不参与排名与胜负。
          this.score += f.big ? 30 : 10;
        }

        this.fx.explode(f.x, f.y, {
          color: f.color,
          big: f.big,
          radius: f.r,
          own: s.isPlayer   // 只有玩家自己吃才震屏
        });

        // 移除（用尾元素填补，O(1)）
        this.foods[i] = this.foods[this.foods.length - 1];
        this.foods.pop();
        for (const brain of this.brains) brain.forgetTarget(f);
      }
    }
  }

  /**
   * 维持食物总量。
   * 补充带冷却：每 spawnCooldownSec 秒最多补一批（默认 0.2s、一批 8 个），
   * 不再「每帧都补」——食物被吃后缺口会存在一小会儿，密度才有起伏。
   * 注意冷却每帧都走（哪怕这帧不缺口），归零后下一次缺口能立刻补，不会被白等。
   * @param {number} dt 真实秒（暂停时调用不到这里，天然冻结）
   */
  ensureFood(dt = 0) {
    const F = CONFIG.food;
    this.foodSpawnCd = Math.max(0, this.foodSpawnCd - dt);

    if (this.foods.length < F.targetCount) {
      // 还在冷却里：这一帧不补，等下一次结算
      if (this.foodSpawnCd > 0) return;
      const n = Math.min(F.spawnPerFrame, F.targetCount - this.foods.length);
      for (let i = 0; i < n; i++) this.foods.push(this.randomFood());
      this.foodSpawnCd = F.spawnCooldownSec;
      return;
    }

    // 蛇大量死亡后食物会堆积，慢慢清掉离玩家最远的（优先视野外的）
    if (this.foods.length > F.targetCount + F.trimExtra) {
      const cam = this.camTarget;
      let farIdx = -1;
      let farD2 = -1;
      for (let i = 0; i < this.foods.length; i++) {
        const f = this.foods[i];
        const d2 = dist2(f.x, f.y, cam.x, cam.y);
        if (d2 > farD2) {
          farD2 = d2;
          farIdx = i;
        }
      }
      if (farIdx >= 0) {
        this.foods[farIdx] = this.foods[this.foods.length - 1];
        this.foods.pop();
      }
    }
  }

  // ------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------
  /** 找一个离所有活着的蛇都足够远的出生点 */
  spawnPoint(minDist) {
    const minD2 = minDist * minDist;
    const m = 280;

    for (let t = 0; t < 50; t++) {
      const x = randRange(m, this.worldW - m);
      const y = randRange(m, this.worldH - m);

      let ok = true;
      for (const s of this.snakes) {
        if (!s.alive || s.body.length === 0) continue;
        const h = s.body[0];
        if (dist2(x, y, h.x, h.y) < minD2) {
          ok = false;
          break;
        }
      }
      if (ok) return { x, y };
    }

    // 兜底：放到世界中心附近
    return {
      x: clamp(this.worldW / 2 + randRange(-300, 300), m, this.worldW - m),
      y: clamp(this.worldH / 2 + randRange(-300, 300), m, this.worldH - m)
    };
  }

  /** 玩家复活剩余秒数（用于 HUD） */
  get playerRespawnIn() {
    return this.player.alive ? 0 : Math.max(0, this.player.respawnTimer);
  }

  /** 玩家静止保护期剩余秒数（用于状态栏 / 调试） */
  get playerFreezeIn() {
    if (!this.player.alive || !this.player.isFrozen()) return 0;
    return Math.max(0, (this.player.freezeUntil - performance.now()) / 1000);
  }

  /** 存活对手数 */
  get aliveOpponents() {
    let n = 0;
    for (const s of this.snakes) if (!s.isPlayer && s.alive) n++;
    return n;
  }
}
