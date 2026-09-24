/* ============================================================
 * TrackVisualizer · 通用工具
 * 无依赖，挂载到 window.TD.util
 * ==========================================================*/
(function (global) {
  'use strict';
  const TD = (global.TD = global.TD || {});

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const _rgbCache = new Map();
  const _rgbaCache = new Map();

  function hexToRgb(hex) {
    if (typeof hex !== 'string') return { r: 255, g: 255, b: 255 };
    let h = hex.trim();
    let hit = _rgbCache.get(h);
    if (hit) return hit;
    if (h[0] === '#') h = h.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 8) h = h.slice(0, 6);
    let n = parseInt(h, 16);
    if (!isFinite(n)) n = 0xffffff;
    const rgb = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    if (_rgbCache.size > 512) _rgbCache.clear();
    _rgbCache.set(hex, rgb);
    return rgb;
  }

  /** 带缓存的颜色字符串，避免每帧产生大量垃圾 */
  function rgba(color, alpha) {
    const a = Math.max(0, Math.min(1, alpha));
    const key = color + '@' + (a * 1000 | 0);
    let hit = _rgbaCache.get(key);
    if (hit) return hit;
    const c = hexToRgb(color);
    const out = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (a * 1000 | 0) / 1000 + ')';
    if (_rgbaCache.size > 4096) _rgbaCache.clear();
    _rgbaCache.set(key, out);
    return out;
  }

  function shade(color, amount) {
    const c = hexToRgb(color);
    const f = (v) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount))));
    return '#' + [f(c.r), f(c.g), f(c.b)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  function midiToName(midi) {
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
  }

  function isBlackKey(midi) {
    return [1, 3, 6, 8, 10].indexOf(((midi % 12) + 12) % 12) >= 0;
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
  }

  function formatBytes(n) {
    if (!isFinite(n) || n <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
  }

  /** 追加一个圆角矩形子路径（不调用 beginPath，便于批量合批） */
  function addRoundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
    if (rr <= 0.2) {
      ctx.rect(x, y, w, h);
      return;
    }
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, rr);
      return;
    }
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.lineTo(x + rr, y + h);
    ctx.arcTo(x, y + h, x, y + h - rr, rr);
    ctx.lineTo(x, y + rr);
    ctx.arcTo(x, y, x + rr, y, rr);
    ctx.closePath();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    addRoundRect(ctx, x, y, w, h, r);
  }

  /** 在有序数组中查找第一个 >= value 的下标 */
  function lowerBound(arr, value, key) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const v = key ? key(arr[mid]) : arr[mid];
      if (v < value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function uid() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  /**
   * 小节数 → 秒。优先使用真实小节线时刻（变速时依然准确），
   * 超出已知范围再按平均小节长外推；支持小数小节（线性插值）。
   */
  function barsToSeconds(barTimes, avgBar, bars) {
    const avg = avgBar > 0 ? avgBar : 2;
    if (!barTimes || barTimes.length < 2) return bars * avg;
    const last = barTimes.length - 1;
    if (bars <= last) {
      const i = Math.floor(bars);
      const f = bars - i;
      if (f <= 1e-9) return barTimes[i];
      const next = (i + 1 <= last) ? barTimes[i + 1] : barTimes[last] + avg;
      return barTimes[i] + (next - barTimes[i]) * f;
    }
    return barTimes[last] + (bars - last) * avg;
  }

  /** 轨道偏移（秒）：正数整体后移，负数整体提前 */
  function trackOffsetSeconds(track) {
    const bars = track && track.offsetBars ? track.offsetBars : 0;
    if (!bars) return 0;
    return bars > 0
      ? barsToSeconds(track.barTimes, track.barSeconds, bars)
      : -barsToSeconds(track.barTimes, track.barSeconds, -bars);
  }

  TD.util = {
    NOTE_NAMES, hexToRgb, rgba, shade, midiToName, isBlackKey,
    clamp, lerp, rand, formatTime, formatBytes, roundRect, addRoundRect, lowerBound, uid,
    barsToSeconds, trackOffsetSeconds
  };
})(window);
