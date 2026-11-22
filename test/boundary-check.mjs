// 写入边界自测：不启动任何成员、不花任何额度。
// 它用工作台真正使用的那套规则，为几个“会话”生成系统级的写入限制，然后在这些限制下实际去写文件，
// 看哪些写得进、哪些被系统拒绝。运行：npm run check:boundary
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from '../server/project.mjs';
import { Dispatcher } from '../server/dispatcher.mjs';
import { handleQun } from '../server/rpc.mjs';
import { sandboxStatus, SANDBOX_EXEC } from '../server/boundary.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(APP, 'data', '_selftest');
fs.mkdirSync(base, { recursive: true });
const dir = fs.mkdtempSync(path.join(base, '边界自测-'));     // 不放在系统临时目录：Codex 的沙箱总是允许写临时目录
const project = new Project({ id: 'selftest', name: '边界自测', dir });
project.patchSettings({ paused: true });                      // 只建任务卡，不唤醒任何成员
const disp = new Dispatcher(project, {
  adapters: {}, appDir: APP,
  status: () => ({ Claude: { connected: true }, Codex: { connected: true }, DeepSeek: { connected: true } }),
});
disp.ownerSay({ text: '@Claude 写文档 A' });                  // T1：Claude 负责，Codex 审查
disp.ownerSay({ text: '@Claude 写文档 B' });                  // T2：还是 Claude 负责（它的另一个会话）
disp.ownerSay({ text: '@DeepSeek 分析字段' });                // T3：DeepSeek 负责
fs.writeFileSync(path.join(dir, '收件箱/原始订单.csv'), '原始\n');

const real = fs.realpathSync(dir);
const sb = sandboxStatus();
const hasCodex = spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0;
console.log(`系统沙箱（管 Claude 和 DeepSeek）：${sb.ok ? '可用' : '不可用 —— ' + sb.reason}`);
console.log(`Codex 自带沙箱：${hasCodex ? '可用' : '没找到 codex 命令，跳过'}`);
console.log(`自测用的临时项目：${dir}\n`);

