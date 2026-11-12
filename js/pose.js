/**
 * 体感输入模块
 * ------------------------------------------------------------
 * 用 MediaPipe Pose Landmarker 从摄像头里取人体骨骼，转成贪吃蛇的控制信号。
 *
 * 核心映射（按需求）：
 *   1) 圆心 C = 沿「脖子(双肩中点) → 腰(双髋中点)」连线按 centerT 插值，
 *      0 = 脖子、1 = 腰，默认 0.35 = 胸口；0.5 与旧版四点平均严格等价
 *   2) 右手腕 W 相对圆心的朝向 → 蛇头目标前进方向（方向只认这一个量）
 *   3) 手腕离圆心的归一化距离 → 速度倍率（越远越快，默认 0.65~1.40 倍，带防抖）
 *      手肘关键点仍参与「手臂是否可靠」的可见性判定与骨架绘制，但不再影响操控。
 *
 * 坐标约定：
 *   MediaPipe 输出的是原始帧的归一化坐标。摄像头是"照镜子"关系，
 *   这里统一翻转为镜像坐标（x -> 1-x），保证玩家往左伸手，画面里也往左。
 *   角度计算使用像素坐标，避免 4:3 视频与 16:9 画布宽高比不一致导致的角度畸变。
 */

import { openCameraStream } from './diag.js';
import { clamp } from './utils.js';

// ---------------- 姿态模型资源：本地优先，CDN 兜底 ----------------
// 项目自带 vendor/mediapipe（约 25MB：JS 库 + WASM + lite 模型），由 serve.py 提供。
// 这样体感识别不依赖外网，也不会被公司代理、DNS 或预览面板的 CSP 拦掉。
// 若页面被放到别的静态服务（例如编辑器内置预览）而拿不到 vendor，自动退回在线 CDN。
const CDN_VISION_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const CDN_MODEL_URLS = [
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'
];

/**
 * 把 vendor 下的文件转成基于当前页面的绝对 URL。
 * 用页面地址而不是模块地址：打包成 play.html 后模块内联在 HTML 里，
 * 相对路径会解析到错误的位置；基于 document.baseURI 则两种形态都对。
 */
function vendorUrl(file) {
  let base;
  try { base = document.baseURI || location.href; } catch (e) { base = location.href; }
  try { return new URL(`vendor/mediapipe/${file}`, base).href; } catch (e) { return ''; }
}

/** 构造一整套资源方案：库、WASM 目录、模型必须来自同一来源，避免版本混搭 */
function buildPacks() {
  const localVision = vendorUrl('vision_bundle.js');
  const localWasm = vendorUrl('wasm');
  const localModel = vendorUrl('pose_landmarker_lite.task');

  // 方案一：与页面同源的 vendor（8123 服务器直接提供，最快且完全离线）
  const packs = [{
    label: '本地模型包',
    detail: 'vendor/mediapipe（无需外网）',
    vision: localVision,
    wasm: localWasm,
    models: [localModel],
    probe: [localVision, `${localWasm}/vision_wasm_internal.wasm`, localModel]
  }];

  // 方案二：页面跑在编辑器内置预览等别的端口时，那个服务往往不提供 vendor 目录。
  // 只要项目自带的 8123 服务器在跑，就跨域从它取同一套本地资源（serve.py 已开 CORS）。
  // 只探一个小文件、超时给 1.5 秒，服务器没开时不会拖慢启动。
  try {
    if (location.protocol.indexOf('http') === 0 && location.host !== '127.0.0.1:8123') {
      const base = 'http://127.0.0.1:8123/vendor/mediapipe';
      packs.push({
        label: '本地服务器 8123',
        detail: '127.0.0.1:8123/vendor/mediapipe（跨域）',
        vision: `${base}/vision_bundle.js`,
        wasm: `${base}/wasm`,
        models: [`${base}/pose_landmarker_lite.task`],
        probe: [`${base}/vision_bundle.js`],
        probeTimeout: 1500
      });
    }
  } catch (e) { /* 极端环境下 location 不可读，跳过这条兜底即可 */ }

  // 方案三：前两条都不可用时才走外网
  packs.push({
    label: '在线 CDN',
    detail: 'jsdelivr + storage.googleapis.com',
    vision: `${CDN_VISION_BASE}/vision_bundle.mjs`,
    wasm: `${CDN_VISION_BASE}/wasm`,
    models: CDN_MODEL_URLS,
    probe: [
      `${CDN_VISION_BASE}/vision_bundle.mjs`,
      `${CDN_VISION_BASE}/wasm/vision_wasm_internal.wasm`,
      ...CDN_MODEL_URLS
    ],
    // 外网比本地慢且受代理影响，单独放宽到 12 秒。
    // 探测是并行的，总耗时仍远小于模型阶段 35 秒的看门狗
    probeTimeout: 12000
  });
  return packs;
}

// MediaPipe Pose 的 33 点索引
const LM = {
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24
};

// 用于在摄像头预览窗里画简笔骨架的连线（只取上半身，避免画面太花）
const SKELETON_EDGES = [
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_SHOULDER, LM.L_ELBOW],
  [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW],
  [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_SHOULDER, LM.L_HIP],
  [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_HIP, LM.R_HIP]
];

/**
 * 轻量探测资源是否可达（HEAD 为主，不支持 HEAD 的静态服务退回 GET）。
 * 只判断可达性、不下载 6MB 模型；真正下载交给 MediaPipe，失败再换下一套来源。
 * 每一步都自带超时，避免 CDN 请求悬着把整个启动流程拖死。
 */
async function reachable(url, timeoutMs = 8000) {
  if (!url) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: 'HEAD', signal: ac.signal, cache: 'no-store' });
    // 个别静态服务没实现 HEAD，退回一次 GET 确认
    if (!res.ok && (res.status === 405 || res.status === 501)) {
      res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    }
    return !!res.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检查一套资源里 JS 库 / WASM / 模型是否都可达。
 * 并行探测：顺序 await 时三个 URL 的耗时会累加，冷启动下很容易让最后一个
 * 踩到单次超时，把明明能用的 CDN 误判成「全部来源不可用」。
 */
async function packReachable(pack) {
  const ms = pack.probeTimeout || 8000;
  const results = await Promise.all(pack.probe.map((url) => reachable(url, ms)));
  return results.every(Boolean);
}

/**
 * 按「本地 → 8123 跨端口 → 在线 CDN」找到第一个资源齐全的方案。
 * 命中即返回，其余方案只作为初始化失败时的备选保留，不在正常路径上探测，
 * 这样本地包可用时浏览器不会向外网发出任何一个请求。
 */
