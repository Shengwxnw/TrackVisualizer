/* ============================================================
 * TrackVisualizer · 音频引擎
 * 两条音源：内置合成器（振荡器）+ 导入音频（AudioBufferSourceNode）
 * 两者共用一个时间基准，因此彼此之间是采样级对齐的。
 *
 * 信号路由：
 *   synthGain ─┐
 *              ├→ master(音量) → compressor ─┬→ monitorGain → 扬声器
 *   clipGain ──┘                             └→ recordDest  → 视频导出混音
 * 监听静音只影响扬声器，不影响录制结果。
 * ==========================================================*/
(function (global) {
  'use strict';
  const TD = (global.TD = global.TD || {});
  const util = TD.util;

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.monitorGain = null;
      this.compressor = null;
      this.recordDest = null;
      this.synthGain = null;
      this.clipGain = null;

      this.voices = [];        // 合成器发声单元
      this.sources = [];       // 正在播放的导入音频
      this.clips = [];         // {buffer, offset, volume, mute}
      this.notes = [];
      this.cursor = 0;

      this.playing = false;
      this.startPos = 0;
      this.startCtxTime = 0;
      this.speed = 1;
      this.lookahead = 0.35;
      this._timer = null;

      this._volume = 0.7;
      this.synthEnabled = true;
      this.monitor = true;
      this.waveType = 'triangle';
      this.octaveShift = 0;
      this.trackProvider = null;
      this.maxVoices = 96;
    }

    get supported() {
      return typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined';
    }

    ensure() {
      if (this.ctx) return this.ctx;
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('当前浏览器不支持 WebAudio');
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;

      const master = ctx.createGain();
      master.gain.value = this._volume;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10;
      comp.knee.value = 20;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;

      const monitor = ctx.createGain();
      monitor.gain.value = this.monitor ? 1 : 0;

      const synthGain = ctx.createGain();
      synthGain.gain.value = 1;
      const clipGain = ctx.createGain();
      clipGain.gain.value = 1;

      synthGain.connect(master);
      clipGain.connect(master);
      master.connect(comp);
      comp.connect(monitor);
      monitor.connect(ctx.destination);

      if (ctx.createMediaStreamDestination) {
        this.recordDest = ctx.createMediaStreamDestination();
        comp.connect(this.recordDest);
      }

      this.master = master;
      this.compressor = comp;
      this.monitorGain = monitor;
      this.synthGain = synthGain;
      this.clipGain = clipGain;
      return ctx;
    }

    resume() {
      const ctx = this.ensure();
      if (ctx.state === 'suspended') return ctx.resume();
      return Promise.resolve();
    }

    /** 解码音频文件为 AudioBuffer */
    decode(arrayBuffer) {
      const ctx = this.ensure();
      return new Promise(function (resolve, reject) {
        let settled = false;
        const ok = function (buf) { if (!settled) { settled = true; resolve(buf); } };
        const fail = function (err) { if (!settled) { settled = true; reject(err || new Error('音频解码失败')); } };
        try {
          const ret = ctx.decodeAudioData(arrayBuffer, ok, fail);
          if (ret && typeof ret.then === 'function') ret.then(ok, fail);
        } catch (e) {
          fail(e);
        }
      });
    }

    get currentTime() {
      return this.ctx ? this.ctx.currentTime : 0;
    }

    setVolume(v) {
      this._volume = util.clamp(v, 0, 1.5);
      if (this.master) this.master.gain.value = this._volume;
    }

    /** 监听开关（导出不受影响） */
    setMonitor(on) {
      this.monitor = !!on;
      if (this.monitorGain) this.monitorGain.gain.value = this.monitor ? 1 : 0;
    }

    getRecordStream() {
      this.ensure();
      return this.recordDest ? this.recordDest.stream : null;
    }

    /**
     * 开始播放（合成器与导入音频共用同一起点）
     * @param {Object} o {notes, clips, fromTime, speed, synthEnabled, waveType, octaveShift, trackProvider}
     */
    start(o) {
      o = o || {};
      if (!this.supported) return;
      const ctx = this.ensure();
      if (ctx.state === 'suspended') ctx.resume();

      this.stopVoices();
      this.stopClips();

      this.notes = o.notes || [];
      this.clips = o.clips || [];
      this.speed = o.speed > 0 ? o.speed : 1;
      this.waveType = o.waveType || this.waveType;
      this.octaveShift = o.octaveShift || 0;
      this.trackProvider = o.trackProvider || this.trackProvider;
      this.synthEnabled = o.synthEnabled !== false;
      this.startPos = o.fromTime > 0 ? o.fromTime : 0;
      this.startCtxTime = ctx.currentTime + 0.06;
      this.cursor = util.lowerBound(this.notes, this.startPos - 0.001, function (n) { return n.time; });
      this.playing = true;

      this._startClips();

      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this.synthEnabled && this.notes.length) {
        const self = this;
        this._tick();
        this._timer = setInterval(function () { self._tick(); }, 40);
      }
    }

    stop() {
      this.playing = false;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      this.stopVoices();
      this.stopClips();
    }

    /* ---------------- 导入音频 ---------------- */

    _startClips() {
      const ctx = this.ctx;
      if (!ctx || !this.clips.length) return;
      const from = this.startPos;
      const speed = this.speed;
      const self = this;

      for (let i = 0; i < this.clips.length; i++) {
        const clip = this.clips[i];
        if (!clip || clip.mute || !clip.buffer) continue;
        const off = clip.offset || 0;            // 音频内部 0 秒对应的曲目时间
        const dur = clip.buffer.duration;
        if (from >= off + dur) continue;         // 已经播放结束

        const into = Math.max(0, from - off);    // 从缓冲区第几秒开始
        // 以 speed 倍速播放时，曲目时间与音频内部时间以相同速率推进，
        // 所以「曲目 t 时刻」永远对应「音频 t - offset」，无需额外换算。
        const when = from < off
          ? self.startCtxTime + (off - from) / speed
          : ctx.currentTime;

        const src = ctx.createBufferSource();
        src.buffer = clip.buffer;
        src.playbackRate.value = speed;

        const gain = ctx.createGain();
        gain.gain.value = clip.volume == null ? 1 : clip.volume;

        src.connect(gain);
        gain.connect(this.clipGain);
        try { src.start(when, into); } catch (e) { continue; }

        this.sources.push(src);
        src.onended = function () {
          const idx = self.sources.indexOf(src);
          if (idx >= 0) self.sources.splice(idx, 1);
          try { gain.disconnect(); } catch (e) { /* noop */ }
        };
      }
    }

    stopClips() {
      for (let i = 0; i < this.sources.length; i++) {
        try {
          this.sources[i].onended = null;
          this.sources[i].stop();
        } catch (e) { /* 未开始或已结束 */ }
      }
      this.sources.length = 0;
    }

    /* ---------------- 内置合成器 ---------------- */

    stopVoices() {
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        try {
          const t = this.ctx.currentTime;
          v.gain.gain.cancelScheduledValues(t);
          v.gain.gain.setTargetAtTime(0, t, 0.008);
          v.osc.stop(t + 0.05);
        } catch (e) { /* 已停止 */ }
      }
      this.voices.length = 0;
    }

    /** 返回当前音频时钟对应的曲目位置（秒） */
    getPosition() {
      if (!this.playing || !this.ctx) return this.startPos;
      // 调度提前量（startCtxTime 在未来 60ms）属于预热期，
      // 这段时间时间轴停在起点，否则开头会倒退 60ms。
      const t = this.startPos + (this.ctx.currentTime - this.startCtxTime) * this.speed;
      return t > this.startPos ? t : this.startPos;
    }

    _tick() {
      if (!this.playing || !this.ctx || !this.synthEnabled) return;
      const ctx = this.ctx;
      const horizon = ctx.currentTime + this.lookahead;
      const tracks = this.trackProvider ? this.trackProvider() : null;
      let guard = 0;
      while (this.cursor < this.notes.length && guard++ < 900) {
        const note = this.notes[this.cursor];
        const when = this.startCtxTime + (note.time - this.startPos) / this.speed;
        if (when > horizon) break;
        this.cursor++;
        const tr = tracks && tracks[note.trackIndex];
        if (tr && tr.mute) continue;
        if (when < ctx.currentTime - 0.02) continue; // 已错过
        this._playNote(note, when, tr);
      }
    }

    _playNote(note, when, tr) {
      const ctx = this.ctx;
      if (this.voices.length >= this.maxVoices) {
        const old = this.voices.shift();
        try {
          old.gain.gain.cancelScheduledValues(ctx.currentTime);
          old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
          old.osc.stop(ctx.currentTime + 0.04);
        } catch (e) { /* noop */ }
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = this.waveType;
      const midi = util.clamp(note.midi + this.octaveShift * 12, 0, 127);
      osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);

      const vel = util.clamp(note.velocity == null ? 0.8 : note.velocity, 0.05, 1);
      const trackVol = tr && tr.volume != null ? tr.volume : 1;
      const peak = 0.16 * vel * trackVol;
      const dur = Math.max(note.duration / this.speed, 0.06);
      const atk = Math.min(0.012, dur * 0.25);
      const rel = Math.min(0.18, dur * 0.6);

      const g = gain.gain;
      g.setValueAtTime(0.0001, when);
      g.linearRampToValueAtTime(peak, when + atk);
      g.setTargetAtTime(peak * 0.55, when + atk, Math.max(0.02, dur * 0.25));
      g.setTargetAtTime(0.0001, when + Math.max(atk + 0.01, dur - rel), Math.max(0.01, rel * 0.4));

      osc.connect(gain);
      gain.connect(this.synthGain);
      osc.start(when);
      osc.stop(when + dur + 0.12);

      const voice = { osc: osc, gain: gain };
      this.voices.push(voice);
      const self = this;
      osc.onended = function () {
        try { gain.disconnect(); } catch (e) { /* noop */ }
        const idx = self.voices.indexOf(voice);
        if (idx >= 0) self.voices.splice(idx, 1);
      };
    }
  }

  TD.AudioEngine = AudioEngine;
})(window);
