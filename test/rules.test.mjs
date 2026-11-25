// 规则测试：只测工作台自己的规则（@ 解析、任务状态机、去重、交接上限、项目隔离）。
// 这里不启动任何真实成员——项目被设成“暂停”，唤醒单只入队不送达。真实成员的实测记录在 docs/实测记录.md。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project, opensAsProgram } from '../server/project.mjs';
import { Dispatcher, readableError, NO_PUSH_MSG } from '../server/dispatcher.mjs';
import { handleQun, serveRpc } from '../server/rpc.mjs';
import { parseMentions } from '../server/mentions.mjs';
import { pickModel, tiersFor, configureMembers, cleanMemberSettings, upgradeSettings, member, enabledAgents, coordinator, defaultReviewer } from '../server/members.mjs';
import { ROSTER, buildRoster, GENERIC_TITLE, GENERIC_ROLE } from '../server/roster.mjs';
import { configureModels, readCodexModels, resetModels, findModel, cleanCustomModels, catalog, lockOf } from '../server/models.mjs';
import { all, one } from '../server/store.mjs';
import { spawnSync, spawn } from 'node:child_process';
import { seatbeltProfile, inTempArea, sandboxStatus, SANDBOX_EXEC, normalizeScopeEntry } from '../server/boundary.mjs';
import { buildPrompt } from '../server/prompt.mjs';
import { deniedLine, cleanEnv, othersSecrets } from '../server/agents/runner.mjs';
import { acpAdapter, pickPermission, findConfigValue, loggedIn } from '../server/agents/acp.mjs';
import { claude, toolDenied, CLAUDE_TOOLS } from '../server/agents/claude.mjs';
import { sandboxArgs as codexSandboxArgs } from '../server/agents/codex.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function setup(name, connected = ['Claude', 'Codex', 'DeepSeek'], { snapshots = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-test-'));
  const project = new Project({ id: name, name, dir });
  project.patchSettings({ paused: true });
  const status = () => Object.fromEntries(['Claude', 'Codex', 'DeepSeek'].map((a) => [a, { connected: connected.includes(a), fix: '测试里设为未连接' }]));
  // 改动快照默认关掉（它要先跑 git 再让成员开跑，会改变别的测试里的时序）；专门测快照的测试再打开
  const disp = new Dispatcher(project, { adapters: {}, status, appDir: APP_DIR, snapshots });
  const wakes = () => all(project.db, 'SELECT target, reason, state, task_id, by_agent FROM wakes ORDER BY id');
  return { project, disp, tasks: disp.tasks, wakes, dir };
}
const qun = (disp, agent, line) => handleQun(disp, agent, line);

test('@ 解析：引用、代码、邮箱里的 @ 不算点名', () => {
  assert.deepEqual(parseMentions('@Codex 写个脚本，完了给 @Claude 审'), ['Codex', 'Claude']);
  assert.deepEqual(parseMentions('> @Codex 之前说过\n我同意'), []);
  assert.deepEqual(parseMentions('日志里有 `@Codex` 字样\n```\n@DeepSeek error\n```'), []);
  assert.deepEqual(parseMentions('发到 someone@codex.com'), []);
  assert.deepEqual(parseMentions('@群主请验收，@deepseek 也看下'), ['群主', 'DeepSeek']);
  assert.deepEqual(parseMentions('@Codexer 不是成员'), []);
  assert.deepEqual(parseMentions('@Claude 你好', { exclude: 'Claude' }), []);
});

test('群主点名谁，谁接单；没点名由 Claude 接', () => {
  const { disp, tasks, wakes } = setup('direct');
  disp.ownerSay({ text: '@Codex 写一个去重脚本' });
  disp.ownerSay({ text: '帮我整理一下目录' });
  const [t1, t2] = tasks.list();
  assert.equal(t1.owner, 'Codex'); assert.equal(t1.reviewer, 'Claude'); assert.equal(t1.state, 'dispatched');
  assert.equal(t2.owner, 'Claude'); assert.equal(t2.reviewer, 'Codex');
  assert.deepEqual(wakes().map((w) => [w.target, w.reason, w.state]), [['Codex', 'task_assigned', 'queued'], ['Claude', 'task_assigned', 'queued']]);
});

test('完整流转：派单 → 接单 → 提交 → 审查 → 群主验收', () => {
  const { disp, tasks, project, dir } = setup('flow');
  disp.ownerSay({ text: '@Claude 帮我统一格式' });
  qun(disp, 'Claude', ['task', 'accept', 'T1']);
  qun(disp, 'Claude', ['task', 'new', '--parent', 'T1', '--title', '字段映射', '--owner', 'DeepSeek', '--reviewer', 'Codex', '--deliver', '映射表', '--accept', '覆盖全部列', '--kind', '分析']);
  qun(disp, 'Claude', ['task', 'new', '--parent', 'T1', '--title', '转换脚本', '--owner', 'Codex', '--after', 'T2', '--deliver', '脚本和新 CSV', '--accept', '行数金额一致']);
  assert.equal(tasks.get('T1').state, 'working');
  assert.equal(one(project.db, "SELECT state FROM wakes WHERE task_id='T3'").state, 'waiting', 'T3 要等 T2');

  // 负责人以外的人不能提交；缺证据会被拒收
  assert.throws(() => qun(disp, 'Codex', ['task', 'submit', 'T2', '--file', 'x', '--run', 'r', '--evidence', 'e']), /只有它能提交/);
  fs.mkdirSync(path.join(dir, '共享区', 'T2'), { recursive: true }); fs.mkdirSync(path.join(dir, '共享区', 'T3'), { recursive: true });
  fs.writeFileSync(path.join(dir, '共享区', 'T2', '映射.md'), '# 映射\n');
  assert.throws(() => qun(disp, 'DeepSeek', ['task', 'submit', 'T2', '--file', '共享区/T2/映射.md', '--run', '对照样例']), /缺测试证据/);
  assert.throws(() => qun(disp, 'DeepSeek', ['task', 'submit', 'T2', '--file', '共享区/不存在.md', '--run', 'r', '--evidence', 'e']), /找不到文件/);
  qun(disp, 'DeepSeek', ['task', 'submit', 'T2', '--file', '共享区/T2/映射.md', '--run', '对照样例', '--evidence', '8 列全部对上']);
  assert.equal(tasks.get('T2').state, 'in_review');

  // 不能自己审自己；只有指定的审查人能审；结论必须带证据
  assert.throws(() => qun(disp, 'DeepSeek', ['task', 'review', 'T2', '--pass', '--evidence', 'ok']), /不能审查自己/);
  assert.throws(() => qun(disp, 'Claude', ['task', 'review', 'T2', '--pass', '--evidence', 'ok']), /审查人是 @Codex/);
  assert.throws(() => qun(disp, 'Codex', ['task', 'review', 'T2', '--pass']), /必须附证据/);
  qun(disp, 'Codex', ['task', 'review', 'T2', '--pass', '--evidence', '逐列核对通过']);
  assert.equal(tasks.get('T2').state, 'done');
  assert.equal(one(project.db, "SELECT state FROM wakes WHERE task_id='T3' AND reason='task_assigned'").state, 'queued', 'T2 完成后放行 T3');

  // 审查不通过 → 退回，返工次数 +1
  fs.writeFileSync(path.join(dir, '共享区', 'T3', 'out.csv'), 'a,b\n1,2\n');
  qun(disp, 'Codex', ['task', 'submit', 'T3', '--file', '共享区/T3/out.csv', '--run', 'python3 convert.py', '--evidence', '17 行']);
  qun(disp, 'Claude', ['task', 'review', 'T3', '--fail', '--evidence', '金额合计差 0.3']);
  assert.equal(tasks.get('T3').state, 'working'); assert.equal(tasks.get('T3').rework, 1);
  // 父任务在子任务没完成时不能提交
  assert.throws(() => qun(disp, 'Claude', ['task', 'submit', 'T1', '--file', '共享区/T3/out.csv', '--run', 'r', '--evidence', 'e']), /还有子任务没完成/);
  qun(disp, 'Codex', ['task', 'submit', 'T3', '--file', '共享区/T3/out.csv', '--run', 'python3 convert.py', '--evidence', '已修正']);
  qun(disp, 'Claude', ['task', 'review', 'T3', '--pass', '--evidence', '独立样例核对一致']);
  assert.equal(one(project.db, "SELECT COUNT(*) AS n FROM wakes WHERE task_id='T1' AND reason='children_done'").n, 1, '子任务都完成后叫负责人汇总');

  qun(disp, 'Claude', ['task', 'submit', 'T1', '--file', '共享区/T3/out.csv', '--run', '打开 CSV', '--evidence', '17 行，合计一致']);
  assert.equal(tasks.get('T1').state, 'awaiting_owner');
  assert.throws(() => tasks.approve('T3'), /还没到群主验收/);
  tasks.reject('T1', '日期格式不对');
  assert.equal(tasks.get('T1').state, 'rejected');
  qun(disp, 'Claude', ['task', 'submit', 'T1', '--file', '共享区/T3/out.csv', '--run', '打开 CSV', '--evidence', '已改日期']);
  tasks.approve('T1');
  assert.equal(tasks.get('T1').state, 'done');
});

test('库里写不进“审查人就是负责人”的任务', () => {
  const { project, tasks } = setup('check');
  assert.throws(() => tasks.create({ title: 'x', owner: 'Codex', reviewer: 'Codex', creator: '群主' }), /审查人不能是负责人/);
  assert.throws(() => project.db.prepare("INSERT INTO tasks(id,seq,title,owner,reviewer,creator,state,created_ts,updated_ts) VALUES('TX',9,'x','Codex','Codex','群主','dispatched',1,1)").run(), /CHECK/i);
});

test('去重：同一条消息、同一句话不会重复唤醒', () => {
  const { disp, project, wakes } = setup('dedupe');
  const m = project.post({ sender: 'Claude', text: '@Codex 请看共享区的需求', chainId: 1 });
  disp.routeMentions(m, { byAgent: true });
  disp.routeMentions(m, { byAgent: true });                       // 同一条消息再路由一次
  const m2 = project.post({ sender: 'Claude', text: '@Codex 请看共享区的需求', chainId: 1 });
  disp.routeMentions(m2, { byAgent: true });                      // 一模一样的话再说一遍
  assert.equal(wakes().filter((w) => w.target === 'Codex').length, 1);
  assert.match(project.messages().at(-1).text, /没有重复唤醒/);
});

test('交接上限：超过后拦下并交给群主，放行后继续', () => {
  const { disp, project, wakes } = setup('hop');
  project.patchSettings({ hopLimit: 3 });
  for (let i = 0; i < 5; i++) {
    const m = project.post({ sender: i % 2 ? 'Codex' : 'Claude', text: `@${i % 2 ? 'Claude' : 'Codex'} 第 ${i} 次交接`, chainId: 7 });
    disp.routeMentions(m, { byAgent: true });
  }
  assert.deepEqual(wakes().map((w) => w.state), ['queued', 'queued', 'queued', 'held', 'held']);
  const notices = project.messages().filter((m) => m.meta.hold === 7);
  assert.equal(notices.length, 1, '只提醒群主一次');
  // 群主自己发话不算成员间交接
  disp.wake({ target: 'Codex', reason: 'mention', dedupeKey: 'owner-1', chainId: 7, byAgent: false });
  assert.equal(wakes().at(-1).state, 'queued');
  disp.releaseHold(7, 6);
  assert.ok(wakes().every((w) => w.state === 'queued'));
});

test('未连接的成员：不能派活，@ 它会明说没送达', () => {
  const { disp, tasks, project, wakes } = setup('offline', ['Claude', 'Codex']);
  assert.throws(() => tasks.create({ title: '映射', owner: 'DeepSeek', creator: 'Claude', deliver: 'd', accept: 'a' }), /未连接/);
  const m = project.post({ sender: 'Claude', text: '@DeepSeek 在吗', chainId: 1 });
  disp.routeMentions(m, { byAgent: true });
  assert.equal(wakes().length, 0);
  assert.match(project.messages().at(-1).text, /@DeepSeek 未连接/);
});

test('收件箱：同一个文件只通知一次，改了内容才再通知', () => {
  const { project, dir } = setup('inbox');
  const f = path.join(dir, '收件箱', 'a.csv');
  fs.writeFileSync(f, 'x\n1\n');
  const old = Date.now() / 1000 - 5;
  fs.utimesSync(f, old, old);
  assert.equal(project.scanInbox().length, 1);
  assert.equal(project.scanInbox().length, 0);
  fs.writeFileSync(f, 'x\n1\n2\n'); fs.utimesSync(f, old, old);
  const again = project.scanInbox();
  assert.equal(again.length, 1); assert.equal(again[0].updated, true);
  assert.equal(project.messages().filter((m) => m.kind === 'file').length, 2);
});

test('项目隔离：两个项目的消息、任务、文件互不可见', () => {
  const a = setup('A'), b = setup('B');
  a.disp.ownerSay({ text: '@Codex 只属于 A 的任务' });
  fs.writeFileSync(path.join(a.dir, '共享区', 'secret.txt'), 'A 的文件');
  assert.equal(b.tasks.list().length, 0);
  assert.equal(b.project.messages().filter((m) => m.kind === 'chat').length, 0);
  assert.equal(b.project.abs(path.join(a.dir, '共享区', 'secret.txt')), null, 'B 打不开 A 的文件');
  assert.equal(b.project.abs('../A/共享区/secret.txt'), null);
  assert.equal(b.project.statFile('/etc/hosts'), null);
});

test('对话：一个项目里可以有多个对话，各说各的；改名、归档、已读只记在本项目里', () => {
  const a = setup('chat-a'), b = setup('chat-b');
  const m1 = a.disp.ownerSay({ text: '@Codex 写一个去重脚本' });
  const m2 = a.disp.ownerSay({ text: '@Claude 整理一下目录' });
  assert.notEqual(m1.chainId, m2.chainId, '两句没有关系的话是两个对话');
  // 接着第一个对话说：留在那个对话里；新建的任务卡也挂在那个对话上
  const m3 = a.disp.ownerSay({ text: '@Codex 再加一个参数', chatId: m1.chainId });
  assert.equal(m3.chainId, m1.chainId);
  assert.deepEqual(a.tasks.list().map((t) => t.chainId), [m1.chainId, m2.chainId, m1.chainId]);
  // 回复某条消息：跟着那条消息所在的对话走
  assert.equal(a.disp.ownerSay({ text: '收到', replyTo: m2.id, asTask: false }).chainId, m2.chainId);
  // 跟进任务卡：留在这张卡所在的对话里
  assert.equal(a.disp.ownerSay({ text: '@Claude 进度？', taskId: 'T2' }).chainId, m2.chainId);
  // 给了一个不存在的对话编号：当成新对话
  const m6 = a.disp.ownerSay({ text: '@Claude 另一件事', chatId: 9999, asTask: false });
  assert.equal(m6.chainId, m6.id);
  const rows = a.project.chatRows();
  assert.deepEqual(rows.map((r) => r.id).sort((x, y) => x - y), [m1.id, m2.id, m6.id]);
  assert.ok(rows.find((r) => r.id === m1.id).n >= 2);
  // 改名、归档、已读
  a.project.patchChat(m1.chainId, { title: '  去重脚本  ', archived: true, readId: m3.id });
  a.project.patchChat(m1.chainId, { readId: 1 });       // 已读只往前走，不会退回去
  assert.deepEqual(a.project.chatMeta()[m1.chainId], { title: '去重脚本', archived: true, readId: m3.id });
  a.project.patchChat(m1.chainId, { title: '', archived: false });
  assert.deepEqual(a.project.chatMeta()[m1.chainId], { readId: m3.id });
  assert.equal(a.project.isChat(m3.id), false, '只有对话开头那条消息的编号才是对话编号');
  // 另一个项目里看不到这些对话
  assert.equal(b.project.chatRows().length, 0);
  assert.deepEqual(b.project.chatMeta(), {});
});

test('重启恢复：没跑完的运行放回队列', () => {
  const { project, dir } = setup('recover');
  project.db.prepare("INSERT INTO runs(id,agent,started_ts,status) VALUES('R1','Codex',1,'running')").run();
  project.db.prepare("INSERT INTO wakes(ts,target,reason,dedupe_key,state,run_id) VALUES(1,'Codex','mention','k1','accepted','R1')").run();
  project.close();
  const p2 = new Project({ id: 'recover', name: 'recover', dir });
  new Dispatcher(p2, { adapters: {}, status: () => ({}), appDir: APP_DIR });
  assert.equal(one(p2.db, "SELECT status FROM runs WHERE id='R1'").status, 'interrupted');
  assert.equal(one(p2.db, "SELECT state FROM wakes WHERE dedupe_key='k1'").state, 'queued');
});

test('选模型：手动优先；按任务类型查表；打回升一档', () => {
  const s = { memberModel: {}, kindLevel: {} };
  assert.equal(pickModel({ agent: 'Claude', task: { kind: '方案', rework: 0 }, settings: s }).model, 'claude-fable-5-2');
  assert.equal(pickModel({ agent: 'Claude', task: { kind: '实现', rework: 0 }, settings: s }).model, 'claude-opus-5-5');
  assert.equal(pickModel({ agent: 'Claude', task: { kind: '整理', rework: 0 }, settings: s }).model, 'claude-sonnet-5-5');
  const up = pickModel({ agent: 'Claude', task: { kind: '实现', rework: 1 }, settings: s });
  assert.equal(up.model, 'claude-fable-5-2'); assert.match(up.by, /升一档/);
  const paid = pickModel({ agent: 'DeepSeek', task: { kind: '分析', rework: 2 }, settings: s });
  assert.equal(paid.effort, 'high', '按量付费的成员被打回不自动升档（分析是常规档）'); assert.match(paid.by, /不自动升档/);
  configureModels({ lock: { DeepSeek: { model: 'deepseek-flash', effort: 'max' } } });
  const fixed = pickModel({ agent: 'DeepSeek', task: { kind: '分析', rework: 2 }, settings: s });
  assert.deepEqual([fixed.model, fixed.effort], ['deepseek-flash', 'max']); assert.match(fixed.by, /固定/);
  const paidHigh = pickModel({ agent: 'DeepSeek', task: { kind: '方案', rework: 0, level: '高', level_set: true }, settings: { memberModel: { DeepSeek: { model: 'deepseek-v4-pro', effort: 'high' } } } });
  assert.deepEqual([paidHigh.model, paidHigh.effort], ['deepseek-flash', 'max'], '设了固定模型后，任务卡标高档、成员上另指定模型，都改不了它');
  resetModels();
  assert.equal(pickModel({ agent: 'Claude', task: { kind: '方案', rework: 0 }, settings: s, highTierLow: true }).model, 'claude-opus-5-5', '高档额度不足时降一档');
  const manual = pickModel({ agent: 'Codex', task: { kind: '方案', rework: 0 }, settings: { memberModel: { Codex: 'gpt-6-astra|快速' } } });
  assert.equal(manual.effort, 'low'); assert.match(manual.by, /群主指定/);
  assert.equal(pickModel({ agent: 'Claude', task: { kind: '整理', rework: 0, model: 'claude-fable-5-2' }, settings: s }).by, '群主指定（任务）');
});

