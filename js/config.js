/**
 * 全局可调参数
 * ------------------------------------------------------------
 * 想调手感 / 难度 / 视觉节奏，基本只需要改这个文件。
 * 坐标单位是"世界像素"，相机把世界映射到屏幕上。
 */

export const CONFIG = {
  // 世界 = 3x3 个屏幕大小
  world: { tileW: 1600, tileH: 900, tilesX: 3, tilesY: 3 },
  // 单屏视野（相机一次看到的范围）
  //
  // 旧做法是固定 1600×900 硬塞进画布（contain）：窗口比 16:9 「更竖」时，
  // 高度会被撑开 —— 竖屏手机 390×700 实际看到 1600×2870 世界单位，
  // 而整个世界才 4800×2700，等于一屏看光所有内容，蛇只剩 10px 宽。
  // 现在改成「短边决定跨度」：短边装多少世界单位，长边按画布比例展开。
  view: {
    w: 1600,          // 仅作语义参考：16:9 桌面下就是 1600×900
    h: 900,           // 桌面（短边 > phoneBreakCss）时短边装 900 → 还原旧的 1600×900
    phoneBreakCss: 620,   // 视口短边低于这个像素数，就按手机口径算视野
    // 手机上短边只装 640 世界单位。这个值是对着「Chrome 窗口 1600×900」调的：
    // 桌面战场带 1578×598 时每世界单位 0.664 CSS px，手机 390 宽 / 640 = 0.61，
    // 两者观感基本一致；再小（600 以下）屏幕会空得看不到食物，再大就回到"太远"。
    phoneShortSpan: 640,
    // ---- 旋转自适应 ----
    // 640 是「短边 390px」这个基准下的取值。横屏手机短边变成高度（约 300px 出头，
    // 还要扣掉界面带），如果仍然硬塞 640，每世界单位只剩 0.47px，蛇会比竖屏小一圈。
    // 所以改成：按画布短边相对基准等比缩放，让「每世界单位占多少 CSS px」在
    // 竖屏 / 横屏基本恒定 —— 转一下手机，蛇的视觉大小不变，只是看到的世界形状变了。
    phoneAnchorCss: 390,  // 基准短边：就是上面 640 的那次实测视口宽
    phoneSpanMin: 380,    // 下限：再远食物就成小点（窄到 232px 的极端分屏才会触底）
    phoneSpanMax: 780,    // 上限：再近蛇头就顶满屏幕（平板竖屏 768 宽时触顶）
    // 双人半屏补偿：每侧只有半个屏宽，短边规则会把镜头推到脸上。
    // 1.5 倍正好复刻改造前的双人视野密度（约 0.40 px/单位），老玩家手感不变。
    splitSpanBoost: 1.5,
    maxViewH: 1900        // 视野高度上限：世界高 2700，超过就看不到上下边界之外了
  },

  // 启动看门狗：浏览器既不授权也不拒绝时，getUserMedia 的 Promise 会永远悬着，
  // 页面就卡在「正在启动」看起来像没反应。这里给每个阶段设上限，超时必须给结论。
  boot: {
    cameraTimeoutMs: 20000,   // 第 1 段：请求摄像头权限（手机上权限弹窗 + 硬件预热更慢，给 20 秒）
    // 第 2 段：模型总时限。手机 4G 下要下 7.5MB（gzip 后），35 秒不够，
    // 真正挂在某个具体步骤上时由下面的 stage 分级切断，不靠这个总闸
    modelTimeoutMs: 70000,
    // 每个子步骤的硬超时：MediaPipe 的 GPU 初始化在部分手机上会永远不回话，
    // 没有这个闸门，启动就永久停在"正在加载姿态模型"，玩家只能看到摄像头亮着、游戏不动
    stage: {
      importMs: 20000,        // 下载 / 解析 vision_bundle
      filesetMs: 30000,       // 编译 WASM（手机上 9MB wasm 编译确实慢）
      createGpuMs: 25000,     // GPU 初始化：超时就换 CPU，别死等
      createCpuMs: 45000      // CPU 初始化慢但通常能成，给足时间
    }
  },

  camera: {
    follow: 9,            // 跟随平滑系数（越大越紧跟）
    lookahead: 140,       // 沿蛇头朝向前瞻的距离，让视野更早看到前方
    lookaheadMax: 240
  },

  snake: {
    startSegments: 16,    // 初始节数（含头）
    segDist: 18,          // 相邻两节的间距
    radius: 22,           // 蛇身半径
    baseSpeed: 300,       // 初始速度（世界像素/秒）。长度超过 startSegments 后按 slowdown 递减
    growPerFood: 1,       // 吃普通食物长几节
    growPerBigFood: 3,    // 吃金果长几节
    growPerKill: 5,       // 旧版固定吞并成长（关闭下方 killReward 时回退到这个值）
    wallPad: 10,          // 撞墙判定的内缩量

    // ---- 击杀收益（2026-11-09：让「必须击杀几条蛇」成为夺冠的硬门槛）----
    // 旧版只有「正面相撞长者胜」才长 5 节并记一次击杀，侧面撞人、
    // 逼对手撞进自己身体这两种主流击杀方式既不计功也不成长。
    // 现在所有「让对手死亡」的情形统一记账，并按输家长度折算成长：
    // 吃食物是线性累积、吞并是跳跃式收益，领跑 AI 靠互吞滚雪球，
    // 玩家不击杀就永远追不上结束瞬间的长度榜。
    killReward: {
      enabled: true,
      absorb: 0.28,       // 按输家节数折算：吃掉 60 节的蛇 ≈ +17 节
      minGain: 8,         // 吞掉刚复活的小蛇也有保底收益
      maxGain: 42,        // 封顶，避免一击长出一整条身体
      immunityMs: 500,    // 吞并后的短暂无敌（与旧版一致）
      playerMul: 2.00,    // 玩家吞并收益倍率：吃一条 60 节的蛇 ≈ +34 节，三次就能反超
      aiMul: 0.30         // AI 互吞折算倍率：给玩家留出可追赶的空间
    },

    // ---- 越长越粗（2026-11-10：大蛇视觉分量不足）----
    // 半径从起始长度的 1.00× 线性涨到 atSegments 时的 girthMax，之后封顶。
    // 头的半径 = 身体半径 × 1.12，所以「头 + 身体」一起变粗，不需要单独再配一套参数。
    // 关键约束：这个半径同时参与碰撞判定（自撞 / 头撞头 / 撞身 / 吃食物拾取），
    // 也就是「看起来多粗、判定就有多粗」——不会出现视觉贴着身体却穿过去的情况。
    girth: {
      enabled: true,
      min: 1.00,          // 滑块下限 = 不加粗（关掉该特性）
      max: 2.00,          // 滑块上限：满额时半径 ×2，即直径 / 宽度 +100%
      default: 2.00,      // 默认按满额（用户要求「最大情况 +100%」）
      atSegments: 120,    // 到 120 节达到最大加粗；起始 16 节为 1.00×
      curve: 1.0          // 插值曲线：1 = 线性，<1 更早变粗，>1 更晚变粗
    }
  },

  // 「越大越慢」：io 类贪吃蛇的通用规则。
  // 大蛇靠身体封路，但机动性下降；小蛇灵活、能抢食。
  // 速度 = baseSpeed × (1 - strength × (1 - e^(-额外节数 / scale)))
  //   extra = 当前节数 - startSegments
  //   strength 决定"最多能慢多少"，scale 决定"多快变慢"（节数）
  // 指数趋近而非线性到顶：大蛇之间仍有细微差别，也不会突然卡住。
  slowdown: {
    strength: 0.20,       // 最大减速比例 0.20 = 极限降到初始速度的 80%（11-10 用户真机调参）
    strengthMin: 0,       // 0 = 完全关闭该特性（恒定速度）
    strengthMax: 0.80,
    scale: 60,            // 额外长 60 节时约减速到 strength 的 63%
    scaleMin: 15,
    scaleMax: 180
  },

  turn: {
    // 暴露给页面滑块的运行时可调参数：基础转向角速度（弧度/秒）
    // 体感输入只给「手腕相对圆心的角度」，不再有手肘伸展度 / 横向偏移参与方向运算。
    rate: 8.5,
    rateMin: 2,
    rateMax: 18,
    // 要掉头（角度差大）时的补偿，避免手感过于难受
    reverseBoost: 1.35
    // 注意：deadzone 必须放在 CONFIG.pose 段 —— PoseTracker 读的是 config.pose。
    // 之前放这里导致 this.cfg.deadzone === undefined，方向角永远不更新（蛇头锁死 0°）。
  },

  food: {
    // 全场维持的食物数量（初始生成与每帧补充都只读这一个值），
    // 也就是食物总产量的唯一旋钮。原来 260，按用户要求整体降低 25% → 195。
    // 想让局面更紧 / 更松就调这里，改完记得重跑一局看长度分布。
    targetCount: 195,
    radius: 24,
    spawnMargin: 90,      // 离世界边界的最小距离
    minDistFromSnake: 70, // 刷新时离蛇身的最小距离
    bigChance: 0.08,      // 金果概率
    eatPadding: 0.82,     // 吃判定：半径和 * 该系数
    // 补充节奏：每 spawnCooldownSec 秒最多补一批（一批最多 spawnPerFrame 个）。
    // 以前是「每帧都补、缺几个补几个」——被吃掉的食物下一帧立刻刷回来，
    // 场上密度几乎是条直线，吃食没有「抢」的感觉。加冷却后缺口会存续一小会儿。
    spawnCooldownSec: 0.2,
    spawnPerFrame: 8,     // 一批最多补几个（避免一次性生成卡顿）
    trimExtra: 70,        // 超过 target+该值才开始清理多余食物
    scatterMax: 64        // 一条蛇死亡时最多散落多少个食物
  },

  // ---- 道具 ----
  // 两种道具：加速（速度倍率，5 秒）、磁铁（把附近食物吸过来，10 秒）。
  // 用户确认：全场都能拾取（AI 也会抢）。AI 吃到加速会改变转弯半径、
  // 吃到磁铁会大幅增加吃食，因此「自撞占 AI 死亡 30%」的基线是按
  // aiCanPickup = true 重新标定过的，改动这里要重跑 diag-rate.mjs 复核。
  //
  // 重要：道具的位置 / 类型 / 拾取特效都走 Game 内部独立的 xorshift 随机流，
  // 不消耗 Math.random()。因为所有统计脚本都用「页面加载前锁定随机流」做
  // 可复现对照，多消耗一次随机就会让整条轨迹分叉（之前踩过这个坑）。
  powerups: {
    enabled: true,
    aiCanPickup: true,    // true = 全场都能拾取（用户确认；自撞基线已按此重标定）
    targetCount: 7,       // 全场维持多少个道具
    spawnSec: 5,          // 被拾取后隔几秒补一个（真实时间，暂停不计时）
    radius: 26,           // 道具图标半径
    pickupRadius: 30,     // 拾取判定 = 蛇头半径 + 该值
    spawnMargin: 180,     // 离世界边界的最小距离
    minDistFromSnake: 160,// 刷新时离所有蛇头的最小距离
    boost: {
      durationSec: 5,     // 持续时间（秒，真实流逝；暂停时冻结）
      speedMul: 1.65,     // 速度倍率
      color: '#FFD93D',
      label: '加速'
    },
    magnet: {
      durationSec: 10,
      radius: 300,        // 吸附半径（世界像素）
      pullSpeed: 620,     // 吸附速度（像素/秒），越靠近蛇头越快
      color: '#5BC8FF',
      label: '磁铁'
    }
  },

  ai: {
    count: 7,             // AI 对手数量（用户确认：玩家 + 7 AI = 单局 8 位玩家）
    respawnDelay: 3,      // 死亡后几秒重生
    skillMin: 0.62,       // 转向能力倍率下限（越低越笨）
    skillMax: 0.96,
    speedJitter: 0.1,     // 速度随机浮动
    wanderRadius: 900,    // 附近没有食物时随机游走的范围
    avoidRadius: 230,     // 侦测危险的半径
    probeDist: 190,       // 向前探路的距离
    attackRatio: 1.45,    // 比对手长这么多倍才主动冲撞（低难度基准值）

    // ---- 压迫模式（2026-11-09：用户反馈「AI 难度又太低了」）----
    // 旧模型有个反直觉的缺陷：自体避让强度 guard = 1 - level，
    // 于是「难度拉满」反而等于「完全不保护自己、疯狂自撞」，
    // 实测每局 7 只 AI 要死 26 次，冠军蛇经常在最后一秒自己咬死自己，
    // 玩家不击杀也有约 25% 概率捡漏夺冠。
    //
    // 新机制统一挂到 pressure 上，兼顾「变强」与「可对照」：
    //   pressure = clamp((level - 0.5) / 0.5, 0, 1) × TUNING.aiPressure
    //   level ≤ 0.5 → pressure = 0 ⇒ 与旧版逐位一致（30% 自撞率基线、全套回归保持）
    //   level = 0.85（新默认）→ pressure = 0.70 ⇒ 攻击性与生存能力大幅增强
    //   level = 1 且 aiPressure = 1 → pressure = 1 ⇒ 最强压迫
    // 单独把「AI 压迫强度」滑块拉到 0，随时可退回旧手感做 A/B 对照。
    pressure: {
      start: 0.5,         // 低于/等于该难度时新机制完全不生效
      default: 1.0,       // 新滑块默认值（TUNING.aiPressure）
      min: 0,
      max: 1
    },

    // ---- 攻击性：满压迫时追加的能力 ----
    hunt: {
      enabled: true,
      ratio: 1.02,        // 满压迫时的进攻长度门槛（只要不比对方短就敢冲）
      rangeAdd: 260,      // 满压迫时额外追击距离（世界像素）
      aggressionAdd: 0.85,// 满压迫时额外冲撞向量权重
      leadSec: 0.55,      // 预判对手前进的时间（秒）：绕到它前面而不是追尾巴
      leadMax: 280,       // 预判距离上限
      cutIn: 0.40,        // 拦截点沿对手航线法线的侧偏比例（横身封路）
      playerFocus: 1.45   // 对玩家的额外仇恨倍率（压迫感主要来源）
    },

    // ---- 生存能力：满压迫时追加的能力 ----
    survival: {
      enabled: true,
      wallProbeAdd: 110,  // 额外探路距离，更早看到墙
      wallPushAdd: 0.85,  // 墙推力倍率增量
      senseAdd: 0.30      // 危险感知半径倍率增量
    },

    // ---- 领跑压制：把「夺冠必须击杀」做成结构性门槛 ----
    // 只作用于 AI、只在压迫档生效：比玩家长的 AI 每吃一个食物会额外
    // 积累一点长度（走小数累积，视觉上只是偶尔多长一节）。
    // 于是「纯吃食物」永远只能跟在领跑 AI 后面一点点，差距始终存在；
    // 而吞并是一次性跳跃收益，是玩家唯一能跨过差距的手段。
    // 玩家侧的吃食物规则一字未改，手感与既有回归保持原样。
    leader: {
      enabled: true,
      maxBonus: 0.30,     // 每个食物最多额外积累的节数（再乘压迫强度）
      edgeScale: 60       // AI 比玩家长多少节时加成到满
    },

    // 压迫档下 AI 吃豆的成长系数（玩家恒为 1，手感一字未改）。
    // 守成机制让 AI 少死很多，若吃豆收益还和玩家一样，冠军会滚到 200+ 节，
    // 玩家吞并几次也追不上。这里让 AI 的成长更多来自「围猎 / 吞并」而非豆子，
    // 既符合攻击性定位，也把差距控制在几次击杀能跨越的范围内。
    foodMul: 0.60,

    // ---- 难度系数（页面滑块实时可调）----
    // 一个主系数派生出 5 个维度，避免玩家面对一堆看不懂的参数：
    //   转向能力 / 反应间隔 / 感知与避让 / 进攻欲望 / 觅食精度
    // 另有独立的「压迫强度」滑块控制上文的 hunt / survival。
    // level ≤ 0.5 时新机制关闭，仍可随时退回旧版做对照。
    // mistakeRate 独立控制「走神失误」的频率，0 = 永不失误。
    difficulty: {
      level: 0.85,         // 主难度系数（2026-11-09 由 0.5 上调：需要击杀才能夺冠）
      levelMin: 0,
      levelMax: 1,
      mistakeRate: 0.10,   // 失误频率系数（0.5 → 0.20 → 0.10：强 AI 不该频繁走神）
      mistakeMin: 0,
      mistakeMax: 1,

      turnFloor: 0.34,     // 难度 0 时转向能力倍率（相对原本的个体 skill）
      senseFloor: 0.38,    // 难度 0 时感知半径 / 避让力度倍率
      reactionMaxSec: 0.50,// 难度 0 时两次决策之间的间隔（秒），难度 1 = 每帧决策
      aimNoiseMax: 0.55,   // 难度 0 时瞄准方向的低频抖动幅度（弧度）
      attackBonus: 2.2,    // 难度 0 时主动进攻的长度门槛加值（越大越不敢冲）
      sloppyFoodMax: 0.55, // 难度 0 时「挑错食物」的概率
      retargetMaxSec: 1.1, // 难度 0 时额外延长锁定同一个食物的时间

      lapsePerSec: 0.40,   // 失误频率 = 该值 × mistakeRate（次/秒/只）
      lapseMinSec: 0.25,   // 单次走神时长
      lapseMaxSec: 0.85,
      lapseTurnMax: 0.95   // 走神时方向打偏的最大角度（弧度，约 54°）
    },

    // ---- 自体避让：把「自撞占 AI 死亡比例」标定到约 30% ----
    // 旧版危险点循环里直接 `if (hz.owner === s) continue`，AI 完全无视
    // 自己的身体；绕小圈时头就追上第 9 节以后的身体节而暴毙。
    // 这里沿目标方向做一次短前瞻：近处有自己的身体就改选一条不撞的航线
    // （左转 / 右转里挑安全的一侧）。不是禁止自撞 —— 两侧都堵死时仍会撞、
    // 转向有角速度上限来不及、走神期间不避让，所以偶尔照样会咬到自己。
    // 避让强度 guard 由 Brain.think 给出：难度 ≤ 0.5 时仍是旧的 1 - level，
    // 难度更高时随压迫强度向 level 靠拢（越聪明越会保护自己）。
    // 注意 selfEscape(snake, angle, guard) 的语义没变：guard = 0 仍完全不避让。
    //
    // 下面 3 个数值是标定值：目标「自撞死亡 / AI 全部死亡 ≈ 30%」。
    // 标定方法（diag-rate.mjs）：20 个种子 × 60 秒/局，页面脚本执行前就锁定
    // 随机流，难度 0.5 / 失误 0.5（= 压迫模式关闭档），特效真实开启；
    // 两次运行结果逐位一致。默认交付档是 0.85 / 0.10，自撞率会更低。
    //   96/44/1.20（旧默认）→ 74.5%   130/55/1.45 → 56.3%
    //  145/58/1.55 → 49.0%           155/62/1.70 → 36.8%
    //  162/66/1.77 → 31.0% ← 采用    165/68/1.80 → 27.6%
    //  175/70/1.85 → 20.5%
    // 想再降就整体往上调、想保留更多自撞就往下调（曲线不严格单调，改完
    // 建议重跑 diag-rate.mjs 复核）。已验证的副作用：AI 总死亡约减半、
    // 平均长度上升、吃食约 -20%、撞墙略增；这是「少自杀」的自然结果。
    selfAvoid: {
      enabled: true,
      lookAhead: 162,     // 沿目标方向看多远（世界像素）
      // 侧向多近算危险。原来是 66px，比身体半径（22~44px）大不少，
      // 导致 AI 为「根本擦不到」的脖颈也急转；收到 44px 后判据贴近真实碰撞。
      // 危险半径按「身体半径 × dangerMul」动态算，另有下限。
      // 固定值怎么都不对：给细蛇 52px 太远（为碰不到的部位急转），
      // 给粗蛇 52px 又只有 8px 余量（来不及躲）。
      dangerMul: 1.25,
      dangerRMin: 34,
      // 8 节（144px）。比碰撞跳过（12 节）更早一点，绕圈收窄时才有预警；
      // 配合 52px 的危险半径，实际触发时机与「真要撞上」接近，
      // 不会像原来 9 节 / 66px 那样为碰不到的脖颈满舵。
      skip: 8,
      step: 2,            // 身体节点采样步长
      // 避让转向幅度（弧度）。原来 1.77 = 101°，单次改写太猛，是「突然拐弯」
      // 的主因；降到 1.15（66°）后仍是果断避让，但不会把航线直接掰到反方向。
      escapeTurn: 1.15
    },

    // ---- 觅食视野（2026-11-11 新增）----
    // 只追「前方 ±foodFov」的食物。身后的食物要掉头，而掉头 = 转过
    // 一个最小转弯半径的整圈，长蛇的 R 差不多正好等于身体长度的一小段，
    // 于是转着转着就咬到自己 —— 现场那些「莫名绕圈自杀」多半是这么来的。
    // 身后暂时没有目标就游走，等它进入前方视野再追，代价只是多走两步。
    foodFov: 1.92,        // 弧度（±110°）

    // ---- 防绕圈（2026-11-11 新增）----
    // 现场问题：AI 会绕着一个够不着的食物越绕越小，最后咬到自己。
    // 根因是 findFood 只按距离选目标 + 没有「追不到就放弃」的机制：
    // 目标一旦落在侧后方，相对航向的 ±60° 截断会让它稳定地绕圈。
    // 这里用「位移 / 累计转角」做检测，命中后强制放弃目标直线脱离。
    antiLoop: {
      enabled: true,
      windowSec: 2.0,     // 观察窗口
      // 判据是「窗口内累计转角 > 180°」+「净位移 / 走过的路程 < 0.75」。
      // 只看位移不行：长蛇转弯半径被限制到 ~90px，绕大半圈时位移仍有
      // 一百多像素，用固定位移阈值根本抓不到（实测判定一次都没触发）。
      // 换成位移/路程比之后，直行≈1、90° 转弯≈0.9、掉头≈0.64、
      // 绕圈会迅速掉到 0.3 以下，区分度足够。
      turnDeg: 180,
      pathRatio: 0.75,
      escapeSec: 1.2,     // 脱离时长：这段时间近似直行，不再追那个食物
      escapeTurn: 0.18,   // 脱离时的固定小偏角（弧度，约 10°），只为把圈撑开
      blacklistSec: 2.6   // 放弃的食物进黑名单多少秒（期间不再被选中）
    },

    // ---- AI 自撞判定宽容度（只作用于 AI，玩家判定不变）----
    // AI 绕小圈时蛇头常只是「擦」到自己的身体节。略微缩小判定半径、
    // 从更靠后的节开始扫，让擦边不死、真正缠进去才死。
    // 不改 AI 决策 / 速度 / 觅食，所以没有撞墙变多、吃食变少这类副作用。
    // 两项与玩家一致（9 / 0.62）时等于关闭该宽容。
    // 默认 12 / 0.45：判定半径 9.9px、跳过前 11 节，擦边不死但真缠进去仍会死。
    selfHit: {
      skip: 12,
      radiusMul: 0.45
    },

    // ---- 随机游戏风格（用户确认：给 AI 不同的性格）----
    // 每局开局重新洗牌分配，7 只 AI 尽量覆盖多种风格；只改「意图」，
    // 不改物理上限（转向角速度、碰撞判定、速度曲线都照旧）。
    // 全部是乘数；steady 全为 1，作为对照。难度滑块仍是总开关。
    //   attackMul     主动进攻的长度门槛倍率（越小越敢冲）
    //   aggressionMul 冲撞向量权重倍率
    //   avoidMul      对别人身体 / 墙的避让斥力倍率
    //   senseMul      感知半径 / 探针长度倍率
    //   sloppyMul     挑错食物概率倍率（贪吃型最低，几乎只盯最近的食物）
    //   lapseMul      走神失误频率倍率（冒险型更容易失误）
    //   foodWeight    合成方向时「追食物」的权重
    //   bigFoodBias   金果的距离权重（<1 = 更偏爱金果）
    //   fleeMul       遇到「比自己长的蛇」时额外避让倍率（畏强型最高）
    styles: {
      enabled: true,
      pool: [
        { key: 'bold',   label: '冒险', attackMul: 0.55, aggressionMul: 1.60, avoidMul: 0.62, senseMul: 0.90, sloppyMul: 0.85, lapseMul: 1.35, foodWeight: 0.55, bigFoodBias: 1.00, fleeMul: 0.60 },
        { key: 'timid',  label: '畏强', attackMul: 1.90, aggressionMul: 0.35, avoidMul: 1.50, senseMul: 1.25, sloppyMul: 1.00, lapseMul: 0.80, foodWeight: 0.55, bigFoodBias: 1.00, fleeMul: 2.20 },
        { key: 'greedy', label: '贪吃', attackMul: 1.60, aggressionMul: 0.40, avoidMul: 0.90, senseMul: 1.00, sloppyMul: 0.25, lapseMul: 0.80, foodWeight: 0.95, bigFoodBias: 0.55, fleeMul: 1.00 },
        { key: 'hunter', label: '好斗', attackMul: 0.75, aggressionMul: 1.90, avoidMul: 0.85, senseMul: 1.10, sloppyMul: 1.00, lapseMul: 1.00, foodWeight: 0.40, bigFoodBias: 1.00, fleeMul: 0.80 },
        { key: 'steady', label: '稳健', attackMul: 1.00, aggressionMul: 1.00, avoidMul: 1.00, senseMul: 1.00, sloppyMul: 1.00, lapseMul: 1.00, foodWeight: 0.55, bigFoodBias: 1.00, fleeMul: 1.00 }
      ]
    },

    // ---- NPC 蛇头造型（2026-11-11）----
    // 用户在预览页（preview/heads.html）从两批共 24 个方案里筛出这 9 款。
    // 每局从池子里洗牌抽 7 款发给 7 只 AI，一局之内保证不重复 —— 玩家靠
    // 脸就能认人，不必只靠颜色。池子比 AI 多 2 个，所以每局都有 2 款缺席，
    // 换局才出现新组合（也让「这局有哪几张脸」本身成了变量）。
    // 造型实现见 js/heads.js；玩家蛇头不参与分配，始终是原版。
    headStyle: {
      enabled: true,        // 关掉后所有 AI 回到原版蛇头（调试面板可切）
      pool: [
        'googly',    // 斗鸡眼
        'bucktooth', // 大板牙
        'moustache', // 小胡子
        'shocked',   // 震惊
        'glitch',    // 故障
        'lowpoly',   // 几何
        'pixel',     // 像素
        'neon',      // 霓虹
        'block'      // 方头
      ]
    }
  },

  // ---- 单局规则（用户确认）----
  // 2 分钟一局；时间到按「结束瞬间的长度」给 8 位玩家排名，不采用积分制。
  // 复活途中长度记 0（死亡时身体被清空、复活回到 startSegments），
  // 所以最后一秒保住蛇非常关键 —— 这正是 io 类「死亡清零」的紧张感。
  // 剩余时间走真实秒 realDt：暂停时主循环不调 update 自然冻结；
  // 击杀顿帧缩放的是物理 dt，不会把 2 分钟偷偷拉长。
  round: {
    mode: 'timed',            // 'timed' = 限时排位 | 'endless' = 无尽练习（不结算）
    durationSec: 120,
    lastCallSec: 10,          // 最后 10 秒的提示阈值
    bestLengthKey: 'poseSnakeBestLength', // 历史最长长度（本地保存）
    // 场上总人数固定 8（用户确认）：1 人 = 1 真人 + 7 AI，2 人 = 2 真人 + 6 AI。
    // 结算永远 8 列，双人模式不会因为多一个真人就把 AI 挤掉两条。
    totalPlayers: 8,
    // 双人分屏时两条真人蛇的配色。玩家 1 沿用原来的绿→青→蓝，
    // 玩家 2 走品红→橙，与 AI 的蓝紫／紫红弧段拉开距离，分屏时一眼分得清。
    playerColors: [
      { color: '#B6FF57', head: '#B6FF57', grad: ['#B6FF57', '#5BEFA0', '#2FD6C8', '#1FA8D8'] },
      { color: '#FF7AD9', head: '#FF9BE4', grad: ['#FFC2F0', '#FF7AD9', '#FF5CA8', '#FF8A4D'] }
    ],
    playerNames: ['你', '玩家 2']
  },

  player: {
    respawnDelay: 3,      // 玩家死亡后复活倒计时
    immunity: 1.4,        // 复活后的无敌时间（可长于静止期，期间能移动但撞不死）
    // 「复活静止保护期」：复活 / 开局后原地不动且无敌的时长（秒）。
    // 期间只接收方向输入（蛇头原地转向），结束后按玩家此刻给的方向起步，
    // 避免复活瞬间朝出生点随机朝向乱冲、玩家来不及反应就又撞死。
    // 与 immunity 独立：静止期永远无敌，immunity 结束后仍可正常移动一段无敌时间。
    respawnFreeze: 0.5,
    respawnFreezeMin: 0,  // 0 = 关闭静止期，复活后立刻运动（旧行为）
    respawnFreezeMax: 1.5
  },

  // 碰撞规则（贪吃蛇大作战）
  collide: {
    // 头撞头的判定半径 = snake.radius * 该值
    headRadius: 2.05,
    // 双方"朝对方冲"的余弦都 >= 该值 → 判为正面相撞
    // cos(57°) ≈ 0.55，即各自朝向与"指向对方"的夹角都在 57° 内
    headOnCos: 0.55,
    // 正面相撞且长度相等时：双双死亡（大作战规则）
    // 想对玩家宽容一点就改成 false，此时判定为"双方互换"、都存活
    evenLengthBothDie: true
  },

  pose: {
    // ---- 圆心高度：沿「脖子 → 腰」连线插值 ----
    //   0    = 脖子（双肩中点，约颈窝）
    //   0.35 = 胸口（默认，胸骨中段；颈窝到髋中点约 1/3 处）
    //   0.5  = 躯干正中间（等价于旧版「双肩+双髋四点平均」，可用来对照旧手感）
    //   1    = 腰部（双髋中点）
    // 圆心上移后，手腕相对圆心的角度、死区距离、归一化距离都会一起变化，
    // 这是刻意的：手臂绕胸口转动时，方向输入应该比绕腹部转动更"跟手"。
    // 举手判定用的也是这个圆心，刻度调高（往腰）会让举手更容易触发。
    centerT: 0.35,
    centerTMin: 0,
    centerTMax: 1,

    // ---- 圆心横向：自动放在「右手左右伸展极限的中点」----
    // 人体骨骼左右不对称：右臂向同侧外展能伸到接近满臂长，跨身体方向受躯干
    // 阻挡只剩一半多。圆心若固定在中线，右手向右侧更远、向左侧更近，
    // 两侧的"距离 → 速度"就不对称。这里用实测极值的中点当偏移，两侧才等距。
    // 偏移单位与 torsoPx 同量纲（占躯干长度的比例），所以离镜头远近不影响。
    centerX: {
      auto: true,        // 关掉则退回"圆心固定在躯干中线"
      maxShift: 0.40,    // 自动偏移上限（0.40 ≈ 躯干长度的 40%），防止误检把圆心拽飞
      learn: 0.06,       // 低通跟随系数（每帧），越小越稳、越大越快追上
      decay: 0.0004,     // 极值每帧朝 0 回缩的量，玩家久不做某侧动作时旧极限会淡出
      minSamples: 45,    // 至少 45 帧有效样本后才采用自动偏移（约 1.5 秒）
      minSpan: 0.50,     // 左右极值的跨度不足 0.5 个躯干长度就认为没真伸开，先不学
      manual: 0,         // 页面滑块的手动微调，叠加在自动值上（0 = 完全自动）
      manualMin: -0.30,
      manualMax: 0.30
    },

    // ---- 距离 → 速度（新体感模型）----
    // 手腕离圆心越远跑得越快。distN = 手腕离圆心距离 / 躯干基准长度，
    // 在 [near, far] 区间线性映射到 [min, max] 倍率（当前速度 = 1）。
    // 防抖三重保护：
    //   1) 时间常数低通（smooth 秒），与帧率无关，手抖不会逐帧抖动；
    //   2) 变化率限制 slew（倍率/秒），换手 / 髋点降级导致的距离跳变会被压成平滑过渡；
    //   3) 死区内 / 丢帧 hold 时保持上一帧目标，不让不可靠坐标把速度打飞。
    // 全部参数都暴露到页面滑块，方便真机标定。
    // 2026-11-10 按用户真机调参固化默认值：上限 1.80×（顶到滑块上限）、
    // 满速距离 0.75（更容易跑满）；下限 0.65 / near 0.30 / 防抖参数保持原样。
    // 2026-11-09 手感重标定（旧值在真机上"很不明显"）：
    //   1) 0.8~1.2 经「越大越慢」压缩后绝对速度差只剩 86~120 px/s，3 米远看不出来；
    //   2) near/far = 0.25/1.05 需要手臂完全伸直才满速，日常挥手只跑到 0.85~1.075×；
    //   3) smooth 0.18s + slew 1.2/s 让 0.2 秒的短促伸手只达成理论幅度 67%。
    // 现在放宽上下限、把距离区间收进真实可达范围、缩短低通并放松变化率限制，
    // 一次自然伸手就能跑满倍率区间；高频手抖仍由低通 + 变化率限制挡住。
    speed: {
      min: 0.65,          // 手收回时的速度倍率下限（原 0.80）
      max: 1.80,          // 手伸远时的速度倍率上限（1.20 → 1.40 → 1.80，已顶到滑块上限）
      near: 0.30,         // 归一化距离下界：小于它按 min 算（原 0.25）
      far: 0.75,          // 归一化距离上界：大于它按 max 算（1.05 → 0.85 → 0.75，更容易跑满速）
      smooth: 0.09,       // 低通时间常数（秒），原 0.18 把短促伸手抹平了
      slew: 3.00,         // 每秒允许的最大倍率变化，原 1.20 成了短动作的瓶颈
      // 页面滑块范围
      minLimit: 0.40, minCeil: 1.00,
      maxFloor: 1.00, maxLimit: 1.80,
      nearMin: 0.10, nearMax: 0.80,
      farMin: 0.40, farMax: 2.00,
      smoothMax: 0.60
    },
    lostTimeoutMs: 1000,  // 丢失姿态后沿用旧方向的时长（原 420ms 太短，断帧就一顿一顿直行）
    raiseToStart: 0.35,   // 手腕高于圆心多少（归一化）算"举手"。原 0.62 连双臂平举都够不到
    raiseHoldSec: 1.0,    // 举手保持多久算准备完成（用户确认：1 秒，左右手均可）
    autoStartSec: 1.0,    // 旧版"检测到人持续这么久就自动开局"，现已不参与开局判定
    // 人在画面里却一直举不了手时的兜底：等这么久也放行，避免被永久挡在准备画面
    raiseWaitMaxSec: 8,
    // 摄像头就绪后，即使一个人都没识别到，最多等这么久也强制开局。
    // 以前只有 seen=true 才能开局，识别不到人时游戏会永远停在"准备"，
    // 而"先用方向键玩"按钮又随着启动遮罩一起消失，屏幕上没有任何可点入口。
    forceStartSec: 2.5,
    camWidth: 960,
    camHeight: 720,

    // ---- 识别鲁棒性 ----
    minConfidence: 0.30,  // 模型检出/存在/跟踪置信度（0.5 → 0.3，弱光远距更容易出人）
    minVisibility: 0.25,  // 肩 / 肘 / 腕关键点的最低可见性
    hipVisibility: 0.35,  // 髋部低于此值就降级为「双肩中心」模式，不再让整帧失效
    hand: 'auto',         // 'auto' 按镜像后双肩位置自动选 | 'right' | 'left'
    inferStaleMs: 120,    // video.currentTime 长时间不变时，强制再推理一次的间隔
    deadzone: 0.05        // 手腕离圆心太近时角度不可靠，沿用上一帧角度
  },

  // 体感输入日志：默认开启，开局即录，随时导出用于事后分析
  poseLog: {
    enabled: true,
    sampleMs: 50,         // 常规采样 20Hz；状态跳变会强制补记一条
    maxRecords: 30000
  },

  // 屏幕反馈能级
  // 只有玩家自己的事才触发这些效果（别人吃东西不震屏、不闪白、不出声）
  // 数值是逻辑像素/强度，震屏会再乘以画面缩放
  fx: {
    // 粒子上限。8 条蛇同时炸开 + 大量进食时粒子会暴增，
    // 不封顶会拖低帧率；超限时丢弃最老的粒子（视觉上几乎无感）
    maxParticles: 1600,

    // ---- 头部可读性（只影响「玩家自己吃普通食物」这一条最高频路径）----
    // 吃食物的爆炸发生在蛇头位置，磁铁 / 密集食物会 0.1~0.3 秒重复一次，
    // 碎片 + 火花 + 白色爆炸星同时在蛇头上叠加 → 看不出蛇头位置与朝向。
    // 金果、击杀、被吃的大爆开不受影响，保留原来的"炸开感"。
    // enabled = false 可一键回到旧表现做对照。
    headClarity: {
      enabled: true,
      skipStar: true,      // 不再画实心白黄爆炸星（覆盖蛇头最重的一层）
      particleMul: 0.55,   // 彩色碎片数量倍率（34 → 19）
      sparkMul: 0.50,      // 高速火花数量倍率（26 → 13）
      waveMul: 0.62        // 冲击波半径倍率（保留扩散感，但收在蛇头附近）
    },
    impact: {
      // 吃普通食物：轻微，只给一点"咬到"的手感
      food: { shake: 5, flash: 0.09, zoom: 0.010, hitStop: 0 },
      // 吃金果：中等
      bigFood: { shake: 11, flash: 0.22, zoom: 0.026, hitStop: 0.05 },
      // 吃掉别人：最大档（炸开感最强）
      kill: { shake: 30, flash: 0.48, zoom: 0.070, hitStop: 0.14 },
      // 自己被吃掉 / 撞死：最大档，略强于击杀
      death: { shake: 34, flash: 0.55, zoom: 0.080, hitStop: 0.16 }
    }
  }
};

