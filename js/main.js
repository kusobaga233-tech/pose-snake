/**
 * 入口：装配模块 + 相机 + 主循环 + UI
 */

import { CONFIG, WORLD, TUNING, computeAiPressure, snakeRadius } from './config.js';
import { PoseTracker, warmupPoseAssets, warmupProgress } from './pose.js';
import { PoseLog } from './poselog.js';
import { FX } from './fx.js';
import { Game } from './game.js';
import { classifyCameraError, collectEnv } from './diag.js';
import {
  Background, drawSnake, drawFood, drawWorldWalls, drawPowerup, drawArenaOverlay
} from './render.js';
import { ResultStage } from './resultStage.js';
import { clamp, smoothK, dist2, safeStorage } from './utils.js';

// ---------------- 元素引用 ----------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });
const video = document.getElementById('video');
const camCanvas = document.getElementById('skeleton');
const camCtx = camCanvas.getContext('2d');

const elScore = document.getElementById('score');
const elLength = document.getElementById('length');
const elKills = document.getElementById('kills');
const elBest = document.getElementById('best');
// ---- 单局：倒计时 / 名次 / 实时榜 / 结算页 ----
const elTimeLeft = document.getElementById('timeLeft');
const elRank = document.getElementById('rank');
const elBestLength = document.getElementById('bestLength');
const elLeaderboard = document.getElementById('leaderboard');
const elLbRows = document.getElementById('lbRows');
const elLbTime = document.getElementById('lbTime');
const elResultOverlay = document.getElementById('resultOverlay');
const elResultTitle = document.getElementById('resultTitle');
const elResultRows = document.getElementById('resultRows');
const elResultStats = document.getElementById('resultStats');
const elAgainBtn = document.getElementById('againBtn');
const elSkipStageBtn = document.getElementById('skipStageBtn');
const elOverlay = document.getElementById('overlay');
const elPanelTitle = document.getElementById('panelTitle');
const elPanelDesc = document.getElementById('panelDesc');
const elStartBtn = document.getElementById('startBtn');
const elHint = document.getElementById('hint');
const elPanelHint = document.getElementById('panelHint');
const elAssetState = document.getElementById('assetState');
const elStatus = document.getElementById('status');
const elStatusDot = document.getElementById('statusDot');
const elMuteBtn = document.getElementById('muteBtn');
const elCamWrap = document.getElementById('cam');
// ---- 分区界面：战场容器 / 界面带 / 名次动态（3 米电视布局）----
const elArena = document.getElementById('arena');
const elUiBar = document.getElementById('uiBar');
const elRankBlock = document.getElementById('rankBlock');
const elRankArrow = document.getElementById('rankArrow');
const elPauseBuff = document.getElementById('pauseBuff');
const elDiag = document.getElementById('diag');
const elKbBtn = document.getElementById('kbBtn');
// 常驻按钮在启动遮罩之外（z-index 高于遮罩），任何状态都能一键脱困
const elQuickPlayBtn = document.getElementById('quickPlayBtn');
// 双人分屏专用节点（单人模式全部隐藏）
const elCam2 = document.getElementById('cam2');
const elSkel2 = document.getElementById('skeleton2');
const elRankBlock2 = document.getElementById('rankBlock2');
const elRank2 = document.getElementById('rank2');
const elRankK1 = document.getElementById('rankK1');
const elRankK2 = document.getElementById('rankK2');
const elPadMove = document.getElementById('padMove');
const elRankArrow2 = document.getElementById('rankArrow2');
const elCamSpeedVal2 = document.getElementById('camSpeedVal2');
const elCamSpeedFill2 = document.getElementById('camSpeedFill2');
const elReady1 = document.getElementById('camReady1');
const elReady2 = document.getElementById('camReady2');
const elPlayerSelect = document.getElementById('playerSelect');
const elPsBtns = Array.from(document.querySelectorAll('.ps-btn'));

// 标题画面的默认文案：诊断 / 重试会把面板临时改成报错信息，
// 回到标题时必须能原样还原，所以在这里先存一份。
const TITLE_TEXT = {
  title: elPanelTitle.textContent,
  desc: elPanelDesc.textContent,
  btn: elStartBtn.textContent
};
const elRules = document.getElementById('rulesList');
const elFineprint = document.getElementById('fineprint');
const elTuning = document.getElementById('tuning');
const elTuningBody = document.getElementById('tuningBody');
const elTuningToggle = document.getElementById('tuningToggle');
const sCenter = document.getElementById('sCenter');
const vCenter = document.getElementById('vCenter');
const sCenterX = document.getElementById('sCenterX');
const vCenterX = document.getElementById('vCenterX');
const sTurn = document.getElementById('sTurn');
const vTurn = document.getElementById('vTurn');
// 距离→速度的五个可调参数（下限 / 上限 / 起速距离 / 满速距离 / 平滑时间常数）
const sSpeedMin = document.getElementById('sSpeedMin');
const vSpeedMin = document.getElementById('vSpeedMin');
const sSpeedMax = document.getElementById('sSpeedMax');
const vSpeedMax = document.getElementById('vSpeedMax');
const sSpeedNear = document.getElementById('sSpeedNear');
const vSpeedNear = document.getElementById('vSpeedNear');
const sSpeedFar = document.getElementById('sSpeedFar');
const vSpeedFar = document.getElementById('vSpeedFar');
const sSpeedSmooth = document.getElementById('sSpeedSmooth');
const vSpeedSmooth = document.getElementById('vSpeedSmooth');
const sSlow = document.getElementById('sSlow');
const sSlowScale = document.getElementById('sSlowScale');
const vSlow = document.getElementById('vSlow');
const vSlowScale = document.getElementById('vSlowScale');
// 大蛇加粗：满额时半径 ×N（默认 2.00 = 直径 +100%）
const sGirth = document.getElementById('sGirth');
const vGirth = document.getElementById('vGirth');
const sFreeze = document.getElementById('sFreeze');
const vFreeze = document.getElementById('vFreeze');
const sAiLevel = document.getElementById('sAiLevel');
const vAiLevel = document.getElementById('vAiLevel');
const sAiMistake = document.getElementById('sAiMistake');
const vAiMistake = document.getElementById('vAiMistake');
// 压迫模式总开关：0 = 完全退回旧版 AI 手感（方便 A/B 对照）
const sAiPressure = document.getElementById('sAiPressure');
const vAiPressure = document.getElementById('vAiPressure');
// NPC 蛇头造型总开关（关掉 = 所有 AI 回原版头）
const chkHeadStyle = document.getElementById('chkHeadStyle');
const elAiReadout = document.getElementById('aiReadout');
const elSpeedReadout = document.getElementById('speedReadout');
// 镜像框内的距离→速度反馈：大字倍率 + 进度条（属于镜像框这一项内部）
const elCamSpeedVal = document.getElementById('camSpeedVal');
const elCamSpeedFill = document.getElementById('camSpeedFill');
const selRoundMode = document.getElementById('selRoundMode');
const elRoundReadout = document.getElementById('roundReadout');
// 右上道具状态（两个 chip + 剩余时间 + 进度条）
const elBuffs = document.getElementById('buffs');
const elBuffBoost = document.getElementById('buffBoost');
const elBuffMagnet = document.getElementById('buffMagnet');
const elBuffBoostTime = document.getElementById('buffBoostTime');
const elBuffBoostBar = document.getElementById('buffBoostBar');
const elBuffMagnetTime = document.getElementById('buffMagnetTime');
const elBuffMagnetBar = document.getElementById('buffMagnetBar');
const elPoseState = document.getElementById('poseState');
const elPoseReadout = document.getElementById('poseReadout');
const elLogEnabled = document.getElementById('logEnabled');
const elLogCount = document.getElementById('logCount');
const elLogExport = document.getElementById('logExport');
const elLogExportCsv = document.getElementById('logExportCsv');
const elLogClear = document.getElementById('logClear');
const elHandBtns = Array.from(document.querySelectorAll('[data-hand]'));

// ---------------- 全局状态 ----------------
// 上次选的比赛模式（默认仍是 2 分钟限时）；必须在 Game 构造前恢复，
// 这样初始 roundLeft / HUD 倒计时口径才一致。
const savedRoundMode = safeStorage.getItem('poseSnakeRoundMode');
if (savedRoundMode === 'endless' || savedRoundMode === 'timed') {
  CONFIG.round.mode = savedRoundMode;
}
const fx = new FX();
const game = new Game(fx, TUNING);
const bg = new Background();
// 结算舞台：时间到之后接管整块画布，把 8 条蛇按最终长度竖着比高
const resultStage = new ResultStage();
// 生长定格后才淡入标题与完整成绩牌，避免演出一开始就被文字盖住
resultStage.onSettled = () => {
  elResultOverlay.classList.remove('stage-growing');
  // 演出结束才允许进下一局：这段时间「再来一局」一直是禁用态，
  // 否则玩家一点就把正在长的蛇打断，看起来像卡住
  setNextRoundEnabled(true);
};
bg.buildPattern();
const tracker = new PoseTracker(CONFIG);
const poseLog = new PoseLog(CONFIG);

// 相机（世界坐标中的视口中心）
// 双人分屏时每半屏一台，cams[0] 跟玩家 1、cams[1] 跟玩家 2；
// 变量 cam 仍指向 cams[0]，旧代码与调试入口不用改。
const cams = [{ x: game.camTarget.x, y: game.camTarget.y }];
const cam = cams[0];

// 当前真人玩家数（1 / 2）。改它必须走 setPlayerCount()，
// 因为要同时重建蛇群、相机、模型 numPoses 和整块界面带布局。
let playerCount = 1;

let poseReady = false;
let camReady = false;
let paused = false;
let started = false;
// 结算页只弹一次；重开时复位
let resultShown = false;
let resultAt = 0;            // 结算页出现的时刻：给「举手重开」做防抖冷却
// 举手「已确认」的上一帧状态，每位真人一份，用来取上升沿
const prevRaise = [false, false];
let lastCallShown = false;   // 最后 10 秒提示，每局只弹一次
let lastTime = performance.now();
let timeAcc = 0;
let hintCooldown = 0;
let signalOverride = null;
// 摄像头就绪的时刻：用于"识别不到人也强制开局"的兜底计时
let readyAt = 0;
// 当前控制方式：'keyboard' | 'pose'，决定常驻按钮的文案与行为
let controlMode = 'keyboard';

const KEY_DIR = { ArrowRight: 0, ArrowDown: Math.PI / 2, ArrowLeft: Math.PI, ArrowUp: -Math.PI / 2 };
// 双人分屏时玩家 2 用 WASD（左手区，和玩家 1 的方向键不打架）
const KEY_DIR2 = { d: 0, s: Math.PI / 2, a: Math.PI, w: -Math.PI / 2 };
// 每位玩家一份键盘兜底状态：{ angle, at }
const keyState = [{ angle: null, at: 0 }, { angle: null, at: 0 }];
let keyAngle = null;
let keyAt = 0;

// 最近一帧"生效的"控制信号（可能是体感、键盘兜底或调试注入）
// 开局时用它决定蛇的初始朝向，避免用错来源
let lastSignal = tracker.signal;
// 每位真人各一份（双人分屏开局时两条蛇各自朝自己的手臂方向）
let lastSignals = [tracker.signal];

// ---------------- 画布尺寸 ----------------
let viewW = 0;
let viewH = 0;
let dpr = 1;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  // 画布尺寸取「战场带」实际盒子：局内是 #uiBar 下方的区域；
  // 结算时 #arena 会临时铺满全屏，比高舞台因此仍是全屏演出。
  // 不用 window.innerHeight，否则界面带会被画布盖住，分区就失去意义。
  const box = elArena.getBoundingClientRect();
  viewW = Math.max(1, Math.round(box.width));
  viewH = Math.max(1, Math.round(box.height));
  canvas.width = Math.floor(viewW * dpr);
  canvas.height = Math.floor(viewH * dpr);
  canvas.style.width = viewW + 'px';
  canvas.style.height = viewH + 'px';

  // 镜像框骨架层跟着 #cam 的实际尺寸走（16:9），不写死 240px
  const camBox = elCamWrap.getBoundingClientRect();
  const camW = Math.max(1, Math.round(camBox.width));
  const camH = Math.max(1, Math.round(camBox.height));
  camCanvas.width = Math.round(camW * dpr);
  camCanvas.height = Math.round(camH * dpr);
  camCanvas.style.width = camW + 'px';
  camCanvas.style.height = camH + 'px';

  // 镜像框 2（双人分屏）：尺寸完全由 CSS 决定，这里只同步像素缓冲，
  // 否则骨架会被横向拉扁（CSS 100% 与位图宽高比不一致）
  if (elSkel2 && elSkel2.parentElement) {
    const b2 = elSkel2.parentElement.getBoundingClientRect();
    elSkel2.width = Math.max(1, Math.round(b2.width * dpr));
    elSkel2.height = Math.max(1, Math.round(b2.height * dpr));
  }
}
window.addEventListener('resize', resize);
// 手机横竖屏切换：iOS Safari 在 orientationchange 瞬间可能还没算好新视口，
// 立刻量会拿到旧尺寸（画布停在半屏、HUD 错位）。补两次量：下一帧 + 260ms 后。
// 这两次都只重排尺寸，不碰游戏状态，重复调用是安全的。
window.addEventListener('orientationchange', () => {
  requestAnimationFrame(resize);
  setTimeout(resize, 260);
});
// 地址栏收起 / 展开只改 visualViewport，不触发 window.resize（安卓 Chrome 常见）
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
resize();

// ---------------- 手感调节滑块 ----------------
// 从 localStorage 恢复上次的调参
(function restoreTuning() {
  // 注意：safeStorage.getItem 在没有值时返回 null，而 Number(null) === 0。
  // 直接用它判断会把"没存过"误当成"存了 0"，导致参数默认值被静默改写。
  const rawT = safeStorage.getItem('poseSnakeTurn');
  const rawS = safeStorage.getItem('poseSnakeSlow');
  const rawK = safeStorage.getItem('poseSnakeSlowScale');
  const rawC = safeStorage.getItem('poseSnakeCenter');
  const rawCX = safeStorage.getItem('poseSnakeCenterX');
  const rawGirth = safeStorage.getItem('poseSnakeGirth');
  const rawF = safeStorage.getItem('poseSnakeFreeze');
  const rawL = safeStorage.getItem('poseSnakeAiLevel');
  const rawM = safeStorage.getItem('poseSnakeAiMistake');
  const rawP = safeStorage.getItem('poseSnakeAiPressure');
  const rawHead = safeStorage.getItem('poseSnakeHeadStyle');
  const rawSMin = safeStorage.getItem('poseSnakeSpeedMin');
  const rawSMax = safeStorage.getItem('poseSnakeSpeedMax');
  const rawSNear = safeStorage.getItem('poseSnakeSpeedNear');
  const rawSFar = safeStorage.getItem('poseSnakeSpeedFar');
  const rawSSmooth = safeStorage.getItem('poseSnakeSpeedSmooth');

  // 圆心刻度与距离→速度参数都直接写回 CONFIG.pose（PoseTracker 每帧读的就是它），
  // 不另建副本，避免出现第二个"真相源"再次导致参数失效
  if (rawC !== null) {
    const c = Number(rawC);
    if (Number.isFinite(c)) tracker.setCenterT(c);
  }
  // 圆心横向手动微调（叠加在自动居中之上）；0 表示完全交给自动
  if (rawCX !== null) {
    const v = Number(rawCX);
    const CX = CONFIG.pose.centerX;
    if (Number.isFinite(v)) CONFIG.pose.centerX.manual = clamp(v, CX.manualMin, CX.manualMax);
  }
  // 大蛇加粗的满额倍率
  if (rawGirth !== null) {
    const g = Number(rawGirth);
    const G = CONFIG.snake.girth;
    if (Number.isFinite(g)) TUNING.girthMax = clamp(g, G.min, G.max);
  }
  // NPC 蛇头造型开关（'0' = 关）。造型分配到 snakes 上是在每局 reset 时做的，
  // 这里只恢复开关本身；页面加载后第一局 reset 会按它决定分不分配。
  if (rawHead !== null) {
    TUNING.headStyleOn = rawHead !== '0';
    // game 在模块顶部已创建（它的构造函数跑过一局 reset），
    // 所以恢复成「关」时要立刻重洗一次，否则第一局仍带着造型。
    // 这里 game 一定存在；用可选调用只是防御模块顺序被改。
    game?.assignHeadStyles();
  }
  // far 先于 near 恢复：setSpeedParam 会保证 far - near >= 0.1，
  // 顺序反了会让先写 near 时的边界按旧 far 计算，把合法值误夹掉。
  for (const [key, raw] of [
    ['min', rawSMin], ['max', rawSMax], ['far', rawSFar],
    ['near', rawSNear], ['smooth', rawSSmooth]
  ]) {
    if (raw === null) continue;
    const v = Number(raw);
    if (Number.isFinite(v)) tracker.setSpeedParam(key, v);
  }
  if (rawT !== null) {
    const t = Number(rawT);
    if (Number.isFinite(t)) TUNING.turnRate = clamp(t, CONFIG.turn.rateMin, CONFIG.turn.rateMax);
  }
  if (rawS !== null) {
    const s = Number(rawS);
    if (Number.isFinite(s)) TUNING.slowStrength = clamp(s, CONFIG.slowdown.strengthMin, CONFIG.slowdown.strengthMax);
  }
  if (rawK !== null) {
    const k = Number(rawK);
    if (Number.isFinite(k)) TUNING.slowScale = clamp(k, CONFIG.slowdown.scaleMin, CONFIG.slowdown.scaleMax);
  }
  if (rawF !== null) {
    const f = Number(rawF);
    if (Number.isFinite(f)) TUNING.respawnFreeze = clamp(f, CONFIG.player.respawnFreezeMin, CONFIG.player.respawnFreezeMax);
  }
  const A = CONFIG.ai.difficulty;
  if (rawL !== null) {
    const l = Number(rawL);
    if (Number.isFinite(l)) TUNING.aiLevel = clamp(l, A.levelMin, A.levelMax);
  }
  if (rawM !== null) {
    const m = Number(rawM);
    if (Number.isFinite(m)) TUNING.aiMistake = clamp(m, A.mistakeMin, A.mistakeMax);
  }
  const AP = CONFIG.ai.pressure;
  if (rawP !== null) {
    const p = Number(rawP);
    if (Number.isFinite(p)) TUNING.aiPressure = clamp(p, AP.min, AP.max);
  }
})();

