/* 解析器 / 示例生成器 自测（Node 环境） */
const fs = require('fs');
const path = require('path');

global.window = global;
function load(f) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
  (0, eval)(code);
}
load('util.js');
load('midi-parser.js');
load('midi-demo.js');

let fails = 0;
function ok(cond, msg, extra) {
  if (cond) console.log('  ✓ ' + msg);
  else { fails++; console.log('  ✗ ' + msg + (extra != null ? '  → ' + extra : '')); }
}
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, msg, a + ' vs ' + b); }

/* ---------- 1. 内置示例（Format 1 + 变速表 + 多轨） ---------- */
console.log('\n[1] 示例 MIDI');
const buf = TD.createDemoMidi();
const p = TD.MidiParser.parse(buf);
ok(p.format === 1, 'Format = 1', p.format);
ok(p.tracks.length === 4, '轨道数 = 4', p.tracks.length);
ok(p.tracks[0].noteCount === 0, '轨道 0 为速度轨（无音符）');
ok(p.noteCount === 128, '总音符 = 128', p.noteCount);
ok(p.bpm === 120, 'BPM = 120', p.bpm);
near(p.duration, 15.96, 0.02, '总时长 ≈ 15.96s');
ok(p.tracks[1].name.indexOf('Bass') >= 0, '轨道名解析正确: ' + p.tracks[1].name);
near(p.beats[4], 2.0, 1e-6, '第 5 拍 = 2.0s');
ok(p.beatsPerBar === 4, '每小节 4 拍');

let sorted = true;
for (let i = 1; i < p.tracks[3].notes.length; i++) {
  if (p.tracks[3].notes[i].time < p.tracks[3].notes[i - 1].time) sorted = false;
}
ok(sorted, '音符按时间升序');

const first = p.tracks[3].notes[0];
ok(first.midi === 69, '旋律首音 = A4(69)', first.midi);
near(first.duration, 0.1875, 1e-6, '八分音符时值 ≈ 0.1875s');

/* ---------- 2. Running Status + 变速度（手工构造 Format 0） ---------- */
console.log('\n[2] Running Status / Tempo');
function vlq(v) { const o = [v & 0x7f]; v = Math.floor(v / 128); while (v > 0) { o.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); } return o; }
function chunk(id, data) {
  const head = [id.charCodeAt(0), id.charCodeAt(1), id.charCodeAt(2), id.charCodeAt(3)];
  const n = data.length;
  return head.concat([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], data);
}
// ppq=96；tick 0 设 120BPM，tick 96（=1拍）改 240BPM；音符 60 从 tick 0 到 tick 96
const ev = [];
ev.push(0, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
ev.push(0, 0x90, 60, 100);           // note on
ev.push.apply(ev, vlq(96));
ev.push(60, 0x00);                   // running status：note on vel 0 = note off
ev.push(0, 0xff, 0x51, 0x03, 0x03, 0xd0, 0x90); // 250000us = 240BPM
ev.push.apply(ev, vlq(96));
ev.push(0x90, 64, 100);              // 新状态字节：note on
ev.push.apply(ev, vlq(96));
ev.push(64, 0x00);
ev.push(0, 0xff, 0x2f, 0x00);
const trk = chunk('MTrk', ev);
const bytes = [].concat(
  [77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96],
  trk
);
const p2 = TD.MidiParser.parse(new Uint8Array(bytes).buffer);
ok(p2.format === 0, 'Format = 0');
ok(p2.noteCount === 2, '解析出 2 个音符', p2.noteCount);
near(p2.tracks[0].notes[0].duration, 0.5, 1e-6, '第一音时值 0.5s（120BPM 一拍）');
near(p2.tracks[0].notes[1].time, 0.75, 1e-6, '第二音起点 0.75s（变速后）');
near(p2.tracks[0].notes[1].duration, 0.25, 1e-6, '第二音时值 0.25s（240BPM 一拍）');
near(p2.duration, 1.0, 1e-6, '总时长 1.0s');

/* ---------- 3. 工具函数 ---------- */
console.log('\n[3] 工具函数');
ok(TD.util.midiToName(60) === 'C4', 'midiToName(60) = C4', TD.util.midiToName(60));
ok(TD.util.midiToName(21) === 'A0', 'midiToName(21) = A0', TD.util.midiToName(21));
ok(TD.util.rgba('#ff0000', 0.5) === 'rgba(255,0,0,0.5)', 'rgba 转换', TD.util.rgba('#ff0000', 0.5));
ok(TD.util.lowerBound([{ t: 1 }, { t: 3 }, { t: 5 }], 3, function (x) { return x.t; }) === 1, 'lowerBound');
ok(TD.util.formatTime(75.5) === '01:15.500', 'formatTime', TD.util.formatTime(75.5));

/* ---------- 4. 小节偏移换算 ---------- */
console.log('\n[4] 小节偏移换算');
const bt = [0, 2, 4, 6, 8];           // 120BPM 4/4：每小节 2 秒
const track = { barTimes: bt, barSeconds: 2, offsetBars: 0 };
ok(TD.util.trackOffsetSeconds(track) === 0, '偏移 0 小节 → 0 秒');
track.offsetBars = 1;
ok(TD.util.trackOffsetSeconds(track) === 2, '+1 小节 → 2 秒', TD.util.trackOffsetSeconds(track));
track.offsetBars = 3;
ok(TD.util.trackOffsetSeconds(track) === 6, '+3 小节 → 6 秒', TD.util.trackOffsetSeconds(track));
track.offsetBars = -2;
ok(TD.util.trackOffsetSeconds(track) === -4, '-2 小节 → -4 秒（提前）', TD.util.trackOffsetSeconds(track));
track.offsetBars = 7;                 // 超出已知小节线 → 按平均小节长外推
ok(TD.util.trackOffsetSeconds(track) === 14, '+7 小节外推 → 14 秒', TD.util.trackOffsetSeconds(track));
track.offsetBars = 0.5;
ok(Math.abs(TD.util.trackOffsetSeconds(track) - 1) < 1e-9, '半小节 → 1 秒（线性插值）');

// 变速时按真实小节线换算，而不是简单乘法
const vt = { barTimes: [0, 2, 6, 8], barSeconds: 2, offsetBars: 2 };
ok(TD.util.trackOffsetSeconds(vt) === 6, '变速曲目 +2 小节 → 6 秒（用真实小节线）',
  TD.util.trackOffsetSeconds(vt));
vt.offsetBars = 3;
ok(TD.util.trackOffsetSeconds(vt) === 8, '变速曲目 +3 小节 → 8 秒', TD.util.trackOffsetSeconds(vt));

// 没有小节线信息时退回平均小节长
const bare = { barTimes: [], barSeconds: 2.5, offsetBars: 4 };
ok(TD.util.trackOffsetSeconds(bare) === 10, '无小节线 → 按平均小节长 2.5s × 4 = 10s',
  TD.util.trackOffsetSeconds(bare));
ok(TD.util.trackOffsetSeconds({ offsetBars: 0 }) === 0, '偏移为 0 时不依赖任何小节信息');

console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
process.exit(fails ? 1 : 0);
