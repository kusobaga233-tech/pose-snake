/**
 * 特效系统
 * ------------------------------------------------------------
 * 负责"吃掉食物时炸开"的所有表现：
 *   粒子（色块 + 火花）、冲击波环、卡通爆炸星、飘字、屏幕震动、全屏闪白。
 * 另外内置一个极简 WebAudio 合成音效，不依赖任何外部音频资源。
 */

import { lerp, easeOutCubic, clamp } from './utils.js';
import { CONFIG } from './config.js';

/**
 * 特效专用随机流（xorshift32）
 * ------------------------------------------------------------
 * 以前粒子 / 火花 / 震屏方向直接调 frand()，而这个流同时被 AI 的
 * 「走神」「挑食物」等决策使用 —— 于是「把粒子从 60 颗减到 32 颗」这种纯
 * 视觉改动，会让 AI 抽到完全不同的随机序列，自撞率、进食顺序都跟着变。
 * 特效是表现层，不该影响玩法。这里给 FX 一条独立随机流：
 *   视觉上完全一样（分布均匀），但玩法侧的随机数与特效数量彻底解耦，
 *   以后调特效再也不会动到 AI 的行为统计。
 */
let fxSeed = 0x9E3779B9;
function frand() {
  fxSeed ^= fxSeed << 13; fxSeed >>>= 0;
  fxSeed ^= fxSeed >>> 17;
  fxSeed ^= fxSeed << 5; fxSeed >>>= 0;
  return fxSeed / 4294967296;
}

/** 从数组里随机取一个（走 FX 独立流；utils.pick 用的是主随机流） */
function fpick(arr) {
  return arr[(frand() * arr.length) | 0];
}

/**
 * 单个粒子
 */
class Particle {
  constructor(o) {
    this.x = o.x;
    this.y = o.y;
    this.vx = o.vx;
    this.vy = o.vy;
    this.r = o.r;
    this.color = o.color;
    this.life = o.life;
    this.maxLife = o.life;
    this.gravity = o.gravity ?? 900;
    this.drag = o.drag ?? 2.6;
    this.shape = o.shape ?? 'circle';
    this.rot = o.rot ?? frand() * Math.PI * 2;
    this.spin = o.spin ?? (frand() - 0.5) * 14;
    this.additive = o.additive ?? false;
  }

  update(dt) {
    this.life -= dt;
    // 阻力用指数衰减，比线性更自然
    const k = Math.exp(-this.drag * dt);
    this.vx *= k;
    this.vy *= k;
    this.vy += this.gravity * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.rot += this.spin * dt;
  }