/** 把圆心刻度翻译成部位名，读数里比纯数字直观 */
function centerLabel(t) {
  if (!Number.isFinite(t)) return '-';
  if (t <= 0.08) return '脖子';
  if (t < 0.45) return '胸口';
  if (t < 0.62) return '躯干正中(旧版)';
  if (t < 0.85) return '上腹';
  return '腰';
}

/** 难度系数翻译成人话档位，读数比纯数字直观 */
function aiLabel(level) {
  if (level >= 0.98) return '原版满强度';
  if (level >= 0.80) return '精明';
  if (level >= 0.60) return '较强';
  if (level >= 0.35) return '普通';
  if (level >= 0.15) return '悠闲';
  return '菜鸟';
}

/** 实时读数：把难度派生出的「反应间隔」和失误期望间隔直接显示出来 */
function syncAiReadout() {
  const A = CONFIG.ai.difficulty;
  const level = TUNING.aiLevel;
  const reaction = (A.reactionMaxSec * (1 - level)).toFixed(2);
  const rate = A.lapsePerSec * TUNING.aiMistake;
  const gap = rate > 0 ? (1 / rate).toFixed(1) + 's/次' : '关闭';
  // 压迫强度与 Brain / Game 共用同一个计算函数，读数不会和实际生效值脱节
  const pr = computeAiPressure(TUNING);
  const press = pr > 0 ? ` · 压迫 ${Math.round(pr * 100)}% · 夺冠需吞并` : ' · 旧版手感';
  elAiReadout.textContent =
    `${aiLabel(level)} ${Math.round(level * 100)}% · 反应 ${reaction}s · 失误 ${gap}${press}`;
}

/**
 * 圆心横向读数
 * ------------------------------------------------------------
 * 自动居中一直在学习（右手左右伸展极限的中点），所以这里的数字会随实际操作
 * 慢慢变化；滑块只表示"手动微调"，两者相加才是真正作用在圆心上的偏移。
 */
function syncCenterXReadout() {
  const manual = Number(CONFIG.pose.centerX.manual) || 0;
  const auto = tracker.centerShiftN || 0;
  const pct = (v) => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';
  if (Math.abs(manual) < 1e-4) {
    vCenterX.textContent = Math.abs(auto) < 0.005 ? '自动' : `自动${pct(auto)}`;
  } else {
    vCenterX.textContent = pct(auto + manual);
  }
}

function syncTuningUI() {
  // 滑块范围以 config 为唯一真相源，避免 HTML 里的硬编码和逻辑配置脱节
  sCenter.min = String(CONFIG.pose.centerTMin);
  sCenter.max = String(CONFIG.pose.centerTMax);
  sCenter.value = String(tracker.centerT);
  vCenter.textContent = tracker.centerT.toFixed(2);
  // 圆心横向：滑块只表示手动微调，读数里同时给出自动居中值（见 syncCenterXReadout）
  const CX = CONFIG.pose.centerX;
  sCenterX.min = String(CX.manualMin);
  sCenterX.max = String(CX.manualMax);
  sCenterX.value = String(CX.manual || 0);
  syncCenterXReadout();
  sTurn.min = String(CONFIG.turn.rateMin);
  sTurn.max = String(CONFIG.turn.rateMax);
  // 距离→速度：五个滑块的范围同样以 config 为唯一真相源
  const SP = CONFIG.pose.speed;
  sSpeedMin.min = String(SP.minLimit);
  sSpeedMin.max = String(SP.minCeil);
  sSpeedMax.min = String(SP.maxFloor);
  sSpeedMax.max = String(SP.maxLimit);
  sSpeedNear.min = String(SP.nearMin);
  sSpeedNear.max = String(SP.nearMax);
  sSpeedFar.min = String(SP.farMin);
  sSpeedFar.max = String(SP.farMax);
  sSpeedSmooth.min = '0';
  sSpeedSmooth.max = String(SP.smoothMax);
  sSlow.min = String(CONFIG.slowdown.strengthMin);
  sSlow.max = String(CONFIG.slowdown.strengthMax);
  sSlowScale.min = String(CONFIG.slowdown.scaleMin);
  sSlowScale.max = String(CONFIG.slowdown.scaleMax);
  // 大蛇加粗：滑块直接就是"满额半径倍率"（1.00 = 不加粗，2.00 = 直径 +100%）
  sGirth.min = String(CONFIG.snake.girth.min);
  sGirth.max = String(CONFIG.snake.girth.max);
  sFreeze.min = String(CONFIG.player.respawnFreezeMin);
  sFreeze.max = String(CONFIG.player.respawnFreezeMax);
  sAiLevel.min = String(CONFIG.ai.difficulty.levelMin);
  sAiLevel.max = String(CONFIG.ai.difficulty.levelMax);
  sAiMistake.min = String(CONFIG.ai.difficulty.mistakeMin);
  sAiMistake.max = String(CONFIG.ai.difficulty.mistakeMax);
  sAiPressure.min = String(CONFIG.ai.pressure.min);
  sAiPressure.max = String(CONFIG.ai.pressure.max);

  sTurn.value = String(TUNING.turnRate);
  sSpeedMin.value = String(SP.min);
  sSpeedMax.value = String(SP.max);
  sSpeedNear.value = String(SP.near);
  sSpeedFar.value = String(SP.far);
  sSpeedSmooth.value = String(SP.smooth);
  sSlow.value = String(TUNING.slowStrength);
  sSlowScale.value = String(TUNING.slowScale);
  sGirth.value = String(TUNING.girthMax);
  sFreeze.value = String(TUNING.respawnFreeze);
  sAiLevel.value = String(TUNING.aiLevel);
  sAiMistake.value = String(TUNING.aiMistake);
  sAiPressure.value = String(TUNING.aiPressure);
  if (chkHeadStyle) chkHeadStyle.checked = !!TUNING.headStyleOn;
  vTurn.textContent = TUNING.turnRate.toFixed(1);
  vSpeedMin.textContent = SP.min.toFixed(2) + '×';
  vSpeedMax.textContent = SP.max.toFixed(2) + '×';
  vSpeedNear.textContent = SP.near.toFixed(2);
  vSpeedFar.textContent = SP.far.toFixed(2);
  vSpeedSmooth.textContent = SP.smooth.toFixed(2) + 's';
  vSlow.textContent = Math.round(TUNING.slowStrength * 100) + '%';
  vSlowScale.textContent = Math.round(TUNING.slowScale) + ' 节';
  vGirth.textContent = girthLabel(TUNING.girthMax);
  vFreeze.textContent = TUNING.respawnFreeze.toFixed(2) + 's';
  vAiLevel.textContent = Math.round(TUNING.aiLevel * 100) + '%';
  vAiMistake.textContent = Math.round(TUNING.aiMistake * 100) + '%';
  vAiPressure.textContent = Math.round(TUNING.aiPressure * 100) + '%';
  syncAiReadout();
}
syncTuningUI();

// ---------------- 识别诊断面板 ----------------
// 控制手与日志开关从 localStorage 恢复；日志默认开启，开局即录
(function restoreDiagPrefs() {
  const h = safeStorage.getItem('poseSnakeHand');
  if (h === 'auto' || h === 'right' || h === 'left') tracker.setHand(h);
  const l = safeStorage.getItem('poseSnakeLog');
  // 注意 getItem 没值时返回 null，不能拿 Number(null)=0 当"用户关了"
  if (l !== null) poseLog.setEnabled(l !== '0');
})();

function syncHandUI() {
  for (const b of elHandBtns) b.classList.toggle('on', b.dataset.hand === CONFIG.pose.hand);
}
syncHandUI();
elLogEnabled.checked = poseLog.enabled;

for (const b of elHandBtns) {
  b.addEventListener('click', () => {
    tracker.setHand(b.dataset.hand);
    safeStorage.setItem('poseSnakeHand', b.dataset.hand);
    syncHandUI();
    setHint('控制手：' + (b.dataset.hand === 'left' ? '左手' : b.dataset.hand === 'right' ? '右手' : '自动（画面右侧）'));
  });
}

elLogEnabled.addEventListener('change', () => {
  poseLog.setEnabled(elLogEnabled.checked);
  safeStorage.setItem('poseSnakeLog', elLogEnabled.checked ? '1' : '0');
  setHint(elLogEnabled.checked ? '体感日志：录制中' : '体感日志：已暂停');
});

/** 导出日志并给出可见反馈 */
function exportLog(fmt) {
  const r = poseLog.download(fmt);
  setHint(`已导出 ${r.name}（${r.records} 条）`);
}
elLogExport.addEventListener('click', () => exportLog('json'));
elLogExportCsv.addEventListener('click', () => exportLog('csv'));
elLogClear.addEventListener('click', () => {
  poseLog.clear();
  setHint('体感日志已清空');
});

// 实时读数每 250ms 刷一次，避免每帧改 DOM
// 识别率用最近 120 帧的滑动窗口：全程累计会把启动阶段没人的那几秒一直算进去，
// 玩到后面也显示很低，反而看不出当下的识别状况
let diagUiAt = 0;
const seenWindow = [];
const fv = (x) => Number.isFinite(x) ? x.toFixed(2) : '-';

function updateDiagUI(now, signal) {
  if (now - diagUiAt < 250) return;
  diagUiAt = now;
  syncQuickPlayBtn();               // 常驻按钮状态统一在这里兜底刷新
  const d = signal.debug || {};
  let sum = 0;
  for (const x of seenWindow) sum += x;
  const pct = seenWindow.length ? Math.round(sum / seenWindow.length * 100) : 0;
  elPoseState.textContent = !poseReady ? '未启动'
    : signal.seen ? '识别中'
      : signal.hold ? '信号弱·保持' : '未识别到人';
  elPoseState.className = 'pose-state ' + (!poseReady ? '' : signal.seen ? 'ok' : signal.hold ? 'warn' : 'bad');
  // 悬停可看当前用的是本地模型包还是在线 CDN，不额外占面板高度
  elPoseState.title = '姿态模型：' + tracker.assetSource;
  elLogCount.textContent = poseLog.count + ' 条';
  // 自动居中值随时在学，跟着诊断刷新一起更新（250ms 一次，足够跟手）
  syncCenterXReadout();

  if (!poseReady) {
    // 键盘模式下没有体感输入，日志里只会是空信号，别让玩家误读成"识别率 0% 出故障了"
    elPoseReadout.textContent =
      '当前是键盘模式 / 摄像头未启动\n体感日志只在摄像头模式下有有效数据';
    return;
  }
  if (!signal.seen) {
    const why = d.reason ? `（${d.reason}）` : '';
    elPoseReadout.textContent =
      `识别率 ${pct}% · 未识别到人${why} · 控制手 ${d.hand || '-'}\n` +
      `蛇保持旧方向：${signal.hold ? '是' : '否'} · 日志 ${poseLog.count} 条`;
    return;
  }
  const v = d.vis || [];
  elPoseReadout.textContent =
    `识别率 ${pct}% · ${d.hand} · 目标 ${d.angleDeg ?? '-'}° · 距离 ${d.distN ?? '-'} · 速度 ${d.speedScale ?? '-'}× · 圆心 ${d.centerT ?? '-'} ${centerLabel(d.centerT)}\n` +
    `死区 ${d.deadzonePass ? '通过' : '未过'} · 肩 ${fv(v[0])}/${fv(v[1])} 髋 ${fv(v[2])}/${fv(v[3])} 腕 ${fv(v[5])} · ${d.useHips ? '全身模式' : '上半身降级'} · 日志 ${poseLog.count} 条`;
}

/**
 * 大蛇加粗读数：倍率 → 人话（+100% 表示直径翻倍）
 * @param {number} mul 满额时的半径倍率（1.00 ~ 2.00）
 */
function girthLabel(mul) {
  const pct = Math.round((mul - 1) * 100);
  return pct <= 0 ? '不加粗' : `+${pct}%`;
}

sCenter.addEventListener('input', () => {
  // 拖动立刻生效：PoseTracker 每帧都从 CONFIG.pose 读 centerT，无需重启摄像头
  const t = tracker.setCenterT(Number(sCenter.value));
  vCenter.textContent = t.toFixed(2);
  safeStorage.setItem('poseSnakeCenter', String(t));
  setHint(`圆心刻度 ${t.toFixed(2)}（${centerLabel(t)}）· 0 脖子 / 1 腰`);
});
// 圆心横向：滑块是"手动微调"，叠加在自动居中（左右伸展极限的中点）之上。
// 0 = 完全交给自动，往右挪让右侧更快达到满速，往左挪则反之。
sCenterX.addEventListener('input', () => {
  const CX = CONFIG.pose.centerX;
  CX.manual = clamp(Number(sCenterX.value), CX.manualMin, CX.manualMax);
  syncCenterXReadout();
  safeStorage.setItem('poseSnakeCenterX', String(CX.manual));
  setHint(Math.abs(CX.manual) < 1e-4
    ? '圆心回到自动居中：按右手左右伸展极限的中点计算'
    : `圆心横向手动微调 ${(CX.manual * 100).toFixed(0)}%（叠加在自动值上）`);
});
sGirth.addEventListener('input', () => {
  const G = CONFIG.snake.girth;
  TUNING.girthMax = clamp(Number(sGirth.value), G.min, G.max);
  vGirth.textContent = girthLabel(TUNING.girthMax);
  safeStorage.setItem('poseSnakeGirth', String(TUNING.girthMax));
  setHint(TUNING.girthMax <= 1.001
    ? '大蛇加粗已关闭：所有蛇都是同样的粗细'
    : `大蛇满 ${G.atSegments} 节时加粗 ${girthLabel(TUNING.girthMax)}（头与身体同步，判定同步）`);
});
/**
 * NPC 蛇头造型总开关
 * 切换后立刻重洗当前这一局的分配（不用重开），关掉时全部回到原版蛇头。
 * 玩家蛇头不受影响。
 */
if (chkHeadStyle) {
  chkHeadStyle.addEventListener('change', () => {
    TUNING.headStyleOn = chkHeadStyle.checked;
    safeStorage.setItem('poseSnakeHeadStyle', TUNING.headStyleOn ? '1' : '0');
    game.assignHeadStyles();
    setHint(TUNING.headStyleOn
      ? 'NPC 蛇头造型已开启：7 只 AI 各一张脸，一局之内不重复'
      : 'NPC 蛇头造型已关闭：所有 AI 回到原版蛇头');
  });
}
sTurn.addEventListener('input', () => {
  TUNING.turnRate = Number(sTurn.value);
  vTurn.textContent = TUNING.turnRate.toFixed(1);
  safeStorage.setItem('poseSnakeTurn', String(TUNING.turnRate));
});
/**
 * 绑定「距离→速度」滑块。
 * 参数写进 CONFIG.pose.speed（PoseTracker 每帧读的单一真相源），
 * setSpeedParam 会夹取范围并把当前平滑状态一起夹进新区间，
 * 所以真机上拖滑块调参时速度是平滑过渡，不会突然跳一下。
 */
function bindSpeedSlider(key, slider, label, storeKey, fmt) {
  slider.addEventListener('input', () => {
    const v = tracker.setSpeedParam(key, Number(slider.value));
    slider.value = String(v);      // 被夹取后回写，滑块与真相源保持一致
    label.textContent = fmt(v);
    safeStorage.setItem(storeKey, String(v));
  });
}
bindSpeedSlider('min', sSpeedMin, vSpeedMin, 'poseSnakeSpeedMin', (v) => v.toFixed(2) + '×');
bindSpeedSlider('max', sSpeedMax, vSpeedMax, 'poseSnakeSpeedMax', (v) => v.toFixed(2) + '×');
bindSpeedSlider('near', sSpeedNear, vSpeedNear, 'poseSnakeSpeedNear', (v) => v.toFixed(2));
bindSpeedSlider('far', sSpeedFar, vSpeedFar, 'poseSnakeSpeedFar', (v) => v.toFixed(2));
bindSpeedSlider('smooth', sSpeedSmooth, vSpeedSmooth, 'poseSnakeSpeedSmooth', (v) => v.toFixed(2) + 's');
sSlow.addEventListener('input', () => {
  TUNING.slowStrength = Number(sSlow.value);
  vSlow.textContent = Math.round(TUNING.slowStrength * 100) + '%';
  safeStorage.setItem('poseSnakeSlow', String(TUNING.slowStrength));
});
sSlowScale.addEventListener('input', () => {
  TUNING.slowScale = Number(sSlowScale.value);
  vSlowScale.textContent = Math.round(TUNING.slowScale) + ' 节';
  safeStorage.setItem('poseSnakeSlowScale', String(TUNING.slowScale));
});
sFreeze.addEventListener('input', () => {
  TUNING.respawnFreeze = clamp(
    Number(sFreeze.value),
    CONFIG.player.respawnFreezeMin,
    CONFIG.player.respawnFreezeMax
  );
  vFreeze.textContent = TUNING.respawnFreeze.toFixed(2) + 's';
  safeStorage.setItem('poseSnakeFreeze', String(TUNING.respawnFreeze));
  // 拖滑块时对"当前这一次"也立即生效：拖到 0 就立刻起步，
  // 调大则延长待命，不用等下次死亡才看到效果。
  if (game.player.alive && game.player.isFrozen()) {
    game.player.freezeUntil = performance.now() + TUNING.respawnFreeze * 1000;
  }
  setHint(TUNING.respawnFreeze === 0
    ? '复活静止保护已关闭：复活后立刻运动'
    : `复活静止保护 ${TUNING.respawnFreeze.toFixed(2)}s · 原地无敌待命，先给方向再起步`);
});