/** 世界尺寸（由 tiles 推导，避免两处写不一致） */
export const WORLD = {
  w: CONFIG.world.tileW * CONFIG.world.tilesX,
  h: CONFIG.world.tileH * CONFIG.world.tilesY
};

/** 运行时手感参数：由页面滑块改写，游戏逻辑每帧读取 */
export const TUNING = {
  turnRate: CONFIG.turn.rate,
  slowStrength: CONFIG.slowdown.strength,
  slowScale: CONFIG.slowdown.scale,
  respawnFreeze: CONFIG.player.respawnFreeze, // 复活 / 开局静止保护期（秒）
  aiLevel: CONFIG.ai.difficulty.level,        // AI 难度系数 0~1（≤0.5 = 旧版手感）
  aiMistake: CONFIG.ai.difficulty.mistakeRate,// AI 走神失误频率 0~1
  aiPressure: CONFIG.ai.pressure.default,     // AI 压迫强度 0~1（0 = 关掉攻击/生存增强）
  girthMax: CONFIG.snake.girth.default,       // 大蛇最大加粗倍率 1.00~2.00（半径倍数）
  headStyleOn: CONFIG.ai.headStyle.enabled    // NPC 蛇头造型总开关（关掉 = 全部原版头）
};

/**
 * 蛇的半径（视觉 + 判定共用的唯一真相源）
 * ------------------------------------------------------------
 * 长度从 startSegments 涨到 girth.atSegments 的过程中，半径从 1.00× 线性涨到
 * TUNING.girthMax（默认 2.00×，即粗细 +100%），到顶后不再变粗。
 *
 * 为什么判定也用这个：如果只把画面画粗、判定仍按固定半径，大蛇会看起来
 * 身上贴着对方却毫发无损，玩家会认为"打不中"是 bug。这里统一口径，
 * 代价是大蛇更容易被撞、也更容易撞到别人 —— 与「越大越笨重」的既定手感一致。
 *
 * @param {number} segments 该蛇当前节数（含头）
 * @returns {number} 半径（世界像素）
 */
