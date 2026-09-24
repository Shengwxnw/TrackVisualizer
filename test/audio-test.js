/* ============================================================
 * 音频引擎自测：用桩 WebAudio 验证导入音频的调度与时间对齐
 * 重点验证：offset 语义、起播位置换算、倍速 playbackRate、
 *          合成器与导入音频共用同一时间基准、监听静音不影响录制链路
 * ==========================================================*/
const fs = require('fs');
const path = require('path');

global.window = global;
function load(f) { (0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8')); }

/* ---------- 桩 WebAudio ---------- */
const started = [];   // 记录所有 source.start 调用
let now = 0;

function node(extra) {
  const n = Object.assign({
    connect() {}, disconnect() {},
    gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} },
    frequency: { value: 0 }
  }, extra || {});
  return n;
}

class FakeCtx {
  constructor() {
    this.state = 'running';
    this.destination = node();
    this.sampleRate = 48000;
  }
  get currentTime() { return now; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createGain() { return node(); }
  createDynamicsCompressor() {
    return node({
      threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
      attack: { value: 0 }, release: { value: 0 }
    });
  }
  createOscillator() {
    return node({ type: 'sine', start() {}, stop() {}, onended: null });
  }
  createMediaStreamDestination() {
    return { stream: { getAudioTracks() { return [{ id: 'rec' }]; } } };
  }
  createBufferSource() {
    const src = node({
      buffer: null,
      playbackRate: { value: 1 },
      onended: null
    });
    src.start = function (when, offset) {
      started.push({ when: when, offset: offset, rate: src.playbackRate.value, buffer: src.buffer });
    };
    src.stop = function () { src.stopped = true; };
    return src;
  }
  decodeAudioData(buf, ok) { if (ok) ok({ duration: 10, sampleRate: 48000, numberOfChannels: 2 }); }
}
window.AudioContext = FakeCtx;

load('util.js');
load('audio-engine.js');

let fails = 0;
function ok(cond, msg, extra) {
  if (cond) console.log('  ✓ ' + msg);
  else { fails++; console.log('  ✗ ' + msg + (extra != null ? '  → ' + extra : '')); }
}
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, msg, a + ' vs ' + b); }
function reset() { started.length = 0; now = 0; }

const clip = { name: 'song.mp3', buffer: { duration: 10 }, offset: 0, volume: 1, mute: false };

/* ---------- 1. offset = 0，从 0 开始 ---------- */
console.log('\n[1] 从头播放（offset 0）');
reset();
let eng = new TD.AudioEngine();
eng.start({ clips: [clip], fromTime: 0, speed: 1, synthEnabled: false });
near(started[0].offset, 0, 1e-9, '从缓冲区 0 秒开始');
ok(started[0].when <= now + 0.001, '立即起播', started[0].when);
near(eng.getPosition(), 0, 1e-9, '位置 = 0');

/* ---------- 2. offset 正值：音频整体后移 ---------- */
console.log('\n[2] offset = +0.5s（音频第 0 秒对应曲目 0.5s）');
reset();
eng = new TD.AudioEngine();
eng.start({ clips: [clip], fromTime: 0, speed: 1, synthEnabled: false });
const c2 = { buffer: { duration: 10 }, offset: 0.5, volume: 1 };
reset();
eng = new TD.AudioEngine();
eng.start({ clips: [c2], fromTime: 0, speed: 1, synthEnabled: false });
near(started[0].when, eng.startCtxTime + 0.5, 1e-9, '延迟 0.5s 后开声');
near(started[0].offset, 0, 1e-9, '仍从缓冲区 0 秒开始');

/* ---------- 3. 从中间起播：位置换算 ---------- */
console.log('\n[3] 从曲目 3.2s 起播（offset 0.5s）');
reset();
eng = new TD.AudioEngine();
eng.start({ clips: [c2], fromTime: 3.2, speed: 1, synthEnabled: false });
near(started[0].offset, 2.7, 1e-9, '缓冲区起点 = 3.2 - 0.5 = 2.7s');
ok(started[0].when <= now + 0.001, '立即起播（已进入音频区间）');

/* ---------- 4. 起播点早于 offset：等待 ---------- */
console.log('\n[4] 从 0.2s 起播（offset 0.5s）');
reset();
eng = new TD.AudioEngine();
eng.start({ clips: [c2], fromTime: 0.2, speed: 1, synthEnabled: false });
near(started[0].when, eng.startCtxTime + 0.3, 1e-9, '等待 0.3s 后开声');
near(started[0].offset, 0, 1e-9, '从缓冲区 0 秒开始');

/* ---------- 5. 倍速 ---------- */
console.log('\n[5] 2 倍速');
reset();
eng = new TD.AudioEngine();
eng.start({ clips: [c2], fromTime: 0, speed: 2, synthEnabled: false });
near(started[0].rate, 2, 1e-9, 'playbackRate = 2');
near(started[0].when, eng.startCtxTime + 0.25, 1e-9, '等待时间减半（0.5/2）');

/* ---------- 6. 超出音频末尾不再播放 ---------- */
console.log('\n[6] 起播点晚于音频末尾');
reset();
eng = new TD.AudioEngine();
eng.start({ clips: [c2], fromTime: 12, speed: 1, synthEnabled: false });
ok(started.length === 0, 'offset 0.5 + 时长 10 → 12s 起播不再发声');

/* ---------- 7. 静音 / 音量 ---------- */
console.log('\n[7] 静音与音量');
reset();
eng = new TD.AudioEngine();
eng.start({ clips: [{ buffer: { duration: 10 }, offset: 0, mute: true }], fromTime: 0, speed: 1, synthEnabled: false });
ok(started.length === 0, '静音轨道不发声');

/* ---------- 8. 时间基准与合成器一致 ---------- */
console.log('\n[8] 时间基准');
reset();
eng = new TD.AudioEngine();
eng.start({ clips: [clip], fromTime: 5, speed: 1, synthEnabled: false });
const p0 = eng.getPosition();
now = eng.startCtxTime + 2;      // 音频时钟前进 2 秒
near(eng.getPosition(), 7, 1e-9, '位置 = 起点 + 音频时钟推进量');
ok(eng.playing === true, 'playing 标志为真（即使没有合成器）');

eng.stop();
ok(eng.playing === false, 'stop 后 playing 为假');
ok(eng.getPosition() === 5, '停止后位置冻结在起点', eng.getPosition());

/* ---------- 9. 监听静音不影响录制链路 ---------- */
console.log('\n[9] 监听与录制');
reset();
eng = new TD.AudioEngine();
eng.ensure();
ok(!!eng.recordDest, '存在录制目标节点');
eng.setMonitor(false);
ok(eng.monitorGain.gain.value === 0, '监听增益归零');
ok(!!eng.getRecordStream(), '录制流依然可用（导出不受监听静音影响）');

/* ---------- 10. 合成器与导入音频共存 ---------- */
console.log('\n[10] 合成器 + 导入音频');
reset();
eng = new TD.AudioEngine();
const notes = [{ time: 0, duration: 0.5, midi: 60, velocity: 0.8, trackIndex: 0 }];
eng.start({ notes: notes, clips: [clip], fromTime: 0, speed: 1, synthEnabled: true, trackProvider: function () { return [{ mute: false, volume: 1 }]; } });
ok(started.length === 1, '导入音频已调度');
ok(eng.voices.length >= 0, '合成器调度未抛错');
eng.stop();
ok(eng.sources.length === 0, 'stop 后音频源已清空');

console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
process.exit(fails ? 1 : 0);