// AI 难度 / 失误频率：Brain 每帧从 game.tuning 读值，拖动后下一帧就生效，
// 不需要重开游戏，也不会打断正在进行的这一局。
sAiLevel.addEventListener('input', () => {
  const A = CONFIG.ai.difficulty;
  TUNING.aiLevel = clamp(Number(sAiLevel.value), A.levelMin, A.levelMax);
  vAiLevel.textContent = Math.round(TUNING.aiLevel * 100) + '%';
  syncAiReadout();
  safeStorage.setItem('poseSnakeAiLevel', String(TUNING.aiLevel));
  setHint(TUNING.aiLevel >= 0.98
    ? 'AI 难度拉满：满强度 + 最强压迫，夺冠必须吞并几条蛇'
    : `AI 难度 ${Math.round(TUNING.aiLevel * 100)}%（${aiLabel(TUNING.aiLevel)}）· 转向 / 反应 / 视野 / 进攻同步变化`);
});
sAiMistake.addEventListener('input', () => {
  const A = CONFIG.ai.difficulty;
  TUNING.aiMistake = clamp(Number(sAiMistake.value), A.mistakeMin, A.mistakeMax);
  vAiMistake.textContent = Math.round(TUNING.aiMistake * 100) + '%';
  syncAiReadout();
  safeStorage.setItem('poseSnakeAiMistake', String(TUNING.aiMistake));
  setHint(TUNING.aiMistake === 0
    ? 'AI 失误已关闭：对手不会再随机走神'
    : `AI 失误频率 ${Math.round(TUNING.aiMistake * 100)}% · 走神时头顶会冒黄色问号`);
});
// 压迫强度：Brain 与 Game 都通过 computeAiPressure(tuning) 每帧/每次进食读取，
// 拖动后下一帧就生效，无需重开；拉到 0 可完整退回旧版 AI 做 A/B 对照。
sAiPressure.addEventListener('input', () => {
  const P = CONFIG.ai.pressure;
  TUNING.aiPressure = clamp(Number(sAiPressure.value), P.min, P.max);
  vAiPressure.textContent = Math.round(TUNING.aiPressure * 100) + '%';
  syncAiReadout();
  safeStorage.setItem('poseSnakeAiPressure', String(TUNING.aiPressure));
  setHint(TUNING.aiPressure === 0
    ? 'AI 压迫已关闭：回到旧版手感（AI 频繁自撞，光吃豆也可能夺冠）'
    : `AI 压迫 ${Math.round(TUNING.aiPressure * 100)}% · 围猎 / 拦截 / 领跑压制同步生效`);
});

// ---------------- 设置 / 调试面板：默认收起成 OPTIONS 胶囊 ----------------
// 主机式 UE：屏幕上不常驻一整块调试控件，玩家按 O 或点胶囊才展开。
// 展开状态写入本地存储，下次进来沿用；首次 / 清缓存后一律是收起。
const elTuningHead = document.getElementById('tuningHead');

function setTuningOpen(open, remember = true) {
  const expanded = !!open;
  elTuning.classList.toggle('collapsed', !expanded);
  // 分区界面：展开设置＝打开局内信息层（数据、榜、道具、按键提示一起淡入），
  // 收起＝战场恢复「只有 3 项」的纯净状态。
  document.body.classList.toggle('pause-open', expanded);
  elTuningToggle.textContent = expanded ? '收起' : '展开';
  elTuningToggle.setAttribute('aria-label', expanded ? '收起设置' : '展开设置');
  elTuningHead.setAttribute('aria-expanded', String(expanded));
  if (remember) safeStorage.setItem('poseSnakeTuningOpen', expanded ? '1' : '0');
  return expanded;
}

// 初始化：默认收起；只有用户主动展开过才记住展开状态
setTuningOpen(safeStorage.getItem('poseSnakeTuningOpen') === '1', false);

elTuningToggle.addEventListener('click', (e) => {
  e.stopPropagation();          // 别让标题条的 click 再切换一次
  setTuningOpen(elTuning.classList.contains('collapsed'));
});
elTuningHead.addEventListener('click', () => {
  setTuningOpen(elTuning.classList.contains('collapsed'));
});
// 标题条可聚焦（role=button），键盘 Enter / 空格也能展开；
// 阻止冒泡，免得空格被全局监听当成「立即开局」。
elTuningHead.addEventListener('keydown', (e) => {
  if (e.code !== 'Enter' && e.code !== 'Space') return;
  e.preventDefault();
  e.stopPropagation();
  setTuningOpen(elTuning.classList.contains('collapsed'));
});
// 分区界面里局内没有常驻设置胶囊，镜像框是唯一可点热区：
// 点自己的画面＝展开信息层，电视遥控器则映射到 O 键，两者等价。
elCamWrap.addEventListener('click', () => {
  setTuningOpen(elTuning.classList.contains('collapsed'));
});
// 双人分屏：点右侧镜像框同样是展开 / 收起信息层
if (elCam2) {
  elCam2.addEventListener('click', () => {
    setTuningOpen(elTuning.classList.contains('collapsed'));
  });
}

// ---------------- UI 辅助 ----------------
const uiCache = {
  score: -1, length: -1, best: -1, kills: -1, speed: -1,
  timeLeft: '', rank: -1, rank2: -1, bestLength: -1
};

// ---------------- 局内态统一同步 ----------------
// 历史上有多条开局旁路（startGame / enterKeyboardMode 直接 game.start() / 一键开玩），
// 只在 startGame 里加 class 会漏。这里由每帧的 updateHUD 统一判定：
// playing / ready = 局内，finished = 退出局内，任何入口都不会漏掉浮层收起。
let inRoundCached = false;
function syncInRound() {
  const want = !!started && (game.state === 'playing' || game.state === 'ready');
  if (want === inRoundCached && document.body.classList.contains('in-round') === want) return;
  inRoundCached = want;
  document.body.classList.toggle('in-round', want);
}

// ---------------- 界面动态效果 ----------------
// 只在「状态变化那一帧」改 DOM，不每帧刷样式，也不消耗 Math.random()
// （保住 20 种子自撞率统计的可复现性）。
const uiFxCache = {
  rank: -1, kills: -1, deaths: -1, boost: 0, magnet: 0,
  camState: '', lastCall: false,
  // 距离→速度反馈的写 DOM 去重缓存：数值没变就不碰样式
  speedTxt: '', speedPct: -1, energyStep: -1
};

/** 重新触发一次同名 CSS 动画：先移除 → 强制重排 → 再加回 */
function flashClass(el, cls, ms) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  const key = `_fx_${cls}`;
  clearTimeout(el[key]);
  el[key] = setTimeout(() => el.classList.remove(cls), ms);
}

/** 局内动态：最后 10 秒 / 名次升降 / 道具 / 击杀 / 体感识别状态 */
function updateUiFx() {
  // 1) 最后 10 秒：界面带能量线与倒计时一起切警示态
  const last = CONFIG.round.mode === 'timed' && game.state === 'playing' &&
    game.roundLeft <= CONFIG.round.lastCallSec;
  if (last !== uiFxCache.lastCall) {
    uiFxCache.lastCall = last;
    document.body.classList.toggle('ui-lastcall', last);
  }

  // 2) 名次变化：上升绿色闪光 + 上箭头；下降橙色 + 下箭头
  const rank = game.playerRank;
  if (rank !== uiFxCache.rank) {
    const prev = uiFxCache.rank;
    uiFxCache.rank = rank;
    if (prev > 0 && game.state === 'playing') {
      const up = rank < prev;
      elRankArrow.textContent = up ? '▲' : '▼';
      flashClass(elRankBlock, up ? 'rank-up' : 'rank-down', 680);
    }
  }

  // 3) 刚拾到道具：能量带换色闪一下，不新增第 4 项常驻信息
  const p = game.player;
  const b = p.alive ? p.buffLeft('boost') : 0;
  const m = p.alive ? p.buffLeft('magnet') : 0;
  if (b > uiFxCache.boost + 0.5 || m > uiFxCache.magnet + 0.5) {
    flashClass(document.body, 'ui-boost', 900);
  }
  uiFxCache.boost = b;
  uiFxCache.magnet = m;

  // 4) 吞并 / 被吃：界面带轻震一次
  if (game.kills !== uiFxCache.kills || game.deaths !== uiFxCache.deaths) {
    const notFirst = uiFxCache.kills >= 0 && uiFxCache.deaths >= 0;
    uiFxCache.kills = game.kills;
    uiFxCache.deaths = game.deaths;
    if (notFirst) flashClass(document.body, 'ui-shake', 420);
  }

  // 5) 镜像框：识别到手 → 绿色锁定边框；识别丢失 → 暗框；键盘模式 → 常态
  const seen = !!(lastSignal && lastSignal.seen && poseReady);
  const camState = seen ? 'locked' : (poseReady ? 'lost' : '');
  if (camState !== uiFxCache.camState) {
    uiFxCache.camState = camState;
    elCamWrap.classList.toggle('locked', camState === 'locked');
    elCamWrap.classList.toggle('lost', camState === 'lost');
  }

  // 6) 距离→速度：镜像框内大字倍率 + 进度条，界面带能量扫光随倍率变速。
  //    反馈全部落在已有的三项里（镜像框 / 装饰层），不新增第 4 项常驻信息，
  //    也不改战场画布。只在数值真的变了才写 DOM，不每帧刷样式。
  const SP = CONFIG.pose.speed;
  const lo = Math.min(SP.min, SP.max);
  const hi = Math.max(SP.min, SP.max);
  // poseSpeed 是玩家蛇真正生效的倍率（AI 恒为 1）；死亡时回到中性的 1
  const ps = game.player.alive ? game.player.poseSpeed : 1;
  const ratio = clamp((ps - lo) / Math.max(0.05, hi - lo), 0, 1);
  const speedTxt = ps.toFixed(2) + '×';
  if (speedTxt !== uiFxCache.speedTxt) {
    uiFxCache.speedTxt = speedTxt;
    elCamSpeedVal.textContent = speedTxt;
  }
  const speedPct = Math.round(ratio * 100);
  if (speedPct !== uiFxCache.speedPct) {
    uiFxCache.speedPct = speedPct;
    elCamSpeedFill.style.width = speedPct + '%';
    // 快慢档以 1.00×（当前速度 = 1）为中性基准：上限拉到 1.80× 后，
    // 若仍按 [min,max] 的 1/3 分档，中性的 1.00× 会被误标成慢速档。
    // 进度条仍按 [min,max] 归一化，样式与画面效果一字未改。
    const above = Math.max(0.05, hi - 1);
    const below = Math.max(0.05, 1 - lo);
    elCamWrap.classList.toggle('speed-fast', ps >= 1 + 0.35 * above);
    elCamWrap.classList.toggle('speed-slow', ps <= 1 - 0.35 * below);
  }
  // 双人分屏：右半屏镜像框的倍率与快慢档同样处理
  if (game.players.length > 1 && elCam2) {
    const ps2 = game.players[1].alive ? game.players[1].poseSpeed : 1;
    const txt2 = ps2.toFixed(2) + '×';
    if (txt2 !== uiFxCache.speedTxt2) {
      uiFxCache.speedTxt2 = txt2;
      if (elCamSpeedVal2) elCamSpeedVal2.textContent = txt2;
    }
    const pct2 = Math.round(clamp((ps2 - lo) / Math.max(0.05, hi - lo), 0, 1) * 100);
    if (pct2 !== uiFxCache.speedPct2) {
      uiFxCache.speedPct2 = pct2;
      if (elCamSpeedFill2) elCamSpeedFill2.style.width = pct2 + '%';
      const above2 = Math.max(0.05, hi - 1);
      const below2 = Math.max(0.05, 1 - lo);
      elCam2.classList.toggle('speed-fast', ps2 >= 1 + 0.35 * above2);
      elCam2.classList.toggle('speed-slow', ps2 <= 1 - 0.35 * below2);
    }
    // 识别锁定 / 丢失状态也各标各的
    const seen2 = !!(tracker.signals[1] && tracker.signals[1].seen && poseReady);
    const st2 = seen2 ? 'locked' : (poseReady ? 'lost' : '');
    if (st2 !== uiFxCache.camState2) {
      uiFxCache.camState2 = st2;
      elCam2.classList.toggle('locked', st2 === 'locked');
      elCam2.classList.toggle('lost', st2 === 'lost');
    }
  }
  // 扫光周期量化成 10 档（慢 5.0s → 快 1.3s），避免每帧改 CSS 变量
  const energyStep = Math.round(ratio * 10);
  if (energyStep !== uiFxCache.energyStep) {
    uiFxCache.energyStep = energyStep;
    document.documentElement.style.setProperty(
      '--energy-dur', (5.0 - 3.7 * (energyStep / 10)).toFixed(1) + 's');
  }
}

