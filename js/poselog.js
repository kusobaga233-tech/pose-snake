/**
 * 体感输入日志
 * ------------------------------------------------------------
 * 目的：把"识别到底有没有工作、方向有没有跟手"变成可事后分析的数据。
 * 每 50ms 采一条，另外在 seen / hold / 死区 / 控制手 / 游戏状态发生跳变时
 * 强制补记一条，既不漏掉关键瞬间，也不会把几分钟的游玩撑成几十 MB。
 *
 * 导出的是纯 JSON / CSV，直接可用 Python(pandas)、Excel 打开。
 * 字段含义见 COLUMNS，避免过几天自己也看不懂列名。
 */

/** 列名 → 中文说明（导出文件里会带上） */
export const COLUMNS = {
  t: '相对开局的毫秒数',
  f: '主循环帧号',
  state: '游戏状态 ready/playing',
  seen: '本帧是否检测到人 1/0',
  hold: '是否沿用旧方向 1/0',
  ctrl: '本帧是否给蛇控制量 1/0',
  kb: '本帧方向是否来自键盘兜底 1/0（1 表示不是体感输入，分析识别时要排除）',
  hand: '实际控制手 auto/right / right / left',
  reason: '姿态不可用原因 no-pose / low-shoulder / low-arm / 空',
  useHips: '腰部基准是否用了髋点 1/0，0 = 上半身降级（用肩宽估腰）',
  ct: '圆心刻度 0=脖子(双肩中点) / 0.35=胸口 / 0.5=旧版躯干正中 / 1=腰(双髋中点)',
  vLS: '左肩可见性', vRS: '右肩可见性',
  vLH: '左髋可见性', vRH: '右髋可见性',
  vElb: '控制手肘可见性', vWri: '控制手腕可见性',
  cx: '插值后的圆心 x（镜像后像素）', cy: '插值后的圆心 y',
  wx: '手腕 x', wy: '手腕 y',
  ex: '手肘 x', ey: '手肘 y',
  torso: '躯干基准长度（像素）',
  distN: '手腕离圆心的归一化距离',
  dead: '是否通过死区 1/0（0 = 方向角没更新）',
  angle: '体感目标角度（度，屏幕坐标）',
  heading: '蛇头当前朝向（度）',
  diff: '目标角度与蛇头的差（度，绝对值）',
  spd: '手腕距离映射出的速度倍率（已平滑，默认 0.80~1.20）',
  spdRaw: '平滑前的目标速度倍率',
  raised: '是否判定为举手 1/0',
  raiseT: '举手已保持秒数',
  fps: '主循环帧率（realDt 钳制后）',
  score: '当前分数'
};