let n = 0; let bad = 0;
// 在某个会话的限制下试着写一个文件。kind: seatbelt = Claude/DeepSeek 的方式；codex = Codex 的方式
function attempt(who, session, kind, rel, expectOk, what = '写') {
  const target = path.join(real, rel);
  let ok;
  if (kind === 'codex') {
    if (!hasCodex) return;
    const roots = session.writableAbs.filter((p) => p !== session.draftAbs);
    const cmd = what === '删' ? ['/bin/rm', '-f', target] : ['/bin/sh', '-c', 'printf x >> "$0"', target];
    // 和工作台启动 Codex 的方式一致：从草稿目录启动，本会话的范围作为额外的可写目录
    const r = spawnSync('codex', ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`, '--', ...cmd], { encoding: 'utf8', cwd: session.draftAbs });
    if (/^error: |Usage: codex sandbox/m.test(r.stderr ?? '')) { n++; bad++; console.log(`✗ 自测命令本身没跑起来（不是被沙箱拒绝）：${String(r.stderr).split('\n')[0]}`); return; }
    ok = r.status === 0 && (what === '删' ? !fs.existsSync(target) : true);
  } else {
    if (!sb.ok) return;
    const code = what === '删' ? `require('fs').unlinkSync(${JSON.stringify(target)})` : `require('fs').appendFileSync(${JSON.stringify(target)}, 'x')`;
    ok = spawnSync(SANDBOX_EXEC, ['-f', session.profile, process.execPath, '-e', code], { encoding: 'utf8' }).status === 0;
  }
  n++;
  const right = ok === expectOk;
  if (!right) bad++;
  console.log(`${right ? '✓' : '✗ 不符合预期'}  ${who.padEnd(24, '　')} ${what} ${rel.padEnd(26)} → ${ok ? '写进去了' : '被系统拒绝'}`);
}

const A = disp.prepareBoundary('Claude', 'T1', 'RselfA');
const B = disp.prepareBoundary('Claude', 'T2', 'RselfB');
const R = disp.prepareBoundary('Codex', 'T1', 'RselfR');
const D = disp.prepareBoundary('DeepSeek', 'T3', 'RselfD');
const M = disp.prepareBoundary('Claude', 'main', 'RselfM');
fs.writeFileSync(path.join(dir, '共享区/T1/文档A.md'), 'A\n');
fs.writeFileSync(path.join(dir, '共享区/T2/文档B.md'), 'B\n');

console.log('一、各写各的（应该写得进）');
attempt('Claude 做 T1 的会话', A, 'seatbelt', '共享区/T1/文档A.md', true);
attempt('Claude 做 T2 的会话', B, 'seatbelt', '共享区/T2/文档B.md', true);
attempt('DeepSeek 做 T3 的会话', D, 'seatbelt', '共享区/T3/字段映射.md', true);
attempt('Codex 审 T1 的会话', R, 'codex', '共享区/审查/T1/审查记录.md', true);
attempt('Claude 做 T1 的会话', A, 'seatbelt', '成员/Claude/T1/草稿.md', true);

console.log('\n二、两个会话碰同一个文件（应该被拒绝）');
attempt('Claude 做 T2 的会话', B, 'seatbelt', '共享区/T1/文档A.md', false);
attempt('Claude 做 T2 的会话', B, 'seatbelt', '共享区/T1/文档A.md', false, '删');
attempt('Claude 做 T1 的会话', A, 'seatbelt', '共享区/T2/文档B.md', false);
attempt('DeepSeek 做 T3 的会话', D, 'seatbelt', '共享区/T1/文档A.md', false);
attempt('Claude 的日常对话', M, 'seatbelt', '共享区/T1/文档A.md', false);
attempt('Claude 做 T2 的会话', B, 'seatbelt', '成员/Claude/T1/草稿.md', false);

console.log('\n三、审查人改被审查的成果（应该被拒绝）');
attempt('Codex 审 T1 的会话', R, 'codex', '共享区/T1/文档A.md', false);
attempt('Codex 审 T1 的会话', R, 'codex', '共享区/T1/文档A.md', false, '删');
attempt('Codex 审 T1 的会话', R, 'codex', '共享区/T2/文档B.md', false);

console.log('\n四、收件箱和工作台自己的数据（对谁都只读）');
attempt('Claude 做 T1 的会话', A, 'seatbelt', '收件箱/原始订单.csv', false);
attempt('DeepSeek 做 T3 的会话', D, 'seatbelt', '收件箱/原始订单.csv', false, '删');
attempt('Codex 审 T1 的会话', R, 'codex', '收件箱/原始订单.csv', false);
attempt('Claude 做 T1 的会话', A, 'seatbelt', '.workgroup/state.db', false);
attempt('Claude 做 T1 的会话', A, 'seatbelt', '乱放在项目根.txt', false);

console.log('\n五、提交之后（负责人自己也改不了，要先撤回）');
handleQun(disp, 'Claude', ['task', 'submit', 'T1', '--file', '共享区/T1/文档A.md', '--run', '打开看', '--evidence', '自测']);
const A2 = disp.prepareBoundary('Claude', 'T1', 'RselfA2');
attempt('Claude 做 T1 的会话（已提交）', A2, 'seatbelt', '共享区/T1/文档A.md', false);
handleQun(disp, 'Claude', ['task', 'revise', 'T1', '自测：撤回再改']);
const A3 = disp.prepareBoundary('Claude', 'T1', 'RselfA3');
attempt('Claude 做 T1 的会话（已撤回）', A3, 'seatbelt', '共享区/T1/文档A.md', true);

console.log('\n六、两张卡要同一个目录（建卡时就拦下）');
try { disp.tasks.create({ title: '也想写 T1 的目录', owner: 'Codex', creator: '群主', write: ['共享区/T1/'] }); bad++; console.log('✗ 不符合预期  居然建出来了'); }
catch (e) { n++; console.log(`✓  建卡被拒绝：${e.message.slice(0, 70)}…`); }

const kept = fs.readFileSync(path.join(dir, '收件箱/原始订单.csv'), 'utf8') === '原始\n';
console.log(`\n收件箱里的文件${kept ? '没有被动过' : '被改了！'}。`);
disp.dispose(); project.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(bad || !kept ? `\n结果：${n} 项里有 ${bad} 项不符合预期。` : `\n结果：${n} 项全部符合预期。写入边界是生效的。`);
if (!sb.ok) console.log('注意：系统沙箱不可用，Claude 和 DeepSeek 的部分没有测（它们现在只靠约定）。');
process.exit(bad || !kept ? 1 : 0);
