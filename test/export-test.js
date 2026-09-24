/* ============================================================
 * 视频导出端到端验证（CDP）
 * 打开页面 → 缩短导出区间 → 触发导出 → 等待下载 → 检查产物
 * 用法: node test/export-test.js
 * ==========================================================*/
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = process.env.TD_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'td-cdp-exp-' + Date.now());
const DL = path.join(os.tmpdir(), 'td-dl-' + Date.now());
const URL_ = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') + '?demo=1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(DL, { recursive: true });
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--disable-extensions', '--window-size=1280,720',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    URL_
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
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push((msg.params.exceptionDetails.exception || {}).description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push((msg.params.args || []).map((a) => a.value || a.description).join(' '));
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');
  try {
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  } catch (e) {
    try { await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }); } catch (e2) { /* noop */ }
  }

  await sleep(1200);
  await send('Runtime.evaluate', { expression: "document.getElementById('btnDemo').click()" });
  await sleep(1200);

  console.log('--- 支持的编码 ---');
  const sup = await send('Runtime.evaluate', {
    expression: "JSON.stringify(TD.Exporter.listSupported().map(m=>m.label+' ['+m.mime+']'))",
    returnByValue: true
  });
  console.log(sup.result.value);

  // 暴露导出结果里的帧健康度
  await send('Runtime.evaluate', {
    expression: `(() => {
      const orig = TD.Exporter.exportVideo;
      TD.Exporter.exportVideo = async function (o) {
        const res = await orig(o);
        window.__lastPerf = res.perf;
        return res;
      };
      return 1;
    })()`
  });

  // 缩短导出：720p / 30fps / 0-2 秒 / 不混音频
  const setup = `(() => {
    const s = TD.app.state.settings;
    s.expPreset = '${process.env.TD_EXP_PRESET || '1280x720'}';
    s.expFps = ${process.env.TD_EXP_FPS || 30};
    s.expQuality = '${process.env.TD_EXP_QUALITY || 'low'}';
    s.expRange = 'custom'; s.expStart = 0; s.expEnd = ${process.env.TD_EXP_DUR || 2}; s.expAudio = false;
    s.expCloseUi = true;
    document.getElementById('btnExport').click();
    return 'started';
  })()`;
  const t0 = Date.now();
  const r = await send('Runtime.evaluate', { expression: setup, returnByValue: true });
  console.log('导出触发:', r.result.value, r.result.description || '');

  // 轮询进度
  let lastPct = '';
  let done = false;
  for (let i = 0; i < 120 && !done; i++) {
    await sleep(500);
    const st = await send('Runtime.evaluate', {
      expression: `JSON.stringify({p: document.getElementById('exportPercent').textContent, hidden: document.getElementById('exportOverlay').classList.contains('hidden'), exporting: TD.app.state.exporting, toast: Array.from(document.querySelectorAll('.toast')).map(t=>t.textContent).join(' | ')})`,
      returnByValue: true
    });
    const v = JSON.parse(st.result.value);
    if (v.p !== lastPct) { lastPct = v.p; console.log('  进度 ' + v.p); }
    if (v.hidden && !v.exporting) { done = true; console.log('  提示信息: ' + v.toast); }
  }

  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  await sleep(1500);

  const perf = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__lastPerf || null)', returnByValue: true });
  console.log('--- 帧健康度 ---');
  if (perf.result.value && perf.result.value !== 'null') {
    const p = JSON.parse(perf.result.value);
    console.log('  总帧数 ' + p.frames + ' · 超预算帧 ' + p.slow + ' · 最长帧 ' + Math.round(p.maxDt * 1000) + 'ms');
    if (p.slowSpots.length) {
      console.log('  掉帧位置(距开头秒/耗时ms): ' +
        p.slowSpots.slice(0, 12).map(function (s) { return s.at + 's/' + s.ms; }).join(', '));
    }
  } else {
    console.log('  (未取到)');
  }

  console.log('--- 下载目录 ---');
  const entries = fs.readdirSync(DL).map((f) => ({ name: f, size: fs.statSync(path.join(DL, f)).size }));
  entries.forEach((e) => console.log('  ' + e.name + '  ' + (e.size / 1024).toFixed(1) + ' KB'));

  const produced = entries.find((e) => /\.(webm|mp4)$/i.test(e.name));
  const size = produced ? produced.size : 0;
  console.log('\n耗时 ' + wall + 's  产物: ' + (produced ? produced.name : '无'));
  let magic = '';
  if (produced) {
    const buf = fs.readFileSync(path.join(DL, produced.name));
    magic = buf.slice(0, 8).toString('hex');
    console.log('文件头: ' + magic + (magic.startsWith('1a45dfa3') ? ' (EBML/WebM ✓)' : (buf.slice(4, 8).toString('ascii') === 'ftyp' ? ' (ISO-BMFF/MP4 ✓)' : ' (未知 ✗)')));
  }
  console.log('控制台错误: ' + errors.length);
  errors.slice(0, 10).forEach((e) => console.log('  ! ' + e));

  ws.close();
  child.kill();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* noop */ }
  process.exit(size > 1000 && !errors.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(3); });
