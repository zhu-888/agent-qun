// 任务卡状态机。
//
//   已派发 dispatched → 已接单 accepted → 进行中 working → 待审查 in_review
//        → 待群主验收 awaiting_owner → 已完成 done
//   另有：卡住 blocked、已打回 rejected、已取消 cancelled
//
// 规则（借鉴 crew 的“提交和审查通过是两步”，并补上它没强制的两点）：
//   · 只有负责人能接单、报进度、提交；只有审查人能给审查结论；只有群主能验收。
//   · 审查人不能是负责人（库里有 CHECK，这里再查一遍提交人）。
//   · 提交必须带成果文件、运行/核对方法、测试证据，缺一项拒收。
//   · 子任务审查通过即完成；没有父任务的任务（群主的需求）审查通过后进入“待群主验收”。
//   · 有子任务的任务：子任务全部完成后，由负责人汇总提交，直接进入“待群主验收”。
import { execFileSync } from 'node:child_process';
import { all, one, run, tx, J } from './store.mjs';
import { now, DIRS } from './project.mjs';
import { normalizeScopeEntry, scopesOverlap, REVIEW_DIR } from './boundary.mjs';
import { AGENTS, COORDINATOR, OWNER, defaultReviewer, LEVELS } from './members.mjs';
import { WtError } from './worktrees.mjs';
import { MODEL_ID_RE } from './models.mjs';

export const STATE_LABEL = {
  dispatched: '已派发', accepted: '已接单', working: '进行中', in_review: '待审查',
  awaiting_owner: '待群主验收', done: '已完成', blocked: '卡住', rejected: '已打回', cancelled: '已取消',
};
const OPEN_STATES = ['dispatched', 'accepted', 'working', 'blocked', 'rejected'];
// 提交之后成果就锁定：这些状态下，负责人的会话也不能再写这张卡的范围（要改先撤回：qun task revise）
export const FROZEN_STATES = ['in_review', 'awaiting_owner', 'done', 'cancelled'];

export class TaskError extends Error {}
const fail = (msg) => { throw new TaskError(msg); };

export class Tasks {
  // hooks: { wake(opts), releaseWaiting(taskId), cancelWakes(taskId, target), connected() }
  constructor(project, hooks) {
    this.p = project;
    this.db = project.db;
    this.hooks = hooks;
    this.actingRun = null;       // 正在处理的 qun 命令是哪一次运行发的（记在任务卡事件上，用来认出“卡是不是被别人推进了”）
    this.wt = null;              // 每张卡的 git 工作区（项目是 git 仓库时由调度器接上，见 worktrees.mjs）
  }

  // ---- 读取 -----------------------------------------------------------
  toTask(r) {
    if (!r) return null;
    return {
      id: r.id, seq: r.seq, title: r.title, owner: r.owner, reviewer: r.reviewer, creator: r.creator, noReview: !!r.no_review,
      parent: r.parent, after: J(r.after, []), state: r.state, stateLabel: STATE_LABEL[r.state],
      deliver: r.deliver, accept: r.accept, kind: r.kind, level: r.level, level_set: r.model_by === 'level',
      model: r.model, stepAt: r.step_at, stepTotal: r.step_total, stepText: r.step_text,
      submission: J(r.submission, null), review: J(r.review, null), rework: r.rework, revision: r.revision,
      chainId: r.chain_id, originMsg: r.origin_msg, createdTs: r.created_ts, updatedTs: r.updated_ts,
      write: J(r.write, []),
      // 这张卡的写入范围：没单独指定就是 共享区/<任务卡号>/
      scope: J(r.write, []).length ? J(r.write, []) : [`${DIRS.shared}/${r.id}/`],
      frozen: FROZEN_STATES.includes(r.state),
      wt: this.wt?.info(r.id) ?? null,
    };
  }

  // ---- 写入范围 ---------------------------------------------------------
  // 同一个位置同一时间只归一张没结束的任务卡：检查这些范围有没有和别的卡重叠
  assertScopeFree(entries, exceptId) {
    for (const o of this.list()) {
      if (o.id === exceptId || ['done', 'cancelled'].includes(o.state)) continue;
      for (const e of entries) for (const oe of o.scope) {
        if (scopesOverlap(e, oe)) {
          fail(`「${e}」和任务 ${o.id}「${clip(o.title, 20)}」（@${o.owner}）的写入范围「${oe}」重叠。同一个位置同一时间只能归一张没结束的任务卡：换一个目录，或者等 ${o.id} 结束。`);
        }
      }
    }
  }
  normScope(entries) {
    const out = [];
    for (const e of entries ?? []) {
      let n;
      try { n = normalizeScopeEntry(this.p, e); } catch (err) { fail(err.message); }
      if (!out.some((x) => n.startsWith(x))) out.push(n);
    }
    return out.filter((x) => !out.some((y) => y !== x && x.startsWith(y)));
  }
  draftDir(agent, taskId) { return `${DIRS.members}/${agent}/${taskId}/`; }
  reviewDir(taskId) { return `${REVIEW_DIR}/${taskId}/`; }
  // 一个文件是不是落在这些目录里
  inDirs(relPath, dirs) { return dirs.some((d) => relPath.startsWith(d)); }
  descendants(id) { const kids = this.children(id); return kids.concat(...kids.map((k) => this.descendants(k.id))); }