test('模型目录：所有模型可选，再配推理强度；可以自己加模型；可以让 DeepSeek 固定一个', () => {
  resetModels();
  // Codex 的清单：只要对外显示的模型，推理强度按清单里写的
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wg-models-')), 'models_cache.json');
  fs.writeFileSync(f, JSON.stringify({ fetched_at: '2026-11-13T10:00:00Z', models: [
    { slug: 'gpt-x-luna', display_name: 'GPT-X-Luna', visibility: 'list', priority: 2, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
    { slug: 'gpt-x-sol', display_name: 'GPT-X-Sol', visibility: 'list', priority: 1, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
  ] }));
  const got = readCodexModels(f);
  assert.deepEqual(got.models.map((m) => m.id), ['gpt-x-sol', 'gpt-x-luna'], '按优先级排，不显示隐藏的');
  assert.deepEqual(got.models[0].efforts, ['low', 'ultra']);
  assert.equal(readCodexModels(path.join(os.tmpdir(), 'no-such-file.json')), null, '读不到清单就用内置的');
  assert.ok(findModel('Codex', 'gpt-6.1-sol'), '内置清单里有 Sol');
  assert.ok(findModel('Claude', 'claude-haiku-5-5'), 'Claude 的四个模型都在');

  // 成员上固定“模型 + 推理强度”；这个模型不支持那一档时用它的默认档
  const sol = pickModel({ agent: 'Codex', task: { kind: '整理', rework: 0 }, settings: { memberModel: { Codex: { model: 'gpt-6.1-sol', effort: 'ultra' } } } });
  assert.deepEqual([sol.model, sol.effort], ['gpt-6.1-sol', 'ultra']); assert.match(sol.by, /群主指定/);
  const luna = pickModel({ agent: 'Codex', task: null, settings: { memberModel: { Codex: { model: 'gpt-6-luna', effort: 'ultra' } } } });
  assert.equal(luna.effort, 'medium', 'Luna 没有 ultra，退回默认档');

  // 自己加模型，再把“高”档换成它
  assert.throws(() => cleanCustomModels({ Claude: [{ id: '有 空格' }] }), /模型名/);
  assert.deepEqual(cleanCustomModels({ DeepSeek: [{ id: 'deepseek-v9' }] }).DeepSeek.map((m) => m.id), ['deepseek-v9'], 'DeepSeek 不固定时也能自己加模型');
  configureModels({ customModels: { Claude: [{ id: 'claude-next-9', label: 'Next 9' }] }, tiers: { Claude: { 高: { model: 'claude-next-9', effort: 'xhigh' } } } });
  assert.equal(catalog('Claude').at(-1).source, 'custom');
  const next = pickModel({ agent: 'Claude', task: { kind: '方案', rework: 0 }, settings: {} });
  assert.deepEqual([next.model, next.effort], ['claude-next-9', 'xhigh'], '自动选模型时“高”档用群主换上的模型');
  assert.equal(tiersFor('Claude').高.label, 'Next 9 · xhigh');
  assert.equal(pickModel({ agent: 'Claude', task: { kind: '实现', rework: 0 }, settings: {} }).model, 'claude-opus-5-5', '没改的档位还是默认');
  // 把自己加的模型删掉：引用它的档位回到默认
  configureModels({ customModels: {}, tiers: { Claude: { 高: { model: 'claude-next-9', effort: 'xhigh' } } } });
  assert.equal(pickModel({ agent: 'Claude', task: { kind: '方案', rework: 0 }, settings: {} }).model, 'claude-fable-5-2');

  // DeepSeek 出厂不固定，按档位表选（三档只差推理强度）；群主在设置里打开“固定只用这一个”后才只用那一个
  assert.equal(lockOf('DeepSeek'), null);
  assert.equal(lockOf('Claude'), null);
  const auto = pickModel({ agent: 'DeepSeek', task: { kind: '方案', rework: 0 }, settings: {} });
  assert.deepEqual([auto.model, auto.effort], ['deepseek-flash', 'max'], '“方案”是高档');
  assert.equal(pickModel({ agent: 'DeepSeek', task: { kind: '摘要', rework: 0 }, settings: {} }).effort, 'low', '“摘要”是快速档');
  configureModels({ lock: { DeepSeek: { model: 'deepseek-v9-flash', effort: 'high' } } });
  const ds = pickModel({ agent: 'DeepSeek', task: { kind: '分析', rework: 0 }, settings: {} });
  assert.deepEqual([ds.model, ds.effort], ['deepseek-v9-flash', 'high']);
  assert.equal(pickModel({ agent: 'DeepSeek', task: { kind: '摘要', rework: 0 }, settings: {} }).model, 'deepseek-v9-flash', '固定后哪一档都只用它');
  configureModels({ lock: {} });
  assert.equal(lockOf('DeepSeek'), null, '关掉固定');
  resetModels();
});

test('被 @ 来帮忙的人不因为别人的返工而升档', async () => {
  const { disp, tasks, project } = setup('pick');
  project.patchSettings({ paused: false });
  const seen = [];
  disp.env.adapters = Object.fromEntries(['Claude', 'Codex', 'DeepSeek'].map((a) => [a, {
    start: ({ model, on }) => { seen.push([a, model]); setTimeout(() => on.done({ status: 'ok', finalText: '' }), 5); return { stop() {}, pid: null }; },
  }]));
  project.patchSettings({ paused: true });
  const t = tasks.create({ title: '映射', owner: 'DeepSeek', reviewer: 'Codex', creator: 'Claude', deliver: 'd', accept: 'a', kind: '分析' });
  project.db.prepare('UPDATE tasks SET rework=2 WHERE id=?').run(t.id);
  // Codex 在这张返工过的卡上 @ 了 Claude
  const m = project.post({ sender: 'Codex', text: '@Claude 请推进后续任务', taskId: t.id, chainId: 1 });
  disp.routeMentions(m, { byAgent: true });
  project.patchSettings({ paused: false });
  disp.pump();
  await new Promise((r) => setTimeout(r, 60));
  const claude = seen.find(([a]) => a === 'Claude');
  assert.equal(claude[1], 'claude-opus-5-5', 'Claude 只是被 @，用常规档');
  const ds = seen.find(([a]) => a === 'DeepSeek');
  assert.equal(ds[1], 'deepseek-flash', 'DeepSeek 按量付费，返工也不自动升档');
  disp.stopAll();
});

test('提交后又改了文件：审查被挡住，负责人重新提交后才能审', () => {
  const { disp, tasks, dir } = setup('stale-file');
  disp.ownerSay({ text: '@Codex 写脚本' });
  fs.mkdirSync(path.join(dir, '共享区', 'T1'), { recursive: true });
  const f = path.join(dir, '共享区', 'T1', 'a.py');
  fs.writeFileSync(f, 'print(1)\n');
  qun(disp, 'Codex', ['task', 'submit', 'T1', '--file', '共享区/T1/a.py', '--run', 'python3 a.py', '--evidence', '输出 1']);
  fs.writeFileSync(f, 'print(2)\n');                                   // 提交后又改了
  assert.throws(() => qun(disp, 'Claude', ['task', 'review', 'T1', '--pass', '--evidence', '看过了']), /提交之后被改过/);
  qun(disp, 'Codex', ['task', 'submit', 'T1', '--file', '共享区/T1/a.py', '--run', 'python3 a.py', '--evidence', '输出 2']);
  assert.equal(tasks.get('T1').state, 'in_review');
  qun(disp, 'Claude', ['task', 'review', 'T1', '--pass', '--evidence', '按新版本独立跑过，输出 2']);
  assert.equal(tasks.get('T1').state, 'awaiting_owner');
  assert.deepEqual(tasks.changedSinceSubmit(tasks.get('T1')), []);
  // 等群主验收时文件又被改了：任务卡能看出来；负责人重新提交后回到待审查
  fs.writeFileSync(f, 'print(3)\n');
  assert.deepEqual(tasks.changedSinceSubmit(tasks.get('T1')), ['共享区/T1/a.py']);
  qun(disp, 'Codex', ['task', 'submit', 'T1', '--file', '共享区/T1/a.py', '--run', 'python3 a.py', '--evidence', '输出 3']);
  assert.equal(tasks.get('T1').state, 'in_review', '改过的版本要重新审');
});

// ---- 运行中插话和群摘要（用假成员测调度规则；真实成员的实测见 docs/实测记录.md） ----
// 假成员：start 之后一直“在干活”，直到测试调用 end()；记录被插进来的话，可选择是否确认读到
function fakeAgents(disp, { injectable = true } = {}) {
  const runs = [];
  disp.env.adapters = Object.fromEntries(['Claude', 'Codex', 'DeepSeek'].map((a) => [a, {
    start: (opts) => {
      const r = { agent: a, opts, injected: [], end: (res = {}) => opts.on.done({ status: 'ok', finalText: '', ...res }) };
      runs.push(r);
      setTimeout(() => opts.on.session(opts.ephemeral ? null : `sess-${a}`, { model: opts.model }), 1);
      const handle = { stop() {}, pid: null };
      if (injectable) handle.inject = (text, key) => { r.injected.push({ text, key }); return true; };
      return handle;
    },
  }]));
  return runs;
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const wakeOf = (project, msgId) => one(project.db, 'SELECT * FROM wakes WHERE source_msg=?', msgId);

test('运行中插话：@ 正在干活的成员，消息写进它的会话；它确认读到后才算“已送到”', async () => {
  const { disp, project } = setup('inject');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  const m1 = disp.ownerSay({ text: '@Codex 先跑一个很久的测试', asTask: false });
  await tick(70);
  assert.equal(runs.length, 1);
  assert.equal(wakeOf(project, m1.id).state, 'delivered');

  const m2 = disp.ownerSay({ text: '@Codex 补充：只测 a 模块', asTask: false, chatId: m1.chainId });      // 在同一个对话里接着说
  await tick(60);
  assert.equal(runs.length, 1, '没有另起一次运行');
  assert.equal(runs[0].injected.length, 1);
  assert.match(runs[0].injected[0].text, /运行中插话[\s\S]*只测 a 模块/);
  let w = wakeOf(project, m2.id);
  assert.equal(w.state, 'queued', '写进去了但还没确认读到，不能算送达');
  assert.match(w.note, /已写入/);

  runs[0].opts.on.injected(runs[0].injected[0].key);
  w = wakeOf(project, m2.id);
  assert.equal(w.state, 'delivered');
  assert.equal(w.note, '已送到正在干活的 @Codex');

  runs[0].end({ finalText: '测完了，只测了 a 模块' });
  await tick(60);
  assert.equal(wakeOf(project, m2.id).state, 'done');
  assert.equal(runs.length, 1);
  assert.equal(project.messages().at(-1).text, '测完了，只测了 a 模块');
});

test('运行中插话：成员没读到就结束了，这条消息放回队列，下一次运行再送', async () => {
  const { disp, project } = setup('inject-miss');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  const m1 = disp.ownerSay({ text: '@Claude 做第一件事', asTask: false });
  await tick(70);
  const m2 = disp.ownerSay({ text: '@Claude 还有第二件事', asTask: false, chatId: m1.chainId });
  await tick(60);
  assert.equal(runs[0].injected.length, 1);
  runs[0].end({ finalText: '第一件做完了' });          // 没有确认读到第二条
  await tick(80);
  assert.equal(runs.length, 2, '另起一次运行来送第二条');
  assert.ok(runs[1].opts.prompt.includes('还有第二件事'));
  assert.equal(wakeOf(project, m2.id).state, 'delivered');
  runs[1].end();
});

test('运行中插话：新任务不插队；不能插话的成员如实标“排队中”', async () => {
  const a = setup('inject-task');
  const runsA = fakeAgents(a.disp);
  a.project.patchSettings({ paused: false, parallel: { Codex: 1 } });      // 不并行时：新任务排队
  a.disp.ownerSay({ text: '@Codex 做第一件事', asTask: false });
  await tick(70);
  a.disp.ownerSay({ text: '@Codex 再做一个新任务' });          // 建了任务卡 → 是另一件事
  await tick(60);
  assert.equal(runsA[0].injected.length, 0, '新任务不插进正在进行的一轮');
  const tw = one(a.project.db, "SELECT * FROM wakes WHERE reason='task_assigned'");
  assert.equal(tw.state, 'queued'); assert.match(tw.note, /正在干活，等它这一步结束后送达/);
  runsA[0].end(); await tick(60); runsA.at(-1).end();

  const b = setup('inject-none');
  const runsB = fakeAgents(b.disp, { injectable: false });
  b.project.patchSettings({ paused: false });
  b.disp.ownerSay({ text: '@DeepSeek 分析这个文件', asTask: false });
  await tick(70);
  const m2 = b.disp.ownerSay({ text: '@DeepSeek 顺便看看编码', asTask: false });
  await tick(60);
  const w = wakeOf(b.project, m2.id);
  assert.equal(w.state, 'queued'); assert.match(w.note, /正在干活，等它这一步结束后送达/);
  runsB[0].end(); await tick(60); runsB.at(-1).end();
});

test('省额度：每个对话各用各的日常会话；另一个对话的话不会混进来，也不会插进别的对话正在跑的会话', async () => {
  const { disp, project } = setup('per-chat');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  const a1 = disp.ownerSay({ text: '@Codex 甲对话：查一下端口', asTask: false });
  await tick(60);
  const b1 = disp.ownerSay({ text: '@Codex 乙对话：改一下文案', asTask: false });      // 另一个对话
  await tick(60);
  assert.equal(runs.length, 2, '另一个对话不插进甲对话正在跑的会话，而是自己开一个');
  assert.equal(runs[0].injected.length, 0);
  assert.deepEqual(all(project.db, 'SELECT lane FROM runs ORDER BY started_ts').map((r) => r.lane), [`c${a1.chainId}`, `c${b1.chainId}`]);
  assert.deepEqual(disp.writableDirs('Codex', `c${a1.chainId}`), [`成员/Codex/对话${a1.chainId}/`], '每个对话的会话有自己的草稿目录');
  assert.ok(!runs[1].opts.prompt.includes('查一下端口'), '乙对话的会话里看不到甲对话的话');
  assert.equal(runs[1].opts.sessionId, null, '乙对话是新会话，不接着甲对话的');
  runs[0].end({ finalText: '端口是 7788' }); runs[1].end({ finalText: '文案改好了' });
  await tick(60);

  // 在甲对话里接着说：接着甲对话自己的会话；只带上次运行之后新出现的消息，自己说过的、触发这次的那条都不重复
  project.system('收件箱里来了新文件：收件箱/a.csv');
  const a2 = disp.ownerSay({ text: '@Codex 再查一下进程', asTask: false, chatId: a1.chainId });
  await tick(60);
  const r3 = runs.at(-1);
  assert.equal(r3.opts.sessionId, 'sess-Codex', '接着甲对话的会话');
  assert.equal(all(project.db, 'SELECT lane FROM runs ORDER BY started_ts').at(-1).lane, `c${a1.chainId}`);
  const p3 = r3.opts.prompt;
  assert.ok(!p3.includes('【群规】'), '接着聊不重发群规');
  assert.ok(p3.includes('收件箱/a.csv'), '上次运行之后的新通知带上');
  assert.ok(!p3.includes('端口是 7788') && !p3.includes('查一下端口'), '它已经看过、说过的不再带');
  assert.ok(!p3.includes('改一下文案') && !p3.includes('文案改好了'), '别的对话的话不带');
  assert.equal(p3.split('再查一下进程').length, 2);
  r3.end(); await tick(40);
  assert.equal(a2.chainId, a1.chainId);
});

test('省额度：日常会话太长就换新的（次数多了，或上一次运行太大）；任务卡的会话不轻易换', async () => {
  const { disp, project } = setup('rotate');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  const m = disp.ownerSay({ text: '@Claude 第 1 句', asTask: false });
  await tick(50); runs.at(-1).end({ finalText: '好', usage: { input: 120000, cached: 100000, output: 50 } }); await tick(50);
  disp.ownerSay({ text: '@Claude 第 2 句', asTask: false, chatId: m.chainId });
  await tick(50);
  assert.equal(runs.at(-1).opts.sessionId, 'sess-Claude', '还不长：接着用');
  runs.at(-1).end({ finalText: '好', usage: { input: 520000, cached: 500000, output: 50 } }); await tick(50);
  disp.ownerSay({ text: '@Claude 第 3 句', asTask: false, chatId: m.chainId });
  await tick(50);
  const r = runs.at(-1);
  assert.equal(r.opts.sessionId, null, '上一次运行重读了 52 万 token：换一个新会话');
  assert.match(r.opts.prompt, /这是一个新开的会话/);
  assert.ok(r.opts.prompt.includes('【群规】'), '新会话重新拿到群规');
  assert.ok(r.opts.prompt.includes('第 1 句'), '也重新拿到这个对话最近的消息');
  r.end({ finalText: '好', usage: { input: 100000, cached: 0, output: 50 } }); await tick(50);
  // 次数：同一个会话接着用了 8 次也换
  assert.equal(disp.shouldRotate('Claude', 'cX', { session_id: 'none' }), false, '没有运行记录的不换');
  for (let i = 0; i < 9; i++) project.db.prepare("INSERT INTO runs(id,agent,started_ts,ended_ts,status,session_id,resumed,wake_ids,kind,lane,usage) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(`Rx${i}`, 'Codex', 1000 + i, 1001 + i, 'ok', 's9', 1, '[]', 'work', 'c77', '{"input":90000}');
  assert.equal(disp.shouldRotate('Codex', 'c77', { session_id: 's9' }), true, '接着用了 8 次以上');
  // 任务卡的会话：同样大小不换，大得离谱才换；按量付费的成员只看次数
  project.db.prepare("INSERT INTO runs(id,agent,started_ts,ended_ts,status,session_id,resumed,wake_ids,kind,lane,usage) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('Rt1', 'Codex', 5000, 5001, 'ok', 'st', 1, '[]', 'work', 'T1', '{"input":520000}');
  assert.equal(disp.shouldRotate('Codex', 'T1', { session_id: 'st' }), false);
  project.db.prepare("UPDATE runs SET usage=? WHERE id='Rt1'").run('{"input":1600000}');
  assert.equal(disp.shouldRotate('Codex', 'T1', { session_id: 'st' }), true);
  project.db.prepare("INSERT INTO runs(id,agent,started_ts,ended_ts,status,session_id,resumed,wake_ids,kind,lane,usage) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('Rd1', 'DeepSeek', 6000, 6001, 'ok', 'sd', 1, '[]', 'work', 'c5', '{"input":12000,"cached":1700000}');
  assert.equal(disp.shouldRotate('DeepSeek', 'c5', { session_id: 'sd' }), false, 'DeepSeek 每一步自带的固定内容就很大，不按 token 数换');
});

test('省额度：闲聊用快速档；任务卡可以选不用审查；群规里提醒少走几步', async () => {
  // 不建任务卡的对话：按“闲聊”那一档选，默认快速档，可以在设置里改
  const s = { memberModel: {}, kindLevel: {} };
  const chat = pickModel({ agent: 'Claude', task: null, settings: s, reason: 'chat' });
  assert.equal(chat.model, 'claude-sonnet-5-5'); assert.equal(chat.level, '快速'); assert.match(chat.by, /不建任务卡的对话/);
  assert.equal(pickModel({ agent: 'Claude', task: null, settings: { kindLevel: { 闲聊: '常规' } }, reason: 'chat' }).model, 'claude-opus-5-5');
  assert.equal(pickModel({ agent: 'Claude', task: { kind: '协调', rework: 0 }, settings: s, reason: 'coordinate' }).model, 'claude-opus-5-5', '任务卡不受影响');
  assert.equal(pickModel({ agent: 'DeepSeek', task: null, settings: s, reason: 'chat' }).model, 'deepseek-flash');

  const { disp, tasks, project } = setup('no-review');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Claude 你好', asTask: false });
  await tick(50);
  assert.equal(one(project.db, 'SELECT model, model_by FROM runs ORDER BY started_ts DESC LIMIT 1').model, 'claude-sonnet-5-5', '协调员的闲聊也用快速档');
  const rules = runs.at(-1).opts.prompt;
  assert.match(rules, /省着用额度/);
  assert.ok(!rules.includes('按量付费的成员'), '订阅成员不带那句“每一步都是钱”');
  runs.at(-1).end(); await tick(40);
  project.patchSettings({ paused: true });

  // 群主建卡时选了不用审查：没有审查人，提交后直接到群主验收；改派也不会再安排审查
  disp.ownerSay({ text: '@Codex 改个错别字', review: false });
  const t = tasks.list().at(-1);
  assert.equal(t.reviewer, null); assert.equal(t.noReview, true);
  assert.match(tasks.events(t.id)[0].text, /群主选了不用审查/);
  // 唤醒内容里明说：提交后直接找群主，不要再 @ 别人来审（实测里 Codex 照习惯 @ 了 Claude“请审查”，多跑了一次）
  const pr = buildPrompt({ agent: 'Codex', project, tasks, wakes: [{ reason: 'task_assigned', task_id: t.id }], connected: ['Claude', 'Codex', 'DeepSeek'], resumed: false, qunPath: 'qun', lane: t.id, writable: [], enforced: true });
  assert.match(pr, /选了不用审查：提交后直接在回复里 @群主/);
  qun(disp, 'Codex', ['task', 'accept', t.id]);
  fs.mkdirSync(path.join(project.dir, '共享区', t.id), { recursive: true });
  fs.writeFileSync(path.join(project.dir, '共享区', t.id, 'a.txt'), '改好了');
  qun(disp, 'Codex', ['task', 'submit', t.id, '--file', `共享区/${t.id}/a.txt`, '--run', 'cat 一下', '--evidence', '内容是“改好了”']);
  assert.equal(tasks.get(t.id).state, 'awaiting_owner', '不经过审查，直接等群主验收');
  assert.match(project.messages().at(-1).text, /选了不用审查/);
  tasks.reject(t.id, '再改改');
  assert.equal(tasks.reassign(t.id, '群主', 'Claude').reviewer, null, '改派之后仍然不用审查');
  // 默认还是要审查；成员自己派的活不能跳过审查
  disp.ownerSay({ text: '@Codex 写个脚本' });
  assert.equal(tasks.list().at(-1).reviewer, 'Claude');
  const child = tasks.create({ title: '子任务', owner: 'DeepSeek', creator: 'Claude', deliver: 'x', accept: 'y', review: false });
  assert.ok(child.reviewer, '成员派的活，“不用审查”不生效');
  assert.equal(child.noReview, false);

  // DeepSeek 是按量付费的：群规里多一句
  const d = setup('ds-rules'); const druns = fakeAgents(d.disp);
  d.project.patchSettings({ paused: false });
  d.disp.ownerSay({ text: '@DeepSeek 看一下这个文件', asTask: false });
  await tick(50);
  assert.match(druns.at(-1).opts.prompt, /省着用额度[\s\S]*按量付费的成员/);
  druns.at(-1).end();
});

test('群摘要：整理成文件；新接手的成员先读摘要，再读摘要之后的消息', async () => {
  const { disp, project, dir } = setup('summary');
  const runs = fakeAgents(disp);
  project.post({ sender: '群主', text: '把两版订单统一成一种格式' });
  project.post({ sender: 'Claude', text: '已拆成 T2、T3', chainId: 1 });
  project.patchSettings({ paused: false });
  assert.equal(disp.summaryInfo().newCount, 2);

  const r = disp.summarize('群主');
  assert.equal(r.agent, 'Claude'); assert.equal(r.model, 'claude-sonnet-5-5', '用快速档');
  await tick();
  assert.equal(runs[0].opts.ephemeral, true, '不占用成员自己的会话');
  assert.match(runs[0].opts.prompt, /把两版订单统一成一种格式/);
  assert.throws(() => disp.summarize('群主'), /正在整理中/);
  runs[0].end({ finalText: '## 群主要什么\n统一两版订单格式\n## 已经定下来的\n拆成 T2、T3' });
  await tick(40);

  const file = fs.readFileSync(path.join(dir, '共享区', '群摘要.md'), 'utf8');
  assert.match(file, /统一两版订单格式/);
  const info = disp.summaryInfo();
  assert.equal(info.agent, 'Claude'); assert.equal(info.newCount, 0); assert.equal(info.upto, 2);
  assert.equal(one(project.db, 'SELECT COUNT(*) AS n FROM lanes').n, 0, '写摘要不产生也不改动成员的会话');
  assert.throws(() => disp.summarize('群主'), /没有新的发言/);

  // 之后来了新消息，再唤醒一位没来过的成员
  project.system('收件箱里来了新文件：收件箱/十月订单.csv');
  const m = disp.ownerSay({ text: '@Codex 接着写转换脚本', asTask: false });
  await tick(40);
  const p = runs.at(-1).opts.prompt;
  assert.match(p, /【群摘要】[\s\S]*统一两版订单格式/);
  assert.match(p, /【摘要之后的群聊】[\s\S]*十月订单\.csv/, '项目级的系统通知照样带上');
  assert.equal(p.split('接着写转换脚本').length, 2, '触发这次唤醒的那条消息只写一遍，不在群聊里再重复');
  assert.ok(!p.includes('已拆成 T2、T3\n#') && !/#2 @Claude/.test(p), '摘要之前的聊天不再重复给');
  runs.at(-1).end();
  assert.ok(m.id > info.upto);
});

test('群摘要：空闲且攒够新发言时自动更新；可以关掉', async () => {
  const { disp, project } = setup('summary-auto');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false, summaryEvery: 3 });
  project.post({ sender: '群主', text: '一' }); project.post({ sender: '群主', text: '二' });
  disp.pump(); await tick();
  assert.equal(runs.length, 0, '还没攒够');
  project.post({ sender: '群主', text: '三' });
  disp.pump(); await tick();
  assert.equal(runs.length, 1);
  assert.equal(disp.runsOf('Claude')[0].kind, 'summary');
  runs[0].end({ finalText: '## 群主要什么\n群主先后说了一、二、三这三句话，都记下了。\n## 已经定下来的\n无' });
  await tick(40);
  assert.equal(disp.summaryInfo().by, '自动');

  const off = setup('summary-off');
  const runs2 = fakeAgents(off.disp);
  off.project.patchSettings({ paused: false, summaryEvery: 1, summaryAuto: false });
  off.project.post({ sender: '群主', text: '一' });
  off.disp.pump(); await tick();
  assert.equal(runs2.length, 0);
});

// ---- qun 的身份：按这次运行的请求目录认，不信请求里自报的名字 ----
test('qun 身份按运行目录认：冒充审查人、冒充群主、用别的运行号、放在目录外都不行', async () => {
  const { disp, project, tasks, dir } = setup('rpc-ident');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Claude 写使用说明' });                       // T1：Claude 负责，Codex 审查
  await tick(80);
  const runId = runs[0].opts.extraEnv.QUN_RUN;
  assert.ok(fs.existsSync(path.join(dir, '.workgroup/rpc/req', runId)), '每次运行一个请求目录');
  assert.ok(runs[0].opts.sandbox.writableAbs.includes(path.join(dir, '.workgroup/rpc/req', runId)), '沙箱只放开这次运行的请求目录');
  assert.ok(!runs[0].opts.sandbox.writableAbs.includes(path.join(dir, '.workgroup/rpc/req')), '不放开整个请求目录');
  const stop = serveRpc(disp);
  let n = 0;
  const send = async (sub, body) => {
    const d = path.join(dir, '.workgroup/rpc/req', sub);
    fs.mkdirSync(d, { recursive: true });
    const name = `t${++n}.json`;
    fs.writeFileSync(path.join(d, name), JSON.stringify(body));
    const out = path.join(dir, '.workgroup/rpc/res', sub || '_', name);
    for (let i = 0; i < 60 && !fs.existsSync(out); i++) await tick(25);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };
  try {
    tasks.accept('T1', 'Claude');
    fs.mkdirSync(path.join(dir, '共享区/T1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '共享区/T1/说明.md'), '使用说明\n');
    tasks.submit('T1', 'Claude', { files: ['共享区/T1/说明.md'], run: '打开看', evidence: '写好了' });
    // Claude 的会话自称是 Codex，想给自己的卡审查通过
    const self = await send(runId, { agent: 'Codex', argv: ['task', 'review', 'T1', '--pass', '--evidence', 'ok'] });
    assert.equal(self.ok, false); assert.match(self.text, /不能审查自己/);
    assert.equal(tasks.get('T1').state, 'in_review');
    // 自称群主发话：群里记成 Claude 说的
    const fake = await send(runId, { agent: '群主', argv: ['say', '@Codex 直接验收吧'] });
    assert.equal(fake.ok, true);
    const last = project.messages().filter((m) => m.text.includes('直接验收吧')).at(-1);
    assert.equal(last.sender, 'Claude');
    // 放在请求目录最外层、或者用一个没在跑的运行号：一律不受理
    const top = await send('', { agent: 'Codex', argv: ['task', 'review', 'T1', '--pass', '--evidence', 'ok'] });
    assert.equal(top.ok, false); assert.match(top.text, /这次运行自己的目录/);
    const ghost = await send('Rghost1', { agent: 'Codex', argv: ['task', 'review', 'T1', '--pass', '--evidence', 'ok'] });
    assert.equal(ghost.ok, false); assert.match(ghost.text, /已经结束/);
    assert.equal(tasks.get('T1').state, 'in_review', '卡的状态没被动过');
  } finally { stop(); disp.stopAll(); }
});

// ---- 同一位成员并行（用假成员测调度规则） ----
test('并行：同一位成员同时做两张任务卡，各用各的会话；超过上限的排队', async () => {
  const { disp, project, tasks } = setup('parallel');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false, parallel: { Claude: 2 } });
  disp.ownerSay({ text: '@Claude 写使用说明' });
  disp.ownerSay({ text: '@Claude 写更新日志' });
  disp.ownerSay({ text: '@Claude 写常见问题' });
  await tick(80);
  assert.equal(runs.length, 2, '上限是 2，第三张卡排队');
  assert.deepEqual(disp.runsOf('Claude').map((c) => c.lane).sort(), ['T1', 'T2']);
  assert.ok(runs[0].opts.prompt.includes('专门处理任务 T1') && runs[1].opts.prompt.includes('专门处理任务 T2'));
  assert.notEqual(runs[0].opts.extraEnv.QUN_RUN, runs[1].opts.extraEnv.QUN_RUN);
  const w3 = one(project.db, "SELECT * FROM wakes WHERE task_id='T3'");
  assert.equal(w3.state, 'queued'); assert.match(w3.note, /2 个并行会话都在忙/);
  assert.deepEqual(all(project.db, 'SELECT lane, session_id FROM lanes ORDER BY lane').map((r) => r.lane), ['T1', 'T2'], '每张卡一个会话');

  // 两个会话各自调用 qun：靠运行号认出是谁，不会记到另一张卡上
  handleQun(disp, 'Claude', ['say', '第二张卡的进度：写了一半'], '', runs[1].opts.extraEnv.QUN_RUN);
  assert.equal(project.messages().at(-1).taskId, 'T2');
  handleQun(disp, 'Claude', ['task', 'accept', 'T1'], '', null);       // 没带运行号：按命令里的任务卡认
  assert.equal(one(project.db, "SELECT state FROM wakes WHERE task_id='T1'").state, 'accepted');
  assert.equal(one(project.db, "SELECT state FROM wakes WHERE task_id='T2'").state, 'accepted');

  runs[0].end({ finalText: 'T1 写完了' });
  await tick(80);
  assert.equal(runs.length, 3, '空出一个位置，第三张卡开跑');
  assert.equal(runs[2].opts.sessionId, null, '新的一张卡是新会话');
  assert.equal(project.messages().filter((m) => m.text === 'T1 写完了')[0].taskId, 'T1');
  runs[1].end(); runs[2].end(); await tick(60);

  // 同一张卡再来事：续接这张卡自己的会话
  tasks.reject('T1', '再补一节');
  await tick(80);
  assert.equal(runs.at(-1).opts.sessionId, 'sess-Claude', '接着 T1 的会话');
  assert.ok(!runs.at(-1).opts.prompt.includes('【群规】'), '续接的会话不再重复整套群规');
  assert.equal(runs.at(-1).opts.model, 'claude-fable-5-2', '被打回来返工：升一档');
  runs.at(-1).end(); await tick(60);
  // 之后群主在这张卡上随口跟进一句：还是这张卡的会话，但不再升档
  disp.ownerSay({ text: '@Claude 顺便把标题改短一点', taskId: 'T1' });
  await tick(80);
  assert.equal(runs.at(-1).opts.sessionId, 'sess-Claude');
  assert.equal(runs.at(-1).opts.model, 'claude-opus-5-5', '普通跟进不升档');
  assert.equal(tasks.list().length, 3, '跟进不另建任务卡');
  runs.at(-1).end();
});

test('并行：插话只进对应那张卡的会话；子任务里 @ 协调员，进它负责的父任务那条线', async () => {
  const { disp, project, tasks } = setup('parallel-lane');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Claude 帮我统一格式' });                        // T1，Claude 负责
  await tick(80);
  handleQun(disp, 'Claude', ['task', 'new', '--parent', 'T1', '--title', '写脚本', '--owner', 'Codex', '--deliver', 'd', '--accept', 'a'], '', runs[0].opts.extraEnv.QUN_RUN);
  disp.ownerSay({ text: '@Claude 另外写个周报' });                        // T3，Claude 负责
  await tick(80);
  const claudeRuns = () => disp.runsOf('Claude');
  assert.deepEqual(claudeRuns().map((c) => c.lane).sort(), ['T1', 'T3']);
  const codexRun = runs.find((r) => r.agent === 'Codex');

  // Codex 在 T2（T1 的子任务）里 @Claude → 进 Claude 的 T1 线，而且是插进正在跑的那个会话
  handleQun(disp, 'Codex', ['say', '@Claude 脚本要不要支持 Excel？'], '', codexRun.opts.extraEnv.QUN_RUN);
  await tick(80);
  const t1Run = runs.find((r) => r.agent === 'Claude' && r.opts.extraEnv.QUN_RUN === claudeRuns().find((c) => c.lane === 'T1').runId);
  const t3Run = runs.find((r) => r.agent === 'Claude' && r.opts.extraEnv.QUN_RUN === claudeRuns().find((c) => c.lane === 'T3').runId);
  assert.equal(t1Run.injected.length, 1); assert.match(t1Run.injected[0].text, /要不要支持 Excel/);
  assert.equal(t3Run.injected.length, 0, '另一张卡的会话不受打扰');

  // 停掉一次运行，不影响同一位成员的另一个会话
  assert.equal(disp.stopRun(claudeRuns().find((c) => c.lane === 'T3').runId), true);
  for (const r of runs) r.end();
});

test('并行：旧版“每位成员一个会话”升级时，挂到它还没做完的任务卡上', () => {
  const { project, tasks, dir, disp } = setup('migrate');
  tasks.create({ title: '总任务', owner: 'Claude', creator: '群主' });
  disp.dispose();
  project.db.prepare("INSERT INTO sessions(agent,session_id,model,updated_ts) VALUES('Claude','old-claude','m',1),('Codex','old-codex','m',1)").run();
  project.close();
  const p2 = new Project({ id: 'migrate', name: 'migrate', dir });
  new Dispatcher(p2, { adapters: {}, status: () => ({}), appDir: APP_DIR });
  assert.deepEqual(all(p2.db, 'SELECT agent, lane, session_id FROM lanes ORDER BY agent').map((r) => `${r.agent}/${r.lane}/${r.session_id}`),
    ['Claude/T1/old-claude', 'Codex/main/old-codex']);
  assert.equal(one(p2.db, 'SELECT COUNT(*) AS n FROM sessions').n, 0);
});

// ---- 写入边界：两个会话不能同时改同一个文件 ----
test('写入范围：每张卡一块地方，互不重叠；只能划共享区下面的目录', () => {
  const { tasks, project } = setup('scope');
  const t1 = tasks.create({ title: '脚本', owner: 'Codex', creator: '群主' });
  assert.deepEqual(t1.scope, ['共享区/T1/'], '没指定就是 共享区/<任务卡号>/');
  const t2 = tasks.create({ title: '文档', owner: 'Claude', creator: '群主', write: ['共享区/文档', '共享区/文档/图片/'] });
  assert.deepEqual(t2.scope, ['共享区/文档/'], '规整成目录，去掉被包含的');
  assert.throws(() => tasks.create({ title: '又一份文档', owner: 'DeepSeek', creator: '群主', write: ['共享区/文档/草案/'] }), /和任务 T2[\s\S]*重叠/);
  assert.throws(() => tasks.create({ title: '占别人的默认目录', owner: 'DeepSeek', creator: '群主', write: ['共享区/T1/'] }), /和任务 T1[\s\S]*重叠/);
  assert.throws(() => tasks.create({ title: 'x', owner: 'Codex', creator: '群主', write: ['收件箱/'] }), /只能是「共享区\/」下面的目录/);
  assert.throws(() => tasks.create({ title: 'x', owner: 'Codex', creator: '群主', write: ['共享区/'] }), /不能把整个/);
  assert.throws(() => tasks.create({ title: 'x', owner: 'Codex', creator: '群主', write: ['共享区/审查/T1/'] }), /留给审查人/);
  assert.throws(() => tasks.create({ title: 'x', owner: 'Codex', creator: '群主', write: ['../别的项目/'] }), /不在项目文件夹里/);
  assert.throws(() => tasks.create({ title: 'x', owner: 'Codex', creator: '群主', write: ['共享区/结果.csv'] }), /要写目录，不是单个文件/);
  assert.equal(tasks.list().length, 2, '被拒绝的都没有建出来');

  // 申请扩大：空着的批准，被占的拒绝
  assert.deepEqual(tasks.claim('T1', 'Codex', ['共享区/转换脚本/']).scope, ['共享区/T1/', '共享区/转换脚本/']);
  assert.throws(() => tasks.claim('T1', 'Codex', ['共享区/文档/']), /和任务 T2[\s\S]*重叠/);
  assert.throws(() => tasks.claim('T1', 'DeepSeek', ['共享区/x/']), /只有群主、负责人或派单人/);
  // T2 结束后，它那块地方可以划给新的卡；这时再把 T2 打回会被拦住
  project.db.prepare("UPDATE tasks SET state='done' WHERE id='T2'").run();
  tasks.create({ title: '改文档', owner: 'DeepSeek', creator: '群主', write: ['共享区/文档/'] });
  assert.throws(() => tasks.reject('T2', '再改改'), /和任务 T3[\s\S]*重叠/);
});

test('写入范围：成果必须交在自己的范围里；汇总时可以带上子任务的成果', () => {
  const { disp, tasks, dir } = setup('scope-submit');
  disp.ownerSay({ text: '@Claude 统一格式' });
  qun(disp, 'Claude', ['task', 'new', '--parent', 'T1', '--title', '脚本', '--owner', 'Codex', '--deliver', 'd', '--accept', 'a', '--write', '共享区/转换/']);
  for (const d of ['共享区/转换', '共享区/T1', '共享区/别处']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, '共享区/转换/c.py'), 'x'); fs.writeFileSync(path.join(dir, '共享区/别处/c.py'), 'x'); fs.writeFileSync(path.join(dir, '共享区/T1/说明.md'), 'x');
  assert.throws(() => qun(disp, 'Codex', ['task', 'submit', 'T2', '--file', '共享区/别处/c.py', '--run', 'r', '--evidence', 'e']), /不在这张卡的写入范围里[\s\S]*共享区\/转换\//);
  qun(disp, 'Codex', ['task', 'submit', 'T2', '--file', '共享区/转换/c.py', '--run', 'r', '--evidence', 'e']);
  qun(disp, 'Claude', ['task', 'review', 'T2', '--pass', '--evidence', '核对过']);
  qun(disp, 'Claude', ['task', 'submit', 'T1', '--file', '共享区/T1/说明.md', '--file', '共享区/转换/c.py', '--run', 'r', '--evidence', 'e']);
  assert.equal(tasks.get('T1').state, 'awaiting_owner');
});

test('写入范围：负责人只在“正在做”时能写成果；提交后锁定；审查人只能写审查记录', () => {
  const { disp, tasks, dir } = setup('scope-session');
  disp.ownerSay({ text: '@Codex 写脚本' });                                   // T1：Codex 负责，Claude 审查
  assert.deepEqual(disp.writableDirs('Codex', 'T1'), ['成员/Codex/T1/', '共享区/T1/']);
  assert.deepEqual(disp.writableDirs('Claude', 'T1'), ['成员/Claude/T1/', '共享区/审查/T1/'], '审查人写不了被审查的成果');
  assert.deepEqual(disp.writableDirs('Claude', 'main'), ['成员/Claude/日常/'], '日常对话只能写草稿');
  assert.deepEqual(disp.writableDirs('DeepSeek', 'T1'), ['成员/DeepSeek/T1/'], '无关的人什么成果都写不了');
  fs.mkdirSync(path.join(dir, '共享区/T1'), { recursive: true }); fs.writeFileSync(path.join(dir, '共享区/T1/a.py'), 'x');
  qun(disp, 'Codex', ['task', 'submit', 'T1', '--file', '共享区/T1/a.py', '--run', 'r', '--evidence', 'e']);
  assert.deepEqual(disp.writableDirs('Codex', 'T1'), ['成员/Codex/T1/'], '提交后负责人自己也改不了成果');
  // 撤回提交：解锁，审查人排队中的审查作废
  assert.throws(() => qun(disp, 'Claude', ['task', 'revise', 'T1', '我来改']), /只有它能撤回/);
  qun(disp, 'Codex', ['task', 'revise', 'T1', '漏了一个参数']);
  assert.equal(tasks.get('T1').state, 'working');
  assert.deepEqual(disp.writableDirs('Codex', 'T1'), ['成员/Codex/T1/', '共享区/T1/']);
  assert.equal(one(disp.db, "SELECT state FROM wakes WHERE target='Claude' AND reason='review_request'").state, 'cancelled');
  // 通过审查并验收之后：永久锁定
  qun(disp, 'Codex', ['task', 'submit', 'T1', '--file', '共享区/T1/a.py', '--run', 'r', '--evidence', 'e2']);
  qun(disp, 'Claude', ['task', 'review', 'T1', '--pass', '--evidence', '核对过']);
  tasks.approve('T1');
  assert.deepEqual(disp.writableDirs('Codex', 'T1'), ['成员/Codex/T1/']);
});

test('写入范围：负责人在自己的会话里撤回或申请后，这一步结束马上再叫它（那时新权限才生效）', async () => {
  const { disp, project, tasks, dir } = setup('scope-continue');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 写脚本' });
  await tick(80);
  assert.deepEqual(runs[0].opts.sandbox.dirs, ['成员/Codex/T1/', '共享区/T1/']);
  assert.match(runs[0].opts.prompt, /能写的目录（相对项目文件夹）：成员\/Codex\/T1\/、共享区\/T1\//);
  const out = handleQun(disp, 'Codex', ['task', 'claim', 'T1', '共享区/工具/'], '', runs[0].opts.extraEnv.QUN_RUN);
  assert.match(out, /请现在就结束这一步/);
  assert.equal(runs.length, 1);
  runs[0].end({ finalText: '等新目录生效' });
  await tick(80);
  assert.equal(runs.length, 2, '这一步结束后马上接着做');
  assert.deepEqual(runs[1].opts.sandbox.dirs, ['成员/Codex/T1/', '共享区/T1/', '共享区/工具/']);
  assert.match(runs[1].opts.prompt, /申请的写入范围已经生效|接着做/);
  runs[1].end();
});

test('写入范围：唤醒内容里写清能写哪里；Codex 的命令从草稿目录启动', () => {
  const { disp, tasks, project } = setup('scope-prompt');
  disp.ownerSay({ text: '@Codex 写脚本' });
  const wakes = all(project.db, "SELECT * FROM wakes WHERE target='Codex'");
  const base = { agent: 'Codex', project, tasks, wakes, connected: ['Claude', 'Codex'], resumed: false, qunPath: '/x/qun', lane: 'T1', parallel: 2, writable: disp.writableDirs('Codex', 'T1') };
  const p1 = buildPrompt({ ...base, enforced: true, cwdIsDraft: true });
  assert.match(p1, /【写入边界】[\s\S]*操作系统强制/);
  assert.match(p1, /能写的目录（相对项目文件夹）：成员\/Codex\/T1\/、共享区\/T1\//);
  assert.match(p1, /你的命令是从草稿目录 成员\/Codex\/T1\/ 启动的/);
  const p2 = buildPrompt({ ...base, agent: 'Claude', writable: disp.writableDirs('Claude', 'T1'), enforced: false, cwdIsDraft: false });
  assert.match(p2, /你是来审查的：被审查的成果对你只读，审查记录写到 共享区\/审查\/T1\//);
  assert.match(p2, /系统级的限制没有生效/);
});

test('写入边界：沙箱规则的内容；项目不能放在临时目录里', () => {
  const prof = seatbeltProfile('/Users/x/项目 A', ['/Users/x/项目 A/共享区/T1', '/Users/x/项目 A/.workgroup/rpc/req']);
  assert.match(prof, /\(allow default\)\n\(deny file-write\* \(subpath "\/Users\/x\/项目 A"\)\)\n\(allow file-write\* \(subpath "\/Users\/x\/项目 A\/共享区\/T1"\)/);
  assert.equal(inTempArea(os.tmpdir() + '/abc'), true);
  assert.equal(inTempArea('/tmp/abc'), true);
  assert.equal(inTempArea(path.join(os.homedir(), 'Desktop/项目')), false);
});

test('写入边界：范围里不能有符号链接；沙箱规则不跟着成员建的链接放开', () => {
  const { project, dir } = setup('scope-link');
  fs.mkdirSync(path.join(dir, '共享区/T9'), { recursive: true });
  fs.symlinkSync(dir, path.join(dir, '共享区/T9/root'));                       // 成员在自己范围里建了个指向项目根的链接
  assert.throws(() => normalizeScopeEntry(project, '共享区/T9/root/'), /符号链接/);
  assert.throws(() => normalizeScopeEntry(project, '共享区/T9/root/.workgroup/'), /符号链接/);
  assert.equal(normalizeScopeEntry(project, '共享区/T9/新目录/'), '共享区/T9/新目录/', '普通目录照常');
  const prof = seatbeltProfile(dir, [path.join(dir, '共享区/T9/root')]);
  const allowLine = prof.split('\n').find((l) => l.startsWith('(allow file-write*'));
  assert.ok(!allowLine.includes(`(subpath "${fs.realpathSync(dir)}")`), '不能借链接把项目根放开');
  if (sandboxStatus().ok) {
    const sb = path.join(dir, 'link.sb');
    fs.writeFileSync(sb, prof);
    const r = spawnSync(SANDBOX_EXEC, ['-f', sb, '/bin/sh', '-c', `echo x > '${path.join(dir, '共享区/T9/root/越界.txt')}'`]);
    assert.notEqual(r.status, 0, '沙箱里借链接写项目根被拒');
    assert.equal(fs.existsSync(path.join(dir, '越界.txt')), false);
  }
});

test('成员连不上工作台自己的端口（不能绕过 qun 直接调群主用的接口），外面的网照常', { skip: sandboxStatus().ok ? false : '这台机器上系统沙箱不可用' }, async () => {
  const http = await import('node:http');
  const srv = http.createServer((q, r) => r.end('ok'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const other = http.createServer((q, r) => r.end('ok'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-port-'));
    const prof = seatbeltProfile(dir, [], { denyPorts: [port] });
    assert.match(prof, new RegExp(`\\(deny network-outbound \\(remote tcp "localhost:${port}"\\)\\)`));
    const sb = path.join(dir, 'p.sb');
    fs.writeFileSync(sb, prof);
    const get = (p) => new Promise((resolve) => {
      const c = spawn(SANDBOX_EXEC, ['-f', sb, '/usr/bin/curl', '-s', '-m', '3', `http://127.0.0.1:${p}/`]);
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
    });
    const blocked = await get(port);
    assert.notEqual(blocked.out, 'ok', '工作台的端口连不上');
    assert.equal((await get(other.address().port)).out, 'ok', '别的端口照常');
  } finally { srv.close(); other.close(); }
});

test('成员的环境变量里没有别家的 key；.workgroup/ 不进项目的 git；打开就会运行的文件认得出来', () => {
  process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek'; process.env.OPENAI_API_KEY = 'sk-test-openai';
  try {
    const forCodex = cleanEnv({}, { dropNames: othersSecrets('Codex') });
    assert.equal(forCodex.DEEPSEEK_API_KEY, undefined); assert.equal(forCodex.OPENAI_API_KEY, 'sk-test-openai');
    const forClaude = cleanEnv({}, { dropNames: othersSecrets('Claude') });
    assert.equal(forClaude.DEEPSEEK_API_KEY, undefined); assert.equal(forClaude.OPENAI_API_KEY, undefined);
  } finally { delete process.env.DEEPSEEK_API_KEY; delete process.env.OPENAI_API_KEY; }
  const { dir } = setup('gitignore');
  assert.match(fs.readFileSync(path.join(dir, '.workgroup', '.gitignore'), 'utf8'), /^\*$/m);
  const f = (name, mode = 0o644) => { const p = path.join(dir, name); fs.writeFileSync(p, 'x'); fs.chmodSync(p, mode); return p; };
  assert.equal(opensAsProgram(f('结果.command')), true);
  assert.equal(opensAsProgram(f('run', 0o755)), true, '带执行权限的文件');
  assert.equal(opensAsProgram(f('说明.md')), false);
  fs.mkdirSync(path.join(dir, '看结果.app'));
  assert.equal(opensAsProgram(path.join(dir, '看结果.app')), true);
});

// 这一项不靠假成员：真的用操作系统的沙箱跑一个小程序，看它写得进哪里、写不进哪里（不花任何额度）
test('写入边界（系统级实测）：另一个会话的范围、收件箱、别人的成果，都写不进去', { skip: sandboxStatus().ok ? false : '这台机器上系统沙箱不可用' }, () => {
  const { disp, dir } = setup('scope-os');
  disp.ownerSay({ text: '@Claude 写文档 A' });                                // T1：Claude 负责，Codex 审查
  disp.ownerSay({ text: '@Claude 写文档 B' });                                // T2：也是 Claude 负责（它的另一个会话）
  fs.writeFileSync(path.join(dir, '收件箱/原始.csv'), '原始\n');
  const real = fs.realpathSync(dir);
  const sessionA = disp.prepareBoundary('Claude', 'T1', 'RtestA');           // Claude 做 T1 的会话
  const sessionB = disp.prepareBoundary('Claude', 'T2', 'RtestB');           // Claude 做 T2 的会话
  const reviewer = disp.prepareBoundary('Codex', 'T1', 'RtestC');            // Codex 审 T1 的会话
  assert.ok(sessionA.enforced && sessionA.profile);
  const tryWrite = (session, rel, how = 'write') => {
    const target = path.join(real, rel);
    const code = how === 'write' ? `require('fs').writeFileSync(${JSON.stringify(target)}, 'x')`
      : how === 'append' ? `require('fs').appendFileSync(${JSON.stringify(target)}, 'x')`
      : `require('fs').unlinkSync(${JSON.stringify(target)})`;
    return spawnSync(SANDBOX_EXEC, ['-f', session.profile, process.execPath, '-e', code], { encoding: 'utf8' }).status === 0;
  };
  // 各写各的：可以
  assert.equal(tryWrite(sessionA, '共享区/T1/a.md'), true);
  assert.equal(tryWrite(sessionB, '共享区/T2/b.md'), true);
  assert.equal(tryWrite(sessionA, '成员/Claude/T1/草稿.md'), true);
  // 同一位成员的另一个会话来改这个文件：系统拒绝
  assert.equal(tryWrite(sessionB, '共享区/T1/a.md', 'append'), false, 'T2 的会话改不了 T1 的文件');
  assert.equal(tryWrite(sessionB, '共享区/T1/a.md', 'unlink'), false, '也删不掉');
  assert.equal(tryWrite(sessionA, '共享区/T2/b.md', 'append'), false, '反过来也一样');
  assert.equal(tryWrite(sessionB, '成员/Claude/T1/草稿.md', 'append'), false, '连另一个会话的草稿也动不了');
  // 审查人：能写审查记录，改不了成果
  assert.equal(tryWrite(reviewer, '共享区/审查/T1/记录.md'), true);
  assert.equal(tryWrite(reviewer, '共享区/T1/a.md', 'append'), false, '审查人改不了被审查的成果');
  // 收件箱对谁都只读；项目根目录不能乱放文件；工作台内部的数据库也碰不了
  for (const s of [sessionA, sessionB, reviewer]) {
    assert.equal(tryWrite(s, '收件箱/原始.csv', 'append'), false);
    assert.equal(tryWrite(s, '收件箱/原始.csv', 'unlink'), false);
    assert.equal(tryWrite(s, '乱放.txt'), false);
    assert.equal(tryWrite(s, '.workgroup/state.db', 'append'), false);
  }
  assert.equal(fs.readFileSync(path.join(dir, '共享区/T1/a.md'), 'utf8'), 'x', 'T1 的文件没有被别的会话动过');
  assert.equal(fs.readFileSync(path.join(dir, '收件箱/原始.csv'), 'utf8'), '原始\n');
  // 提交之后，负责人自己的下一个会话也写不进去了
  handleQun(disp, 'Claude', ['task', 'submit', 'T1', '--file', '共享区/T1/a.md', '--run', 'r', '--evidence', 'e']);
  const afterSubmit = disp.prepareBoundary('Claude', 'T1', 'RtestD');
  assert.equal(tryWrite(afterSubmit, '共享区/T1/a.md', 'append'), false, '提交后锁定');
  assert.equal(tryWrite(afterSubmit, '成员/Claude/T1/草稿.md', 'append'), true);
});

// ---- 手机访问 ----
{
  const { Remote, phoneAllowed } = await import('../server/remote.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-remote-'));
  const mk = () => new Remote({ file: path.join(tmp, 'remote.json') });

  test('手机访问：没打开时不能生成配对码，也认不出任何设备', () => {
    const r = mk();
    assert.throws(() => r.newCode(), /先打开/);
    assert.equal(r.auth('wg_dev=abc.def'), null);
  });
  test('手机访问：配对码只能用一次，配对后凭 cookie 认出设备，移除后立刻失效', () => {
    const r = mk(); r.setEnabled(true);
    const { value } = r.newCode();
    const cookie = r.pair(value, 'iPhone');
    assert.throws(() => r.pair(value, 'iPhone'), /失效/);
    assert.equal(r.auth(`a=1; wg_dev=${cookie}`)?.name, 'iPhone');
    assert.equal(r.auth(`wg_dev=${cookie}x`), null);
    assert.equal(mk().auth(`wg_dev=${cookie}`)?.name, 'iPhone');           // 重启后还认得
    assert.ok(!fs.readFileSync(path.join(tmp, 'remote.json'), 'utf8').includes(cookie.split('.')[1]));   // 存的是摘要，不是那串本身
    r.revoke(r.devices[0].id);
    assert.equal(r.auth(`wg_dev=${cookie}`), null);
  });
  test('手机访问：配对码输错 5 次就作废', () => {
    const r = mk(); r.setEnabled(true);
    const { value } = r.newCode();
    const wrong = value === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) assert.throws(() => r.pair(wrong), /不对/);
    assert.throws(() => r.pair(wrong), /作废/);
    assert.throws(() => r.pair(value), /失效/);
  });
  test('手机访问：关掉开关后，已配对的设备也进不来', () => {
    const r = mk(); r.setEnabled(true);
    const cookie = r.pair(r.newCode().value, 'x');
    r.setEnabled(false);
    assert.equal(r.auth(`wg_dev=${cookie}`), null);
  });
  test('手机访问：手机能发消息和验收，不能改设置、换模型、删项目、管理手机访问', () => {
    const ok = (m, p) => phoneAllowed(m, p.split('/'));
    for (const p of ['api/app', 'api/events', 'api/p/x/state', 'index.html']) assert.ok(ok('GET', p), p);
    for (const p of ['api/p/x/say', 'api/p/x/upload', 'api/p/x/task/T1/approve', 'api/p/x/task/T1/reject', 'api/p/x/agent/Claude/stop', 'api/p/x/run/r1/stop']) assert.ok(ok('POST', p), p);
    for (const p of ['api/app/settings', 'api/app/pick-folder', 'api/projects', 'api/p/x/meta', 'api/p/x/move', 'api/p/x/remove', 'api/p/x/open', 'api/p/x/task/T1/model', 'api/p/x/agent/Claude/model', 'api/p/x/agent/Claude/new-session', 'api/remote/enable', 'api/remote/code', 'api/remote/revoke']) assert.ok(!ok('POST', p), p);
    assert.ok(!ok('GET', 'api/remote'));
  });
}

// ---- 改动快照：看这一次改了什么，不满意就撤回 ----------------------------------
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('等太久了'); await tick(20); } };

test('改动快照：每次运行前后各拍一次，只算这次运行能写的目录；大文件和 node_modules 不拍；能看逐行对比', async () => {
  const { disp, project, dir } = setup('snap', undefined, { snapshots: true });
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  const m1 = disp.ownerSay({ text: '@Codex 写两个文件', asTask: false });
  await until(() => runs.length === 1);
  const draft = runs[0].opts.sandbox.draftAbs;
  assert.equal(path.relative(dir, draft), path.join('成员', 'Codex', `对话${m1.chainId}`));
  fs.writeFileSync(path.join(draft, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(draft, 'b.md'), '# 标题\n第一行\n');
  fs.writeFileSync(path.join(draft, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 1));
  fs.mkdirSync(path.join(draft, 'node_modules')); fs.writeFileSync(path.join(draft, 'node_modules', 'x.js'), '1');
  fs.mkdirSync(path.join(dir, '成员', 'Claude', '日常'), { recursive: true });
  fs.writeFileSync(path.join(dir, '成员', 'Claude', '日常', '别人的.txt'), '同时在跑的别的会话写的');      // 不是这次运行能写的地方
  runs[0].end({ finalText: '写好了' });
  const runId = runs[0].opts.extraEnv.QUN_RUN;
  await until(() => disp.runs().find((r) => r.id === runId)?.changes);
  const ch = disp.runs().find((r) => r.id === runId).changes;
  assert.equal(ch.n, 2, '只算 a.txt 和 b.md');
  assert.equal(ch.adds, 3); assert.equal(ch.skipped, 1, '6 MB 的文件记为没拍');
  const d = await disp.snap.diff(runId);
  assert.deepEqual(d.files.map((f) => [f.p.split('/').pop(), f.s]).sort(), [['a.txt', 'A'], ['b.md', 'A']]);
  assert.match(d.text, /\+hello/);
  assert.ok(!d.text.includes('别人的') && !d.text.includes('node_modules'));
  assert.equal(d.skipped.length, 1);
  assert.ok(fs.existsSync(path.join(dir, '.workgroup', 'snap.git', 'HEAD')), '快照放在 .workgroup 里自己的仓库');
  assert.ok(!fs.existsSync(path.join(dir, '.git')), '不会把项目变成 git 仓库');

  // 第二次：改一个、删一个、加一个 —— 然后撤回
  disp.ownerSay({ text: '@Codex 改一下', asTask: false, chatId: m1.chainId });
  await until(() => runs.length === 2);
  fs.writeFileSync(path.join(draft, 'a.txt'), 'hello\nworld\n');
  fs.rmSync(path.join(draft, 'b.md'));
  fs.writeFileSync(path.join(draft, 'c.txt'), 'new\n');
  runs[1].end({ finalText: '改好了' });
  const run2 = runs[1].opts.extraEnv.QUN_RUN;
  await until(() => disp.runs().find((r) => r.id === run2)?.changes);
  assert.deepEqual((await disp.snap.diff(run2)).files.map((f) => [f.p.split('/').pop(), f.s]).sort(), [['a.txt', 'M'], ['b.md', 'D'], ['c.txt', 'A']]);
  const out = await disp.rollbackRun(run2);
  assert.equal(out.files, 3);
  assert.equal(fs.readFileSync(path.join(draft, 'a.txt'), 'utf8'), 'hello\n');
  assert.equal(fs.readFileSync(path.join(draft, 'b.md'), 'utf8'), '# 标题\n第一行\n', '删掉的文件找回来了');
  assert.ok(!fs.existsSync(path.join(draft, 'c.txt')), '新加的文件删掉了');
  assert.ok(fs.existsSync(path.join(draft, 'big.bin')), '大文件不动');
  assert.match(project.messages().at(-1).text, /群主撤回了 @Codex 那次运行改的 3 个文件/);
  assert.equal(disp.runs().find((r) => r.id === run2).changes.rolled != null, true);
  await assert.rejects(disp.rollbackRun(run2), /已经撤回过了/);

  // 第三次：成员改了以后，群主自己又改了同一个文件 —— 拒绝撤回，一个文件也不动
  disp.ownerSay({ text: '@Codex 再改', asTask: false, chatId: m1.chainId });
  await until(() => runs.length === 3);
  fs.writeFileSync(path.join(draft, 'a.txt'), 'v3\n');
  fs.writeFileSync(path.join(draft, 'd.txt'), 'd\n');
  runs[2].end({ finalText: '又改了' });
  const run3 = runs[2].opts.extraEnv.QUN_RUN;
  await until(() => disp.runs().find((r) => r.id === run3)?.changes);
  fs.writeFileSync(path.join(draft, 'a.txt'), '群主手改的\n');
  await assert.rejects(disp.rollbackRun(run3), /又被改过[\s\S]*a\.txt/);
  assert.equal(fs.readFileSync(path.join(draft, 'a.txt'), 'utf8'), '群主手改的\n');
  assert.ok(fs.existsSync(path.join(draft, 'd.txt')), '拒绝时一个文件也不动');

  // 第一次运行的改动后来被第二、三次覆盖过：也拒绝
  await assert.rejects(disp.rollbackRun(runId), /又被改过/);

  // 清理：超过 30 天的删掉
  const r = await disp.snap.prune({ now: Date.now() + 31 * 86400_000 });
  assert.equal(r.removed, 3);
  await assert.rejects(disp.snap.diff(run3), /保留期限/);
  disp.dispose();
});

test('改动快照：任务卡还没结束，快照过了 30 天也不删；运行还没开始就被停，不会启动成员', async () => {
  const { disp, project, tasks } = setup('snap-keep', undefined, { snapshots: true });
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Claude 写使用说明' });
  await until(() => runs.length === 1);
  fs.writeFileSync(path.join(runs[0].opts.sandbox.draftAbs, '草稿.md'), '草稿\n');
  runs[0].end();
  const id = runs[0].opts.extraEnv.QUN_RUN;
  await until(() => disp.runs().find((r) => r.id === id)?.changes);
  const open = new Set(tasks.list().filter((t) => !['done', 'cancelled'].includes(t.state)).map((t) => t.id));
  assert.equal((await disp.snap.prune({ openTasks: open, now: Date.now() + 40 * 86400_000 })).removed, 0, 'T1 还没做完，不删');

  // 拍“之前”的快照时就被停了：不启动成员，唤醒单标成已取消
  const m = disp.ownerSay({ text: '@Codex 跑一下', asTask: false });
  disp.pump();                                   // 马上派出去：会话已登记，“之前”的快照还在拍
  assert.equal(disp.runsOf('Codex').length, 1);
  assert.equal(disp.stop('Codex'), true);
  await tick(400);
  assert.equal(runs.filter((r) => r.agent === 'Codex').length, 0, '没有启动');
  assert.equal(wakeOf(project, m.id).state, 'cancelled');
  assert.equal(disp.runsOf('Codex').length, 0);
  disp.dispose();
});

// ---- 重启后接着做 ----------------------------------------------------------
test('重启后接着做：提示里写清打断前做到哪（正在跑的命令、改了的文件、说过的话）；群里在那个对话里说明', async () => {
  const { disp, project, dir } = setup('resume', undefined, { snapshots: true });
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  const m = disp.ownerSay({ text: '@Claude 分两步：先写 第一步.txt，等一分钟，再写 第二步.txt', asTask: false });
  await until(() => runs.length === 1);
  const r1 = runs[0];
  await tick(10);                                                // 等它报回会话号
  fs.writeFileSync(path.join(r1.opts.sandbox.draftAbs, '第一步.txt'), '1\n');
  r1.opts.on.activity({ kind: 'cmd', text: 'sleep 60' });
  r1.opts.on.reply('第一步写好了，接下来等一分钟');
  // 工作台在这时崩了：不收尾，直接换一个新的工作台进程把项目打开
  disp.dispose(); project.close();
  const p2 = new Project({ id: 'resume', name: 'resume', dir });
  const d2 = new Dispatcher(p2, { adapters: {}, status: disp.env.status, appDir: APP_DIR, snapshots: true });
  const runs2 = fakeAgents(d2);
  await until(() => runs2.length === 1);
  const pr = runs2[0].opts.prompt;
  assert.equal(runs2[0].opts.sessionId, 'sess-Claude', '接着原来的会话');
  assert.match(pr, /工作台重启把它打断了，现在接着做（这是第 1 次接着做）/);
  assert.match(pr, /你当时正在执行：sleep 60/);
  assert.match(pr, /第一步\.txt（新增）/);
  assert.match(pr, /你已经在群里说过：「第一步写好了/);
  assert.match(pr, /先确认上一步有没有生效/);
  const note = p2.messages().find((x) => x.kind === 'system' && /已自动让它接着做/.test(x.text));
  assert.ok(note, '群里有说明');
  assert.equal(note.chainId, m.chainId, '说明发在那个对话里，不是整个项目');
  assert.match(note.text, /第 1 次，最多 3 次/);
  runs2[0].end({ finalText: '第二步也写好了' });
  await tick(60);
  d2.dispose();
});

test('重启后接着做：同一张卡连续被重启打断超过 3 次就停下，标成卡住，交给群主；不到 3 次照常接着做', () => {
  const { project, disp, tasks, dir } = setup('resume-cap');
  disp.ownerSay({ text: '@Codex 跑一个会把工作台弄崩的脚本' });
  disp.ownerSay({ text: '@DeepSeek 整理一下目录' });
  const R = '工作台重启时这次运行还没结束';
  const ins = (id, agent, lane, ts, status) => project.db.prepare("INSERT INTO runs(id,agent,started_ts,status,error,lane,kind,task_id) VALUES(?,?,?,?,?,?,'work',?)").run(id, agent, ts, status, status === 'interrupted' ? R : null, lane, lane);
  // T1：之前已经连着 3 次被重启打断，这是第 4 次
  ins('A1', 'Codex', 'T1', 1, 'interrupted'); ins('A2', 'Codex', 'T1', 2, 'interrupted'); ins('A3', 'Codex', 'T1', 3, 'interrupted'); ins('A4', 'Codex', 'T1', 4, 'running');
  project.db.prepare("UPDATE wakes SET state='accepted', run_id='A4' WHERE task_id='T1'").run();
  // T2：之前打断过 2 次，中间有一次正常跑完的不算“连续”
  ins('B0', 'DeepSeek', 'T2', 1, 'interrupted'); ins('B1', 'DeepSeek', 'T2', 2, 'ok'); ins('B2', 'DeepSeek', 'T2', 3, 'interrupted'); ins('B3', 'DeepSeek', 'T2', 4, 'running');
  project.db.prepare("UPDATE wakes SET state='delivered', run_id='B3' WHERE task_id='T2'").run();
  disp.dispose(); project.close();
  const p2 = new Project({ id: 'resume-cap', name: 'resume-cap', dir });
  const d2 = new Dispatcher(p2, { adapters: {}, status: disp.env.status, appDir: APP_DIR, snapshots: false });
  const w1 = one(p2.db, "SELECT * FROM wakes WHERE task_id='T1'");
  assert.equal(w1.state, 'failed'); assert.match(w1.note, /连续 4 次/);
  assert.equal(d2.tasks.get('T1').state, 'blocked', '标成卡住');
  assert.match(d2.tasks.events('T1').at(-1).text, /连续 4 次/);
  const stop = p2.messages().find((x) => /不再自动让它接着做/.test(x.text));
  assert.ok(stop && stop.meta.failedRun === 'A4' && stop.meta.mentions.includes('群主'), '提醒群主，并带“重试”');
  const w2 = one(p2.db, "SELECT * FROM wakes WHERE task_id='T2'");
  assert.equal(w2.state, 'queued'); assert.match(w2.note, /第 2 次/);
  assert.equal(d2.tasks.get('T2').state, 'dispatched');
  assert.equal(one(p2.db, "SELECT COUNT(*) AS n FROM wakes WHERE target='Claude'").n, 0, '不去叫协调员');
  d2.dispose();
  void tasks;
});

// ---- 连续失败熔断 ------------------------------------------------------------
test('熔断：出错、超时自动重试两次（先等一会儿），第 3 次停下交给群主；群主点重试照样能跑，跑通了重新计数', async () => {
  const { disp, project, tasks } = setup('breaker');
  const runs = fakeAgents(disp);
  disp.retryWaitMs = [150, 150];
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 写个下载脚本' });
  await until(() => runs.length === 1);
  await tick(10);
  const wake = () => one(project.db, "SELECT * FROM wakes WHERE task_id='T1'");
  const sys = () => project.messages().filter((m) => m.kind === 'system');

  // 第 1 次：出错 → 放回队列，等一会儿自动再试；群里说明，不打扰群主
  runs[0].end({ status: 'error', error: 'Could not resolve host: api.openai.com' });
  await tick(60);
  assert.equal(runs.length, 1, '还在等，没有马上重试');
  assert.equal(wake().state, 'queued'); assert.match(wake().note, /1 分钟后自动重试（第 1 次）/);
  const n1 = sys().at(-1);
  assert.match(n1.text, /没有完成：Could not resolve host[\s\S]*1 分钟后自动再试（连着 3 次没完成就停下交给群主，这是第 1 次）/);
  assert.ok(!n1.meta?.mentions?.includes('群主'), '自动重试时不打扰群主');
  assert.equal(n1.taskId, 'T1');
  await until(() => runs.length === 2);
  assert.equal(runs[1].opts.sessionId, 'sess-Codex', '接着原来的会话');
  assert.match(runs[1].opts.prompt, /你上一次运行没有完成（Could not resolve host: api\.openai\.com），工作台自动让你再试一次（这是第 1 次重试；连着 3 次没完成就停下来交给群主）/);
  await tick(10);

  // 第 2 次：超时 → 再等一会儿再试
  runs[1].opts.on.activity({ kind: 'cmd', text: 'python3 下载.py' });
  runs[1].end({ status: 'timeout' });
  await tick(30);
  assert.match(wake().note, /5 分钟后自动重试（第 2 次）/);
  await until(() => runs.length === 3);
  assert.match(runs[2].opts.prompt, /没有完成（超过 25 分钟没做完，被自动停止）[\s\S]*第 2 次重试[\s\S]*出问题前你正在执行：python3 下载\.py/);
  await tick(10);

  // 第 3 次：熔断。唤醒单失败、任务卡卡住、提醒群主（带“重试”），不叫协调员，也不再自动重试
  runs[2].end({ status: 'error', error: 'boom' });
  await tick(300);
  assert.equal(runs.length, 3, '不再自动重试');
  assert.equal(wake().state, 'failed'); assert.match(wake().note, /连续 3 次没有完成：boom/);
  assert.equal(tasks.get('T1').state, 'blocked');
  assert.match(tasks.events('T1').at(-1).text, /连续 3 次没有完成/);
  const stop = sys().at(-1);
  assert.match(stop.text, /连续 3 次没有完成（最近一次：boom），工作台不再自动重试/);
  assert.equal(stop.meta.failedRun, runs[2].opts.extraEnv.QUN_RUN);
  assert.ok(stop.meta.mentions.includes('群主'));
  assert.equal(one(project.db, "SELECT COUNT(*) AS n FROM wakes WHERE target='Claude'").n, 0, '不去叫协调员');
  assert.equal(disp.pendingWakes().find((w) => w.state === 'failed').runId, runs[2].opts.extraEnv.QUN_RUN, '界面的“重试”只重试这次运行的唤醒单');

  // 群主点“重试”：照样跑（熔断只管自动重试）；又失败了，还是直接交给群主
  disp.retryFailed(wake().id);
  await until(() => runs.length === 4);
  assert.match(runs[3].opts.prompt, /第 3 次重试/);
  await tick(10);
  runs[3].end({ status: 'error', error: 'still down' });
  await tick(250);
  assert.equal(runs.length, 4);
  assert.equal(wake().state, 'failed'); assert.match(sys().at(-1).text, /连续 4 次没有完成/);
  // 再点一次重试，跑通了：重新计数。之后再出错，又是第 1 次、自动重试
  disp.retryFailed(wake().id);
  await until(() => runs.length === 5);
  await tick(10);
  runs[4].end({ finalText: '下载脚本写好了' });
  await tick(30);
  assert.equal(wake().state, 'done');
  assert.equal(disp.failStreak('Codex', 'T1'), 0);
  disp.ownerSay({ text: '@Codex 再加一个断点续传', taskId: 'T1' });
  await until(() => runs.length === 6);
  await tick(10);
  runs[5].end({ status: 'error', error: 'network' });
  await tick(30);
  assert.match(sys().at(-1).text, /这是第 1 次）/);
  await until(() => runs.length === 7);
  runs[6].end();
  await tick(30);
  disp.dispose();
});

test('熔断：等自动重试的时候，群主新发的消息不用等（一起送过去）；成员之间的 @ 照样等', async () => {
  const { disp, project } = setup('breaker-wait');
  const runs = fakeAgents(disp);
  disp.retryWaitMs = [60_000];
  project.patchSettings({ paused: false });
  const m = disp.ownerSay({ text: '@Codex 装依赖' });
  await until(() => runs.length === 1);
  await tick(10);
  runs[0].end({ status: 'error', error: '529 overloaded' });
  await tick(60);
  disp.wake({ target: 'Codex', reason: 'mention', taskId: 'T1', dedupeKey: 'peer-1', chainId: m.chainId, byAgent: true });
  await tick(80);
  assert.equal(runs.length, 1, '别的成员来 @，也要等');
  disp.ownerSay({ text: '@Codex 换国内镜像试试', taskId: 'T1' });
  await until(() => runs.length === 2);
  assert.equal(runs[1].opts.prompt.match(/换国内镜像/g)?.length, 1);
  assert.match(runs[1].opts.prompt, /你上一次运行没有完成（529 overloaded）/);
  assert.equal(all(project.db, "SELECT run_id FROM wakes WHERE task_id='T1'").filter((w) => w.run_id === runs[1].opts.extraEnv.QUN_RUN).length, 3, '重试的、成员 @ 的、群主新说的，一起送进这次运行');
  runs[1].end();
  await tick(30);
  disp.dispose();
});

test('被系统拦下：认得出拦截报错，不认正文里提到的；群里说明被拦了什么；连着 3 次就停下交给群主', async () => {
  for (const line of [
    'touch: 共享区/T9/x.md: Operation not permitted',
    'zsh:1: operation not permitted: 共享区/T9/x.md',
    "EPERM: operation not permitted, open '/p/共享区/T9/x.md'",
    "PermissionError: [Errno 1] Operation not permitted: '/p/x'",
    'cp: /p/收件箱/a.csv: Read-only file system',
  ]) assert.equal(deniedLine(`前面一行\n${line}\n后面一行`), line, line);
  for (const text of [
    '写入被拒绝（报 operation not permitted / EPERM）说明那个位置不归你。',
    'Operation not permitted 是常见的报错',
    'error: Operation not permitted is common on macOS',
    '',
  ]) assert.equal(deniedLine(text), null, text);
  // zsh 把中文路径转义成 \\M-^E 这类，解码后是乱码：换成省略号
  assert.equal(deniedLine(String.raw`(eval):1: operation not permitted: \uFFFD\M-^E\uFFFD享\uFFFD\M-\n\uFFFD2.txt`.replace(/\\uFFFD/g, '\uFFFD')), '(eval):1: operation not permitted: …享…2.txt');

  const { disp, project, tasks } = setup('denied');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 改一下 共享区/T9/x.md' });
  await until(() => runs.length === 1);
  await tick(10);
  runs[0].opts.on.denied('touch: 共享区/T9/x.md: Operation not permitted');
  runs[0].opts.on.denied('touch: 共享区/T9/x.md: Operation not permitted');
  runs[0].opts.on.denied("zsh:1: operation not permitted: 共享区/T9/y.md");
  runs[0].opts.on.denied(`EPERM: operation not permitted, open '${project.dir}/共享区/T9/z.md'`, `Write ${project.dir}/共享区/T9/z.md`);
  runs[0].end({ finalText: '那个目录不归我，写不进去' });
  await tick(30);
  const rid = runs[0].opts.extraEnv.QUN_RUN;
  assert.equal(one(project.db, 'SELECT denied FROM runs WHERE id=?', rid).denied, 4);
  assert.equal(one(project.db, "SELECT state FROM wakes WHERE task_id='T1'").state, 'done', '跑完了就是跑完了，不重试');
  const n = project.messages().filter((m) => m.kind === 'system').at(-1);
  assert.match(n.text, /有 4 处操作被系统拦下，写到了不归它的位置，或者做了沙箱不允许的事：「touch: 共享区\/T9\/x\.md: Operation not permitted」 「zsh:1: operation not permitted: 共享区\/T9\/y\.md」 「Write 共享区\/T9\/z\.md」（operation not permitted） 等 4 处/);
  assert.equal(n.meta.run, rid);
  assert.ok(fs.readFileSync(runs[0].opts.logPath, 'utf8').includes('"kind":"denied"'), '过程记录里也有');
  // 中间一次干净跑完就重新计数
  disp.ownerSay({ text: '@Codex 那先写在自己的范围里', taskId: 'T1' });
  await until(() => runs.length === 2); await tick(10);
  runs[1].end(); await tick(30);
  assert.equal(disp.failStreak('Codex', 'T1'), 0);
  // 连着 3 次被拦（中间夹一次出错也算）：任务卡卡住，提醒群主
  for (let i = 0; i < 3; i++) {
    const msg = disp.ownerSay({ text: `@Codex 再试第 ${i + 1} 次`, taskId: 'T1' });
    await until(() => runs.length === 3 + i); await tick(10);
    const r = runs.at(-1);
    if (i === 1) { disp.retryWaitMs = [0, 0]; r.end({ status: 'error', error: 'boom' }); await until(() => runs.length === 3 + i + 1); await tick(10); runs.at(-1).opts.on.denied('touch: 共享区/T9/x.md: Operation not permitted'); runs.at(-1).end(); await tick(30); break; }
    r.opts.on.denied('touch: 共享区/T9/x.md: Operation not permitted');
    r.end(); await tick(30);
    void msg;
  }
  // 次序：被拦 → 出错（自动重试）→ 重试那次被拦 = 连着 3 次
  assert.equal(disp.failStreak('Codex', 'T1'), 3);
  assert.equal(tasks.get('T1').state, 'blocked');
  const stop = project.messages().filter((m) => m.kind === 'system').at(-1);
  assert.match(stop.text, /连续 3 次运行被系统拦下或没有完成[\s\S]*@群主 请决定：给它换个写入范围、改派，或者取消/);
  assert.ok(stop.meta.mentions.includes('群主'));
  disp.dispose();
});

test('熔断计数：出错、超时、被拦算；被重启打断、群主停止、被叫停、额度用尽的跳过；干净跑完就清零', () => {
  const { disp, project } = setup('streak');
  const ins = (id, ts, status, denied = 0) => project.db.prepare("INSERT INTO runs(id,agent,started_ts,status,lane,kind,denied) VALUES(?,?,?,?,?,'work',?)").run(id, 'Claude', ts, status, 'T5', denied);
  ins('a', 1, 'error'); ins('b', 2, 'ok'); ins('c', 3, 'timeout'); ins('d', 4, 'interrupted'); ins('e', 5, 'ok', 2);
  ins('f', 6, 'stopped'); ins('g', 7, 'quota'); ins('h', 8, 'superseded'); ins('i', 9, 'error');
  assert.equal(disp.failStreak('Claude', 'T5'), 3, 'c、e、i 连着，b 跑通了所以 a 不算');
  assert.equal(disp.failStreak('Claude', 'T6'), 0, '别的线不算');
  assert.equal(disp.failStreak('Codex', 'T5'), 0, '别的成员不算');
  disp.dispose();
});

test('报错原文是一整段 JSON 时，群里只显示里面那句话', () => {
  assert.equal(readableError('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'x\' model is not supported.","code":"model_not_found"}}'), "The 'x' model is not supported.");
  assert.equal(readableError('开始这一轮失败：{"message":"bad"}'), '开始这一轮失败：bad');
  assert.equal(readableError('Could not resolve host'), 'Could not resolve host');
  assert.equal(readableError('{not json'), '{not json');
  assert.equal(readableError(null), '未知错误');
});

// ---- 已过时 --------------------------------------------------------------
test('已过时：成员干活期间任务卡被群主取消了，它交回来的话标成“已过时”，里面 @ 的人先不叫醒；群主可以照样送出', async () => {
  const { disp, project, tasks } = setup('stale');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 写个导出脚本' });
  await until(() => runs.length === 1); await tick(10);
  tasks.cancel('T1', '群主', '不需要了');
  runs[0].end({ finalText: '脚本写好了，@Claude 帮我审一下' });
  await tick(30);
  const m = project.messages().filter((x) => x.sender === 'Codex').at(-1);
  assert.equal(m.meta.stale?.taskId, 'T1');
  assert.match(m.meta.stale.text, /它干活期间，任务 T1 有了新进展：群主取消了/);
  assert.equal(one(project.db, "SELECT COUNT(*) AS n FROM wakes WHERE target='Claude'").n, 0, '先不叫醒 Claude');
  // 群主看过后决定照样送出：Claude 照常被叫醒；不会送两次
  assert.deepEqual(disp.forwardStale(m.id), { forwarded: true });
  assert.equal(one(project.db, "SELECT COUNT(*) AS n FROM wakes WHERE target='Claude'").n, 1);
  assert.equal(project.message(m.id).meta.stale.forwarded, true);
  assert.deepEqual(disp.forwardStale(m.id), { forwarded: false });
  assert.throws(() => disp.forwardStale(project.messages().find((x) => x.sender === '群主').id), /没有标成已过时/);
  await tick(80);
  for (const r of runs.slice(1)) r.end();
  await tick(30);
  disp.dispose();
});

test('已过时：它自己这次运行做的提交不算；别人推进了才算（qun say 也一样）；给成员看的群聊里标出来；不多跑一次', async () => {
  const { disp, project, tasks, dir } = setup('stale-own');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 写个导出脚本' });
  await until(() => runs.length === 1); await tick(10);
  const rid = runs[0].opts.extraEnv.QUN_RUN;
  fs.mkdirSync(path.join(dir, '共享区', 'T1'), { recursive: true });
  fs.writeFileSync(path.join(dir, '共享区', 'T1', 'export.py'), 'print(1)\n');
  handleQun(disp, 'Codex', ['task', 'accept', 'T1'], '', rid);
  handleQun(disp, 'Codex', ['task', 'submit', 'T1', '--file', '共享区/T1/export.py', '--run', 'python3 export.py', '--evidence', '输出 1'], '', rid);
  assert.equal(tasks.get('T1').state, 'in_review');
  assert.equal(JSON.parse(one(project.db, "SELECT data FROM task_events WHERE task_id='T1' AND type='submitted'").data).run, rid, '事件上记了是哪次运行做的');
  runs[0].end({ finalText: '提交了，@Claude 请审查' });
  await tick(30);
  assert.ok(!project.messages().filter((x) => x.sender === 'Codex').at(-1).meta.stale, '自己这次运行的提交不算过时');

  // 审查人 Claude 开始审；审到一半，负责人在别的地方重新交了一版
  await until(() => runs.some((r) => r.agent === 'Claude')); await tick(10);
  const rv = runs.find((r) => r.agent === 'Claude');
  fs.writeFileSync(path.join(dir, '共享区', 'T1', 'export.py'), 'print(2)\n');
  qun(disp, 'Codex', ['task', 'submit', 'T1', '--file', '共享区/T1/export.py', '--run', 'python3 export.py', '--evidence', '输出 2']);
  const codexWakes = () => one(project.db, "SELECT COUNT(*) AS n FROM wakes WHERE target='Codex'").n;
  const before = codexWakes();
  const out = handleQun(disp, 'Claude', ['say', '看了，@Codex 第 3 行要改'], '', rv.opts.extraEnv.QUN_RUN);
  assert.match(out, /标成了“已过时”：它干活期间，任务 T1 有了新进展：@Codex 提交了。里面的 @Codex 没有送出，等群主决定/);
  assert.equal(codexWakes(), before, 'qun say 里的 @ 也先不叫醒');
  rv.end({ finalText: '审完了，@Codex 第 3 行要改' });
  await tick(30);
  const stale = project.messages().filter((x) => x.sender === 'Claude');
  assert.ok(stale.length === 2 && stale.every((x) => x.meta.stale), '两段话都标了');
  assert.equal(codexWakes(), before);
  const runsBefore = runs.length;

  // 之后再叫 Codex：给它看的群聊里，这两条标着“已过时”
  disp.ownerSay({ text: '@Codex 看一下现在的情况', taskId: 'T1' });
  await until(() => runs.filter((r) => r.agent === 'Codex').length === 2);
  const p2 = runs.filter((r) => r.agent === 'Codex')[1].opts.prompt;
  assert.match(p2, /@Claude（已过时，写的时候还不知道任务卡后来的进展）：看了，@Codex 第 3 行要改/);
  assert.ok(runs.length - runsBefore <= 2, '标“已过时”本身不让谁多跑一次');
  await tick(30);
  for (const r of runs) { try { r.end(); } catch { /* 已结束 */ } }
  await tick(30);
  disp.dispose();
});

// ---- 每张卡一个 git 工作区 ------------------------------------------------------
const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`);
  return r.stdout.trim();
};
// 把测试项目变成一个 git 仓库：main 分支上一个 app.js
function gitRepo(dir) {
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.name', '测试群主'); g(dir, 'config', 'user.email', 'owner@test.local');
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# 示例\n');
  g(dir, 'add', 'app.js', 'README.md');
  g(dir, 'commit', '-q', '-m', 'init');
}
const runIdOf = (r) => r.opts.extraEnv.QUN_RUN;

test('工作区：git 项目里每张卡一个工作区，负责人在里面改代码；提交时工作台替它提交到分支；群主验收时合并进当前分支，不推送', async () => {
  const { disp, project, tasks, dir } = setup('wt-flow');
  gitRepo(dir);
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 把 app.js 改成乘法，再加一个 lib.js' });
  await until(() => runs.length === 1);
  const wtAbs = path.join(dir, '.workgroup', 'worktrees', 'T1');
  const r1 = runs[0];
  assert.equal(r1.opts.cwd, wtAbs, '负责人的命令从这张卡的工作区启动');
  assert.ok(r1.opts.sandbox.dirs.includes('.workgroup/worktrees/T1/'), '工作区在它能写的目录里');
  assert.ok(r1.opts.sandbox.dirs.includes('共享区/T1/'), '写入范围照旧');
  assert.equal(g(wtAbs, 'rev-parse', '--abbrev-ref', 'HEAD'), 'workgroup/T1');
  assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.workgroup\/$/m, '项目自己的 git 看不到 .workgroup/');
  assert.match(r1.opts.prompt, /这张卡有自己的 git 工作区[\s\S]*workgroup\/T1[\s\S]*不要自己 git commit/);
  assert.ok(r1.opts.mdExcludes.includes(path.join(dir, 'CLAUDE.md')) && r1.opts.mdExcludes.includes(path.join(fs.realpathSync(dir), 'CLAUDE.md')), '项目根的 CLAUDE.md 不再读一遍');

  // 成员在工作区里改代码，项目文件夹里的原件不动
  fs.writeFileSync(path.join(wtAbs, 'app.js'), 'const a = 1;\nconst b = 2;\nconsole.log(a * b);\n');
  fs.writeFileSync(path.join(wtAbs, 'lib.js'), 'export const x = 1;\n');
  assert.match(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), /a \+ b/);
  handleQun(disp, 'Codex', ['task', 'accept', 'T1'], '', runIdOf(r1), wtAbs);
  // 相对路径按工作区找（项目文件夹里也有一个 app.js，但那是原件）
  const out = handleQun(disp, 'Codex', ['task', 'submit', 'T1', '--file', 'app.js', '--file', 'lib.js', '--run', 'node app.js', '--evidence', '输出 2'], '', runIdOf(r1), wtAbs);
  assert.match(out, /已提交/);
  const t1 = tasks.get('T1');
  assert.deepEqual(t1.submission.files.map((f) => f.path), ['.workgroup/worktrees/T1/app.js', '.workgroup/worktrees/T1/lib.js']);
  assert.equal(t1.submission.branch, 'workgroup/T1');
  assert.equal(g(dir, 'rev-parse', 'workgroup/T1'), t1.submission.sha, '改动提交到了这张卡的分支');
  assert.equal(g(dir, 'log', '-1', '--format=%an', 'workgroup/T1'), 'Codex（AgentQun）');
  assert.match(project.messages().filter((m) => m.kind === 'task').at(-1).text, /T1 工作区\/app\.js/);
  assert.equal(g(wtAbs, 'status', '--porcelain'), '', '提交后工作区是干净的');
  r1.end({ finalText: '改好了' });

  // 审查人：工作区对它只读，命令也从工作区启动（看得到 diff）
  await until(() => runs.length === 2);
  const r2 = runs[1];
  assert.equal(r2.agent, 'Claude');
  assert.ok(!r2.opts.sandbox.dirs.includes('.workgroup/worktrees/T1/'), '审查人不能写工作区');
  assert.match(r2.opts.prompt, /对你只读。看改了什么：git -C/);
  handleQun(disp, 'Claude', ['task', 'review', 'T1', '--pass', '--evidence', '跑了 node app.js 输出 2'], '', runIdOf(r2));
  r2.end({ finalText: '通过' });
  assert.equal(tasks.get('T1').state, 'awaiting_owner');

  // 验收前项目自己又往前走了一步（改的是别的文件）：照样能合
  fs.writeFileSync(path.join(dir, 'README.md'), '# 示例\n第二行\n');
  g(dir, 'commit', '-q', '-am', 'owner edits readme');
  tasks.approve('T1');
  assert.equal(tasks.get('T1').state, 'done');
  assert.match(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), /a \* b/, '改动合并进了项目');
  assert.ok(fs.existsSync(path.join(dir, 'lib.js')));
  assert.match(g(dir, 'log', '-1', '--format=%s'), /合并任务 T1/);
  assert.equal(g(dir, 'log', '-1', '--format=%an'), '测试群主', '合并提交用的是项目自己的身份');
  assert.equal(g(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.match(project.messages().filter((m) => m.kind === 'task').at(-1).text, /已合并进项目的 main 分支[\s\S]*没有推送/);
  // 清理：工作区删掉，分支已经合并了，也删掉
  await until(() => !fs.existsSync(wtAbs));
  assert.equal(g(dir, 'branch', '--list', 'workgroup/*'), '');
  assert.equal(tasks.get('T1').wt.merged.into, 'main');
  disp.dispose();
});

test('工作区：负责人改了工作区的 .git 文件，工作台照样用项目里登记的那份，不去用它指的仓库和配置', async () => {
  const { disp, project, tasks, dir } = setup('wt-gitfile');
  gitRepo(dir);
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 改一下 app.js' });
  await until(() => runs.length === 1);
  const wtAbs = path.join(dir, '.workgroup', 'worktrees', 'T1');
  // 负责人另建一个仓库，配上 fsmonitor（git 跑起来就会执行它），再把工作区的 .git 文件指过去
  const evil = path.join(dir, '共享区', 'evil.git');
  spawnSync('git', ['init', '-q', '--bare', evil]);
  const marker = path.join(dir, '被执行了.txt');
  spawnSync('git', ['--git-dir', evil, 'config', 'core.fsmonitor', `touch '${marker}'`]);
  fs.writeFileSync(path.join(wtAbs, '.git'), `gitdir: ${evil}\n`);
  fs.writeFileSync(path.join(wtAbs, 'app.js'), 'console.log(42);\n');
  handleQun(disp, 'Codex', ['task', 'accept', 'T1'], '', runIdOf(runs[0]), wtAbs);
  const out = handleQun(disp, 'Codex', ['task', 'submit', 'T1', '--file', 'app.js', '--run', 'node app.js', '--evidence', '42'], '', runIdOf(runs[0]), wtAbs);
  assert.match(out, /已提交/);
  assert.equal(fs.existsSync(marker), false, '成员配的程序没有被执行');
  assert.equal(g(dir, 'rev-parse', 'workgroup/T1'), tasks.get('T1').submission.sha, '照样提交到了这张卡在项目仓库里的分支');
  disp.stopAll();
});

test('工作区：合并有冲突就不合并、告诉群主冲突在哪；打回时工作台把最新改动合进工作区留下冲突标记，改好才能再提交', async () => {
  const { disp, project, tasks, dir } = setup('wt-conflict');
  gitRepo(dir);
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 改第一行' });
  await until(() => runs.length === 1);
  const wtAbs = path.join(dir, '.workgroup', 'worktrees', 'T1');
  fs.writeFileSync(path.join(wtAbs, 'app.js'), 'const a = 10;\nconst b = 2;\nconsole.log(a + b);\n');
  handleQun(disp, 'Codex', ['task', 'submit', 'T1', '--file', 'app.js', '--run', 'node app.js', '--evidence', '12'], '', runIdOf(runs[0]), wtAbs);
  runs[0].end();
  await until(() => runs.length === 2);
  handleQun(disp, 'Claude', ['task', 'review', 'T1', '--pass', '--evidence', 'ok'], '', runIdOf(runs[1]));
  runs[1].end();

  // 群主在项目里把同一行改成了别的
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 5;\nconst b = 2;\nconsole.log(a + b);\n');
  g(dir, 'commit', '-q', '-am', 'owner changes line 1');
  const head = g(dir, 'rev-parse', 'HEAD');
  assert.throws(() => tasks.approve('T1'), /没有合并：和 main 有冲突，冲突在 app\.js/);
  assert.equal(tasks.get('T1').state, 'awaiting_owner', '没合并就不算验收');
  assert.equal(g(dir, 'rev-parse', 'HEAD'), head, '项目分支一点没动');
  assert.equal(g(dir, 'status', '--porcelain', '-uno'), '', '项目文件夹里没有留下半截合并');
  assert.match(project.messages().at(-1).text, /改动没有合并[\s\S]*冲突在 app\.js[\s\S]*点“打回”/);
  assert.deepEqual(tasks.get('T1').wt.conflict.files, ['app.js']);

  // 打回：main 的最新改动合进工作区，冲突文件留下标记，告诉负责人
  tasks.reject('T1', '和 main 有冲突，请合一下');
  const wt = fs.readFileSync(path.join(wtAbs, 'app.js'), 'utf8');
  assert.match(wt, /^<<<<<<< /m); assert.match(wt, /^>>>>>>> /m);
  assert.match(project.messages().filter((m) => m.kind === 'task').at(-1).text, /有冲突标记[\s\S]*app\.js/);
  await until(() => runs.length === 3);
  assert.match(runs[2].opts.prompt, /【要先处理】[\s\S]*app\.js/);
  assert.throws(() => handleQun(disp, 'Codex', ['task', 'submit', 'T1', '--file', 'app.js', '--run', 'r', '--evidence', 'e'], '', runIdOf(runs[2]), wtAbs), /还有没解决的冲突标记[\s\S]*app\.js/);
  fs.writeFileSync(path.join(wtAbs, 'app.js'), 'const a = 50;\nconst b = 2;\nconsole.log(a + b);\n');
  handleQun(disp, 'Codex', ['task', 'submit', 'T1', '--file', 'app.js', '--run', 'node app.js', '--evidence', '52'], '', runIdOf(runs[2]), wtAbs);
  assert.equal(g(dir, 'show', '-s', '--format=%P', 'workgroup/T1').split(' ').length, 2, '工作台替它完成了那次合并（两个上级提交）');
  runs[2].end();
  await until(() => runs.length === 4);
  handleQun(disp, 'Claude', ['task', 'review', 'T1', '--pass', '--evidence', 'ok'], '', runIdOf(runs[3]));
  runs[3].end();
  tasks.approve('T1');
  assert.match(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), /a = 50/);
  disp.dispose();
});

test('工作区：项目文件夹里有没提交的改动、会被合并覆盖，就不合并；项目不在原来的分支上也不合并', async () => {
  const { disp, project, tasks, dir } = setup('wt-dirty');
  gitRepo(dir);
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 改 app.js', review: false });
  await until(() => runs.length === 1);
  const wtAbs = path.join(dir, '.workgroup', 'worktrees', 'T1');
  fs.writeFileSync(path.join(wtAbs, 'app.js'), 'changed by card\n');
  handleQun(disp, 'Codex', ['task', 'submit', 'T1', '--file', 'app.js', '--run', 'r', '--evidence', 'e'], '', runIdOf(runs[0]), wtAbs);
  runs[0].end();
  if (tasks.get('T1').state === 'in_review') {      // 没关审查的话先过审查
    await until(() => runs.length === 2);
    handleQun(disp, 'Claude', ['task', 'review', 'T1', '--pass', '--evidence', 'ok'], '', runIdOf(runs[1]));
    runs[1].end();
  }
  fs.writeFileSync(path.join(dir, 'app.js'), '群主手改、还没提交\n');
  assert.throws(() => tasks.approve('T1'), /没提交的内容[\s\S]*app\.js/);
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), '群主手改、还没提交\n', '群主没提交的改动原样留着');
  assert.equal(tasks.get('T1').state, 'awaiting_owner');
  g(dir, 'checkout', '-q', '--', 'app.js');
  g(dir, 'checkout', '-q', '-b', 'other');
  assert.throws(() => tasks.approve('T1'), /现在在「other」分支上[\s\S]*切回 main/);
  g(dir, 'checkout', '-q', 'main');
  tasks.approve('T1');
  assert.equal(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), 'changed by card\n');
  disp.dispose();
});

test('工作区：子任务从父任务的分支分出来，审查通过后合进父任务的工作区；有冲突就留在分支上，告诉父任务负责人', async () => {
  const { disp, project, tasks, dir } = setup('wt-kids');
  gitRepo(dir);
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '帮我把 app.js 拆一下' });       // 没点名 → Claude 接（协调员）
  await until(() => runs.length === 1);
  const p1 = path.join(dir, '.workgroup', 'worktrees', 'T1');
  assert.equal(runs[0].opts.cwd, p1);
  fs.writeFileSync(path.join(p1, 'plan.md'), '先拆再合\n');       // 协调员在自己工作区里先写了点东西（还没提交）
  const R = (i) => runIdOf(runs[i]);
  handleQun(disp, 'Claude', ['task', 'new', '--parent', 'T1', '--title', '加 lib', '--owner', 'Codex', '--reviewer', 'DeepSeek', '--deliver', 'lib.js', '--accept', '能 import'], '', R(0), p1);
  handleQun(disp, 'Claude', ['task', 'new', '--parent', 'T1', '--title', '改第一行', '--owner', 'DeepSeek', '--reviewer', 'Codex', '--deliver', 'app.js', '--accept', 'a=3'], '', R(0), p1);
  handleQun(disp, 'Claude', ['task', 'new', '--parent', 'T1', '--title', '也改第一行', '--owner', 'Codex', '--reviewer', 'DeepSeek', '--deliver', 'app.js', '--accept', 'a=4'], '', R(0), p1);
  runs[0].end();
  await until(() => runs.length >= 3);
  const runOf = (agent, lane) => runs.find((r) => r.agent === agent && r.opts.extraEnv && disp.runs().find((x) => x.id === runIdOf(r))?.lane === lane);
  await until(() => runOf('Codex', 'T2') && runOf('DeepSeek', 'T3'));
  const p2 = path.join(dir, '.workgroup', 'worktrees', 'T2'), p3 = path.join(dir, '.workgroup', 'worktrees', 'T3');
  assert.ok(fs.existsSync(path.join(p2, 'plan.md')), '子任务看得到父任务分支前存下的改动');
  assert.equal(tasks.get('T2').wt.baseBranch, 'workgroup/T1');
  fs.writeFileSync(path.join(p2, 'lib.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(p3, 'app.js'), 'const a = 3;\nconst b = 2;\nconsole.log(a + b);\n');
  handleQun(disp, 'Codex', ['task', 'submit', 'T2', '--file', 'lib.js', '--run', 'r', '--evidence', 'e'], '', runIdOf(runOf('Codex', 'T2')), p2);
  handleQun(disp, 'DeepSeek', ['task', 'submit', 'T3', '--file', 'app.js', '--run', 'r', '--evidence', 'e'], '', runIdOf(runOf('DeepSeek', 'T3')), p3);
  runOf('Codex', 'T2').end(); runOf('DeepSeek', 'T3').end();
  await until(() => runOf('DeepSeek', 'T2') && runOf('Codex', 'T3'));
  handleQun(disp, 'DeepSeek', ['task', 'review', 'T2', '--pass', '--evidence', 'ok'], '', runIdOf(runOf('DeepSeek', 'T2')));
  handleQun(disp, 'Codex', ['task', 'review', 'T3', '--pass', '--evidence', 'ok'], '', runIdOf(runOf('Codex', 'T3')));
  assert.ok(fs.existsSync(path.join(p1, 'lib.js')), 'T2 审查通过后合进了 T1 的工作区');
  assert.match(fs.readFileSync(path.join(p1, 'app.js'), 'utf8'), /a = 3/);
  assert.match(project.messages().filter((m) => m.taskId === 'T3').at(-1).text, /已合并进 T1 的工作区/);
  runOf('DeepSeek', 'T2').end(); runOf('Codex', 'T3').end();

  // T4 也改第一行（从 T1 早先的样子分出来）：和已经合进来的 T3 冲突，留在分支上
  await until(() => runOf('Codex', 'T4'));
  const p4 = path.join(dir, '.workgroup', 'worktrees', 'T4');
  fs.writeFileSync(path.join(p4, 'app.js'), 'const a = 4;\nconst b = 2;\nconsole.log(a + b);\n');
  handleQun(disp, 'Codex', ['task', 'submit', 'T4', '--file', 'app.js', '--run', 'r', '--evidence', 'e'], '', runIdOf(runOf('Codex', 'T4')), p4);
  runOf('Codex', 'T4').end();
  await until(() => runOf('DeepSeek', 'T4'));
  handleQun(disp, 'DeepSeek', ['task', 'review', 'T4', '--pass', '--evidence', 'ok'], '', runIdOf(runOf('DeepSeek', 'T4')));
  assert.match(project.messages().filter((m) => m.taskId === 'T4').at(-1).text, /没有自动合进 T1 的工作区（冲突在 app\.js）[\s\S]*留在分支 workgroup\/T4[\s\S]*@Claude/);
  assert.match(fs.readFileSync(path.join(p1, 'app.js'), 'utf8'), /a = 3/, 'T1 的工作区没被弄乱');
  runOf('DeepSeek', 'T4').end();
  // 清理：T2、T3 合并过的分支删掉；T4 没合并，分支留着
  await until(() => !fs.existsSync(p2) && !fs.existsSync(p3) && !fs.existsSync(p4));
  assert.deepEqual(g(dir, 'branch', '--list', 'workgroup/*', '--format=%(refname:short)').split('\n').sort(), ['workgroup/T1', 'workgroup/T4']);
  assert.match(project.messages().filter((m) => m.taskId === 'T4').at(-1).text, /分支 workgroup\/T4 上还有没合并进去的改动，留着没删/);
  disp.dispose();
});

test('工作区：不是 git 仓库、或者在别的仓库里面的项目照旧不建；取消的卡清理时把改动留在分支上', async () => {
  const { disp, project, tasks, dir } = setup('wt-none');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 做点事' });
  await until(() => runs.length === 1);
  assert.equal(runs[0].opts.cwd, dir, '不是 git 仓库：照旧从项目文件夹启动');
  assert.equal(tasks.get('T1').wt, null);
  assert.equal(disp.wt.status().reason, '项目文件夹不是 git 仓库');
  runs[0].end();
  disp.dispose();

  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-outer-'));
  gitRepo(outer);
  const inner = new Project({ id: 'inner', name: 'inner', dir: path.join(outer, 'sub') });
  const d2 = new Dispatcher(inner, { adapters: {}, status: () => ({ Claude: { connected: true }, Codex: { connected: true }, DeepSeek: { connected: true } }), appDir: APP_DIR, snapshots: false });
  assert.match(d2.wt.status().reason, /在另一个 git 仓库.*里面/);
  d2.dispose();

  const { disp: d3, project: p3, tasks: t3, dir: dir3 } = setup('wt-cancel');
  gitRepo(dir3);
  const runs3 = fakeAgents(d3);
  p3.patchSettings({ paused: false });
  d3.ownerSay({ text: '@Codex 试着改改' });
  await until(() => runs3.length === 1);
  const w = path.join(dir3, '.workgroup', 'worktrees', 'T1');
  fs.writeFileSync(path.join(w, 'draft.js'), '半成品\n');
  t3.cancel('T1', '群主', '不做了');
  await tick(400);
  assert.ok(fs.existsSync(w), '还有会话在用，先不清');
  runs3[0].end();
  await until(() => !fs.existsSync(w));
  assert.equal(g(dir3, 'show', 'workgroup/T1:draft.js'), '半成品', '取消时没提交的改动存到了分支上');
  d3.dispose();
});

test('工作区：改动快照也拍工作区里的改动，能看逐行对比，能撤回；合并清理之后撤不了', async () => {
  const { disp, project, tasks, dir } = setup('wt-snap', undefined, { snapshots: true });
  gitRepo(dir);
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Codex 改 app.js', review: false });
  await until(() => runs.length === 1);
  const wtAbs = path.join(dir, '.workgroup', 'worktrees', 'T1');
  fs.writeFileSync(path.join(wtAbs, 'app.js'), 'const a = 1;\nconst b = 3;\nconsole.log(a + b);\n');
  fs.writeFileSync(path.join(wtAbs, 'new.js'), 'x\n');
  const id1 = runIdOf(runs[0]);
  runs[0].end({ finalText: '改了' });
  await until(() => disp.runs().find((r) => r.id === id1)?.changes);
  const d = await disp.snap.diff(id1);
  assert.deepEqual(d.files.map((f) => [f.p, f.s]).sort(), [['.workgroup/worktrees/T1/app.js', 'M'], ['.workgroup/worktrees/T1/new.js', 'A']]);
  assert.match(d.text, /-const b = 2;\n\+const b = 3;/);
  assert.ok(!d.text.includes('node_modules') && !d.files.some((f) => f.p.endsWith('.git')));
  await disp.rollbackRun(id1);
  assert.match(fs.readFileSync(path.join(wtAbs, 'app.js'), 'utf8'), /b = 2/);
  assert.ok(!fs.existsSync(path.join(wtAbs, 'new.js')));

  // 再改一次、提交、验收合并：清理之后这次运行撤不了，说清楚为什么
  disp.ownerSay({ text: '@Codex 再改', taskId: 'T1' });
  await until(() => runs.length === 2);
  fs.writeFileSync(path.join(wtAbs, 'app.js'), 'const a = 1;\nconst b = 4;\nconsole.log(a + b);\n');
  handleQun(disp, 'Codex', ['task', 'submit', 'T1', '--file', 'app.js', '--run', 'r', '--evidence', 'e'], '', runIdOf(runs[1]), wtAbs);
  const id2 = runIdOf(runs[1]);
  runs[1].end();
  await until(() => disp.runs().find((r) => r.id === id2)?.changes);
  if (tasks.get('T1').state === 'awaiting_owner') tasks.approve('T1');
  await until(() => !fs.existsSync(wtAbs));
  await assert.rejects(disp.rollbackRun(id2), /工作区，这个工作区已经合并进项目、清理掉了/);
  disp.dispose();
});

test('工作区（系统级实测）：负责人能写自己卡的工作区，改不了项目里的原件；别的卡、审查人写不进这个工作区', { skip: sandboxStatus().ok ? false : '这台机器上系统沙箱不可用' }, () => {
  const { disp, tasks, dir } = setup('wt-os');
  gitRepo(dir);
  disp.ownerSay({ text: '@Codex 改代码 A' });                                // T1
  disp.ownerSay({ text: '@Codex 改代码 B' });                                // T2
  disp.prepareWorktree('Codex', tasks.get('T1'));
  disp.prepareWorktree('Codex', tasks.get('T2'));
  const real = fs.realpathSync(dir);
  const a = disp.prepareBoundary('Codex', 'T1', 'RwtA');
  const b = disp.prepareBoundary('Codex', 'T2', 'RwtB');
  const rv = disp.prepareBoundary('Claude', 'T1', 'RwtC');
  const tryWrite = (session, rel) => spawnSync(SANDBOX_EXEC, ['-f', session.profile, process.execPath, '-e',
    `require('fs').appendFileSync(${JSON.stringify(path.join(real, rel))}, 'x')`], { encoding: 'utf8' }).status === 0;
  assert.equal(tryWrite(a, '.workgroup/worktrees/T1/app.js'), true, '负责人能改自己工作区里的代码');
  assert.equal(tryWrite(a, 'app.js'), false, '项目里的原件改不了');
  assert.equal(tryWrite(a, '.git/config'), false, '项目的 git 仓库碰不了');
  assert.equal(tryWrite(b, '.workgroup/worktrees/T1/app.js'), false, '另一张卡的会话写不进 T1 的工作区');
  assert.equal(tryWrite(rv, '.workgroup/worktrees/T1/app.js'), false, '审查人写不进');
  assert.equal(tryWrite(b, '.workgroup/worktrees/T2/app.js'), true);
});


// ---- 逐字显示、工具没放开、上网查资料 ----
// 一个假的 claude 命令：把收到的参数记下来，按顺序吐出准备好的事件，等输入关掉再退出
function fakeClaudeBin(dir, events) {
  const bin = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.txt"\ncat "${dir}/events.jsonl"\ncat > /dev/null\n`, { mode: 0o755 });
  return bin;
}
function runFakeClaude(dir, events, extra = {}) {
  const bin = fakeClaudeBin(dir, events);
  const got = { stream: [], activity: [], denied: [], done: null };
  const logPath = path.join(dir, 'run.jsonl');
  return new Promise((resolve) => {
    claude.start.call({ ...claude, bin }, {
      cwd: dir, prompt: '干活', pathPrefix: path.dirname(process.execPath), logPath, timeoutMs: 20000, ...extra,
      on: {
        stream: (d, k) => got.stream.push([d, k]), activity: (a) => got.activity.push(a), denied: (l, w) => got.denied.push([l, w]),
        session() {}, done: (res) => { got.done = res; got.args = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').split('\n'); got.log = fs.readFileSync(logPath, 'utf8'); resolve(got); },
      },
    });
  });
}

test('逐字显示：Claude 边写边把字吐出来（只吐说的话，思考只显示“正在想”和想了多少）；逐字的碎片不进运行记录；一次性的小活不逐字', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-claude-'));
  const se = (uuid, event) => ({ type: 'stream_event', uuid, event });
  const got = await runFakeClaude(dir, [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5' },
    se('u1', { type: 'message_start' }),
    se('u2', { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    se('u3', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想一想' } }),
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 150, estimated_tokens_delta: 100 },
    se('u4', { type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
    se('u5', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '我先' } }),
    se('u6', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '查一下文档' } }),
    { type: 'assistant', message: { content: [{ type: 'text', text: '我先查一下文档' }] } },
    se('u7', { type: 'message_start' }),
    se('u8', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    se('u9', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好了' } }),
    { type: 'result', subtype: 'success', result: '好了', session_id: 's1', usage: { input_tokens: 1, output_tokens: 2 } },
  ]);
  assert.equal(got.done.status, 'ok');
  assert.equal(got.done.finalText, '好了');
  assert.deepEqual(got.stream.map((x) => x[0]), ['我先', '查一下文档', '好了'], '思考过程不吐');
  assert.equal(got.stream[0][1], got.stream[1][1], '同一段话的字是一个标识');
  assert.notEqual(got.stream[1][1], got.stream[2][1], '下一条消息的段落是新标识');
  assert.deepEqual(got.activity.find((a) => a.kind === 'say'), { kind: 'say', text: '我先查一下文档' }, '整段写完后给完整的一段，不截断');
  assert.deepEqual(got.activity.filter((a) => a.kind === 'think').map((a) => a.text), ['', '已经想了约 150 token'], '在想的时候显示“正在想”，想了多少');
  assert.ok(got.args.includes('--include-partial-messages'));
  assert.ok(!got.log.includes('stream_event'), '逐字的碎片不进运行记录');
  assert.ok(got.log.includes('我先查一下文档'), '整段写完的那条进运行记录');
  const eph = await runFakeClaude(fs.mkdtempSync(path.join(os.tmpdir(), 'wg-claude-')), [{ type: 'result', subtype: 'success', result: '摘要', usage: {} }], { ephemeral: true });
  assert.ok(!eph.args.includes('--include-partial-messages'), '整理群摘要这种一次性的小活不逐字');
});

test('逐字显示：工作台把同一段话的字拼起来，“正在做”那一行只放最新的字；推给界面最多每 150 毫秒一次；写完一段、跑完都会清掉', async () => {
  const { disp, project } = setup('stream');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  let emits = 0;
  project.on('activity', () => emits++);
  disp.ownerSay({ text: '@Claude 看看这个项目' });
  await until(() => runs.length === 1); await tick(10);
  const r = runs[0], rid = r.opts.extraEnv.QUN_RUN;
  emits = 0;
  for (const piece of ['我先', '看看', '\n\nprice.js']) r.opts.on.stream(piece, 'b1');
  assert.deepEqual([disp.activity[rid].kind, disp.activity[rid].streaming, disp.activity[rid].text], ['say', true, '我先看看 price.js'], '换行压成空格');
  assert.equal(disp.liveText(rid), '我先看看\n\nprice.js', '点开看的是原样');
  for (let i = 0; i < 60; i++) r.opts.on.stream('字', 'b1');
  await tick(250);
  assert.ok(emits >= 1 && emits <= 2, `攒着推：${emits} 次`);
  r.opts.on.stream('x'.repeat(500), 'b1');
  assert.equal(disp.activity[rid].text.length, 240, '那一行只放最后 240 个字');
  assert.ok(disp.activity[rid].text.endsWith('xxx'));
  r.opts.on.stream('新的一段', 'b2');
  assert.equal(disp.liveText(rid), '新的一段', '换了一段就重新拼');
  r.opts.on.activity({ kind: 'say', text: '新的一段话写完了，' + '很长'.repeat(200) });
  assert.equal(disp.liveText(rid), '', '写完的段落交给运行记录');
  assert.equal(disp.activity[rid].streaming, false);
  assert.equal(disp.activity[rid].text.length, 240);
  r.opts.on.activity({ kind: 'cmd', text: 'node test.js' });
  assert.equal(disp.activity[rid].text, 'node test.js');
  assert.ok(one(project.db, 'SELECT first_out_ts FROM runs WHERE id=?', rid).first_out_ts, '第一个字也算首次响应');
  r.end({ finalText: '看完了' }); await tick(30);
  assert.equal(disp.liveText(rid), null, '跑完就没有“正在写”了');
  assert.equal(disp.activity[rid], undefined);
  disp.dispose();
});

test('工具没放开：认得出 Claude 用了没放开的工具（只认报错的工具结果）；群里说明；成员能上网查资料，能写哪里不变', async () => {
  assert.equal(toolDenied("Claude requested permissions to use WebFetch, but you haven't granted it yet."), '工具没放开：WebFetch');
  assert.equal(toolDenied('Permission to use NotebookEdit has been denied.'), '工具没放开：NotebookEdit');
  assert.equal(toolDenied('文档里写着：申请权限要 requested permissions'), null);
  assert.equal(deniedLine("Claude requested permissions to use WebFetch, but you haven't granted it yet."), null, '不是写入被拦');
  // 真实 CLI 的事件顺序：调工具 → 工具结果（报错）；读到的文件里碰巧有这句话不算
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-claude-'));
  const got = await runFakeClaude(dir, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'NotebookEdit', input: { notebook_path: 'a.ipynb' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Permission to use NotebookEdit has been denied.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'WebFetch', input: { url: 'https://example.com' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: "页面原文：Claude requested permissions to use WebFetch, but you haven't granted it yet." }] } },
    { type: 'result', subtype: 'success', result: '好', usage: {} },
  ]);
  assert.deepEqual(got.denied, [['工具没放开：NotebookEdit', 'NotebookEdit ']]);
  assert.ok(got.activity.some((a) => a.text === 'WebFetch https://example.com'), '打开网页时显示网址');
  const allowed = got.args[got.args.indexOf('--allowedTools') + 1].split(',');
  for (const t of ['WebSearch', 'WebFetch', 'Bash', 'Write']) assert.ok(allowed.includes(t), t);
  assert.equal(allowed.join(','), CLAUDE_TOOLS);
  // Codex：干活的会话打开联网，可写目录照旧；整理摘要的一次性小活不联网
  const sb = { writableAbs: ['/p/.workgroup/drafts/Codex', '/p/共享区/T1'], draftAbs: '/p/.workgroup/drafts/Codex' };
  assert.deepEqual(codexSandboxArgs(sb), ['-c', 'sandbox_workspace_write.writable_roots=["/p/共享区/T1"]', '-c', 'sandbox_workspace_write.network_access=true']);
  assert.deepEqual(codexSandboxArgs(null, true), []);
  // 群里怎么说：和沙箱拦下一样记“被拦下”，原因写清是工具没放开
  const { disp, project } = setup('tooldeny');
  const runs = fakeAgents(disp);
  project.patchSettings({ paused: false });
  disp.ownerSay({ text: '@Claude 查一下文档' });
  await until(() => runs.length === 1); await tick(10);
  runs[0].opts.on.denied('工具没放开：NotebookEdit', 'NotebookEdit a.ipynb');
  runs[0].end({ finalText: '那个工具用不了，换了个办法' }); await tick(30);
  const n = project.messages().filter((m) => m.kind === 'system').at(-1);
  assert.match(n.text, /有 1 处操作被系统拦下，用了工作台没有放开的工具：「NotebookEdit a\.ipynb」（工具没放开）。/);
  // 推送被拦：原因写清是想推送
  disp.ownerSay({ text: '@Claude 推一下' });
  await until(() => runs.length === 2); await tick(10);
  runs[1].opts.on.denied(NO_PUSH_MSG, 'git push origin main');
  runs[1].opts.on.denied('touch: 共享区/T9/x.md: Operation not permitted');
  runs[1].end({ finalText: '推不上去' }); await tick(30);
  const n2 = project.messages().filter((m) => m.kind === 'system').at(-1);
  assert.match(n2.text, /有 2 处操作被系统拦下，写到了不归它的位置，或者做了沙箱不允许的事；想推送到远端（推送由群主自己来）：「git push origin main」（不能推送）/);
  assert.equal(one(project.db, 'SELECT denied FROM runs WHERE id=?', runs[0].opts.extraEnv.QUN_RUN).denied, 1);
  disp.dispose();
});

test('不能推送：成员的 git 推送一律被拒（工作台认得出是被拦下）；拉取、看历史照常，群主自己的 git 配置照样生效', () => {
  const { disp, dir } = setup('nopush');
  const remote = path.join(dir, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', remote]);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const g0 = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g0('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
  g0('add', '-A'); g0('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
  g0('remote', 'add', 'origin', remote); g0('remote', 'add', 'gh', 'https://github.com/example/never.git');
  // 成员的命令：带上工作台给的环境变量，PATH 里有它自己的命令目录
  const env = { ...process.env, ...disp.memberEnv('R1'), PATH: `${disp.qunDir('Codex')}:${process.env.PATH}` };
  const sh = (cmd) => spawnSync('/bin/sh', ['-c', cmd], { cwd: repo, env, encoding: 'utf8' });
  for (const target of ['origin main', 'gh main', `${remote} main`]) {
    const r = sh(`git push ${target}`);
    assert.notEqual(r.status, 0, target);
    assert.ok(r.stderr.includes(NO_PUSH_MSG), `${target}：${r.stderr}`);
  }
  assert.equal(spawnSync('git', ['-C', remote, 'rev-parse', '--verify', '-q', 'refs/heads/main']).status, 1, '远端什么也没收到');
  assert.equal(deniedLine(`fatal: 推不上去\n${NO_PUSH_MSG}`), NO_PUSH_MSG, '工作台把它当成被拦下');
  // 群主自己推送（不带这些环境变量）照常
  assert.equal(g0('push', '-q', 'origin', 'main').status, 0);
  // 成员拉取、看历史照常
  assert.equal(sh('git fetch -q origin && git log --oneline -1').status, 0);
  // 群主的全局配置被引用进来了
  const cfg = fs.readFileSync(disp.gitConfigPath(), 'utf8');
  assert.ok(cfg.includes(`path = ${path.join(os.homedir(), '.gitconfig')}`));
  disp.dispose();
});


// ---- 成员表：启用 / 停用、分工、新成员默认“通用干活” ----------------------------------
test('成员表：新成员没写分工就是“通用干活”；表本身写错了启动时就报出来', () => {
  const [kimi] = buildRoster([{ name: 'Kimi', adapter: 'kimi', aliases: ['月之暗面'] }]);
  assert.equal(kimi.title, GENERIC_TITLE);
  assert.equal(kimi.role, GENERIC_ROLE);
  assert.equal(kimi.enabled, true);
  assert.equal(kimi.payPerUse, false);
  assert.deepEqual(kimi.aliases, ['kimi', '月之暗面']);
  assert.equal(kimi.id, 'kimi');
  assert.ok(Object.isFrozen(kimi), '出厂资料只读，群主改的另存');
  assert.throws(() => buildRoster([{ name: 'K-1', adapter: 'x' }]), /字母开头/);
  assert.throws(() => buildRoster([{ name: 'Kimi', adapter: 'x' }, { name: 'kimi', adapter: 'y' }]), /重复/);
  assert.throws(() => buildRoster([{ name: 'Kimi' }]), /adapter/);
  assert.throws(() => buildRoster([{ name: 'A1', adapter: 'x', coordinator: true }, { name: 'B1', adapter: 'y', coordinator: true }]), /一位默认协调员/);
  assert.throws(() => buildRoster([{ name: 'Kimi', adapter: 'x', color: { light: 'red' } }]), /#rrggbb/);
  // 出厂的三位：别处不再写死名字，全从这张表来
  assert.deepEqual(ROSTER.map((r) => r.name), ['Claude', 'Codex', 'DeepSeek', 'Kimi']);
  const k = ROSTER.find((r) => r.name === 'Kimi');
  assert.equal(k.adapter, 'acp');
  assert.equal(k.enabled, false, 'Kimi 出厂停用：装好、登录后到设置里打开');
  assert.equal(k.title, GENERIC_TITLE, '新成员默认通用干活');
  assert.deepEqual(enabledAgents(), ['Claude', 'Codex', 'DeepSeek']);
  assert.throws(() => buildRoster([{ name: 'Qwen', adapter: 'acp' }]), /acp\.command/);
  assert.equal(ROSTER.filter((r) => r.coordinator).map((r) => r.name).join(), 'Claude');
  assert.deepEqual(parseMentions('@ds 看一下，@克劳德 汇总'), ['DeepSeek', 'Claude'], '别名也从成员表读');
});

test('成员设置：只存和出厂不同的；分工留空就恢复出厂；至少留一位启用', () => {
  try {
    const c = cleanMemberSettings({
      Claude: { enabled: true, title: ROSTER[0].title, role: '  ' },           // 和出厂一样 / 留空：都不存
      Codex: { title: '  只做 测试\n和接入 ', role: '你只写测试。\r\n别的不碰。' },
      DeepSeek: { enabled: false },
      Nobody: { enabled: false },                                              // 表里没有的成员：不理
    });
    assert.deepEqual(c, { Codex: { title: '只做 测试 和接入', role: '你只写测试。\n别的不碰。' }, DeepSeek: { enabled: false } });
    assert.throws(() => cleanMemberSettings({ Claude: { enabled: false }, Codex: { enabled: false }, DeepSeek: { enabled: false } }), /至少要留一位/);
    assert.throws(() => cleanMemberSettings({ Codex: { title: '长'.repeat(41) } }), /最多 40/);
    assert.throws(() => cleanMemberSettings({ Codex: { role: '长'.repeat(801) } }), /最多 800/);

    configureMembers(c);
    assert.equal(member('Codex').title, '只做 测试 和接入');
    assert.equal(member('Codex').defaultTitle, ROSTER[1].title, '出厂分工还在，界面上能“恢复出厂分工”');
    assert.deepEqual(enabledAgents(), ['Claude', 'Codex']);
    // 旧版设置：关掉了“允许 DeepSeek 使用 API key”的，升级后就是 DeepSeek 停用
    assert.deepEqual(upgradeSettings({ deepseekApiAllowed: false, tiers: {} }), { tiers: {}, members: { DeepSeek: { enabled: false } } });
    assert.deepEqual(upgradeSettings({ deepseekApiAllowed: true }), {});
  } finally { configureMembers({}); }
});

test('停用成员：不算已连接，不能派活、不能当审查人，群主 @ 它会被告知“已停用”，提示词里不出现', () => {
  const { project, disp, tasks } = setup('member-off');
  try {
    const t1 = tasks.create({ title: '格式分析', owner: 'DeepSeek', creator: '群主', kind: '分析' });   // 停用前派出去的卡
    configureMembers({ DeepSeek: { enabled: false } });
    assert.deepEqual(disp.connected(), ['Claude', 'Codex'], '命令行接着也不算');
    assert.throws(() => tasks.create({ title: 'x', owner: 'DeepSeek', creator: '群主' }), /@DeepSeek 已停用，不能派给它/);
    assert.throws(() => tasks.create({ title: 'x', owner: 'Codex', reviewer: 'DeepSeek', creator: '群主' }), /@DeepSeek 已停用，不能当审查人/);
    assert.equal(defaultReviewer('Codex', disp.connected()), 'Claude');
    assert.equal(defaultReviewer('Claude', disp.connected()), 'Codex');

    const before = tasks.list().length;
    disp.ownerSay({ text: '@DeepSeek 再看一个样例' });
    assert.equal(tasks.list().length, before, '没有建卡');
    assert.match(project.messages().at(-1).text, /@DeepSeek 已停用，没法接这个任务。要用它，到设置 →「成员」里打开/);
    disp.routeMentions({ id: 99, sender: 'Claude', mentions: ['DeepSeek'], text: '@DeepSeek 看下', chainId: null }, { byAgent: true });
    assert.match(project.messages().at(-1).text, /@DeepSeek 已停用，#99 这条消息没有送达/);

    const pr = buildPrompt({ agent: 'Claude', project, tasks, wakes: [{ reason: 'mention' }], connected: disp.connected(), resumed: false, qunPath: 'qun', writable: [], enforced: true });
    const rules = pr.slice(0, pr.indexOf('【最近群聊】'));      // 群聊记录是背景资料，里面可以有它的名字
    assert.doesNotMatch(rules, /@DeepSeek/, '成员名单和派活规则里都没有它');
    assert.match(pr, /@Codex：工程负责人/);
    assert.match(pr, /【你是协调员】/);

    // 它手上的卡：马上提醒群主一次，不等 20 分钟
    project.patchSettings({ paused: false });        // 项目暂停时不查（测试项目默认是暂停的，免得成员真的开跑）
    disp.checkStale(); disp.checkStale();
    project.patchSettings({ paused: true });
    const off = project.messages().filter((m) => /已在设置里停用/.test(m.text));
    assert.equal(off.length, 1);
    assert.match(off[0].text, new RegExp(`任务 ${t1.id}「格式分析」该 @DeepSeek 做`));
  } finally { configureMembers({}); disp.dispose(); }
});

test('协调员停用了：没点名的需求交给表里第一位启用的成员，它拿到协调员的说明', () => {
  const { project, disp, tasks } = setup('coord-off');
  try {
    configureMembers({ Claude: { enabled: false } });
    assert.equal(coordinator(), 'Codex');
    disp.ownerSay({ text: '帮我把收件箱整理一下' });
    const t = tasks.list().at(-1);
    assert.equal(t.owner, 'Codex');
    assert.equal(t.kind, '协调');
    assert.equal(t.reviewer, 'DeepSeek', '能审的只剩 DeepSeek');
    const pr = buildPrompt({ agent: 'Codex', project, tasks, wakes: [{ reason: 'task_assigned', task_id: t.id }], connected: disp.connected(), resumed: false, qunPath: 'qun', lane: t.id, writable: [], enforced: true });
    assert.match(pr, /【你是协调员】/);
    assert.doesNotMatch(pr.slice(0, pr.indexOf('【最近群聊】')), /@Claude/);
    // 群摘要原来选的是 Claude：它停用了就由协调员写
    project.patchSettings({ summaryAgent: 'Claude' });
    assert.equal(disp.summaryWriter(), 'Codex');
  } finally { configureMembers({}); disp.dispose(); }
  assert.equal(coordinator(), 'Claude', '恢复出厂后还是 Claude');
});

test('改过的分工：成员自己的身份和协调员看到的名单都跟着变', () => {
  const { project, disp, tasks } = setup('member-role');
  try {
    configureMembers({ Codex: { title: '只写测试', role: '你只负责写测试，不写业务代码。' } });
    const mine = buildPrompt({ agent: 'Codex', project, tasks, wakes: [{ reason: 'mention' }], connected: disp.connected(), resumed: false, qunPath: 'qun', writable: [], enforced: true });
    assert.match(mine, /成员 @Codex（只写测试）。.*你只负责写测试，不写业务代码。/s);
    const coord = buildPrompt({ agent: 'Claude', project, tasks, wakes: [{ reason: 'mention' }], connected: disp.connected(), resumed: false, qunPath: 'qun', writable: [], enforced: true });
    assert.match(coord, /@Codex：只写测试，已连接/);
  } finally { configureMembers({}); disp.dispose(); }
});


// ---- 通用 ACP 接入：用一个假的 ACP 成员测（不花钱、不联网） ---------------------------------
// 它按 FAKE_ACP 的值演不同情况，把收到的每个请求记到 FAKE_ACP_LOG 里，测试再对照
const FAKE_ACP = `
import fs from 'node:fs';
const mode = process.env.FAKE_ACP ?? 'ok';
const log = (o) => fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(o) + '\\n');
let buf = '', pend = new Map(), nid = 1000;
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
const upd = (sessionId, update) => out({ method: 'session/update', params: { sessionId, update } });
const ask = (method, params) => new Promise((r) => { const id = ++nid; pend.set(id, r); out({ id, method, params }); });
const models = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'k-1', options: [{ value: 'k-1', name: 'K 一号' }, { value: 'k-2', name: 'K 二号' }] }];
async function handle(m) {
  if (m.id != null && !m.method) { pend.get(m.id)?.(m); return; }
  log({ method: m.method, params: m.params });
  const p = m.params ?? {};
  if (m.method === 'initialize') return out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } } });
  if (m.method === 'session/new') {
    if (mode === 'auth') return out({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    return out({ id: m.id, result: { sessionId: 'sess-new', configOptions: models } });
  }
  if (m.method === 'session/resume') {
    if (p.sessionId === 'gone') return out({ id: m.id, error: { code: -32002, message: 'Session not found' } });
    return out({ id: m.id, result: { configOptions: models } });
  }
  if (m.method === 'session/set_config_option') return out({ id: m.id, result: { configOptions: [{ ...models[0], currentValue: p.value }] } });
  if (m.method === 'session/prompt') {
    const s = p.sessionId;
    upd(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一想' } });
    upd(s, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '先看一下' } });
    upd(s, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls 共享区' } });
    const perm = await ask('session/request_permission', { sessionId: s, toolCall: { toolCallId: 't1' }, options: [
      { optionId: 'no', name: '拒绝', kind: 'reject_once' }, { optionId: 'once', name: '允许一次', kind: 'allow_once' }, { optionId: 'always', name: '总是允许', kind: 'allow_always' }] });
    log({ permission: perm.result ?? perm.error });
    upd(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'touch: 共享区/T9/a.md: Operation not permitted' } }] });
    if (mode === 'fs') { const r = await ask('fs/write_text_file', { sessionId: s, path: '/tmp/x', content: 'x' }); log({ fsAnswer: r.error ? 'error' : 'ok' }); }
    upd(s, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: '做完了，' } });
    upd(s, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: '结果在共享区。' } });
    upd(s, { sessionUpdate: 'usage_update', used: 5000, size: 200000, cost: { amount: 0.12, currency: 'CNY' } });
    if (mode === 'hang') return;          // 不回 prompt：等着被停止
    return out({ id: m.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1200, cachedReadTokens: 800, outputTokens: 90, thoughtTokens: 30, totalTokens: 1320 } } });
  }
  if (m.method === 'session/cancel') { log({ cancelled: true }); process.exit(0); }
  if (m.id != null) out({ id: m.id, error: { code: -32601, message: 'no' } });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(JSON.parse(l)); } });
`;
function fakeAcp(mode = 'ok', { auth } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-acp-'));
  const script = path.join(dir, 'fake-acp.mjs');
  fs.writeFileSync(script, FAKE_ACP);
  const logFile = path.join(dir, 'calls.jsonl');
  const ad = acpAdapter({ name: 'Kimi', acp: { command: process.execPath, args: [script], env: { FAKE_ACP: mode, FAKE_ACP_LOG: logFile }, auth, loginFix: '在终端运行 kimi login' } });
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { ad, dir, calls };
}
function runAcp(ad, dir, opts = {}) {
  return new Promise((resolve) => {
    const seen = { activity: [], stream: [], denied: [], session: [] };
    const h = ad.start({
      cwd: dir, prompt: '把共享区整理一下', sessionId: null, pathPrefix: dir, logPath: path.join(dir, 'run.log'), timeoutMs: 20000, ...opts,
      on: {
        activity: (a) => seen.activity.push(a), stream: (t, id) => seen.stream.push([t, id]), denied: (line, what) => seen.denied.push([line, what]),
        session: (sid, i) => seen.session.push([sid, i?.model]), done: (res) => resolve({ ...res, seen }),
      },
    });
    opts.onStart?.(h);
  });
}

test('ACP 接入：一轮完整对话——说话、调工具自动允许、被沙箱拦下、最终回复、用量和花费、会话号', async () => {
  const { ad, dir, calls } = fakeAcp('ok');
  const r = await runAcp(ad, dir);
  assert.equal(r.status, 'ok', r.error);
  assert.equal(r.finalText, '做完了，结果在共享区。', '最后一段话是回复，前面那段是过程');
  assert.equal(r.sessionId, 'sess-new');
  assert.deepEqual(r.seen.session, [['sess-new', 'K 一号']], '报出它实际用的模型');
  assert.deepEqual(r.usage, { input: 1200, cached: 800, output: 90, reasoning: 30, cost: 0.12, currency: 'CNY' });
  assert.ok(r.seen.activity.some((a) => a.kind === 'say' && a.text === '先看一下'));
  assert.ok(r.seen.activity.some((a) => a.kind === 'cmd' && a.text === 'ls 共享区'));
  assert.ok(r.seen.activity.some((a) => a.kind === 'think'));
  assert.deepEqual(r.seen.stream.map(([t]) => t).join(''), '先看一下做完了，结果在共享区。', '逐字显示');
  assert.equal(r.seen.denied.length, 1, '工具报 Operation not permitted：算被沙箱拦下');
  assert.equal(r.seen.denied[0][1], 'ls 共享区');
  const c = calls();
  const init = c.find((x) => x.method === 'initialize').params;
  assert.equal(init.protocolVersion, 1);
  assert.deepEqual(init.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, '不声明读写文件、终端：那些会绕过沙箱');
  assert.equal(c.find((x) => x.method === 'session/new').params.cwd, path.resolve(dir));
  assert.deepEqual(c.find((x) => x.permission).permission, { outcome: { outcome: 'selected', optionId: 'always' } }, '不弹窗，自动选“总是允许”');
  assert.deepEqual(c.find((x) => x.method === 'session/prompt').params.prompt, [{ type: 'text', text: '把共享区整理一下' }]);
});

test('ACP 接入：接着上次的会话；接不上就开新的；选了模型就设上，没有这个模型用它的默认', async () => {
  let { ad, dir, calls } = fakeAcp('ok');
  let r = await runAcp(ad, dir, { sessionId: 'sess-old', model: 'k-2' });
  assert.equal(r.status, 'ok');
  assert.equal(r.sessionId, 'sess-old');
  assert.ok(calls().some((x) => x.method === 'session/resume' && x.params.sessionId === 'sess-old'));
  assert.ok(!calls().some((x) => x.method === 'session/new'));
  assert.deepEqual(calls().find((x) => x.method === 'session/set_config_option').params, { sessionId: 'sess-old', configId: 'model', value: 'k-2' });
  assert.deepEqual(r.seen.session, [['sess-old', 'K 二号']]);

  ({ ad, dir, calls } = fakeAcp('ok'));
  r = await runAcp(ad, dir, { sessionId: 'gone', model: 'k-9' });
  assert.equal(r.status, 'ok');
  assert.equal(r.sessionId, 'sess-new', '旧会话找不到：开新的，工作台记住新的会话号');
  assert.ok(r.seen.activity.some((a) => a.kind === 'boot' && /接不上/.test(a.text)));
  assert.ok(r.seen.activity.some((a) => a.kind === 'boot' && /没有「k-9」/.test(a.text)));
  assert.ok(!calls().some((x) => x.method === 'session/set_config_option'));

  ({ ad, dir, calls } = fakeAcp('ok'));
  r = await runAcp(ad, dir, { sessionId: 'sess-old', ephemeral: true });
  assert.equal(r.sessionId, null, '写群摘要这类一次性运行：不留会话');
  assert.ok(calls().some((x) => x.method === 'session/new'));
});

test('ACP 接入：没登录时说清怎么登录；问工作台要读写文件就拒绝；停止时先按协议取消', async () => {
  let { ad, dir } = fakeAcp('auth');
  let r = await runAcp(ad, dir);
  assert.equal(r.status, 'error');
  assert.match(r.error, /Kimi 还没登录：在终端运行 kimi login/);

  let calls;
  ({ ad, dir, calls } = fakeAcp('fs'));
  r = await runAcp(ad, dir);
  assert.equal(r.status, 'ok');
  assert.equal(calls().find((x) => x.fsAnswer).fsAnswer, 'error', '工作台不替成员写文件（那会绕过沙箱）');

  ({ ad, dir, calls } = fakeAcp('hang'));
  r = await runAcp(ad, dir, { onStart: (h) => setTimeout(() => h.stop('stopped'), 800) });
  assert.equal(r.status, 'stopped');
  assert.ok(calls().some((x) => x.method === 'session/cancel'), '先发 session/cancel');
});

test('ACP 接入：权限选项、模型配置项、登录检查这几个小判断', () => {
  assert.deepEqual(pickPermission([{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }]), { outcome: { outcome: 'selected', optionId: 'a' } });
  assert.deepEqual(pickPermission([{ optionId: 'r', kind: 'reject_once' }]), { outcome: { outcome: 'cancelled' } }, '只有拒绝的选项：取消，不替它选');
  const opts = [{ id: 'mdl', category: 'model', options: [{ group: 'g', name: '组', options: [{ value: 'x/k3', name: 'K3' }] }] }, { id: 'think', category: 'thought_level', options: [{ value: 'high', name: '高' }] }];
  assert.deepEqual(findConfigValue(opts, 'model', 'x/k3'), { configId: 'mdl', value: 'x/k3', label: 'K3' }, '分组的选项也找得到');
  assert.deepEqual(findConfigValue(opts, 'thought_level', 'high'), { configId: 'think', value: 'high', label: '高' });
  assert.equal(findConfigValue(opts, 'model', 'nope'), null);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-login-'));
  const cred = path.join(home, 'credentials'), conf = path.join(home, 'config.toml');
  const auth = { files: [cred], configHas: [[conf, 'api_key']] };
  assert.equal(loggedIn(auth), false);
  fs.mkdirSync(cred);
  assert.equal(loggedIn(auth), false, '空目录不算');
  fs.writeFileSync(conf, '[providers.kimi]\napi_key_env = "X"\n');
  assert.equal(loggedIn(auth), true, '配置里填了 key 也算');
  fs.rmSync(conf); fs.writeFileSync(path.join(cred, 'kimi-code.json'), '{}');
  assert.equal(loggedIn(auth), true);
  assert.equal(loggedIn(null), true, '没写怎么查就不查，交给运行时报错');
});
