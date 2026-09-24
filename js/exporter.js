/* ============================================================
 * TrackVisualizer · 视频导出
 * 使用离屏画布以目标分辨率离线渲染 + MediaRecorder 实时录制，
 * 可同时混入内置合成器音频。
 * 支持 MP4(H.264) / WebM(VP9/VP8)，按浏览器能力自动选择。
 * ==========================================================*/
(function (global) {
  'use strict';
  const TD = (global.TD = global.TD || {});

  const MIME_CANDIDATES = [
    { mime: 'video/mp4;codecs=avc1.4d002a,mp4a.40.2', label: 'MP4 (H.264 + AAC)', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', label: 'MP4 (H.264 + AAC)', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.42E01E', label: 'MP4 (H.264)', ext: 'mp4' },
    { mime: 'video/mp4', label: 'MP4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', label: 'WebM (VP9 + Opus)', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', label: 'WebM (VP8 + Opus)', ext: 'webm' },
    { mime: 'video/webm', label: 'WebM', ext: 'webm' }
  ];

  function isSupported(mime) {
    try {
      return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
    } catch (e) {
      return false;
    }
  }

  function listSupported() {
    const out = [];
    for (let i = 0; i < MIME_CANDIDATES.length; i++) {
      if (isSupported(MIME_CANDIDATES[i].mime)) out.push(MIME_CANDIDATES[i]);
    }
    return out;
  }

  function pickMime(prefer) {
    const all = listSupported();
    if (!all.length) return null;
    if (prefer === 'mp4') {
      const mp4 = all.find(function (m) { return m.ext === 'mp4'; });
      if (mp4) return mp4;
    }
    if (prefer === 'webm') {
      const webm = all.find(function (m) { return m.ext === 'webm'; });
      if (webm) return webm;
    }
    return all[0];
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 4000);
  }

  /**
   * @param {Object} o
   *   state        应用状态（{notes, tracks, settings, pitch, beats, beatsPerBar, maxDuration}）
   *   width/height 导出分辨率
   *   fps          帧率
   *   bitrate      视频码率 bps
   *   startTime/endTime 导出区间（秒）
   *   speed        倍速
   *   audio        AudioEngine 实例或 null
   *   includeAudio 是否混入音频
   *   mirrorCanvas 用于同步显示导出画面（可选）
   *   onProgress(ratio, info)
   *   isCancelled() => bool
   */
  async function exportVideo(o) {
    if (typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持 MediaRecorder，无法导出视频');
    const picked = pickMime(o.format);
    if (!picked) throw new Error('当前浏览器没有可用的视频录制编码器');

    const W = Math.round(o.width), H = Math.round(o.height);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const renderer = new TD.Renderer(canvas);
    renderer.reset();

    const startTime = Math.max(0, o.startTime || 0);
    const endTime = Math.max(startTime + 0.05, o.endTime || o.state.duration || 1);
    const speed = o.speed > 0 ? o.speed : 1;
    const prevTime = o.state.time;

    // 复位命中状态，让导出过程中特效正常触发
    const notes = o.state.notes;
    for (let i = 0; i < notes.length; i++) notes[i].hit = false;

    /* ---- 预热：先把光晕贴图、背景层、星空数组、JIT 全部跑热 ----
       否则前若干帧会明显偏慢，录进去就是开头一段卡顿。 */
    const PREROLL_FRAMES = 10;
    o.state.time = startTime;
    for (let i = 0; i < PREROLL_FRAMES; i++) {
      renderer.render(o.state, 1 / o.fps);
    }

    const stream = canvas.captureStream(o.fps);
    let audioAttached = false;
    const plan = o.audioOpts || {};
    const wantSynth = plan.synthEnabled !== false;
    const wantClips = (plan.clips || []).length > 0;
    const needAudio = o.includeAudio && (wantSynth || wantClips);
    if (needAudio && o.audio && o.audio.supported) {
      try {
        o.audio.ensure();
        const as = o.audio.getRecordStream();
        if (as) {
          const tracks = as.getAudioTracks();
          for (let i = 0; i < tracks.length; i++) { stream.addTrack(tracks[i]); audioAttached = true; }
        }
      } catch (e) { audioAttached = false; }
    }

    const recOpts = { mimeType: picked.mime };
    if (o.bitrate) recOpts.videoBitsPerSecond = Math.round(o.bitrate);
    if (audioAttached) recOpts.audioBitsPerSecond = 128000;

    let recorder;
    try {
      recorder = new MediaRecorder(stream, recOpts);
    } catch (e) {
      recorder = new MediaRecorder(stream);
    }

    const chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };

    const stopped = new Promise(function (resolve, reject) {
      recorder.onstop = function () { resolve(); };
      recorder.onerror = function (e) { reject(e && e.error ? e.error : new Error('录制失败')); };
    });

    recorder.start(400);

    const mctx = o.mirrorCanvas ? o.mirrorCanvas.getContext('2d') : null;
    let cancelled = false;
    let virtual = startTime;
    let last = performance.now();
    const wallStart = last;
    /* 编码器预热窗口：录制已经开始，但时间轴先按住不动。
       这段静止画面落在开头的留白区里，不影响内容，却能让编码器进入状态。 */
    const WARMUP_MS = o.encoderWarmup == null ? 350 : o.encoderWarmup;
    let running = WARMUP_MS <= 0;
    let audioStarted = false;

    // 帧健康度统计：用来定位掉帧发生在导出的哪一段
    const perf = { frames: 0, slow: 0, maxDt: 0, warmupMs: WARMUP_MS, slowSpots: [] };
    const frameBudget = 1.5 / o.fps;

    const startAudioAt = function (t) {
      if (audioStarted) return;
      audioStarted = true;
      if (needAudio && o.audio && o.audio.supported) {
        o.audio.start({
          notes: wantSynth ? notes : [],
          clips: wantClips ? plan.clips : [],
          fromTime: t,
          speed: speed,
          synthEnabled: wantSynth,
          waveType: plan.waveType,
          octaveShift: plan.octaveShift,
          trackProvider: plan.trackProvider
        });
      }
    };
    if (running) startAudioAt(startTime);

    await new Promise(function (resolve) {
      function loop(now) {
        if (o.isCancelled && o.isCancelled()) { cancelled = true; return resolve(); }
        let dt = (now - last) / 1000;
        last = now;
        if (dt > 0.35) dt = 0.35; // 卡顿保护

        if (!running) {
          // 预热阶段：时间轴按住，只出静止帧
          if (now - wallStart >= WARMUP_MS) {
            running = true;
            startAudioAt(startTime);
          }
        } else if (needAudio && o.audio && o.audio.playing) {
          // 以音频时钟为准，保证画面与声音严格对齐
          virtual = o.audio.getPosition();
        } else {
          virtual += dt * speed;
        }
        if (virtual > endTime) virtual = endTime;

        perf.frames++;
        if (dt > perf.maxDt) perf.maxDt = dt;
        if (running && dt > frameBudget) {
          perf.slow++;
          if (perf.slowSpots.length < 24) {
            perf.slowSpots.push({ at: +(virtual - startTime).toFixed(2), ms: Math.round(dt * 1000) });
          }
        }

        o.state.time = virtual;
        renderer.render(o.state, dt);

        if (mctx) {
          try {
            mctx.setTransform(1, 0, 0, 1, 0, 0);
            mctx.drawImage(canvas, 0, 0, o.mirrorCanvas.width, o.mirrorCanvas.height);
          } catch (e) { /* noop */ }
        }

        const ratio = (virtual - startTime) / (endTime - startTime);
        if (o.onProgress) {
          const elapsed = (now - wallStart) / 1000;
          o.onProgress(Math.min(1, ratio), {
            elapsed: elapsed,
            remaining: ratio > 0.01 ? elapsed / ratio - elapsed : 0,
            time: virtual
          });
        }

        if (virtual >= endTime - 1e-6) return resolve();
        requestAnimationFrame(loop);
      }
      requestAnimationFrame(loop);
    });

    if (o.audio && o.audio.playing) o.audio.stop();

    try { recorder.stop(); } catch (e) { /* noop */ }
    await stopped;
    o.state.time = prevTime;

    const tracks = stream.getTracks();
    for (let i = 0; i < tracks.length; i++) { try { tracks[i].stop(); } catch (e) { /* noop */ } }

    if (cancelled) return { cancelled: true, chunks: chunks.length, mimeType: picked.mime };

    const blob = new Blob(chunks, { type: picked.mime.split(';')[0] });
    return {
      cancelled: false,
      blob: blob,
      mimeType: picked.mime,
      ext: picked.ext,
      label: picked.label,
      audioAttached: audioAttached,
      duration: (endTime - startTime) / speed,
      perf: perf
    };
  }

  TD.Exporter = { exportVideo: exportVideo, listSupported: listSupported, pickMime: pickMime, download: download };
})(window);
