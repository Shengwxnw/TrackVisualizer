/* 小节偏移的浏览器端验证：
   直接操作界面上的数字输入框，确认偏移真的写进了轨道并改变了音符时间 */
(function () {
  const st = TD.app.state;
  if (!st.tracks.length) return { error: '没有轨道，请先加载示例' };

  const tr = st.tracks[st.tracks.length - 1];   // 旋律轨
  const firstTime = function () {
    let t = Infinity;
    for (let i = 0; i < st.notes.length; i++) {
      if (st.notes[i].trackIndex === tr.index) { t = st.notes[i].time; break; }
    }
    return t;
  };
  const before = firstTime();
  const barSec = tr.barSeconds;

  // 找到该轨的偏移数字输入框并模拟输入
  const items = document.querySelectorAll('#trackList .track-item');
  const row = items[items.length - 1];
  const num = row.querySelector('.offset-num');
  const val = row.querySelector('.val');
  num.value = '3';
  num.dispatchEvent(new Event('input', { bubbles: true }));

  const after = firstTime();
  const shown = val.textContent;
  const barsNow = tr.offsetBars;

  // 再试负数
  num.value = '-2';
  num.dispatchEvent(new Event('input', { bubbles: true }));
  const negShift = firstTime();

  // 复位
  num.value = '0';
  num.dispatchEvent(new Event('input', { bubbles: true }));

  return {
    barSec: +barSec.toFixed(4),
    barsApplied: barsNow,
    before: +before.toFixed(4),
    afterPlus3: +after.toFixed(4),
    deltaPlus3: +(after - before).toFixed(4),
    deltaMinus2: +(negShift - before).toFixed(4),
    secondsLabel: shown,
    offsetBarsReset: tr.offsetBars
  };
})()
