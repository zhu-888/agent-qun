// 成员通过 qun 命令和工作台交互。qun 把请求写成文件放进项目的 .workgroup/rpc/req/<运行号>/，
// 工作台处理后把结果写到 rpc/res/。用文件而不用网络，是因为成员的 CLI 可能跑在禁止联网的沙箱里。
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, RUN_ID_RE } from './project.mjs';
import { TaskError, STATE_LABEL, clip, pretty } from './tasks.mjs';
import { OWNER } from './members.mjs';

const BOOL = new Set(['pass', 'fail', 'help']);

export function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const k = a.slice(2);
      if (BOOL.has(k)) { opt[k] = true; continue; }
      const v = argv[i + 1];
      if (v === undefined) { opt[k] = true; continue; }
      i++;
      if (opt[k] === undefined) opt[k] = v;
      else opt[k] = [].concat(opt[k], v);
    } else pos.push(a);
  }
  return { pos, opt };
}
const list = (v) => (v === undefined || v === true ? [] : [].concat(v));
const str = (v) => (v === undefined || v === true ? '' : [].concat(v).join(' '));

function taskLine(t) {
  const step = t.stepTotal ? ` 步骤 ${t.stepAt}/${t.stepTotal}` : '';
  return `${t.id} [${STATE_LABEL[t.state]}] 「${t.title}」 负责人 @${t.owner}${t.reviewer ? ' 审查人 @' + t.reviewer : ''}${t.parent ? ' 父任务 ' + t.parent : ''}${step}`;
}