export function snakeRadius(segments) {
  const G = CONFIG.snake.girth;
  const R0 = CONFIG.snake.radius;
  if (!G.enabled) return R0;

  const len = Number.isFinite(segments) ? segments : CONFIG.snake.startSegments;
  const top = Number.isFinite(TUNING.girthMax) ? TUNING.girthMax : G.max;
  // 上限夹在 [min, max]：滑块之外（比如旧存档 / 代码里直接写）也不会画出离谱的粗细
  const mulTop = Math.min(G.max, Math.max(G.min, top));

  const start = CONFIG.snake.startSegments;
  const span = Math.max(1, G.atSegments - start);
  const t = Math.min(1, Math.max(0, (len - start) / span));
  // 曲线只作用在"加粗的增量"上，mul = 1 + (mulTop - 1) × t^curve
  const mul = 1 + (mulTop - 1) * Math.pow(t, G.curve > 0 ? G.curve : 1);
  return R0 * mul;
}

/**
 * 统一的「AI 压迫强度」计算（Brain 与 Game 共用，避免两处口径漂移）
 * ------------------------------------------------------------
 * 难度 ≤ pressure.start 时恒为 0 ⇒ 旧版行为逐位可复现；
 * 单独把 aiPressure 拉到 0 也能随时退回旧手感做 A/B 对照。
 * @param {object} tune 运行时手感参数（默认 TUNING）
 * @returns {number} 0~1
 */
export function computeAiPressure(tune = TUNING) {
  const P = CONFIG.ai.pressure;
  const D = CONFIG.ai.difficulty;
  const lv = Number.isFinite(tune.aiLevel) ? tune.aiLevel : D.level;
  const pr = Number.isFinite(tune.aiPressure) ? tune.aiPressure : P.default;
  const clamp01 = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  return clamp01((lv - P.start) / Math.max(1e-3, 1 - P.start), 0, 1)
       * clamp01(pr, P.min, P.max);
}