  draw(ctx) {
    const t = Math.max(0, this.life / this.maxLife); // 1 -> 0
    // 生命末期收缩，制造"燃尽"的感觉
    const scale = t < 0.35 ? t / 0.35 : 1;
    const r = this.r * scale;
    if (r <= 0.4) return;

    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 1.6);
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rot);
    ctx.fillStyle = this.color;

    if (this.shape === 'square') {
      ctx.fillRect(-r, -r, r * 2, r * 2);
    } else if (this.shape === 'star') {
      // 五角星，卡通爆炸碎片的味道
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * 0.46;
        const px = Math.cos(a) * rr;
        const py = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    } else if (this.shape === 'spark') {
      // 拉长的火花，朝速度反方向拖尾
      const len = r * 3.2;
      ctx.rotate(Math.atan2(this.vy, this.vx));
      ctx.fillRect(-len, -r * 0.35, len * 2, r * 0.7);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * 扩散圆环
 */
class Shockwave {
  constructor(o) {
    this.x = o.x;
    this.y = o.y;
    this.r0 = o.r0;
    this.r1 = o.r1;
    this.width = o.width;
    this.color = o.color;
    this.life = o.life;
    this.maxLife = o.life;
    this.delay = o.delay ?? 0;
  }

  update(dt) {
    if (this.delay > 0) {
      this.delay -= dt;
      return;
    }
    this.life -= dt;
  }

  draw(ctx) {
    if (this.delay > 0) return;
    const t = 1 - Math.max(0, this.life / this.maxLife);
    const r = lerp(this.r0, this.r1, easeOutCubic(t));
    ctx.save();
    ctx.globalAlpha = Math.pow(1 - t, 1.6);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.width * (1 - t * 0.7);
    ctx.beginPath();
    ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 卡通爆炸星形（吃到瞬间一闪而过的尖角放射）
 */
class BurstStar {
  constructor(o) {
    this.x = o.x;
    this.y = o.y;
    this.r = o.r;
    this.color = o.color;
    this.life = o.life;
    this.maxLife = o.life;
    this.spikes = o.spikes ?? 12;
    this.rot = frand() * Math.PI;
  }

  update(dt) {
    this.life -= dt;
    this.rot += dt * 3;
  }

  draw(ctx) {
    const t = 1 - Math.max(0, this.life / this.maxLife);
    const outer = this.r * (0.6 + easeOutCubic(t) * 1.9);
    const inner = outer * 0.42;
    ctx.save();
    ctx.globalAlpha = Math.pow(1 - t, 1.2);
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rot);
    ctx.beginPath();
    for (let i = 0; i < this.spikes * 2; i++) {
      const a = (i / (this.spikes * 2)) * Math.PI * 2;
      const rr = i % 2 === 0 ? outer : inner;
      const px = Math.cos(a) * rr;
      const py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.restore();
  }
}

/**
 * 飘字（开局 GO! / 击杀 / 被吃 / 复活 / 道具名）
 * 注意：吃食物不再飘字 —— 那条路径每次进食都会触发，连吃时整片糊在蛇头上。
 */
class FloatText {
  constructor(o) {
    this.x = o.x;
    this.y = o.y;
    this.text = o.text;
    this.color = o.color;
    this.size = o.size;
    this.life = o.life;
    this.maxLife = o.life;
    this.vy = o.vy ?? -90;
  }

  update(dt) {
    this.life -= dt;
    this.y += this.vy * dt;
    this.vy *= Math.exp(-2.2 * dt);
  }

  draw(ctx) {
    const t = 1 - Math.max(0, this.life / this.maxLife);
    // 弹出：前 30% 时间放大到 1.25 再回落到 1
    let scale;
    if (t < 0.18) scale = lerp(0.3, 1.28, t / 0.18);
    else if (t < 0.32) scale = lerp(1.28, 1, (t - 0.18) / 0.14);
    else scale = 1;

    ctx.save();
    ctx.globalAlpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
    ctx.translate(this.x, this.y);
    ctx.scale(scale, scale);
    ctx.font = `900 ${this.size}px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = this.size * 0.18;
    ctx.strokeStyle = 'rgba(20,8,40,0.85)';
    ctx.strokeText(this.text, 0, 0);
    ctx.fillStyle = this.color;
    ctx.fillText(this.text, 0, 0);
    ctx.restore();
  }
}

/**
 * 极简音效合成器（无需外部音频文件）
 */
class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  /** 浏览器要求用户手势后才能创建 AudioContext */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** 吃到食物的"啵"声：短促上滑 + 噪声爆破 */
  eat(big = false) {
    if (!this.enabled) return;
    const ac = this.ensure();
    if (!ac) return;
    const t = ac.currentTime;
    const base = big ? 300 : 440;

    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 2.6, t + 0.1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(big ? 0.34 : 0.22, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.24);

    // 噪声爆破，制造"爆开"的质感
    const dur = 0.16;
    const buf = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (frand() * 2 - 1) * Math.pow(1 - i / data.length, 2.4);
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    const ng = ac.createGain();
    ng.gain.value = big ? 0.3 : 0.18;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = big ? 1400 : 2200;
    bp.Q.value = 0.8;
    src.connect(bp).connect(ng).connect(ac.destination);
    src.start(t);
  }

  /**
   * 拾取道具：两个上滑短音。
   * 刻意不用 eat() 里的噪声 buffer —— 填噪声要白填一段随机数，这里不需要。
   */
  powerup() {
    if (!this.enabled) return;
    const ac = this.ensure();
    if (!ac) return;
    const t0 = ac.currentTime;
    for (let i = 0; i < 2; i++) {
      const t = t0 + i * 0.085;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      const base = 520 + i * 260;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 1.7, t + 0.11);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.20);
      osc.connect(g).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.22);
    }
  }

  /** 死亡：低频下坠 + 长噪声 */
  die() {
    if (!this.enabled) return;
    const ac = this.ensure();
    if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.75);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.9);
  }
}

/**
 * 特效管理器
 */
export class FX {
  constructor() {
    this.particles = [];
    this.waves = [];
    this.stars = [];
    this.texts = [];
    this.sfx = new Sfx();

    // 屏幕震动状态
    this.shakeAmp = 0;
    this.shakeX = 0;
    this.shakeY = 0;

    // 全屏闪白强度
    this.flash = 0;
    this.flashColor = '255,255,255';

    // 画面缩放脉冲（吃到瞬间轻微"推镜"，是打击感的关键）
    this.zoom = 1;

    // 时间放缓剩余时长（秒，真实时间）
    this.hitStop = 0;
  }

  /**
   * 主爆开效果：食物被吃掉
   * @param {number} x 世界坐标
   * @param {number} y
   * @param {object} opts { color, big, radius }
   */
  /**
   * 触发一档屏幕反馈
   * 只有玩家自己的行为才调用这里——别人的动作不放震屏/闪白/音效，
   * 否则 8 只 AI 在场上吃东西会把画面震得没法看。
   * @param {'food'|'bigFood'|'kill'|'death'} level
   */
  impact(level) {
    const table = CONFIG.fx.impact;
    const p = table[level];
    if (!p) return;

    // 取最大值而不是叠加：连续吃到两个食物不该震成两倍
    this.shakeAmp = Math.max(this.shakeAmp, p.shake);
    this.flash = Math.max(this.flash, p.flash);
    this.hitStop = Math.max(this.hitStop, p.hitStop);
    this.zoom = Math.max(this.zoom, 1 + p.zoom);
    this.flashColor = level === 'kill' || level === 'death'
      ? '255,90,130'
      : level === 'bigFood' ? '255,220,120' : '255,255,255';
  }

  /**
   * 食物被吃掉
   * @param {object} opts {color, big, radius, own}
   *   own=true 表示是玩家自己吃的：才触发震屏、闪白、音效
   */
  explode(x, y, opts = {}) {
    const { color = '#FF4D9D', big = false, radius = 27, own = false } = opts;
    const mult = big ? 1.75 : 1;

    // ---- 0. 头部可读性：玩家自己吃「普通食物」时收敛特效 ----
    // 吃食物发生在蛇头位置，磁铁 / 密集食物会每 0.1~0.3 秒重复触发一次，
    // 碎片、火花、爆炸星同时在蛇头上叠加，玩家反而看不清自己在哪、朝哪。
    // 这里只削这一条最高频的路径（own && !big）；
    // 金果、击杀、被吃的大爆开完全不受影响。
    const HC = CONFIG.fx.headClarity;
    const calm = own && !big && HC.enabled;

    const count = Math.round((big ? 52 : 34) * (calm ? HC.particleMul : 1));

    // ---- 1. 大颗彩色碎片：慢、重、有体积 ----
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + frand() * 0.4;
      const speed = (140 + frand() * 420) * mult;
      this.particles.push(new Particle({
        x, y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 80,
        r: (4 + frand() * 11) * mult,
        color: frand() < 0.32 ? '#FFF6B0' : color,
        life: 0.5 + frand() * 0.6,
        gravity: 1150,
        drag: 2.2,
        shape: fpick(['circle', 'circle', 'square', 'star'])
      }));
    }

    // ---- 2. 高速火花：快、亮、拖尾，负责"炸"的方向感 ----
    const sparks = Math.round((big ? 40 : 26) * (calm ? HC.sparkMul : 1));
    for (let i = 0; i < sparks; i++) {
      const a = frand() * Math.PI * 2;
      const speed = (420 + frand() * 780) * mult;
      this.particles.push(new Particle({
        x, y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        r: 1.8 + frand() * 2.6,
        color: fpick(['#FFFDF0', '#FFE66D', color]),
        life: 0.22 + frand() * 0.3,
        gravity: 260,
        drag: 5.5,
        shape: 'spark',
        additive: true
      }));
    }

    // ---- 3. 冲击波：一快一慢，双层 ----
    // calm 时半径收窄：环还是从蛇头扩散，但不会一圈把蛇头盖成白色。
    const waveMul = calm ? HC.waveMul : 1;
    this.waves.push(new Shockwave({
      x, y, r0: radius * 0.6, r1: radius * 4.2 * mult * waveMul,
      width: 7 * mult, color: '#FFFFFF', life: 0.34
    }));
    this.waves.push(new Shockwave({
      x, y, r0: radius * 0.4, r1: radius * 6.5 * mult * waveMul,
      width: 4 * mult, color, life: 0.62, delay: 0.05
    }));

    // ---- 4. 卡通尖角爆发 ----
    // 这是覆盖蛇头最严重的一层（实心白黄星形，半径最大到 food.r 的 3.75 倍），
    // calm 时整层跳过，只保留碎片 + 火花 + 冲击波来表达"咬到"。
    if (!(calm && HC.skipStar)) {
      this.stars.push(new BurstStar({
        x, y, r: radius * 1.5 * mult, color: '#FFF7C2',
        life: 0.26, spikes: big ? 16 : 12
      }));
    }

    // ---- 5. 不飘字 ----
    // 以前每次进食都会在蛇头弹一句英文拟声词（金果更长更粗），连续进食时
    // 好几条白字叠在蛇头上，既挡位置又挡朝向，信息量却是零。
    // 已整体删除：吃食物的反馈交给音效 + 震屏 + 粒子，长度变化看 HUD 就够。

    // ---- 6. 屏幕反馈：只有玩家自己吃才有 ----
    if (own) {
      this.impact(big ? 'bigFood' : 'food');
      this.sfx.eat(big);
    }
  }

  /**
   * 道具拾取反馈：扩散环 + 一圈星屑 + 飘字。
   * 不震屏、不闪白 —— 用户明确要求「只有自己吃东西才震屏」，道具是另一类事件。
   * 星屑的角度 / 速度 / 自转全部由下标确定性生成，不做额外随机抽样：
   * 拾取频率高，省一次是一次，八个方向均匀铺开也更整齐。
   */
  pickup(x, y, opts = {}) {
    const { color = '#FFD93D', label = '道具', own = false } = opts;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.particles.push(new Particle({
        x, y,
        vx: Math.cos(a) * 260,
        vy: Math.sin(a) * 260,
        r: 4.5,
        color: i % 3 === 0 ? '#FFFFFF' : color,
        life: 0.5,
        gravity: 0,
        drag: 3.2,
        shape: 'star',
        rot: a,
        spin: 2.4,
        additive: true
      }));
    }
    this.waves.push(new Shockwave({ x, y, r0: 12, r1: 110, width: 6, color: '#FFFFFF', life: 0.36 }));
    this.waves.push(new Shockwave({ x, y, r0: 8, r1: 170, width: 4, color, life: 0.60, delay: 0.06 }));
    // 只有玩家拾取才飘字 / 出声，AI 拾取只留一圈光，画面不会被刷屏
    if (own) {
      this.texts.push(new FloatText({ x, y: y - 20, text: label, color, size: 40, life: 0.9 }));
      this.sfx.powerup();
    }
  }

  /** 死亡爆开：比普通爆开更夸张，沿着整条蛇身炸 */
  /**
   * 蛇死亡爆开
   * @param {Array} points 身体节点（世界坐标）
   * @param {string} color
   * @param {object} opts { own, killerIsPlayer }
   *   own=true            自己的蛇死了 → 最大档震屏
   *   killerIsPlayer=true 自己吃掉了别人 → 也是最大档震屏
   *   两者都 false（AI 之间互相撞死）→ 只放粒子，不震屏不出声
   */
  explodeDeath(points, color, opts = {}) {
    const { own = false, killerIsPlayer = false } = opts;

    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const n = i === 0 ? 16 : 6;
      for (let k = 0; k < n; k++) {
        const a = frand() * Math.PI * 2;
        const speed = 100 + frand() * 560;
        this.particles.push(new Particle({
          x: p.x, y: p.y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed - 120,
          r: 3 + frand() * 10,
          color: frand() < 0.25 ? '#FFFFFF' : color,
          life: 0.6 + frand() * 0.9,
          gravity: 900,
          drag: 1.9,
          shape: fpick(['circle', 'square', 'star'])
        }));
      }
    }

    const head = points[0] || { x: 0, y: 0 };
    this.waves.push(new Shockwave({
      x: head.x, y: head.y, r0: 20, r1: 520,
      width: 12, color: '#FF5C8A', life: 0.8
    }));
    this.stars.push(new BurstStar({
      x: head.x, y: head.y, r: 60, color: '#FFB3C7', life: 0.4, spikes: 18
    }));

    // ---- 屏幕反馈：只对玩家自己的事生效 ----
    if (own) {
      this.impact('death');
      this.sfx.die();
    } else if (killerIsPlayer) {
      this.impact('kill');
      this.sfx.eat(true);
    }
    // AI 之间互杀：什么都不做，让画面保持干净
  }

  /** 飘字（外部调用） */
  floatText(x, y, text, color = '#fff', size = 40) {
    this.texts.push(new FloatText({ x, y, text, color, size, life: 0.8 }));
  }

  /**
   * 更新
   * @param {number} dt 已应用时间缩放的 dt
   * @param {number} realDt 真实 dt（震动/闪白衰减用它，避免被 hit-stop 拖长）
   */
  update(dt, realDt) {
    // 粒子数量封顶：8 条蛇同时炸开时粒子会瞬间破万，不封顶会明显掉帧。
    // 粒子是 push 到末尾的，所以从数组头部（最老的）丢弃。
    const cap = CONFIG.fx.maxParticles || 1600;
    if (this.particles.length > cap) {
      this.particles.splice(0, this.particles.length - cap);
    }

    // 粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.update(dt);
      if (p.life <= 0) this.particles.splice(i, 1);
    }
    // 冲击波
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.update(dt);
      if (w.life <= 0 && w.delay <= 0) this.waves.splice(i, 1);
    }
    // 爆炸星
    for (let i = this.stars.length - 1; i >= 0; i--) {
      const s = this.stars[i];
      s.update(dt);
      if (s.life <= 0) this.stars.splice(i, 1);
    }
    // 飘字
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.update(dt);
      if (t.life <= 0) this.texts.splice(i, 1);
    }

    // 震动：用真实时间衰减，保证震感不会被 hit-stop 拉长
    // 衰减速度按幅度分档 —— 小震（吃食物）迅速平息只留"轻触感"，
    // 大震（击杀/被吃）拖得更久，让能级差异不只在幅度上、也在时长上体现
    const decayK = this.shakeAmp > 18 ? 4.6 : 8.5;
    this.shakeAmp *= Math.exp(-decayK * realDt);
    if (this.shakeAmp < 0.15) this.shakeAmp = 0;
    const a = frand() * Math.PI * 2;
    this.shakeX = Math.cos(a) * this.shakeAmp;
    this.shakeY = Math.sin(a) * this.shakeAmp;

    // 闪白
    this.flash *= Math.exp(-7 * realDt);
    if (this.flash < 0.004) this.flash = 0;

    // 缩放脉冲回弹
    this.zoom = 1 + (this.zoom - 1) * Math.exp(-8 * realDt);
    if (Math.abs(this.zoom - 1) < 0.0006) this.zoom = 1;

    // hit-stop 计时（真实时间）
    if (this.hitStop > 0) this.hitStop -= realDt;
  }

  /** 当前是否处于时间放缓状态 */
  get timeScale() {
    return this.hitStop > 0 ? 0.12 : 1;
  }

  /**
   * 画在蛇/食物上层的内容：碎片、火花、冲击波、爆炸星，最后是飘字
   */
  drawWorld(ctx) {
    // 加色混合的火花单独一批，视觉上才有"发光"的感觉
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) if (p.additive) p.draw(ctx);
    for (const w of this.waves) w.draw(ctx);
    for (const s of this.stars) s.draw(ctx);
    ctx.restore();

    for (const p of this.particles) if (!p.additive) p.draw(ctx);

    for (const t of this.texts) t.draw(ctx);
  }

  /** 全屏闪白（屏幕空间） */
  drawFlash(ctx, w, h) {
    if (this.flash <= 0) return;
    ctx.save();
    ctx.fillStyle = `rgba(${this.flashColor},${this.flash})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}
