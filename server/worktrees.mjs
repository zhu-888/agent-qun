// 每张任务卡一个 git 工作区（只在项目文件夹本身是 git 仓库时用）。
//
// 为什么要：写入范围只能是 共享区/ 下面互不重叠的目录，成员改不了项目自己的代码，两张卡也不能各改一份同一个文件。
// 有了工作区，每张卡在 .workgroup/worktrees/<卡号>/ 有一份项目代码的独立副本（分支 workgroup/<卡号>），
// 负责人在里面随便改，别的卡看不到，项目文件夹里的原件也不受影响。
//
// 规则：
//   · 工作区在负责人第一次在这张卡上干活时才建。顶层卡从项目当前分支的最新提交分出来；子任务从父任务的分支分出来。
//   · 写入范围照旧强制：只有负责人做这张卡的会话能写这个工作区，提交之后同样锁定；审查人只读。
//   · 成员不自己 git commit：负责人 qun task submit 时，工作台把工作区的改动提交到这张卡的分支上，提交号记在任务卡上。
//   · 子任务审查通过：把它的分支合并进父任务的工作区。顶层卡群主点“验收通过”：合并进项目当前分支。
//     合并前先用 git merge-tree 算一遍，有冲突就不合并，告诉群主冲突在哪些文件。项目文件夹里没提交的改动和这张卡改的文件重叠时也不合并。
//   · 永远不推送。
//   · 卡结束（完成、取消）后清理：工作区删掉；分支已经合并、或者根本没改动的就删，没合并的分支留着（里面的改动不丢）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { all, one, run, J } from './store.mjs';
import { DIRS, now } from './project.mjs';
import { findGit, baseEnv } from './snapshots.mjs';

