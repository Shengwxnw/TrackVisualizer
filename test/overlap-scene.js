/* 重叠场景注入脚本：由 browser-test.js 通过 TD_EVAL_FILE 执行
   构造三类典型冲突，用于肉眼验证分层与接缝效果：
   1) 三个不同轨道的同音高长音完全重叠
   2) 同轨同音高的连续音（首尾相接，应出现接缝）
   3) 正常和弦（不同音高，不应被分层） */
(function () {
  const st = TD.app.state;
  const mk = (color, name, notes) => ({
    color: color, visible: true, mute: true, volume: 1, offset: 0,
    notes: notes, noteCount: notes.length, name: name
  });
  const n = (time, dur, midi, ti) => ({ time: time, duration: dur, midi: midi, velocity: 0.9, channel: 0, trackIndex: ti });

  // 轨道 A：同音高重叠（三个音在同一音高 60 上叠着）
  const A = [
    n(2.0, 3.2, 60, 0),
    n(10.0, 2.0, 72, 0)
  ];
  // 轨道 B：与 A 同音高、部分重叠
  const B = [
    n(2.4, 2.4, 60, 1),
    n(10.2, 1.2, 74, 1)
  ];
  // 轨道 C：再叠一层
  const C = [
    n(2.8, 2.6, 60, 2),
    n(10.4, 1.4, 76, 2)
  ];
  // 轨道 D：同轨连续音（应出现接缝）
  const D = [
    n(2.0, 0.5, 48, 3), n(2.5, 0.5, 48, 3), n(3.0, 0.5, 48, 3),
    n(3.5, 0.5, 48, 3), n(4.0, 0.5, 48, 3), n(4.5, 0.5, 48, 3),
    n(10.0, 0.4, 55, 3), n(10.4, 0.4, 55, 3), n(10.8, 0.4, 55, 3)
  ];

  st.tracks.length = 0;
  st.tracks.push(mk('#8fb0d6', 'A 同音高长音', A));
  st.tracks.push(mk('#d69a9a', 'B 同音高重叠', B));
  st.tracks.push(mk('#9ecfa8', 'C 同音高重叠', C));
  st.tracks.push(mk('#d9c48d', 'D 同轨连续音', D));
  TD.app.rebuild();
  TD.app.seek(3.6);
  TD.app.pause();
  return st.notes.length;
})()
