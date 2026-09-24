/* ============================================================
 * 浏览器端到端验证（CDP，无第三方依赖）
 * 启动 Edge headless → 打开页面 → 收集控制台错误 →
 * 读取 canvas 像素 → 截图
 * 用法: node test/browser-test.js [url]
 * ==========================================================*/
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = process.env.TD_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'td-cdp-profile-' + Date.now());
const URL_ = process.env.TD_URL || process.argv[2] || ('file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') + '?demo=1&play=1&t=4');
const SHOT = path.join(__dirname, 'shot.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--disable-extensions', '--mute-audio',
    '--window-size=1600,900',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    URL_
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await res.json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (e) { /* 还没起来 */ }
  }
  if (!target) { console.error('无法连接浏览器调试端口'); child.kill(); process.exit(2); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const errors = [];
  const logs = [];

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value != null ? String(a.value) : (a.description || a.type)).join(' ');
      logs.push(msg.params.type + ': ' + text);
      if (msg.params.type === 'error') errors.push(text);
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      logs.push('log/' + e.level + ': ' + e.text);
      if (e.level === 'error') errors.push(e.text + ' @ ' + (e.url || ''));
    }
  });

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  await sleep(2600); // 让播放跑一会儿

  // 压力模式：注入大量音符后测量帧率
  const STRESS = process.env.TD_STRESS === '1' || process.argv.includes('--stress');
  if (STRESS) {
    const inject = `(() => {
      const st = TD.app.state;
      st.tracks.length = 0;
      const N = 24, PER = 900;
      for (let t = 0; t < N; t++) {
        const notes = [];
        let time = 0;
        for (let i = 0; i < PER; i++) {
          time += Math.random() * 0.06;
          notes.push({ time: time, duration: 0.08 + Math.random() * 0.4, midi: 30 + Math.floor(Math.random() * 70), velocity: 0.5 + Math.random() * 0.5, channel: 0, trackIndex: t });
        }
        st.tracks.push({ color: ['#35e0ff','#ff5d8f','#7cffb2','#ffd166'][t % 4], visible: true, mute: true, volume: 1, offset: 0, notes: notes, noteCount: notes.length, name: 'stress' + t });
      }
      TD.app.rebuild();
      TD.app.play();
      return TD.app.state.notes.length;
    })()`;
    const inj = await send('Runtime.evaluate', { expression: inject, returnByValue: true });
    console.log('注入音符: ' + inj.result.value);
    await sleep(1000);
    const f0 = await send('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true });
    const t0 = f0.result.value;
    await sleep(4000);
    const f1 = await send('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true });
    const fps = await send('Runtime.evaluate', { expression: "document.getElementById('hudFps').textContent", returnByValue: true });
    const parts = await send('Runtime.evaluate', { expression: "document.querySelectorAll('.toast').length + '|' + TD.app.state.notes.length", returnByValue: true });
    console.log('压力测试：' + ((f1.result.value - t0) / 1000).toFixed(1) + 's 内 → HUD 帧率 ' + fps.result.value + '  (音符 ' + parts.result.value + ')');
  }

  const probe = `(() => {
    const c = document.getElementById('stageCanvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0, maxSum = 0, samples = 0;
    const hist = {};
    for (let i = 0; i < d.length; i += 4 * 37) {
      samples++;
      const s = d[i] + d[i+1] + d[i+2];
      if (s > 60) nonBg++;
      if (s > maxSum) maxSum = s;
      const key = (d[i]>>5) + ',' + (d[i+1]>>5) + ',' + (d[i+2]>>5);
      hist[key] = (hist[key] || 0) + 1;
    }
    const st = window.TD && TD.app ? TD.app.state : null;
    return {
      canvas: [c.width, c.height],
      css: [c.clientWidth, c.clientHeight],
      samples, nonBg, maxSum,
      topColors: Object.entries(hist).sort((a,b)=>b[1]-a[1]).slice(0,6),
      notes: st ? st.notes.length : -1,
      time: st ? +st.time.toFixed(3) : -1,
      duration: st ? +st.duration.toFixed(3) : -1,
      tracks: st ? st.tracks.length : -1,
      playing: st ? st.playing : null,
      particles: window.TD && TD.app ? null : null,
      fps: document.getElementById('hudFps') ? document.getElementById('hudFps').textContent : null,
      hudTime: document.getElementById('hudTime') ? document.getElementById('hudTime').textContent : null,
      rendererStats: (function(){ try { return null; } catch(e){ return String(e); } })()
    };
  })()`;

  let probeResult = null;
  try {
    const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: false });
    probeResult = r.result && r.result.value;
  } catch (e) { probeResult = { error: String(e) }; }

  // 截图前可插入一段自定义脚本（例如滚动侧栏到指定面板）
  let preEval = process.env.TD_EVAL || '';
  if (process.env.TD_EVAL_FILE) preEval = fs.readFileSync(process.env.TD_EVAL_FILE, 'utf8');
  if (preEval) {
    const r = await send('Runtime.evaluate', { expression: preEval, returnByValue: true });
    if (r.result && r.result.value !== undefined && process.env.TD_EVAL_QUIET !== '1') {
      console.log('eval → ' + JSON.stringify(r.result.value));
    }
    await sleep(700);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));

  // 直接把 canvas 自身的像素导出，排除合成/缩放带来的干扰
  if (process.env.TD_DUMP) {
    const r = await send('Runtime.evaluate', {
      expression: "document.getElementById('stageCanvas').toDataURL('image/png')",
      returnByValue: true
    });
    const b64 = String(r.result.value).split(',')[1];
    fs.writeFileSync(path.join(__dirname, 'canvas-dump.png'), Buffer.from(b64, 'base64'));
    console.log('canvas 原始像素已导出: test/canvas-dump.png');
  }

  console.log('=== 页面探测 ===');
  console.log(JSON.stringify(probeResult, null, 2));
  console.log('=== 控制台错误 (' + errors.length + ') ===');
  errors.slice(0, 20).forEach((e) => console.log('  ! ' + e));

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* noop */ }
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(3); });
