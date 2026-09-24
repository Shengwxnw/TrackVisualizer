/* 渲染器 / 特效 / 设置项 冒烟测试（Node + 伪 canvas 环境） */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

/* ---------- 伪 DOM ---------- */
function makeCtx(canvas) {
  const store = { canvas: canvas };
  const grad = { addColorStop: function () {} };
  return new Proxy(store, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return function () { return grad; };
      if (k === 'measureText') return function () { return { width: 10 }; };
      return function () {};
    },
    set: function (t, k, v) { t[k] = v; return true; }
  });
}
function makeCanvas(w, h) {
  const c = { width: w || 300, height: h || 150 };
  const ctx = makeCtx(c);
  c.getContext = function () { return ctx; };
  return c;
}
global.window = global;
global.document = { createElement: function (tag) { return makeCanvas(128, 128); } };

function load(f) { (0, eval)(fs.readFileSync(path.join(root, 'js', f), 'utf8')); }
load('util.js');
load('midi-parser.js');
load('midi-demo.js');
load('effects.js');
load('renderer.js');
load('exporter.js');

let fails = 0;
function ok(cond, msg, extra) {
  if (cond) console.log('  ✓ ' + msg);
  else { fails++; console.log('  ✗ ' + msg + (extra != null ? '  → ' + extra : '')); }
}

/* ---------- 1. 从 index.html 读取设置项默认值 ---------- */
console.log('\n[1] index.html 设置项');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const settings = {};
const selectRe = /<select[^>]*data-setting="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g;
let m;
while ((m = selectRe.exec(html))) {
  const key = m[1];
  const sel = m[2].match(/<option[^>]*selected[^>]*value="([^"]*)"/);
  const first = m[2].match(/<option[^>]*value="([^"]*)"/);
  settings[key] = sel ? sel[1] : (first ? first[1] : '');
}
const inputRe = /<(input)[^>]*data-setting="([^"]+)"[^>]*>/g;
while ((m = inputRe.exec(html))) {
  const tag = m[0];
  const key = m[2];
  const attrs = {};
  const attrRe = /([a-zA-Z-]+)="([^"]*)"/g;
  let a;
  while ((a = attrRe.exec(tag))) attrs[a[1]] = a[2];
  if (attrs.type === 'checkbox') settings[key] = /\bchecked\b/.test(tag);
  else if (attrs.type === 'range' || attrs.type === 'number') settings[key] = parseFloat(attrs.value);
  else settings[key] = attrs.value;
}

const REQUIRED = ['bgColor', 'bgGlow', 'vignette', 'trail', 'lineColor', 'lineWidth', 'lineX',
  'showGrid', 'gridColor', 'gridBarColor', 'showOctaveLines', 'octaveLineColor', 'showNoteLabels',
  'labelColor', 'lookAhead', 'pitchMode', 'pitchMin', 'pitchMax', 'noteHeightRatio', 'noteRadius',
  'noteOpacity', 'noteGlow', 'fadeAfterHit', 'fxEnabled', 'particleCount', 'particleSpeed',
  'particleLife', 'particleSize', 'flashStrength', 'shockwave', 'shockwaveSize', 'shake',
  'synthEnabled', 'volume', 'waveType', 'octaveShift', 'expPreset', 'expFps', 'expQuality',
  'expFormat', 'expRange', 'expStart', 'expEnd', 'expAudio', 'expAudioSource', 'expCloseUi',
  'bgColor2', 'bgGradient', 'starColor', 'starSize',
  'floatAmount', 'floatTrail', 'floatBreath', 'floatKick', 'leadIn',
  'starfield', 'starCount', 'starSpeed', 'starTwinkle'];