/** 剩余秒数 → m:ss；无尽练习档显示 ∞ */
function formatRoundTime(sec) {
  if (CONFIG.round.mode !== 'timed') return '∞';
  const t = Math.max(0, Math.ceil(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function updateHUD(force = false) {
  syncInRound();
  // 旧的分数 / 最佳节点保留但隐藏：只为兼容旧自动化用例，不参与任何规则
  if (force || uiCache.score !== game.score) {
    uiCache.score = game.score;
    elScore.textContent = String(game.score);
  }
  if (force || uiCache.best !== game.best) {
    uiCache.best = game.best;
    elBest.textContent = String(game.best);
  }

  // ---- 单局主指标：剩余时间 / 名次 / 长度 / 吞并 / 历史最长 ----
  const txtTime = formatRoundTime(game.roundLeft);
  if (force || uiCache.timeLeft !== txtTime) {
    const changed = !force && game.state === 'playing';
    uiCache.timeLeft = txtTime;
    elTimeLeft.textContent = txtTime;
    // 每跳一秒给数字一次短促放大，3 米外也能察觉时间在走
    if (changed) flashClass(elTimeLeft, 'tick', 300);
  }
  // 最后 10 秒：倒计时变色提醒「这时候死掉长度记 0」
  elTimeLeft.classList.toggle('last-call',
    CONFIG.round.mode === 'timed' && game.state === 'playing' &&
    game.roundLeft <= CONFIG.round.lastCallSec);
  const rank = game.playerRank;
  if (force || uiCache.rank !== rank) {
    uiCache.rank = rank;
    elRank.textContent = `${rank} / ${game.snakes.length}`;
  }
  // 双人分屏：右半屏那一位的名次单独刷
  if (game.players.length > 1 && elRank2) {
    const r2 = game.rankOf(game.players[1]);
    if (force || uiCache.rank2 !== r2) {
      uiCache.rank2 = r2;
      elRank2.textContent = `${r2} / ${game.snakes.length}`;
    }
  }
  if (force || uiCache.bestLength !== game.bestLength) {
    uiCache.bestLength = game.bestLength;
    elBestLength.textContent = String(game.bestLength);
  }

  const len = game.player.alive ? game.player.length : 0;
  if (force || uiCache.length !== len) {
    uiCache.length = len;
    elLength.textContent = String(len);
  }
  // 实时速度读数：把「越大越慢」这条曲线直接显示给玩家看
  // 静止保护期显示"待命"而不是速度，免得写着 300 px/s 却一动不动让人以为坏了
  const spd = game.player.alive ? Math.round(game.player.speed) : 0;
  const frozen = game.player.alive && game.player.isFrozen();
  const boosted = game.player.alive && game.player.hasBuff('boost');
  // 暂停层 / 调试面板里的精确读数也带上体感倍率，方便真机标定对照
  const mult = game.player.poseSpeed;
  if (force || uiCache.speed !== spd || uiCache.frozen !== frozen ||
      uiCache.boosted !== boosted || uiCache.mult !== mult) {
    uiCache.speed = spd;
    uiCache.frozen = frozen;
    uiCache.boosted = boosted;
    uiCache.mult = mult;
    const base = CONFIG.snake.baseSpeed * game.player.speedMul;
    const pct = Math.round((spd / base) * 100);
    elSpeedReadout.textContent = frozen
      ? '起步准备 · 静止无敌，先给方向'
      : spd ? `当前 ${len} 节 · ${spd} px/s · 体感 ${mult.toFixed(2)}× · 初始的 ${pct}%${boosted ? ' · 加速中' : ''}` : '等待重生…';
  }
  if (force || uiCache.kills !== game.kills) {
    uiCache.kills = game.kills;
    elKills.textContent = String(game.kills);
  }
  updateBuffHUD();
  updateLeaderboard();
  updateReadyUI();
  updateUiFx();
}

/** 实时榜：前 3 名 + 玩家自己（若不在前 3），口径与结算完全一致 */
function updateLeaderboard() {
  // 结算页出现后收起实时榜（结算页本身有完整 8 名）
  if (game.state === 'finished' || !started) {
    elLeaderboard.classList.add('hidden');
    return;
  }
  elLeaderboard.classList.remove('hidden');
  const rows = game.liveRanking;
  elLbTime.textContent = formatRoundTime(game.roundLeft);
  const show = rows.slice(0, 3);
  const me = rows.find((r) => r.isPlayer);
  if (me && me.rank > 3) show.push(me);
  const html = show.map((r) => {
    const dead = r.length === 0;
    return `<div class="lb-row${r.isPlayer ? ' me' : ''}${dead ? ' dim' : ''}">` +
      `<span class="lb-rank">${r.rank}</span>` +
      `<span class="lb-dot" style="background:${r.color}"></span>` +
      `<span class="lb-name">${r.isPlayer ? '你' : r.name}` +
      `${r.style ? `<span class="lb-style">${r.style}</span>` : ''}</span>` +
      `<span class="lb-len">${dead ? '复活中' : r.length + ' 节'}</span></div>`;
  }).join('');
  if (html !== elLbRows.innerHTML) elLbRows.innerHTML = html;
}

/**
 * 把结算舞台的列几何同步给底部成绩牌（CSS 变量 --result-rows-w）。
 * 画布里 8 条蛇按「首末列心相距 屏宽 × laneSpan、整体居中」等距排开，
 * 所以列心步长是 span/(n-1)；而成绩牌是 n 个等宽格子，格子中心间距是
 * 牌宽/n。要让每个格子中心正好落在一条蛇上，牌宽必须是 span × n/(n-1)
 * （8 条蛇、60% 时即 68.57%）。两边共用一套几何，窗口缩放也不会错位。
 * 只在数值变化时写 DOM，避免每帧触发样式重算。
 */
let lastRowsWidth = '';
function syncResultLaneSpan() {
  const n = resultStage.lanes.length;
  if (n < 2) {
    if (lastRowsWidth !== '100.00') {
      lastRowsWidth = '100.00';
      elResultRows.style.setProperty('--result-rows-w', '100%');
    }
    return;
  }
  const width = ((resultStage.laneSpan * n) / (n - 1) * 100).toFixed(2) + '%';
  if (width === lastRowsWidth) return;
  lastRowsWidth = width;
  elResultRows.style.setProperty('--result-rows-w', width);
}

/**
 * 结算页「下一局」的可用性开关。
 * 生长演出没走完时禁用按钮、改文案，玩家一眼能看出「还要等一下」，
 * 而不是点了没反应以为卡住。演出结束由 resultStage.onSettled 放开。
 * @param {boolean} on 是否允许进入下一局
 */
function setNextRoundEnabled(on) {
  if (!elAgainBtn) return;
  elAgainBtn.disabled = !on;
  elAgainBtn.textContent = on ? '再来一局' : '蛇还在长…';
  const hint = elAgainBtn.parentElement
    ? elAgainBtn.parentElement.querySelector('.hint')
    : null;
  if (hint) hint.style.opacity = on ? '' : '0.28';
}

/**
 * 把摄像头画面里某位玩家的头部裁出来，作为结算页的头像
 * ------------------------------------------------------------
 * 用姿态关键点定位：鼻子 + 双耳取平均当头部中心，肩宽当尺度。
 * 用肩宽而不是固定像素：离镜头远近不同时，裁出来的人脸大小才稳定。
 * 镜头是镜像的，所以画的时候也水平翻转 —— 和玩家在镜像框里看到的自己一致。
 * @param {number} i 玩家下标（0 = 左半屏，1 = 右半屏）
 * @returns {string} dataURL；没识别到人 / 没有画面时返回空串（结算页不显示头像）
 */
function capturePlayerAvatar(i = 0) {
  const sig = tracker.signals[i] || tracker.signals[0];
  const lm = sig && sig.landmarks;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!lm || lm.length < 25 || !vw || !vh) return '';

  const nose = lm[0];
  const lEar = lm[7];
  const rEar = lm[8];
  const lSh = lm[11];
  const rSh = lm[12];
  const okL = lEar && lEar.v > 0.3;
  const okR = rEar && rEar.v > 0.3;
  const cx = (nose.px + (okL ? lEar.px : nose.px) + (okR ? rEar.px : nose.px)) / 3;
  const cy = (nose.py + (okL ? lEar.py : nose.py) + (okR ? rEar.py : nose.py)) / 3;

  const shoulderW = lSh && rSh ? Math.hypot(lSh.px - rSh.px, lSh.py - rSh.py) : 0;
  const half = clamp(shoulderW ? shoulderW * 0.62 : 90, 40, Math.min(vw, vh) * 0.45);

  const C = 192;
  const cv = document.createElement('canvas');
  cv.width = C;
  cv.height = C;
  const g = cv.getContext('2d');
  // 镜像坐标 → 原始帧坐标：x 轴反过来
  const sx = vw - (cx + half);
  const sy = cy - half;
  g.save();
  g.translate(C, 0);
  g.scale(-1, 1);
  try {
    g.drawImage(video, sx, sy, half * 2, half * 2, 0, 0, C, C);
  } catch (e) {
    return '';
  }
  g.restore();
  try {
    return cv.toDataURL('image/jpeg', 0.86);
  } catch (e) {
    return '';
  }
}

/** 时间到：弹出结算页（每局只弹一次） */
function showResult() {
  if (resultShown) return;
  const R = game.roundResult;
  if (!R) return;
  resultShown = true;
  resultAt = performance.now();
  elLeaderboard.classList.add('hidden');

  // 结算演出：8 条蛇横向按名次排开、按最终长度向上生长、镜头随最高者升高。
  // 世界此刻已冻结，画布完全交给舞台；底部成绩牌与蛇的列中心一一对齐。
  // 先切 result-mode 让 #arena 铺满整屏，再重算画布尺寸，最后才 begin()：
  // 否则舞台会按「战场带 880px 高」去算每节像素与镜头抬升，画面被压扁。
  document.body.classList.remove('in-round');
  document.body.classList.remove('pause-open');
  document.body.classList.add('result-mode');
  resize();
  resultStage.begin(game.ranking, viewW, viewH);
  syncResultLaneSpan();   // 成绩牌先按同一跨度收窄，第一帧就不会错位
  elResultOverlay.classList.add('stage-growing');
  setNextRoundEnabled(false);

  const mine = R.players || (R.player ? [R.player] : []);
  if (mine.length > 1) {
    // 双人分屏：标题写两人的名次，谁赢谁输一眼看清
    const parts = mine.map((m) => `${m.name} 第 ${m.rank} 名`);
    const champ = mine.find((m) => m.rank === 1);
    elResultTitle.textContent = champ ? `${parts.join(' · ')} · ${champ.name} 获胜！` : parts.join(' · ');
  } else {
    elResultTitle.textContent = R.won ? '第 1 名 · 本局获胜！' : `第 ${R.playerRank} 名`;
  }

  // 真人玩家的头像：结算瞬间直接从摄像头画面裁一个头部特写。
  // 每人各裁各的（双人模式两个头像不一样），没识别到人就留空不显示。
  const avatars = mine.map((m) => capturePlayerAvatar(m.playerIndex ?? 0));

  // 成绩牌压成两行（名次+名字 / 节数），细节行只在玩家自己那一格保留：
  // 7 条 AI 的风格 / 吞并 / 死亡对玩家没有决策价值，8 格重复 8 遍纯属噪声。
  elResultRows.innerHTML = game.ranking.map((r) => {
    const av = r.isPlayer ? (avatars[r.playerIndex ?? 0] || '') : '';
    return `<div class="result-row${r.isPlayer ? ' me' : ''}${av ? ' has-avatar' : ''}" data-rank="${r.rank}" style="--lane:${r.color}">` +
      `<span class="r-rank">${r.rank}</span>` +
      `<span class="r-name">${r.name}` +
      (av ? `<img class="r-avatar" src="${av}" alt="">` : '') +
      `</span>` +
      // 细节行并入节数这一行，不再单独占第三行：8 格高度完全一致，
      // 底部牌面也不会被玩家那一格拽高。
      `<span class="r-len">${r.length} 节` +
      (r.isPlayer ? `<em class="r-extra">吞 ${r.kills} · 死 ${r.deaths}</em>` : '') +
      `</span></div>`;
  }).join('');
  // 结算顶带只留两个有意义的数字：本局最长 + 历史最佳。
  // 吃食 / 吞并 / 死亡局内 HUD 已经实时显示过，再重复一遍只让顶带变厚。
  // 打破纪录（或持平）时两个数一样，重复写两遍反而啰嗦，只留一个。
  const p = R.player;
  const best = p ? Math.max(game.bestLength, p.peakLength) : 0;
  if (mine.length > 1) {
    // 双人：各自的最长长度并排写，不再比"历史最佳"（那是个人纪录，容易误解）
    elResultStats.textContent = mine.map((m) => `${m.name} 最长 ${m.peakLength} 节`).join(' · ');
  } else {
    elResultStats.textContent = !p
      ? ''
      : best > p.peakLength
        ? `最长 ${p.peakLength} 节 · 历史最佳 ${best} 节`
        : `最长 ${p.peakLength} 节`;
  }
  elResultOverlay.classList.remove('hidden');
  setStatus('本局结束', 'ok');
  setHint('长度赛演出中 · 点「跳过演出」可直接看结果 · 空格 / 举手 / 再来一局都能重开');
}

/** 收起结算页与演出舞台（重开 / 换模式时调用） */
function hideResult() {
  resultShown = false;
  resultStage.end();
  document.body.classList.remove('result-mode');
  // 从全屏结算切回「界面带 + 战场带」，画布像素尺寸必须同步重算
  resize();
  elResultOverlay.classList.remove('stage-growing');
  elResultOverlay.classList.add('hidden');
}

/** 再来一局：沿用当前控制方式，不回启动面板，体感日志按局重新分段 */
function restartRound() {
  hideResult();
  lastCallShown = false;
  startGame();
  // 按局重新分段，事后分析体感输入时能直接按局切开
  poseLog.start();
}

/**
 * 举手准备进度：镜像框底部一条进度条
 * ------------------------------------------------------------
 * 只在「摄像头已就绪 + 还没开局」这段时间显示。
 * 双人模式两个镜像框各有一条，谁举满了谁的变金色；
 * 只有两个人都是金色，游戏才会开始（判定在 loop 里）。
 */
const readyCache = { on: null, w: ['', ''], done: [null, null] };
function updateReadyUI() {
  const on = poseReady && started && game.state === 'ready';
  if (readyCache.on !== on) {
    readyCache.on = on;
    document.body.classList.toggle('ready-phase', on);
  }
  if (!on) return;

  const hold = Math.max(0.2, CONFIG.pose.raiseHoldSec);
  const boxes = [elCamWrap, elCam2];
  const layers = [elReady1, elReady2];
  for (let i = 0; i < game.players.length && i < 2; i++) {
    const layer = layers[i];
    if (!layer) continue;
    const t = clamp(tracker.raiseTimerOf(i) / hold, 0, 1);
    const w = (t * 100).toFixed(0) + '%';
    if (readyCache.w[i] !== w) {
      readyCache.w[i] = w;
      const bar = layer.querySelector('b');
      if (bar) bar.style.width = w;
    }
    const done = t >= 1;
    if (readyCache.done[i] !== done) {
      readyCache.done[i] = done;
      if (boxes[i]) boxes[i].classList.toggle('ready-done', done);
    }
  }
}

/** 右上道具条：显示两类增益的剩余时间与进度（没有增益就整块隐藏） */const buffCache = { boost: '', magnet: '' };
function updateBuffHUD() {
  const P = CONFIG.powerups;
  const p = game.player;
  const b = p.alive ? p.buffLeft('boost') : 0;
  const m = p.alive ? p.buffLeft('magnet') : 0;

  elBuffs.classList.toggle('hidden', b <= 0 && m <= 0);
  elBuffBoost.classList.toggle('hidden', b <= 0);
  elBuffMagnet.classList.toggle('hidden', m <= 0);

  if (b > 0) {
    const txt = b.toFixed(1) + 's';
    if (buffCache.boost !== txt) { elBuffBoostTime.textContent = txt; buffCache.boost = txt; }
    elBuffBoostBar.style.width = Math.min(100, b / P.boost.durationSec * 100).toFixed(1) + '%';
  } else buffCache.boost = '';

  if (m > 0) {
    const txt = m.toFixed(1) + 's';
    if (buffCache.magnet !== txt) { elBuffMagnetTime.textContent = txt; buffCache.magnet = txt; }
    elBuffMagnetBar.style.width = Math.min(100, m / P.magnet.durationSec * 100).toFixed(1) + '%';
  } else buffCache.magnet = '';

  // 分区界面：局内不常驻道具 chip，剩余时长写进暂停层的数据条
  const parts = [];
  if (b > 0) parts.push(`加速 ${b.toFixed(1)}s`);
  if (m > 0) parts.push(`磁铁 ${m.toFixed(1)}s`);
  const buffTxt = parts.length ? `道具 · ${parts.join(' / ')}` : '道具 · 无';
  if (elPauseBuff.textContent !== buffTxt) elPauseBuff.textContent = buffTxt;
}

function setStatus(text, kind) {
  elStatus.textContent = text;
  elStatusDot.className = 'dot ' + (kind || '');
}

function showOverlay(title, desc, btnText) {
  elPanelTitle.textContent = title;
  elPanelDesc.textContent = desc;
  elStartBtn.textContent = btnText;
  elOverlay.classList.remove('hidden');
}

/**
 * 还原标题画面：文案、人数按钮、分屏布局全部回到初始状态。
 * 诊断 / 摄像头失败会把面板改成报错信息，回到标题时靠它复位，
 * 否则玩家会看到「摄像头没准备好」当标题挂着。
 * @param {number} [count] 指定人数；不传则沿用当前人数
 */
function resetTitleScreen(count) {
  elPanelTitle.textContent = TITLE_TEXT.title;
  elPanelDesc.textContent = TITLE_TEXT.desc;
  elStartBtn.textContent = TITLE_TEXT.btn;
  setPlayerCount(count || playerCount, { silent: true });
}

function hideOverlay() {
  elOverlay.classList.add('hidden');
}

function setHint(text) {
  if (elHint.textContent !== text) elHint.textContent = text;
  if (elPanelHint && elPanelHint.textContent !== text) elPanelHint.textContent = text;
}

/** 把体检结果渲染成清单 */
function renderDiag(rows) {
  elDiag.textContent = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'diag-row ' + (r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'warn');

    const ico = document.createElement('span');
    ico.className = 'diag-ico';
    const label = document.createElement('span');
    label.className = 'diag-label';
    label.textContent = r.label;
    const detail = document.createElement('span');
    detail.className = 'diag-detail';
    detail.textContent = r.detail;

    row.append(ico, label, detail);
    elDiag.appendChild(row);
  }
  elDiag.classList.remove('hidden');
}

/** 渲染"失败原因 + 修复建议" */
function renderErrorBlocks(info) {
  for (const el of elDiag.parentElement.querySelectorAll('.diag-block,.diag-title,#useLocalBtn')) el.remove();

  const frag = document.createDocumentFragment();

  if (info.reasons.length) {
    const h = document.createElement('p');
    h.className = 'diag-title';
    h.textContent = '可能的原因';
    const ul = document.createElement('ul');
    ul.className = 'diag-block';
    for (const t of info.reasons) {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    }
    frag.append(h, ul);
  }

  const h2 = document.createElement('p');
  h2.className = 'diag-title fixes';
  h2.textContent = '怎么修';
  const ul2 = document.createElement('ul');
  ul2.className = 'diag-block fixes';
  for (const t of info.fixes) {
    const li = document.createElement('li');
    li.textContent = t;
    ul2.appendChild(li);
  }
  frag.append(h2, ul2);

  elDiag.parentElement.insertBefore(frag, elDiag.nextSibling);
}

// ---------------- 启动流程 ----------------
// 启动代号：每次开始 / 取消都递增，用来丢弃过期的异步结果
let bootSeq = 0;
let booting = false;
let bootStageLabel = '请求摄像头权限';
/** 上一次「点开始 → 可玩」的耗时与分阶段明细，玩家反馈慢时直接看这条 */
let lastBoot = null;
// 当前这一轮启动的看门狗。取消时必须一并停掉，否则它的定时器
// 会在十几秒后才 abort()，把用户紧接着发起的新启动也一起打断
let activeWatchdog = null;

/**
 * 可续期看门狗
 * ------------------------------------------------------------
 * getUserMedia / CDN 请求有可能永远不 resolve 也不 reject（权限弹窗被
 * 嵌入式预览窗口吞掉时最常见），页面就会永久停在「正在启动」。
 * 这里按阶段设时限：权限阶段短（15s），模型下载阶段长（35s）。
 * 不能"每条进度都续期"——init 一开头就会发一条进度，那样会把权限
 * 阶段的 15 秒直接续成 35 秒，真正卡住时玩家要多等二十几秒。
 */
function createBootWatchdog(firstMs, onTimeout) {
  let timer = null;
  let settled = false;
  let resolveFn = null;
  let rejectFn = null;

  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  /** 设置/重设当前阶段允许的最长等待时间 */
  const arm = (ms) => {
    if (settled) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const e = new Error('启动超时（卡在：' + bootStageLabel + '）');
      e.name = 'StartTimeoutError';
      onTimeout();          // 先中止底层 init，释放摄像头
      rejectFn(e);
    }, ms);
  };
  arm(firstMs);

  return {
    promise,
    arm,
    // 用户主动取消：直接收场，不弹诊断面板
    cancel(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onTimeout();
      rejectFn(err);
    },
    // 启动已经出结果，看门狗正常结束，别留下悬挂的 Promise
    finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveFn();
    }
  };
}

// ---------------- 启动计时器 ----------------
// 手机上模型要下 7.5MB + 编译 9MB wasm，几十秒很正常。
// 界面必须每秒钟动一下，否则玩家无法区分「在慢慢加载」和「已经卡死」。
let bootTick = null;
let bootHintRaw = '';
let bootT0 = 0;

function stopBootTicker() {
  if (bootTick) { clearInterval(bootTick); bootTick = null; }
}

function startBootTicker() {
  stopBootTicker();
  bootT0 = performance.now();
  bootTick = setInterval(() => {
    const s = Math.round((performance.now() - bootT0) / 1000);
    if (bootHintRaw) setHint(`${bootHintRaw} · 已等待 ${s} 秒`);
  }, 1000);
}