  // 负责人申请扩大写入范围（没被别的卡占用就批准）
  claim(id, actor, paths) {
    const t = this.need(id);
    const parent = t.parent ? this.get(t.parent) : null;
    if (![OWNER, t.owner, t.creator, parent?.owner].includes(actor)) fail(`只有群主、负责人或派单人能改 ${t.id} 的写入范围`);
    if (['done', 'cancelled'].includes(t.state)) fail(`任务 ${t.id} 已结束，不能再申请写入范围`);
    const want = this.normScope(paths).filter((e) => !t.scope.some((s) => e.startsWith(s)));
    if (!want.length) fail(paths?.length ? '这些位置已经在这张卡的写入范围里了' : '请写出要申请的目录，例如：qun task claim T3 共享区/convert/');
    this.assertScopeFree(want, t.id);
    const next = this.normScope([...t.scope, ...want]);
    const nt = this.move(t, { write: JSON.stringify(next) }, { actor, type: 'claimed', text: `写入范围增加：${want.join('、')}` });
    this.card(nt, `任务 ${t.id} 的写入范围增加了 ${want.join('、')}（${actor === OWNER ? '群主' : '@' + actor} 申请）。`);
    return nt;
  }

  // 负责人撤回提交：成果解锁，可以接着改。审查先停下，改完重新提交。
  revise(id, actor, reason) {
    const t = this.need(id);
    if (t.owner !== actor) fail(`任务 ${t.id} 的负责人是 @${t.owner}，只有它能撤回提交`);
    if (!['in_review', 'awaiting_owner'].includes(t.state)) fail(`任务 ${t.id} 现在是「${t.stateLabel}」，没有可以撤回的提交`);
    const why = String(reason ?? '').trim() || fail('请写清楚为什么要撤回、打算改什么');
    const nt = this.move(t, { state: 'working' }, { actor, type: 'revised', text: why });
    this.card(nt, `@${actor} 撤回了任务 ${t.id} 的提交，要接着改：${clip(why, 160)}。改完会重新提交。`);
    if (t.reviewer) { this.hooks.cancelWakes(t.id, t.reviewer); this.hooks.stopLane?.(t.reviewer, t.id, '负责人撤回了提交，这次审查作废'); }
    return nt;
  }
  get(id) { return this.toTask(one(this.db, 'SELECT * FROM tasks WHERE id=?', String(id).toUpperCase())); }
  // 提交之后又被改过的成果文件（盘上的内容和任务卡登记的版本对不上）
  changedSinceSubmit(t) {
    if (!t?.submission || !['in_review', 'awaiting_owner'].includes(t.state)) return [];
    return t.submission.files.filter((f) => this.p.statFile(f.path)?.sha !== f.sha).map((f) => f.path);
  }
  need(id) { return this.get(id) ?? fail(`没有任务 ${id}`); }
  list() { return all(this.db, 'SELECT * FROM tasks ORDER BY seq').map((r) => this.toTask(r)); }
  children(id) { return all(this.db, 'SELECT * FROM tasks WHERE parent=? ORDER BY seq', id).map((r) => this.toTask(r)); }
  events(id) {
    return all(this.db, 'SELECT * FROM task_events WHERE task_id=? ORDER BY id', id)
      .map((e) => ({ id: e.id, ts: e.ts, actor: e.actor, type: e.type, text: e.text, data: J(e.data, {}) }));
  }

  // ---- 内部：一次状态变化 = 一次带版本号的更新 + 一条过程记录 ---------------
  move(task, patch, event) {
    const cols = Object.keys(patch);
    const sql = `UPDATE tasks SET ${cols.map((c) => `${c}=?`).join(', ')}${cols.length ? ', ' : ''}revision=revision+1, updated_ts=?
                 WHERE id=? AND revision=?`;
    const r = run(this.db, sql, ...cols.map((c) => patch[c]), now(), task.id, task.revision);
    if (r.changes !== 1) fail(`任务 ${task.id} 刚被别人改过，请重新查看后再操作`);
    this.log(task.id, event.actor, event.type, event.text ?? '', event.data ?? {});
    this.p.sync();
    return this.get(task.id);
  }
  log(taskId, actor, type, text = '', data = {}) {
    run(this.db, 'INSERT INTO task_events(task_id,ts,actor,type,text,data) VALUES(?,?,?,?,?,?)',
      taskId, now(), actor, type, text, JSON.stringify(this.actingRun ? { ...data, run: this.actingRun } : data));
  }
  card(task, text) {
    // 群里的一条“任务动态”，不参与 @ 解析
    return this.p.post({ sender: '系统', kind: 'task', text, taskId: task.id, chainId: task.chainId });
  }

