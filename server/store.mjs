// 每个项目一个 SQLite 文件，放在项目文件夹的 .workgroup/ 里。
// 不同项目的聊天、任务、文件登记天然隔离：它们根本不在同一个库里。
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  sender    TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','system','file','task')),
  text      TEXT NOT NULL,
  reply_to  INTEGER,
  task_id   TEXT,
  files     TEXT NOT NULL DEFAULT '[]',
  mentions  TEXT NOT NULL DEFAULT '[]',
  run_id    TEXT,
  chain_id  INTEGER,
  meta      TEXT NOT NULL DEFAULT '{}'
);

-- 任务卡。状态机见 tasks.mjs；这里用 CHECK 保证库里写不进非法状态，
-- 也写不进“审查人就是负责人”的任务（crew 只靠提示词约束这一点，这里改成硬约束）。
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL,
  owner       TEXT NOT NULL,
  reviewer    TEXT,
  creator     TEXT NOT NULL,
  parent      TEXT,
  after       TEXT NOT NULL DEFAULT '[]',
  state       TEXT NOT NULL CHECK (state IN
              ('dispatched','accepted','working','in_review','awaiting_owner','done','blocked','rejected','cancelled')),
  prev_state  TEXT,
  deliver     TEXT NOT NULL DEFAULT '',
  accept      TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '实现',
  level       TEXT NOT NULL DEFAULT '常规',
  model       TEXT,
  model_by    TEXT,
  step_at     INTEGER NOT NULL DEFAULT 0,
  step_total  INTEGER NOT NULL DEFAULT 0,
  step_text   TEXT NOT NULL DEFAULT '',
  submission  TEXT,
  review      TEXT,
  rework      INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL DEFAULT 0,
  chain_id    INTEGER,
  origin_msg  INTEGER,
  created_ts  INTEGER NOT NULL,
  updated_ts  INTEGER NOT NULL,
  CHECK (reviewer IS NULL OR reviewer <> owner)
);

-- 每次状态变化留一条不可改的记录（任务卡上的过程记录就读这张表）。
CREATE TABLE IF NOT EXISTS task_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  actor    TEXT NOT NULL,
  type     TEXT NOT NULL,
  text     TEXT NOT NULL DEFAULT '',
  data     TEXT NOT NULL DEFAULT '{}'
);

-- 唤醒单：一次“把某件事送到某个成员的真实会话”。
-- UNIQUE(target, dedupe_key) 保证同一件事不会对同一个成员派两次。
CREATE TABLE IF NOT EXISTS wakes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  target       TEXT NOT NULL,
  reason       TEXT NOT NULL,
  source_msg   INTEGER,
  task_id      TEXT,
  dedupe_key   TEXT NOT NULL,
  chain_id     INTEGER,
  by_agent     INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL CHECK (state IN ('queued','waiting','delivered','accepted','done','failed','held','cancelled')),
  note         TEXT NOT NULL DEFAULT '',
  run_id       TEXT,
  delivered_ts INTEGER,
  done_ts      INTEGER,
  UNIQUE (target, dedupe_key)
);

-- 一次真实的 CLI 运行。
CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  agent      TEXT NOT NULL,
  started_ts INTEGER NOT NULL,
  ended_ts   INTEGER,
  status     TEXT NOT NULL,
  model      TEXT,
  model_by   TEXT,
  effort     TEXT,
  session_id TEXT,
  resumed    INTEGER NOT NULL DEFAULT 0,
  usage      TEXT NOT NULL DEFAULT '{}',
  exit_code  INTEGER,
  error      TEXT,
  wake_ids   TEXT NOT NULL DEFAULT '[]',
  task_id    TEXT,
  log_path   TEXT,
  last_cmd   TEXT,
  final_text TEXT,
  first_out_ts INTEGER,
  qun_calls  INTEGER NOT NULL DEFAULT 0
);

-- 每个成员在本项目里的会话号，重启后靠它接着聊。
CREATE TABLE IF NOT EXISTS sessions (
  agent      TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  model      TEXT,
  updated_ts INTEGER NOT NULL
);

-- 并行：一位成员可以同时有多条“线”，每条线一个会话。
-- 线的名字是任务卡编号（成员是这张卡的负责人或审查人），或者 main（不属于某张卡的日常对话）。
-- （上面的 sessions 表是旧版“每位成员一个会话”时用的，现在只在升级时读一次。）
CREATE TABLE IF NOT EXISTS lanes (
  agent      TEXT NOT NULL,
  lane       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  model      TEXT,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (agent, lane)
);

-- 收件箱登记：同一个文件（同路径同内容）只通知一次。
CREATE TABLE IF NOT EXISTS inbox (
  path     TEXT NOT NULL,
  sha      TEXT NOT NULL,
  size     INTEGER NOT NULL,
  first_ts INTEGER NOT NULL,
  msg_id   INTEGER,
  PRIMARY KEY (path, sha)
);

CREATE INDEX IF NOT EXISTS idx_wakes_state ON wakes(state, target);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // 老库补字段：记录每次运行的进程号，工作台异常退出后重启时好把残留进程收掉
  const cols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
  if (!cols.includes('pid')) db.exec('ALTER TABLE runs ADD COLUMN pid INTEGER');
  if (!cols.includes('kind')) db.exec('ALTER TABLE runs ADD COLUMN kind TEXT');   // work = 干活，summary = 写群摘要
  if (!cols.includes('lane')) db.exec('ALTER TABLE runs ADD COLUMN lane TEXT');   // 这次运行属于成员的哪条线
  if (!cols.includes('denied')) db.exec('ALTER TABLE runs ADD COLUMN denied INTEGER NOT NULL DEFAULT 0');   // 这次运行里有几处操作被系统拦下（沙箱）
  // 任务卡的写入范围（项目内的相对目录，JSON 数组；空 = 默认的 共享区/<任务卡号>/）
  const tcols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!tcols.includes('write')) db.exec("ALTER TABLE tasks ADD COLUMN write TEXT NOT NULL DEFAULT '[]'");
  // 群主建卡时选了“不用审查”：这张卡提交后直接到群主验收，改派时也不会再给它安排审查人
  if (!tcols.includes('no_review')) db.exec('ALTER TABLE tasks ADD COLUMN no_review INTEGER NOT NULL DEFAULT 0');
  return db;
}

export const all = (db, sql, ...p) => db.prepare(sql).all(...p);
export const one = (db, sql, ...p) => db.prepare(sql).get(...p);
export const run = (db, sql, ...p) => db.prepare(sql).run(...p);

// 事务：要么都写进去，要么都不写。
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const J = (s, fallback) => {
  try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; }
};