/** 更新启动提示文案（同时给计时器用，避免它把秒数刷回去） */
function bootHint(text) {
  bootHintRaw = text;
  const s = bootT0 ? Math.round((performance.now() - bootT0) / 1000) : 0;
  setHint(s >= 2 ? `${text} · 已等待 ${s} 秒` : text);
}

/** 把启动进度翻译成玩家看得懂的分步提示，并按阶段调整看门狗时限 */
function showBootStep(msg, watchdog) {
  if (msg.includes('请求摄像头')) {
    bootStageLabel = '请求摄像头权限';
    watchdog.arm(CONFIG.boot.cameraTimeoutMs);
    bootHint('① 正在请求摄像头权限… 浏览器若弹出提示，请点「允许」');
  } else if (msg.includes('摄像头就绪') || msg.includes('模型包')) {
    bootStageLabel = '准备姿态模型';
    watchdog.arm(CONFIG.boot.modelTimeoutMs);
    bootHint('② 摄像头已连上，正在准备姿态模型（本地包优先，无需外网）…');
  } else if (msg.includes('①')) {
    bootStageLabel = '加载识别库';
    watchdog.arm(CONFIG.boot.modelTimeoutMs);
    bootHint('③ ' + msg.replace(/^①\s*/, ''));
  } else if (msg.includes('②')) {
    bootStageLabel = '编译 WASM 运行时';
    watchdog.arm(CONFIG.boot.modelTimeoutMs);
    bootHint('④ ' + msg.replace(/^②\s*/, ''));
  } else if (msg.includes('③')) {
    bootStageLabel = '创建姿态模型';
    watchdog.arm(CONFIG.boot.modelTimeoutMs);
    bootHint('⑤ ' + msg.replace(/^③\s*/, ''));
  } else {
    bootStageLabel = '初始化姿态识别';
    watchdog.arm(CONFIG.boot.modelTimeoutMs);
    bootHint('⑥ ' + msg);
  }
}

async function bootCamera() {
  // 从「按下按钮」开始计时：玩家感知的等待就是这么长。
  // 别放在下面 watchdog 之后 —— 中间的 DOM 操作（清诊断块、切按钮态）
  // 在慢设备上要几百毫秒，少算这一段会让日志和真实体感对不上。
  const bootT0 = performance.now();
  const mySeq = ++bootSeq;
  booting = true;
  // 启动中按钮保持可点，文案变成「取消启动」，玩家随时能脱身
  elStartBtn.disabled = false;
  elStartBtn.textContent = '取消启动';
  elStartBtn.classList.add('loading');
  // 键盘模式从一开始就可见：摄像头卡住也不至于完全玩不了
  elKbBtn.classList.remove('hidden');

  for (const el of elDiag.parentElement.querySelectorAll('.diag-block,.diag-title')) el.remove();
  elDiag.classList.add('hidden');
  if (tracker.stream) tracker.release();

  // 点击后立刻给可见反馈（状态栏 + 面板提示），避免"点了没反应"的错觉
  bootStageLabel = '请求摄像头权限';
  setStatus('正在启动', 'warn');
  startBootTicker();                    // 之后每秒刷新一次「已等待 N 秒」
  bootHint('① 正在请求摄像头权限… 浏览器若弹出提示，请点「允许」');

  const watchdog = createBootWatchdog(CONFIG.boot.cameraTimeoutMs, () => tracker.abort());
  activeWatchdog = watchdog;

  try {
    await Promise.race([
      tracker.init(
        video,
        (msg) => showBootStep(msg, watchdog),
        () => {
          camReady = true;
          elCamWrap.classList.add('live');
          setStatus('摄像头已连上', 'ok');
        }
      ),
      watchdog.promise
    ]);
    watchdog.finish();
    if (mySeq !== bootSeq) return;      // 已被取消，不要偷偷进游戏
    poseReady = true;
    booting = false;

    fx.sfx.ensure();
    enterReady();

    // 启动耗时落一份账：玩家反馈"太慢"时，这一段能直接看出卡在哪。
    // 记在 enterReady 之后 —— 首次创建音频上下文也可能要几百毫秒，
    // 只统计到「模型就绪」会少算这一段，与玩家实际等待对不上。
    lastBoot = {
      ms: Math.round(performance.now() - bootT0),
      stages: (tracker.stageLog || []).slice(),
      at: new Date().toLocaleString('zh-CN')
    };
    console.info(`[启动] 点开始 → 可玩 ${lastBoot.ms}ms · ${lastBoot.stages.join(' → ')}`);
  } catch (err) {
    watchdog.finish();
    if (mySeq !== bootSeq) return;      // 主动取消：静默收场
    booting = false;
    console.error('[摄像头启动失败]', err);
    // 把本次实际用过的模型来源带给诊断页，失败时能说清是本地包没找到还是 CDN 不通
    if (err instanceof Error && !err.assetSource) err.assetSource = tracker.assetSource;
    const info = classifyCameraError(err);

    if (info.code !== 'model') {
      tracker.release();
      elCamWrap.classList.remove('live');
      camReady = false;
    }
    await showCameraFailure(err, info);
  } finally {
    stopBootTicker();
    if (mySeq === bootSeq) {
      if (activeWatchdog === watchdog) activeWatchdog = null;
      booting = false;
      elStartBtn.classList.remove('loading');
      elStartBtn.disabled = false;
      // 修复：以前成功后按钮文案会永久停留在「正在启动…」
      elStartBtn.textContent = poseReady ? '已就绪' : '重新尝试';
      elKbBtn.classList.remove('hidden');
    }
  }
}

/** 用户点「取消启动」或「先用方向键玩」时调用：立刻终止挂起的启动 */
function cancelBoot() {
  bootSeq++;                            // 让正在跑的 init 结果全部作废
  booting = false;
  // 先把看门狗停掉，避免它稍后误伤"取消后立刻重试"的那一轮启动
  if (activeWatchdog) {
    const wd = activeWatchdog;
    activeWatchdog = null;
    wd.cancel(new Error('用户取消启动'));
  }
  tracker.abort();
  elCamWrap.classList.remove('live');
  camReady = false;
  elStartBtn.classList.remove('loading');
  elStartBtn.disabled = false;
  elStartBtn.textContent = '重新尝试';
  setStatus('已取消', 'warn');
  setHint('已取消摄像头启动，可以直接用方向键玩');
  elKbBtn.classList.remove('hidden');
}

// ---------------- 全局异常兜底 ----------------
// 任何没被接住的错误都在面板上留一句话，杜绝"点了没反应又查不到原因"
window.addEventListener('error', (e) => {
  const msg = e?.message || e?.target?.src || '脚本 / 资源加载出错';
  console.error('[未捕获错误]', e?.error || msg);
  reportBootProblem('脚本错误：' + msg);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e?.reason?.message || String(e?.reason || '未知异步错误');
  console.error('[未处理的 Promise 拒绝]', e?.reason);
  reportBootProblem('异步错误：' + msg);
});

/** 只在还没进游戏时提示，避免游戏过程中的偶发异常打断画面 */
function reportBootProblem(text) {
  if (poseReady || started) return;
  setHint(text);
  elKbBtn.classList.remove('hidden');
}

async function showCameraFailure(err, info) {
  // 游戏已经在跑（例如玩家一键开玩后又重连体感失败）：
  // 绝不弹全屏遮罩打断，只更新状态栏并切回键盘，游戏进度原样保留。
  if (started) {
    poseReady = false;
    controlMode = 'keyboard';
    readyAt = 0;
    tracker.signal.seen = false;
    tracker.signal.hold = false;
    setStatus(info.code === 'model' ? '体感不可用' : '摄像头不可用', 'bad');
    setHint('体感没连上，已切到键盘：方向键可玩 · 右上角可重连体感');
    hintCooldown = 4;
    window.__poseSnake.lastCameraError = {
      name: err?.name || 'Error',
      message: err?.message || '',
      info
    };
    syncQuickPlayBtn();
    return;
  }

  showOverlay(info.title, '先定位原因，再决定怎么玩', '重新尝试');
  elRules.classList.add('hidden');
  elFineprint.classList.add('hidden');

  elDiag.classList.remove('hidden');
  elDiag.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'diag-row warn';
  loading.textContent = '正在检查运行环境…';
  elDiag.appendChild(loading);

  const rows = await collectEnv();
  rows.unshift({
    label: '浏览器错误',
    ok: false,
    detail: `${err?.name || 'Error'}: ${err?.message || '（无描述）'}`
  });
  // 模型类失败单独列一行来源：能一眼看出是本地包没找到，还是 CDN 被拦
  rows.splice(1, 0, {
    label: '模型资源',
    ok: err?.assetSource === '全部来源不可用' ? false : null,
    detail: err?.assetSource || tracker.assetSource || '未检测'
  });
  // 每个加载阶段的耗时：一眼看出是「下不动」还是「编译/初始化挂住」
  const stages = err?.stageLog || tracker.stageLog;
  if (Array.isArray(stages) && stages.length) {
    rows.splice(2, 0, { label: '加载阶段', ok: null, detail: stages.join(' → ') });
  }
  renderDiag(rows);
  renderErrorBlocks(info);

  // 模型失败且当前不是项目自带服务器时，给一个能直接点的跳板，不用手敲地址
  if (info.code === 'model' && location.host !== '127.0.0.1:8123') {
    const fixes = elDiag.parentElement.querySelector('.diag-block.fixes');
    if (fixes) {
      const jump = document.createElement('button');
      jump.id = 'useLocalBtn';
      jump.className = 'diag-jump';
      jump.textContent = '打开本地服务器 127.0.0.1:8123（推荐 · 模型免外网）';
      jump.addEventListener('click', () => { window.location.href = 'http://127.0.0.1:8123/'; });
      fixes.insertAdjacentElement('afterend', jump);
    }
  }

  elKbBtn.classList.remove('hidden');
  setHint('');
  setStatus(info.code === 'model' ? '模型加载失败' : '摄像头不可用', 'bad');

  window.__poseSnake.lastCameraError = {
    name: err?.name || 'Error',
    message: err?.message || '',
    info
  };
}

function enterReady() {
  hideOverlay();
  hideResult();
  // 重连摄像头时游戏可能已经在跑，别把玩家的分数和进度重置掉
  if (!(started && game.state === 'playing')) game.reset();
  started = true;
  controlMode = 'pose';
  readyAt = performance.now();      // 强制开局的计时起点
  snapCamera();
  updateHUD(true);
  elTuning.classList.remove('hidden');
  // 开新一段日志：从摄像头就绪这一刻开始录，玩完直接导出即可
  poseLog.start();
  setStatus('识别中', 'ok');
  setHint('站进画面 1 秒自动开始 · 举手可立即开始 · 按空格立即开局');
  syncQuickPlayBtn();
}

/** 一键切到键盘模式：不管摄像头处于什么状态，都能立刻进游戏 */
function enterKeyboardMode() {
  if (booting) cancelBoot();
  // 必须彻底关掉体感，否则一旦识别到人就会把方向从键盘手里抢走
  poseReady = false;
  readyAt = 0;
  controlMode = 'keyboard';
  for (const s of tracker.signals) {
    s.seen = false;
    s.hold = false;
  }
  tracker.release();                // 释放摄像头，避免占用导致重连报 NotReadableError
  elCamWrap.classList.remove('live');
  camReady = false;

  const alreadyPlaying = started && game.state === 'playing';
  hideOverlay();
  if (!alreadyPlaying) {
    hideResult();           // 从结算页「直接开玩」时也要收起结算面板
    game.start();
    snapCamera();
    // 新开一局才重开日志；游戏中切换控制方式时保留已有记录
    poseLog.start();
  }
  started = true;
  updateHUD(true);
  elTuning.classList.remove('hidden');
  setStatus('键盘模式', 'warn');
  setHint('方向键控制方向 · 2 分钟自动结算 · 结算后按空格再来一局 · P 暂停 · 右上角可重连体感');
  fx.sfx.ensure();
  // 首次创建音频上下文要几十毫秒，把静止期重新锚定到这里，
  // 保证玩家真正看到画面后仍有完整的 0.3 秒待命时间。
  if (!alreadyPlaying) for (const p of game.players) game.applySpawnFreeze(p);
  syncQuickPlayBtn();
}

/**
 * 切换真人玩家数（1 / 2）
 * ------------------------------------------------------------
 * 一处调用同步四件事，缺一件就会出现"半屏布局单机数据"的错位：
 *   1) Game：重建蛇群（1 人 = 1+7 AI，2 人 = 2+6 AI，总数恒 8）
 *   2) PoseTracker：numPoses 改成 2（要重建模型，异步进行，失败退回单人识别）
 *   3) 相机：多一台，各跟各的
 *   4) 界面带：data-split 驱动 CSS 换成五栏（两个镜像框 + 中间倒计时）
 * 只允许在标题画面 / 结算页切换：局内换人数等于换一局，会让人莫名其妙掉分。
 * @param {number} n 1 或 2
 * @param {object} opts { silent } silent = 不写 localStorage（初始化时用）
 */
function setPlayerCount(n, opts = {}) {
  const v = n >= 2 ? 2 : 1;
  playerCount = v;
  game.setPlayerCount(v);
  tracker.setMaxPoses(v);

  // 相机数组跟着人数增减，并把镜头立刻对准各自的出生点
  while (cams.length < v) cams.push({ x: game.camTarget.x, y: game.camTarget.y });
  cams.length = v;
  for (let i = 0; i < v; i++) {
    const t = game.camTargets[i] || game.camTarget;
    cams[i].x = t.x;
    cams[i].y = t.y;
  }

  // 布局开关：body / #arena / #uiBar 三处 data-split 必须一致，
  // CSS 与自动化用例都读它判断当前是单屏还是分屏
  document.body.dataset.split = String(v);
  elArena.dataset.split = String(v);
  elUiBar.dataset.split = String(v);

  // 人数按钮选中态
  for (const b of elPsBtns) {
    b.classList.toggle('active', Number(b.dataset.count) === v);
    b.setAttribute('aria-pressed', Number(b.dataset.count) === v ? 'true' : 'false');
  }
  // 名次标题跟着人数走：双人时左右两侧必须对称写 1P / 2P，
  // 否则左边「我的名次」右边「玩家 2 名次」读起来像两套命名
  if (elRankK1) elRankK1.textContent = v > 1 ? '1P 名次' : '我的名次';
  if (elRankK2) elRankK2.textContent = '2P 名次';
  // 底部键位条同理：双人时必须两套键位都写出来，
  // 否则 2P 玩家照着手柄提示按方向键会去抢 1P 的蛇
  if (elPadMove) {
    elPadMove.innerHTML = v > 1
      ? '<i class="keycap">← ↑ ↓ →</i> 1P · <i class="keycap">W A S D</i> 2P'
      : '<i class="keycap">← ↑ ↓ →</i> 移动';
  }

  // 标题画面副标题跟着人数换一句话
  if (elPanelDesc) {
    elPanelDesc.textContent = v > 1
      ? '两人左右分屏 · 各控一条蛇 · 8 条蛇同场'
      : TITLE_TEXT.desc;
  }

  resize();
  snapCamera();
  updateHUD(true);
  if (!opts.silent) safeStorage.setItem('poseSnakePlayers', String(v));
  return v;
}

/** 常驻按钮文案：永远给玩家一条明确的"进游戏 / 换控制方式"路径 */
function syncQuickPlayBtn() {
  if (!elQuickPlayBtn) return;
  // 窄屏启动遮罩显示时收起常驻按钮，避免压住规则文字（面板内已有等价入口）
  // 手机口径就用视野同一套判定：横屏 844×390 的 innerWidth 是 844，
  // 按宽度判会把手机当桌面，常驻按钮就压在战场上了
  const narrow = window.innerWidth <= 720 || isPhoneViewport();
  const overlayShown = !elOverlay.classList.contains('hidden');
  elQuickPlayBtn.classList.toggle('compact-hidden', narrow && overlayShown);
  const reconnect = started && controlMode === 'keyboard' && !booting;
  const text = reconnect ? '重连体感' : '直接开玩';
  if (elQuickPlayBtn.textContent !== text) elQuickPlayBtn.textContent = text;
  elQuickPlayBtn.title = reconnect
    ? '重新连接摄像头，恢复体感控制'
    : '不等摄像头，立刻用方向键开始游戏';
}

elQuickPlayBtn.addEventListener('click', () => {
  if (started && controlMode === 'keyboard' && !booting) {
    bootCamera();                   // 已在键盘模式 → 重连体感
  } else {
    enterKeyboardMode();            // 未进游戏 / 体感就绪 / 启动中 → 一键开玩
  }
});

function startGame() {
  // 修复：以前按空格只把状态改成 playing，启动遮罩却没关，
  // 游戏在遮罩背后跑，看起来就像"进不了游戏"
  hideOverlay();
  // 从结算页重开时一并收起结算面板、复位本局提示标记
  hideResult();
  lastCallShown = false;
  started = true;
  readyAt = 0;
  // 进入局内态：界面带接管，战场带内不再显示任何浮层。
  // 不在这里强制收起暂停层：默认收起已由初始化时的 setTuningOpen(偏好) 保证，
  // 若玩家在发车前主动展开过设置，自动开局时不应把它关掉。
  document.body.classList.add('in-round');
  game.start();
  // 让蛇头直接指向玩家当前手臂方向，避免开局强行甩头
  // 用 lastSignal 而不是 tracker.signal：键盘模式 / 调试注入也要生效
  for (let i = 0; i < game.players.length; i++) {
    const s = lastSignals[i];
    if (s && s.seen) game.players[i].heading = s.angle;
  }
  snapCamera();
  fx.sfx.ensure();
  // 同上：音频/UI 初始化完成后才重新开始计 0.3 秒，别让初始化吃掉待命时间
  for (const p of game.players) game.applySpawnFreeze(p);
  updateHUD(true);
  setStatus('游戏中', 'ok');
  showToast('GO!');
}