  // ---- 派单 -----------------------------------------------------------
  create({ title, owner, reviewer, creator, parent = null, after = [], deliver = '', accept = '',
           kind = '实现', level = null, model = null, chainId = null, originMsg = null, selfStart = false, write = [], noReview = false }) {
    title = String(title ?? '').trim();
    if (!title) fail('任务要有标题（--title）');
    owner = this.normName(owner) ?? fail(`负责人必须是群成员之一：${AGENTS.join('、')}`);
    const connected = this.hooks.connected();
    if (!connected.includes(owner)) fail(`@${owner} 未连接，不能派给它。已连接的成员：${connected.join('、') || '无'}`);
    if (creator !== OWNER && creator !== owner) {
      if (!String(deliver).trim()) fail('派给别人的任务要写清交付物（--deliver）');
      if (!String(accept).trim()) fail('派给别人的任务要写清验收条件（--accept）');
    }
    let parentTask = null;
    if (parent) {
      parentTask = this.need(parent);
      if (['done', 'cancelled'].includes(parentTask.state)) fail(`父任务 ${parentTask.id} 已结束，不能再加子任务`);
    }
    after = [...new Set((after ?? []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
    for (const dep of after) this.need(dep);

    if (creator !== OWNER) noReview = false;       // 只有群主能决定一张卡不用审查
    if (noReview) {
      reviewer = null;
    } else if (reviewer) {
      reviewer = this.normName(reviewer) ?? fail(`审查人必须是群成员之一：${AGENTS.join('、')}`);
      if (reviewer === owner) fail('审查人不能是负责人自己，请换一位');
      if (!connected.includes(reviewer)) fail(`@${reviewer} 未连接，不能当审查人`);
    } else {
      reviewer = defaultReviewer(owner, connected);
    }
    if (level && !LEVELS.includes(level)) fail(`模型档位只能是：${LEVELS.join('、')}`);
    const scope = this.normScope(write);

    const t = now();
    const task = tx(this.db, () => {
      const seq = (one(this.db, 'SELECT COALESCE(MAX(seq),0)+1 AS n FROM tasks').n);
      const id = `T${seq}`;
      const state = selfStart ? 'working' : 'dispatched';
      // 写入范围不能和别的没结束的任务卡重叠（没指定时默认是 共享区/<任务卡号>/）
      this.assertScopeFree(scope.length ? scope : [`${DIRS.shared}/${id}/`], id);
      run(this.db,
        `INSERT INTO tasks(id,seq,title,owner,reviewer,creator,parent,after,state,deliver,accept,kind,level,model,model_by,chain_id,origin_msg,created_ts,updated_ts,write,no_review)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, seq, title, owner, reviewer, creator, parentTask?.id ?? null, JSON.stringify(after), state,
        String(deliver ?? ''), String(accept ?? ''), kind, level ?? '常规', model, level ? 'level' : null,
        chainId ?? parentTask?.chainId ?? null, originMsg, t, t, JSON.stringify(scope), noReview ? 1 : 0);
      this.log(id, creator, 'created', `派给 @${owner}${reviewer ? `，审查人 @${reviewer}` : noReview ? '（群主选了不用审查）' : '（没有第二位已连接成员，无法安排审查）'}`);
      return this.get(id);
    });

    const pending = after.filter((d) => this.get(d)?.state !== 'done');
    const waitNote = pending.length ? `（等 ${pending.join('、')} 完成后开始）` : '';
    this.card(task, `${creator === OWNER ? '群主' : '@' + creator} 派发任务 ${task.id}「${title}」给 @${owner}${waitNote}`);

    // 父任务有了子任务，就算进行中
    if (parentTask && ['dispatched', 'accepted'].includes(parentTask.state)) {
      this.move(parentTask, { state: 'working' }, { actor: creator, type: 'step', text: `拆出子任务 ${task.id}` });
    }
    if (!selfStart) {
      this.hooks.wake({
        target: owner, reason: 'task_assigned', taskId: task.id, chainId: task.chainId,
        dedupeKey: `task:${task.id}:assigned:${task.revision}`, byAgent: creator !== OWNER,
        waiting: pending.length > 0, note: pending.length ? `等待 ${pending.join('、')}` : '',
        sourceMsg: originMsg,
      });
    }
    return task;
  }

  normName(n) {
    const s = String(n ?? '').replace(/^[@＠]/, '').trim().toLowerCase();
    return AGENTS.find((a) => a.toLowerCase() === s) ?? null;
  }

  // ---- 负责人的动作 -----------------------------------------------------
  accept(id, actor) {
    const t = this.need(id);
    if (t.owner !== actor) fail(`任务 ${t.id} 的负责人是 @${t.owner}，只有它能接单`);
    if (!['dispatched', 'rejected', 'blocked'].includes(t.state)) {
      if (['accepted', 'working'].includes(t.state)) return t;  // 重复接单不报错
      fail(`任务 ${t.id} 现在是「${t.stateLabel}」，不能接单`);
    }
    return this.move(t, { state: 'accepted' }, { actor, type: 'accepted', text: '接单' });
  }

  step(id, actor, text, { at, total } = {}) {
    const t = this.need(id);
    if (t.owner !== actor) fail(`任务 ${t.id} 的负责人是 @${t.owner}，只有它能报进度`);
    if (!OPEN_STATES.includes(t.state)) fail(`任务 ${t.id} 现在是「${t.stateLabel}」，不能再报进度`);
    const patch = { state: 'working', step_text: String(text ?? '').slice(0, 200) };
    if (Number.isFinite(+total) && +total > 0) patch.step_total = Math.min(99, Math.round(+total));
    if (Number.isFinite(+at) && +at > 0) patch.step_at = Math.min(99, Math.round(+at));
    return this.move(t, patch, { actor, type: 'step', text: patch.step_text, data: { at: patch.step_at, total: patch.step_total } });
  }

  submit(id, actor, { files = [], run: runHow = '', evidence = '', note = '' } = {}) {
    const t = this.need(id);
    if (t.owner !== actor) fail(`任务 ${t.id} 的负责人是 @${t.owner}，只有它能提交`);
    // 待审查、待群主验收时，负责人还可以再交一版（比如提交后又改了文件）。
    // 有审查人的任务重新提交后会回到“待审查”，按新版本重新审。
    const resubmit = ['in_review', 'awaiting_owner'].includes(t.state);
    if (!OPEN_STATES.includes(t.state) && !resubmit) fail(`任务 ${t.id} 现在是「${t.stateLabel}」，不能提交`);

    const missing = [];
    const infos = [];
    for (const f of files) {
      const info = this.p.statFile(f);
      if (!info) missing.push(`找不到文件「${f}」（要写项目里的相对路径，并且文件已经落盘）`);
      else if (info.size === 0) missing.push(`文件「${f}」是空的`);
      else infos.push(info);
    }
    // 成果必须放在这张卡自己的写入范围里（汇总提交时也可以是子任务的成果）
    const kidsAll = this.descendants(t.id).filter((k) => k.state !== 'cancelled');
    const wtDir = (x) => (x.wt ? [x.wt.dir] : []);
    const okDirs = [...t.scope, ...wtDir(t), this.draftDir(t.owner, t.id), ...kidsAll.flatMap((k) => [...k.scope, ...wtDir(k), this.draftDir(k.owner, k.id), this.reviewDir(k.id)])];
    const before = new Set((t.submission?.files ?? []).map((f) => f.path));     // 以前交过的文件可以原样再交
    const outside = infos.filter((f) => !this.inDirs(f.path, okDirs) && !before.has(f.path)).map((f) => f.path);
    if (outside.length) {
      missing.push(`这些文件不在这张卡的写入范围里：${outside.map(pretty).join('、')}。这张卡的范围是 ${[...t.scope, ...wtDir(t).map(pretty)].join('、')}，请把成果放进去再提交；确实要用别的目录，先运行 qun task claim ${t.id} <目录>`);
    }
    if (!files.length) missing.push('缺成果文件（--file 路径，可以写多个）');
    if (!String(runHow).trim()) missing.push('缺运行或核对方法（--run "怎么运行/怎么核对"）');
    if (!String(evidence).trim()) missing.push('缺测试证据（--evidence "实际跑出来的结果"）');
    if (missing.length) fail(`提交被拒收：\n- ${missing.join('\n- ')}`);

    const kids = this.children(t.id).filter((k) => k.state !== 'cancelled');
    const unfinished = kids.filter((k) => k.state !== 'done');
    if (unfinished.length) fail(`还有子任务没完成：${unfinished.map((k) => `${k.id}（${k.stateLabel}）`).join('、')}，现在不能提交 ${t.id}`);

    // 有 git 工作区：把工作区里的改动提交到这张卡的分支上，审查和验收认的就是这个提交
    let commit = null;
    if (t.wt?.live) {
      try { commit = this.wt.commitAll(t.id, `${t.id}「${clip(t.title, 40)}」第 ${t.rework + 1} 轮提交（@${actor}）`, actor); }
      catch (e) { if (e instanceof WtError) fail(`提交被拒收：${e.message}`); throw e; }
    }
    const submission = {
      files: infos, run: String(runHow).trim(), evidence: String(evidence).trim(), note: String(note).trim(),
      ts: now(), by: actor, round: t.rework + 1,
      ...(commit ? { commit: commit.sha.slice(0, 7), sha: commit.sha, branch: t.wt.branch } : { commit: this.gitHead() }),
    };
    const fileList = infos.map((f) => pretty(f.path)).join('、');

    if (kids.length) {
      // 汇总提交：每个子任务都已被独立审查过，直接交群主
      const nt = this.move(t, { state: 'awaiting_owner', submission: JSON.stringify(submission), step_text: '' },
        { actor, type: 'submitted', text: `汇总提交：${fileList}`, data: submission });
      this.card(nt, `任务 ${t.id}「${t.title}」的子任务全部通过审查，@${actor} 已汇总提交。@群主 请验收：${fileList}`);
      return nt;
    }
    if (!t.reviewer) {
      const nt = this.move(t, { state: 'awaiting_owner', submission: JSON.stringify(submission), step_text: '' },
        { actor, type: 'submitted', text: `提交：${fileList}（${t.noReview ? '群主选了不用审查' : '没有第二位已连接成员'}，未经成员审查）`, data: submission });
      this.card(nt, t.noReview
        ? `任务 ${t.id}「${t.title}」已提交。建这张卡时选了不用审查，@群主 请直接验收：${fileList}`
        : `任务 ${t.id}「${t.title}」已提交，但没有第二位已连接成员可以审查。@群主 请直接验收：${fileList}`);
      return nt;
    }
    const nt = this.move(t, { state: 'in_review', submission: JSON.stringify(submission), review: null, step_text: '' },
      { actor, type: 'submitted', text: `${resubmit ? '更新提交' : '提交'}：${fileList}`, data: submission });
    this.card(nt, resubmit
      ? `@${actor} 更新了任务 ${t.id}「${t.title}」的提交，@${t.reviewer} 请按新版本审查：${fileList}`
      : `@${actor} 提交了任务 ${t.id}「${t.title}」，等 @${t.reviewer} 审查：${fileList}`);
    this.hooks.wake({
      target: t.reviewer, reason: 'review_request', taskId: t.id, chainId: t.chainId,
      dedupeKey: `task:${t.id}:review:${nt.revision}`, byAgent: true,
    });
    return nt;
  }

  // actor 是“系统”时，是工作台替负责人报的（比如连续被重启打断）；这种情况不去叫派活的协调员，它也解决不了
  block(id, actor, text, { notifyCreator = true } = {}) {
    const t = this.need(id);
    if (actor !== '系统' && t.owner !== actor) fail(`任务 ${t.id} 的负责人是 @${t.owner}，只有它能报卡住`);
    if (!OPEN_STATES.includes(t.state)) fail(`任务 ${t.id} 现在是「${t.stateLabel}」，不能报卡住`);
    const why = String(text ?? '').trim() || fail('请写清楚卡在哪');
    const nt = this.move(t, { state: 'blocked', prev_state: t.state }, { actor, type: 'blocked', text: why });
    this.card(nt, `任务 ${t.id}「${t.title}」卡住了（${actor === '系统' ? '工作台' : '@' + actor}）：${why}。@群主 请处理，或改派。`);
    if (notifyCreator && actor !== COORDINATOR && t.creator === COORDINATOR) {
      this.hooks.wake({
        target: COORDINATOR, reason: 'task_blocked', taskId: t.id, chainId: t.chainId,
        dedupeKey: `task:${t.id}:blocked:${nt.revision}`, byAgent: true, note: why,
      });
    }
    return nt;
  }

  // ---- 审查人的动作 -----------------------------------------------------
  review(id, actor, { pass, evidence = '', files = [] } = {}) {
    const t = this.need(id);
    if (t.state !== 'in_review') fail(`任务 ${t.id} 现在是「${t.stateLabel}」，不在待审查状态`);
    if (t.owner === actor || t.submission?.by === actor) fail('不能审查自己提交的任务');
    if (t.reviewer !== actor) fail(`任务 ${t.id} 的审查人是 @${t.reviewer}，只有它能给审查结论`);
    if (typeof pass !== 'boolean') fail('请明确结论：--pass 或 --fail');
    if (!String(evidence).trim()) fail('审查结论必须附证据（--evidence "你独立核对了什么、结果如何"）');
    // 审的必须是提交的那个版本：提交后文件又被改过，就让负责人先重新提交
    const changed = (t.submission?.files ?? []).filter((f) => this.p.statFile(f.path)?.sha !== f.sha).map((f) => f.path);
    if (changed.length) {
      fail(`这些成果文件在提交之后被改过，和任务卡上登记的版本不一致：${changed.map(pretty).join('、')}。` +
        `请让负责人 @${t.owner} 运行 qun task submit ${t.id} 重新提交当前版本，你再按新版本审查。`);
    }
    if (pass && t.wt) {
      try { this.wt.checkSubmitted(t); } catch (e) { if (e instanceof WtError) fail(`${e.message}（请让 @${t.owner} 运行 qun task submit ${t.id} 重新提交，你再按新版本审查）`); throw e; }
    }
    const infos = files.map((f) => this.p.statFile(f)).filter(Boolean);
    const review = { pass, evidence: String(evidence).trim(), files: infos, by: actor, ts: now(), round: t.rework + 1 };

    if (!pass) {
      const nt = this.move(t, { state: 'working', review: JSON.stringify(review), rework: t.rework + 1 },
        { actor, type: 'review_failed', text: review.evidence, data: review });
      this.card(nt, `@${actor} 审查任务 ${t.id} 未通过，退回 @${t.owner} 修改：${clip(review.evidence, 160)}`);
      this.hooks.wake({
        target: t.owner, reason: 'review_failed', taskId: t.id, chainId: t.chainId,
        dedupeKey: `task:${t.id}:rework:${nt.revision}`, byAgent: true,
      });
      return nt;
    }
    if (!t.parent) {
      const nt = this.move(t, { state: 'awaiting_owner', review: JSON.stringify(review) },
        { actor, type: 'review_passed', text: review.evidence, data: review });
      this.card(nt, `任务 ${t.id}「${t.title}」已通过 @${actor} 的审查。@群主 请验收：${(t.submission?.files ?? []).map((f) => f.path).join('、')}`);
      return nt;
    }
    const nt = this.move(t, { state: 'done', review: JSON.stringify(review) },
      { actor, type: 'review_passed', text: review.evidence, data: review });
    this.card(nt, `子任务 ${t.id}「${t.title}」已通过 @${actor} 的审查，完成。${this.mergeKid(nt)}`);
    this.afterDone(nt);
    return nt;
  }

  // 任务完成后：放行等它的任务；父任务的子任务都完成了就叫负责人汇总
  afterDone(t) {
    this.hooks.cleanup?.();
    for (const other of this.list()) {
      if (!other.after.includes(t.id) || other.state !== 'dispatched') continue;
      const pending = other.after.filter((d) => this.get(d)?.state !== 'done');
      if (!pending.length) this.hooks.releaseWaiting(other.id);
    }
    if (!t.parent) return;
    const parent = this.get(t.parent);
    if (!parent || ['done', 'cancelled', 'awaiting_owner'].includes(parent.state)) return;
    const kids = this.children(parent.id).filter((k) => k.state !== 'cancelled');
    if (kids.every((k) => k.state === 'done')) {
      this.hooks.wake({
        target: parent.owner, reason: 'children_done', taskId: parent.id, chainId: parent.chainId,
        dedupeKey: `task:${parent.id}:children_done:${kids.map((k) => `${k.id}.${k.revision}`).join(',')}`, byAgent: true,
      });
    }
  }

  // 派单的人（或父任务负责人）发现已交的子任务有问题，可以退回重做
  reopen(id, actor, reason) {
    const t = this.need(id);
    const parent = t.parent ? this.get(t.parent) : null;
    if (actor !== OWNER && actor !== t.creator && actor !== parent?.owner) fail(`只有群主、派单人或父任务负责人能退回 ${t.id}`);
    if (!['done', 'in_review', 'awaiting_owner'].includes(t.state)) fail(`任务 ${t.id} 现在是「${t.stateLabel}」，不需要退回`);
    const why = String(reason ?? '').trim() || fail('请写清楚退回原因');
    if (t.state === 'done') this.assertScopeFree(t.scope, t.id);       // 结束期间这块地方可能已经划给别的卡了
    const nt = this.move(t, { state: 'rejected', rework: t.rework + 1 }, { actor, type: 'reopened', text: why });
    const sync = this.syncAfterConflict(nt);
    this.card(nt, `${actor === OWNER ? '群主' : '@' + actor} 把任务 ${t.id} 退回给 @${t.owner}：${sync ? `${endStop(clip(why, 160))}${sync}` : clip(why, 160)}`);
    // 子任务被退回，父任务之前的汇总就不算数了：从“待群主验收”撤回到进行中
    if (parent && parent.state === 'awaiting_owner') {
      const np = this.move(parent, { state: 'working' }, { actor, type: 'step', text: `子任务 ${t.id} 被退回重做，撤回汇总` });
      this.card(np, `任务 ${parent.id}「${parent.title}」的子任务 ${t.id} 被退回重做，先撤回验收，等它重新通过审查后再汇总提交。`);
    }
    this.hooks.wake({
      target: t.owner, reason: 'owner_rejected', taskId: t.id, chainId: t.chainId,
      dedupeKey: `task:${t.id}:reopen:${nt.revision}`, byAgent: actor !== OWNER, note: sync ? `${endStop(why)}${sync}` : why,
    });
    return this.get(t.id);
  }

  // ---- 群主的动作 -------------------------------------------------------
  approve(id) {
    const t = this.need(id);
    if (t.state !== 'awaiting_owner') fail(`任务 ${t.id} 现在是「${t.stateLabel}」，还没到群主验收这一步`);
    // 有 git 工作区：先合并进项目当前分支。有冲突、或者会覆盖项目文件夹里没提交的改动，就不合并，这次验收也不算
    let m = null;
    if (t.wt && !t.parent) {
      try { m = this.wt.mergeToMain(t); } catch (e) { if (e instanceof WtError) fail(e.message); throw e; }
      if (m.conflicts) {
        const files = m.conflicts.slice(0, 12).join('、') + (m.conflicts.length > 12 ? ` 等 ${m.conflicts.length} 个` : '');
        const text = `任务 ${t.id}「${t.title}」的改动没有合并：和项目里 ${m.into} 分支现在的内容有冲突，冲突在 ${files}。这张卡还在等你验收。可以点“打回”，工作台会把 ${m.into} 的最新改动合进 ${t.id} 的工作区，让 @${t.owner} 解决冲突后重新提交。`;
        this.p.post({ sender: '系统', kind: 'task', text, taskId: t.id, chainId: t.chainId });
        this.p.sync();
        fail(`没有合并：和 ${m.into} 有冲突，冲突在 ${files}。可以打回让 @${t.owner} 解决。`);
      }
    }
    const nt = this.move(t, { state: 'done' }, { actor: OWNER, type: 'approved', text: '群主验收通过', data: m?.merged ? { merged: m.commit, into: m.into } : {} });
    const merged = m?.merged ? `改动已合并进项目的 ${m.into} 分支（合并提交 ${m.commit.slice(0, 7)}），没有推送到远端。` : '';
    if (m?.into) this.relocate(nt);
    this.card(nt, `群主验收通过：任务 ${t.id}「${t.title}」已完成。${merged}`);
    this.afterDone(nt);
    return this.get(t.id);
  }

  // 合并进项目以后，工作区会被清理掉：任务卡上登记的成果文件改成项目里的位置（内容就是合并进来的那份）
  relocate(t) {
    const inWt = /^\.workgroup\/worktrees\/T\d+\//;
    for (const x of [t, ...this.descendants(t.id)]) {
      if (!x.submission?.files?.some((f) => inWt.test(f.path))) continue;
      if (x.id !== t.id && !x.wt?.merged) continue;      // 没合进来的子任务，成果还在它自己的分支上
      const files = x.submission.files.map((f) => ({ ...f, path: f.path.replace(inWt, '') }));
      run(this.db, 'UPDATE tasks SET submission=? WHERE id=?', JSON.stringify({ ...x.submission, files }), x.id);
    }
  }

  // 子任务审查通过：把它分支上的改动合并进父任务的工作区。返回要接在群消息后面的一句话
  mergeKid(t) {
    if (!t.wt || !t.parent) return '';
    const parent = this.get(t.parent);
    if (!parent || ['done', 'cancelled'].includes(parent.state)) return '';
    let m;
    try { m = this.wt.mergeToParent(t, parent, this); }
    catch (e) { if (!(e instanceof WtError)) throw e; return `它的改动没能合进 ${parent.id} 的工作区：${e.message}。改动留在分支 ${t.wt.branch} 上。`; }
    if (m.merged) return `它的改动已合并进 ${parent.id} 的工作区。`;
    if (m.conflicts) {
      const why = m.why ?? `冲突在 ${m.conflicts.slice(0, 8).join('、')}`;
      return `它的改动没有自动合进 ${parent.id} 的工作区（${why}），留在分支 ${t.wt.branch} 上。@${parent.owner} 汇总时请把这些改动手工合进 ${parent.id} 的工作区：git -C ${parent.wt?.abs ?? '<工作区>'} diff ${t.wt.baseCommit} ${t.wt.branch} 可以看到 ${t.id} 改了什么。`;
    }
    return '';
  }

  // 合并有冲突被打回（或退回）：把目标分支的最新改动合进这张卡的工作区，冲突的文件留下冲突标记。返回要告诉负责人的一句话
  syncAfterConflict(t) {
    if (!t.wt?.conflict) return '';
    let s;
    try { s = this.wt.syncFromBase(t, this); } catch (e) { if (!(e instanceof WtError)) throw e; return `工作台没能把 ${t.wt.conflict.into} 的最新改动合进工作区：${e.message}`; }
    if (!s) return '';
    return s.files.length
      ? `工作台已经把 ${s.into} 的最新改动合进 ${t.id} 的工作区，这些文件有冲突标记（<<<<<<< ======= >>>>>>>），请逐个改好、去掉标记，再重新提交：${s.files.join('、')}`
      : `工作台已经把 ${s.into} 的最新改动合进 ${t.id} 的工作区，没有冲突。请确认一下改动还对，再重新提交。`;
  }

  reject(id, reason) {
    const t = this.need(id);
    if (['cancelled'].includes(t.state)) fail(`任务 ${t.id} 已取消`);
    const why = String(reason ?? '').trim() || fail('打回要写原因，成员才知道改什么');
    if (t.state === 'done') this.assertScopeFree(t.scope, t.id);
    const nt = this.move(t, { state: 'rejected', rework: t.rework + 1 }, { actor: OWNER, type: 'rejected', text: why });
    const sync = this.syncAfterConflict(nt);
    this.card(nt, `群主打回任务 ${t.id}「${t.title}」：${sync ? `${endStop(why)}${sync}` : why}`);
    this.hooks.cancelWakes(t.id, null);
    this.hooks.wake({
      target: t.owner, reason: 'owner_rejected', taskId: t.id, chainId: t.chainId,
      dedupeKey: `task:${t.id}:rejected:${nt.revision}`, byAgent: false, note: sync ? `${endStop(why)}${sync}` : why,
    });
    return this.get(t.id);
  }

  reassign(id, actor, to, reason = '') {
    const t = this.need(id);
    if (actor !== OWNER && actor !== t.creator && actor !== t.owner) fail(`只有群主、派单人或当前负责人能改派 ${t.id}`);
    if (['done', 'cancelled'].includes(t.state)) fail(`任务 ${t.id} 已结束，不能改派`);
    const owner = this.normName(to) ?? fail(`改派对象必须是群成员之一：${AGENTS.join('、')}`);
    if (owner === t.owner) fail(`任务 ${t.id} 本来就是 @${owner} 负责`);
    const connected = this.hooks.connected();
    if (!connected.includes(owner)) fail(`@${owner} 未连接，不能改派给它`);
    const reviewer = t.noReview ? null : t.reviewer && t.reviewer !== owner ? t.reviewer : defaultReviewer(owner, connected);
    this.hooks.cancelWakes(t.id, null);
    this.hooks.stopLane?.(t.owner, t.id, `任务改派给了 @${owner}`);
    const nt = this.move(t, { owner, reviewer, state: 'dispatched', step_text: '' },
      { actor, type: 'reassigned', text: `从 @${t.owner} 改派给 @${owner}${reason ? '：' + reason : ''}` });
    this.card(nt, `任务 ${t.id}「${t.title}」从 @${t.owner} 改派给 @${owner}${reason ? '：' + reason : ''}`);
    this.hooks.wake({
      target: owner, reason: 'task_assigned', taskId: t.id, chainId: t.chainId,
      dedupeKey: `task:${t.id}:assigned:${nt.revision}`, byAgent: actor !== OWNER, note: reason,
    });
    return nt;
  }

  cancel(id, actor, reason = '') {
    const t = this.need(id);
    if (actor !== OWNER && actor !== t.creator) fail(`只有群主或派单人能取消 ${t.id}`);
    if (['done', 'cancelled'].includes(t.state)) return t;
    this.hooks.cancelWakes(t.id, null);
    const nt = this.move(t, { state: 'cancelled' }, { actor, type: 'cancelled', text: reason });
    this.card(nt, `任务 ${t.id}「${t.title}」已取消${reason ? '：' + reason : ''}`);
    for (const k of this.children(t.id)) this.cancel(k.id, actor, `父任务 ${t.id} 已取消`);
    this.hooks.cleanup?.();
    return nt;
  }

  setModel(id, model) {
    const t = this.need(id);
    if (model && !MODEL_ID_RE.test(String(model))) fail(`模型名「${String(model).slice(0, 40)}」不对：只能有字母、数字和 . _ - : / [ ]`);
    run(this.db, 'UPDATE tasks SET model=?, updated_ts=? WHERE id=?', model || null, now(), t.id);
    this.log(t.id, OWNER, 'model', model ? `群主指定模型：${model}` : '恢复自动选模型');
    this.p.sync();
    return this.get(t.id);
  }
  setLevel(id, level) {
    const t = this.need(id);
    if (!LEVELS.includes(level)) fail(`模型档位只能是：${LEVELS.join('、')}`);
    run(this.db, "UPDATE tasks SET level=?, model_by='level', updated_ts=? WHERE id=?", level, now(), t.id);
    this.log(t.id, OWNER, 'model', `群主把模型档位改成「${level}」`);
    this.p.sync();
    return this.get(t.id);
  }

  gitHead() {
    try {
      return execFileSync('git', ['-C', this.p.dir, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
        .toString().trim() || null;
    } catch { return null; }
  }
}

// 接下一句话之前补一个句号（原文已经以标点结尾就不补）
const endStop = (s) => (/[。！？.!?；;]$/.test(String(s).trim()) ? String(s).trim() : `${String(s).trim()}。`);
// 工作区里的文件路径写得短一点：.workgroup/worktrees/T3/src/a.js → T3 工作区/src/a.js
export const pretty = (p) => String(p).replace(/^\.workgroup\/worktrees\/(T\d+)\//, '$1 工作区/');
export const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