async function availablePacks(onProgress) {
  const packs = buildPacks();

  // 预热已经把本地 vendor 的 WASM 与模型整份读完了 —— 本地包必然可用，
  // 不必再对三个文件各发一次 HEAD 去"确认"。公网下这三次往返要 0.5~1 秒，
  // 而结果一定是已知的。失败时下面照旧可以降级到 8123 / CDN。
  if (warmupProgress.done) {
    return {
      primary: packs[0],
      fallback: packs.slice(1),
      tried: [`${packs[0].label}（预热已确认）`]
    };
  }

  const tried = [];
  for (const pack of packs) {
    onProgress(`正在检查姿态模型包：${pack.label}…`);
    const good = await packReachable(pack);
    tried.push(`${pack.label}（${good ? '可用' : '不可用'}）`);
    if (good) {
      return { primary: pack, fallback: packs.filter((p) => p !== pack), tried };
    }
  }
  // 探测只是「优先用哪套」的排序提示，绝不能当成硬门槛：
  // HEAD 可能被 CDN 限流、被代理改写、或被一次网络抖动打断，但真正
  // 下载模型的 GET 仍然可用。全都没探通时，把最后一档交给 MediaPipe
  // 实打实加载一次，由真实结果决定成败，避免把可用资源误判成全断。
  const last = packs[packs.length - 1];
  onProgress(`探测未通过，直接尝试${last.label}…`);
  return { primary: last, fallback: [], tried, unverified: true };
}

/**
 * 给任意 Promise 加一道硬超时
 * ------------------------------------------------------------
 * MediaPipe 在部分手机 / 显卡上用 GPU delegate 初始化时，会「既不 resolve 也不 reject」，
 * 一直悬在那里。没有这道闸门，启动流程就永久停在「正在加载姿态模型」，
 * 玩家只看到摄像头亮着、游戏不动，完全没法判断是哪一步坏了。
 * 超时后我们让流程继续往下走（改试 CPU、或换下一套资源），
 * 被丢下的那个 Promise 之后自己完成也没关系 —— 调用点后面的 guard() 会按启动代号丢弃它。
 */