function showToast(text) {
  const h = game.player.body[0];
  if (h) fx.floatText(h.x, h.y - 80, text, '#B6FF57', 64);
}

/**
 * 手机口径判定
 * ------------------------------------------------------------
 * 看的是 **window 视口短边**，不是战场带短边：
 * 桌面 16:9 窗口扣掉顶部界面带后，战场带高度只有 598，用它判断会把桌面误判成手机。
 * 竖屏时短边是宽度、横屏时短边是高度 —— 两种方向都命中，旋转后口径不跳变。
 */
function isPhoneViewport() {
  return Math.min(window.innerWidth, window.innerHeight) <= CONFIG.view.phoneBreakCss;
}

/**
 * 一块视口能看到的世界范围
 * ------------------------------------------------------------
 * 核心规则：**短边决定跨度**，长边按画布比例展开。
 *
 * · 桌面（视口短边 > 620 px）：短边装 900 世界单位。
 *   16:9 窗口算出来正好是 1600×900，与改造前逐像素一致，老玩家手感不变。
 * · 手机（视口短边 ≤ 620 px）：以「390 CSS px 短边装 640 世界单位」为基准等比缩放。
 *   竖屏 390×752 → 640×1234（旧版竖屏是 1600×2870），每单位 0.61 CSS px；
 *   横屏 844×314 → 515×1385，每单位仍是 0.61 —— 旋转不会让蛇突然变大变小。
 * · 双人分屏：半屏短边更短，再乘 splitSpanBoost 回到改造前的视野密度。
 *
 * @param {number} pxW 视口宽（设备像素）
 * @param {number} pxH 视口高（设备像素）
 * @param {number} [panes] 分屏块数（1=单人，2=双人），决定是否做半屏补偿
 */
function viewRectFor(pxW, pxH, panes = 1) {
  const d = Math.max(1, dpr);
  const cssW = pxW / d;
  const cssH = pxH / d;
  const ratio = cssW / Math.max(1e-3, cssH);          // 宽 / 高
  const cssShort = Math.min(cssW, cssH);

  // 短边该装多少世界单位
  let span;
  if (isPhoneViewport()) {
    const V = CONFIG.view;
    // 按画布短边（已扣掉界面带）相对基准等比缩放，横屏压扁后自动把镜头推近
    span = V.phoneShortSpan * (cssShort / V.phoneAnchorCss);
    span = clamp(span, V.phoneSpanMin, V.phoneSpanMax);
    // 双人半屏只有半个屏宽，不补偿就贴脸了
    if (panes > 1) span *= V.splitSpanBoost;
  } else {
    span = CONFIG.view.h;
  }

  let w;
  let h;
  if (ratio >= 1) {
    // 横屏：短边是高度
    h = span;
    w = span * ratio;
  } else {
    // 竖屏：短边是宽度
    w = span;
    h = span / ratio;
  }

  // 极端竖长条（手机双人分屏的半屏）会把高度顶到世界之外，等比截一下
  const maxH = CONFIG.view.maxViewH;
  if (h > maxH) {
    const k = maxH / h;
    h = maxH;
    w *= k;
  }
  return { w, h };
}

/** 相机立即对准玩家，用于开局 / 复活，避免长距离滑动 */
function snapCamera() {
  const half = splitHalfSize();
  for (let i = 0; i < game.players.length; i++) {
    const c = cams[i] || cams[0];
    const t = game.camTargets[i] || game.camTarget;
    c.x = clamp(t.x, half.w / 2, WORLD.w - half.w / 2);
    c.y = clamp(t.y, half.h / 2, WORLD.h - half.h / 2);
  }
  // 单人模式两个变量可能是同一个对象，重复写一次无副作用
  cam.x = cams[0].x;
  cam.y = cams[0].y;
}

/** 半屏（单人时是整屏）实际能看到的世界尺寸，按当前画布像素反算 */
function splitHalfSize() {
  const n = Math.max(1, game.players.length);
  const pxW = Math.max(1, canvas.width / n);
  const pxH = Math.max(1, canvas.height);
  const vp = viewRectFor(pxW, pxH, n);
  const scale = Math.min(pxW / vp.w, pxH / vp.h) || 1;
  return { w: pxW / scale, h: pxH / scale };
}

/** 相机跟随：带朝向前瞻 + 平滑（双人分屏各跟各的） */
function updateCamera(dt) {
  const half = splitHalfSize();
  const k = smoothK(CONFIG.camera.follow, dt);

  for (let i = 0; i < game.players.length; i++) {
    const p = game.players[i];
    const c = cams[i] || cams[0];
    const t = game.camTargets[i] || game.camTarget;
    let lx = 0;
    let ly = 0;

    // 沿蛇头朝向前瞻一点，让玩家更早看到前方
    if (p.alive && p.body.length) {
      const la = Math.min(CONFIG.camera.lookaheadMax, p.speed * 0.45);
      lx = Math.cos(p.heading) * la;
      ly = Math.sin(p.heading) * la;
    }

    c.x += (t.x + lx - c.x) * k;
    c.y += (t.y + ly - c.y) * k;

    c.x = clamp(c.x, half.w / 2, WORLD.w - half.w / 2);
    c.y = clamp(c.y, half.h / 2, WORLD.h - half.h / 2);
  }
  cam.x = cams[0].x;
  cam.y = cams[0].y;
}

// ---------------- 输入 ----------------
elStartBtn.addEventListener('click', () => {
  if (booting) { cancelBoot(); return; }   // 启动中点一下 = 取消，不再干等
  if (poseReady) return;
  bootCamera();
});

// 人数选择：点一下立刻切，标题画面里就能看出「1 人 / 2 人」的差别
for (const b of elPsBtns) {
  b.addEventListener('click', (e) => {
    e.preventDefault();
    setPlayerCount(Number(b.dataset.count) || 1);
  });
}

elKbBtn.addEventListener('click', () => enterKeyboardMode());
// 结算页「再来一局」：沿用当前控制方式，不退回启动面板
elAgainBtn.addEventListener('click', () => restartRound());
// 「跳过演出」：不想等 5 秒生长动画时，立刻把蛇长到最终长度并定格
if (elSkipStageBtn) elSkipStageBtn.addEventListener('click', () => resultStage.skip());

/** 单局模式：同步下拉框与说明文字 */
function syncRoundModeUI() {
  selRoundMode.value = CONFIG.round.mode;
  elRoundReadout.textContent = CONFIG.round.mode === 'timed'
    ? `限时 ${formatRoundTime(CONFIG.round.durationSec)} · 时间到按长度排名，第 1 名胜`
    : '无尽练习 · 不计时、不结算，实时榜仍按长度显示';
}
selRoundMode.addEventListener('change', () => {
  CONFIG.round.mode = selRoundMode.value === 'endless' ? 'endless' : 'timed';
  safeStorage.setItem('poseSnakeRoundMode', CONFIG.round.mode);
  // 立刻按新模式重开：已在游戏中就直接发车，还没开局就留在准备画面
  hideResult();
  game.reset();
  if (started) startGame();
  syncRoundModeUI();
  updateHUD(true);
});

window.addEventListener('pointerdown', () => fx.sfx.ensure(), { once: true });

window.addEventListener('keydown', (e) => {
  if (KEY_DIR[e.key] !== undefined) {
    e.preventDefault();
    keyAngle = KEY_DIR[e.key];
    keyAt = performance.now();
    keyState[0].angle = keyAngle;
    keyState[0].at = keyAt;
    // 停在准备画面时按方向键直接开局，不必再猜要按什么
    if (game.state === 'ready') startGame();
    return;
  }
  // 双人分屏：WASD 控右半屏那位（左手区，和方向键不打架）
  const k2 = KEY_DIR2[String(e.key).toLowerCase()];
  if (k2 !== undefined && playerCount > 1) {
    e.preventDefault();
    keyState[1].angle = k2;
    keyState[1].at = performance.now();
    if (game.state === 'ready') startGame();
    return;
  }

  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    if (game.state === 'finished') restartRound();   // 结算页：空格 / 回车再来一局
    else if (game.state === 'ready') startGame();
    else hideOverlay();          // 兜底：空格不该让启动遮罩一直盖着画面
  }
  if (e.code === 'KeyP' || e.code === 'Escape') {
    paused = !paused;
    setStatus(paused ? '已暂停' : '游戏中', paused ? 'warn' : 'ok');
  }
  if (e.code === 'KeyM') {
    fx.sfx.enabled = !fx.sfx.enabled;
    elMuteBtn.classList.toggle('muted', !fx.sfx.enabled);
  }
  // L = 立刻导出体感日志（不用回到面板找按钮）
  if (e.code === 'KeyL') exportLog('json');
  // O = OPTIONS：主机式「设置」快捷键，展开 / 收起调试面板。
  // 焦点在滑块、下拉框里时不抢键，避免拖参数时面板突然收起。
  if (e.code === 'KeyO') {
    const t = e.target;
    const tag = (t && t.tagName) || '';
    if (!/INPUT|SELECT|TEXTAREA/.test(tag) && !(t && t.isContentEditable)) {
      setTuningOpen(elTuning.classList.contains('collapsed'));
    }
  }
});

elMuteBtn.addEventListener('click', () => {
  fx.sfx.enabled = !fx.sfx.enabled;
  elMuteBtn.classList.toggle('muted', !fx.sfx.enabled);
});

// ---------------- 触摸滑动（手机 / 平板） ----------------
// 手机上既没有方向键，摄像头也不一定可用 —— 两条退路都没有就等于进局也不能动。
// 这里做「增量式拖动」：手指按住往哪拖，蛇就往哪转，松手保持最后方向 8 秒。
// 锚点跟着手指走，所以连续画圈也能一直给新方向，手感接近虚拟摇杆。
// 只接管 pointerType === 'touch'：桌面鼠标不抢键盘，原本的操作完全不变。
let touchDrag = null;                        // { id, x, y } 按下时的锚点
const touchState = { angle: null, at: 0 };   // 最近一次有效滑动

function onArenaPointerDown(e) {
  if (e.pointerType !== 'touch') return;
  // 准备阶段：手机举不了手，点一下屏幕直接开局（等同键盘空格）
  if (game.state === 'ready' && !paused) {
    startGame();
    return;
  }
  // 双人分屏不做触摸：一块屏两个人抢手指，反而谁都不好用
  if (game.players.length > 1) return;
  touchDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
}

function onArenaPointerMove(e) {
  if (!touchDrag || e.pointerId !== touchDrag.id) return;
  const dx = e.clientX - touchDrag.x;
  const dy = e.clientY - touchDrag.y;
  // 14px 死区：手指静止时的抖动不该让蛇乱抖
  if (Math.hypot(dx, dy) < 14) return;
  touchState.angle = Math.atan2(dy, dx);   // 与键盘同一套角度约定：0=右，π/2=下
  touchState.at = performance.now();
  touchDrag.x = e.clientX;
  touchDrag.y = e.clientY;
}

function onArenaPointerUp(e) {
  if (!touchDrag || e.pointerId !== touchDrag.id) return;
  touchDrag = null;
  touchState.at = performance.now();       // 松手后再保活 8 秒
}

elArena.addEventListener('pointerdown', onArenaPointerDown, { passive: true });
elArena.addEventListener('pointermove', onArenaPointerMove, { passive: true });
elArena.addEventListener('pointerup', onArenaPointerUp, { passive: true });
elArena.addEventListener('pointercancel', onArenaPointerUp, { passive: true });

window.addEventListener('blur', () => {
  if (game.state === 'playing') {
    paused = true;
    setStatus('已暂停', 'warn');
  }
});

// ---------------- 主循环 ----------------
function loop(now) {
  requestAnimationFrame(loop);

  let realDt = (now - lastTime) / 1000;
  lastTime = now;
  if (!Number.isFinite(realDt) || realDt < 0) realDt = 0;
  realDt = Math.min(realDt, 0.05);

  // ---- 1. 体感信号 ----
  if (poseReady) tracker.update(now);
  // 每位真人一份信号：单人 = 1 份，双人分屏 = 左半屏 / 右半屏各一份
  const sigs = [];
  for (let i = 0; i < playerCount; i++) {
    sigs.push(tracker.signals[i] || tracker.signals[0]);
  }
  // 键盘兜底：只要最近 4 秒按过对应键位，就以键盘为准。
  // 旧版只在 !poseReady 时生效，导致摄像头一连上、识别不到人时键盘也彻底失灵，
  // 玩家卡在准备状态且没有任何可操作入口。现在体感就绪时同样能用键盘脱困。
  for (let i = 0; i < sigs.length; i++) {
    const k = keyState[i] || keyState[0];
    if (k.angle === null || now - k.at >= 4000) continue;
    // 键盘兜底只覆盖「方向」，不再把速度倍率强制打回 1。
    // 旧写法让按过方向键之后的 4 秒里体感距离完全失效，这是真机上
    // "速度差异感受不明显"的头号原因。没开摄像头 / 没识别到人时
    // tracker.signal.speedScale 本来就是 1，键盘模式行为与旧版一致。
    sigs[i] = Object.assign({}, sigs[i], {
      seen: true, hold: false, angle: k.angle, keyboard: true
    });
  }
  // 触摸兜底：手机上滑过之后 8 秒内以滑动方向为准。
  // 放在键盘之后，是因为两者的适用场景互斥（手机没键盘、桌面不用触摸），
  // 谁最近有动作谁生效，不会互相打回。
  if (touchState.angle !== null && now - touchState.at < 8000) {
    for (let i = 0; i < sigs.length; i++) {
      sigs[i] = Object.assign({}, sigs[i], {
        seen: true, hold: false, angle: touchState.angle, touch: true
      });
    }
  }
  // 调试注入优先级最高，放最后覆盖（传数组则逐位注入，传对象只打给玩家 1）
  if (signalOverride) {
    for (let i = 0; i < sigs.length; i++) {
      const ov = Array.isArray(signalOverride)
        ? signalOverride[i]
        : (i === 0 ? signalOverride : null);
      if (ov) sigs[i] = Object.assign({}, sigs[i], ov);
    }
  }
  const signal = sigs[0];
  lastSignal = signal;
  lastSignals = sigs;
  // 举手的「上升沿」：结算页靠它重开，举着不放也只触发一次。
  // 双人模式下任何一位举手都算（谁先举谁开下一局，不用两人同步）。
  let raiseEdge = false;
  for (let i = 0; i < playerCount; i++) {
    const conf = tracker.raiseConfirmedOf(i, CONFIG.pose.raiseHoldSec);
    if (conf && !prevRaise[i]) raiseEdge = true;
    prevRaise[i] = conf;
  }

  // 识别率：最近 120 帧滑动窗口（日志里有全程逐帧统计）
  seenWindow.push(signal.seen ? 1 : 0);
  if (seenWindow.length > 120) seenWindow.shift();

  // ---- 2. 状态机 ----
  if (!paused) {
    // 结算页举手重开：只在「放下 → 举起」那一帧触发，且留出 0.8 秒冷却，
    // 免得玩家看完结算还在举手、页面一闪就被连开好几局。
    // 另外必须等生长演出结束（resultStage.settled）：蛇还在往上长的时候
    // 举手重开会把演出打断，看着像"没演完就跳走了"。
    // 不额外要求 poseReady：重连摄像头的中间态也该能举手重开；
    // 键盘模式下 tracker 不会更新，raiseConfirmed 恒为 false，天然不会误触发。
    if (game.state === 'finished' && resultShown && resultStage.settled &&
        raiseEdge && now - resultAt > 800) {
      restartRound();
    }
    if (poseReady && game.state === 'ready') {
      // ---- 举手准备：每位真人各举一只手满 raiseHoldSec（默认 1 秒）----
      // 双人模式必须两个人都完成，一个人举着不算。
      const need = game.players.length;
      let allRaised = true;
      let allSeen = true;
      for (let i = 0; i < need; i++) {
        if (!tracker.raiseConfirmedOf(i, CONFIG.pose.raiseHoldSec)) allRaised = false;
        if (!tracker.signals[i]?.seen) allSeen = false;
      }
      // 兜底一：摄像头就绪后一个人都没识别到，等 forceStartSec 秒也放行
      const waitedTooLong = readyAt > 0 && now - readyAt > CONFIG.pose.forceStartSec * 1000;
      // 兜底二：人在画面里但一直举不了手（坐姿 / 手臂被挡），等 raiseWaitMaxSec 秒放行，
      // 否则这些玩家会被永久挡在准备画面 —— 这是旧版最招骂的一类"卡住"
      const raisedTooLong = allSeen && readyAt > 0 &&
        now - readyAt > CONFIG.pose.raiseWaitMaxSec * 1000;

      if (allRaised || waitedTooLong || raisedTooLong) {
        if (allRaised) setHint('');
        else if (waitedTooLong && !signal.seen) {
          setHint('没识别到人 → 已自动开局：方向键可直接玩，站进画面后体感会接管');
          hintCooldown = 4;
        } else if (raisedTooLong && !allRaised) {
          setHint('没等到举手 → 已开局：举起单手就能立刻出发');
          hintCooldown = 4;
        }
        startGame();
      }
    }

    // 引导提示
    if (game.state === 'playing' && game.player.alive && hintCooldown <= 0) {
      hintCooldown = 1.4;
      if (timeAcc < 24) {
        // 新体感模型的开局引导：手伸远加速、收回减速。
        // 阈值按当前滑块设定的区间相对判断，用户放宽 / 收窄上下限后提示依然准确。
        const SP = CONFIG.pose.speed;
        const sp = signal.speedScale ?? 1;
        const lo = Math.min(SP.min, SP.max);
        const hi = Math.max(SP.min, SP.max);
        const ratio = (sp - lo) / Math.max(0.05, hi - lo);
        if (ratio > 0.62) setHint('手伸远 → 加速');
        else if (ratio < 0.38) setHint('手收回 → 减速');
        else setHint('');
      } else if (elHint.textContent) {
        setHint('');
      }
    }
    hintCooldown -= realDt;
  }

  // ---- 3. 时间缩放 ----
  const dt = paused ? 0 : realDt * fx.timeScale;
  timeAcc += dt;

  // ---- 4. 更新 ----
  // 复活后相机要直接跳到新位置：每位真人各记一份上一帧的存活状态
  const wasAlive = game.players.map((p) => p.alive);
  if (!paused) {
    game.update(dt, sigs, realDt);
    fx.update(dt, realDt);
    bg.update(realDt);
    updateCamera(realDt);
    // 玩家从死亡恢复 → 相机直接跳到新位置
    for (let i = 0; i < game.players.length; i++) {
      if (!wasAlive[i] && game.players[i].alive) snapCamera();
    }
  }

  // ---- 4.5 单局结束 / 最后 10 秒 ----
  // 时间到时 Game.finishRound() 已冻结世界并生成排名，这里只负责弹一次结算页。
  if (game.state === 'finished' && !resultShown) showResult();
  if (game.state === 'playing' && CONFIG.round.mode === 'timed' &&
      !lastCallShown && game.roundLeft <= CONFIG.round.lastCallSec) {
    lastCallShown = true;
    showToast('最后 10 秒！');
    setHint('最后 10 秒 · 保住蛇！复活途中长度记 0');
    hintCooldown = CONFIG.round.lastCallSec;
  }

  // ---- 5. 渲染 ----
  // 结算演出用真实时间推进：暂停只冻结物理世界，颁奖动画照常播完
  if (resultStage.active) resultStage.update(realDt);
  render(sigs);

  // ---- 6. UI ----
  updateHUD();
  updateCameraPreview(sigs);
  updateStatusText(signal);

  // 体感输入日志：每帧采样，内部按 50ms + 状态跳变去重
  poseLog.sample(now, signal, {
    state: game.state,
    controlUsed: !!(signal.seen || signal.hold),
    headingDeg: game.player.heading * 180 / Math.PI,
    raiseTimer: tracker.raiseTimer,
    score: game.score,
    fps: realDt > 0 ? 1 / realDt : null
  });
  updateDiagUI(now, signal);
}