/** 角度差归一到 0..180，避免 ±180 跳变被算成 360° */
function angleGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export class PoseLog {
  /**
   * @param {object} config 全局 CONFIG，导出时带一份配置快照
   */
  constructor(config) {
    this.cfg = config.poseLog;
    this.appCfg = config;
    this.records = [];
    this.enabled = !!this.cfg.enabled;
    this.sessionStart = 0;
    this.sessionId = '';
    this.lastSampleAt = -Infinity;
    this.lastKey = '';
    this.frame = 0;
    this.truncated = false;
  }

  /** 开新一段录制（摄像头就绪 / 手动重开时调用） */
  start() {
    this.records.length = 0;
    this.truncated = false;
    this.sessionStart = performance.now();
    this.lastSampleAt = -Infinity;
    this.lastKey = '';
    this.frame = 0;
    const d = new Date();
    this.sessionId = d.toISOString();
  }

  /** 暂停 / 恢复录制 */
  setEnabled(on) {
    this.enabled = !!on;
    return this.enabled;
  }

  /** 清空当前会话但保持录制状态 */
  clear() {
    this.start();
  }

  get count() {
    return this.records.length;
  }

  /**
   * 每帧调用一次
   * @param {number} nowMs performance.now()
   * @param {object} signal PoseTracker.signal
   * @param {object} extra { state, controlUsed, headingDeg, raiseTimer, score, fps }
   */
  sample(nowMs, signal, extra = {}) {
    if (!this.enabled || !this.sessionStart) return;
    this.frame++;

    const d = signal.debug || {};
    // 状态指纹：任何跳变都强制补记一条，保证"识别断掉的那一帧"一定在日志里
    const key = [
      signal.seen ? 1 : 0,
      signal.hold ? 1 : 0,
      signal.keyboard ? 1 : 0,     // 键盘/体感切换的那一帧也必须留痕
      d.deadzonePass ? 1 : 0,
      d.hand || '',
      d.reason || '',
      d.centerT ?? '',        // 玩家拖动圆心滑块那一刻也要留痕
      extra.state || ''
    ].join('|');
    const changed = key !== this.lastKey;
    this.lastKey = key;
    if (!changed && nowMs - this.lastSampleAt < this.cfg.sampleMs) return;
    this.lastSampleAt = nowMs;

    const vis = d.vis || [null, null, null, null, null, null];
    const angle = +(signal.angle * 180 / Math.PI).toFixed(1);
    const heading = Number.isFinite(extra.headingDeg) ? +extra.headingDeg.toFixed(1) : null;
    const rec = {
      t: +(nowMs - this.sessionStart).toFixed(1),
      f: this.frame,
      state: extra.state || '',
      seen: signal.seen ? 1 : 0,
      hold: signal.hold ? 1 : 0,
      ctrl: extra.controlUsed ? 1 : 0,
      kb: signal.keyboard ? 1 : 0,
      hand: d.hand || '',
      reason: d.reason || '',
      useHips: d.useHips === null || d.useHips === undefined ? '' : (d.useHips ? 1 : 0),
      ct: d.centerT ?? null,
      vLS: this.num(vis[0]), vRS: this.num(vis[1]),
      vLH: this.num(vis[2]), vRH: this.num(vis[3]),
      vElb: this.num(vis[4]), vWri: this.num(vis[5]),
      cx: d.center?.x ?? null, cy: d.center?.y ?? null,
      wx: d.wrist?.x ?? null, wy: d.wrist?.y ?? null,
      ex: d.elbow?.x ?? null, ey: d.elbow?.y ?? null,
      torso: d.torsoPx ?? null,
      distN: d.distN ?? null,
      dead: d.deadzonePass ? 1 : 0,
      angle,
      heading,
      diff: heading === null ? null : +angleGap(angle, heading).toFixed(1),
      spd: +(signal.speedScale ?? 1).toFixed(3),
      spdRaw: Number.isFinite(d.speedTarget) ? +d.speedTarget.toFixed(3) : null,
      raised: signal.raised ? 1 : 0,
      raiseT: Number.isFinite(extra.raiseTimer) ? +extra.raiseTimer.toFixed(2) : null,
      fps: Number.isFinite(extra.fps) ? +extra.fps.toFixed(1) : null,
      score: extra.score ?? null
    };

    this.records.push(rec);
    // 超过上限时批量丢弃最旧的一段，避免每条都 shift 造成卡顿
    if (this.records.length > this.cfg.maxRecords) {
      this.records.splice(0, 500);
      this.truncated = true;
    }
  }

  /** 数值统一保留两位，null 原样保留 */
  num(v) {
    return Number.isFinite(v) ? +v.toFixed(2) : null;
  }

  /**
   * 汇总统计：一眼看出"识别率、丢帧、死区是否挡住方向、角度有没有真的在变"
   */
  summary() {
    const r = this.records;
    if (!r.length) return { records: 0 };
    const n = r.length;
    const dur = Math.max(1, r[n - 1].t - r[0].t);
    const seen = r.filter((x) => x.seen).length;
    const hold = r.filter((x) => x.hold).length;
    const dead = r.filter((x) => x.dead).length;
    const hips = r.filter((x) => x.useHips === 0).length;
    // 本次会话出现过的圆心刻度：调过滑块时一眼看出在哪些刻度上比较过手感
    const centerTs = [...new Set(r.map((x) => x.ct).filter((x) => x !== null && x !== undefined && x !== ''))].sort((a, b) => a - b);

    // 连续丢失的最长段与次数
    let lostEvents = 0, maxLost = 0, cur = 0;
    const reasons = {};
    for (const x of r) {
      if (!x.seen) {
        cur++;
        if (cur === 1) lostEvents++;
        maxLost = Math.max(maxLost, cur);
        if (x.reason) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
      } else cur = 0;
    }

    // 角度累计变化量：如果玩家一直在挥手但这里接近 0，说明方向链路没生效
    let travel = 0;
    for (let i = 1; i < n; i++) {
      if (r[i].seen && r[i - 1].seen) travel += angleGap(r[i].angle, r[i - 1].angle);
    }

    return {
      records: n,
      durationSec: +(dur / 1000).toFixed(1),
      seenRatePct: +(seen / n * 100).toFixed(1),
      holdRatePct: +(hold / n * 100).toFixed(1),
      deadzonePassPct: +(dead / n * 100).toFixed(1),
      upperBodyFallbackPct: +(hips / n * 100).toFixed(1),
      centerTValues: centerTs,
      lostEvents,
      maxLostSamples: maxLost,
      lostReasons: reasons,
      angleTravelDeg: +travel.toFixed(1),
      angleTravelDegPerSec: +(travel / (dur / 1000)).toFixed(1),
      truncated: this.truncated
    };
  }

  /** 完整 JSON 对象（含配置快照、字段说明、摘要） */
  toJSON() {
    return {
      app: 'Pose Snake 体感输入日志',
      version: 1,
      sessionId: this.sessionId,
      exportedAt: new Date().toISOString(),
      columns: COLUMNS,
      config: {
        pose: { ...this.appCfg.pose },
        turn: { ...this.appCfg.turn },
        slowdown: { ...this.appCfg.slowdown },
        poseLog: { ...this.appCfg.poseLog }
      },
      summary: this.summary(),
      records: this.records
    };
  }

  /** CSV 字符串（第一行表头，方便 Excel / pandas 直接读） */
  toCSV() {
    if (!this.records.length) return '';
    const keys = Object.keys(this.records[0]);
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [keys.join(',')];
    for (const rec of this.records) lines.push(keys.map((k) => esc(rec[k])).join(','));
    return '\ufeff' + lines.join('\r\n');   // BOM，Excel 打开中文不乱码
  }

  /** 触发浏览器下载；返回文件名，方便页面提示 */
  download(format = 'json') {
    const isCSV = format === 'csv';
    const payload = isCSV ? this.toCSV() : JSON.stringify(this.toJSON(), null, 2);
    const blob = new Blob([payload], {
      type: isCSV ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8'
    });
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const name = `pose-snake-log-${ts}.${isCSV ? 'csv' : 'json'}`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { name, records: this.records.length, bytes: blob.size };
  }
}