// 执行一条 qun 命令，返回要打印给成员看的文字
export function handleQun(disp, agent, argv, stdinText = '', runId = null, cwd = null) {
  try { return runQun(disp, agent, argv, stdinText, runId, cwd); } finally { disp.tasks.actingRun = null; }
}
function runQun(disp, agent, argv, stdinText, runId, cwd) {
  const p = disp.p;
  const tasks = disp.tasks;
  const { pos, opt } = parseArgs(argv);
  const [cmd, sub, ...rest] = pos;
  // 同一位成员可能同时有几个会话：先按运行号认，认不出再看命令里提到的是哪张任务卡
  const hint = cmd === 'task' && sub !== 'new' && /^t\d+$/i.test(rest[0] ?? '') ? rest[0].toUpperCase()
    : str(opt.parent) || str(opt.task) ? (str(opt.parent) || str(opt.task)).toUpperCase() : null;
  const ctx = disp.noteQunCall(agent, runId, hint);
  tasks.actingRun = ctx?.runId ?? null;
  // 文件路径：相对项目文件夹的优先；不存在的话，按成员运行命令时所在的目录再试一次（Codex 的命令从草稿目录启动）
  //   命令从任务卡的 git 工作区启动时反过来：先按工作区找（项目文件夹里多半有同名的原件，那不是它改的那份）
  const inWt = !!cwd && !!p.rel(cwd)?.startsWith(`${DIRS.internal}/worktrees/`);
  const fileArg = (f) => {
    if (path.isAbsolute(f) || !cwd) return f;
    const viaCwd = path.resolve(cwd, f);
    if (inWt && fs.existsSync(viaCwd)) return viaCwd;
    if (fs.existsSync(path.join(p.dir, f))) return f;
    return fs.existsSync(viaCwd) ? viaCwd : f;
  };
  const files = (v) => list(v).map(fileArg);
  // 负责人自己撤回提交或申请了新目录：这一步的写入权限已经定死了，所以排一个“接着做”，这一步结束后马上再叫它
  const continueAfter = (t, note) => {
    if (ctx && ctx.agent === t.owner && ctx.lane === t.id) {
      disp.wake({ target: t.owner, reason: 'continue', taskId: t.id, chainId: t.chainId, dedupeKey: `task:${t.id}:continue:${t.revision}`, byAgent: false, note });
      return true;
    }
    return false;
  };

  switch (cmd) {
    case 'say': {
      let text = [sub, ...rest].filter((x) => x !== undefined).join(' ');
      if (text === '-' || !text) text = stdinText;
      text = text.trim();
      if (!text) throw new TaskError('qun say 后面要跟要说的话');
      const msg = disp.postMember(ctx, {
        sender: agent, text, replyTo: opt.reply ? Number(opt.reply) : null, files: files(opt.file),
        taskId: opt.task ? String(opt.task).toUpperCase() : ctx?.taskId ?? null, runId: ctx?.runId ?? null, chainId: ctx?.chainId ?? null,
      });
      ctx?.said.push(text);
      const woke = msg.mentions.filter((n) => n !== OWNER);
      if (msg.meta?.stale) return `已发到群里（#${msg.id}），但标成了“已过时”：${msg.meta.stale.text}。${woke.length ? '里面的 ' + woke.map((n) => '@' + n).join('、') + ' 没有送出，等群主决定。' : ''}先用 qun task show ${msg.meta.stale.taskId} 看看现在的情况。`;
      return `已发到群里（#${msg.id}）${woke.length ? '，已通知 ' + woke.map((n) => '@' + n).join('、') : ''}`;
    }
    case 'tasks': {
      const all = tasks.list();
      return all.length ? all.map(taskLine).join('\n') : '还没有任务卡';
    }
    case 'chat': {
      const n = Math.min(60, Math.max(1, Number(opt.last ?? 20)));
      return p.messages({ limit: n }).map((m) => `#${m.id} ${m.sender}：${clip(m.text.replace(/\s+/g, ' '), 400)}${m.files.length ? ' [文件：' + m.files.map((f) => f.path).join('、') + ']' : ''}`).join('\n') || '群里还没有消息';
    }
    case 'files':
      return p.listFiles().filter((f) => !f.path.startsWith(DIRS.members + '/') || f.path.startsWith(`${DIRS.members}/${agent}/`))
        .slice(0, 80).map((f) => `${f.path}（${f.size} 字节）`).join('\n') || '项目里还没有文件';
    case 'who': {
      const st = disp.env.status();
      return Object.entries(st).map(([n, s]) => `@${n}：${s.connected ? '已连接' : '未连接'}`).join('\n');
    }
    case 'task': break;
    default:
      throw new TaskError('不认识的命令。可用：qun say / tasks / chat / files / who / task new|accept|step|submit|review|block|reopen|handoff|show');
  }

  const id = rest[0];
  const tail = rest.slice(1).join(' ');
  switch (sub) {
    case 'new': {
      const t = tasks.create({
        title: str(opt.title) || [id, tail].filter(Boolean).join(' '), owner: str(opt.owner) || agent, reviewer: str(opt.reviewer) || null,
        creator: agent, parent: str(opt.parent) ? str(opt.parent).toUpperCase() : null,
        after: str(opt.after).split(/[,，、\s]+/).filter(Boolean),
        deliver: str(opt.deliver), accept: str(opt.accept), kind: str(opt.kind) || '实现', level: str(opt.level) || null,
        write: list(opt.write).flatMap((w) => String(w).split(/[,，、]+/)).filter(Boolean),
        chainId: ctx?.chainId ?? null, selfStart: (str(opt.owner) || agent).replace(/^@/, '').toLowerCase() === agent.toLowerCase(),
      });
      return `已建任务卡 ${taskLine(t)}，写入范围 ${t.scope.join('、')}。${t.owner === agent ? '这是你自己的任务：它的写入范围要到这张卡自己的会话里才生效，系统会另外叫你。' : `系统会唤醒 @${t.owner}，你不用再 @ 它。`}`;
    }
    case 'accept': return `已接单：${taskLine(tasks.accept(id, agent))}`;
    case 'step': return `进度已记录：${taskLine(tasks.step(id, agent, tail || str(opt.text), { at: opt.at, total: opt.total }))}`;
    case 'submit': {
      const t = tasks.submit(id, agent, { files: files(opt.file), run: str(opt.run), evidence: str(opt.evidence), note: str(opt.note) });
      return t.state === 'in_review' ? `已提交，等 @${t.reviewer} 审查：${taskLine(t)}。系统会通知审查人，你不用再 @。`
        : `已提交，等群主验收：${taskLine(t)}`;
    }
    case 'review': {
      if (opt.pass && opt.fail) throw new TaskError('--pass 和 --fail 只能选一个');
      const t = tasks.review(id, agent, { pass: opt.pass ? true : opt.fail ? false : undefined, evidence: str(opt.evidence), files: files(opt.file) });
      return `审查结论已记录：${taskLine(t)}`;
    }
    case 'block': return `已标记卡住并通知群主：${taskLine(tasks.block(id, agent, tail || str(opt.reason)))}`;
    case 'revise': {
      const t = tasks.revise(id, agent, tail || str(opt.reason));
      const again = continueAfter(t, '撤回提交后接着改');
      return `已撤回 ${t.id} 的提交，成果解锁了。${again ? '但这一步里它们对你还是只读的：请现在就结束这一步（简单回复一句即可），系统会马上再叫你，那时就能改了。' : ''}改完记得重新 qun task submit。`;
    }
    case 'claim': {
      const t = tasks.claim(id, agent, rest.slice(1).concat(list(opt.dir)).map(fileArg));
      const again = continueAfter(t, '申请的写入范围已生效');
      return `已批准，${t.id} 现在的写入范围：${t.scope.join('、')}。${again ? '这一步里新目录还写不进去：请现在就结束这一步，系统会马上再叫你，那时就能写了。' : `@${t.owner} 下一次被唤醒时生效。`}`;
    }
    case 'reopen': return `已退回：${taskLine(tasks.reopen(id, agent, tail || str(opt.reason)))}`;
    case 'handoff': return `已改派：${taskLine(tasks.reassign(id, agent, str(opt.to), str(opt.reason)))}`;
    case 'show': {
      const t = tasks.need(id);
      const lines = [taskLine(t), `交付物：${t.deliver || '（未写）'}`, `验收条件：${t.accept || '（未写）'}`, `写入范围：${t.scope.join('、')}${t.frozen ? '（已提交，成果锁定）' : ''}`];
      if (t.wt) {
        lines.push(t.wt.merged ? `git 工作区：改动已合并进 ${t.wt.merged.into}`
          : t.wt.live ? `git 工作区：${t.wt.abs}（分支 ${t.wt.branch}，从 ${t.wt.baseBranch} 的 ${t.wt.baseCommit} 分出来）` : `git 工作区：已清理${t.wt.kept ? `，改动留在分支 ${t.wt.branch}` : ''}`);
        if (t.wt.syncing?.files?.length) lines.push(`工作区里有冲突标记要解决：${t.wt.syncing.files.join('、')}`);
        if (t.wt.conflict && !t.wt.merged) lines.push(`上次合并进 ${t.wt.conflict.into} 没成：${t.wt.conflict.why ?? `冲突在 ${(t.wt.conflict.files ?? []).join('、')}`}`);
      }
      if (t.submission) lines.push(`提交：${t.submission.files.map((f) => pretty(f.path)).join('、')}${t.submission.branch ? `（分支 ${t.submission.branch} 的提交 ${t.submission.commit}）` : ''}｜运行：${t.submission.run}｜证据：${t.submission.evidence}`);
      if (t.review) lines.push(`审查（@${t.review.by}）：${t.review.pass ? '通过' : '未通过'}｜${t.review.evidence}`);
      const kids = tasks.children(t.id);
      if (kids.length) lines.push('子任务：', ...kids.map((k) => '  ' + taskLine(k)));
      return lines.join('\n');
    }
    default:
      throw new TaskError('qun task 后面要跟：new / accept / step / submit / revise / claim / review / block / reopen / handoff / show');
  }
}