function updateStatusText(signal) {
  // 结算后状态栏固定写「本局结束」，别被每帧的「游戏中 / 未识别到人」盖掉
  if (game.state === 'finished') {
    setStatus('本局结束', 'ok');
    return;
  }
  // 键盘模式不接管状态栏：否则 0.3 秒待命结束后没人把它改回「键盘模式」。
  // 键盘模式下待命仍有两处可见提示：蛇头上的「待命 x.xs · 给方向」文字环、
  // 以及手感面板里的「起步准备 · 静止无敌，先给方向」。
  if (!poseReady) return;
  if (paused) {
    setStatus('已暂停', 'warn');
    return;
  }
  // 体感模式：静止保护期明确显示倒计时 + 无敌，结束后自动回到「游戏中」
  if (game.player.alive && game.player.isFrozen()) {
    setStatus(`起步准备 ${game.playerFreezeIn.toFixed(1)}s · 静止无敌`, 'ok');
    return;
  }
  if (!game.player.alive) {
    setStatus(`复活中 ${game.playerRespawnIn.toFixed(1)}s`, 'warn');
    return;
  }
  if (signal.seen) {
    setStatus(game.state === 'playing' ? '游戏中' : '识别中', 'ok');
  } else if (signal.hold) {
    setStatus('信号弱', 'warn');
  } else {
    setStatus('未识别到人', 'bad');
  }
}

/**
 * 摄像头预览：视频 + 骨架
 * ------------------------------------------------------------
 * 单人模式只画镜像框 1；双人模式下两个镜像框各画各的人。
 * 镜像框 1 用 <video> 直接显示画面（画布只叠骨架）；
 * 镜像框 2 没有独立视频源，于是把同一帧画进它的画布再叠骨架 ——
 * 两个人本来就在同一台摄像头的画面里，分左右而已。
 * @param {Array} sigs 每位真人的信号
 */
function updateCameraPreview(sigs) {
  if (!camReady) return;
  drawOneCam(camCanvas, camCtx, sigs[0], false);
  if (game.players.length > 1 && elSkel2) {
    const ctx2 = elSkel2.getContext('2d');
    drawOneCam(elSkel2, ctx2, sigs[1], true);
  }
}

/**
 * 画一个镜像框
 * @param {HTMLCanvasElement} cv 目标画布
 * @param {CanvasRenderingContext2D} c 它的 2D 上下文
 * @param {object} signal 这个人的信号
 * @param {boolean} drawVideo 是否把视频帧也画进画布（镜像框 2 需要）
 */
function drawOneCam(cv, c, signal, drawVideo) {
  const w = cv.width;
  const h = cv.height;
  if (!w || !h) return;

  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);

  c.translate(w, 0);
  c.scale(-1, 1);

  if (drawVideo) {
    const vw = video.videoWidth || 4;
    const vh = video.videoHeight || 3;
    const targetRatio = w / h;
    const srcRatio = vw / vh;
    let sw = vw;
    let sh = vh;
    if (srcRatio > targetRatio) sw = vh * targetRatio;
    else sh = vw / targetRatio;
    c.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h);
  }
  c.restore();

  if (!signal) return;

  if (signal.seen) {
    tracker.drawSkeleton(c, w, h, signal);
  } else {
    // 识别不到人时预览窗也要给明确反馈，否则看起来就像"骨架功能没做"
    const why = {
      'no-pose': '未检测到人体',
      'low-shoulder': '肩部不可见',
      'low-arm': '手臂不可见',
      'one-person': '这一侧没人'
    }[signal.debug?.reason] || '未识别到人体';
    c.save();
    c.fillStyle = 'rgba(10,4,20,0.62)';
    c.fillRect(0, h * 0.72, w, h * 0.28);
    c.fillStyle = '#ffb4c8';
    c.font = `700 ${Math.round(h * 0.075)}px "PingFang SC","Microsoft YaHei",sans-serif`;
    c.textAlign = 'center';
    c.fillText(why, w / 2, h * 0.89);
    c.restore();
  }
}

/** 视口裁剪：蛇身很长，用采样点算包围盒 */
function snakeVisible(s, view) {
  const b = s.body;
  if (b.length === 0) return false;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < b.length; i += 4) {
    const p = b[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // 补上尾巴（步长可能跳过最后一节）
  const last = b[b.length - 1];
  minX = Math.min(minX, last.x); maxX = Math.max(maxX, last.x);
  minY = Math.min(minY, last.y); maxY = Math.max(maxY, last.y);

  const m = 80;
  return !(maxX < view.x - m || minX > view.x + view.w + m ||
           maxY < view.y - m || minY > view.y + view.h + m);
}

/**
 * 画一块视口里的世界
 * ------------------------------------------------------------
 * 单人时 px/pxW 就是整块画布；双人分屏时左右各调一次，各用各的相机。
 * 世界坐标下做视口裁剪，屏幕空间叠加交给 drawViewOverlay。
 * @param {number} px 视口左上角（设备像素）
 * @param {number} py
 * @param {number} pxW 视口宽（设备像素）
 * @param {number} pxH
 * @param {number} idx 相机 / 玩家下标
 */
function drawWorldView(px, py, pxW, pxH, idx) {
  const camObj = cams[idx] || cams[0];
  // panes 决定要不要做双人半屏补偿：这里和 splitHalfSize() 必须用同一个口径，
  // 否则相机夹取范围与实际绘制比例对不上，蛇会在屏幕边缘瞬移
  const vp = viewRectFor(pxW, pxH, Math.max(1, game.players.length));
  const scale = Math.min(pxW / vp.w, pxH / vp.h) * fx.zoom;
  const ox = px + pxW / 2 - camObj.x * scale + fx.shakeX * scale;
  const oy = py + pxH / 2 - camObj.y * scale + fx.shakeY * scale;
  ctx.setTransform(scale, 0, 0, scale, ox, oy);

  // 实际可见的世界矩形：按像素反算，和相机夹取口径完全一致
  const view = {
    x: camObj.x - (pxW / scale) / 2,
    y: camObj.y - (pxH / scale) / 2,
    w: pxW / scale,
    h: pxH / scale
  };

  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x, view.y, view.w, view.h);
  ctx.clip();

  // ---- 背景 ----
  bg.draw(ctx, view);

  // ---- 世界边界（用这条视口主人的蛇算危险预警）----
  drawWorldWalls(ctx, view, game.players[idx] || game.player);

  // ---- 食物（视口裁剪）----
  const fm = 70;
  const camD2 = 760 * 760;
  for (let i = 0; i < game.foods.length; i++) {
    const f = game.foods[i];
    if (f.x < view.x - fm || f.x > view.x + view.w + fm) continue;
    if (f.y < view.y - fm || f.y > view.y + view.h + fm) continue;
    const detail = dist2(f.x, f.y, camObj.x, camObj.y) < camD2;
    drawFood(ctx, f, timeAcc, detail);
  }

  // ---- 蛇（视口裁剪；AI 在远处时简化绘制）----
  for (const s of game.snakes) {
    if (!s.alive || s.body.length < 2) continue;
    if (!snakeVisible(s, view)) continue;
    const h = s.body[0];
    const detail = s.isPlayer || dist2(h.x, h.y, camObj.x, camObj.y) < 1000 * 1000;
    drawSnake(ctx, s, timeAcc, detail);
  }

  // ---- 道具（视口裁剪；画在蛇之上，快被拾取时不会被身体挡住）----
  const pm = 90;
  for (let i = 0; i < game.powerups.length; i++) {
    const p = game.powerups[i];
    if (p.x < view.x - pm || p.x > view.x + view.w + pm) continue;
    if (p.y < view.y - pm || p.y > view.y + view.h + pm) continue;
    drawPowerup(ctx, p, timeAcc);
  }

  // ---- 粒子 / 飘字 ----
  // 层次和原来一致：蛇身 → 碎片 / 火花 / 爆炸星 → 飘字。
  // 特效统一盖在蛇头之上，不做「蛇头置顶」补画 —— 头从碎片里穿出来才符合
  // 吃食物爆开的前后关系；连吃时靠 fx.headClarity 收敛玩家进食特效来保持
  // 头部可辨，而不是把蛇头强行提到最上层。
  fx.drawWorld(ctx);

  ctx.restore();
}

/** 一块视口的屏幕空间叠加（边缘暗角 / 准备提示 / 复活倒计时 / 玩家标号） */
function drawViewOverlay(px, py, pxW, pxH, idx) {
  const p = game.players[idx] || game.player;
  const cssW = pxW / dpr;
  const cssH = pxH / dpr;
  // 变换到「这块视口的 CSS 像素」坐标系：本地 0,0 就是视口左上角
  ctx.setTransform(dpr, 0, 0, dpr, px, py);

  // 只画战场带自身的画面边缘反馈（四角取景框 + 暗角）
  const buffed = p && p.alive && (p.hasBuff('boost') || p.hasBuff('magnet')) ? 1 : 0;
  drawArenaOverlay(ctx, cssW, cssH, timeAcc, buffed);

  // 双人分屏的 1P / 2P 标识交给镜像框上的 .cam-tag（DOM 层）：
  // 画在 canvas 左上角会被设置浮动条盖住，实测自动截图里 1P 看不见。

  // 准备提示
  if (game.state === 'ready' && started) {
    if (game.players.length > 1) {
      drawCenterTip(ctx, cssW / 2, cssH / 2,
        '举手准备',
        poseReady ? '举起任意一只手满 1 秒开始 · 两人都举' : '按空格开始 · 1P 方向键 / 2P WASD');
    } else {
      // 以前只写"站进画面 → 自动开始"，识别不到人时玩家不知道还能按键盘，
      // 屏幕上也没有任何按钮，看起来就像卡死。这里明确给出两条入口。
      drawCenterTip(ctx, cssW / 2, cssH / 2,
        '举手 1 秒开始',
        poseReady ? '举起任意一只手 · 也可按空格 / 方向键' : '方向键控制方向 · 右上角可一键开玩');
    }
  }

  // 复活倒计时（每位真人各画各的半屏）
  if (game.state === 'playing' && p && !p.alive) {
    drawRespawn(ctx, p, cssW, cssH);
  }
}

/** 世界渲染：单人一整屏，双人左右分屏 */
function render(sigs) {
  // 结算演出接管整块画布：不画游戏世界、不画小地图、不画暂停遮罩，
  // 避免 8 条比高的蛇被残留的食物 / 粒子 / HUD 干扰。
  if (resultStage.active) {
    resultStage.draw(ctx, viewW, viewH, dpr);
    syncResultLaneSpan();
    return;
  }
  const cw = canvas.width;
  const ch = canvas.height;

  // 全屏底色（letterbox 区域）
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#050c16';
  ctx.fillRect(0, 0, cw, ch);

  const n = Math.max(1, game.players.length);
  const halfW = Math.floor(cw / 2);

  if (n === 1) {
    drawWorldView(0, 0, cw, ch, 0);
  } else {
    drawWorldView(0, 0, halfW, ch, 0);
    drawWorldView(halfW, 0, cw - halfW, ch, 1);
    // 分屏接缝：一条发光竖线，明确「这是两块屏」
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const lw = Math.max(2, Math.round(cw * 0.0018));
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, 'rgba(86,232,255,0.85)');
    g.addColorStop(0.5, 'rgba(230,251,255,0.95)');
    g.addColorStop(1, 'rgba(86,232,255,0.85)');
    ctx.fillStyle = g;
    ctx.fillRect(halfW - lw / 2, 0, lw, ch);
  }

  // ---------------- 屏幕空间 ----------------
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  fx.drawFlash(ctx, cw, ch);

  for (let i = 0; i < n; i++) {
    const px = i === 0 ? 0 : halfW;
    const pxW = n === 1 ? cw : (i === 0 ? halfW : cw - halfW);
    drawViewOverlay(px, 0, pxW, ch, i);
  }

  // 暂停遮罩盖满整块战场（分屏时不该出现两个「已暂停」）
  if (paused) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(6,2,14,0.72)';
    ctx.fillRect(0, 0, viewW, viewH);
    ctx.fillStyle = '#E8DFFF';
    ctx.font = `900 ${Math.min(viewW, viewH) * 0.08}px "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('已暂停', viewW / 2, viewH / 2);
    ctx.font = `600 ${Math.min(viewW, viewH) * 0.028}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.fillStyle = 'rgba(232,223,255,0.6)';
    ctx.fillText('按 P 继续', viewW / 2, viewH / 2 + Math.min(viewW, viewH) * 0.07);
  }
}

/** 屏幕中心提示 */
function drawCenterTip(ctx, cx, cy, main, sub) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const bob = Math.sin(timeAcc * 2.4) * 8;

  ctx.font = '900 52px "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(12,4,26,0.8)';
  ctx.strokeText(main, cx, cy + bob - 10);
  ctx.fillStyle = 'rgba(182,255,87,0.95)';
  ctx.fillText(main, cx, cy + bob - 10);

  ctx.font = '600 22px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle = 'rgba(232,223,255,0.5)';
  ctx.fillText(sub, cx, cy + bob + 42);
  ctx.restore();
}

/** 复活倒计时（按某一位真人的复活剩余时间绘制） */
function drawRespawn(ctx, snake, cw, ch) {
  const left = snake.alive ? 0 : Math.max(0, snake.respawnTimer);
  const t = 1 - clamp(left / CONFIG.player.respawnDelay, 0, 1);

  ctx.save();
  // 暗角
  const vg = ctx.createRadialGradient(cw / 2, ch / 2, ch * 0.15, cw / 2, ch / 2, ch * 0.75);
  vg.addColorStop(0, 'rgba(20,4,14,0)');
  vg.addColorStop(1, 'rgba(20,4,14,0.72)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, cw, ch);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const size = Math.min(cw, ch) * 0.11;
  ctx.font = `900 ${size}px "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.lineWidth = size * 0.14;
  ctx.strokeStyle = 'rgba(10,2,20,0.9)';
  ctx.strokeText(left.toFixed(1), cw / 2, ch / 2 - size * 0.1);
  ctx.fillStyle = `rgba(255,138,180,${0.85 + 0.15 * Math.sin(performance.now() / 180)})`;
  ctx.fillText(left.toFixed(1), cw / 2, ch / 2 - size * 0.1);

  ctx.font = `700 ${size * 0.22}px "PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.fillStyle = 'rgba(255,220,235,0.85)';
  ctx.fillText('复活中', cw / 2, ch / 2 - size * 0.78);

  // 进度条
  const bw = Math.min(cw * 0.26, 320);
  const bh = 7;
  const bx = cw / 2 - bw / 2;
  const by = ch / 2 + size * 0.62;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, bh / 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,138,180,0.95)';
  ctx.beginPath();
  ctx.roundRect(bx, by, bw * t, bh, bh / 2);
  ctx.fill();

  ctx.restore();
}

