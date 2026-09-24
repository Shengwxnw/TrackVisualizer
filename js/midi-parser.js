/* ============================================================
 * TrackVisualizer · 标准 MIDI 文件（SMF）解析器
 * 支持 Format 0 / 1 / 2、PPQ 与 SMPTE 时基、running status、
 * 变速（Tempo Map）、变拍号、多轨。
 * 产出：{ format, ppq, duration, tempoMap, tracks:[{name, notes:[]}] }
 * note = { time, duration, midi, velocity(0~1), channel, trackIndex }
 * ==========================================================*/
(function (global) {
  'use strict';
  const TD = (global.TD = global.TD || {});

  const DEFAULT_TEMPO = 500000; // 120 BPM

  function readVLQ(view, offset) {
    let value = 0, byte, count = 0;
    do {
      byte = view.getUint8(offset++);
      value = (value << 7) | (byte & 0x7f);
      if (++count > 4) break;
    } while (byte & 0x80);
    return { value: value >>> 0, offset: offset };
  }

  let _decoder = null;
  function readStr(view, offset, length) {
    if (length <= 0) return '';
    if (typeof TextDecoder !== 'undefined') {
      if (!_decoder) _decoder = new TextDecoder('utf-8', { fatal: false });
      try {
        const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
        return _decoder.decode(bytes).replace(/\u0000+$/, '');
      } catch (e) { /* 退回到逐字节 */ }
    }
    let s = '';
    for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s.replace(/\u0000+$/, '');
  }

  function parseTrack(view, start, end) {
    const notes = [];
    const tempos = [];
    const timeSigs = [];
    const active = new Map(); // (channel<<8|note) -> [{tick, velocity}]
    let name = '';
    let offset = start;
    let tick = 0;
    let running = 0;

    function openNote(channel, midi, velocity) {
      const key = (channel << 8) | midi;
      let list = active.get(key);
      if (!list) { list = []; active.set(key, list); }
      list.push({ tick: tick, velocity: velocity });
    }
    function closeNote(channel, midi) {
      const key = (channel << 8) | midi;
      const list = active.get(key);
      if (!list || !list.length) return;
      const item = list.shift();
      if (!list.length) active.delete(key);
      const dur = Math.max(tick - item.tick, 1);
      notes.push({
        tick: item.tick,
        durationTicks: dur,
        midi: midi,
        velocity: item.velocity / 127,
        channel: channel
      });
    }

    while (offset < end) {
      const vlq = readVLQ(view, offset);
      tick += vlq.value;
      offset = vlq.offset;
      if (offset >= end) break;

      let status = view.getUint8(offset);
      if (status & 0x80) {
        offset++;
        running = status;
      } else if (running) {
        status = running;
      } else {
        break; // 无 running status 且不是状态字节 → 流损坏
      }

      // ---- Meta 事件 ----
      if (status === 0xff) {
        const metaType = view.getUint8(offset++);
        const len = readVLQ(view, offset);
        offset = len.offset;
        const dataStart = offset;
        if (metaType === 0x51 && len.value >= 3) {
          tempos.push({
            tick: tick,
            usPerQuarter: (view.getUint8(dataStart) << 16) | (view.getUint8(dataStart + 1) << 8) | view.getUint8(dataStart + 2)
          });
        } else if (metaType === 0x58 && len.value >= 2) {
          timeSigs.push({
            tick: tick,
            numerator: view.getUint8(dataStart),
            denominator: Math.pow(2, view.getUint8(dataStart + 1))
          });
        } else if (metaType === 0x03) {
          name = readStr(view, dataStart, Math.min(len.value, 128));
        }
        offset = dataStart + len.value;
        if (metaType === 0x2f) break; // End of Track
        continue;
      }

      // ---- SysEx ----
      if (status === 0xf0 || status === 0xf7) {
        const len = readVLQ(view, offset);
        offset = len.offset + len.value;
        running = 0;
        continue;
      }

      const type = status & 0xf0;
      const channel = status & 0x0f;

      if (type === 0x80) {
        const midi = view.getUint8(offset); offset += 2;
        closeNote(channel, midi);
      } else if (type === 0x90) {
        const midi = view.getUint8(offset);
        const vel = view.getUint8(offset + 1);
        offset += 2;
        if (vel > 0) openNote(channel, midi, vel);
        else closeNote(channel, midi);
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
        offset += 2;
      } else if (type === 0xc0 || type === 0xd0) {
        offset += 1;
      } else {
        break;
      }
    }

    // 收尾：未闭合的音符
    active.forEach(function (list, key) {
      const midi = key & 0xff;
      const channel = (key >> 8) & 0x0f;
      for (let i = 0; i < list.length; i++) {
        notes.push({
          tick: list[i].tick,
          durationTicks: Math.max(tick - list[i].tick, 1),
          midi: midi,
          velocity: list[i].velocity / 127,
          channel: channel
        });
      }
    });

    return { name: name, notes: notes, tempos: tempos, timeSigs: timeSigs, endTick: tick };
  }

  function buildTempoMap(tempos, isSmpte, tickSeconds, ticksPerQuarter) {
    if (isSmpte) {
      const seg = [{ tick: 0, time: 0, secondsPerTick: tickSeconds, usPerQuarter: tickSeconds * 1e6 * ticksPerQuarter }];
      return {
        segments: seg,
        isSmpte: true,
        tickToTime: function (t) { return t * tickSeconds; },
        timeToTick: function (s) { return s / tickSeconds; }
      };
    }

    const sorted = tempos.slice().sort(function (a, b) { return a.tick - b.tick; });
    const segments = [];
    let lastTick = 0, time = 0, us = DEFAULT_TEMPO;

    if (!sorted.length || sorted[0].tick > 0) {
      segments.push({ tick: 0, time: 0, usPerQuarter: DEFAULT_TEMPO, secondsPerTick: DEFAULT_TEMPO / 1e6 / ticksPerQuarter });
    }
    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i];
      if (ev.tick < lastTick) continue;
      time += (ev.tick - lastTick) * (us / 1e6 / ticksPerQuarter);
      segments.push({
        tick: ev.tick, time: time, usPerQuarter: ev.usPerQuarter,
        secondsPerTick: ev.usPerQuarter / 1e6 / ticksPerQuarter
      });
      lastTick = ev.tick;
      us = ev.usPerQuarter;
    }
    if (!segments.length) {
      segments.push({ tick: 0, time: 0, usPerQuarter: DEFAULT_TEMPO, secondsPerTick: DEFAULT_TEMPO / 1e6 / ticksPerQuarter });
    }

    return {
      segments: segments,
      isSmpte: false,
      tickToTime: function (tick) {
        let lo = 0, hi = segments.length - 1, idx = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (segments[mid].tick <= tick) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        const s = segments[idx];
        return s.time + (tick - s.tick) * s.secondsPerTick;
      },
      timeToTick: function (sec) {
        let lo = 0, hi = segments.length - 1, idx = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (segments[mid].time <= sec) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        const s = segments[idx];
        return s.tick + (sec - s.time) / s.secondsPerTick;
      },
      /** 生成节拍时间点（用于网格） */
      collectBeats: function (maxTime, maxCount) {
        maxTime = maxTime > 0 ? maxTime : 3600;
        maxCount = maxCount || 40000;
        const beats = [];
        for (let i = 0; i < segments.length; i++) {
          const s = segments[i];
          const next = segments[i + 1];
          const beatDur = s.usPerQuarter / 1e6;
          if (beatDur <= 0) continue;
          const endTime = Math.min(next ? next.time : maxTime, maxTime);
          let t = s.time, first = true;
          while (t <= endTime + 1e-6 && beats.length < maxCount) {
            if (!first || i === 0) beats.push(t);
            first = false;
            t += beatDur;
            if (beats.length >= maxCount) break;
          }
        }
        // 去重排序
        beats.sort(function (a, b) { return a - b; });
        const out = [];
        for (let i = 0; i < beats.length; i++) {
          if (!out.length || beats[i] - out[out.length - 1] > 1e-4) out.push(beats[i]);
        }
        return out;
      }
    };
  }

  /**
   * @param {ArrayBuffer} buffer
   * @param {Object} [options] { mergeTracks:false, minDuration:0.01 }
   */
  function parse(buffer, options) {
    options = options || {};
    const view = new DataView(buffer);
    if (view.byteLength < 14) throw new Error('文件过小，不是有效的 MIDI 文件');
    if (readStr(view, 0, 4) !== 'MThd') throw new Error('未找到 MThd 头，不是标准 MIDI 文件');

    const headerLength = view.getUint32(4);
    const format = view.getUint16(8);
    const declaredTracks = view.getUint16(10);
    const division = view.getUint16(12);

    const isSmpte = (division & 0x8000) !== 0;
    let ticksPerQuarter = division & 0x7fff;
    let tickSeconds = 0;
    if (isSmpte) {
      const fps = 256 - ((division >> 8) & 0x7f);
      const ticksPerFrame = division & 0xff || 1;
      tickSeconds = 1 / (fps * ticksPerFrame);
      ticksPerQuarter = 480;
    } else if (ticksPerQuarter <= 0) {
      ticksPerQuarter = 480;
    }

    const rawTracks = [];
    let offset = 8 + headerLength;
    const len = view.byteLength;

    while (offset + 8 <= len) {
      const id = readStr(view, offset, 4);
      const size = view.getUint32(offset + 4);
      offset += 8;
      const end = Math.min(offset + size, len);
      if (id !== 'MTrk') { offset = end; continue; }
      rawTracks.push(parseTrack(view, offset, end));
      offset = end;
    }
    if (!rawTracks.length) throw new Error('文件中没有任何 MTrk 轨道');

    // 合并 tempo / 拍号
    const allTempos = [];
    const allTimeSigs = [];
    for (let i = 0; i < rawTracks.length; i++) {
      for (let j = 0; j < rawTracks[i].tempos.length; j++) allTempos.push(rawTracks[i].tempos[j]);
      for (let j = 0; j < rawTracks[i].timeSigs.length; j++) allTimeSigs.push(rawTracks[i].timeSigs[j]);
    }
    const tempoMap = buildTempoMap(allTempos, isSmpte, tickSeconds, ticksPerQuarter);
    const timeSigs = allTimeSigs.sort(function (a, b) { return a.tick - b.tick; });
    const beatsPerBar = (timeSigs.length && timeSigs[0].numerator) ? timeSigs[0].numerator : 4;

    const minDur = options.minDuration == null ? 0.02 : options.minDuration;
    const tracks = [];
    let duration = 0;
    let totalNotes = 0;

    for (let i = 0; i < rawTracks.length; i++) {
      const rt = rawTracks[i];
      const notes = [];
      for (let j = 0; j < rt.notes.length; j++) {
        const raw = rt.notes[j];
        const time = tempoMap.tickToTime(raw.tick);
        let dur = tempoMap.tickToTime(raw.tick + raw.durationTicks) - time;
        if (dur < minDur) dur = minDur;
        notes.push({
          time: time,
          duration: dur,
          midi: raw.midi,
          velocity: raw.velocity,
          channel: raw.channel,
          trackIndex: i
        });
        const endT = time + dur;
        if (endT > duration) duration = endT;
      }
      notes.sort(function (a, b) { return a.time - b.time; });
      totalNotes += notes.length;
      tracks.push({
        index: i,
        name: rt.name || ('轨道 ' + (i + 1)),
        notes: notes,
        noteCount: notes.length,
        endTick: rt.endTick
      });
    }

    if (!totalNotes) throw new Error('未解析到任何音符，文件可能只包含控制信息');

    const beats = tempoMap.collectBeats(Math.ceil(duration) + 2);

    return {
      format: format,
      declaredTracks: declaredTracks,
      ppq: ticksPerQuarter,
      isSmpte: isSmpte,
      duration: duration,
      tempoMap: tempoMap,
      beats: beats,
      beatsPerBar: beatsPerBar,
      timeSignatures: timeSigs,
      tracks: tracks,
      noteCount: totalNotes,
      bpm: Math.round(60000000 / (tempoMap.segments[0] ? tempoMap.segments[0].usPerQuarter : DEFAULT_TEMPO))
    };
  }

  TD.MidiParser = { parse: parse, readStr: readStr, readVLQ: readVLQ, DEFAULT_TEMPO: DEFAULT_TEMPO };
})(window);
