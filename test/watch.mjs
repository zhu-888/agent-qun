// 观察一个项目的真实运行过程：把新消息、任务状态变化、成员正在跑的命令打印出来。
// 用法：node test/watch.mjs <项目id> [最长分钟数]
// 根任务进入“待群主验收/已完成”，或者队列空闲超过 90 秒，就退出。
const [id, maxMin = '30'] = process.argv.slice(2);
const base = `http://127.0.0.1:${process.env.PORT ?? 7788}`;
const t0 = Date.now();
const hhmmss = () => new Date().toTimeString().slice(0, 8);
let lastMsg = 0;
const taskState = {};
const actText = {};
let idleSince = null;

for (;;) {
  let s;
  try { s = await (await fetch(`${base}/api/p/${id}/state`)).json(); } catch (e) { console.log(hhmmss(), '工作台没响应', e.message); break; }
  for (const m of s.messages) {
    if (m.id <= lastMsg) continue;
    lastMsg = m.id;
    const wakes = (s.wakesByMsg[m.id] ?? []).map((w) => `${w.target}:${w.state}`).join(' ');
    console.log(`${hhmmss()} 消息#${m.id} [${m.sender}] ${m.text.replace(/\s+/g, ' ').slice(0, 300)}${m.files.length ? ' 〔' + m.files.map((f) => f.path).join('、') + '〕' : ''}${wakes ? ' → ' + wakes : ''}`);
  }
  for (const t of s.tasks) {
    const sig = `${t.stateLabel}|${t.owner}|${t.stepAt}/${t.stepTotal} ${t.stepText}`;
    if (taskState[t.id] !== sig) {
      taskState[t.id] = sig;
      console.log(`${hhmmss()} 任务 ${t.id}「${t.title}」→ ${t.stateLabel}（负责 ${t.owner}，审查 ${t.reviewer ?? '无'}）${t.stepText ? ' 进度：' + t.stepAt + '/' + t.stepTotal + ' ' + t.stepText : ''}`);
    }
  }
  for (const act of Object.values(s.activity)) {      // 一位成员可能同时有几个会话，按运行号区分
    const sig = `${act.kind}|${act.text}`;
    if (actText[act.runId] !== sig) { actText[act.runId] = sig; console.log(`${hhmmss()}   @${act.agent}［${act.taskId ?? (act.kind === 'summary' ? '群摘要' : '日常对话')}］（${act.model}）${act.kind === 'cmd' ? '运行：' : ''}${String(act.text).replace(/\s+/g, ' ').slice(0, 150)}`); }
  }
  const roots = s.tasks.filter((t) => !t.parent);
  const busy = Object.keys(s.activity).length > 0 || s.wakes.some((w) => ['queued', 'delivered', 'accepted'].includes(w.state));
  if (roots.length && roots.every((t) => ['awaiting_owner', 'done', 'cancelled'].includes(t.state)) && !busy) { console.log(hhmmss(), `所有根任务都已到「待群主验收」或已结束，观察结束。用时 ${Math.round((Date.now() - t0) / 1000)} 秒`); break; }
  if (!busy) { idleSince ??= Date.now(); if (Date.now() - idleSince > 90000) { console.log(hhmmss(), '队列已空闲 90 秒，观察结束。未结束的唤醒：', JSON.stringify(s.wakes.filter((w) => !['done'].includes(w.state)))); break; } }
  else idleSince = null;
  if (Date.now() - t0 > Number(maxMin) * 60000) { console.log(hhmmss(), '到达最长观察时间'); break; }
  await new Promise((r) => setTimeout(r, 2500));
}
