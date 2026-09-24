/* ============================================================
 * TrackVisualizer · 主程序
 * 状态管理 / 交互 / 播放循环 / 导出调度
 * ==========================================================*/
(function (global) {
  'use strict';
  const TD = global.TD;
  const util = TD.util;

  // 低饱和配色：在深色背景上保持可辨识度，同时避免霓虹感
  const PALETTE = [
    '#8fb0d6', '#d69a9a', '#9ecfa8', '#d9c48d', '#b3a6d6',
    '#d9b18d', '#8fcacb', '#c79aae', '#b7d68d', '#9aa6c9'
  ];

  const QUALITY_BPP = { low: 0.05, mid: 0.09, high: 0.15 };

  const state = {
    tracks: [],
    clips: [],          // 导入的音频 {id, name, buffer, offset(秒), volume, mute}
    notes: [],
    settings: {},
    time: 0,
    duration: 0,
    midiDuration: 0,
    maxDuration: 0.1,
    playing: false,
    exporting: false,
    looping: false,
    speed: 1,
    pitch: { min: 36, max: 84 },
    autoPitch: { min: 36, max: 84 },
    beats: [],
    beatsPerBar: 4,
    colorCursor: 0
  };

  let renderer = null;
  let audio = null;
  let canvas = null;
  let rafId = 0;
  let lastFrame = 0;
  let fpsAvg = 60;
  let lastHud = 0;
  let exportCancel = false;
  let currentBlobUrl = null;

  const $ = function (sel) { return document.querySelector(sel); };
  const $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /* ============================================================
   * 设置绑定
   * ==========================================================*/
  const WHEN = {
    manual: function () { return state.settings.pitchMode === 'manual'; },
    custom: function () { return state.settings.expRange === 'custom'; }
  };

  function decimalsOf(el) {
    const step = el.getAttribute('step');
    if (!step) return 0;
    const dot = String(step).indexOf('.');
    return dot < 0 ? 0 : String(step).length - dot - 1;
  }

  const OUT_FORMAT = {
    particleSpeed: function (v) { return Math.round(v); },
    particleCount: function (v) { return Math.round(v); },
    shake: function (v) { return Math.round(v); },
    octaveShift: function (v) { return (v > 0 ? '+' : '') + Math.round(v); }
  };

  function readSettings() {
    $$('[data-setting]').forEach(function (el) {
      const key = el.getAttribute('data-setting');
      if (el.type === 'checkbox') state.settings[key] = el.checked;
      else if (el.type === 'range' || el.type === 'number') {
        const v = parseFloat(el.value);
        state.settings[key] = isFinite(v) ? v : 0;
      } else state.settings[key] = el.value;
    });
    state.settings.expStart = state.settings.expStart || 0;
    state.settings.expEnd = state.settings.expEnd || 0;
  }

  function syncOuts() {
    $$('[data-out]').forEach(function (el) {
      const key = el.getAttribute('data-out');
      const src = document.querySelector('[data-setting="' + key + '"]');
      const v = state.settings[key];
      if (v == null) return;
      const dec = src ? decimalsOf(src) : 0;
      const fmt = OUT_FORMAT[key];
      el.textContent = fmt ? fmt(v) : (typeof v === 'number' ? v.toFixed(dec) : v);
    });
  }

  function syncWhens() {
    $$('[data-when]').forEach(function (el) {
      const key = el.getAttribute('data-when');
      const fn = WHEN[key];
      el.classList.toggle('hidden', fn ? !fn() : false);
    });
  }

  function applySetting(key, value) {
    state.settings[key] = value;

    if (key === 'volume' && audio) audio.setVolume(value);
    if (key === 'waveType' && audio) audio.waveType = value;
    if (key === 'pitchMode' || key === 'pitchMin' || key === 'pitchMax') applyPitch();
    if (key === 'leadIn') {
      // 开场留白会整体平移内容，需要重建时间轴
      rebuild();
      if (state.playing) startAudio();
    }
    if (key === 'synthEnabled') {
      if (state.playing) startAudio();
      else if (!value && !activeClips().length && audio) audio.stop();
    }
    if (key === 'expRange' || key === 'pitchMode') syncWhens();
    if (key === 'expStart' || key === 'expEnd') syncWhens();
    syncOuts();
  }

  function bindSettings() {
    $$('[data-setting]').forEach(function (el) {
      const key = el.getAttribute('data-setting');
      const handler = function () {
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'range' || el.type === 'number') {
          v = parseFloat(el.value);
          if (!isFinite(v)) v = 0;
        } else v = el.value;
        applySetting(key, v);
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
  }

  /* ============================================================
   * 轨道 / 状态重建
   * ==========================================================*/
  function fitPitch(min, max) {
    if (max < min) { const t = min; min = max; max = t; }
    let lo = Math.max(0, min - 2);
    let hi = Math.min(127, max + 2);
    if (hi - lo < 11) {
      const mid = (hi + lo) / 2;
      lo = Math.max(0, Math.round(mid - 6));
      hi = Math.min(127, lo + 12);
    }
    return { min: lo, max: hi };
  }

  function applyPitch() {
    if (state.settings.pitchMode === 'manual') {
      const min = util.clamp(state.settings.pitchMin, 0, 127);
      const max = util.clamp(state.settings.pitchMax, 0, 127);
      state.pitch = max > min ? { min: min, max: max } : fitPitch(min, max);
    } else {
      state.pitch = state.autoPitch;
    }
  }

  function rebuild() {
    const all = [];
    let duration = 0;
    let maxDur = 0.05;
    let lo = 127, hi = 0;
    const lead = state.settings.leadIn || 0;
    for (let i = 0; i < state.tracks.length; i++) {
      const tr = state.tracks[i];
      tr.index = i;
      const off = util.trackOffsetSeconds(tr) + lead;
      for (let j = 0; j < tr.notes.length; j++) {
        const n = tr.notes[j];
        const time = n.time + off;
        const end = time + n.duration;
        if (end > duration) duration = end;
        if (n.duration > maxDur) maxDur = n.duration;
        if (n.midi < lo) lo = n.midi;
        if (n.midi > hi) hi = n.midi;
        all.push({
          time: time, duration: n.duration, midi: n.midi, velocity: n.velocity,
          trackIndex: i, hit: false, hitAt: null
        });
      }
    }
    all.sort(function (a, b) { return a.time - b.time; });
    // 同音高的重叠音符分层，避免相互遮挡
    TD.assignNoteLanes(all);
    state.notes = all;
    state.midiDuration = duration;
    state.maxDuration = maxDur;
    state.autoPitch = (hi >= lo) ? fitPitch(lo, hi) : { min: 36, max: 84 };
    applyPitch();
    resetHits();
    updateTimeline();
    $('#emptyHint').classList.toggle('hidden', all.length > 0 || state.clips.length > 0);
    $('#hudNotes').textContent = all.length + ' 音符';
    $('#trackCount').textContent = state.tracks.length;
    const endInput = document.querySelector('[data-setting="expEnd"]');
    if (endInput && !parseFloat(endInput.value)) endInput.value = duration.toFixed(1);
  }

  /** 时间轴长度 = MIDI 末尾与所有音频末尾的较大者（均含开场留白） */
  function updateTimeline() {
    let d = state.midiDuration || 0;
    const lead = state.settings.leadIn || 0;
    for (let i = 0; i < state.clips.length; i++) {
      const c = state.clips[i];
      if (!c.buffer) continue;
      const end = lead + (c.offset || 0) + c.buffer.duration;
      if (end > d) d = end;
    }
    state.duration = d;
    if (state.time > d) state.time = 0;
    const endInput = document.querySelector('[data-setting="expEnd"]');
    if (endInput && !parseFloat(endInput.value)) endInput.value = d.toFixed(1);
    updateTransport(true);
  }

  /** 交给音频引擎的音频片段：把开场留白并进 offset */
  function engineClips() {
    const lead = state.settings.leadIn || 0;
    const src = activeClips();
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      out.push({
        buffer: c.buffer,
        offset: lead + (c.offset || 0),
        volume: c.volume,
        mute: c.mute
      });
    }
    return out;
  }

  function resetHits() {
    for (let i = 0; i < state.notes.length; i++) state.notes[i].hit = false;
  }

  function addTrackFromParsed(parsed, fileName) {
    let added = 0;
    // 该文件的小节线时刻，用于「按小节」偏移
    const beatList = parsed.beats || [];
    const perBar = Math.max(1, parsed.beatsPerBar || 4);
    const barTimes = [];
    for (let b = 0; b < beatList.length; b += perBar) barTimes.push(beatList[b]);
    let barSeconds = 2;
    if (barTimes.length > 1) barSeconds = barTimes[1] - barTimes[0];
    else if (beatList.length > 1) barSeconds = (beatList[1] - beatList[0]) * perBar;

    for (let i = 0; i < parsed.tracks.length; i++) {
      const t = parsed.tracks[i];
      if (!t.notes.length) continue;
      const color = PALETTE[state.colorCursor % PALETTE.length];
      state.colorCursor++;
      state.tracks.push({
        id: util.uid(),
        index: state.tracks.length,
        name: t.name || (fileName.replace(/\.midi?$/i, '') + ' · 轨 ' + (i + 1)),
        fileName: fileName,
        color: color,
        visible: true,
        mute: false,
        volume: 1,
        offsetBars: 0,        // 偏移，单位：小节
        barTimes: barTimes,
        barSeconds: barSeconds,
        notes: t.notes,
        noteCount: t.noteCount,
        bpm: parsed.bpm
      });
      added++;
    }
    if (!state.beats.length && parsed.beats && parsed.beats.length) {
      state.beats = parsed.beats;
      state.beatsPerBar = parsed.beatsPerBar || 4;
    }
    return added;
  }

  function loadBuffer(buffer, fileName) {
    const parsed = TD.MidiParser.parse(buffer);
    const added = addTrackFromParsed(parsed, fileName);
    if (!added) throw new Error('该文件没有可显示的音符');
    rebuild();
    renderTracks();
    return { tracks: added, notes: parsed.noteCount, duration: parsed.duration, bpm: parsed.bpm, format: parsed.format };
  }

  function handleFiles(files) {
    const list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    let pending = list.length;
    const summary = [];
    const errors = [];
    const hint = $('#loadHint');
    hint.textContent = '正在解析 ' + list.length + ' 个文件…';

    list.forEach(function (file) {
      const reader = new FileReader();
      reader.onload = function () {
        try {
          const info = loadBuffer(reader.result, file.name);
          summary.push(file.name + '：' + info.tracks + ' 轨 / ' + info.notes + ' 音符 / ' + info.bpm + ' BPM');
        } catch (e) {
          errors.push(file.name + '：' + e.message);
        }
        done();
      };
      reader.onerror = function () {
        errors.push(file.name + '：读取失败');
        done();
      };
      reader.readAsArrayBuffer(file);
    });

    function done() {
      if (--pending > 0) return;
      hint.textContent = '';
      if (summary.length) toast('导入成功\n' + summary.join('\n'), 'ok', 5000);
      if (errors.length) toast('导入失败\n' + errors.join('\n'), 'error', 7000);
      if (state.tracks.length && !state.playing) updateTransport(true);
    }
  }

  /* ============================================================
   * 导入音频
   * ==========================================================*/
  const AUDIO_RE = /\.(mp3|wav|wave|ogg|oga|m4a|aac|flac|opus|weba|webm)$/i;

  function handleAudioFiles(files) {
    const list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    if (!audio || !audio.supported) { toast('当前浏览器不支持 WebAudio，无法播放音频', 'error'); return; }

    list.forEach(function (file) {
      const reader = new FileReader();
      reader.onload = function () {
        audio.decode(reader.result).then(function (buffer) {
          state.clips.push({
            id: util.uid(),
            name: file.name,
            buffer: buffer,
            offset: 0,          // 秒：音频第 0 秒对应的曲目时间
            volume: 1,
            mute: false
          });
          updateTimeline();
          renderClips();
          $('#clipCount').textContent = state.clips.length;
          $('#emptyHint').classList.add('hidden');
          toast('已导入音频：' + file.name + '\n时长 ' + util.formatTime(buffer.duration) +
            ' · ' + buffer.sampleRate + ' Hz · ' + buffer.numberOfChannels + ' 声道', 'ok', 4500);
          if (state.playing) startAudio();
        }).catch(function (e) {
          toast('音频解码失败：' + file.name + '\n' + (e && e.message ? e.message : e), 'error', 6000);
        });
      };
      reader.onerror = function () { toast('读取失败：' + file.name, 'error'); };
      reader.readAsArrayBuffer(file);
    });
  }

  function renderClips() {
    const box = $('#clipList');
    box.innerHTML = '';
    if (!state.clips.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = '未导入音频，当前使用内置合成器';
      box.appendChild(p);
      return;
    }

    state.clips.forEach(function (clip, i) {
      const item = document.createElement('div');
      item.className = 'track-item';
      item.style.borderLeftColor = '#8a8a93';

      // 名称
      const head = document.createElement('div');
      head.className = 'track-head';
      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'track-name';
      name.value = clip.name;
      name.title = '可重命名';
      name.addEventListener('input', function () { clip.name = name.value; });
      head.appendChild(name);
      item.appendChild(head);

      // 信息
      const meta = document.createElement('div');
      meta.className = 'track-meta';
      meta.textContent = util.formatTime(clip.buffer.duration) + ' · ' +
        clip.buffer.sampleRate + ' Hz · ' + clip.buffer.numberOfChannels + 'ch';
      item.appendChild(meta);

      // 工具
      const tools = document.createElement('div');
      tools.className = 'track-tools';

      const mute = document.createElement('button');
      mute.className = 'tbtn-mini' + (clip.mute ? ' on' : '');
      mute.textContent = clip.mute ? '已静音' : '有声';
      mute.addEventListener('click', function () {
        clip.mute = !clip.mute;
        mute.classList.toggle('on', clip.mute);
        mute.textContent = clip.mute ? '已静音' : '有声';
        item.classList.toggle('dimmed', clip.mute);
        if (state.playing) startAudio();
      });
      tools.appendChild(mute);

      const align = document.createElement('button');
      align.className = 'tbtn-mini';
      align.textContent = '与开头对齐';
      align.title = '把偏移归零';
      align.addEventListener('click', function () {
        clip.offset = 0;
        offRange.value = '0';
        offNum.value = '0';
        updateTimeline();
        if (state.playing) startAudio();
      });
      tools.appendChild(align);

      const del = document.createElement('button');
      del.className = 'tbtn-mini';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        state.clips.splice(i, 1);
        if (state.playing) startAudio();
        updateTimeline();
        renderClips();
        $('#clipCount').textContent = state.clips.length;
      });
      tools.appendChild(del);
      item.appendChild(tools);

      // 偏移：滑杆 + 精确数值
      const offWrap = document.createElement('div');
      offWrap.className = 'track-offset';
      const offLabel = document.createElement('span');
      offLabel.textContent = '偏移';
      const offRange = document.createElement('input');
      offRange.type = 'range';
      offRange.min = '-15000';
      offRange.max = '15000';
      offRange.step = '10';
      offRange.value = String(Math.round((clip.offset || 0) * 1000));
      const offNum = document.createElement('input');
      offNum.type = 'number';
      offNum.className = 'offset-num';
      offNum.step = '10';
      offNum.value = String(Math.round((clip.offset || 0) * 1000));
      offNum.title = '毫秒，可为负';

      const applyOffset = function (ms, fromRange) {
        ms = isFinite(ms) ? ms : 0;
        clip.offset = ms / 1000;
        if (fromRange) offNum.value = String(Math.round(ms));
        else offRange.value = String(util.clamp(ms, -15000, 15000));
        updateTimeline();
      };
      offRange.addEventListener('input', function () {
        applyOffset(parseFloat(offRange.value), true);
      });
      offRange.addEventListener('change', function () { if (state.playing) startAudio(); });
      offNum.addEventListener('input', function () {
        applyOffset(parseFloat(offNum.value), false);
      });
      offNum.addEventListener('change', function () { if (state.playing) startAudio(); });

      offWrap.appendChild(offLabel);
      offWrap.appendChild(offRange);
      offWrap.appendChild(offNum);
      item.appendChild(offWrap);

      // 音量
      const volWrap = document.createElement('div');
      volWrap.className = 'track-offset';
      const volLabel = document.createElement('span');
      volLabel.textContent = '音量';
      const vol = document.createElement('input');
      vol.type = 'range';
      vol.min = '0';
      vol.max = '1.5';
      vol.step = '0.01';
      vol.value = String(clip.volume == null ? 1 : clip.volume);
      const volVal = document.createElement('span');
      volVal.className = 'val';
      volVal.textContent = Math.round((clip.volume == null ? 1 : clip.volume) * 100) + '%';
      vol.addEventListener('input', function () {
        clip.volume = parseFloat(vol.value);
        volVal.textContent = Math.round(clip.volume * 100) + '%';
      });
      vol.addEventListener('change', function () { if (state.playing) startAudio(); });
      volWrap.appendChild(volLabel);
      volWrap.appendChild(vol);
      volWrap.appendChild(volVal);
      item.appendChild(volWrap);

      box.appendChild(item);
    });
  }

  /* ============================================================
   * 轨道列表 UI
   * ==========================================================*/
  function renderTracks() {
    const box = $('#trackList');
    box.innerHTML = '';
    if (!state.tracks.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = '暂无轨道，先导入 MIDI 文件';
      box.appendChild(p);
      return;
    }

    state.tracks.forEach(function (tr, i) {
      const item = document.createElement('div');
      item.className = 'track-item';
      item.style.borderLeftColor = tr.color;

      // 头部：颜色 + 名称
      const head = document.createElement('div');
      head.className = 'track-head';

      const color = document.createElement('input');
      color.type = 'color';
      color.value = tr.color;
      color.title = '点击修改该轨道颜色';
      color.addEventListener('input', function () {
        tr.color = color.value;
        item.style.borderLeftColor = tr.color;
      });
      head.appendChild(color);

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'track-name';
      name.value = tr.name;
      name.title = '双击可重命名';
      name.addEventListener('input', function () { tr.name = name.value; });
      head.appendChild(name);

      item.appendChild(head);

      // 信息
      const meta = document.createElement('div');
      meta.className = 'track-meta';
      meta.textContent = tr.noteCount + ' 音符 · ' + tr.fileName;
      item.appendChild(meta);

      // 工具
      const tools = document.createElement('div');
      tools.className = 'track-tools';

      const eye = document.createElement('button');
      eye.className = 'tbtn-mini' + (tr.visible ? ' on' : '');
      eye.textContent = tr.visible ? '显示' : '隐藏';
      eye.addEventListener('click', function () {
        tr.visible = !tr.visible;
        eye.classList.toggle('on', tr.visible);
        eye.textContent = tr.visible ? '显示' : '隐藏';
        item.classList.toggle('dimmed', !tr.visible);
        if (state.settings.pitchMode === 'auto') recomputeAutoPitch();
      });
      tools.appendChild(eye);

      const mute = document.createElement('button');
      mute.className = 'tbtn-mini' + (tr.mute ? ' on' : '');
      mute.textContent = tr.mute ? '已静音' : '有声';
      mute.addEventListener('click', function () {
        tr.mute = !tr.mute;
        mute.classList.toggle('on', tr.mute);
        mute.textContent = tr.mute ? '已静音' : '有声';
      });
      tools.appendChild(mute);

      const del = document.createElement('button');
      del.className = 'tbtn-mini';
      del.textContent = '删除';
      del.addEventListener('click', function () {
        state.tracks.splice(i, 1);
        rebuild();
        renderTracks();
      });
      tools.appendChild(del);

      const solo = document.createElement('button');
      solo.className = 'tbtn-mini';
      solo.textContent = '仅此轨';
      solo.title = '只显示这一条轨道';
      solo.addEventListener('click', function () {
        const anyOther = state.tracks.some(function (t) { return t !== tr && t.visible; });
        state.tracks.forEach(function (t) { t.visible = anyOther ? (t === tr) : true; });
        renderTracks();
        if (state.settings.pitchMode === 'auto') recomputeAutoPitch();
      });
      tools.appendChild(solo);

      item.appendChild(tools);

      // 时间偏移（小节）
      const offWrap = document.createElement('div');
      offWrap.className = 'track-offset';
      const offLabel = document.createElement('span');
      offLabel.textContent = '偏移';
      const off = document.createElement('input');
      off.type = 'range';
      off.min = '-64';
      off.max = '64';
      off.step = '1';
      off.value = String(tr.offsetBars || 0);
      const offNum = document.createElement('input');
      offNum.type = 'number';
      offNum.className = 'offset-num';
      offNum.step = '1';
      offNum.value = String(tr.offsetBars || 0);
      offNum.title = '偏移小节数，可为负、可填小数';
      const offVal = document.createElement('span');
      offVal.className = 'val';

      const refreshOffset = function () {
        const sec = util.trackOffsetSeconds(tr);
        offVal.textContent = (sec >= 0 ? '+' : '') + sec.toFixed(2) + 's';
        offVal.title = '按首段速度换算：1 小节 ≈ ' + (tr.barSeconds || 2).toFixed(3) + ' 秒';
      };
      const applyBars = function (bars, fromRange) {
        bars = isFinite(bars) ? bars : 0;
        tr.offsetBars = bars;
        if (fromRange) offNum.value = String(bars);
        else off.value = String(util.clamp(bars, -64, 64));
        refreshOffset();
        rebuild();
      };
      off.addEventListener('input', function () { applyBars(parseFloat(off.value), true); });
      offNum.addEventListener('input', function () { applyBars(parseFloat(offNum.value), false); });
      refreshOffset();

      offWrap.appendChild(offLabel);
      offWrap.appendChild(off);
      offWrap.appendChild(offNum);
      offWrap.appendChild(offVal);
      item.appendChild(offWrap);

      box.appendChild(item);
    });
  }

  function recomputeAutoPitch() {
    let lo = 127, hi = 0;
    for (let i = 0; i < state.tracks.length; i++) {
      const tr = state.tracks[i];
      if (!tr.visible) continue;
      for (let j = 0; j < tr.notes.length; j++) {
        const m = tr.notes[j].midi;
        if (m < lo) lo = m;
        if (m > hi) hi = m;
      }
    }
    state.autoPitch = (hi >= lo) ? fitPitch(lo, hi) : { min: 36, max: 84 };
    applyPitch();
  }

  /* ============================================================
   * 播放控制
   * ==========================================================*/
  /** 当前需要参与播放的音频素材 */
  function activeClips() {
    const out = [];
    for (let i = 0; i < state.clips.length; i++) {
      if (state.clips[i].buffer) out.push(state.clips[i]);
    }
    return out;
  }

  function startAudio() {
    if (!audio || !audio.supported) return;
    const synth = !!state.settings.synthEnabled && state.notes.length > 0;
    const clips = engineClips();
    if (!synth && !clips.length) { audio.stop(); return; }

    audio.waveType = state.settings.waveType;
    audio.setVolume(state.settings.volume);
    audio.setMonitor(state.settings.monitor !== false);
    audio.start({
      notes: synth ? state.notes : [],
      clips: clips,
      fromTime: state.time,
      speed: state.speed,
      synthEnabled: synth,
      waveType: state.settings.waveType,
      octaveShift: state.settings.octaveShift,
      trackProvider: function () { return state.tracks; }
    });
  }

  /** 是否有任何音频需要 AudioContext 时钟 */
  function needsAudioClock() {
    return (!!state.settings.synthEnabled && state.notes.length > 0) || activeClips().length > 0;
  }

  function play() {
    if (!state.tracks.length && !state.clips.length) { toast('请先导入 MIDI 或音频文件', 'error'); return; }
    if (needsAudioClock() && audio && audio.supported) audio.resume();
    if (state.time >= state.duration - 0.02) seek(0);
    state.playing = true;
    startAudio();
    updateTransport(true);
  }

  function pause() {
    state.playing = false;
    if (audio) audio.stop();
    updateTransport(true);
  }

  function togglePlay() {
    if (state.playing) pause(); else play();
  }

  function seek(t) {
    state.time = util.clamp(t, 0, state.duration || 0);
    resetHits();
    if (state.playing) startAudio();
    updateTransport(true);
  }

  function restart() {
    seek(0);
    if (renderer) renderer.reset();
  }

  function updateTransport(force) {
    const btn = $('#btnPlay');
    if (btn) btn.textContent = state.playing ? '❚❚' : '▶';
    const t = util.formatTime(state.time);
    $('#tTime').textContent = t;
    $('#hudTime').textContent = t;
    $('#hudDuration').textContent = util.formatTime(state.duration);
    $('#tDuration').textContent = util.formatTime(state.duration);
    const bar = $('#progress');
    if (bar && document.activeElement !== bar) {
      const ratio = state.duration > 0 ? state.time / state.duration : 0;
      bar.value = String(Math.round(ratio * 1000));
    }
  }

  /* ============================================================
   * 渲染循环
   * ==========================================================*/
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (!isFinite(dt) || dt <= 0) dt = 1 / 60;
    if (dt > 0.25) dt = 0.25;
    fpsAvg = fpsAvg * 0.9 + (1 / dt) * 0.1;

    if (state.exporting) return;

    if (state.playing) {
      // 只要音频引擎在跑，就以 AudioContext 时钟为准，保证画面与声音不漂移
      if (audio && audio.playing) {
        state.time = audio.getPosition();
      } else {
        state.time += dt * state.speed;
      }
      if (state.time >= state.duration) {
        if (state.looping) {
          state.time = 0;
          resetHits();
          if (renderer) renderer.reset();
          startAudio();
        } else {
          state.time = state.duration;
          pause();
        }
      }
    }

    if (renderer) renderer.render(state, dt);
    updateTransport(false);

    if (now - lastHud > 250) {
      lastHud = now;
      $('#hudFps').textContent = Math.round(fpsAvg) + ' fps';
    }
  }

  function resizeCanvas() {
    if (!canvas) return;
    const stage = $('#stage');
    const rect = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.round(rect.width * dpr));
    const h = Math.max(180, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  /* ============================================================
   * 提示
   * ==========================================================*/
  function toast(msg, kind, ms) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.style.whiteSpace = 'pre-line';
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, ms || 3200);
  }

  /* ============================================================
   * 导出
   * ==========================================================*/
  function currentExportInfo() {
    const preset = String(state.settings.expPreset || '1920x1080').split('x');
    const W = parseInt(preset[0], 10) || 1920;
    const H = parseInt(preset[1], 10) || 1080;
    const fps = parseInt(state.settings.expFps, 10) || 60;
    const bpp = QUALITY_BPP[state.settings.expQuality] || 0.09;
    const bitrate = Math.round(W * H * fps * bpp);
    const pick = TD.Exporter.pickMime(state.settings.expFormat);
    let start = 0, end = state.duration;
    if (state.settings.expRange === 'custom') {
      start = util.clamp(state.settings.expStart || 0, 0, Math.max(0, state.duration - 0.2));
      end = state.settings.expEnd > 0 ? util.clamp(state.settings.expEnd, start + 0.2, state.duration) : state.duration;
    }
    return { W: W, H: H, fps: fps, bitrate: bitrate, mime: pick, start: start, end: end };
  }

  /** 解析导出时的音源选择 */
  function resolveExportAudio() {
    const clips = engineClips();
    const hasClips = clips.some(function (c) { return !c.mute; });
    const mode = state.settings.expAudioSource || 'auto';
    let synth, useClips;
    if (mode === 'import') { synth = false; useClips = true; }
    else if (mode === 'synth') { synth = true; useClips = false; }
    else if (mode === 'both') { synth = true; useClips = true; }
    else { synth = !hasClips; useClips = hasClips; }   // auto
    return {
      synth: synth && state.notes.length > 0,
      clips: useClips ? clips.filter(function (c) { return !c.mute; }) : []
    };
  }

  async function doExport() {
    if (state.exporting) return;
    if (!state.tracks.length && !state.clips.length) { toast('请先导入 MIDI 或音频文件', 'error'); return; }
    const info = currentExportInfo();
    if (!info.mime) { toast('当前浏览器不支持视频录制编码，建议使用最新版 Chrome / Edge', 'error', 6000); return; }

    const wasPlaying = state.playing;
    pause();
    resetHits();
    if (renderer) renderer.reset();
    exportCancel = false;
    state.exporting = true;

    if (state.settings.expCloseUi) document.body.classList.add('immersive');
    const overlay = $('#exportOverlay');
    overlay.classList.remove('hidden');
    const audioPlan = resolveExportAudio();
    const includeAudio = !!state.settings.expAudio && (audioPlan.synth || audioPlan.clips.length > 0);
    $('#exportTitle').textContent = '正在渲染 ' + info.W + '×' + info.H + ' @ ' + info.fps + 'fps · ' + info.mime.label;
    $('#exportBar').style.width = '0%';
    $('#exportPercent').textContent = '0%';
    $('#exportEta').textContent = '';

    try {
      const res = await TD.Exporter.exportVideo({
        state: state,
        width: info.W,
        height: info.H,
        fps: info.fps,
        bitrate: info.bitrate,
        startTime: info.start,
        endTime: info.end,
        speed: state.speed,
        format: state.settings.expFormat,
        audio: audio,
        includeAudio: includeAudio,
        audioOpts: {
          clips: audioPlan.clips,
          synthEnabled: audioPlan.synth,
          waveType: state.settings.waveType,
          octaveShift: state.settings.octaveShift,
          trackProvider: function () { return state.tracks; }
        },
        mirrorCanvas: canvas,
        isCancelled: function () { return exportCancel; },
        onProgress: function (ratio, meta) {
          $('#exportBar').style.width = (ratio * 100).toFixed(1) + '%';
          $('#exportPercent').textContent = (ratio * 100).toFixed(1) + '%';
          $('#exportEta').textContent = meta.remaining > 0.5
            ? ('剩余约 ' + Math.ceil(meta.remaining) + ' 秒')
            : '';
        }
      });

      overlay.classList.add('hidden');
      state.exporting = false;
      if (state.settings.expCloseUi) document.body.classList.remove('immersive');
      if (renderer) renderer.reset();

      if (res.cancelled) {
        toast('已取消导出');
      } else {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const name = 'TrackVisualizer_' + info.W + 'x' + info.H + '_' + info.fps + 'fps_' + stamp + '.' + res.ext;
        TD.Exporter.download(res.blob, name);
        if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
        toast('导出完成：' + name + '\n' + util.formatBytes(res.blob.size) +
          ' · ' + res.duration.toFixed(1) + ' 秒' + (res.audioAttached ? ' · 含音频' : '') +
          (res.ext === 'webm' ? '\n提示：本机浏览器不支持 MP4 直出，已输出 WebM' : ''), 'ok', 8000);
      }
    } catch (e) {
      overlay.classList.add('hidden');
      state.exporting = false;
      if (state.settings.expCloseUi) document.body.classList.remove('immersive');
      if (renderer) renderer.reset();
      toast('导出失败：' + (e && e.message ? e.message : e), 'error', 7000);
    }

    lastFrame = performance.now();
    if (wasPlaying) play();
  }

  /* ============================================================
   * 音频 UI 同步
   * ==========================================================*/
  /** 传输条上的按钮 = 预览监听开关（静音不影响导出结果） */
  function syncAudioUi() {
    const on = state.settings.monitor !== false;
    const btn = $('#btnAudio');
    btn.classList.toggle('on', !on);
    btn.textContent = on ? '🔊' : '🔇';
    btn.title = on ? '预览监听：开（点击静音，不影响导出）' : '预览监听：已静音（点击恢复）';
  }

  /* ============================================================
   * 初始化
   * ==========================================================*/
  function init() {
    canvas = $('#stageCanvas');
    renderer = new TD.Renderer(canvas);
    audio = new TD.AudioEngine();

    readSettings();
    syncOuts();
    syncWhens();
    syncAudioUi();
    resizeCanvas();

    bindSettings();

    // 显示可用的导出格式
    const supported = TD.Exporter.listSupported();
    if (!supported.length) {
      $('#mimeHint').textContent = '⚠ 当前浏览器不支持 MediaRecorder，无法导出视频。';
    } else {
      const mp4 = supported.some(function (m) { return m.ext === 'mp4'; });
      $('#mimeHint').textContent = '本机可用编码：' + supported.map(function (m) { return m.label; })
        .filter(function (v, i, a) { return a.indexOf(v) === i; }).join('、') +
        (mp4 ? '' : '（无 MP4 直出，将导出 WebM，可用剪辑软件转码）');
    }

    // ---- 文件导入 ----
    const fileInput = $('#fileInput');
    fileInput.addEventListener('change', function () {
      handleFiles(fileInput.files);
      fileInput.value = '';
    });

    const audioInput = $('#audioInput');
    audioInput.addEventListener('change', function () {
      handleAudioFiles(audioInput.files);
      audioInput.value = '';
    });

    const dropzone = $('#dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove('over'); });
    });

    const audioDrop = $('#audioDrop');
    ['dragenter', 'dragover'].forEach(function (ev) {
      audioDrop.addEventListener(ev, function (e) { e.preventDefault(); audioDrop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      audioDrop.addEventListener(ev, function (e) { e.preventDefault(); audioDrop.classList.remove('over'); });
    });

    const stage = $('#stage');
    let dragDepth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      dragDepth++;
      $('#dropMask').classList.remove('hidden');
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('#dropMask').classList.add('hidden');
    });
    // 全局拖放：按扩展名自动分流到 MIDI / 音频
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      $('#dropMask').classList.add('hidden');
      const files = e.dataTransfer && e.dataTransfer.files ? Array.prototype.slice.call(e.dataTransfer.files) : [];
      if (!files.length) return;
      const midis = [], audios = [], other = [];
      files.forEach(function (f) {
        if (/\.(mid|midi|smf)$/i.test(f.name)) midis.push(f);
        else if (AUDIO_RE.test(f.name) || /^audio\//.test(f.type)) audios.push(f);
        else other.push(f);
      });
      if (midis.length) handleFiles(midis);
      if (audios.length) handleAudioFiles(audios);
      if (other.length) toast('不认识的文件类型：' + other.map(function (f) { return f.name; }).join('、'), 'error', 5000);
    });

    // ---- 按钮 ----
    $('#btnDemo').addEventListener('click', function () {
      try {
        const buf = TD.createDemoMidi();
        const info = loadBuffer(buf, '示例曲目.mid');
        toast('已加载示例：' + info.tracks + ' 轨 / ' + info.notes + ' 音符', 'ok');
      } catch (e) {
        toast('示例加载失败：' + e.message, 'error');
      }
    });

    $('#btnClear').addEventListener('click', function () {
      pause();
      state.tracks = [];
      state.notes = [];
      state.clips = [];
      state.beats = [];
      state.duration = 0;
      state.midiDuration = 0;
      state.time = 0;
      state.colorCursor = 0;
      rebuild();
      renderTracks();
      renderClips();
      $('#clipCount').textContent = '0';
      if (renderer) renderer.reset();
    });

    $('#btnPalette').addEventListener('click', function () {
      state.tracks.forEach(function (t, i) { t.color = PALETTE[i % PALETTE.length]; });
      renderTracks();
    });
    $('#btnRandomColor').addEventListener('click', function () {
      state.tracks.forEach(function (t) { t.color = PALETTE[Math.floor(Math.random() * PALETTE.length)]; });
      renderTracks();
    });
    $('#btnTestFx').addEventListener('click', function () {
      if (!renderer) return;
      const L = TD.computeLayout(state, canvas.width, canvas.height);
      const midi = Math.round((state.pitch.min + state.pitch.max) / 2);
      const track = state.tracks[0];
      const color = track ? track.color : '#35e0ff';
      renderer._onHit(state, L, { midi: midi, velocity: 0.9 }, { color: color });
      resumeAudioContext();
    });

    // ---- 播放条 ----
    $('#btnPlay').addEventListener('click', togglePlay);
    $('#btnRestart').addEventListener('click', restart);
    $('#progress').addEventListener('input', function (e) {
      const ratio = parseFloat(e.target.value) / 1000;
      seek(ratio * state.duration);
    });
    $('#speedSelect').addEventListener('change', function (e) {
      state.speed = parseFloat(e.target.value) || 1;
      if (state.playing) startAudio();
    });
    $('#btnAudio').addEventListener('click', function () {
      state.settings.monitor = state.settings.monitor === false;
      if (audio) audio.setMonitor(state.settings.monitor);
      syncAudioUi();
    });
    $('#btnLoop').addEventListener('click', function (e) {
      state.looping = !state.looping;
      e.currentTarget.classList.toggle('on', state.looping);
    });
    $('#btnImmersive').addEventListener('click', function () {
      const on = !document.body.classList.contains('immersive');
      document.body.classList.toggle('immersive', on);
      try {
        if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
        else if (!on && document.fullscreenElement) document.exitFullscreen();
      } catch (e) { /* noop */ }
      setTimeout(resizeCanvas, 120);
    });
    $('#btnCollapse').addEventListener('click', function () {
      $('#app').classList.toggle('collapsed');
      setTimeout(resizeCanvas, 260);
    });
    $('#btnExport').addEventListener('click', doExport);
    $('#btnExport2').addEventListener('click', doExport);
    $('#btnCancelExport').addEventListener('click', function () { exportCancel = true; });

    // ---- 键盘 ----
    window.addEventListener('keydown', function (e) {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (state.exporting && e.key !== 'Escape') return;
      switch (e.key) {
        case ' ': e.preventDefault(); togglePlay(); break;
        case 'r': case 'R': restart(); break;
        case 'f': case 'F': $('#btnImmersive').click(); break;
        case 'e': case 'E': doExport(); break;
        case 'Tab': e.preventDefault(); $('#btnCollapse').click(); break;
        case 'ArrowLeft': e.preventDefault(); seek(state.time - (e.shiftKey ? 10 : 2)); break;
        case 'ArrowRight': e.preventDefault(); seek(state.time + (e.shiftKey ? 10 : 2)); break;
        case 'Escape':
          if (state.exporting) exportCancel = true;
          else if (document.body.classList.contains('immersive')) $('#btnImmersive').click();
          break;
        default: break;
      }
    });

    function resumeAudioContext() {
      if (audio && audio.supported) audio.resume();
    }
    window.addEventListener('pointerdown', resumeAudioContext, { once: true });

    // ---- 尺寸 ----
    let resizeTimer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeCanvas, 100);
    });
    if (window.ResizeObserver) {
      new ResizeObserver(function () { resizeCanvas(); }).observe($('#stage'));
    }

    // ---- 启动 ----
    renderTracks();
    renderClips();
    updateTransport(true);
    lastFrame = performance.now();
    rafId = requestAnimationFrame(loop);

    // 读取 URL 参数（可选：?demo=1&play=1&t=5 便于自动演示 / 回归验证）
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1') $('#btnDemo').click();
    if (params.get('t')) {
      const t = parseFloat(params.get('t'));
      if (isFinite(t)) seek(t);
    }
    if (params.get('immersive') === '1') document.body.classList.add('immersive');
    if (params.get('play') === '1') setTimeout(play, 120);
    if (params.get('export') === '1') {
      window.__autoExport = true;
      setTimeout(function () { doExport().then(function () { window.__exportDone = true; }); }, 400);
    }
    window.__ready = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  TD.app = {
    state: state, seek: seek, play: play, pause: pause, toast: toast, rebuild: rebuild,
    updateTimeline: updateTimeline, renderClips: renderClips, handleAudioFiles: handleAudioFiles,
    startAudio: startAudio, resolveExportAudio: resolveExportAudio
  };
})(window);
