/* ============================================================
 * TrackVisualizer · 命中特效系统（粒子 / 冲击波 / 闪光）
 * ==========================================================*/
(function (global) {
  'use strict';
  const TD = (global.TD = global.TD || {});
  const util = TD.util;

  const MAX_PARTICLES = 6000;
  const MAX_RINGS = 120;
  const BATCH_LEVELS = 6;

  class Effects {
    constructor() {
      this.particles = [];
      this.rings = [];
      this.flash = 0;      // 竖线闪光强度
      this.shake = 0;      // 屏幕抖动强度
      this.time = 0;
      this._batches = new Map();
    }

    reset() {
      this.particles.length = 0;
      this.rings.length = 0;
      this.flash = 0;
      this.shake = 0;
    }

    /**
     * 在 (x,y) 处爆开粒子（x,y 为画布像素，由调用方按参考高度缩放过）
     */
    burst(x, y, color, o) {
      o = o || {};
      const count = Math.max(0, Math.round(o.count == null ? 18 : o.count));
      if (count <= 0) return;
      const speed = o.speed == null ? 320 : o.speed;
      const spread = o.spread == null ? Math.PI * 2 : o.spread;
      const baseAngle = o.angle == null ? 0 : o.angle;
      const life = o.life == null ? 0.6 : o.life;
      const size = o.size == null ? 2.6 : o.size;
      const gravity = o.gravity == null ? 420 : o.gravity;
      const drag = o.drag == null ? 2.2 : o.drag;

      for (let i = 0; i < count; i++) {
        if (this.particles.length >= MAX_PARTICLES) break;
        const a = baseAngle + (Math.random() - 0.5) * spread;
        const sp = speed * (0.25 + Math.random() * 0.95);
        const lf = life * (0.55 + Math.random() * 0.75);
        this.particles.push({
          x: x, y: y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: lf, max: lf,
          size: size * (0.5 + Math.random()),
          color: color,
          gravity: gravity, drag: drag,
          spin: (Math.random() - 0.5) * 8,
          rot: Math.random() * Math.PI
        });
      }
    }

    ring(x, y, color, o) {
      o = o || {};
      if (this.rings.length >= MAX_RINGS) this.rings.shift();
      this.rings.push({
        x: x, y: y,
        r: o.startRadius == null ? 2 : o.startRadius,
        maxR: o.maxRadius == null ? 120 : o.maxRadius,
        life: o.life == null ? 0.45 : o.life,
        max: o.life == null ? 0.45 : o.life,
        width: o.width == null ? 3 : o.width,
        color: color,
        vertical: !!o.vertical
      });
    }

    addFlash(amount) {
      this.flash = Math.min(3.5, this.flash + amount);
    }

    addShake(amount) {
      this.shake = Math.min(40, this.shake + amount);
    }

    update(dt) {
      if (dt <= 0) return;
      this.time += dt;
      const ps = this.particles;
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.life -= dt;
        if (p.life <= 0) { ps.splice(i, 1); continue; }
        const damp = Math.max(0, 1 - p.drag * dt);
        p.vx *= damp;
        p.vy = p.vy * damp + p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
      }
      const rs = this.rings;
      for (let i = rs.length - 1; i >= 0; i--) {
        const r = rs[i];
        r.life -= dt;
        if (r.life <= 0) { rs.splice(i, 1); continue; }
        const t = 1 - r.life / r.max;
        r.r = r.r + (r.maxR - r.r) * Math.min(1, dt * 9 * (1 - t * 0.4));
      }
      this.flash = Math.max(0, this.flash - dt * 4.2);
      this.shake = Math.max(0, this.shake - dt * 26);
    }

    /** scale: 相对 1080p 的缩放系数 */
    draw(ctx, scale) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // 冲击波圆环
      for (let i = 0; i < this.rings.length; i++) {
        const r = this.rings[i];
        const t = 1 - r.life / r.max;
        const alpha = Math.pow(1 - t, 1.8) * 0.85;
        if (alpha <= 0.01) continue;
        ctx.strokeStyle = util.rgba(r.color, alpha);
        ctx.lineWidth = Math.max(0.6, r.width * scale * (1 - t * 0.75));
        ctx.beginPath();
        if (r.vertical) ctx.ellipse(r.x, r.y, r.r * 0.35, r.r, 0, 0, Math.PI * 2);
        else ctx.arc(r.x, r.y, Math.max(0.5, r.r), 0, Math.PI * 2);
        ctx.stroke();
      }

      // 粒子：按 颜色 × 透明度档位 合批，一次 fill 画一大批
      const batches = this._batches;
      batches.forEach(function (arr) { arr.length = 0; });
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        const t = p.life / p.max;
        const lvl = Math.max(1, Math.min(BATCH_LEVELS, Math.round(Math.min(1, t * 1.4) * BATCH_LEVELS)));
        const key = p.color + '|' + lvl;
        let arr = batches.get(key);
        if (!arr) { arr = []; batches.set(key, arr); }
        arr.push(p);
      }

      const TAU = Math.PI * 2;
      batches.forEach(function (arr, key) {
        if (!arr.length) return;
        const sep = key.lastIndexOf('|');
        ctx.fillStyle = util.rgba(key.slice(0, sep), parseInt(key.slice(sep + 1), 10) / BATCH_LEVELS);
        ctx.beginPath();
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          const t = p.life / p.max;
          const s = p.size * scale * (0.35 + t * 0.85);
          if (s < 2.2) {
            ctx.rect(p.x - s * 0.5, p.y - s * 0.5, s, s);
          } else {
            const r = s * 0.5;
            ctx.moveTo(p.x + r, p.y);
            ctx.arc(p.x, p.y, r, 0, TAU);
          }
        }
        ctx.fill();
      });
      ctx.restore();
    }
  }

  TD.Effects = Effects;
})(window);