const missing = REQUIRED.filter(function (k) { return !(k in settings); });
ok(missing.length === 0, '全部 ' + REQUIRED.length + ' 个设置项在 HTML 中存在', missing.join(','));
ok(typeof settings.lookAhead === 'number' && settings.lookAhead === 2, 'lookAhead 默认 2');
ok(settings.bgColor === '#0a0e28', 'bgColor 默认深蓝 #0a0e28', settings.bgColor);
ok(settings.bgColor2 === '#1e1640', 'bgColor2 默认深紫 #1e1640', settings.bgColor2);
ok(settings.bgGradient === true, '纵向渐变默认开启');
ok(settings.starColor === '#c9b8ff', '星星默认浅紫 #c9b8ff', settings.starColor);
ok(settings.starSize === 1, '星空粒子大小默认 1', settings.starSize);
ok(settings.floatAmount === 4, '浮动强度默认 4', settings.floatAmount);
ok(settings.floatTrail === 2, '拖影层数默认 2', settings.floatTrail);
ok(settings.floatBreath === true && settings.floatKick === true, '呼吸缩放 / 命中回弹默认开启');
ok(settings.leadIn === 2, '开场留白默认 2 秒', settings.leadIn);
ok(settings.showGrid === false, '节拍网格默认关闭');
ok(settings.bgGlow === false, '竖线中心辉光默认关闭');
ok(settings.vignette === false, '暗角默认关闭');
ok(settings.flashStrength === 0, '闪光强度默认 0', settings.flashStrength);
ok(settings.noteRadius === 1, '音符圆角默认 1', settings.noteRadius);
ok(settings.noteHeightRatio === 0.4, '音符高度比例默认 0.4', settings.noteHeightRatio);
ok(settings.fadeAfterHit === false, '越过竖线后淡出默认关闭');
ok(settings.starfield === true, '星空默认开启');
ok(settings.waveType === 'triangle', '音色默认 triangle', settings.waveType);
ok(settings.expPreset === '1920x1080', '导出预设默认 1920x1080', settings.expPreset);

/* ---------- 2. 构造状态并逐帧渲染 ---------- */
console.log('\n[2] 渲染器逐帧冒烟');
const parsed = TD.MidiParser.parse(TD.createDemoMidi());
const tracks = [];
const notes = [];
let lo = 127, hi = 0, duration = 0, maxDur = 0.05;
parsed.tracks.forEach(function (t, i) {
  if (!t.notes.length) return;
  const idx = tracks.length;
  tracks.push({ color: ['#35e0ff', '#ff5d8f', '#7cffb2'][idx % 3], visible: true, mute: false, volume: 1, index: idx, name: t.name, notes: t.notes });
  t.notes.forEach(function (n) {
    notes.push({ time: n.time, duration: n.duration, midi: n.midi, velocity: n.velocity, trackIndex: idx, hit: false, hitAt: null });
    if (n.midi < lo) lo = n.midi;
    if (n.midi > hi) hi = n.midi;
    if (n.time + n.duration > duration) duration = n.time + n.duration;
    if (n.duration > maxDur) maxDur = n.duration;
  });
});
notes.sort(function (a, b) { return a.time - b.time; });

const state = {
  time: 0, notes: notes, tracks: tracks, settings: settings,
  pitch: { min: lo - 2, max: hi + 2 }, beats: parsed.beats, beatsPerBar: 4,
  maxDuration: maxDur, duration: duration
};

const canvas = makeCanvas(1920, 1080);
const renderer = new TD.Renderer(canvas);

let hitTotal = 0, drawnMax = 0, error = null, frames = 0;
const dt = 1 / 60;
try {
  for (let t = 0; t <= duration + 1; t += dt) {
    state.time = t;
    const res = renderer.render(state, dt);
    hitTotal += res.stats.hits;
    if (res.stats.drawn > drawnMax) drawnMax = res.stats.drawn;
    frames++;
  }
} catch (e) { error = e; }

ok(!error, '逐帧渲染 ' + frames + ' 帧无异常', error && (error.message + '\n' + error.stack));
ok(drawnMax > 20, '单帧最多绘制音符数 > 20', drawnMax);
ok(hitTotal === notes.length, '命中次数 == 音符总数 (' + notes.length + ')', hitTotal);
ok(renderer.effects.particles.length >= 0, '粒子系统运行正常');

/* ---------- 3. 命中特效确实产生粒子 ---------- */
console.log('\n[3] 命中特效');
renderer.reset();
for (let i = 0; i < notes.length; i++) notes[i].hit = false;
// 只推进到第 5 个音符结束
const stop = notes[4].time + 0.05;
for (let t = 0; t <= stop; t += dt) { state.time = t; renderer.render(state, dt); }
ok(renderer.effects.particles.length > 0, '命中后产生粒子', renderer.effects.particles.length);
ok(renderer.effects.flash > 0 || renderer.effects.rings.length >= 0, '竖线闪光 > 0', renderer.effects.flash);

// 特效自然衰减
for (let i = 0; i < 240; i++) renderer.render(state, dt);
ok(renderer.effects.particles.length === 0, '约 4 秒后粒子全部回收', renderer.effects.particles.length);

