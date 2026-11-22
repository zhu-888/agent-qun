// 真实成员的“运行中插话”实测：先让成员跑一条要等一会儿的命令，等它跑起来后再 @ 它一次，
// 看第二条消息是不是直接进了它正在进行的会话。会消耗该成员的真实额度。
// 用法：node test/real-inject.mjs <项目id> <成员名>
const [pid, agent] = process.argv.slice(2);
const base = `http://127.0.0.1:${process.env.PORT ?? 7788}/api/p/${pid}`;
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
const state = async () => (await fetch(`${base}/state`)).json();
const say = async (text) => (await (await fetch(`${base}/say`, { method: 'POST', headers: { 'X-Workgroup': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text, asTask: false }) })).json()).msg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = await state();
const runsBefore = before.runs.filter((r) => r.agent === agent).length;
const m1 = await say(`@${agent} 这是“运行中插话”的功能测试，不用建任务卡。请运行命令 \`sleep 25; echo 好了\`，等它结束后回复“睡醒了”。`);
console.log(at(), `发出第 1 条 #${m1.id}`);

// 等它真的开始跑那条命令
for (;;) {
  const s = await state();
  const act = Object.values(s.activity).find((a) => a.agent === agent && a.kind === 'cmd' && /sleep/.test(a.text));
  if (act?.kind === 'cmd' && /sleep/.test(act.text)) { console.log(at(), `@${agent} 正在运行：${act.text.slice(0, 60)}`); break; }
  if (Date.now() - t0 > 120000) { console.log(at(), '等了两分钟它还没开始跑命令，放弃'); process.exit(1); }
  await sleep(700);
}
await sleep(1500);
const m2 = await say(`@${agent} 补充一句：回复的最后一行请写“插话已读”。`);
console.log(at(), `发出第 2 条 #${m2.id}（这时它还在跑 sleep）`);

let last = '';
for (;;) {
  const s = await state();
  const w = (s.wakesByMsg[m2.id] ?? [])[0];
  const sig = w ? `${w.state}｜${w.note}` : '（还没有唤醒单）';
  if (sig !== last) { console.log(at(), `第 2 条的送达状态：${sig}`); last = sig; }
  const busy = Object.values(s.activity).some((a) => a.agent === agent) || s.wakes.some((x) => x.target === agent && ['queued', 'delivered', 'accepted'].includes(x.state));
  if (!busy) {
    const runs = s.runs.filter((r) => r.agent === agent).length - runsBefore;
    const replies = s.messages.filter((m) => m.id > m1.id && m.sender === agent);
    console.log(at(), `结束。这期间 @${agent} 一共运行了 ${runs} 次，回复了 ${replies.length} 条：`);
    for (const r of replies) console.log('   ', JSON.stringify(r.text.slice(0, 200)));
    const ok = runs === 1 && replies.some((r) => /睡醒了/.test(r.text) && /插话已读/.test(r.text));
    console.log(ok ? '结论：第 2 条消息在同一次运行里被读到并照办了。' : '结论：和预期不一致，见上面的记录。');
    break;
  }
  if (Date.now() - t0 > 240000) { console.log(at(), '超过四分钟还没结束'); break; }
  await sleep(700);
}
