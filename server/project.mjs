// 一个项目 = 一个工作群 = 一个本地文件夹。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { openDb, all, one, run, J } from './store.mjs';
import { parseMentions, OWNER } from './mentions.mjs';
import { AGENTS } from './members.mjs';

export const DIRS = { inbox: '收件箱', shared: '共享区', members: '成员', internal: '.workgroup' };
// 一次运行的 qun 请求目录（.workgroup/rpc/req/<运行号>/）。运行号只有字母数字，拼不出别的路径
export const RUN_ID_RE = /^R[0-9A-Za-z]{2,30}$/;
export const rpcRunDir = (dir, runId) => {
  if (!RUN_ID_RE.test(String(runId))) throw new Error(`运行号不对：${runId}`);
  return path.join(dir, DIRS.internal, 'rpc', 'req', runId);
};

// 用 open 打开就会运行程序的东西：应用和各种包、终端脚本、带执行权限的文件、指向别处的快捷方式
const PROGRAM_EXT = new Set(['.app', '.command', '.tool', '.terminal', '.workflow', '.action', '.scptd', '.jar', '.pkg', '.mpkg', '.fileloc', '.webloc', '.inetloc', '.prefpane', '.saver', '.appex', '.bundle', '.plugin', '.kext', '.dmg', '.shortcut']);
export function opensAsProgram(abs) {
  if (PROGRAM_EXT.has(path.extname(abs).toLowerCase())) return true;
  const st = fs.statSync(abs);
  return st.isFile() && (st.mode & 0o111) !== 0;
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const now = () => Date.now();

export class Project extends EventEmitter {
  constructor({ id, name, dir }) {
    super();
    this.id = id;
    this.name = name;
    this.dir = dir;
    this.ensureLayout();
    this.db = openDb(path.join(dir, DIRS.internal, 'state.db'));
    if (!this.getMeta('created_ts')) this.setMeta('created_ts', String(now()));
    this.setMeta('name', name);
    this._syncTimer = null;
  }

  // ---- 文件夹结构 ----------------------------------------------------
  ensureLayout() {
    const mk = (...p) => fs.mkdirSync(path.join(this.dir, ...p), { recursive: true });
    mk(DIRS.inbox);
    mk(DIRS.shared);
    for (const a of AGENTS) mk(DIRS.members, a);
    mk(DIRS.internal, 'rpc', 'req');
    mk(DIRS.internal, 'rpc', 'res');
    mk(DIRS.internal, 'runs');
    // .workgroup/ 里是群聊记录、运行日志：项目自己的 git 永远看不到它，群主 git add -A 也不会把它提交上去
    const ign = path.join(this.dir, DIRS.internal, '.gitignore');
    if (!fs.existsSync(ign)) fs.writeFileSync(ign, '# AgentQun 的内部文件夹：不进 git\n*\n');
    const readme = path.join(this.dir, DIRS.internal, '说明.txt');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme,
        '这个文件夹由 AgentQun（AI 工作群）管理：state.db 是本项目的群聊和任务记录，runs/ 是每次真实运行的日志，rpc/ 是成员和工作台之间的收发目录。\n');
    }
  }

  // 把任意路径规整成“项目内的相对路径”；跑到项目外面的一律拒绝。
  rel(p) {
    const abs = path.resolve(this.dir, String(p));
    const r = path.relative(this.dir, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
    return r.split(path.sep).join('/');
  }
  abs(relPath) {
    const r = this.rel(relPath);
    return r ? path.join(this.dir, r) : null;
  }
  // 真实位置也在项目里：项目里的符号链接可能指向项目外（比如 ~/.ssh），读、打开之前先确认
  realInside(abs) {
    try {
      const r = fs.realpathSync(abs), root = fs.realpathSync(this.dir);
      return r === root || r.startsWith(root + path.sep);
    } catch { return false; }
  }
  statFile(relPath) {
    const abs = this.abs(relPath);
    if (!abs || !fs.existsSync(abs) || !this.realInside(abs)) return null;
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(abs);
    return { path: this.rel(relPath), size: st.size, mtime: Math.round(st.mtimeMs), sha: sha256(buf).slice(0, 12) };
  }

  // ---- meta / 设置 ----------------------------------------------------
  getMeta(k, fallback = null) { return one(this.db, 'SELECT value FROM meta WHERE key=?', k)?.value ?? fallback; }
  setMeta(k, v) { run(this.db, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v)); }
  get settings() {
    return {
      hopLimit: 12,            // 一条需求最多允许成员之间自动交接多少次
      runTimeoutMin: 25,       // 单次运行超时（分钟）
      paused: false,
      memberModel: {},         // 成员手动指定模型：{ Claude: 'auto' | 'claude-opus-5-5' }
      kindLevel: {},           // 任务类型 → 档位 的自定义
      tiers: {},
      ...J(this.getMeta('settings'), {}),
    };
  }
  patchSettings(patch) {
    const s = { ...this.settings, ...patch };
    this.setMeta('settings', JSON.stringify(s));
    this.sync();
    return s;
  }

  // ---- 群消息 ---------------------------------------------------------
  // 返回 { msg, mentions }。mentions 只来自“自己说的话”。
  post({ sender, text, kind = 'chat', replyTo = null, taskId = null, files = [], runId = null, chainId = null, meta = {} }) {
    const fileInfos = [];
    for (const f of files) {
      const info = typeof f === 'string' ? this.statFile(f) : f;
      if (info) fileInfos.push(info);
    }
    const mentions = kind === 'chat' ? parseMentions(text, { exclude: sender }) : (meta.mentions ?? []);
    const ts = now();
    const r = run(this.db,
      `INSERT INTO messages(ts,sender,kind,text,reply_to,task_id,files,mentions,run_id,chain_id,meta)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ts, sender, kind, String(text), replyTo, taskId, JSON.stringify(fileInfos), JSON.stringify(mentions),
      runId, chainId, JSON.stringify(meta));
    const id = Number(r.lastInsertRowid);
    // 群主发起的新话题，自己就是一条“需求链”的起点
    if (chainId == null && sender === OWNER) {
      let chain = id;
      if (replyTo) chain = one(this.db, 'SELECT chain_id FROM messages WHERE id=?', replyTo)?.chain_id ?? id;
      run(this.db, 'UPDATE messages SET chain_id=? WHERE id=?', chain, id);
      chainId = chain;
    }
    this.sync();
    return { id, ts, sender, kind, text, replyTo, taskId, files: fileInfos, mentions, chainId };
  }
  system(text, extra = {}) { return this.post({ sender: '系统', kind: 'system', text, ...extra }); }

  message(id) { return this.rowToMsg(one(this.db, 'SELECT * FROM messages WHERE id=?', id)); }
  patchMessageMeta(id, patch) {
    const m = this.message(id);
    if (!m) return null;
    run(this.db, 'UPDATE messages SET meta=? WHERE id=?', JSON.stringify({ ...m.meta, ...patch }), id);
    this.sync();
    return this.message(id);
  }
  rowToMsg(r) {
    if (!r) return null;
    return {
      id: r.id, ts: r.ts, sender: r.sender, kind: r.kind, text: r.text, replyTo: r.reply_to, taskId: r.task_id,
      files: J(r.files, []), mentions: J(r.mentions, []), runId: r.run_id, chainId: r.chain_id, meta: J(r.meta, {}),
    };
  }
  messages({ sinceId = 0, limit = 400 } = {}) {
    const rows = all(this.db, 'SELECT * FROM (SELECT * FROM messages WHERE id>? ORDER BY id DESC LIMIT ?) ORDER BY id', sinceId, limit);
    return rows.map((r) => this.rowToMsg(r));
  }

  // 发给成员当背景的最近消息：只取和这件事有关的——同一个对话（同一条需求链）里的，加上不属于任何对话的系统通知（收件箱来了文件、项目暂停之类）。
  // sinceTs：只要这个时间之后的（接着同一个会话聊时，之前的它已经看过了）。不给 chainId 就退回成全项目最近的几条。
  recentFor({ chainId = null, sinceTs = null, limit = 20 } = {}) {
    const cond = [], args = [];
    if (chainId != null) { cond.push("(chain_id = ? OR (chain_id IS NULL AND kind != 'chat'))"); args.push(chainId); }
    if (sinceTs != null) { cond.push('ts > ?'); args.push(sinceTs); }
    const rows = all(this.db, `SELECT * FROM (SELECT * FROM messages ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT ?) ORDER BY id`, ...args, limit);
    return rows.map((r) => this.rowToMsg(r));
  }

  // ---- 对话：群主每提一个需求（一条需求链）就是一个对话，只属于这个项目 ------------
  // 这里只存群主给对话起的名字、是否归档、读到了哪一条；对话里的消息还是 messages 表里 chain_id 相同的那些
  chatMeta() { return J(this.getMeta('chats'), {}); }
  patchChat(id, patch) {
    const meta = this.chatMeta();
    const cur = { ...(meta[id] ?? {}) };
    if ('title' in patch) { const t = String(patch.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60); if (t) cur.title = t; else delete cur.title; }
    if ('archived' in patch) { if (patch.archived) cur.archived = true; else delete cur.archived; }
    if ('readId' in patch) cur.readId = Math.max(Number(cur.readId ?? 0), Number(patch.readId) || 0);
    meta[id] = cur;
    this.setMeta('chats', JSON.stringify(meta));
    this.sync();
    return cur;
  }
  // 每个对话一行：从哪条消息开始、最后一条是什么时候、一共几条。对话的编号就是群主开头那条消息的编号
  chatRows() {
    return all(this.db,
      `SELECT c.id, c.firstTs, c.lastTs, c.lastId, c.n, m.text
         FROM (SELECT chain_id AS id, MIN(ts) AS firstTs, MAX(ts) AS lastTs, MAX(id) AS lastId, COUNT(*) AS n
                 FROM messages WHERE chain_id IS NOT NULL GROUP BY chain_id) c
         JOIN messages m ON m.id = c.id AND m.sender = ?
        ORDER BY c.lastTs DESC`, OWNER);
  }
  isChat(id) { return !!one(this.db, 'SELECT 1 AS x FROM messages WHERE id=? AND chain_id=? AND sender=?', id, id, OWNER); }
  rename(name) { this.name = name; this.setMeta('name', name); this.sync(); }

  // ---- 收件箱：同一个文件只通知一次 ------------------------------------
  scanInbox() {
    const dir = path.join(this.dir, DIRS.inbox);
    const found = [];
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile()) found.push(p);
      }
    };
    try { walk(dir); } catch { return []; }
    const fresh = [];
    for (const abs of found) {
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      // 还在拷贝中的文件（刚改过）先等下一轮
      if (now() - st.mtimeMs < 800) continue;
      const info = this.statFile(abs);
      if (!info) continue;
      const seen = one(this.db, 'SELECT 1 AS x FROM inbox WHERE path=? AND sha=?', info.path, info.sha);
      if (seen) continue;
      const older = one(this.db, 'SELECT 1 AS x FROM inbox WHERE path=?', info.path);
      run(this.db, 'INSERT INTO inbox(path,sha,size,first_ts) VALUES(?,?,?,?)', info.path, info.sha, info.size, now());
      fresh.push({ ...info, updated: !!older });
    }
    if (fresh.length) {
      const names = fresh.map((f) => path.basename(f.path) + (f.updated ? '（新版本）' : '')).join('、');
      const m = this.post({ sender: '系统', kind: 'file', text: `收件箱收到 ${fresh.length} 个文件：${names}`, files: fresh });
      for (const f of fresh) run(this.db, 'UPDATE inbox SET msg_id=? WHERE path=? AND sha=?', m.id, f.path, f.sha);
    }
    return fresh;
  }
  watchInbox() {
    this.scanInbox();
    const dir = path.join(this.dir, DIRS.inbox);
    let t = null;
    const kick = () => { clearTimeout(t); t = setTimeout(() => { try { this.scanInbox(); } catch (e) { console.error('收件箱扫描失败', e); } }, 1000); };
    try { this._watcher = fs.watch(dir, { recursive: true }, kick); } catch { /* 用下面的定时扫描兜底 */ }
    this._inboxPoll = setInterval(kick, 5000);
  }

  // 项目里的文件清单（给界面和成员看）
  listFiles() {
    const out = [];
    const walk = (d, depth) => {
      if (depth > 4) return;
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (ent.name.startsWith('.')) continue;
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p, depth + 1);
        else if (ent.isFile()) {
          const st = fs.statSync(p);
          out.push({ path: this.rel(p), size: st.size, mtime: Math.round(st.mtimeMs) });
        }
      }
    };
    walk(this.dir, 0);
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, 300);
  }

  // ---- 通知界面刷新 -----------------------------------------------------
  sync() {
    if (this._syncTimer) return;
    this._syncTimer = setTimeout(() => { this._syncTimer = null; this.emit('sync'); }, 60);
  }

  close() {
    this._watcher?.close();
    clearInterval(this._inboxPoll);
    try { this.db.close(); } catch { /* 已关闭 */ }
  }
}