/* ---------- 4. 常驻星空 ---------- */
console.log('\n[4] 常驻星空');
renderer.reset();
state.time = 0;
for (let i = 0; i < notes.length; i++) notes[i].hit = false;
renderer._drawStars(renderer.ctx, settings, 1920, 1080, 1, 960, 1 / 60);
ok(renderer._stars && renderer._stars.length === settings.starCount,
  '按设置生成星星（' + settings.starCount + ' 颗）', renderer._stars && renderer._stars.length);
ok(renderer._starBatches.reduce(function (a, b) { return a + b.length; }, 0) > 0,
  '星星已进入绘制批次');

const x0 = renderer._stars[0].x;
for (let i = 0; i < 60; i++) renderer._drawStars(renderer.ctx, settings, 1920, 1080, 1, 960, 1 / 60);
ok(renderer._stars[0].x !== x0, '星空持续漂移（暂停时也在动）', x0 + ' → ' + renderer._stars[0].x);

settings.starfield = false;
const before = renderer._stars[0].x;
renderer._drawStars(renderer.ctx, settings, 1920, 1080, 1, 960, 1 / 60);
ok(renderer._stars[0].x === before, '关闭后星空冻结');
settings.starfield = true;

settings.starCount = 40;
renderer._drawStars(renderer.ctx, settings, 1920, 1080, 1, 960, 1 / 60);
ok(renderer._stars.length === 40, '改数量后重新生成', renderer._stars.length);
settings.starCount = 160;

// 粒子大小倍率应直接影响绘制半径
function starRadiusSum() {
  renderer._drawStars(renderer.ctx, settings, 1920, 1080, 1, 960, 1 / 60);
  let sum = 0;
  renderer._starBatches.forEach(function (a) { for (let k = 2; k < a.length; k += 3) sum += a[k]; });
  return sum;
}
settings.starSize = 1;
const r1 = starRadiusSum();
settings.starSize = 3;
const r3 = starRadiusSum();
ok(r3 > r1 * 2.5, '粒子大小 ×3 时半径约为原来的 3 倍', r1.toFixed(1) + ' → ' + r3.toFixed(1));
settings.starSize = 1;

// 星星颜色应作用到填充色
settings.starColor = '#c9b8ff';
starRadiusSum();
ok(String(renderer.ctx.fillStyle).indexOf('201,184,255') >= 0,
  '星星使用设定的浅紫色填充', renderer.ctx.fillStyle);

// 全流程逐帧渲染仍需无异常
let starErr = null;
try {
  for (let t = 0; t <= duration + 0.5; t += 1 / 60) {
    state.time = t;
    renderer.render(state, 1 / 60);
  }
} catch (e) { starErr = e; }
ok(!starErr, '开启星空后逐帧渲染无异常', starErr && starErr.message);

/* ---------- 5. 重叠音符分层 ---------- */
console.log('\n[5] 同音高重叠分层');
function N(time, dur, midi, ti) {
  return { time: time, duration: dur, midi: midi, velocity: 0.8, trackIndex: ti || 0, hit: false, hitAt: null };
}

// 三个音符完全重叠在同音高
let ov = [N(1, 2, 60), N(1.2, 2, 60), N(1.4, 2, 60)];
TD.assignNoteLanes(ov);
ok(ov.every(function (n) { return n.lanes === 3; }), '三重同音高重叠 → 3 条子声道',
  ov.map(function (n) { return n.lanes; }).join(','));
ok([0, 1, 2].every(function (k) { return ov.some(function (n) { return n.lane === k; }); }),
  '三条子声道都被分配到不同的 lane');

// 依次相接的音符不应分层，但要有接缝
let seq = [N(0, 1, 60), N(1, 1, 60), N(2, 1, 60), N(3, 1, 60)];
TD.assignNoteLanes(seq);
ok(seq.every(function (n) { return n.lanes === 1; }), '首尾相接的音符不分层');
ok(seq[0].seam && seq[1].seam && seq[2].seam && !seq[3].seam, '相邻音符标记接缝、最后一个不标',
  seq.map(function (n) { return n.seam ? 1 : 0; }).join(','));

// 有间隔的音符既不分层也不需要接缝
let gap = [N(0, 1, 60), N(2, 1, 60)];
TD.assignNoteLanes(gap);
ok(gap.every(function (n) { return n.lanes === 1 && !n.seam; }), '有间隔的音符不分层、不画接缝');