export const WT_ROOT = `${DIRS.internal}/worktrees`;          // 相对项目文件夹
export const WT_BRANCH = 'workgroup/';
// 依赖目录不进 git，工作区里没有。项目里有的话，工作区里放一个指过去的链接（只读：写进去会被沙箱拦下）
export const WT_LINKS = ['node_modules', '.venv', 'venv'];
const WB = { name: 'AgentQun', email: 'workgroup@workgroup.local' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worktrees (
  task_id       TEXT PRIMARY KEY,
  branch        TEXT NOT NULL,
  base_branch   TEXT NOT NULL,       -- 合并回哪个分支：顶层卡是建工作区时项目所在的分支；子任务是父任务的分支
  base_commit   TEXT NOT NULL,       -- 从哪个提交分出来
  parent        TEXT,                -- 子任务：父任务卡号
  links         TEXT NOT NULL DEFAULT '[]',
  dirty_main    INTEGER NOT NULL DEFAULT 0,   -- 建的时候项目文件夹里有几个改了没提交的文件（这些改动不在工作区里）
  created_ts    INTEGER NOT NULL,
  merged_commit TEXT,
  merged_into   TEXT,
  merged_ts     INTEGER,
  conflict      TEXT,                -- 最近一次合并没成：{ files, into, why, ts }
  syncing       TEXT,                -- 正在解冲突：工作台已把 into 的新改动合进工作区，这些文件有冲突标记 { into, files, ts }
  removed_ts    INTEGER,
  kept          INTEGER NOT NULL DEFAULT 0    -- 清理时分支没合并、留着了
);`;

export class WtError extends Error {}

const short = (sha) => (sha ? String(sha).slice(0, 7) : null);
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export class Worktrees {
  constructor(project) {
    this.p = project;
    this.db = project.db;
    this.db.exec(SCHEMA);
    this._st = null;
  }

  // ---- git ----------------------------------------------------------------
  // 同步执行：qun 命令和界面按钮都是同步处理的，中间不会插进别的操作
  // core.fsmonitor 关掉：它会让 git 去运行配置里写的程序，工作台自己跑 git 时不需要它
  git(cwd, args, { env = {}, input = null, timeout = 120_000, quiet = false } = {}) {
    const r = spawnSync(findGit(), ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args], {
      cwd, input, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
      env: { ...baseEnv(), GIT_TERMINAL_PROMPT: '0', LANG: 'C', LC_ALL: 'C', ...this.pinned(cwd), ...env },
    });
    if (r.error) throw new WtError(`git ${args[0]} 没跑起来：${r.error.message}`);
    const res = { code: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
    if (!quiet && res.code !== 0) throw new WtError(`git ${args.find((a) => !a.startsWith('-')) ?? ''} 失败：${(res.err || res.out).slice(0, 400)}`);
    return res;
  }
  // 在任务卡的工作区里跑 git 时，不信工作区根目录下那个 .git 文件（负责人写得到它，改一下就能让工作台用它准备的仓库和配置），
  // 直接按项目 .git/worktrees/ 里登记的那份指定 GIT_DIR 和 GIT_WORK_TREE
  pinned(cwd) {
    const root = path.join(this.p.dir, WT_ROOT);
    const rel = path.relative(root, path.resolve(cwd));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return {};
    const wt = path.join(root, rel.split(path.sep)[0]);
    const r = spawnSync(findGit(), ['-c', 'core.fsmonitor=false', 'rev-parse', '--git-common-dir'], { cwd: this.p.dir, encoding: 'utf8', env: { ...baseEnv(), LANG: 'C', LC_ALL: 'C' } });
    const adm = path.join(path.resolve(this.p.dir, (r.stdout ?? '').trim()), 'worktrees');
    const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const want = realOr(wt);
    let names = [];
    try { names = fs.readdirSync(adm); } catch { /* 还没有工作区 */ }
    for (const name of names) {
      let gd = '';
      try { gd = fs.readFileSync(path.join(adm, name, 'gitdir'), 'utf8').trim(); } catch { continue; }
      if (realOr(path.dirname(gd)) === want) return { GIT_DIR: path.join(adm, name), GIT_WORK_TREE: wt };
    }
    throw new WtError(`工作区 ${path.basename(wt)} 在项目的 git 里没有登记（它的 .git 文件可能被改过），工作台不在里面跑 git`);
  }
  // 工作台自己在工作区里做的操作：不跑项目的 git 钩子、不签名
  wgit(cwd, args, opts = {}) {
    return this.git(cwd, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'merge.autoStash=false', ...args], opts);
  }
  ident(name, email = WB.email) {
    return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: WB.name, GIT_COMMITTER_EMAIL: WB.email };
  }
  memberIdent(agent) { return this.ident(`${agent}（AgentQun）`, `${String(agent).toLowerCase()}@workgroup.local`); }

  // ---- 项目是不是 git 仓库 ---------------------------------------------------
  status({ fresh = false } = {}) {
    if (!fresh && this._st && now() - this._st.at < 3000) return this._st;
    const st = { at: now(), ok: false, reason: null, branch: null };
    try {
      if (!findGit()) st.reason = '这台电脑上找不到 git';
      else {
        const top = this.git(this.p.dir, ['rev-parse', '--show-toplevel'], { quiet: true });
        if (top.code !== 0) st.reason = '项目文件夹不是 git 仓库';
        else if (real(top.out.trim()) !== real(this.p.dir)) st.reason = `项目文件夹在另一个 git 仓库（${top.out.trim()}）里面，不是仓库的最上层`;
        else if (this.git(this.p.dir, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { quiet: true }).code !== 0) st.reason = '这个 git 仓库还没有任何提交';
        else {
          const br = this.git(this.p.dir, ['symbolic-ref', '-q', '--short', 'HEAD'], { quiet: true });
          if (br.code !== 0) st.reason = '项目文件夹现在不在任何分支上（detached HEAD）';
          else { st.ok = true; st.branch = br.out.trim(); }
        }
      }
    } catch (e) { st.reason = e.message; }
    this._st = st;
    return st;
  }

  // ---- 记录 -----------------------------------------------------------------
  rec(taskId) {
    const r = one(this.db, 'SELECT * FROM worktrees WHERE task_id=?', taskId);
    return r ? { ...r, links: J(r.links, []), conflict: J(r.conflict, null), syncing: J(r.syncing, null) } : null;
  }
  relDir(taskId) { return `${WT_ROOT}/${taskId}/`; }
  absDir(taskId) { return path.join(this.p.dir, WT_ROOT, taskId); }
  live(taskId) {
    const r = this.rec(taskId);
    return r && !r.removed_ts && fs.existsSync(path.join(this.absDir(taskId), '.git')) ? r : null;
  }
  patch(taskId, fields) {
    const cols = Object.keys(fields);
    run(this.db, `UPDATE worktrees SET ${cols.map((c) => `${c}=?`).join(', ')} WHERE task_id=?`,
      ...cols.map((c) => (fields[c] !== null && typeof fields[c] === 'object' ? JSON.stringify(fields[c]) : fields[c])), taskId);
  }
  // 给界面、提示词、qun task show 看的
  info(taskId) {
    const r = this.rec(taskId);
    if (!r) return null;
    const live = !r.removed_ts && fs.existsSync(path.join(this.absDir(taskId), '.git'));
    return {
      branch: r.branch, baseBranch: r.base_branch, baseCommit: short(r.base_commit), parent: r.parent,
      dir: this.relDir(taskId), abs: this.absDir(taskId), live, links: r.links, dirtyMain: r.dirty_main,
      merged: r.merged_commit ? { commit: short(r.merged_commit), into: r.merged_into, ts: r.merged_ts } : null,
      conflict: r.conflict, syncing: r.syncing, removed: !!r.removed_ts, kept: !!r.kept,
    };
  }
  all() { return all(this.db, 'SELECT task_id FROM worktrees').map((r) => this.rec(r.task_id)); }

  // 工作区的 .git、node_modules 这些链接不算改动
  specs(r) { return ['--', '.', ...(r?.links ?? []).map((l) => `:(exclude,literal)${l}`)]; }
  dirtyFiles(taskId) {
    const r = this.rec(taskId);
    return this.git(this.absDir(taskId), ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', ...this.specs(r)]).out
      .split('\0').filter(Boolean).map((l) => l.slice(3));
  }

  // ---- 建工作区 ---------------------------------------------------------------
  // tasks：用来找父任务。返回记录，或者 null（项目不是 git 仓库）。出错抛 WtError。
  ensure(task, tasks) {
    const st = this.status();
    if (!st.ok) return null;
    const have = this.live(task.id);
    if (have) return have;
    const old = this.rec(task.id);
    const abs = this.absDir(task.id);
    const main = this.p.dir;

    // 从哪里分：子任务从父任务的分支（先把父任务工作区里还没提交的改动存一下，子任务才看得到）；顶层卡从项目当前分支
    let base = null, baseBranch = st.branch, parentId = null;
    const parent = task.parent ? tasks?.get(task.parent) : null;
    if (parent && !['done', 'cancelled'].includes(parent.state)) {
      const pr = this.ensure(parent, tasks);
      if (pr) {
        this.commitAll(parent.id, `${parent.id} 进行中的改动（给子任务 ${task.id} 分支之前存一下）`, parent.owner);
        base = this.git(main, ['rev-parse', `refs/heads/${pr.branch}^{commit}`]).out.trim();
        baseBranch = pr.branch; parentId = parent.id;
      }
    }
    if (!base) base = this.git(main, ['rev-parse', 'HEAD^{commit}']).out.trim();

    fs.mkdirSync(path.join(main, WT_ROOT), { recursive: true });
    this.ensureExclude();
    this.git(main, ['worktree', 'prune'], { quiet: true });
    if (fs.existsSync(abs)) {
      // 留下来的旧目录（比如上次崩在半路）：挪到旁边，不删，免得丢东西
      fs.renameSync(abs, `${abs}.旧-${now()}`);
    }
    // 分支：原来的分支还在（上次没合并、留着的）就接着用；否则新开一个
    const exists = (b) => this.git(main, ['show-ref', '--verify', '-q', `refs/heads/${b}`], { quiet: true }).code === 0;
    let branch = old?.branch && exists(old.branch) ? old.branch : null;
    if (branch) {
      this.wgit(main, ['worktree', 'add', '--quiet', abs, branch]);
    } else {
      branch = `${WT_BRANCH}${task.id}`;
      for (let i = 2; exists(branch); i++) branch = `${WT_BRANCH}${task.id}-${i}`;
      this.wgit(main, ['worktree', 'add', '--quiet', '-b', branch, abs, base]);
    }
    // 依赖目录：项目里有、又不归 git 管的，链接过去
    const links = [];
    for (const name of WT_LINKS) {
      const src = path.join(main, name);
      const dst = path.join(abs, name);
      try {
        if (!fs.statSync(src).isDirectory() || fs.existsSync(dst)) continue;
        if (this.git(main, ['ls-files', '--', name], { quiet: true }).out.trim()) continue;      // 是仓库里的文件，不是依赖目录
        fs.symlinkSync(src, dst);
        links.push(name);
      } catch { /* 没有这个目录 */ }
    }
    let dirty = 0;
    if (!parentId) {
      dirty = this.git(main, ['status', '--porcelain', '-uno', '-z'], { quiet: true }).out.split('\0').filter(Boolean).length;
    }
    run(this.db, `INSERT INTO worktrees(task_id,branch,base_branch,base_commit,parent,links,dirty_main,created_ts)
                  VALUES(?,?,?,?,?,?,?,?)
                  ON CONFLICT(task_id) DO UPDATE SET branch=excluded.branch, base_branch=excluded.base_branch, base_commit=excluded.base_commit,
                    parent=excluded.parent, links=excluded.links, dirty_main=excluded.dirty_main, created_ts=excluded.created_ts,
                    merged_commit=NULL, merged_into=NULL, merged_ts=NULL, conflict=NULL, syncing=NULL, removed_ts=NULL, kept=0`,
      task.id, branch, baseBranch, base, parentId, JSON.stringify(links), dirty, now());
    this.p.sync();
    return this.rec(task.id);
  }

  // 项目自己的 git 不该看到 .workgroup/（里面有工作区，git add -A 会把它们当成嵌套仓库加进去）。
  // 写在 .git/info/exclude：只在这台电脑上生效，不改项目里的任何文件
  ensureExclude() {
    try {
      const file = this.git(this.p.dir, ['rev-parse', '--git-path', 'info/exclude']).out.trim();
      const abs = path.resolve(this.p.dir, file);
      const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      if (/^\/?\.workgroup\/?$/m.test(cur)) return;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, `${cur && !cur.endsWith('\n') ? '\n' : ''}# AgentQun 的内部文件夹（任务卡的工作区也在里面）\n/.workgroup/\n`);
    } catch { /* 写不了不影响工作区本身 */ }
  }

  // ---- 提交：把工作区的改动存到这张卡的分支上 ------------------------------------
  // 返回 { sha, made }：made=这次有没有新提交。正在解冲突时，文件里还有冲突标记就拒绝。
  commitAll(taskId, message, agent = null) {
    const r = this.live(taskId);
    if (!r) return null;
    const cwd = this.absDir(taskId);
    const merging = this.git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { quiet: true }).code === 0;
    if (merging) {
      const unmerged = this.git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']).out.split('\0').filter(Boolean);
      const marked = unmerged.filter((f) => hasMarkers(path.join(cwd, f)));
      if (marked.length) throw new WtError(`这些文件里还有没解决的冲突标记（<<<<<<< ======= >>>>>>>）：${marked.join('、')}。改好再提交。`);
    }
    this.wgit(cwd, ['add', '-A', ...this.specs(r)]);
    const staged = this.git(cwd, ['diff', '--cached', '--quiet'], { quiet: true }).code !== 0;
    if (staged || merging) {
      this.wgit(cwd, ['commit', '-q', '--no-verify', '-m', message], { env: agent ? this.memberIdent(agent) : this.ident(WB.name) });
      if (merging || r.syncing) this.patch(taskId, { syncing: null });
    }
    const sha = this.git(cwd, ['rev-parse', 'HEAD']).out.trim();
    return { sha, made: staged || merging };
  }

  // ---- 合并 ---------------------------------------------------------------------
  // 只算一遍，不动任何文件：把 sha 合进 into 会不会冲突。返回冲突文件列表（没冲突是空的）
  conflictsOf(into, sha) {
    const r = this.git(this.p.dir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', into, sha], { quiet: true });
    if (r.code === 0) return [];
    if (r.code === 1) return r.out.split('\n').slice(1).map((s) => s.trim()).filter(Boolean);
    throw new WtError(`算合并结果时出错：${(r.err || r.out).slice(0, 300)}`);
  }
  ahead(base, sha) { return Number(this.git(this.p.dir, ['rev-list', '--count', `${base}..${sha}`]).out.trim()) || 0; }
  contains(into, sha) { return this.git(this.p.dir, ['merge-base', '--is-ancestor', sha, into], { quiet: true }).code === 0; }

  // 合并前的核对：这张卡登记的提交就是分支现在的样子，工作区里也没有提交之后的新改动
  checkSubmitted(task) {
    const r = this.rec(task.id);
    const sha = task.submission?.sha;
    if (!r || !sha) return null;
    const tip = this.git(this.p.dir, ['rev-parse', `refs/heads/${r.branch}`], { quiet: true }).out.trim();
    if (tip && tip !== sha) throw new WtError(`任务 ${task.id} 的分支 ${r.branch} 在提交之后又有了新改动（登记的是 ${short(sha)}，现在是 ${short(tip)}），和审查过的版本不一样。可以打回，让 @${task.owner} 重新提交。`);
    if (this.live(task.id)) {
      const dirty = this.dirtyFiles(task.id);
      if (dirty.length) throw new WtError(`任务 ${task.id} 的工作区在提交之后又被改过：${dirty.slice(0, 8).join('、')}${dirty.length > 8 ? ` 等 ${dirty.length} 个` : ''}。和审查过的版本不一样，可以打回，让 @${task.owner} 重新提交。`);
    }
    return { r, sha };
  }

  // 顶层卡验收：合并进项目当前所在的分支（必须是建工作区时的那个分支）。
  // 返回 { merged, commit, into } / { nothing: true } / { conflicts: [...], into }。其它情况抛 WtError。
  mergeToMain(task) {
    const chk = this.checkSubmitted(task);
    if (!chk) return { nothing: true };
    const { r, sha } = chk;
    const main = this.p.dir;
    const st = this.status({ fresh: true });
    if (!st.ok) throw new WtError(`没法合并：${st.reason}`);
    if (st.branch !== r.base_branch) throw new WtError(`项目文件夹现在在「${st.branch}」分支上，任务 ${task.id} 是从「${r.base_branch}」分出来的。切回 ${r.base_branch} 再点验收。`);
    if (this.contains('HEAD', sha)) { this.patch(task.id, { merged_commit: sha, merged_into: st.branch, merged_ts: now(), conflict: null }); return { nothing: true, into: st.branch }; }
    const files = this.conflictsOf('HEAD', sha);
    if (files.length) {
      this.patch(task.id, { conflict: { files, into: st.branch, ts: now() } });
      return { conflicts: files, into: st.branch };
    }
    const msg = `合并任务 ${task.id}「${task.title}」（群主在 AgentQun 验收通过）`;
    const named = this.git(main, ['config', 'user.name'], { quiet: true }).out.trim();
    const env = named ? {} : this.ident(WB.name);
    const res = this.git(main, ['-c', 'merge.autoStash=false', 'merge', '--no-ff', '--no-edit', '-m', msg, sha], { env, quiet: true });
    if (res.code !== 0) {
      // 合并没完成：确保项目文件夹回到原样（git 拒绝时本来就没动；万一停在半路就撤掉）
      if (this.git(main, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { quiet: true }).code === 0) this.git(main, ['merge', '--abort'], { quiet: true });
      const text = `${res.err}\n${res.out}`;
      const listed = [...text.matchAll(/^\t(.+)$/gm)].map((m) => m[1].trim());
      if (/would be overwritten/.test(text)) {
        const why = /untracked working tree files/.test(text) ? '项目文件夹里有这些还没加入 git 的文件，合并会覆盖它们' : '项目文件夹里这些文件有改了还没提交的内容，合并会覆盖它们';
        throw new WtError(`没有合并：${why}：${listed.slice(0, 8).join('、') || '（git 没列出文件）'}。先把这些改动提交或挪走，再点验收。`);
      }
      throw new WtError(`没有合并：${(res.err || res.out).split('\n').slice(0, 4).join(' ').slice(0, 300)}`);
    }
    const commit = this.git(main, ['rev-parse', 'HEAD']).out.trim();
    this.patch(task.id, { merged_commit: sha, merged_into: st.branch, merged_ts: now(), conflict: null });
    this._st = null;
    return { merged: true, commit, into: st.branch };
  }

  // 子任务审查通过：合并进父任务的工作区（父任务的会话可能正在里面干活，合并会直接改那里的文件）
  mergeToParent(task, parent, tasks) {
    const chk = this.checkSubmitted(task);
    if (!chk) return { nothing: true };
    const { sha } = chk;
    const pr = this.ensure(parent, tasks);
    if (!pr) return { nothing: true };
    const pdir = this.absDir(parent.id);
    if (this.git(pdir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { quiet: true }).code === 0) {
      this.patch(task.id, { conflict: { files: [], into: pr.branch, why: `${parent.id} 的工作区正在解另一个冲突`, ts: now() } });
      return { conflicts: [], into: pr.branch, why: `${parent.id} 的工作区正在解另一个冲突` };
    }
    this.commitAll(parent.id, `${parent.id} 进行中的改动（合并子任务 ${task.id} 之前存一下）`, parent.owner);
    if (this.contains(`refs/heads/${pr.branch}`, sha)) { this.patch(task.id, { merged_commit: sha, merged_into: pr.branch, merged_ts: now(), conflict: null }); return { nothing: true, into: pr.branch }; }
    const files = this.conflictsOf(`refs/heads/${pr.branch}`, sha);
    if (files.length) {
      this.patch(task.id, { conflict: { files, into: pr.branch, ts: now() } });
      return { conflicts: files, into: pr.branch };
    }
    this.wgit(pdir, ['merge', '--no-ff', '--no-edit', '-m', `合并子任务 ${task.id}「${task.title}」（审查通过）`, sha], { env: this.ident(WB.name) });
    this.patch(task.id, { merged_commit: sha, merged_into: pr.branch, merged_ts: now(), conflict: null });
    return { merged: true, into: pr.branch };
  }

  // 合并有冲突、被打回之后：工作台把目标分支的新改动合进这张卡的工作区，冲突的文件留下冲突标记，让负责人改。
  // 返回 { into, files }（files 空 = 没冲突，已经自动合好提交了）
  syncFromBase(task, tasks) {
    const r0 = this.rec(task.id);
    if (!r0) return null;
    const r = this.ensure(task, tasks);
    if (!r) return null;
    const cwd = this.absDir(task.id);
    const into = r.base_branch;
    if (this.git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { quiet: true }).code === 0) {
      return { into, files: r.syncing?.files ?? [] };
    }
    this.commitAll(task.id, `${task.id} 合并 ${into} 之前存一下`, task.owner);
    if (this.contains(`refs/heads/${r.branch}`, `refs/heads/${into}`)) return { into, files: [] };
    const res = this.wgit(cwd, ['merge', '--no-ff', '--no-commit', `refs/heads/${into}`], { env: this.ident(WB.name), quiet: true });
    if (res.code === 0) {
      this.wgit(cwd, ['commit', '-q', '--no-verify', '-m', `把 ${into} 的最新改动合进 ${task.id}`], { env: this.ident(WB.name) });
      this.patch(task.id, { syncing: null });
      return { into, files: [] };
    }
    const files = this.git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']).out.split('\0').filter(Boolean);
    if (!files.length) { this.git(cwd, ['merge', '--abort'], { quiet: true }); throw new WtError(`把 ${into} 合进 ${task.id} 的工作区失败：${res.err.slice(0, 300)}`); }
    this.patch(task.id, { syncing: { into, files, ts: now() } });
    return { into, files };
  }

  // ---- 清理 ---------------------------------------------------------------------
  // 卡已结束、而且没有会话正在用它的工作区。busy：正在运行的任务卡号
  cleanup(tasks, busy = new Set()) {
    const done = [];
    for (const r of all(this.db, 'SELECT task_id FROM worktrees WHERE removed_ts IS NULL').map((x) => this.rec(x.task_id))) {
      const t = tasks.get(r.task_id);
      if (!t || !['done', 'cancelled'].includes(t.state) || busy.has(t.id)) continue;
      // 子任务还要合进父任务：父任务还没结束、它的工作区可能还用得着这个分支，照样可以清（分支留着）
      try {
        if (this.live(t.id) && t.state === 'cancelled') this.commitAll(t.id, `任务 ${t.id} 取消时留下的改动`, t.owner);
      } catch { /* 有冲突标记之类，照样留在分支上的只是之前的提交 */ }
      const abs = this.absDir(t.id);
      if (fs.existsSync(abs)) {
        const rm = this.git(this.p.dir, ['worktree', 'remove', '--force', abs], { quiet: true });
        if (rm.code !== 0) { console.error(`清理工作区 ${t.id} 失败：${rm.err}`); continue; }
      }
      this.git(this.p.dir, ['worktree', 'prune'], { quiet: true });
      const tip = this.git(this.p.dir, ['rev-parse', '-q', '--verify', `refs/heads/${r.branch}`], { quiet: true }).out.trim();
      let kept = 0;
      if (tip) {
        const safe = (r.merged_commit && (tip === r.merged_commit || this.contains(r.merged_commit, tip))) || this.ahead(r.base_commit, tip) === 0;
        if (safe) this.git(this.p.dir, ['branch', '-D', r.branch], { quiet: true });
        else kept = 1;
      }
      this.patch(t.id, { removed_ts: now(), kept });
      done.push({ taskId: t.id, branch: r.branch, kept: !!kept });
    }
    if (done.length) this.p.sync();
    return done;
  }

  // 项目文件夹挪了位置：工作区和项目 .git 之间互相记的是绝对路径，修一下
  repair() {
    const live = all(this.db, 'SELECT task_id FROM worktrees WHERE removed_ts IS NULL').map((r) => this.absDir(r.task_id)).filter((d) => fs.existsSync(d));
    if (!live.length || !this.status().ok) return;
    this.git(this.p.dir, ['worktree', 'repair', ...live], { quiet: true });
  }
}

// 文件里还有没解决的冲突标记
function hasMarkers(abs) {
  try {
    const text = fs.readFileSync(abs, 'utf8');
    return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
  } catch { return false; }
}
