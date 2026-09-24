/* ============================================================
 * TrackVisualizer · 内置示例 MIDI 生成器
 * 在内存中直接构造一个标准 MIDI 文件（Format 1），
 * 这样无需任何素材即可体验完整流程。
 * ==========================================================*/
(function (global) {
  'use strict';
  const TD = (global.TD = global.TD || {});

  const PPQ = 480;
  const BEAT = PPQ;
  const BAR = PPQ * 4;

  function vlq(value) {
    const out = [value & 0x7f];
    value = Math.floor(value / 128);
    while (value > 0) {
      out.unshift((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    return out;
  }

  function ascii(s) {
    if (typeof TextEncoder !== 'undefined') {
      const bytes = new TextEncoder().encode(s);
      const out = [];
      for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
      return out;
    }
    const out = [];
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    return out;
  }

  function chunk(id, data) {
    const head = ascii(id);
    const size = data.length;
    return head.concat([
      (size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255
    ], data);
  }

  function buildTrack(events) {
    events.sort(function (a, b) { return a.tick - b.tick; });
    const data = [];
    let last = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const delta = Math.max(0, Math.round(e.tick - last));
      last = e.tick;
      data.push.apply(data, vlq(delta));
      data.push.apply(data, e.data);
    }
    data.push(0x00, 0xff, 0x2f, 0x00);
    return chunk('MTrk', data);
  }

  function metaText(type, text) {
    const bytes = ascii(text);
    return [0xff, type].concat(vlq(bytes.length), bytes);
  }

  function noteEvents(trackIndex, channel, midi, startTick, durTicks, velocity) {
    const ch = channel & 0x0f;
    const vel = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    return [
      { tick: startTick, data: [0x90 | ch, midi, vel] },
      { tick: startTick + Math.max(10, durTicks), data: [0x80 | ch, midi, 0] }
    ];
  }

  /** 生成示例文件，返回 ArrayBuffer */
  function createDemoMidi() {
    const bars = [
      { chord: [57, 60, 64], bass: 45, mel: [69, 72, 76, 74, 72, 69, 72, 74] }, // Am
      { chord: [53, 57, 60], bass: 41, mel: [65, 69, 72, 69, 65, 64, 65, 69] }, // F
      { chord: [60, 64, 67], bass: 48, mel: [67, 72, 76, 72, 67, 72, 76, 79] }, // C
      { chord: [55, 59, 62], bass: 43, mel: [67, 74, 71, 74, 71, 67, 71, 74] }  // G
    ];
    const prog = [0, 1, 2, 3, 0, 1, 2, 3];
    const velPattern = [0.92, 0.68, 0.8, 0.72, 0.86, 0.66, 0.78, 0.7];

    // 轨道 0：速度与标题
    const conductor = [
      { tick: 0, data: metaText(0x03, 'Tempo Map') },
      { tick: 0, data: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }, // 120 BPM = 500000us
      { tick: 0, data: [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08] }
    ];

    // 轨道 1：低音
    const bass = [{ tick: 0, data: metaText(0x03, 'Bass 低音') }];
    // 轨道 2：和弦
    const chords = [{ tick: 0, data: metaText(0x03, 'Chords 和弦') }];
    // 轨道 3：旋律
    const melody = [{ tick: 0, data: metaText(0x03, 'Melody 旋律') }];

    for (let b = 0; b < prog.length; b++) {
      const bar = bars[prog[b]];
      const base = b * BAR;

      // 低音：每半拍脉冲，第 3 拍跳八度
      for (let i = 0; i < 8; i++) {
        const t = base + i * (BEAT / 2);
        const pitch = bar.bass + (i === 3 || i === 6 ? 12 : 0);
        if (i % 2 === 0 || i === 3) {
          bass.push.apply(bass, noteEvents(0, 0, pitch, t, BEAT / 2 - 40, i % 4 === 0 ? 0.95 : 0.7));
        }
      }

      // 和弦：整小节铺底 + 第 3 拍重击
      for (let c = 0; c < bar.chord.length; c++) {
        chords.push.apply(chords, noteEvents(0, 1, bar.chord[c], base, BAR - 40, 0.62));
      }

      // 旋律：八分音符
      for (let i = 0; i < 8; i++) {
        if (!bar.mel[i]) continue;
        const t = base + i * (BEAT / 2);
        melody.push.apply(melody, noteEvents(0, 2, bar.mel[i], t, BEAT / 2 - 60, velPattern[i]));
      }
    }

    const trackChunks = [
      buildTrack(conductor),
      buildTrack(bass),
      buildTrack(chords),
      buildTrack(melody)
    ];

    const header = ascii('MThd').concat([
      0, 0, 0, 6,
      0, 1,                    // format 1
      0, trackChunks.length,   // 轨道数
      (PPQ >> 8) & 255, PPQ & 255
    ]);

    let total = header.length;
    for (let i = 0; i < trackChunks.length; i++) total += trackChunks[i].length;
    const out = new Uint8Array(total);
    let p = 0;
    out.set(header, p); p += header.length;
    for (let i = 0; i < trackChunks.length; i++) { out.set(trackChunks[i], p); p += trackChunks[i].length; }
    return out.buffer;
  }

  TD.createDemoMidi = createDemoMidi;
})(window);