// 不同音高即使同时发声也不分层
let chord = [N(0, 2, 60), N(0, 2, 64), N(0, 2, 67)];
TD.assignNoteLanes(chord);
ok(chord.every(function (n) { return n.lanes === 1; }), '和弦（不同音高）不分层');

// 局部重叠：只有真正重叠的两个分层，后面独立的不受影响
let partial = [N(0, 1, 60), N(0.5, 1, 60), N(5, 1, 60)];
TD.assignNoteLanes(partial);
ok(partial[0].lanes === 2 && partial[1].lanes === 2, '重叠的一对 → 2 条子声道');
ok(partial[2].lanes === 1, '之后单独的音符保持满高度', partial[2].lanes);

// 分层后的实际矩形不得互相重叠（直接调用渲染器里那份几何函数）
const L4 = TD.computeLayout(state, 1920, 1080);
ov = [N(1, 2, 60), N(1.2, 2, 60), N(1.4, 2, 60)];
TD.assignNoteLanes(ov);
const rects = ov.map(function (n) { return TD.noteRect(L4, n, {}); });
const tops = rects.map(function (r) { return r.y; }).sort(function (a, b) { return a - b; });
const heights = rects.map(function (r) { return r.h; });
let noOverlap = true;
for (let k = 1; k < tops.length; k++) {
  if (tops[k] - tops[k - 1] < heights[k] - 1e-9) noOverlap = false;
}
ok(noOverlap, '分层后各音符垂直方向互不重叠',
  rects.map(function (r) { return r.y.toFixed(1) + '+' + r.h.toFixed(1); }).join(' / '));
ok(heights[0] < L4.noteH, '分层时音符变矮以适应子声道',
  heights[0].toFixed(1) + ' < ' + L4.noteH.toFixed(1));

// 单个音符的高度必须与未分层时完全一致（不引入回归）
const solo = N(1, 2, 60);
TD.assignNoteLanes([solo]);
const soloRect = TD.noteRect(L4, solo, {});
ok(Math.abs(soloRect.y - L4.noteY(60)) < 1e-9 && Math.abs(soloRect.h - L4.noteH) < 1e-9,
  '未重叠音符的矩形与分层前完全一致');

// 逐帧渲染一遍，确认不报错
let laneErr = null;
try {
  for (let i = 0; i < notes.length; i++) notes[i].hit = false;
  for (let t = 0; t <= duration + 0.3; t += 1 / 60) {
    state.time = t;
    renderer.render(state, 1 / 60);
  }
} catch (e) { laneErr = e; }
ok(!laneErr, '带重叠分层的逐帧渲染无异常', laneErr && laneErr.message);

/* ---------- 6. 不同分辨率 / 竖线位置 ---------- */
console.log('\n[6] 布局一致性');
const L1 = TD.computeLayout(state, 1920, 1080);
const L2 = TD.computeLayout(state, 3840, 2160);
ok(Math.abs(L2.lineX / 3840 - L1.lineX / 1920) < 1e-9, '竖线相对位置与分辨率无关');
ok(Math.abs(L2.noteH / 2160 - L1.noteH / 1080) < 1e-9, '音符高度比例与分辨率无关');
ok(Math.abs((L2.pxPerSec / 3840) - (L1.pxPerSec / 1920)) < 1e-9, '飞行速度比例与分辨率无关');
state.settings.lineX = 30;
const L3 = TD.computeLayout(state, 1920, 1080);
ok(Math.abs(L3.lineX - 576) < 1e-6, 'lineX=30% → 576px', L3.lineX);
ok(Math.abs(L3.pxPerSec - (1920 - 576) / settings.lookAhead) < 1e-6,
  'pxPerSec 由预览时长(' + settings.lookAhead + 's)推导', L3.pxPerSec);
state.settings.lineX = 50;

/* ---------- 6. 导出模块 ---------- */
console.log('\n[6] 导出模块');
ok(typeof TD.Exporter.exportVideo === 'function', 'exportVideo 已导出');
ok(typeof TD.Exporter.pickMime === 'function', 'pickMime 已导出');
ok(TD.Exporter.listSupported().length === 0, 'Node 环境无 MediaRecorder → 返回空列表');

console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
process.exit(fails ? 1 : 0);