// ---------------- 启动 ----------------
window.__poseSnake = {
  game,
  fx,
  tracker,
  poseLog,
  CONFIG,
  TUNING,
  cam,
  collectEnv,
  classifyCameraError,
  // 调识别参数的调试入口
  setHand: (h) => { const v = tracker.setHand(h); syncHandUI(); return v; },
  // 圆心刻度调试入口：0 脖子 / 0.35 胸口 / 0.5 旧版 / 1 腰
  setCenterT: (t) => { const v = tracker.setCenterT(t); syncTuningUI(); return v; },
  get centerT() { return tracker.centerT; },
  setLog: (on) => { poseLog.setEnabled(on); elLogEnabled.checked = poseLog.enabled; return poseLog.enabled; },
  exportLog: (fmt = 'json') => exportLog(fmt),
  clearLog: () => poseLog.clear(),
  get paused() { return paused; },
  get poseReady() { return poseReady; },
  get assetSource() { return tracker.assetSource; },
  get controlMode() { return controlMode; },
  get started() { return started; },
  // 复活静止保护期：调试 / 自动化用例可直接改，立即同步滑块与读数
  get respawnFreeze() { return TUNING.respawnFreeze; },
  setRespawnFreeze: (v) => {
    if (!Number.isFinite(v)) return TUNING.respawnFreeze;
    TUNING.respawnFreeze = clamp(v, CONFIG.player.respawnFreezeMin, CONFIG.player.respawnFreezeMax);
    safeStorage.setItem('poseSnakeFreeze', String(TUNING.respawnFreeze));
    // 当前正在待命的话同步延长 / 缩短，方便立刻观察效果
    if (game.player.alive && game.player.isFrozen()) {
      game.player.freezeUntil = performance.now() + TUNING.respawnFreeze * 1000;
    }
    syncTuningUI();
    return TUNING.respawnFreeze;
  },
  get playerFreezeIn() { return game.playerFreezeIn; },
  // AI 难度调试入口：Brain 每帧读 TUNING，设置后无需重开
  get aiLevel() { return TUNING.aiLevel; },
  get aiMistake() { return TUNING.aiMistake; },
  get aiPressure() { return TUNING.aiPressure; },
  get computedAiPressure() { return computeAiPressure(TUNING); },
  setAiLevel: (v) => {
    if (!Number.isFinite(v)) return TUNING.aiLevel;
    const A = CONFIG.ai.difficulty;
    TUNING.aiLevel = clamp(v, A.levelMin, A.levelMax);
    safeStorage.setItem('poseSnakeAiLevel', String(TUNING.aiLevel));
    syncTuningUI();
    return TUNING.aiLevel;
  },
  setAiMistake: (v) => {
    if (!Number.isFinite(v)) return TUNING.aiMistake;
    const A = CONFIG.ai.difficulty;
    TUNING.aiMistake = clamp(v, A.mistakeMin, A.mistakeMax);
    safeStorage.setItem('poseSnakeAiMistake', String(TUNING.aiMistake));
    syncTuningUI();
    return TUNING.aiMistake;
  },
  setAiPressure: (v) => {
    if (!Number.isFinite(v)) return TUNING.aiPressure;
    const P = CONFIG.ai.pressure;
    TUNING.aiPressure = clamp(v, P.min, P.max);
    safeStorage.setItem('poseSnakeAiPressure', String(TUNING.aiPressure));
    syncTuningUI();
    return TUNING.aiPressure;
  },
  /** 一次设置两项，自动化用例里比连调两次更省往返 */
  setAiDifficulty: (level, mistake) => {
    window.__poseSnake.setAiLevel(level);
    if (Number.isFinite(mistake)) window.__poseSnake.setAiMistake(mistake);
    return { level: TUNING.aiLevel, mistake: TUNING.aiMistake };
  },
  // ---- 大蛇加粗：可视化/判定共用 snakeRadius()，设置后立即生效 ----
  get girthMax() { return TUNING.girthMax; },
  get snakeRadius() { return snakeRadius(CONFIG.snake.startSegments); },
  radiusOf: (segments) => snakeRadius(segments),
  setGirth: (v) => {
    if (!Number.isFinite(v)) return TUNING.girthMax;
    const G = CONFIG.snake.girth;
    TUNING.girthMax = clamp(v, G.min, G.max);
    safeStorage.setItem('poseSnakeGirth', String(TUNING.girthMax));
    syncTuningUI();
    return TUNING.girthMax;
  },
  // ---- NPC 蛇头造型：每局洗牌分配，一局之内 7 只 AI 互不重复 ----
  get headStyleOn() { return !!TUNING.headStyleOn; },
  /** 当前这一局每条 AI 分到的造型（测试用来断言"不重复"） */
  get headStyles() {
    return game.snakes
      .filter((s) => !s.isPlayer)
      .map((s) => ({ id: s.id, name: s.name, headStyle: s.headStyle }));
  },
  /** 开关造型；切换后立刻重洗当前局 */
  setHeadStyle: (on) => {
    TUNING.headStyleOn = !!on;
    safeStorage.setItem('poseSnakeHeadStyle', TUNING.headStyleOn ? '1' : '0');
    game.assignHeadStyles();
    syncTuningUI();
    return TUNING.headStyleOn;
  },
  /** 手动重洗一次造型分配（同一局内仍保证不重复） */
  reshuffleHeadStyles: () => {
    game.assignHeadStyles();
    return window.__poseSnake.headStyles;
  },
  // ---- 圆心横向：自动居中值 + 手动微调 ----
  get centerXAuto() { return tracker.centerShiftN; },
  get centerXManual() { return CONFIG.pose.centerX.manual || 0; },
  setCenterXManual: (v) => {
    const CX = CONFIG.pose.centerX;
    CONFIG.pose.centerX.manual = Number.isFinite(v) ? clamp(v, CX.manualMin, CX.manualMax) : 0;
    safeStorage.setItem('poseSnakeCenterX', String(CONFIG.pose.centerX.manual));
    syncTuningUI();
    return CONFIG.pose.centerX.manual;
  },
  /** 清空自动居中已学到的极值，重新开始标定（换人 / 换姿势后可用） */
  resetCenterX: () => {
    tracker._cxState = { min: NaN, max: NaN, n: 0 };
    tracker._cxShift = 0;
    syncCenterXReadout();
    return true;
  },
  // ---- 道具调试入口：自动化用例 / 现场验证用 ----
  get powerups() { return game.powerups; },
  spawnPowerup: (type, x, y) => game.spawnPowerup(type, x, y),
  grantBuff: (type, sec) => {
    const cfg = CONFIG.powerups[type];
    if (!cfg) return null;
    game.player.applyBuff(type, Number.isFinite(sec) ? sec : cfg.durationSec);
    return { boost: game.player.buffLeft('boost'), magnet: game.player.buffLeft('magnet') };
  },
  get playerBuffs() {
    return { boost: game.player.buffLeft('boost'), magnet: game.player.buffLeft('magnet') };
  },
  setPowerupsEnabled: (on) => {
    CONFIG.powerups.enabled = !!on;
    return CONFIG.powerups.enabled;
  },
  // ---- 单局调试入口：自动化用例可把倒计时压到几秒来验证结算 ----
  get roundLeft() { return game.roundLeft; },
  /** 只读诊断：结算 / 举手重开的状态机快照，自动化用例定位用 */
  get roundDebug() {
    return {
      resultShown, resultAt, prevRaiseConfirmed, poseReady, paused,
      state: game.state, raiseConfirmed: !!tracker.raiseConfirmed,
      now: performance.now()
    };
  },
  get roundResult() { return game.roundResult; },
  get ranking() { return game.ranking; },
  get aiStyles() { return game.brains.map((b) => b.style ? b.style.label : null); },
  /** 改单局时长并重置世界（会回到 ready，测试里请紧接着调 start） */
  setRoundDuration: (sec) => {
    if (!Number.isFinite(sec) || sec < 1) return CONFIG.round.durationSec;
    CONFIG.round.durationSec = sec;
    hideResult();          // 从结算页改时长时，收起比高舞台免得盖住新一局
    game.reset();
    syncRoundModeUI();
    return CONFIG.round.durationSec;
  },
  setRoundMode: (mode) => {
    CONFIG.round.mode = mode === 'endless' ? 'endless' : 'timed';
    hideResult();
    game.reset();
    syncRoundModeUI();
    return CONFIG.round.mode;
  },
  /** 立即结束本局并弹出结算页，不等倒计时（验证排名口径用） */
  forceFinish: () => { game.finishRound(); showResult(); return game.roundResult; },
  // ---- 结算舞台调试入口：自动化用例验证生长 / 镜头 / 跳过 ----
  get resultStage() { return resultStage.debug; },
  skipResultStage: () => { resultStage.skip(); return resultStage.debug; },
  restartRound: () => { restartRound(); return game.state; },
  start: () => startGame(),
  enterKeyboardMode: () => enterKeyboardMode(),
  retryCamera: () => bootCamera(),
  setSignal: (s) => { signalOverride = s; },
  // 设置面板折叠状态：调试用例与远程协助可直接读写
  get tuningOpen() { return !elTuning.classList.contains('collapsed'); },
  setTuningOpen: (open) => setTuningOpen(open),
  // 分区布局只读快照：回归用例与真机调参用
  get arenaLayout() {
    const a = elArena.getBoundingClientRect();
    const b = elUiBar.getBoundingClientRect();
    return {
      uiH: Math.round(b.height),
      arenaTop: Math.round(a.top),
      arenaW: Math.round(a.width),
      arenaH: Math.round(a.height),
      viewW, viewH,
      split: document.body.dataset.split || '1',
      inRound: document.body.classList.contains('in-round'),
      pauseOpen: document.body.classList.contains('pause-open'),
      timeFont: parseFloat(getComputedStyle(elTimeLeft).fontSize),
      rankFont: parseFloat(getComputedStyle(elRank).fontSize),
      camW: Math.round(elCamWrap.getBoundingClientRect().width),
      canvasW: canvas.width,
      canvasH: canvas.height
    };
  },
  setPauseOpen: (on) => setTuningOpen(!!on, false),
  /** 手动触发一次界面动效，方便截图与回归；不触碰游戏逻辑 */
  uiFx: (kind) => {
    if (kind === 'boost') flashClass(document.body, 'ui-boost', 900);
    else if (kind === 'shake') flashClass(document.body, 'ui-shake', 420);
    else if (kind === 'lastCall') document.body.classList.add('ui-lastcall');
    else if (kind === 'rankUp') {
      elRankArrow.textContent = '▲';
      flashClass(elRankBlock, 'rank-up', 680);
    } else if (kind === 'rankDown') {
      elRankArrow.textContent = '▼';
      flashClass(elRankBlock, 'rank-down', 680);
    } else if (kind === 'clear') {
      document.body.classList.remove('ui-lastcall');
      elRankBlock.classList.remove('rank-up', 'rank-down');
      elRankArrow.textContent = '';
    }
    return {
      body: document.body.className,
      rank: elRankBlock.className,
      arrow: elRankArrow.textContent
    };
  },
  // 第 2 个位置参数是旧版「手肘权重」的历史占位，已无作用；
  // 保留位置是为了让既有回归脚本的 8 参数调用方式继续可用（不静默错位）。
  setTuning: (turn, _legacyElbow, slow, scale, center, freeze, aiLevel, aiMistake, aiPressure) => {
    if (Number.isFinite(turn)) TUNING.turnRate = clamp(turn, CONFIG.turn.rateMin, CONFIG.turn.rateMax);
    if (Number.isFinite(slow)) TUNING.slowStrength = clamp(slow, CONFIG.slowdown.strengthMin, CONFIG.slowdown.strengthMax);
    if (Number.isFinite(scale)) TUNING.slowScale = clamp(scale, CONFIG.slowdown.scaleMin, CONFIG.slowdown.scaleMax);
    // 第 5~8 个参数可选，保持旧调用方式（4 个参数）完全兼容
    if (Number.isFinite(center)) tracker.setCenterT(center);
    if (Number.isFinite(freeze)) TUNING.respawnFreeze = clamp(freeze, CONFIG.player.respawnFreezeMin, CONFIG.player.respawnFreezeMax);
    const A = CONFIG.ai.difficulty;
    if (Number.isFinite(aiLevel)) TUNING.aiLevel = clamp(aiLevel, A.levelMin, A.levelMax);
    if (Number.isFinite(aiMistake)) TUNING.aiMistake = clamp(aiMistake, A.mistakeMin, A.mistakeMax);
    // 第 9 个参数可选：压迫强度（旧调用方式不受影响）
    if (Number.isFinite(aiPressure)) {
      const P = CONFIG.ai.pressure;
      TUNING.aiPressure = clamp(aiPressure, P.min, P.max);
    }
    syncTuningUI();
  },
  // ---- 距离→速度调试入口 ----
  // 只读快照，方便自动化用例核对默认 0.65~1.40 / 距离区间 / 防抖参数
  get speedTuning() { return { ...CONFIG.pose.speed }; },
  setSpeedTuning: (o = {}) => {
    for (const k of ['min', 'max', 'far', 'near', 'smooth']) {
      if (Number.isFinite(o[k])) tracker.setSpeedParam(k, o[k]);
    }
    syncTuningUI();
    return { ...CONFIG.pose.speed };
  },
  // 玩家蛇当前生效的体感速度倍率（AI 恒为 1，用来确认基线没被污染）
  get playerSpeedScale() { return game.player.poseSpeed; },
  // 当前体感信号里的平滑前 / 平滑后倍率，用于验证防抖（默认玩家 1）
  get speedDebug() {
    const slot = tracker.slots[0];
    return { target: slot.speedTarget, smooth: slot.smSpeed, signal: tracker.signal.speedScale };
  },
  // ---- 双人模式调试入口 ----
  get playerCount() { return game.players.length; },
  setPlayers: (n) => setPlayerCount(n),
  // 结算头像裁切：自动化用例接管 video 帧后，注入 landmarks 直接取结果，
  // 用来验证「定位头部 → 裁方图 → 水平翻转 → JPEG」整条链路
  captureAvatar: (i = 0) => capturePlayerAvatar(i),
  // 上次启动耗时（点开始 → 可玩）：{ ms, stages, at }。
  // 用户报"启动慢"时，先读它，再看 stages 里是哪一段占了大头。
  get lastBoot() { return lastBoot; },
  // 资源预取进度（标题画面那行百分比）：{ ratio, done, failed }
  get warmup() { return { ...warmupProgress }; },
  // 触摸滑动的当前方向（手机兜底控制）：自动化用例派发 PointerEvent 后读它验证
  get touch() {
    return { angle: touchState.angle, at: touchState.at, dragging: !!touchDrag };
  },
  // 当前相机一屏能看到多少世界单位（CSS px / 世界单位的换算也一并给出）。
  // 手机竖屏曾经因为固定 1600×900 的视野矩形被撑到 2870 高，
  // 蛇缩成 10px；这条接口让回归用例能直接卡住"别再把镜头拉远"。
  viewSize: () => {
    const half = splitHalfSize();
    // 双人时每个视口只有半屏宽，perUnit 必须按半屏算，否则会报出两倍的密度
    const halfCssW = viewW / Math.max(1, game.players.length);
    return {
      w: Math.round(half.w),
      h: Math.round(half.h),
      cssW: Math.round(halfCssW),
      cssH: viewH,
      dpr,
      perUnit: Math.round((halfCssW / half.w) * 1000) / 1000   // 每世界单位占多少 CSS 像素
    };
  },
  get players() {
    return game.players.map((p) => ({
      index: p.playerIndex, alive: p.alive, length: p.alive ? p.length : 0,
      rank: game.rankOf(p), name: p.name, color: p.color
    }));
  },
  // 每位真人的体感信号快照（seen / angle / speed / 举手进度），分屏调试用
  get signals() {
    return tracker.signals.map((s, i) => ({
      index: i,
      seen: !!s.seen,
      angle: s.angle,
      speedScale: s.speedScale,
      raiseTimer: tracker.raiseTimerOf(i),
      raised: !!s.raised,
      reason: s.debug ? s.debug.reason : ''
    }));
  }
};

updateHUD(true);
requestAnimationFrame(loop);

// 标题画面：恢复上次选的人数（1 人 / 2 人），并把标题文案还原成默认值。
// showOverlay 只留给诊断 / 报错路径，不再覆盖标题画面的名字。
const savedPlayers = Number(safeStorage.getItem('poseSnakePlayers') || 1);
resetTitleScreen(savedPlayers >= 2 ? 2 : 1);
elOverlay.classList.remove('hidden');
setHint('');
syncQuickPlayBtn();
syncRoundModeUI();

// 标题画面一出现就在后台预取 8MB 姿态资源（WASM + 模型）。
// 玩家读规则、选人数的那几秒正好用来下载；点开始后 MediaPipe 直接命中缓存，
// 不必等授权弹窗关掉才开始下文件。延迟 700ms 让首屏和字体先渲染完，
// 免得预热和首屏抢带宽反而让标题画面变慢。
setTimeout(() => {
  warmupPoseAssets();
  startWarmupUI();
}, 700);

/**
 * 标题画面上的资源预取进度
 * ------------------------------------------------------------
 * 8MB 不可能秒下。与其让玩家对着"点了没反应"猜，不如把进度摊开 ——
 * 知道在动，等待的感受会短得多。完成或失败都自己收尾，不影响后续启动流程。
 */
function startWarmupUI() {
  if (!elAssetState) return;
  elAssetState.classList.remove('hidden', 'ok');
  const timer = setInterval(() => {
    if (warmupProgress.failed) {
      clearInterval(timer);
      elAssetState.classList.add('hidden');
      return;
    }
    if (warmupProgress.done) {
      clearInterval(timer);
      elAssetState.textContent = '体感资源已就绪';
      elAssetState.classList.add('ok');
      setTimeout(() => elAssetState.classList.add('hidden'), 1600);
      return;
    }
    elAssetState.textContent = `正在准备体感资源 ${Math.round(warmupProgress.ratio * 100)}%`;
  }, 180);
}

// 编辑器内置预览 / iframe 里，浏览器通常会直接吞掉摄像头权限请求，
// 表现为"点了完全没反应"。这里提前把原因和出路写在面板上。
if (window.top !== window.self) {
  elFineprint.textContent =
    '当前是嵌入式预览窗口，浏览器往往会拦截摄像头。请把地址复制到独立的 Chrome / Edge 标签页打开；也可以直接点「先用方向键玩」。';
  elKbBtn.classList.remove('hidden');
}