function withTimeout(promise, ms, label) {
  if (!(ms > 0)) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error(`${label}超时（${Math.round(ms / 1000)} 秒无响应）`);
      e.name = 'StageTimeoutError';
      reject(e);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * 预热体感资源：把 WASM 与模型提前拉进浏览器缓存
 * ------------------------------------------------------------
 * 这两份文件（WASM 8.99MB → gzip 2.87MB，模型 5.5MB → gzip 4.84MB）原本都要等到
 * 「点开始游戏 → 玩家点了允许摄像头」之后才开始下载，等于授权那几秒完全白等。
 * 手机走公网时实测这一段占启动总时间的一半以上。
 *
 * 现在改成：标题画面一出现就在后台预取，玩家读规则 / 选人数的时间正好用来下文件。
 * 返回的 Promise 会被 init() 复用 —— 如果玩家点得很快、预热还没下完，
 * init 等它而不是再发一遍请求，避免同两个文件下两遍。
 *
 * 只预取本地 vendor 包：预热是为了走"本地优先"这条最快路径；
 * 本地包缺失时真正的加载流程会自己降级到 CDN，不需要在这里提前探测。
 */
let warmupPromise = null;
/** 预取进度（0~1），标题画面用它显示「正在准备体感资源 42%」 */
export const warmupProgress = { ratio: 0, done: false, failed: false };

export function warmupPoseAssets() {
  if (warmupPromise) return warmupPromise;
  const urls = [
    vendorUrl('wasm/vision_wasm_internal.wasm'),
    vendorUrl('pose_landmarker_lite.task')
  ].filter(Boolean);

  let total = 0;   // 已知的总字节（按响应头累计，第二个文件到达前只是一半）
  let got = 0;     // 已读字节
  const update = () => {
    if (total > 0) warmupProgress.ratio = Math.min(1, got / total);
  };

  /** 读一个文件并读完 body：只读不存，目的是让浏览器把它放进 HTTP 缓存 */
  const pull = async (u) => {
    try {
      const res = await fetch(u, { cache: 'force-cache' });
      if (!res.ok) return;
      const len = Number(res.headers.get('content-length') || 0);
      total += len;
      if (!res.body || typeof res.body.getReader !== 'function') {
        // 老浏览器没有流式 body：退化成整块读，只是看不到中途进度
        const buf = await res.arrayBuffer();
        got += buf.byteLength;
        update();
        return;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        update();
      }
    } catch (e) { /* 单个文件失败无所谓，真正的加载会自己重试 */ }
  };

  warmupPromise = Promise.all(urls.map(pull))
    .then(() => {
      warmupProgress.done = true;
      warmupProgress.ratio = 1;
    })
    .catch(() => { warmupProgress.failed = true; });
  return warmupPromise;
}

/**
 * 体感追踪器
 */
export class PoseTracker {
  constructor(config) {
    this.cfg = config.pose;
    // 启动阶段的时间闸门（见 withTimeout）。单独取出来，切到 CPU 时用更大的一档
    this.bootCfg = config.boot || {};
    this.video = null;
    this.landmarker = null;
    this.ready = false;
    // 实际选中的模型资源来源，启动失败时写进诊断面板便于定位
    this.assetSource = '未检测';

    // 启动代号。每次 init 递增；超时或用户取消后再递增，
    // 让"迟到的"异步结果作废，避免摄像头被偷偷打开却没人管
    this._gen = 0;

    // 帧尺寸（像素），用于把归一化坐标换算到像素空间
    this.frameW = 1;
    this.frameH = 1;

    // 上一次处理的视频时间，避免同一帧被重复推理
    this._lastVideoTime = -1;
    this._lastInferAt = -Infinity;
    this._frame = 0;

    // ---- 多人识别槽位 ----
    // 单人模式只有 1 个槽位；双人模式 2 个（画面左半 / 右半各一个）。
    // 「每帧记住上一次状态」的东西全部挂在槽位上，两个人互不干扰。
    this.maxPoses = 1;
    this.slots = [this._makeSlot(0)];
    // 兼容旧接口：tracker.signal 恒等于玩家 1 的信号
    this.signal = this.slots[0].signal;
    // 双人模式给主循环用：signals[0] = 左半屏玩家，signals[1] = 右半屏玩家
    this.signals = [this.signal];

    // 模型创建参数：切换人数要重建 landmarker（numPoses 只能在创建时指定）
    this._vision = null;
    this._fileset = null;
    this._modelUrl = '';
    this._rebuildSeq = 0;
  }

  /**
   * 造一个「被识别者专用」的状态槽
   * ------------------------------------------------------------
   * 每个槽位自带方向角 / 速度平滑 / 举手计时 / 圆心学习 / 输出信号。
   * 双人模式下这些状态必须分开，否则一个人的手会改写另一个人的方向。
   */
  _makeSlot(index) {
    return {
      index,
      speedTarget: 1,          // 原始目标倍率
      smSpeed: 1,              // 低通 + 变化率限制后的实际输出
      _lastSpeedAt: -Infinity,
      lastAngle: null,         // 上一次有效的方向角
      lastSeenAt: -Infinity,
      raiseTimer: 0,           // 举手持续秒数
      _raiseStartAt: null,
      _armOnRight: null,       // 手臂归属缓存
      _armLabel: 'auto/right',
      _seenSince: null,        // 连续识别到人的起点
      _lostReason: '',
      _cxState: { min: NaN, max: NaN, n: 0 },
      _cxShift: 0,
      signal: {
        seen: false,      // 本帧是否真的检测到人体
        hold: false,      // 是否在使用保持的旧方向
        angle: 0,         // 目标朝向（弧度，屏幕坐标系，y 轴向下）—— 方向唯一输入
        speedScale: 1,    // 手腕距离映射出的速度倍率（默认 0.65~1.40，已平滑）
        raised: false,    // 手腕是否高于圆心
        landmarks: null,  // 镜像后的归一化骨骼点
        center: null,     // 圆心（像素坐标，已镜像）
        neck: null,       // 刻度 0 的脖子基准点
        waist: null,      // 刻度 1 的腰部基准点
        wrist: null,
        elbow: null,
        debug: null       // 实时诊断数据，HUD 与体感日志共用
      }
    };
  }

  /**
   * 切换同时识别的人数（1 / 2）
   * ------------------------------------------------------------
   * MediaPipe 的 numPoses 只能在创建 landmarker 时指定，所以切换要重建模型。
   * 重建走异步：失败时保留旧模型（单人仍可玩），绝不把摄像头打断。
   * @param {number} n 1 或 2
   * @returns {number} 目标人数
   */
  setMaxPoses(n) {
    const v = n >= 2 ? 2 : 1;
    if (v === this.maxPoses) return this.maxPoses;
    this.maxPoses = v;
    this.slots = [];
    for (let i = 0; i < v; i++) this.slots.push(this._makeSlot(i));
    this.signal = this.slots[0].signal;
    this.signals = this.slots.map((s) => s.signal);
    // 还没加载模型（或正在启动）时不用重建：init 会按当前 maxPoses 创建
    if (this.ready) this._rebuildLandmarker(v);
    return v;
  }

  /** 用已缓存的模型资源重建 landmarker（numPoses 变化时调用） */
  async _rebuildLandmarker(n) {
    if (!this._vision || !this._fileset || !this._modelUrl) return;
    const seq = ++this._rebuildSeq;
    try {
      const next = await this._createLandmarker(n);
      // 期间又切了人数 / 重新启动过 → 这次结果作废，关掉它避免泄漏
      if (seq !== this._rebuildSeq || !next) {
        if (next?.close) next.close();
        return;
      }
      const old = this.landmarker;
      this.landmarker = next;
      if (old?.close) {
        try { old.close(); } catch (e) { /* 已被释放，忽略 */ }
      }
    } catch (e) {
      // 重建失败：保留旧模型（单人识别照常工作），只在诊断里留痕
      this.assetSource += ' · 双人模型重建失败，已退回单人识别';
    }
  }

  /** 按当前缓存资源创建一个 landmarker，GPU 失败自动退回 CPU */
  async _createLandmarker(n) {
    let lastErr = null;
    for (const delegate of ['GPU', 'CPU']) {
      try {
        return await this._vision.PoseLandmarker.createFromOptions(this._fileset, {
          baseOptions: { modelAssetPath: this._modelUrl, delegate },
          runningMode: 'VIDEO',
          numPoses: n,
          minPoseDetectionConfidence: this.cfg.minConfidence,
          minPosePresenceConfidence: this.cfg.minConfidence,
          minTrackingConfidence: this.cfg.minConfidence
        });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('landmarker 创建失败');
  }

  /**
   * 打开摄像头 + 加载模型
   * @param {HTMLVideoElement} videoEl
   * @param {(msg:string)=>void} onProgress 进度回调，用于提示 UI
   * @param {()=>void} onStreamReady 摄像头出画面时立刻回调（模型可能还没好）
   */
  async init(videoEl, onProgress = () => {}, onStreamReady = () => {}) {
    this.video = videoEl;

    // 本次启动的代号。外部调用 abort() 后 _gen 变化，所有关键等待点都要检查它，
    // 一旦过期就立刻收摊，不能让挂起的请求在后台继续跑
    const gen = ++this._gen;
    /** 构造一个统一的"已中止"错误 */
    const aborted = () => {
      const e = new Error('启动已取消或超时');
      e.name = 'AbortError';
      return e;
    };
    /** 关键等待点之后调用：不属于本次启动就中止 */
    const guard = () => { if (this._gen !== gen) throw aborted(); };

    // 前置检查：不满足条件时不必浪费时间去下载 6MB 模型
    if (!window.isSecureContext) {
      const e = new Error('页面不是安全上下文');
      e.name = 'SecurityError';
      throw e;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      const e = new Error('浏览器不支持 getUserMedia');
      e.name = 'NotSupportedError';
      throw e;
    }

    onProgress('正在请求摄像头…');
    // 分级放宽约束，尽量在各种摄像头/虚拟摄像头上都能出画面
    const stream = await openCameraStream(this.cfg);
    // 请求挂起后被超时中止，但 Promise 后来又返回了流 —— 必须立刻关掉轨道，
    // 否则摄像头会一直被占用，之后重试必然 NotReadableError
    if (this._gen !== gen) {
      for (const t of stream.getTracks()) t.stop();
      throw aborted();
    }
    videoEl.srcObject = stream;
    this.stream = stream;
    await videoEl.play();
    guard();

    // 等首帧就绪，拿到真实的视频分辨率。给个超时，避免设备"给了流但不出画面"时无限等待
    await new Promise((resolve, reject) => {
      const start = performance.now();
      const check = () => {
        if (this._gen !== gen) return reject(aborted());
        if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) return resolve();
        if (performance.now() - start > 8000) {
          const e = new Error('摄像头已授权但一直没有画面');
          e.name = 'NotReadableError';
          return reject(e);
        }
        requestAnimationFrame(check);
      };
      check();
    });
    guard();
    this.frameW = videoEl.videoWidth;
    this.frameH = videoEl.videoHeight;
    // 摄像头这一关已经过了，先通知外部把预览窗亮起来。
    // 即使后面模型加载失败，玩家也能看到"摄像头本身是好的"，便于定位问题
    onStreamReady();
    onProgress(`摄像头就绪 ${this.frameW}×${this.frameH}，正在准备姿态模型…`);

    // 标题画面期间已经在后台预取 WASM 与模型。玩家点得快时它们可能还没下完，
    // 在这里等预热结束，避免 MediaPipe 再向同一 URL 发一遍请求（等于下两遍 8MB）。
    // 失败或超时都放行 —— 真正的加载流程会自己重新请求，不能因为预热失败卡住启动。
    try {
      await withTimeout(warmupPoseAssets(), 20000, '资源预热');
    } catch (e) { /* 预热失败不影响正常加载 */ }
    guard();

    // 先探测可用资源（本地包优先），再逐套尝试初始化。
    // 本地包存在但 WASM 的 MIME 不对 / 文件损坏时，也能自动切到在线 CDN。
    let sources;
    try {
      sources = await availablePacks(onProgress);
    } catch (e) {
      e.assetDetail = vendorUrl('pose_landmarker_lite.task');
      throw e;
    }
    guard();

    const candidates = [sources.primary, ...sources.fallback];
    let landmarker = null;
    let lastErr = null;
    let usedPack = null;
    for (let i = 0; i < candidates.length; i++) {
      const pack = candidates[i];
      // 备选方案只在首选真的初始化失败后才探测，正常路径零外网请求
      if (i > 0) {
        onProgress(`正在检查备用姿态模型包：${pack.label}…`);
        const ok = await packReachable(pack);
        guard();
        if (!ok) continue;
      }
      this.assetSource = `${pack.label} · ${pack.detail}`;
      // 每一步都单独上闸：任一环节悬住都能被切断，界面上的阶段名也能告诉我们卡在哪
      const ST = this.bootCfg.stage || {};
      const tImport = ST.importMs || 20000;
      const tFileset = ST.filesetMs || 30000;
      const tGpu = ST.createGpuMs || 25000;
      const tCpu = ST.createCpuMs || 45000;
      const stageLog = this.stageLog = [];
      /** 记一条阶段耗时，失败后能看到到底是哪一步慢死 / 挂死 */
      const mark = (label, t0, extra = '') => {
        const ms = Math.round(performance.now() - t0);
        stageLog.push(`${label} ${ms}ms${extra}`);
        return ms;
      };

      try {
        let t0 = performance.now();
        onProgress(`① 加载识别库（${pack.label}）…`);
        const vision = await withTimeout(import(pack.vision), tImport, '识别库加载');
        mark('识别库', t0);
        guard();

        t0 = performance.now();
        onProgress('② 编译 WASM 运行时…');
        const fileset = await withTimeout(
          vision.FilesetResolver.forVisionTasks(pack.wasm), tFileset, 'WASM 运行时初始化'
        );
        mark('WASM', t0);
        guard();

        // GPU 推理失败时自动回退 CPU，保证兼容性。
        // 注意：手机上 GPU 初始化有时不是"失败"而是"永远不回话"，所以这里也必须有超时。
        for (const url of pack.models) {
          for (const delegate of ['GPU', 'CPU']) {
            t0 = performance.now();
            onProgress(`③ 创建姿态模型（${delegate === 'GPU' ? 'GPU 加速' : 'CPU'}）…`);
            try {
              landmarker = await withTimeout(
                vision.PoseLandmarker.createFromOptions(fileset, {
                  baseOptions: { modelAssetPath: url, delegate },
                  runningMode: 'VIDEO',
                  // 双人模式要同时检出两个人；切换人数时由 setMaxPoses 重建
                  numPoses: this.maxPoses,
                  minPoseDetectionConfidence: this.cfg.minConfidence,
                  minPosePresenceConfidence: this.cfg.minConfidence,
                  minTrackingConfidence: this.cfg.minConfidence
                }),
                delegate === 'GPU' ? tGpu : tCpu,
                `模型初始化（${delegate}）`
              );
              mark(`模型-${delegate}`, t0);
              guard();
              break;
            } catch (e) {
              mark(`模型-${delegate}`, t0, `（失败：${e?.name || 'Error'}）`);
              if (this._gen !== gen) throw aborted();
              lastErr = e;
            }
          }
          if (landmarker) {
            // 缓存创建参数：切换人数时要用同一套资源重建 landmarker
            this._vision = vision;
            this._fileset = fileset;
            this._modelUrl = url;
            break;
          }
        }
        if (landmarker) { usedPack = pack; break; }
      } catch (e) {
        // 启动被取消/超时，交给外层看门狗收场，别再换源浪费时间
        if (this._gen !== gen || e?.name === 'AbortError' || e?.name === 'StartTimeoutError') throw e;
        lastErr = e;
      }
    }
    guard();
    if (!landmarker) {
      const e = new Error(`姿态模型初始化失败（${this.assetSource}）：${lastErr?.message || '未知错误'}`);
      e.name = 'ModelLoadError';
      e.assetSource = this.assetSource;
      // 附上每一档资源的探测结论，诊断页能说清「本地没找到 / CDN 探测也没过」
      e.assetTried = sources.tried;
      // 每一阶段的耗时 / 失败点，诊断面板和日志里直接能看出卡在哪一步
      e.stageLog = this.stageLog || [];
      e.assetDetail = vendorUrl('pose_landmarker_lite.task');
      throw e;
    }
    this.landmarker = landmarker;
    this.assetSource = `${usedPack.label} · ${usedPack.detail}（已就绪）`;

    this.ready = true;
    onProgress(`就绪（${this.frameW}×${this.frameH}）`);
    return true;
  }

  /** 释放摄像头（避免占用导致下次启动失败） */
  release() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.ready = false;
  }

  /**
   * 中止正在进行的 init（启动超时 / 用户点「取消启动」时调用）
   * 递增代号让所有迟到的异步结果作废，同时立刻释放已拿到的媒体流。
   */
  abort() {
    this._gen++;
    this.release();
  }

  /**
   * 每帧调用一次：推理 + 生成控制信号
   * @param {number} nowMs 单调递增的时间戳（毫秒）
   */
  update(nowMs) {
    if (!this.ready) return this.signal;
    const cfg = this.cfg;

    // 同一帧视频只推理一次；但 currentTime 长时间不动的摄像头也必须继续推理，
    // 否则那种设备会永远返回同一份旧信号，看起来像"识别死了"
    const stale = nowMs - this._lastInferAt >= cfg.inferStaleMs;
    if (this.video.currentTime === this._lastVideoTime && !stale) return this.signal;
    this._lastVideoTime = this.video.currentTime;
    this._lastInferAt = nowMs;
    this._frame++;

    let result = null;
    try {
      result = this.landmarker.detectForVideo(this.video, nowMs);
    } catch (e) {
      // 偶发的推理异常不应打断游戏
      for (const slot of this.slots) {
        this._markLostSlot(slot, nowMs, 'infer-error:' + (e?.message || 'unknown'));
      }
      return this.signal;
    }

    const raws = (result?.landmarks || []).filter((r) => r && r.length >= 25);

    // ---- 单人模式：只认第一个人 ----
    if (this.slots.length === 1) {
      if (raws.length) this._processPose(this.slots[0], raws[0], nowMs);
      else this._markLostSlot(this.slots[0], nowMs, 'no-pose');
      return this.signal;
    }

    // ---- 双人模式：按「镜像后的肩中点横坐标」分左右 ----
    // 镜像坐标 x 小 = 玩家在画面里看到的左侧 = 左边那块分屏。
    // 于是两人各控一半屏幕；互换站位时控制权跟着换，和分屏画面的逻辑一致。
    const scored = raws.map((raw) => ({
      raw,
      mx: 1 - (raw[LM.L_SHOULDER].x + raw[LM.R_SHOULDER].x) / 2
    })).sort((a, b) => a.mx - b.mx);

    const used = [false, false];
    for (const it of scored) {
      const idx = it.mx < 0.5 ? 0 : 1;
      // 两个人挤在同一侧：第二个人忽略，避免抢同一半屏
      if (used[idx]) continue;
      used[idx] = true;
      this._processPose(this.slots[idx], it.raw, nowMs);
    }
    for (let i = 0; i < 2; i++) {
      if (!used[i]) {
        this._markLostSlot(this.slots[i], nowMs, raws.length ? 'one-person' : 'no-pose');
      }
    }
    return this.signal;
  }

  /**
   * 处理一个人的一帧姿态，写进他专属的槽位
   * ------------------------------------------------------------
   * 原 update() 的主体原样搬进来，只是把「记住上一次」的状态全部从 this
   * 移到 slot：两个人各有各的方向角、速度平滑、举手计时、圆心学习，
   * 否则一个人举手会把另一个人也判成举手，速度也会互相覆盖。
   * @param {object} slot 槽位（见 _makeSlot）
   * @param {Array} raw MediaPipe 原始关键点（未镜像的归一化坐标）
   * @param {number} nowMs 单调时间戳
   */
  _processPose(slot, raw, nowMs) {
    const cfg = this.cfg;
    const s = slot.signal;
    const W = this.frameW;
    const H = this.frameH;

    // ---- 转成镜像坐标 + 像素坐标 ----
    const pts = raw.map((p) => ({
      nx: 1 - p.x,          // 镜像
      ny: p.y,
      px: (1 - p.x) * W,    // 镜像后的像素坐标
      py: p.y * H,
      v: p.visibility ?? 1
    }));

    // 选控制手臂（不再硬编码 16 号腕，见 pickArm）
    const arm = this.pickArm(slot, pts);
    const shoulder = pts[arm.ids[0]];
    const elbow = pts[arm.ids[1]];
    const wrist = pts[arm.ids[2]];
    const ls = pts[LM.L_SHOULDER];
    const rs = pts[LM.R_SHOULDER];
    const lh = pts[LM.L_HIP];
    const rh = pts[LM.R_HIP];

    // ---- 可见性分级 ----
    // 旧逻辑要求双肩+双髋四点全部可见，坐在桌前只露上半身时髋点不可用，
    // 整帧直接判死、蛇只直行 —— 这是"识别失效"最常见的现场。
    // 现在：肩必须有；髋缺失就降级；腕/肘太差则保持旧方向，不用坏坐标乱转。
    const shoulderVis = Math.min(ls.v, rs.v);
    const hipVis = Math.min(lh.v, rh.v);
    const armVis = Math.min(shoulder.v, elbow.v, wrist.v);
    if (shoulderVis < cfg.minVisibility) { this._markLostSlot(slot, nowMs, 'low-shoulder'); return; }
    if (armVis < cfg.minVisibility) { this._markLostSlot(slot, nowMs, 'low-arm'); return; }
    const useHips = hipVis >= cfg.hipVisibility;

    // ---- 圆心与归一化尺度 ----
    // 刻度定义：neck = 双肩中点（刻度 0，约颈窝），waist = 双髋中点（刻度 1，腰）。
    // 圆心 = neck + (waist - neck) × centerT。
    // t = 0.5 时展开正好是 (ls+rs+lh+rh)/4，与旧版四点平均完全一致，
    // 因此把滑块拉到 0.5 就能一比一复现改造前的手感，方便 A/B 对照。
    const neckX = (ls.px + rs.px) / 2;
    const neckY = (ls.py + rs.py) / 2;
    let waistX, waistY, torsoPx;
    if (useHips) {
      waistX = (lh.px + rh.px) / 2;
      waistY = (lh.py + rh.py) / 2;
      // 归一化尺度沿用旧算法（两侧肩→髋长度的平均），不改它，
      // 保证这次只动了"圆心位置"这一个变量，死区与举手阈值的行为可预期
      torsoPx = Math.max(40, (
        Math.hypot(ls.px - lh.px, ls.py - lh.py) +
        Math.hypot(rs.px - rh.px, rs.py - rh.py)
      ) / 2);
    } else {
      // 髋点不可见：用肩宽估出腰部位置。
      // 旧版把"双肩中点 + 0.75 肩宽"当作躯干中心（即 t=0.5），
      // 所以这里反推 waist = 1.5 肩宽，让降级模式下 t=0.5 也严格等价。
      const shoulderW = Math.max(40, Math.hypot(ls.px - rs.px, ls.py - rs.py));
      waistX = neckX;
      waistY = neckY + shoulderW * 1.5;
      torsoPx = shoulderW * 1.35;
    }
    // 单一真相源：CONFIG.pose.centerT，页面滑块直接改它，不再另设副本
    const centerT = this.centerT;
    const cxBase = neckX + (waistX - neckX) * centerT;
    const cy = neckY + (waistY - neckY) * centerT;

    // ---- 圆心横向：移到「右手左右伸展极限的中点」----
    // 人体骨骼左右不对称：右臂向同侧外展能伸到接近满臂长，向跨身体方向受躯干
    // 阻挡只剩一半多。圆心若死守躯干中线，右手往外侧更容易达到满速、往内侧几乎
    // 加不起来速，两侧手感就不对称。
    // 这里持续观测手腕相对中线的归一化横向位置（右为正），取左右极值的中点作为
    // 偏移量；只在手腕已经离开死区时采样，避免手停在身前晃动把范围学窄。
    const wristRelXN = (wrist.px - cxBase) / torsoPx;
    const preDistN = Math.hypot(wrist.px - cxBase, wrist.py - cy) / torsoPx;
    const shiftN = preDistN >= cfg.deadzone
      ? this._learnCenterX(slot, wristRelXN)
      : slot._cxShift;
    // 手动微调：页面上拖动滑块时叠加在自动值上，0 = 完全自动
    const manualN = Number.isFinite(this.cfg.centerX?.manual) ? this.cfg.centerX.manual : 0;
    const shiftTotalN = shiftN + manualN;
    const cx = cxBase + shiftTotalN * torsoPx;

    // ---- 方向：手腕相对圆心 ----
    // deadzone 必须来自 CONFIG.pose（this.cfg），早期误放在 CONFIG.turn 里，
    // 读到 undefined 会让这个分支永远不成立，方向角锁死在 0°。
    const dx = wrist.px - cx;
    const dy = wrist.py - cy;
    const dist = Math.hypot(dx, dy);
    const distN = dist / torsoPx;
    const deadzonePass = distN >= cfg.deadzone;
    if (deadzonePass) {
      // canvas 的 y 轴向下，atan2(dy, dx) 直接就是屏幕上的视觉角度
      slot.lastAngle = Math.atan2(dy, dx);
    }
    const angle = slot.lastAngle ?? 0;

    // ---- 距离 → 速度倍率 ----
    // distN = 手腕离圆心的距离 / 躯干基准长度，已按玩家体型归一化：
    // 高矮胖瘦、离摄像头远近不同，用的是同一套刻度。
    const SP = cfg.speed;
    if (deadzonePass) {
      // 只有死区外的坐标才可信；手贴在胸口附近时保持上一帧目标，速度不乱跳。
      // near/far 已收进真人一次伸手就能跨完的区间（默认 0.30~0.85），
      // 所以手臂从自然弯曲到伸直即可跑满 min→max，不再需要把胳膊拉到极限。
      const span = Math.max(0.05, SP.far - SP.near);
      const tSpeed = clamp((distN - SP.near) / span, 0, 1);
      slot.speedTarget = SP.min + (SP.max - SP.min) * tSpeed;
    }
    // 防抖 1：与帧率无关的一阶低通（smooth 是时间常数，秒）
    const dtSec = slot._lastSpeedAt === -Infinity
      ? 0
      : clamp((nowMs - slot._lastSpeedAt) / 1000, 0, 0.1);
    slot._lastSpeedAt = nowMs;
    const alpha = SP.smooth > 0 && dtSec > 0 ? 1 - Math.exp(-dtSec / SP.smooth) : 1;
    let nextSpeed = slot.smSpeed + (slot.speedTarget - slot.smSpeed) * alpha;
    // 防抖 2：变化率限制。左右手切换 / 髋点降级会让距离瞬间跳一大截，
    // 这里把跳变压成每秒最多 slew 的平滑过渡。
    const maxStep = SP.slew * dtSec;
    if (maxStep > 0) {
      nextSpeed = clamp(nextSpeed, slot.smSpeed - maxStep, slot.smSpeed + maxStep);
    }
    // 防抖 3：最终夹在用户设定的上下限内，滑块怎么拖都不会跑出承诺范围
    slot.smSpeed = clamp(nextSpeed, Math.min(SP.min, SP.max), Math.max(SP.min, SP.max));

    // ---- 举手判定（用于开始 / 重开）----
    const raiseRatio = (cy - wrist.py) / torsoPx;
    const raised = raiseRatio > cfg.raiseToStart;
    if (raised) {
      if (slot._raiseStartAt === null) slot._raiseStartAt = nowMs;
    } else {
      slot._raiseStartAt = null;
    }
    slot.raiseTimer = slot._raiseStartAt === null ? 0 : (nowMs - slot._raiseStartAt) / 1000;

    // ---- 组装输出 ----
    s.seen = true;
    s.hold = false;
    s.angle = angle;
    s.speedScale = slot.smSpeed;
    s.raised = raised;
    s.landmarks = pts;
    s.center = { x: cx, y: cy };
    s.neck = { x: neckX, y: neckY };
    s.waist = { x: waistX, y: waistY };
    s.wrist = { x: wrist.px, y: wrist.py };
    s.elbow = { x: elbow.px, y: elbow.py };
    slot.lastSeenAt = nowMs;
    slot._lostReason = '';
    if (slot._seenSince === null) slot._seenSince = nowMs;

    // 实时诊断数据：HUD 与体感日志共用同一份，避免两边各算一套
    s.debug = {
      frame: this._frame,
      hand: arm.label,
      armIds: arm.ids,
      useHips,
      // 顺序固定：左肩/右肩/左髋/右髋/肘/腕
      vis: [ls.v, rs.v, lh.v, rh.v, elbow.v, wrist.v],
      torsoPx: Math.round(torsoPx),
      distN: +distN.toFixed(3),
      speedScale: +slot.smSpeed.toFixed(3),
      speedTarget: +slot.speedTarget.toFixed(3),
      deadzonePass,
      angleDeg: +(angle * 180 / Math.PI).toFixed(1),
      raiseRatio: +raiseRatio.toFixed(3),
      centerT: +centerT.toFixed(2),
      // 圆心横向偏移（归一化）：auto = 学到的自动值，manual = 滑块微调，total = 实际生效
      centerX: +shiftTotalN.toFixed(3),
      centerXAuto: +shiftN.toFixed(3),
      centerXManual: +manualN.toFixed(3),
      centerXRange: [
        Number.isFinite(slot._cxState.min) ? +slot._cxState.min.toFixed(3) : null,
        Number.isFinite(slot._cxState.max) ? +slot._cxState.max.toFixed(3) : null
      ],
      center: { x: Math.round(cx), y: Math.round(cy) },
      neck: { x: Math.round(neckX), y: Math.round(neckY) },
      waist: { x: Math.round(waistX), y: Math.round(waistY) },
      wrist: { x: Math.round(wrist.px), y: Math.round(wrist.py) },
      elbow: { x: Math.round(elbow.px), y: Math.round(elbow.py) },
      size: [W, H],
      reason: ''
    };
  }

  /**
   * 本帧这个人的姿态不可用：清标记，并在 lostTimeoutMs 内沿用旧方向
   * reason 会进日志，用来区分"模型没检出人 / 肩不可见 / 手臂被遮挡 / 只识别到一个人"
   */
  _markLostSlot(slot, nowMs, reason) {
    const s = slot.signal;
    slot._lostReason = reason;
    s.seen = false;
    s.hold = nowMs - slot.lastSeenAt < this.cfg.lostTimeoutMs && slot.lastAngle !== null;
    // 短暂丢帧不打断自动开局计时，只有真的失去信号才归零
    if (!s.hold) slot._seenSince = null;
    s.debug = {
      frame: this._frame,
      hand: slot._armLabel,
      armIds: null,
      useHips: null,
      vis: null,
      distN: null,
      // 丢帧期间速度倍率保持上一帧的值，日志里也照实记，方便分析「保持」行为
      speedScale: +slot.smSpeed.toFixed(3),
      speedTarget: +slot.speedTarget.toFixed(3),
      deadzonePass: false,
      angleDeg: +((slot.lastAngle ?? 0) * 180 / Math.PI).toFixed(1),
      raiseRatio: null,
      centerT: +this.centerT.toFixed(2),
      reason,
      size: [this.frameW, this.frameH]
    };
    // 举手计时必须跟着断：人都不在画面里了，不能继续累积
    if (!s.hold) {
      slot._raiseStartAt = null;
      slot.raiseTimer = 0;
      s.landmarks = null;
      s.center = null;
      s.neck = null;
      s.waist = null;
      s.wrist = null;
      s.elbow = null;
    }
  }

  /**
   * 选控制手臂
   * ------------------------------------------------------------
   * MediaPipe 的 11/13/15 与 12/14/16 是两条手臂，左右命名在不同版本里
   * 按"被拍摄者"还是"图像"视角有过差异。这里统一按镜像后的画面位置判定：
   * x 更大的那条肩所连的手臂 = 玩家在镜像画面里看到的右手。
   * 带 20px 迟滞，肩部几乎重合时不会左右来回跳。
   * 迟滞缓存挂在槽位上：双人模式下两个人各自记各自的手臂归属。
   */
  pickArm(slot, pts) {
    const A = [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST];   // 12 / 14 / 16
    const B = [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST];   // 11 / 13 / 15
    const gap = pts[A[0]].px - pts[B[0]].px;
    if (Math.abs(gap) > 20) slot._armOnRight = gap > 0 ? A : B;
    else if (!slot._armOnRight) slot._armOnRight = A;

    const rightSet = slot._armOnRight;
    const leftSet = rightSet === A ? B : A;
    if (this.cfg.hand === 'left') {
      slot._armLabel = 'left';
      return { ids: leftSet, label: 'left' };
    }
    slot._armLabel = this.cfg.hand === 'right' ? 'right' : 'auto/right';
    return { ids: rightSet, label: slot._armLabel };
  }

  /** 切换控制手：'auto' | 'right' | 'left'（页面按钮直接调） */
  setHand(hand) {
    if (['auto', 'right', 'left'].includes(hand)) this.cfg.hand = hand;
    return this.cfg.hand;
  }

  /**
   * 距离→速度参数：页面滑块直接写 CONFIG.pose.speed（单一真相源），
   * 这里只负责按范围夹取，防止拖出 far <= near 之类的非法组合。
   * 改完立刻把当前平滑状态也夹进新区间，避免调参瞬间速度跳一下。
   * @param {string} key min | max | far | smooth
   * @param {number} v
   */
  setSpeedParam(key, v) {
    const SP = this.cfg.speed;
    if (!Number.isFinite(v) || !(key in SP)) return SP[key];
    // near / far 的合法上、下界互相依赖：始终保持 far - near >= 0.1，
    // 否则拖滑块把两端拖交叉会让映射退化成"非满速即满减速"的跳变。
    const R = {
      min: [SP.minLimit, SP.minCeil],
      max: [SP.maxFloor, SP.maxLimit],
      near: [SP.nearMin, Math.min(SP.nearMax, SP.far - 0.1)],
      far: [Math.max(SP.farMin, SP.near + 0.1), SP.farMax],
      smooth: [0, SP.smoothMax]
    }[key];
    if (!R) return SP[key];
    SP[key] = clamp(v, R[0], R[1]);
    const lo = Math.min(SP.min, SP.max);
    const hi = Math.max(SP.min, SP.max);
    // 每个槽位各自夹一遍（双人模式两个人的速度状态是分开的）
    for (const slot of this.slots) {
      slot.speedTarget = clamp(slot.speedTarget, lo, hi);
      slot.smSpeed = clamp(slot.smSpeed, lo, hi);
    }
    return SP[key];
  }

  /**
   * 圆心刻度（0 = 脖子 / 1 = 腰），读取时自动夹到合法范围。
   * 配置不完整时退回默认胸口值，不会算出 NaN 把方向搞死。
   */
  get centerT() {
    return clamp(
      Number.isFinite(this.cfg.centerT) ? this.cfg.centerT : 0.35,
      this.cfg.centerTMin ?? 0,
      this.cfg.centerTMax ?? 1
    );
  }

  /**
   * 学习「右手左右伸展极限的中点」，作为圆心的横向偏移
   * ------------------------------------------------------------
   * 输入是手腕相对躯干中线的归一化横向位置（画面右侧为正，已镜像）。
   * 维护两个缓慢回缩的极值：
   *   max —— 向画面右侧（玩家同侧）能伸到多远，通常更大
   *   min —— 向画面左侧（跨身体方向）能伸到多远，通常更小甚至为负
   * 取中点就是"两侧等距"的圆心位置。人体右臂向外侧伸得远、跨身体伸不远，
   * 所以中点自然落在躯干中线偏右的地方，正好补偿两侧加速不对称。
   *
   * 三个防抖设计：
   *   1) 极值每帧朝 0 缓慢回缩（decay），玩家很久不做某一侧动作时不会永久占位；
   *   2) 样本不足 minSamples 前不采用，避免开局手一抖就把圆心拽偏；
   *   3) 结果按 learn 低通跟随，圆心跳动不会直接变成蛇头抖动。
   * @param {object} slot 被识别者的槽位（极值与偏移都挂在他身上）
   * @param {number} relXN 手腕相对躯干中线的横向偏移 / 躯干长度（右为正）
   * @returns {number} 当前的横向偏移（同一归一化单位）
   */
  _learnCenterX(slot, relXN) {
    const C = this.cfg.centerX;
    if (!C || C.auto === false) {
      slot._cxShift = 0;
      return 0;
    }
    const st = slot._cxState;
    if (!Number.isFinite(relXN)) return slot._cxShift;
    if (!Number.isFinite(st.min)) { st.min = relXN; st.max = relXN; }

    // 极值更新 + 朝 0 的缓慢回缩（回缩量远小于一帧内的正常位移，不影响收敛）
    const rec = Number.isFinite(C.decay) ? C.decay : 0.0004;
    st.min = Math.max(-2, Math.min(relXN, st.min + rec));
    st.max = Math.min(2, Math.max(relXN, st.max - rec));
    st.n++;

    if (st.n < (C.minSamples ?? 45)) return slot._cxShift;

    // 没真正向两侧伸展过就别学：跨度太小说明玩家只在一小块区域里动，
    // 这时取中点纯属噪声，会把圆心拽偏。
    if (st.max - st.min < (C.minSpan ?? 0.5)) return slot._cxShift;

    // 人体同侧外展总比跨身体伸得远，所以中点理论上不会落在中线左侧；
    // 一旦算出来是负的（数据还不够），按 0 处理，绝不把圆心往左拽。
    const target = clamp((st.min + st.max) / 2, 0, C.maxShift);
    const k = clamp(Number.isFinite(C.learn) ? C.learn : 0.06, 0.005, 1);
    slot._cxShift += (target - slot._cxShift) * k;
    return slot._cxShift;
  }

  /** 当前自动横向偏移（归一化，供调试读数；默认玩家 1） */
  get centerShiftN() { return this.slots[0]._cxShift; }

  /** 设置圆心刻度，返回实际生效值（页面滑块 / 调试入口都走这里） */
  setCenterT(t) {
    if (!Number.isFinite(t)) return this.centerT;
    this.cfg.centerT = clamp(t, this.cfg.centerTMin ?? 0, this.cfg.centerTMax ?? 1);
    return this.cfg.centerT;
  }

  /**
   * 连续识别到人的时长（秒），用于 ready 状态自动开局
   * @param {number} i 槽位下标（双人模式传 1 取玩家 2 的）
   */
  seenDurationOf(i = 0) {
    const slot = this.slots[i] || this.slots[0];
    if (!slot || slot._seenSince === null) return 0;
    return (performance.now() - slot._seenSince) / 1000;
  }

  /** 兼容旧接口：玩家 1 的连续识别时长 */
  get seenDuration() { return this.seenDurationOf(0); }

  /** 某个槽位的举手持续秒数（双人模式两人各算各的） */
  raiseTimerOf(i = 0) {
    const slot = this.slots[i] || this.slots[0];
    return slot ? slot.raiseTimer : 0;
  }

  /** 兼容旧接口：玩家 1 的举手计时 */
  get raiseTimer() { return this.raiseTimerOf(0); }

  /**
   * 某个人是否已经"举手够久"
   * @param {number} i 槽位下标
   * @param {number} holdSec 需要的持续秒数，默认配置里的 raiseHoldSec
   */
  raiseConfirmedOf(i = 0, holdSec = this.cfg.raiseHoldSec) {
    return this.raiseTimerOf(i) >= holdSec;
  }

  /** 兼容旧接口：玩家 1 是否举手够久 */
  get raiseConfirmed() { return this.raiseConfirmedOf(0); }

  /** 重置举手计时（触发一次动作后调用，防连触）；不传则重置所有人 */
  resetRaise(i = null) {
    for (const slot of this.slots) {
      if (i !== null && slot.index !== i) continue;
      slot.raiseTimer = 0;
      slot._raiseStartAt = performance.now();
    }
  }

  /** 在预览窗里画简笔骨架，帮玩家确认自己有没有被识别到 */
  drawSkeleton(ctx, w, h, signal) {
    if (!signal.seen || !signal.landmarks) return;

    // 预览窗用的是 object-fit:cover（裁切填满），这里要复现同一套映射，
    // 否则非 4:3 的摄像头会让骨架和视频错位
    const vw = this.frameW;
    const vh = this.frameH;
    const targetRatio = w / h;
    const srcRatio = vw / vh;
    let sw = vw;
    let sh = vh;
    if (srcRatio > targetRatio) sw = vh * targetRatio;
    else sh = vw / targetRatio;
    const offX = (vw - sw) / 2;
    const offY = (vh - sh) / 2;
    const kx = w / sw;
    const ky = h / sh;
    /** 帧像素坐标 -> 预览窗坐标 */
    const mapX = (x) => (x - offX) * kx;
    const mapY = (y) => (y - offY) * ky;

    const pts = signal.landmarks;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 骨架线
    ctx.strokeStyle = 'rgba(160,255,190,0.85)';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(80,255,160,0.9)';
    ctx.shadowBlur = 8;
    for (const [a, b] of SKELETON_EDGES) {
      const p = pts[a];
      const q = pts[b];
      if (!p || !q) continue;
      if (p.v < 0.3 || q.v < 0.3) continue;
      ctx.beginPath();
      ctx.moveTo(mapX(p.px), mapY(p.py));
      ctx.lineTo(mapX(q.px), mapY(q.py));
      ctx.stroke();
    }

    // 圆心刻度尺：画出「脖子(0) → 腰(1)」这条基准线，
    // 拖滑块时玩家能直接看到圆心停在身体的哪个高度
    if (signal.neck && signal.waist) {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(190,160,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mapX(signal.neck.x), mapY(signal.neck.y));
      ctx.lineTo(mapX(signal.waist.x), mapY(signal.waist.y));
      ctx.stroke();
      ctx.setLineDash([]);
      // 端点只标 0 / 1：预览窗很小，写「0 脖子」会和圆心读数挤成一团
      ctx.fillStyle = 'rgba(205,185,255,0.95)';
      ctx.font = `bold ${Math.max(10, Math.round(w * 0.055))}px sans-serif`;
      for (const [p, label] of [[signal.neck, '0'], [signal.waist, '1']]) {
        ctx.beginPath();
        ctx.arc(mapX(p.x), mapY(p.y), 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(label, mapX(p.x) - 15, mapY(p.y) - 5);
      }
      ctx.restore();
    }

    // 圆心 → 手腕的"方向盘"连线，让玩家直观看懂控制方式
    if (signal.center) {
      const cx = mapX(signal.center.x);
      const cy = mapY(signal.center.y);
      const wx = mapX(signal.wrist.x);
      const wy = mapY(signal.wrist.y);

      ctx.shadowBlur = 12;
      ctx.strokeStyle = 'rgba(255,225,110,0.95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(wx, wy);
      ctx.stroke();

      // 箭头
      const a = Math.atan2(wy - cy, wx - cx);
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.lineTo(wx - Math.cos(a - 0.4) * 12, wy - Math.sin(a - 0.4) * 12);
      ctx.moveTo(wx, wy);
      ctx.lineTo(wx - Math.cos(a + 0.4) * 12, wy - Math.sin(a + 0.4) * 12);
      ctx.stroke();

      // 手腕点
      ctx.fillStyle = 'rgba(255,225,110,1)';
      ctx.beginPath();
      ctx.arc(wx, wy, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 圆心刻度读数固定在预览左上角，不随骨架移动，小窗里也始终清晰
    ctx.save();
    ctx.shadowBlur = 0;
    const fs = Math.max(10, Math.round(w * 0.055));
    ctx.font = `bold ${fs}px sans-serif`;
    const label = `圆心 ${(signal.debug?.centerT ?? 0).toFixed(2)}`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,5,20,0.66)';
    ctx.fillRect(6, 6, tw + 12, fs + 9);
    ctx.fillStyle = 'rgba(255,225,110,0.98)';
    ctx.fillText(label, 12, 6 + fs + 1);
    ctx.restore();

    ctx.restore();
  }
}
