// 真实成员实测：同一位成员的两个会话同时在跑时，冲着其中一张任务卡说的话只进那张卡的会话。会消耗真实额度。
// 用法：node test/real-parallel-inject.mjs <项目id> <成员名> <任务卡A> <任务卡B>
const [pid, agent, A, B] = process.argv.slice(2);
const base = `http://127.0.0.1:${process.env.PORT ?? 7788}/api/p/${pid}`;
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
const state = async () => (await fetch(`${base}/state`)).json();
const say = async (text, taskId) => (await (await fetch(`${base}/say`, { method: 'POST', headers: { 'X-Workgroup': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text, taskId }) })).json()).msg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a1 = await say(`@${agent} 并行插话测试：请运行 \`sleep 25; echo ok\`，结束后只回复“${A} 完成”。不用改任务卡。`, A);
const b1 = await say(`@${agent} 并行插话测试：请运行 \`sleep 25; echo ok\`，结束后只回复“${B} 完成”。不用改任务卡。`, B);
console.log(at(), `分别冲着 ${A} 和 ${B} 发了一条（#${a1.id}、#${b1.id}）`);
for (;;) {
  const s = await state();
  const mine = Object.values(s.activity).filter((x) => x.agent === agent && x.kind === 'cmd' && /sleep/.test(x.text));
  if (mine.length >= 2) { console.log(at(), `@${agent} 有 ${mine.length} 个会话同时在跑 sleep：${mine.map((x) => x.taskId).join('、')}`); break; }
  if (Date.now() - t0 > 120000) { console.log(at(), '两分钟内没有等到两个会话同时在跑'); process.exit(1); }
  await sleep(700);
}
await sleep(1500);
const a2 = await say(`@${agent} 补充：回复的最后一行请写“这句只说给 ${A}”。`, A);
console.log(at(), `冲着 ${A} 又说了一句（#${a2.id}）`);
let last = '';
for (;;) {
  const s = await state();
  const w = (s.wakesByMsg[a2.id] ?? [])[0];
  const sig = w ? `${w.state}｜${w.note}` : '（还没有唤醒单）';
  if (sig !== last) { console.log(at(), `这句话的送达状态：${sig}`); last = sig; }
  const busy = Object.values(s.activity).some((x) => x.agent === agent) || s.wakes.some((x) => x.target === agent && ['queued', 'delivered', 'accepted'].includes(x.state));
  if (!busy) {
    const replies = s.messages.filter((m) => m.id > a1.id && m.sender === agent);
    for (const r of replies) console.log('   ', `［${r.taskId}］`, JSON.stringify(r.text.slice(0, 120)));
    const ra = replies.find((r) => r.taskId === A), rb = replies.find((r) => r.taskId === B);
    const ok = replies.length === 2 && ra && rb && ra.text.includes(`这句只说给 ${A}`) && !rb.text.includes('这句只说给');
    console.log(ok ? `结论：补充的那句话只进了 ${A} 的会话，${B} 的会话没受影响。` : '结论：和预期不一致，见上面的记录。');
    break;
  }
  if (Date.now() - t0 > 240000) { console.log(at(), '超过四分钟还没结束'); break; }
  await sleep(700);
}