// 盯着请求目录，来一个处理一个。
// 请求放在 req/<运行号>/ 里：每次运行一个目录，沙箱只让那次运行写它自己的目录。
// 所以是谁在说话按目录认（那次运行是哪位成员），请求里自报的名字不算数——冒充别人审查、冒充群主发话都做不到。
export function serveRpc(disp) {
  const reqDir = path.join(disp.p.dir, DIRS.internal, 'rpc', 'req');
  const resDir = path.join(disp.p.dir, DIRS.internal, 'rpc', 'res');
  const seen = new Set();
  const handle = (file, name, runId) => {
    if (!/^[\w.-]+\.json$/.test(name)) return;
    const key = `${runId ?? ''}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    let res;
    try {
      const req = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ctx = runId ? disp.active.get(runId) : null;
      if (!runId) res = { ok: false, text: 'qun 的请求要放在这次运行自己的目录里：请用工作台给你的 qun 命令' };
      else if (!ctx) res = { ok: false, text: `运行 ${runId} 已经结束（或者不是工作台启动的），这条 qun 命令不再受理` };
      else {
        try { res = { ok: true, text: handleQun(disp, ctx.agent, req.argv ?? [], req.stdin ?? '', runId, req.cwd ?? null) }; }
        catch (e) {
          if (!(e instanceof TaskError)) console.error('qun 处理出错', e);
          res = { ok: false, text: e instanceof TaskError ? e.message : `工作台内部错误：${e.message}` };
        }
      }
    } catch (e) { res = { ok: false, text: `请求格式不对：${e.message}` }; }
    // 回复也按运行分目录放，别的运行没法抢先放一个同名的假回复
    const outDir = path.join(resDir, runId ?? '_');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, name);
    fs.writeFileSync(out + '.tmp', JSON.stringify(res));
    fs.renameSync(out + '.tmp', out);
    fs.rmSync(file, { force: true });
    setTimeout(() => {
      seen.delete(key); fs.rmSync(out, { force: true });
      try { fs.rmdirSync(outDir); } catch { /* 目录里还有别的回复 */ }
    }, 120000).unref();
  };
  const scan = () => {
    let entries;
    try { entries = fs.readdirSync(reqDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isFile()) { handle(path.join(reqDir, ent.name), ent.name, null); continue; }
      if (!ent.isDirectory() || !RUN_ID_RE.test(ent.name)) continue;
      let names;
      try { names = fs.readdirSync(path.join(reqDir, ent.name)); } catch { continue; }
      for (const name of names) handle(path.join(reqDir, ent.name, name), name, ent.name);
    }
  };
  let watcher = null;
  try { watcher = fs.watch(reqDir, { recursive: true }, scan); } catch { /* 用定时扫描兜底 */ }
  const timer = setInterval(scan, 250);
  scan();
  return () => { watcher?.close(); clearInterval(timer); };
}
