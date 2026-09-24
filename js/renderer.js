/* ============================================================
 * TrackVisualizer · 画布渲染器
 * 负责：背景 / 节拍网格 / 音高线 / note 飞行 / 命中判定与特效 /
 *       中央竖线 / 音名标签 / 常驻星空 / 浮动与拖影
 * 所有尺寸以 1080p 高度为基准做等比缩放，保证预览与导出观感一致。
 * ==========================================================*/
(function (global) {
  'use strict';
  const TD = (global.TD = global.TD || {});
  const util = TD.util;

  /** 计算布局（导出与预览共用同一套比例） */
  function computeLayout(state, W, H) {
    const st = state.settings;
    const s = H / 1080;
    const lineX = W * util.clamp(st.lineX, 5, 95) / 100;
    const usable = Math.max(W - lineX, W * 0.08);
    const pxPerSec = usable / Math.max(0.4, st.lookAhead);
    const pitchMin = state.pitch.min;
    const pitchMax = state.pitch.max;
    const span = Math.max(1, pitchMax - pitchMin + 1);
    const slotH = H / span;
    const noteH = Math.max(2 * s, slotH * util.clamp(st.noteHeightRatio, 0.1, 1.3));
    const noteY = function (midi) {
      return H - (midi - pitchMin + 1) * slotH + (slotH - noteH) * 0.5;
    };
    return { s, W, H, lineX, pxPerSec, pitchMin, pitchMax, span, slotH, noteH, noteY };
  }

  const LEVELS = 6;       // 透明度档位（用于合批）
  const LANE_FILL = 0.92; // 子声道内音符最多占用该比例，保证分层后互不接触
  const SEAM = 1.5;       // 相邻音符之间的接缝宽度（1080p 基准像素）
  const STAR_ALPHA = [0.13, 0.24, 0.40, 0.62];

  /** 浮动相位：让每个音符的摆动互不同步 */
  function floatPhase(note) {
    return note.midi * 0.28 + (note.trackIndex || 0) * 1.3;
  }

  /**
   * 浮动位移（像素）。两个不同频率的正弦叠加，避免看出周期感。
   * t 用于取「该时刻」的位移，拖影因此能画出弯曲的轨迹。
   */
  function bobAt(t, phase, noteTime, amp) {
    return (Math.sin(t * 1.7 + phase) * 0.65 +
      Math.sin(t * 0.63 + noteTime * 0.8) * 0.35) * amp;
  }

  /**
   * 计算某个音符实际的矩形位置（写入 out，避免每帧产生垃圾对象）。
   * 同音高的重叠音符会被分配到不同「子声道」，各自占据音高槽的一小条，
   * 这样多个音同时出现时不会互相遮挡。
   */
  function noteRect(L, note, out) {
    const lanes = note.lanes > 1 ? note.lanes : 1;
    const slotTop = L.H - (note.midi - L.pitchMin + 1) * L.slotH;
    if (lanes === 1) {
      out.y = slotTop + (L.slotH - L.noteH) * 0.5;
      out.h = L.noteH;
      return out;
    }
    const sub = L.slotH / lanes;
    const h = Math.min(L.noteH, sub * LANE_FILL);
    out.y = slotTop + (note.lane || 0) * sub + (sub - h) * 0.5;
    out.h = h;
    return out;
  }

  /**
   * 预处理：为同音高的重叠音符分配子声道，并标记需要画接缝的相邻音符。
   * 只有在真正发生重叠时才分层，单独出现的音符保持原高度。
   */
  function assignNoteLanes(notes, epsilon) {
    const eps = epsilon == null ? 1e-4 : epsilon;
    const JOIN = 0.012; // 间隔小于 12ms 视为紧邻，需要一条接缝来区分
    const byPitch = new Map();

    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      n.lane = 0;
      n.lanes = 1;
      n.seam = false;
      let arr = byPitch.get(n.midi);
      if (!arr) { arr = []; byPitch.set(n.midi, arr); }
      arr.push(n);
    }

    byPitch.forEach(function (list) {
      list.sort(function (a, b) { return a.time - b.time || a.duration - b.duration; });

      for (let i = 0; i + 1 < list.length; i++) {
        const end = list[i].time + list[i].duration;
        if (list[i + 1].time - end < JOIN) list[i].seam = true;
      }

      // 把互相重叠的音符聚成连通组，组内做区间着色
      let i = 0;
      while (i < list.length) {
        let j = i;
        let groupEnd = list[i].time + list[i].duration;
        while (j + 1 < list.length && list[j + 1].time < groupEnd - eps) {
          j++;
          const e = list[j].time + list[j].duration;
          if (e > groupEnd) groupEnd = e;
        }
        if (j > i) {
          const laneEnds = [];
          for (let k = i; k <= j; k++) {
            const n = list[k];
            let lane = 0;
            while (lane < laneEnds.length && laneEnds[lane] > n.time + eps) lane++;
            if (lane === laneEnds.length) laneEnds.push(0);
            laneEnds[lane] = n.time + n.duration;
            n.lane = lane;
          }
          const lanes = laneEnds.length;
          for (let k = i; k <= j; k++) list[k].lanes = lanes;
        }
        i = j + 1;
      }
    });
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.effects = new TD.Effects();
      this._halo = new Map();
      this._pool = [];          // 可见音符记录对象池
      this._vis = [];           // 本帧可见音符
      this._bucketMap = new Map();
      this._edgeMap = new Map();
      this._stars = null;       // 常驻星空
      this._starBatches = [[], [], [], []];
      this._starTime = 0;
      this._starKick = 0;
      this._rect = { y: 0, h: 0 };
      this._hitRect = { y: 0, h: 0 };
      this._now = 0;
      this.lastStats = { drawn: 0, hits: 0 };
      this._visibleCount = 0;
    }

    reset() {
      this.effects.reset();
    }

    /** 背景层缓存：纯色或纵向渐变 + 竖线中心辉光 */
    _bgLayer(state, W, H, L) {
      const st = state.settings;
      const key = W + 'x' + H + '|' + st.bgColor + '|' + st.bgColor2 + '|' + (st.bgGradient ? 1 : 0) +
        '|' + st.lineColor + '|' + Math.round(L.lineX) + '|' + (st.bgGlow ? 1 : 0);
      if (this._bgKey === key && this._bg) return this._bg;
      let c = this._bg;
      if (!c) c = this._bg = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      if (st.bgGradient) {
        const grad = g.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, st.bgColor);
        grad.addColorStop(1, st.bgColor2 || st.bgColor);
        g.fillStyle = grad;
      } else {
        g.fillStyle = st.bgColor;
      }
      g.fillRect(0, 0, W, H);
      if (st.bgGlow) {
        const grad = g.createRadialGradient(L.lineX, H * 0.5, 0, L.lineX, H * 0.5, Math.max(W, H) * 0.62);
        grad.addColorStop(0, util.rgba(st.lineColor, 0.10));
        grad.addColorStop(0.5, util.rgba(st.lineColor, 0.03));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
      this._bgKey = key;
      return c;
    }

    /** 暗角层缓存（带透明度，需要叠加在所有内容之上） */
    _vignetteLayer(W, H) {
      const key = W + 'x' + H;
      if (this._vigKey === key && this._vig) return this._vig;
      let c = this._vig;
      if (!c) c = this._vig = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      const grad = g.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.28, W * 0.5, H * 0.5, Math.max(W, H) * 0.78);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.72)');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
      this._vigKey = key;
      return c;
    }

    /** 生成 / 复用星空（坐标归一化，缩放窗口不会跳变） */
    _ensureStars(count) {
      if (this._stars && this._stars.length === count) return this._stars;
      const stars = new Array(count);
      for (let i = 0; i < count; i++) {
        stars[i] = {
          x: Math.random(),
          y: Math.random(),
          d: 0.35 + Math.random() * 0.65,   // 视差深度：越近越大越亮
          r: 0.7 + Math.random() * 1.7,     // 半径（1080p 基准）
          b: 0.35 + Math.random() * 0.65,   // 基础亮度
          p: Math.random() * Math.PI * 2,   // 闪烁相位
          f: 0.50 + Math.random() * 1.80    // 闪烁频率
        };
      }
      this._stars = stars;
      return stars;
    }

    /**
     * 常驻星空：多层视差缓慢左移 + 轻微闪烁。
     * 与播放状态无关（暂停时依旧漂浮），按亮度档位合批绘制。
     */
    _drawStars(ctx, st, W, H, s, lineX, dt) {
      const count = Math.round(st.starCount == null ? 160 : st.starCount);
      if (!st.starfield || count <= 0) return;
      const stars = this._ensureStars(count);
      const speed = (st.starSpeed || 0) * s;
      const sizeK = util.clamp(st.starSize == null ? 1 : st.starSize, 0.1, 4);
      const twk = util.clamp(st.starTwinkle == null ? 0.45 : st.starTwinkle, 0, 1);
      const color = st.starColor || '#ffffff';
      this._starTime += dt;
      this._starKick = Math.max(0, this._starKick - dt * 1.9);
      const t = this._starTime;
      const kick = this._starKick;
      const lineU = W > 0 ? lineX / W : 0.5;

      const b0 = this._starBatches[0], b1 = this._starBatches[1];
      const b2 = this._starBatches[2], b3 = this._starBatches[3];
      b0.length = b1.length = b2.length = b3.length = 0;

      for (let i = 0; i < stars.length; i++) {
        const star = stars[i];
        star.x -= speed * star.d * dt / Math.max(1, W);
        if (star.x < -0.02) { star.x += 1.04; star.y = Math.random(); }

        let b = star.b * (1 - twk + twk * (0.5 + 0.5 * Math.sin(t * star.f * 1.7 + star.p)));
        if (kick > 0.001) {
          const dd = Math.abs(star.x - lineU);
          if (dd < 0.12) b += kick * 0.5 * (1 - dd / 0.12);
        }
        const arr = b > 0.80 ? b3 : b > 0.55 ? b2 : b > 0.32 ? b1 : b0;
        arr.push(star.x * W, star.y * H, star.d * star.r * sizeK * s);
      }

      const TAU = Math.PI * 2;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let lvl = 0; lvl < 4; lvl++) {
        const arr = this._starBatches[lvl];
        if (!arr.length) continue;
        ctx.fillStyle = util.rgba(color, STAR_ALPHA[lvl]);
        ctx.beginPath();
        for (let k = 0; k < arr.length; k += 3) {
          const x = arr[k], y = arr[k + 1], r = arr[k + 2];
          if (r < 1.15) ctx.rect(x - r * 0.5, y - r * 0.5, r, r);
          else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
        }
        ctx.fill();
      }
      ctx.restore();
    }

    _haloSprite(color) {
      let c = this._halo.get(color);
      if (c) return c;
      const S = 128, pad = 30;
      c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d');
      g.fillStyle = color;
      g.strokeStyle = color;
      g.shadowColor = color;
      g.shadowBlur = 24;
      util.roundRect(g, pad, pad, S - pad * 2, S - pad * 2, 16);
      g.fill();
      g.fill();
      if (this._halo.size > 64) this._halo.clear();
      this._halo.set(color, c);
      return c;
    }

    /**
     * @param {Object} state { time, notes, tracks, settings, pitch, beats, beatsPerBar, maxDuration }
     * @param {number} dt 视觉帧间隔（秒），用于特效推进
     */
    render(state, dt) {
      const ctx = this.ctx;
      const W = this.canvas.width, H = this.canvas.height;
      const st = state.settings;
      const L = computeLayout(state, W, H);
      const s = L.s;
      const now = state.time;
      this._now = now;
      const stats = { drawn: 0, hits: 0 };

      // ---------- 特效推进 ----------
      this.effects.update(dt > 0 ? dt : 0);

      // ---------- 背景 ----------
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      // 背景层（渐变 + 中心辉光）与暗角层都做了缓存，
      // 避免每帧重新计算全屏渐变——4K 导出时这是决定性的优化。
      const trail = util.clamp(st.trail || 0, 0, 0.92);
      const bgLayer = this._bgLayer(state, W, H, L);
      if (trail > 0.01) {
        ctx.fillStyle = util.rgba(st.bgColor2 || st.bgColor, 1 - trail);
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = trail;
        ctx.drawImage(bgLayer, 0, 0);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(bgLayer, 0, 0);
      }

      // ---------- 常驻星空（画在背景之上、抖动之前） ----------
      this._drawStars(ctx, st, W, H, s, L.lineX, dt > 0 ? dt : 0);

      // 屏幕抖动
      const shakeAmp = this.effects.shake * (st.shake || 0) * 0.1 * s;
      if (shakeAmp > 0.05) {
        ctx.translate((Math.random() - 0.5) * shakeAmp, (Math.random() - 0.5) * shakeAmp);
      }

      // ---------- 节拍网格 ----------
      if (st.showGrid && state.beats && state.beats.length) {
        const beats = state.beats;
        const perBar = Math.max(1, state.beatsPerBar || 4);
        const gridBehind = (L.lineX + 40 * s) / L.pxPerSec;
        const i0 = Math.max(0, util.lowerBound(beats, now - gridBehind) - 1);
        const iEnd = util.lowerBound(beats, now + st.lookAhead * 1.15);
        const lw1 = Math.max(1, 1 * s);
        // 先合批画拍线，再合批画小节线，各自一次 stroke
        ctx.strokeStyle = util.rgba(st.gridColor, 0.22);
        ctx.lineWidth = lw1;
        ctx.beginPath();
        for (let i = i0; i < iEnd && i < beats.length; i++) {
          if ((i % perBar) === 0) continue;
          const x = L.lineX + (beats[i] - now) * L.pxPerSec;
          if (x < -2 || x > W + 2) continue;
          const px = Math.round(x) + 0.5;
          ctx.moveTo(px, 0);
          ctx.lineTo(px, H);
        }
        ctx.stroke();

        ctx.strokeStyle = util.rgba(st.gridBarColor, 0.5);
        ctx.lineWidth = lw1 * 1.4;
        ctx.beginPath();
        for (let i = i0; i < iEnd && i < beats.length; i++) {
          if ((i % perBar) !== 0) continue;
          const x = L.lineX + (beats[i] - now) * L.pxPerSec;
          if (x < -2 || x > W + 2) continue;
          const px = Math.round(x) + 0.5;
          ctx.moveTo(px, 0);
          ctx.lineTo(px, H);
        }
        ctx.stroke();
      }

      // ---------- 八度分隔线 + 音名 ----------
      if (st.showOctaveLines || st.showNoteLabels) {
        const startMidi = Math.ceil(L.pitchMin / 12) * 12;
        if (st.showOctaveLines) {
          ctx.strokeStyle = util.rgba(st.octaveLineColor, 0.3);
          ctx.lineWidth = Math.max(1, 1 * s);
          ctx.beginPath();
          for (let m = startMidi; m <= L.pitchMax; m += 12) {
            const y = L.noteY(m) + L.noteH * 0.5;
            if (y < -6 || y > H + 6) continue;
            ctx.moveTo(0, Math.round(y) + 0.5);
            ctx.lineTo(W, Math.round(y) + 0.5);
          }
          ctx.stroke();
        }
        if (st.showNoteLabels) {
          ctx.fillStyle = util.rgba(st.labelColor, 0.45);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.font = (11 * s).toFixed(1) + 'px ui-monospace, SFMono-Regular, Menlo, monospace';
          for (let m = startMidi; m <= L.pitchMax; m += 12) {
            const y = L.noteY(m) + L.noteH * 0.5;
            if (y < -6 || y > H + 6) continue;
            ctx.fillText(util.midiToName(m), 8 * s, y);
          }
        }
      }

      // ---------- note ----------
      const notes = state.notes;
      const tracks = state.tracks;
      const pad = 120 * s;
      const lookBehind = (L.lineX + pad) / L.pxPerSec + state.maxDuration;
      const lookAhead = st.lookAhead * 1.05;
      const i0 = util.lowerBound(notes, now - lookBehind, function (n) { return n.time; });
      const grow = Math.max(6 * s, 16 * s * (st.noteGlow || 0));
      const radius = st.noteRadius * s;
      const baseAlpha = util.clamp(st.noteOpacity, 0.05, 1);
      const fadeSpan = L.lineX + pad;
      // 浮动参数（每帧只算一次）
      const floatAmp = Math.max(0, st.floatAmount || 0) * 0.9 * s;
      const floatBreath = !!st.floatBreath;
      const floatKick = !!st.floatKick;

      /* ---- 第一步：收集可见音符（对象池复用，避免每帧 GC） ---- */
      const pool = this._pool;
      const vis = this._vis;
      vis.length = 0;
      let vn = 0;
      const rect = this._rect;

      for (let i = i0; i < notes.length; i++) {
        const n = notes[i];
        if (n.time > now + lookAhead) break;
        const x = L.lineX + (n.time - now) * L.pxPerSec;
        if (x > W + pad) break;
        let w = Math.max(n.duration * L.pxPerSec, 2.5 * s);
        // 与后一个同音高音符紧邻时留一道接缝，避免连成一个长条
        if (n.seam) w = Math.max(w - SEAM * s, 2 * s);
        if (x + w < -pad) continue;

        const tr = tracks[n.trackIndex];
        if (!tr || tr.visible === false) continue;

        // ---- 几何：基础位置 + 漂浮 + 呼吸 + 命中回弹 ----
        noteRect(L, n, rect);
        let y = rect.y;
        let h = rect.h;
        let bob = 0;
        const ph = floatPhase(n);
        if (floatAmp > 0) {
          bob = bobAt(now, ph, n.time, floatAmp);
          y += bob;
          if (floatBreath) {
            const bh = h * (1 + Math.sin(now * 2.1 + ph) * (st.floatAmount || 0) * 0.02);
            y -= (bh - h) * 0.5;
            h = bh;
          }
        }
        if (floatKick && n.kickAt != null) {
          const kk = 1 - (now - n.kickAt) / 0.5;
          if (kk > 0) {
            const e = kk * kk;
            y += (n.kickDir || 0) * e * floatAmp * 1.7;
            h *= 1 + e * 0.45;
          } else {
            n.kickAt = null;
          }
        }

        // ---- 命中判定（用实际绘制位置触发特效） ----
        if (n.time > now) {
          n.hit = false;
        } else if (!n.hit && now < n.time + 0.6) {
          n.hit = true;
          n.hitAt = now;
          stats.hits++;
          this._onHit(state, L, n, tr, y, h);
        }

        let alpha = baseAlpha;
        // 越过竖线后淡出
        if (n.time < now) {
          if (st.fadeAfterHit) {
            alpha *= util.clamp(1 - (now - n.time) * L.pxPerSec / fadeSpan, 0.05, 1);
          } else {
            alpha *= 0.92;
          }
        }
        if (alpha <= 0.02) continue;

        let rec = pool[vn];
        if (!rec) rec = pool[vn] = {};
        vn++;
        rec.x = x;
        rec.y = y;
        rec.w = w;
        rec.h = h;
        rec.ti = n.trackIndex;
        rec.level = Math.max(1, Math.min(LEVELS, Math.round(alpha * LEVELS)));
        rec.ph = ph;
        rec.nt = n.time;
        rec.bob = bob;
        rec.note = n;
        vis.push(rec);
      }
      stats.drawn = vn;
      this._visibleCount = vn;

      /* ---- 第二步：光晕（高密度时抽样绘制，保证帧率） ---- */
      if (st.noteGlow > 0.01 && vn) {
        const haloStep = vn > 1100 ? Math.ceil(vn / 1100) : 1;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < vn; i += haloStep) {
          const r = vis[i];
          const halo = this._haloSprite(tracks[r.ti].color);
          ctx.globalAlpha = util.clamp(0.5 * st.noteGlow * (r.level / LEVELS), 0, 1);
          ctx.drawImage(halo, r.x - grow, r.y - grow * 0.55, r.w + grow * 2, r.h + grow * 1.1);
        }
        ctx.restore();
      }

      /* ---- 第三步：本体（按 轨道 × 透明度档位 合批，一次 fill 画一批） ---- */
      // 同屏音符极多时省掉拖影：它会让矩形数量翻数倍，收益却几乎看不见
      let trailCount = Math.max(0, Math.min(4, Math.round(st.floatTrail || 0)));
      if (vn > 1500) trailCount = 0;
      else if (vn > 800) trailCount = Math.min(trailCount, 1);
      const buckets = this._bucketMap;
      buckets.clear();
      const bucketFor = function (ti, level) {
        const key = (ti << 3) | level;
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        return arr;
      };
      // 拖影先入桶：它们在更低的透明度档位，先画才不会盖住本体
      if (trailCount > 0 && vn) {
        const TRAIL_DT = 0.055;
        const TRAIL_GAP = 3.6 * s;
        for (let i = 0; i < vn; i++) {
          const r = vis[i];
          for (let g = trailCount; g >= 1; g--) {
            const lvl = Math.max(1, r.level - g * 2);
            let gy = r.y;
            if (floatAmp > 0) {
              gy += bobAt(now - g * TRAIL_DT, r.ph, r.nt, floatAmp) - r.bob;
            }
            bucketFor(r.ti, lvl).push({ x: r.x + g * TRAIL_GAP, y: gy, w: r.w, h: r.h });
          }
        }
      }
      for (let i = 0; i < vn; i++) {
        const r = vis[i];
        bucketFor(r.ti, r.level).push(r);
      }
      ctx.globalAlpha = 1;
      buckets.forEach(function (arr, key) {
        const tr = tracks[key >> 3];
        if (!tr) return;
        ctx.fillStyle = util.rgba(tr.color, (key & 7) / LEVELS);
        ctx.beginPath();
        for (let k = 0; k < arr.length; k++) {
          const r = arr[k];
          util.addRoundRect(ctx, r.x, r.y, r.w, r.h, radius);
        }
        ctx.fill();
      });

      /* ---- 第四步：细节高光（数量多时自动省略） ---- */
      if (vn <= 1800) {
        // 顶部高光
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < vn; i++) {
          const r = vis[i];
          if (r.h <= 4 * s || r.w <= 3 * s) continue;
          util.addRoundRect(ctx, r.x + 1 * s, r.y + 1 * s, r.w - 2 * s, Math.max(1, r.h * 0.32), radius * 0.8);
          any = true;
        }
        if (any) ctx.fill();

        // 前沿高亮：按轨道合批
        const edges = this._edgeMap;
        edges.clear();
        for (let i = 0; i < vn; i++) {
          const r = vis[i];
          if (r.w <= 3 * s) continue;
          let arr = edges.get(r.ti);
          if (!arr) { arr = []; edges.set(r.ti, arr); }
          arr.push(r);
        }
        edges.forEach(function (arr, ti) {
          const tr = tracks[ti];
          if (!tr) return;
          ctx.fillStyle = util.rgba(util.shade(tr.color, 0.65), 0.9);
          ctx.beginPath();
          for (let k = 0; k < arr.length; k++) {
            const r = arr[k];
            const edge = Math.max(1.2 * s, Math.min(4 * s, r.w * 0.08));
            util.addRoundRect(ctx, r.x + r.w - edge, r.y, edge, r.h, Math.min(radius, edge * 0.5));
          }
          ctx.fill();
        });
      }

      /* ---- 第五步：刚命中音符的瞬时增亮 ---- */
      const flashK = st.flashStrength == null ? 1 : st.flashStrength;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < vn; i++) {
        const r = vis[i];
        const n = r.note;
        if (!n.hit || n.hitAt == null) continue;
        const k = util.clamp(1 - (now - n.hitAt) / 0.28, 0, 1);
        if (k <= 0.01) continue;
        const tr = tracks[r.ti];
        ctx.globalAlpha = k * 0.75 * flashK;
        ctx.fillStyle = util.rgba(util.shade(tr.color, 0.5), 1);
        util.roundRect(ctx, r.x - 2 * s, r.y - 2 * s, r.w + 4 * s, r.h + 4 * s, radius + 2 * s);
        ctx.fill();
      }
      ctx.restore();
      ctx.globalAlpha = 1;

      // ---------- 粒子 / 冲击波 ----------
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.effects.draw(ctx, s);

      // ---------- 中央竖线 ----------
      const flash = this.effects.flash;
      const lw = Math.max(1, st.lineWidth * s);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const glowW = lw * (2.5 + flash * 3);
      ctx.fillStyle = util.rgba(st.lineColor, util.clamp(0.10 + flash * 0.16, 0, 0.6));
      ctx.fillRect(L.lineX - glowW * 0.5, 0, glowW, H);
      ctx.fillStyle = util.rgba(st.lineColor, util.clamp(0.35 + flash * 0.3, 0, 1));
      ctx.fillRect(L.lineX - lw * 1.5, 0, lw * 3, H);
      ctx.fillStyle = util.rgba(util.shade(st.lineColor, 0.75), util.clamp(0.75 + flash * 0.25, 0, 1));
      ctx.fillRect(L.lineX - lw * 0.5, 0, lw, H);
      if (flash > 0.01) {
        ctx.fillStyle = util.rgba('#ffffff', util.clamp(flash * 0.35, 0, 0.85));
        ctx.fillRect(L.lineX - lw * 1.2, 0, lw * 2.4, H);
      }
      ctx.restore();

      // 竖线顶端三角指示
      ctx.fillStyle = util.rgba(st.lineColor, 0.9);
      ctx.beginPath();
      ctx.moveTo(L.lineX, 14 * s);
      ctx.lineTo(L.lineX - 7 * s, 2 * s);
      ctx.lineTo(L.lineX + 7 * s, 2 * s);
      ctx.closePath();
      ctx.fill();

      // ---------- 暗角 ----------
      if (st.vignette) {
        ctx.drawImage(this._vignetteLayer(W, H), 0, 0);
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      this.lastStats = stats;
      return { layout: L, stats: stats };
    }

    /** 命中时的特效组合 */
    _onHit(state, L, note, track, y, h) {
      const st = state.settings;
      const fAmp = Math.max(0, st.floatAmount || 0);
      // 命中回弹：给音符一个随机的垂直反冲，再由绘制循环衰减
      if (st.floatKick && fAmp > 0) {
        note.kickAt = this._now;
        note.kickDir = (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.8);
      }
      if (!st.fxEnabled) return;
      const x = L.lineX;
      let cy = y;
      if (cy == null) {
        const fallback = noteRect(L, note, this._hitRect);
        cy = fallback.y;
        h = fallback.h;
      }
      const s = L.s;
      const color = track.color;
      const vel = note.velocity == null ? 0.8 : note.velocity;
      const power = 0.55 + vel * 0.75;
      const cyy = cy + (h || 0) * 0.5;

      this.effects.addFlash(0.5 * power * (st.flashStrength == null ? 1 : st.flashStrength));
      this._starKick = Math.min(1, this._starKick + 0.32); // 竖线附近的星星被点亮一下

      if (st.particleCount > 0) {
        // 粒子预算：同屏音符极多时自动收敛，避免拖垮帧率
        const cap = this._visibleCount > 1200 ? 900 : 2600;
        const budget = Math.max(0, cap - this.effects.particles.length);
        let count = Math.round(st.particleCount * (0.6 + vel * 0.8));
        count = Math.min(count, Math.ceil(budget / 3));
        if (count > 0) {
          // 主爆散：沿左侧扇形喷出（与飞行方向一致）
          this.effects.burst(x, cyy, color, {
            count: count,
            speed: st.particleSpeed * s * power,
            spread: Math.PI * 0.85,
            angle: Math.PI,
            life: st.particleLife * (0.8 + Math.random() * 0.5),
            size: st.particleSize * s * (0.7 + note.velocity * 0.7),
            gravity: 260 * s,
            drag: 2.6
          });
          // 少量向上/下的火花，增加层次
          this.effects.burst(x, cyy, util.shade(color, 0.5), {
            count: Math.max(1, Math.round(count * 0.22)),
            speed: st.particleSpeed * s * power * 0.55,
            spread: Math.PI * 1.1,
            angle: -Math.PI / 2,
            life: st.particleLife * 0.8,
            size: st.particleSize * s * 0.8,
            gravity: 620 * s,
            drag: 1.6
          });
        }
      }

      if (st.shockwave) {
        this.effects.ring(x, cyy, color, {
          maxRadius: (60 + 160 * vel) * s * util.clamp(st.shockwaveSize || 1, 0.3, 2.5),
          life: 0.42,
          width: 3.5 * s,
          startRadius: 3 * s
        });
      }
      if (st.shake > 0) this.effects.addShake(power * st.shake * 6);
    }
  }

  TD.computeLayout = computeLayout;
  TD.assignNoteLanes = assignNoteLanes;
  TD.noteRect = noteRect;
  TD.Renderer = Renderer;
})(window);
