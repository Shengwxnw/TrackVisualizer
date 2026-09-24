/* ============================================================
 * 导入音频端到端验证（CDP）
 * 1. 在页面里构造一个真实 WAV 文件并走 <input type=file> 导入
 * 2. 校验解码、时间轴延长、偏移调整、播放调度
 * 3. 以「仅导入音频」导出视频，检查产物里确实带音轨（mp4a）
 * 用法: node test/audio-e2e-test.js
 * ==========================================================*/
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = process.env.TD_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9336;
const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'td-cdp-audio-' + Date.now());
const DL = path.join(os.tmpdir(), 'td-dl-audio-' + Date.now());
const URL_ = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') + '?demo=1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 生成一段 3 秒 440Hz WAV ---------- */
function makeWav(seconds, rate, freq) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 12000), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let fails = 0;
function ok(cond, msg, extra) {
  if (cond) console.log('  ✓ ' + msg);
  else { fails++; console.log('  ✗ ' + msg + (extra != null ? '  → ' + extra : '')); }
}

async function main() {
  fs.mkdirSync(DL, { recursive: true });
  const wav = makeWav(3, 8000, 440);
  const b64 = wav.toString('base64');

  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--disable-extensions', '--window-size=1280,720',
    '--autoplay-policy=no-user-gesture-required',
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
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push((m.params.args || []).map((a) => a.value || a.description).join(' '));
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    .then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; });

  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  try { await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true }); } catch (e) { /* noop */ }

  await sleep(1200);
  await ev("document.getElementById('btnDemo').click()");
  await sleep(800);

  console.log('\n[1] 导入音频文件');
  const inject = `(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([arr], 'tone440.wav', { type: 'audio/wav' }));
    const input = document.getElementById('audioInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    for (let i = 0; i < 60 && TD.app.state.clips.length === 0; i++) await new Promise(r => setTimeout(r, 100));
    const c = TD.app.state.clips[0];
    return c ? { n: TD.app.state.clips.length, name: c.name, dur: c.buffer.duration, rate: c.buffer.sampleRate, ch: c.buffer.numberOfChannels } : null;
  })()`;
  const clip = await ev(inject);
  ok(clip && clip.n === 1, '音频导入成功', JSON.stringify(clip));
  ok(clip && Math.abs(clip.dur - 3) < 0.01, '解码时长 ≈ 3s', clip && clip.dur);
  ok(clip && clip.name === 'tone440.wav', '文件名保留', clip && clip.name);

  console.log('\n[2] 偏移与时间轴');
  const base = await ev('TD.app.state.duration');
  const lead = await ev('TD.app.state.settings.leadIn || 0');
  const dur2 = await ev('TD.app.state.clips[0].offset = 20; TD.app.updateTimeline(); TD.app.state.duration');
  const expect2 = lead + 20 + clip.dur;
  ok(Math.abs(dur2 - expect2) < 0.01,
    'offset=20s → 留白 ' + lead + 's + 20s + 音频 ' + clip.dur + 's = ' + expect2.toFixed(1) + 's',
    dur2 + '（原 ' + base + '）');
  const dur3 = await ev('TD.app.state.clips[0].offset = 0; TD.app.updateTimeline(); TD.app.state.duration');
  ok(Math.abs(dur3 - base) < 0.01, 'offset 归零后恢复', dur3);

  console.log('\n[3] 播放调度');
  // 顺手截一张带音频面板的图
  await ev(`(() => {
    const p=[...document.querySelectorAll('details.panel')];
    p.forEach((d,i)=>{ d.open = (i===6 || i===7); });
    document.querySelector('.scroll').scrollTop=0;
    TD.app.seek(2); TD.app.play();
    return 1;
  })()`);
  await sleep(900);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'shot-audio.png'), Buffer.from(shot.data, 'base64'));
  const playInfo = await ev(`(async () => {
    TD.app.seek(0); TD.app.play();
    await new Promise(r => setTimeout(r, 500));
    const t1 = TD.app.state.time;
    await new Promise(r => setTimeout(r, 700));
    const t2 = TD.app.state.time;
    return { t1: t1, t2: t2, sources: window.__audio ? 0 : 0 };
  })()`);
  ok(playInfo.t1 >= 0 && playInfo.t2 > playInfo.t1, '播放推进：' + playInfo.t1.toFixed(2) + 's → ' + playInfo.t2.toFixed(2) + 's');

  const plan = await ev("JSON.stringify(TD.app.resolveExportAudio())");
  console.log('  导出音源计划: ' + plan);

  console.log('\n[4] 以导入音频导出（静音合成器）');
  await ev(`(() => {
    const s = TD.app.state.settings;
    s.expPreset='1280x720'; s.expFps=30; s.expQuality='low';
    s.expRange='custom'; s.expStart=0; s.expEnd=2;
    s.expAudio=true; s.expAudioSource='import'; s.expCloseUi=true;
    TD.app.pause();
    document.getElementById('btnExport').click();
    return 1;
  })()`);

  let done = false, toastText = '';
  for (let i = 0; i < 100 && !done; i++) {
    await sleep(500);
    const st = JSON.parse(await ev(`JSON.stringify({
      hidden: document.getElementById('exportOverlay').classList.contains('hidden'),
      exporting: TD.app.state.exporting,
      toast: Array.from(document.querySelectorAll('.toast')).map(t=>t.textContent).join(' | ')
    })`));
    if (st.hidden && !st.exporting) { done = true; toastText = st.toast; }
  }
  await sleep(1200);

  const files = fs.readdirSync(DL).filter((f) => /\.(mp4|webm)$/i.test(f));
  ok(files.length === 1, '产出 1 个视频文件', files.join(','));
  ok(/含音频/.test(toastText), '提示信息标注「含音频」', toastText.slice(-60));

  let hasAudioBox = false, size = 0;
  if (files.length) {
    const buf = fs.readFileSync(path.join(DL, files[0]));
    size = buf.length;
    hasAudioBox = buf.includes(Buffer.from('mp4a')) || buf.includes(Buffer.from('Opus')) || buf.includes(Buffer.from('opus'));
    console.log('  文件: ' + files[0] + '  ' + (size / 1024).toFixed(1) + ' KB');
  }
  ok(hasAudioBox, '视频容器内存在音频轨（mp4a/Opus）');

  console.log('\n控制台错误: ' + errors.length);
  errors.slice(0, 8).forEach((e) => console.log('  ! ' + e));
  ok(errors.length === 0, '无控制台错误');

  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  ws.close(); child.kill();
  await sleep(300);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* noop */ }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(3); });
