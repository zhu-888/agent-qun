// 改动快照：成员每次运行前后，把这次运行能写的那几个目录各拍一次，
// 用来回答“这一次改了哪些文件、改了什么”，以及群主不满意时把这一次的改动撤回去。
//
// 快照存在项目的 .workgroup/snap.git：一个只给工作台用的独立 git 仓库（bare），
// 不碰项目自己的 .git，项目不是 git 仓库也能用。每次运行一个临时索引文件，前后两棵树各挂一个引用：
//   refs/wg/<运行号>/pre、refs/wg/<运行号>/post
// 只拍这次运行能写的目录（写入边界由系统沙箱强制），所以同时在跑的别的会话不会混进来。
//
// 不拍：node_modules/、.git/、.workgroup/、.DS_Store、项目 .gitignore 里列的东西、单个超过 5 MB 的文件（记下来告诉群主）。
// 保留：最近 30 天，或整个快照仓库不超过 2 GB，先到哪个算哪个；任务卡还没结束的快照不删。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run, J } from './store.mjs';

export const SNAP = {
  bigFile: 5 * 1024 * 1024,
  keepDays: 30,
  maxBytes: 2 * 1024 ** 3,
  diffChars: 400_000,
  exclude: ['node_modules', '.git/', '.workgroup/', '.DS_Store'],      // node_modules 不带斜杠：任务卡工作区里它是个链接，也不拍

};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  run_id     TEXT PRIMARY KEY,
  agent      TEXT NOT NULL,
  task_id    TEXT,
  dirs       TEXT NOT NULL DEFAULT '[]',
  pre        TEXT,
  post       TEXT,
  files      TEXT NOT NULL DEFAULT '[]',
  n          INTEGER NOT NULL DEFAULT 0,
  adds       INTEGER NOT NULL DEFAULT 0,
  dels       INTEGER NOT NULL DEFAULT 0,
  skipped    TEXT NOT NULL DEFAULT '[]',
  error      TEXT,
  ms         INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL,
  ended_ts   INTEGER,
  rolled_ts  INTEGER,
  rolled_by  TEXT,
  pruned     INTEGER NOT NULL DEFAULT 0
);`;

// 找一个能用的 git（启动工作台的方式不同，PATH 里不一定有 Homebrew 的 git）
let gitBin;
export function findGit() {
  if (gitBin !== undefined) return gitBin;
  gitBin = null;
  for (const c of ['git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 5000 }); gitBin = c; break; } catch { /* 下一个 */ }
  }
  return gitBin;
}

// 去掉外面带进来的 GIT_* 变量，免得指到别的仓库
export const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const CFG = ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'gc.auto=0',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'advice.addEmbeddedRepo=false', '-c', 'core.hooksPath=/dev/null'];
const lit = (p) => `:(literal)${p}`;
const WT_PREFIX = '.workgroup/worktrees/';      // 任务卡的 git 工作区（见 worktrees.mjs）

export class Snapshots {
  constructor(project) {
    this.p = project;
    this.db = project.db;
    this.db.exec(SCHEMA);
    this.gitDir = path.join(project.dir, '.workgroup', 'snap.git');
    this.inflight = 0;
    this.ready = null;
    this.off = null;      // 用不了时的原因（比如这台电脑没有 git）
  }

  git(args, { index = null, input = null, cwd = this.p.dir, work = this.p.dir, maxBuffer = 256 * 1024 * 1024 } = {}) {
    const env = { ...baseEnv(), GIT_DIR: this.gitDir, GIT_WORK_TREE: work, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    if (index) env.GIT_INDEX_FILE = index;
    return new Promise((resolve, reject) => {
      const child = spawn(findGit(), [...CFG, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out = []; let n = 0; const err = [];
      child.stdout.on('data', (c) => { n += c.length; if (n <= maxBuffer) out.push(c); });
      child.stderr.on('data', (c) => err.push(c));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(out));
        else reject(new Error(`git ${args[0]} 失败：${Buffer.concat(err).toString().trim().slice(0, 400)}`));
      });
      child.stdin.on('error', () => {});
      if (input != null) child.stdin.write(input);
      child.stdin.end();
    });
  }

  init() {
    this.ready ??= (async () => {
      if (!findGit()) { this.off = '这台电脑上找不到 git，改动快照没有开启'; return; }
      if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
        fs.mkdirSync(this.gitDir, { recursive: true });
        await new Promise((resolve, reject) => {
          const c = spawn(findGit(), ['init', '--bare', '-q', this.gitDir], { env: baseEnv(), stdio: 'ignore' });
          c.on('error', reject); c.on('close', (code) => (code === 0 ? resolve() : reject(new Error('git init 失败'))));
        });
      }
      fs.mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
      fs.mkdirSync(path.join(this.gitDir, 'idx'), { recursive: true });
      fs.writeFileSync(path.join(this.gitDir, 'info', 'exclude'), `# AgentQun：改动快照不拍这些\n${SNAP.exclude.join('\n')}\n`);
      fs.writeFileSync(path.join(this.gitDir, 'description'), 'AgentQun 的改动快照（每次成员运行前后各一份）。不是项目自己的 git 仓库。\n');
    })().catch((e) => { this.off = `改动快照开不了：${e.message}`; });
    return this.ready;
  }

  // 拍一次：把 dirs（项目内相对目录，以 / 结尾）的当前内容写成一棵树，挂到 refs/wg/<运行号>/<which>
  //   任务卡的 git 工作区（.workgroup/worktrees/<卡号>/）单独拍：它是个嵌套的 git 工作区，而且在 .workgroup/ 里面，
  //   按项目文件夹拍会被跳过。所以以工作区本身为根拍一棵树，再挂到总树的 .workgroup/worktrees/<卡号>/ 下面——
  //   这样看改动、撤回都还是按项目里的相对路径来，不用另外处理。
  async capture(runId, which, dirs) {
    const index = path.join(this.gitDir, 'idx', runId);
    const wtDirs = dirs.filter((d) => d.startsWith(WT_PREFIX));
    const plain = dirs.filter((d) => !d.startsWith(WT_PREFIX));
    const listed = plain.length
      ? (await this.git(['ls-files', '-z', '-o', '-c', '--exclude-standard', '--', ...plain.map(lit)], { index })).toString('utf8').split('\0').filter(Boolean)
      : [];
    const big = [];
    for (const f of new Set(listed)) {
      try { const st = fs.lstatSync(path.join(this.p.dir, f)); if (st.isFile() && st.size > SNAP.bigFile) big.push(f); } catch { /* 已经删了 */ }
    }
    const used = plain.filter((d) => listed.some((f) => f.startsWith(d)));
    if (used.length) {
      const specs = [...used.map(lit), ...big.map((f) => `:(exclude,literal)${f}`)];
      await this.git(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { index, input: specs.join('\0') + '\0' });
    }
    for (const [i, d] of wtDirs.entries()) {
      const work = path.join(this.p.dir, d);
      if (!fs.existsSync(work)) continue;
      const sub = `${index}.wt${i}`;
      const files = (await this.git(['ls-files', '-z', '-o', '-c', '--exclude-standard'], { index: sub, work, cwd: work })).toString('utf8').split('\0').filter(Boolean);
      const bigHere = [];
      for (const f of new Set(files)) {
        try { const st = fs.lstatSync(path.join(work, f)); if (st.isFile() && st.size > SNAP.bigFile) bigHere.push(f); } catch { /* 已经删了 */ }
      }
      big.push(...bigHere.map((f) => d + f));
      await this.git(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { index: sub, work, cwd: work, input: ['.', ...bigHere.map((f) => `:(exclude,literal)${f}`)].join('\0') + '\0' });
      const subTree = (await this.git(['write-tree'], { index: sub, work, cwd: work })).toString().trim();
      await this.git(['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', lit(d)], { index });
      await this.git(['read-tree', `--prefix=${d}`, subTree], { index });
    }
    const tree = (await this.git(['write-tree'], { index })).toString().trim();
    await this.git(['update-ref', `refs/wg/${runId}/${which}`, tree]);
    return { tree, big };
  }

  // 运行开始前：建一条记录，拍“之前”
  async before({ runId, agent, taskId, dirs }) {
    await this.init();
    if (this.off) return null;
    const t0 = Date.now();
    run(this.db, 'INSERT OR IGNORE INTO snapshots(run_id,agent,task_id,dirs,created_ts) VALUES(?,?,?,?,?)', runId, agent, taskId ?? null, JSON.stringify(dirs), t0);
    this.inflight++;
    try {
      const { tree, big } = await this.capture(runId, 'pre', dirs);
      run(this.db, 'UPDATE snapshots SET pre=?, skipped=?, ms=? WHERE run_id=?', tree, JSON.stringify(big), Date.now() - t0, runId);
      return tree;
    } catch (e) {
      run(this.db, 'UPDATE snapshots SET error=? WHERE run_id=?', e.message.slice(0, 500), runId);
      return null;
    } finally { this.inflight--; }
  }

  // 运行结束后：拍“之后”，算出改了哪些文件
  async after(runId) {
    await this.init();
    const row = one(this.db, 'SELECT * FROM snapshots WHERE run_id=?', runId);
    if (this.off || !row?.pre || row.post) return null;
    const dirs = J(row.dirs, []);
    const t0 = Date.now();
    this.inflight++;
    try {
      const { tree, big } = await this.capture(runId, 'post', dirs);
      const files = await this.changed(row.pre, tree, dirs);
      const skipped = [...new Set([...J(row.skipped, []), ...big])];
      run(this.db, 'UPDATE snapshots SET post=?, files=?, n=?, adds=?, dels=?, skipped=?, ms=ms+?, ended_ts=? WHERE run_id=?',
        tree, JSON.stringify(files), files.length, files.reduce((s, f) => s + (f.a ?? 0), 0), files.reduce((s, f) => s + (f.d ?? 0), 0),
        JSON.stringify(skipped), Date.now() - t0, Date.now(), runId);
      return files;
    } catch (e) {
      run(this.db, 'UPDATE snapshots SET error=?, ended_ts=? WHERE run_id=?', e.message.slice(0, 500), Date.now(), runId);
      return null;
    } finally {
      this.inflight--;
      for (const f of fs.readdirSync(path.join(this.gitDir, 'idx'))) if (f === runId || f.startsWith(`${runId}.wt`)) fs.rm(path.join(this.gitDir, 'idx', f), { force: true }, () => {});
    }
  }

  // 两棵树之间改了哪些文件：[{ p: 路径, s: A 新增 / M 修改 / D 删除, a: 加了几行, d: 删了几行, bin: 是不是二进制 }]
  async changed(pre, post, dirs) {
    const spec = ['--', ...dirs.map(lit)];
    const ns = (await this.git(['diff', '--name-status', '-z', '--no-renames', pre, post, ...spec])).toString('utf8').split('\0');
    const files = new Map();
    for (let i = 0; i + 1 < ns.length; i += 2) if (ns[i]) files.set(ns[i + 1], { p: ns[i + 1], s: ns[i][0] });
    const num = (await this.git(['diff', '--numstat', '-z', '--no-renames', pre, post, ...spec])).toString('utf8').split('\0');
    for (const rec of num) {
      const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
      if (!m || !files.has(m[3])) continue;
      const f = files.get(m[3]);
      if (m[1] === '-') f.bin = true; else { f.a = Number(m[1]); f.d = Number(m[2]); }
    }
    return [...files.values()];
  }

  row(runId) { return one(this.db, 'SELECT * FROM snapshots WHERE run_id=?', runId); }

  // 给界面看的摘要：运行号 → { n, adds, dels, rolled }
  summaries(runIds) {
    if (!runIds.length) return {};
    const rows = all(this.db, `SELECT run_id, n, adds, dels, rolled_ts, post, skipped FROM snapshots WHERE run_id IN (${runIds.map(() => '?').join(',')})`, ...runIds);
    return Object.fromEntries(rows.filter((r) => r.post).map((r) => [r.run_id, { n: r.n, adds: r.adds, dels: r.dels, rolled: r.rolled_ts ?? null, skipped: J(r.skipped, []).length }]));
  }

  // 一次运行的完整改动：文件列表 + 逐行对比（太长就截断）
  async diff(runId) {
    await this.init();
    const r = this.row(runId);
    if (!r) throw new Error('这次运行没有改动快照（可能是加快照之前的运行，或者是整理群摘要的运行）');
    if (r.pruned) throw new Error('这次运行的快照已经超过保留期限，被清理了');
    if (!r.post) throw new Error(r.error ? `快照没拍成：${r.error}` : '这次运行还没结束，结束后才能看改动');
    const dirs = J(r.dirs, []);
    let text = '';
    if (r.n) {
      text = (await this.git(['diff', '--no-color', '--no-renames', '-U3', r.pre, r.post, '--', ...dirs.map(lit)], { maxBuffer: SNAP.diffChars * 4 })).toString('utf8');
    }
    const truncated = text.length > SNAP.diffChars;
    return {
      runId, agent: r.agent, taskId: r.task_id, dirs, files: J(r.files, []), skipped: J(r.skipped, []),
      text: truncated ? text.slice(0, SNAP.diffChars) : text, truncated,
      rolled: r.rolled_ts ? { ts: r.rolled_ts, by: r.rolled_by } : null, endedTs: r.ended_ts,
    };
  }

  // 撤回一次运行的改动：只动这次运行改过的文件，恢复成运行之前的样子。
  // 这些文件只要有一个在那之后又被改过（别的运行、群主自己），就整个拒绝，不做一半。
  // busyDirs：现在正在跑的会话能写的目录；和这次运行的目录有重叠就先不撤回，免得和正在干的活打架。
  async rollback(runId, { by = '群主', busyDirs = [] } = {}) {
    await this.init();
    const r = this.row(runId);
    if (!r || !r.post) throw new Error('这次运行没有完整的改动快照，没法撤回');
    if (r.pruned) throw new Error('这次运行的快照已经超过保留期限，被清理了');
    if (r.rolled_ts) throw new Error('这次运行的改动已经撤回过了');
    const files = J(r.files, []);
    if (!files.length) throw new Error('这次运行没有改动任何文件');
    const dirs = J(r.dirs, []);
    const overlap = (a, b) => a === b || a.startsWith(b) || b.startsWith(a);
    const busy = busyDirs.find((b) => dirs.some((d) => overlap(b.dir, d)));
    if (busy) throw new Error(`@${busy.agent} 正在「${busy.dir}」里干活，等它这一步结束再撤回`);

    const entries = async (tree) => {
      const out = (await this.git(['ls-tree', '-r', '-z', '--full-tree', tree, '--', ...files.map((f) => lit(f.p))])).toString('utf8').split('\0').filter(Boolean);
      const map = new Map();
      for (const line of out) { const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/s.exec(line); if (m) map.set(m[3], { mode: m[1], sha: m[2] }); }
      return map;
    };
    const pre = await entries(r.pre);
    const post = await entries(r.post);
    const blob = (sha) => this.git(['cat-file', 'blob', sha]);

    // 先核对：每个文件现在都必须还是这次运行结束时的样子
    const conflicts = [];
    const plain = [];
    for (const f of files) {
      const abs = path.join(this.p.dir, f.p);
      const want = post.get(f.p);
      let st = null; try { st = fs.lstatSync(abs); } catch { /* 不存在 */ }
      if (!want) { if (st) conflicts.push(f.p); continue; }
      if (!st) { conflicts.push(f.p); continue; }
      if (want.mode === '120000') {
        if (!st.isSymbolicLink() || fs.readlinkSync(abs) !== (await blob(want.sha)).toString()) conflicts.push(f.p);
        continue;
      }
      if (!st.isFile()) { conflicts.push(f.p); continue; }
      plain.push({ f, want });
    }
    if (plain.length) {
      const hashes = (await this.git(['hash-object', '--stdin-paths'], { input: plain.map((x) => x.f.p).join('\n') + '\n' })).toString().trim().split('\n');
      plain.forEach((x, i) => { if (hashes[i] !== x.want.sha) conflicts.push(x.f.p); });
    }
    if (conflicts.length) {
      const e = new Error(`这些文件在那次运行之后又被改过，为了不抹掉后来的工作，这次不撤回：${conflicts.slice(0, 8).join('、')}${conflicts.length > 8 ? ` 等 ${conflicts.length} 个` : ''}`);
      e.conflicts = conflicts;
      throw e;
    }

    // 再动手：运行之前没有的文件删掉，其余恢复成运行之前的内容
    for (const f of files) {
      const abs = path.join(this.p.dir, f.p);
      const was = pre.get(f.p);
      if (!was) { fs.rmSync(abs, { force: true }); continue; }
      const content = await blob(was.sha);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      try { if (fs.lstatSync(abs).isSymbolicLink()) fs.rmSync(abs, { force: true }); } catch { /* 不存在 */ }
      if (was.mode === '120000') { fs.symlinkSync(content.toString(), abs); continue; }
      fs.writeFileSync(abs, content);
      fs.chmodSync(abs, was.mode === '100755' ? 0o755 : 0o644);
    }
    run(this.db, 'UPDATE snapshots SET rolled_ts=?, rolled_by=? WHERE run_id=?', Date.now(), by, runId);
    return { files, skipped: J(r.skipped, []) };
  }

  // 清理：超过 30 天的删掉；整个仓库超过 2 GB 再从最旧的删。任务卡没结束的不删。
  // 只在这个项目没有快照正在拍的时候做（canRun 由调度器告诉我们）。
  async prune({ openTasks = new Set(), now = Date.now() } = {}) {
    await this.init();
    if (this.off || this.inflight) return { removed: 0 };
    const eligible = () => all(this.db, 'SELECT run_id, task_id, created_ts FROM snapshots WHERE pruned=0 AND (post IS NOT NULL OR error IS NOT NULL) ORDER BY created_ts')
      .filter((r) => !(r.task_id && openTasks.has(r.task_id)));
    const drop = async (rows) => {
      if (!rows.length) return 0;
      const lines = rows.flatMap((r) => [`delete refs/wg/${r.run_id}/pre`, `delete refs/wg/${r.run_id}/post`]).join('\n') + '\n';
      await this.git(['update-ref', '--stdin'], { input: lines }).catch(() => {});
      for (const r of rows) run(this.db, 'UPDATE snapshots SET pruned=1 WHERE run_id=?', r.run_id);
      return rows.length;
    };
    let removed = await drop(eligible().filter((r) => r.created_ts < now - SNAP.keepDays * 86400_000));
    if (removed) await this.gc();
    for (let round = 0; round < 6 && this.size() > SNAP.maxBytes; round++) {
      const rows = eligible();
      if (!rows.length) break;
      removed += await drop(rows.slice(0, Math.max(1, Math.ceil(rows.length / 5))));
      await this.gc();
    }
    // 中途崩掉留下的临时索引
    try {
      for (const f of fs.readdirSync(path.join(this.gitDir, 'idx'))) {
        const abs = path.join(this.gitDir, 'idx', f);
        if (now - fs.statSync(abs).mtimeMs > 86400_000) fs.rmSync(abs, { force: true });
      }
    } catch { /* 没有 */ }
    return { removed };
  }
  async gc() { await this.git(['gc', '--prune=now', '--quiet']).catch(() => {}); }
  size() {
    let total = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { total += fs.statSync(p).size; } catch { /* 刚被删 */ } } };
    try { walk(this.gitDir); } catch { /* 还没有 */ }
    return total;
  }
}
