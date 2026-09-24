/* ============================================================
 * 性能剖析：注入大量音符后，逐项关闭特性测量帧率
 * 用法: node test/perf-test.js
 * ==========================================================*/
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = process.env.TD_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9335;
const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'td-cdp-perf-' + Date.now());
const URL_ = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') + '?demo=1';
const TRACKS = parseInt(process.env.TD_TRACKS || '24', 10);
const PER = parseInt(process.env.TD_PER || '900', 10);
const GAP = parseFloat(process.env.TD_GAP || '0.06'); // 每轨相邻音符平均间隔(秒)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--disable-extensions', '--window-size=1600,900',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, URL_
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) { /* retry */ }
  }
  if (!target) { console.error('无法连接浏览器'); child.kill(); process.exit(2); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');

  const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => r.result.value);
  await sleep(1500);

  // 注入压力数据并启动播放
  await ev(`(() => {
    const st = TD.app.state;
    st.tracks.length = 0;
    for (let t = 0; t < ${TRACKS}; t++) {
      const notes = []; let time = 0;
      for (let i = 0; i < ${PER}; i++) {
        time += Math.random() * ${GAP};
        notes.push({ time: time, duration: 0.08 + Math.random() * 0.4, midi: 30 + Math.floor(Math.random()*70), velocity: 0.6, channel: 0, trackIndex: t });
      }
      st.tracks.push({ color: ['#35e0ff','#ff5d8f','#7cffb2','#ffd166'][t%4], visible: true, mute: true, volume: 1, offset: 0, notes: notes, noteCount: notes.length, name: 's'+t });
    }
    TD.app.rebuild(); TD.app.play();
    window.__frames = 0;
    const raf = () => { window.__frames++; requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    return TD.app.state.notes.length;
  })()`);
  console.log('音符总数: ' + TRACKS + ' × ' + PER + ' = ' + (TRACKS * PER));
  await sleep(1500);

  async function measure(label, setup) {
    if (setup) await ev(setup);
    await sleep(600);
    await ev('window.__frames = 0');
    await sleep(3000);
    const f = await ev('window.__frames');
    const drawn = await ev('TD.app && window.__r ? 0 : 0');
    console.log('  ' + label.padEnd(28) + (f / 3).toFixed(1) + ' fps');
    return f / 3;
  }

  const st = 'TD.app.state.settings';
  console.log('--- 帧率剖析 ---');
  await measure('全开（默认）', '');
  await measure('关光晕 noteGlow=0', st + '.noteGlow=0');
  await measure('关光晕 + 关粒子', st + '.noteGlow=0; ' + st + '.fxEnabled=false');
  await measure('再关网格/音名/辉光/暗角', st + '.showGrid=false; ' + st + '.showOctaveLines=false; ' + st + '.showNoteLabels=false; ' + st + '.bgGlow=false; ' + st + '.vignette=false');

  const info = await ev(`(() => {
    const r = TD.app.state;
    const R = window.__r;
    return JSON.stringify({ notes: r.notes.length, time: +r.time.toFixed(2) });
  })()`);
  console.log('状态: ' + info);
  console.log('控制台错误: ' + errors.length);
  errors.slice(0, 5).forEach((e) => console.log('  ! ' + e));

  ws.close(); child.kill(); await sleep(300);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* noop */ }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(3); });
