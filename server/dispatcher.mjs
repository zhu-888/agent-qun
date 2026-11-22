// 调度：把 @ 和任务事件变成“唤醒单”，送进对应成员的真实 CLI 会话。
//
// 一条唤醒单的状态：
//   waiting   等前置任务
//   queued    已入队（成员正忙、未连接或项目暂停时停在这里）
//   delivered 已送达：真实 CLI 进程已启动，并且报回了会话号
//   accepted  已接单：成员在这次运行里已经开始动作（调用了 qun，或给出了回复）
//   done / failed / cancelled
//   held      被拦下：这条需求的成员间自动交接超过上限，等群主决定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { all, one, run, J } from './store.mjs';
import { now, DIRS, rpcRunDir } from './project.mjs';
import { Tasks, TaskError, clip } from './tasks.mjs';
import { AGENTS, MEMBERS, OWNER, COORDINATOR, DEFAULT_PARALLEL, MAX_PARALLEL, pickModel } from './members.mjs';
import { buildPrompt, buildInjectPrompt, buildSummaryPrompt, identityText } from './prompt.mjs';
import { sandboxStatus, seatbeltProfile, MAIN_DRAFT } from './boundary.mjs';
import { Snapshots } from './snapshots.mjs';
import { Worktrees, WT_ROOT } from './worktrees.mjs';

export const SUMMARY_FILE = `${DIRS.shared}/群摘要.md`;
const realDir = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const SUMMARY_LANE = '__summary__';
// 界面上“正在做”那一行：成员正在写的话只放最后这么多字（逐字显示看的是最新的字）；整段在内存里最多留这么多
const LIVE_TAIL = 240, LIVE_MAX = 40000;
const tailText = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(-n);      // 放不下时界面在左边打省略号
const TOOL_DENIED = /^工具没放开/;
// 成员不能推送（推送永远由群主自己来）：成员的 git 换一份全局配置，照常引用群主自己的配置，只多一条：
// 推送的地址一律改写成 qunnopush://，由工作台的小程序接住、报 operation not permitted 拒绝（工作台据此在群里说被拦下）。
// 拉取、看历史不受影响。防的是误推：远端单独写了 pushurl、或者成员存心绕开，这里挡不住。
const NO_PUSH = 'qunnopush';
export const NO_PUSH_MSG = 'git push: operation not permitted: 工作台不让成员推送，推送由群主自己来（改动交到任务卡上，群主验收后自己决定推不推）';
function noPushGitConfig() {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return ['[include]', `\tpath = ${path.join(os.homedir(), '.gitconfig')}`, `\tpath = ${path.join(xdg, 'git', 'config')}`,
    `[url "${NO_PUSH}://"]`, ...['https://', 'http://', 'ssh://', 'git://', 'git@', 'file://'].map((p) => `\tpushInsteadOf = ${p}`),
    `[url "${NO_PUSH}:///"]`, '\tpushInsteadOf = /', ''].join('\n');
}
// 日常对话的会话：每个对话一条线（c<对话号>）；不属于任何对话的 @ 走 main。任务卡的会话的线名就是任务卡号。
const CHAT_LANE = /^c(\d+)$/;
const isChatLane = (lane) => lane === 'main' || CHAT_LANE.test(lane);
// 会话接着用得越久，每一步要重读的内容越多。日常对话的会话接着用了这么多次、或者上一次运行已经这么大，就换一个新的。
// 任务卡的会话做到一半换掉代价大，所以只在大得离谱时才换。
const ROTATE_RUNS = 8, ROTATE_CHAT_TOKENS = 400_000, ROTATE_TASK_TOKENS = 1_500_000;
// 工作台重启打断了正在跑的运行：自动让成员接着做。同一条线连续被打断超过这么多次就停下，交给群主
// （大概率是这件事本身会把工作台弄崩，接着做只会再崩一次）
export const MAX_RESTART_RESUMES = 3;
// 同一条线（同一张任务卡，或同一个对话）连着这么多次没完成（出错、超时、被系统拦下）就熔断：
// 不再自动重试，交给群主。不到这个数时自动再试，第 1、2 次分别等 1 分钟、5 分钟（网络抖一下、服务忙一下，过一会儿常常就好）。
export const MAX_FAILS = 3;
// 成员干活期间，它这张卡被别人推进了（这些事件）：它交回来的话可能已经过时
const STALE_EVENTS = { submitted: '提交了', review_passed: '审查通过了', review_failed: '审查没通过', approved: '验收通过了',
  rejected: '打回了', reopened: '重新打开了', reassigned: '改派了', cancelled: '取消了', revised: '撤回了提交' };
export const RETRY_WAIT_MIN = [1, 5];
// 成员报的错有时是接口原样返回的一整段 JSON（比如 {"type":"error","status":400,"error":{"message":"…"}}）：取出里面那句话
export function readableError(e) {
  const s = String(e ?? '').trim();
  if (!s) return '未知错误';
  const i = s.indexOf('{');
  if (i >= 0) {
    try {
      const o = JSON.parse(s.slice(i));
      const msg = o?.error?.message ?? o?.message ?? (typeof o?.error === 'string' ? o.error : null);
      const head = s.slice(0, i).trim();
      if (msg) return head ? `${head}${/[：:]$/.test(head) ? '' : ' '}${msg}` : msg;
    } catch { /* 不是 JSON，原样用 */ }
  }
  return s;
}
const RESTART_ERROR = '工作台重启时这次运行还没结束';

export class Dispatcher {
  // env: { adapters: {name: adapter}, status(): {name: {connected,...}}, appDir, onUsage(agent, info) }
  constructor(project, env) {
    this.p = project;
    this.db = project.db;
    this.env = env;
    this.active = new Map();     // 运行号 → { runId, agent, lane, handle, wakes, ... }（一位成员可以同时有几个）
    this.activity = {};          // 运行号 → 界面上显示的“正在做什么”
    this.cooling = {};           // agent → 额度用尽后的恢复时间戳
    this.retryAt = new Map();    // "成员|线" → { at, maxWake }：这条线没完成，等到 at 再自动重试（期间群主新发的消息不用等）
    this.retryWaitMs = env.retryWaitMs ?? null;      // 测试用：把重试前的等待改短
    this.tasks = new Tasks(project, {
      wake: (o) => this.wake(o),
      releaseWaiting: (taskId) => this.releaseWaiting(taskId),
      cancelWakes: (taskId, target) => this.cancelWakes(taskId, target),
      connected: () => this.connected(),
      stopLane: (agent, taskId, why) => this.stopLane(agent, taskId, why),
      cleanup: () => this.scheduleWtCleanup(),
    });
    // 改动快照：每次运行前后拍一次这次运行能写的目录（见 snapshots.mjs）。测试里可以关掉
    this.snap = env.snapshots === false ? null : new Snapshots(project);
    this.snapChain = new Map();   // 成员|线 → 这条线上最后一次拍快照的 Promise：同一条线的“之后”和下一次的“之前”按顺序拍
    // 每张卡一个 git 工作区（项目文件夹本身是 git 仓库时才用，见 worktrees.mjs）。测试里可以关掉
    this.wt = env.worktrees === false ? null : new Worktrees(project);
    this.tasks.wt = this.wt;
    try { this.wt?.repair(); } catch (e) { console.error('修复工作区路径出错：', e.message); }
    this.ensureQunWrappers();
    this.migrateSessions();
    this.recover();
    this.scheduleWtCleanup();
    this._stale = setInterval(() => { try { this.checkStale(); } catch (e) { console.error('检查停滞任务出错', e); } }, 60 * 1000);
    this._stale.unref();
    // 快照清理：启动一分钟后一次，之后每 6 小时一次
    this._pruneFirst = setTimeout(() => this.pruneSnapshots(), 60 * 1000); this._pruneFirst.unref();
    this._prune = setInterval(() => this.pruneSnapshots(), 6 * 3600 * 1000); this._prune.unref();
  }

  // 长时间没动静的任务：提醒群主一次（不自动唤醒成员，免得白耗额度）
  checkStale() {
    if (this.p.settings.paused) return;
    const limitMs = (this.p.settings.staleMin ?? 20) * 60 * 1000;
    for (const t of this.tasks.list()) {
      if (!['dispatched', 'accepted', 'working', 'in_review'].includes(t.state)) continue;
      if (now() - t.updatedTs < limitMs) continue;
      if (this.tasks.children(t.id).some((k) => !['done', 'cancelled'].includes(k.state))) continue;   // 在等子任务，不算停滞
      const who = t.state === 'in_review' ? t.reviewer : t.owner;
      if (this.isBusy(who)) continue;
      const pending = one(this.db, "SELECT COUNT(*) AS n FROM wakes WHERE task_id=? AND state IN ('queued','waiting','delivered','accepted','held')", t.id).n;
      if (pending) continue;
      const key = `stale:${t.id}:${t.revision}`;
      if (this.p.getMeta(key)) continue;
      this.p.setMeta(key, '1');
      this.p.post({
        sender: '系统', kind: 'system', taskId: t.id, chainId: t.chainId,
        text: `任务 ${t.id}「${t.title}」已经 ${Math.round((now() - t.updatedTs) / 60000)} 分钟没有动静，@${who} 现在没有在运行，也没有排队的唤醒。@群主 可以 @ 它催一下、改派，或者取消。`,
        meta: { mentions: [OWNER] },
      });
    }
  }

  connected() { const st = this.env.status(); return AGENTS.filter((a) => st[a]?.connected); }

  // 每个成员一个 qun 包装脚本，成员不用自己报名字。
  // 真正认身份靠请求目录：每次运行一个 .workgroup/rpc/req/<运行号>/，沙箱只放开这一个，工作台按目录认人（见 rpc.mjs）。
  ensureQunWrappers() {
    for (const a of AGENTS) {
      const dir = path.join(this.p.dir, DIRS.internal, 'bin', a);
      fs.mkdirSync(dir, { recursive: true });
      const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;   // 路径里有空格、引号也不会出错
      const script = `#!/bin/sh\nexec ${q(process.execPath)} --no-warnings ${q(path.join(this.env.appDir, 'bin', 'qun.mjs'))} --project ${q(this.p.dir)} --agent ${a} "$@"\n`;
      const file = path.join(dir, 'qun');
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== script) fs.writeFileSync(file, script, { mode: 0o755 });
      // git 推送时找的“远端小程序”：名字独一份，PATH 顺序被成员的登录 shell 打乱也找得到
      const helper = `#!/bin/sh\necho ${q(NO_PUSH_MSG)} >&2\nexit 1\n`;
      const hf = path.join(dir, `git-remote-${NO_PUSH}`);
      if (!fs.existsSync(hf) || fs.readFileSync(hf, 'utf8') !== helper) fs.writeFileSync(hf, helper, { mode: 0o755 });
    }
    const cfg = noPushGitConfig();
    if (!fs.existsSync(this.gitConfigPath()) || fs.readFileSync(this.gitConfigPath(), 'utf8') !== cfg) fs.writeFileSync(this.gitConfigPath(), cfg);
  }
  gitConfigPath() { return path.join(this.p.dir, DIRS.internal, 'bin', 'gitconfig'); }
  // 成员进程的额外环境变量：这次运行的编号（qun 用），加上不能推送的 git 配置
  memberEnv(runId) { return { QUN_RUN: runId, GIT_CONFIG_GLOBAL: this.gitConfigPath() }; }
  qunDir(agent) { return path.join(this.p.dir, DIRS.internal, 'bin', agent); }

  // 工作台重启：把上次没跑完的运行标成“中断”，自动让成员接着做（唤醒单放回队列，下一次运行的提示里写清打断前做到哪）。
  // 同一条线连续被重启打断超过 MAX_RESTART_RESUMES 次就不再自动接着做：唤醒单标成失败，任务卡标成卡住，交给群主。
  recover() {
    const stale = all(this.db, "SELECT id, agent, pid, lane, kind, task_id FROM runs WHERE status='running'");
    const afters = [];
    for (const r of stale) {
      this.killOrphan(r.pid);
      run(this.db, 'UPDATE runs SET status=?, ended_ts=?, error=? WHERE id=?', 'interrupted', now(), RESTART_ERROR, r.id);
      if (r.kind === 'summary') continue;      // 整理群摘要的运行没有唤醒单，下次到点再整理
      const lane = r.lane ?? 'main';
      afters.push(this.snapAfter(r.id, r.agent, lane));      // 被打断的运行也补拍“之后”：改了什么照样看得到、撤得回，接着做时也告诉成员
      const n = this.restartStreak(r.agent, lane);
      const t = r.task_id ? this.tasks.get(r.task_id) : null;
      const chainId = one(this.db, 'SELECT chain_id FROM wakes WHERE run_id=? AND chain_id IS NOT NULL LIMIT 1', r.id)?.chain_id ?? t?.chainId ?? null;
      if (n > MAX_RESTART_RESUMES) {
        const why = `连续 ${n} 次在干活时被工作台重启打断`;
        run(this.db, "UPDATE wakes SET state='failed', note=?, done_ts=? WHERE run_id=? AND state IN ('delivered','accepted','queued')", why, now(), r.id);
        this.blockTask(t, r.agent, why);
        this.p.post({
          sender: '系统', kind: 'system', chainId, taskId: t?.id ?? null,
          text: `@${r.agent} 在${this.laneOn(lane)}${why}，工作台不再自动让它接着做，免得再崩一次。@群主 可以点“重试”让它再试，或改派。`,
          meta: { failedRun: r.id, mentions: [OWNER] },
        });
      } else {
        run(this.db, "UPDATE wakes SET state='queued', note=?, run_id=NULL WHERE run_id=? AND state IN ('delivered','accepted','queued')", `工作台重启后接着做（第 ${n} 次）`, r.id);
        this.p.post({
          sender: '系统', kind: 'system', chainId, taskId: t?.id ?? null,
          text: `工作台重启时 @${r.agent} 正在${this.laneOn(lane)}干活，已自动让它接着做（第 ${n} 次，最多 ${MAX_RESTART_RESUMES} 次），会先确认打断前的那一步有没有生效。`,
        });
      }
    }
    // 等被打断的运行补拍完“之后”再开始派活：接着做的提示里要写它打断前改了哪些文件
    if (afters.length) this.recovering = Promise.allSettled(afters).then(() => { this.recovering = null; this.kick(); });
  }
  // 停下来交给群主：这位成员是这张卡的负责人、卡还在做，就标成“卡住”（不叫协调员来接，免得它又把活派回来）
  blockTask(t, agent, why) {
    if (!t || t.owner !== agent || !['dispatched', 'accepted', 'working', 'rejected'].includes(t.state)) return;
    try { this.tasks.block(t.id, '系统', `${why}，已停下等群主处理`, { notifyCreator: false }); } catch { /* 状态不允许就只发群消息 */ }
  }
  // 这条线最近连着几次“没完成”：出错、超时，或者有操作被系统拦下。
  // 跑完了（没被拦）就重新计数；被重启打断、群主停止、被叫停、额度用尽的不算，也不打断计数。
  failStreak(agent, lane) {
    const rows = all(this.db, `SELECT status, denied FROM runs WHERE agent=? AND COALESCE(lane,'main')=? AND COALESCE(kind,'work')='work'
      AND status NOT IN ('running','interrupted','stopped','superseded','quota') ORDER BY started_ts DESC LIMIT 50`, agent, lane);
    let n = 0;
    for (const r of rows) { if (['error', 'timeout'].includes(r.status) || r.denied > 0) n++; else break; }
    return n;
  }
  // 这条线过 ms 毫秒再自动重试。这期间群主新发来的消息不用等，会和重试一起送过去。
  retryLater(agent, lane, ms) {
    const maxWake = one(this.db, 'SELECT MAX(id) AS m FROM wakes')?.m ?? 0;
    this.retryAt.set(`${agent}|${lane}`, { at: now() + ms, maxWake });
    setTimeout(() => this.kick(), ms + 50).unref();
  }
  // 这条线最近连着几次运行是被工作台重启打断的
  restartStreak(agent, lane) {
    const rows = all(this.db, "SELECT status, error FROM runs WHERE agent=? AND COALESCE(lane,'main')=? AND COALESCE(kind,'work')='work' ORDER BY started_ts DESC LIMIT ?", agent, lane, MAX_RESTART_RESUMES + 2);
    let n = 0;
    for (const r of rows) { if (r.status === 'interrupted' && r.error === RESTART_ERROR) n++; else break; }
    return n;
  }

  // 工作台上次是异常退出的话，它启动的成员进程可能还活着。确认是我们启动的那种进程后，整组结束掉，
  // 否则重启后会有两个进程同时做同一件事。
  killOrphan(pid) {
    if (!pid) return;
    try {
      const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-g', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString();
      if (!/codex|claude|DeepSeek Harness|dsh/i.test(cmd)) return;
      process.kill(-pid, 'SIGTERM');
      setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* 已退出 */ } }, 4000).unref();
    } catch { /* 进程已经不在了 */ }
  }

  // ---- 唤醒单 ---------------------------------------------------------
  wake({ target, reason, taskId = null, sourceMsg = null, dedupeKey, chainId = null, byAgent = false, waiting = false, note = '' }) {
    if (!AGENTS.includes(target)) return { created: false };
    if (one(this.db, 'SELECT id FROM wakes WHERE target=? AND dedupe_key=?', target, dedupeKey)) return { created: false, duplicate: true };
    let state = waiting ? 'waiting' : 'queued';
    if (byAgent && chainId != null) {
      const used = one(this.db, "SELECT COUNT(*) AS n FROM wakes WHERE chain_id=? AND by_agent=1 AND state NOT IN ('cancelled','held')", chainId).n;
      const allow = this.p.settings.hopLimit + Number(this.p.getMeta(`chain_extra:${chainId}`, '0'));
      if (used >= allow) { state = 'held'; this.noticeHold(chainId, allow); }
    }
    const r = run(this.db,
      `INSERT INTO wakes(ts,target,reason,source_msg,task_id,dedupe_key,chain_id,by_agent,state,note) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      now(), target, reason, sourceMsg, taskId, dedupeKey, chainId, byAgent ? 1 : 0, state, note);
    this.p.sync();
    if (state === 'queued') this.kick();
    return { created: true, id: Number(r.lastInsertRowid), state };
  }

  noticeHold(chainId, allow) {
    const key = `hold_notice:${chainId}:${allow}`;
    if (this.p.getMeta(key)) return;
    this.p.setMeta(key, '1');
    this.p.post({
      sender: '系统', kind: 'system', chainId,
      text: `这条需求里成员之间的自动交接已达到上限（${allow} 次），为了不白白消耗额度，后面的唤醒先拦下了。@群主 请决定：放行继续、改派，或者到此为止。`,
      meta: { hold: chainId, mentions: [OWNER] },
    });
  }
  releaseHold(chainId, extra = 6) {
    const cur = Number(this.p.getMeta(`chain_extra:${chainId}`, '0'));
    this.p.setMeta(`chain_extra:${chainId}`, String(cur + extra));
    run(this.db, "UPDATE wakes SET state='queued' WHERE chain_id=? AND state='held'", chainId);
    this.p.system(`群主放行：这条需求可以再自动交接 ${extra} 次。`, { chainId });
    this.kick();
  }
  releaseWaiting(taskId) {
    const r = run(this.db, "UPDATE wakes SET state='queued', note='前置任务已完成' WHERE task_id=? AND state='waiting'", taskId);
    if (r.changes) { this.p.sync(); this.kick(); }
  }
  cancelWakes(taskId, target) {
    if (target) run(this.db, "UPDATE wakes SET state='cancelled' WHERE task_id=? AND target=? AND state IN ('queued','waiting','held')", taskId, target);
    else run(this.db, "UPDATE wakes SET state='cancelled' WHERE task_id=? AND state IN ('queued','waiting','held')", taskId);
    this.p.sync();
  }
  retryFailed(wakeId) {
    const w = one(this.db, 'SELECT * FROM wakes WHERE id=?', wakeId);
    if (w) this.retryAt.delete(`${w.target}|${this.laneOf(w.target, w)}`);
    run(this.db, "UPDATE wakes SET state='queued', note='群主重试', run_id=NULL WHERE id=? AND state IN ('failed','cancelled')", wakeId);
    this.p.sync();
    this.kick();
  }

  // ---- 群消息里的 @ ----------------------------------------------------
  routeMentions(msg, { byAgent }) {
    const st = this.env.status();
    for (const name of msg.mentions) {
      if (name === OWNER || name === msg.sender) continue;
      if (!st[name]?.connected) {
        this.p.system(`@${name} 未连接，#${msg.id} 这条消息没有送达。${st[name]?.fix ? '接通方法：' + st[name].fix : ''}`, { chainId: msg.chainId });
        continue;
      }
      // 同一个人 10 分钟内对同一个成员说一模一样的话，不重复派发
      const twin = one(this.db,
        `SELECT m.id FROM messages m JOIN wakes w ON w.source_msg=m.id AND w.target=?
         WHERE m.sender=? AND m.text=? AND m.id<>? AND m.ts>? LIMIT 1`,
        name, msg.sender, msg.text, msg.id, now() - 10 * 60 * 1000);
      if (twin) {
        this.p.system(`#${msg.id} 和 #${twin.id} 内容相同，没有重复唤醒 @${name}。`, { chainId: msg.chainId });
        continue;
      }
      // 成员提交或审查后，系统已经为这张任务卡通知过对方；它在回复里再 @ 一次就不重复唤醒了
      if (byAgent && msg.taskId) {
        const already = one(this.db,
          "SELECT id FROM wakes WHERE target=? AND task_id=? AND reason<>'mention' AND state IN ('queued','waiting','delivered','accepted') LIMIT 1",
          name, msg.taskId);
        if (already) continue;
      }
      this.wake({ target: name, reason: 'mention', sourceMsg: msg.id, taskId: msg.taskId, dedupeKey: `msg:${msg.id}`, chainId: msg.chainId, byAgent });
    }
  }

  // 群主说话。没点名时由协调员接。asTask：把这句话建成任务卡，被点名的人就是负责人。
  // taskId：这句话是冲着哪张任务卡说的（回复某张卡的消息时自动带上）。带上之后，消息会送到正在做这张卡的那个会话。
  // chatId：接着哪个已有的对话说（对话 = 一条需求链）。不给就是开一个新对话；回复某条消息时跟着那条消息所在的对话走。
  // review：这张新任务卡要不要另一位成员审查（默认要）。
  ownerSay({ text, replyTo = null, files = [], asTask = true, taskId = null, chatId = null, review = true }) {
    if (!taskId && replyTo) taskId = this.p.message(replyTo)?.taskId ?? null;
    if (taskId && !this.tasks.get(taskId)) taskId = null;
    if (taskId) asTask = false;        // 跟进已有的任务卡，不再另建一张
    if (chatId != null && !this.p.isChat(chatId)) chatId = null;      // 没有这个对话：当成新对话
    if (taskId && chatId == null) chatId = this.tasks.get(taskId)?.chainId ?? null;   // 跟进任务卡：留在这张卡所在的对话里
    const msg = this.p.post({ sender: OWNER, text, replyTo, files, taskId, chainId: chatId });
    const st = this.env.status();
    let targets = msg.mentions.filter((n) => AGENTS.includes(n));
    if (!targets.length) {
      targets = [COORDINATOR];
      msg.mentions = [COORDINATOR];
    }
    if (asTask) {
      const owner = targets[0];
      if (!st[owner]?.connected) {
        this.p.system(`@${owner} 未连接，没法接这个任务。${st[owner]?.fix ? '接通方法：' + st[owner].fix : ''}`, { chainId: msg.chainId });
      } else {
        const title = clip(text.replace(/[@＠][A-Za-z一-龥]+\s*/g, '').replace(/\s+/g, ' ').trim() || '群主的需求', 40);
        try {
          this.tasks.create({ title, owner, creator: OWNER, deliver: '按群主这条消息的要求交付', accept: '群主验收', kind: owner === COORDINATOR ? '协调' : '实现', chainId: msg.chainId, originMsg: msg.id, noReview: review === false });
        } catch (e) {
          this.p.system(`没能建任务卡：${e.message}`, { chainId: msg.chainId });
        }
      }
      // 其余被点名的人只是被叫来帮忙
      this.routeMentions({ ...msg, mentions: targets.slice(1) }, { byAgent: false });
    } else {
      this.routeMentions({ ...msg, mentions: targets }, { byAgent: false });
    }
    return msg;
  }

  // ---- 运行 -----------------------------------------------------------
  // 并行：一位成员可以同时有几条“线”在跑，每条线一个真实会话。
  //   · 成员是某张任务卡的负责人或审查人 → 这张卡就是一条线（会话只管这张卡，上下文不混）
  //   · 不属于某张卡的 @ → 这个对话自己的日常对话线（c<对话号>）：每个对话各用各的会话，不会越攒越长；没有对话号的走 main 线
  // 同一条线上的事排队做（或插话）；不同的线并行，最多同时开 parallelLimit(agent) 条。
  runsOf(agent) { return [...this.active.values()].filter((c) => c.agent === agent); }
  laneRun(agent, lane) { return this.runsOf(agent).find((c) => c.lane === lane) ?? null; }
  isBusy(agent) { return this.runsOf(agent).length > 0; }
  parallelLimit(agent) {
    const n = Number(this.p.settings.parallel?.[agent] ?? DEFAULT_PARALLEL[agent] ?? 1);
    return Math.max(1, Math.min(MAX_PARALLEL, Number.isFinite(n) ? Math.round(n) : 1));
  }
  laneOf(agent, w) {
    const chat = w.chain_id != null ? `c${w.chain_id}` : 'main';
    const t = w.task_id ? this.tasks.get(w.task_id) : null;
    if (!t) return chat;
    if (t.owner === agent) return t.id;
    if (t.reviewer === agent) {
      // 审查请求进这张卡的审查线。卡上的 @ 也进审查线，但只在审查已经开始之后（这条线有过会话）；
      // 审查还没开始就 @ 审查人，多半是找它商量别的事，按下面的规则走。
      const started = w.reason !== 'mention' || this.laneRun(agent, t.id) || one(this.db, 'SELECT 1 AS x FROM lanes WHERE agent=? AND lane=?', agent, t.id);
      if (started) return t.id;
    }
    // 别人的任务卡里 @ 到我：如果我负责它上面的某一级任务（这件事是我在协调），就进那张卡的线
    for (let p = t.parent ? this.tasks.get(t.parent) : null; p; p = p.parent ? this.tasks.get(p.parent) : null) {
      if (p.owner === agent) return p.id;
    }
    return chat;
  }
  laneLabel(lane) { return isChatLane(lane) ? '日常对话' : lane === SUMMARY_LANE ? '群摘要' : `任务 ${lane}`; }
  laneOn(lane) { const l = this.laneLabel(lane); return /[A-Za-z0-9]$/.test(l) ? `${l} 上` : `${l}上`; }      // “任务 T1 上”“日常对话上”

  // ---- 写入边界 ---------------------------------------------------------
  // 这个会话在项目文件夹里能写哪些目录（相对路径）。除此之外，项目里的一切对它都是只读的。
  //   · 自己的草稿目录：总是可写
  //   · 负责人：这张卡的写入范围——但提交之后就锁定，要改先撤回（qun task revise）
  //   · 审查人：只能写审查记录目录，改不了被审查的成果
  writableDirs(agent, lane) {
    if (lane === SUMMARY_LANE) return [`${DIRS.members}/${agent}/摘要/`];      // 写摘要不需要写文件，给个空的草稿目录就够了
    // 草稿目录：main 线是 成员/<谁>/日常/，每个对话的线是 成员/<谁>/对话<号>/，任务卡的线是 成员/<谁>/<任务卡号>/。互不包含，两个会话写不到一起
    const chatNo = CHAT_LANE.exec(lane)?.[1];
    const dirs = [`${DIRS.members}/${agent}/${lane === 'main' ? MAIN_DRAFT : chatNo ? `对话${chatNo}` : lane}/`];
    const t = isChatLane(lane) ? null : this.tasks.get(lane);
    // 负责人还能写这张卡的 git 工作区（有的话），同样是提交之后锁定
    if (t && t.owner === agent) { if (!t.frozen) dirs.push(...t.scope, ...(t.wt?.live ? [t.wt.dir] : [])); }
    else if (t && t.reviewer === agent) dirs.push(this.tasks.reviewDir(t.id));
    return dirs;
  }
  // 为一次运行准备好边界：建目录、生成沙箱规则。返回给成员接入层用的参数。
  prepareBoundary(agent, lane, runId) {
    const dirs = this.writableDirs(agent, lane);
    for (const d of dirs) fs.mkdirSync(path.join(this.p.dir, d), { recursive: true });
    // qun 的请求目录：每次运行单独一个，沙箱只放开它。工作台按目录认是谁在说话，不信请求里自报的名字
    const rpcReq = rpcRunDir(this.p.dir, runId);
    fs.mkdirSync(rpcReq, { recursive: true });
    const writableAbs = [...dirs.map((d) => path.join(this.p.dir, d)), rpcReq];
    const status = this.env.boundary?.() ?? sandboxStatus();
    let profile = null;
    if (status.ok) {
      const dir = path.join(this.p.dir, DIRS.internal, 'sandbox');
      fs.mkdirSync(dir, { recursive: true });
      profile = path.join(dir, `${runId}.sb`);
      fs.writeFileSync(profile, seatbeltProfile(this.p.dir, writableAbs, { denyPorts: this.env.port ? [this.env.port] : [] }));
    }
    return { dirs, writableAbs, profile, draftAbs: dirs.length ? path.join(this.p.dir, dirs[0]) : this.p.dir, enforced: status.ok };
  }
  // 这条线上的会话是不是该换新的了：看它接着用了多少次、上一次运行重读了多少内容。
  // 按量付费的成员（DeepSeek）每一步自带的固定内容就很大，token 数说明不了会话长短，所以只看次数。
  shouldRotate(agent, lane, session) {
    const rows = all(this.db, "SELECT usage FROM runs WHERE agent=? AND COALESCE(lane,'main')=? AND session_id=? AND COALESCE(kind,'work')='work' ORDER BY started_ts DESC LIMIT ?", agent, lane, session.session_id, ROTATE_RUNS + 1);
    if (!rows.length) return false;
    const chat = isChatLane(lane);
    if (chat && rows.length >= ROTATE_RUNS) return true;
    if (MEMBERS[agent]?.payPerUse) return false;
    const u = J(rows[0].usage, {});
    const load = (u.input ?? 0) + ((u.cached ?? 0) > (u.input ?? 0) ? u.cached : 0);      // 有的成员把缓存命中另算，有的算在输入里
    return load > (chat ? ROTATE_CHAT_TOKENS : ROTATE_TASK_TOKENS);
  }
  // 停掉某位成员在某张卡上正在跑的会话（比如负责人撤回了提交、任务改派了）
  stopLane(agent, taskId, why) {
    const ctx = this.laneRun(agent, taskId);
    if (!ctx) return false;
    ctx.stopWhy = why;
    this.stopCtx(ctx, 'superseded');
    return true;
  }

  // 旧版每位成员只有一个会话。升级时把它挂到这位成员还没做完的那张任务卡上（没有就挂到 main），不丢上下文。
  migrateSessions() {
    const legacy = all(this.db, 'SELECT * FROM sessions');
    for (const s of legacy) {
      if (!one(this.db, 'SELECT 1 AS x FROM lanes WHERE agent=?', s.agent)) {
        const open = this.tasks.list()
          .filter((t) => t.owner === s.agent && !['done', 'cancelled'].includes(t.state))
          .sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0) || b.seq - a.seq)[0];
        run(this.db, 'INSERT OR IGNORE INTO lanes(agent,lane,session_id,model,updated_ts) VALUES(?,?,?,?,?)',
          s.agent, open?.id ?? 'main', s.session_id, s.model, s.updated_ts);
      }
    }
    if (legacy.length) run(this.db, 'DELETE FROM sessions');
  }

  kick() { if (this.disposed) return; clearTimeout(this._kick); this._kick = setTimeout(() => this.pump(), 30); }

  // 项目要关掉了：不再调度，定时器全部停掉
  dispose() { this.disposed = true; clearTimeout(this._actSoon); clearTimeout(this._kick); clearInterval(this._stale); clearTimeout(this._pruneFirst); clearInterval(this._prune); clearTimeout(this._wtClean); }

  pump() {
    if (this.disposed || this.p.settings.paused || this.recovering) return;
    const st = this.env.status();
    for (const agent of AGENTS) {
      const queued = all(this.db, "SELECT * FROM wakes WHERE target=? AND state='queued' AND run_id IS NULL ORDER BY id", agent);
      if (!queued.length) continue;
      const usable = st[agent]?.connected && !this.p.settings.pausedAgents?.includes(agent) && !((this.cooling[agent] ?? 0) > now());
      const byLane = new Map();
      for (const w of queued) { const lane = this.laneOf(agent, w); if (!byLane.has(lane)) byLane.set(lane, []); byLane.get(lane).push(w); }
      let changed = false;
      for (const [lane, wakes] of byLane) {
        const ctx = this.laneRun(agent, lane);
        if (ctx) { changed = this.tryInject(ctx, wakes) || changed; continue; }
        const wait = this.retryAt.get(`${agent}|${lane}`);
        if (wait && wait.at > now() && !wakes.some((w) => !w.by_agent && w.id > wait.maxWake)) continue;
        if (!usable) continue;
        const limit = this.parallelLimit(agent);
        if (this.runsOf(agent).length >= limit) {
          const note = limit > 1 ? `@${agent} 的 ${limit} 个并行会话都在忙，排队中` : `@${agent} 正在干活，等它这一步结束后送达`;
          for (const w of wakes) if (w.note !== note) { run(this.db, 'UPDATE wakes SET note=? WHERE id=?', note, w.id); changed = true; }
          continue;
        }
        this.startRun(agent, lane, wakes);
      }
      if (changed) this.p.sync();
    }
    this.maybeAutoSummarize();
  }

  // 运行中插话：这条线正在跑的时候，群里 @ 它的消息直接写进它正在进行的会话。
  // 只插“消息”（reason=mention）；同一条线上要另起一步的事（返工、汇总等），等它这一步结束后再送。
  tryInject(ctx, wakes) {
    const { agent } = ctx;
    let changed = false;
    for (const w of wakes) {
      const canInject = ctx.kind !== 'summary' && w.reason === 'mention' && typeof ctx.handle?.inject === 'function';
      if (canInject) {
        const text = buildInjectPrompt({ agent, project: this.p, tasks: this.tasks, wake: w, currentTaskId: ctx.taskId });
        if (ctx.handle.inject(text, w.id)) {
          ctx.injected.set(w.id, false);
          run(this.db, 'UPDATE wakes SET run_id=?, note=? WHERE id=?', ctx.runId, `已写入 @${agent} 正在进行的会话，等它读到`, w.id);
          try { fs.appendFileSync(ctx.logPath, JSON.stringify({ t: now(), kind: 'inject', line: text }) + '\n'); } catch { /* 日志写不了不影响插话 */ }
          changed = true;
          continue;
        }
      }
      const note = `@${agent} 正在干活，等它这一步结束后送达`;
      if (w.note !== note) { run(this.db, 'UPDATE wakes SET note=? WHERE id=?', note, w.id); changed = true; }
    }
    return changed;
  }

  startRun(agent, lane, wakes) {
    const adapter = this.env.adapters[agent];
    const runId = 'R' + now().toString(36) + crypto.randomBytes(2).toString('hex');
    // 任务卡的负责人第一次干活：项目是 git 仓库的话，先给这张卡建好工作区
    const laneCard = isChatLane(lane) || lane === SUMMARY_LANE ? null : this.tasks.get(lane);
    if (laneCard) this.prepareWorktree(agent, laneCard);
    let session = one(this.db, 'SELECT * FROM lanes WHERE agent=? AND lane=?', agent, lane);
    // 会话太长了就换一个新的（新会话会重新拿到群规、群摘要和这个对话最近的消息）
    const rotated = !!session && this.shouldRotate(agent, lane, session);
    if (rotated) { run(this.db, 'DELETE FROM lanes WHERE agent=? AND lane=?', agent, lane); session = null; }
    const lastRun = one(this.db, "SELECT id, status, started_ts, last_cmd, error FROM runs WHERE agent=? AND COALESCE(lane,'main')=? AND COALESCE(kind,'work')='work' ORDER BY started_ts DESC LIMIT 1", agent, lane);
    const interrupted = !!session && ['interrupted', 'timeout', 'stopped'].includes(lastRun?.status);
    // 是被工作台重启打断的：把打断前做到哪一步告诉它（正在跑的命令、已经改的文件、已经说过的话），让它先确认再接着做
    let resumeInfo = null;
    if (interrupted && lastRun.status === 'interrupted' && lastRun.error === RESTART_ERROR) {
      const snap = this.snap?.row(lastRun.id);
      resumeInfo = {
        n: this.restartStreak(agent, lane),
        lastCmd: lastRun.last_cmd ?? null,
        files: snap?.post ? J(snap.files, []) : null,
        said: all(this.db, "SELECT text FROM messages WHERE run_id=? AND kind='chat' ORDER BY id", lastRun.id).map((m) => m.text),
      };
    }

    // 上一次出错或超时、这次是自动重试（或群主点的重试）：告诉它上次为什么没完成、当时在跑什么
    this.retryAt.delete(`${agent}|${lane}`);
    let retryInfo = null;
    if (['error', 'timeout'].includes(lastRun?.status)) {
      retryInfo = {
        n: this.failStreak(agent, lane), max: MAX_FAILS, lastCmd: lastRun.last_cmd ?? null,
        why: lastRun.status === 'timeout' ? `超过 ${this.p.settings.runTimeoutMin} 分钟没做完，被自动停止` : readableError(lastRun.error),
      };
    }

    // 选模型：按这批唤醒里最要紧的那个任务来定
    const primary = wakes.find((w) => w.task_id) ?? wakes[0];
    const task = primary.task_id ? this.tasks.get(primary.task_id) : null;
    const chainId = primary.chain_id ?? wakes.find((w) => w.chain_id != null)?.chain_id ?? null;      // 这次运行属于哪个对话
    // “打回升一档”只对这张任务卡的负责人生效；被 @ 来帮忙的人、审查人按各自的档位选
    const isOwner = !!task && task.owner === agent;
    // 不属于任何任务卡的对话（问一句、说一声）按“闲聊”那一档选，默认是快速档
    const reasonKind = primary.reason === 'review_request' ? 'review_request'
      : !task ? 'chat'
      : (agent === COORDINATOR && (!isOwner || task.creator === OWNER || primary.reason === 'children_done')) ? 'coordinate' : 'task';
    // 而且只在“这次就是来返工的”时候升；之后在这张卡上的普通跟进不升
    const reworkRun = wakes.some((w) => ['review_failed', 'owner_rejected'].includes(w.reason));
    const pick = pickModel({
      agent, task: isOwner ? (reworkRun ? task : { ...task, rework: 0 }) : null, settings: this.p.settings, reason: reasonKind,
      highTierLow: !!this.env.highTierLow?.(agent),
    });

    const boundary = this.prepareBoundary(agent, lane, runId);
    // 这张卡有 git 工作区：命令从工作区启动。Codex 的自带沙箱总是让工作目录可写，所以它只有能写工作区时才从那里启动
    const wtCard = laneCard ? this.tasks.get(lane)?.wt : null;
    const wtLive = wtCard?.live ? wtCard : null;
    const wtWritable = !!wtLive && boundary.dirs.includes(wtLive.dir);
    const cwdAbs = wtLive && (!adapter.ownSandbox || wtWritable) ? wtLive.abs : null;
    boundary.cwdAbs = cwdAbs;
    const cwdIsDraft = !!adapter.ownSandbox && !cwdAbs;      // Codex 用自带沙箱：工作目录是草稿目录，不是项目根
    const prompt = buildPrompt({
      agent, project: this.p, tasks: this.tasks, wakes, connected: this.connected(),
      resumed: !!session, qunPath: path.join(this.qunDir(agent), 'qun'), interrupted,
      summary: session ? null : this.summaryInfo(), lane, parallel: this.parallelLimit(agent),
      writable: boundary.dirs, enforced: boundary.enforced || !!adapter.ownSandbox, cwdIsDraft,
      wt: wtLive ? { ...wtLive, writable: wtWritable, cwd: !!cwdAbs } : null,
      chainId, sinceTs: session ? lastRun?.started_ts ?? null : null, rotated, resumeInfo, retryInfo,
    });
    const logPath = path.join(this.p.dir, DIRS.internal, 'runs', `${runId}.jsonl`);
    fs.writeFileSync(logPath, JSON.stringify({ t: now(), kind: 'prompt', line: prompt }) + '\n');

    const taskId = task?.id ?? (isChatLane(lane) ? null : lane);
    run(this.db,
      `INSERT INTO runs(id,agent,started_ts,status,model,model_by,effort,session_id,resumed,wake_ids,task_id,log_path,kind,lane)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'work',?)`,
      runId, agent, now(), 'running', pick.model, pick.by, pick.effort ?? null, session?.session_id ?? null, session ? 1 : 0,
      JSON.stringify(wakes.map((w) => w.id)), taskId, logPath, lane);
    for (const w of wakes) run(this.db, 'UPDATE wakes SET run_id=? WHERE id=?', runId, w.id);

    const ctx = { runId, agent, lane, kind: 'work', wakes, chainId, taskId, startedTs: now(), said: [], injected: new Map(), logPath, profile: boundary.profile, denied: [], deniedN: 0 };
    // 开跑时这张卡的进展到哪了（之后别人再推进，它交回来的话就标成“已过时”）
    ctx.cardEv = taskId ? (one(this.db, 'SELECT MAX(id) AS m FROM task_events WHERE task_id=?', taskId)?.m ?? 0) : null;
    this.activity[runId] = { runId, agent, lane, startedTs: ctx.startedTs, model: pick.model, effort: pick.effort ?? null, modelBy: pick.by, level: pick.level, taskId, text: '正在启动会话…', kind: 'boot', writable: boundary.dirs };
    this.p.sync();

    const on = {
      ...this.commonCallbacks(ctx),
      session: (sid, info) => {
        if (info?.model) { if (this.activity[runId]) this.activity[runId].model = info.model; run(this.db, 'UPDATE runs SET model=? WHERE id=?', info.model, runId); }
        if (!sid) return;
        run(this.db, `INSERT INTO lanes(agent,lane,session_id,model,updated_ts) VALUES(?,?,?,?,?)
                      ON CONFLICT(agent,lane) DO UPDATE SET session_id=excluded.session_id, model=excluded.model, updated_ts=excluded.updated_ts`,
          agent, lane, sid, info?.model ?? pick.model, now());
        run(this.db, 'UPDATE runs SET session_id=? WHERE id=?', sid, runId);
        // 开头就带着的那批唤醒单：真实会话已启动 → 已送达
        const ids = wakes.map((w) => w.id);
        const r = run(this.db, `UPDATE wakes SET state='delivered', delivered_ts=? WHERE run_id=? AND state='queued' AND id IN (${ids.map(() => '?').join(',')})`, now(), runId, ...ids);
        if (r.changes) { if (this.activity[runId]) this.activity[runId].text = '已送达，正在读需求…'; this.p.sync(); }
      },
      // 成员确认读到了一条插话
      injected: (wakeId) => {
        ctx.injected.set(wakeId, true);
        run(this.db, "UPDATE wakes SET state='delivered', delivered_ts=?, note=? WHERE id=? AND run_id=?", now(), `已送到正在干活的 @${agent}`, wakeId, runId);
        this.p.sync();
      },
      // 一次运行里出了不止一轮回复（后到的插话另起了一轮）：前面几轮的回复先发到群里
      reply: (text) => this.postReply(ctx, text),
      // 有操作被系统拦下（写到了不归它的位置）：记下来，运行结束时在群里说明被拦了什么
      denied: (line, what = null) => {
        ctx.deniedN++;
        const key = what ?? line;
        if (ctx.denied.length < 10 && !ctx.denied.some((d) => (d.what ?? d.line) === key)) ctx.denied.push({ line, what });
        try { fs.appendFileSync(ctx.logPath, JSON.stringify({ t: now(), kind: 'denied', line: what ? `${what} → ${line}` : line }) + '\n'); } catch { /* 日志写不了不影响 */ }
      },
      done: (res) => this.finishRun(ctx, res),
    };
    // 先登记再启动：这样启动过程中的回调（包括立刻失败）都能找到这次运行
    this.active.set(runId, ctx);
    ctx.dirs = boundary.dirs;
    const begin = () => {
      if (ctx.ended) return;
      if (ctx.stopReq) { this.finishRun(ctx, { status: ctx.stopReq, error: null, finalText: '' }); return; }      // 还没启动就被停了
      try {
        ctx.handle = adapter.start({
          cwd: cwdAbs ?? this.p.dir, prompt, sessionId: session?.session_id ?? null, model: pick.model, effort: pick.effort,
          // 工作区在项目文件夹里面：Claude 会把上层目录的 CLAUDE.md 也读进来，项目根上那份和工作区里的是同一份，跳过免得读两遍
          mdExcludes: cwdAbs ? ['CLAUDE.md', 'CLAUDE.local.md'].flatMap((f) => [...new Set([path.join(this.p.dir, f), path.join(realDir(this.p.dir), f)])]) : null,
          identity: identityText(agent, this.p), pathPrefix: this.qunDir(agent), logPath,
          timeoutMs: this.p.settings.runTimeoutMin * 60 * 1000, patchDir: path.join(this.p.dir, DIRS.internal),
          extraEnv: this.memberEnv(runId), sandbox: boundary, on,
        });
      } catch (e) {
        this.finishRun(ctx, { status: 'error', error: `启动失败：${e.message}`, finalText: '' });
        return;
      }
      if (ctx.handle?.pid) run(this.db, 'UPDATE runs SET pid=? WHERE id=?', ctx.handle.pid, runId);
    };
    // 先拍“之前”的快照再让成员动手（拍不成也照样开跑，只是这次看不到改动）
    if (this.snap) this.snapBefore(ctx, boundary.dirs).finally(begin);
    else begin();
  }

  // ---- 每张卡的 git 工作区 ---------------------------------------------------
  prepareWorktree(agent, t) {
    if (!this.wt || t.owner !== agent || ['done', 'cancelled'].includes(t.state) || t.wt?.live) return;
    const had = !!this.wt.rec(t.id);
    let r;
    try { r = this.wt.ensure(t, this.tasks); } catch (e) {
      const key = `wtfail:${t.id}`;
      if (!this.p.getMeta(key)) {
        this.p.setMeta(key, '1');
        this.p.system(`没能给任务 ${t.id} 建 git 工作区：${clip(e.message, 200)}。这次照旧在项目文件夹里做，只能写这张卡的写入范围。`, { taskId: t.id, chainId: t.chainId });
      }
      return;
    }
    // 第一次建：这条线上之前的会话是从别的目录启动的，接不上了，换新会话（重建的工作区路径不变，会话照常接着用）
    if (r && !had) run(this.db, 'DELETE FROM lanes WHERE lane=?', t.id);
  }
  // 结束了的卡：清理工作区。等这张卡上没有会话在跑、“之后”的快照也拍完了再清
  scheduleWtCleanup() {
    if (!this.wt || this.disposed) return;
    clearTimeout(this._wtClean);
    this._wtClean = setTimeout(() => this.cleanupWorktrees(), 300);
    this._wtClean.unref?.();
  }
  cleanupWorktrees() {
    if (!this.wt || this.disposed) return [];
    const busy = new Set([...this.active.values()].map((c) => c.lane));
    for (const k of this.snapChain.keys()) busy.add(k.slice(k.indexOf('|') + 1));
    let done = [];
    try { done = this.wt.cleanup(this.tasks, busy); } catch (e) { console.error('清理工作区出错：', e.message); }
    for (const d of done) {
      if (!d.kept) continue;
      const t = this.tasks.get(d.taskId);
      this.p.system(`任务 ${d.taskId} 已结束，它的工作区清理掉了。分支 ${d.branch} 上还有没合并进去的改动，留着没删，需要时可以在项目的 git 里找到它。`, { taskId: d.taskId, chainId: t?.chainId ?? null });
    }
    return done;
  }

  // ---- 改动快照 -----------------------------------------------------------
  snapRun(agent, lane, fn) {
    const key = `${agent}|${lane}`;
    const p = (this.snapChain.get(key) ?? Promise.resolve()).then(fn).catch((e) => { console.error('改动快照出错：', e.message); return null; });
    this.snapChain.set(key, p);
    p.finally(() => { if (this.snapChain.get(key) === p) { this.snapChain.delete(key); this.scheduleWtCleanup(); } });
    return p;
  }
  snapBefore(ctx, dirs) {
    return this.snapRun(ctx.agent, ctx.lane, () => this.snap.before({ runId: ctx.runId, agent: ctx.agent, taskId: ctx.taskId, dirs }));
  }
  snapAfter(runId, agent, lane) {
    if (!this.snap) return Promise.resolve(null);
    return this.snapRun(agent, lane, async () => {
      const files = await this.snap.after(runId);
      if (files?.length && !this.disposed) this.p.sync();
      return files;
    });
  }
  // 停一次运行：已经启动的发信号；还在拍快照、没启动的记下来，启动前直接收尾
  stopCtx(ctx, reason) {
    if (ctx.handle) ctx.handle.stop(reason);
    else ctx.stopReq = ctx.stopReq ?? reason;
  }
  pruneSnapshots() {
    if (!this.snap || this.disposed) return;
    if ([...this.active.values()].some((c) => c.kind === 'work')) return;      // 有会话在跑，下次再清
    const openTasks = new Set(this.tasks.list().filter((t) => !['done', 'cancelled'].includes(t.state)).map((t) => t.id));
    this.snap.prune({ openTasks }).catch((e) => console.error('清理改动快照出错：', e.message));
  }
  // 群主撤回一次运行的改动
  async rollbackRun(runId, by = OWNER) {
    if (!this.snap) throw new TaskError('改动快照没有开启');
    await this.snap.init();
    if (this.snap.off) throw new TaskError(this.snap.off);
    const busyDirs = [...this.active.values()].filter((c) => c.dirs && c.runId !== runId).flatMap((c) => c.dirs.map((dir) => ({ agent: c.agent, dir })));
    if (this.active.has(runId)) throw new TaskError('这次运行还没结束，结束后才能撤回');
    const snapRow = this.snap.row(runId);
    for (const d of J(snapRow?.dirs, [])) {
      const m = d.startsWith(WT_ROOT + '/') ? /^[^/]+\/[^/]+\/(T\d+)\//.exec(d) : null;
      if (m && !this.wt?.live(m[1])) throw new TaskError(`那次运行改的是任务 ${m[1]} 的工作区，这个工作区已经${this.wt?.rec(m[1])?.merged_commit ? '合并进项目、' : ''}清理掉了，没法在这里撤回。要撤销，请在项目的 git 里处理。`);
    }
    let out;
    try { out = await this.snap.rollback(runId, { by, busyDirs }); } catch (e) { throw new TaskError(e.message); }
    const r = one(this.db, 'SELECT agent, task_id FROM runs WHERE id=?', runId) ?? {};
    const chainId = one(this.db, 'SELECT chain_id FROM messages WHERE run_id=? AND chain_id IS NOT NULL ORDER BY id DESC LIMIT 1', runId)?.chain_id
      ?? (r.task_id ? this.tasks.get(r.task_id)?.chainId : null) ?? null;
    const names = out.files.slice(0, 6).map((f) => f.p.split('/').pop()).join('、') + (out.files.length > 6 ? ` 等` : '');
    const t = r.task_id ? this.tasks.get(r.task_id) : null;
    const notes = [];
    if (out.skipped.length) notes.push(`有 ${out.skipped.length} 个超过 5 MB 的大文件当时没拍快照，没有恢复`);
    if (t && ['in_review', 'awaiting_owner', 'done'].includes(t.state)) notes.push(`任务 ${t.id} 提交时的文件变了，审查和验收时会提示`);
    this.p.post({
      sender: '系统', kind: 'system', chainId, taskId: r.task_id ?? null,
      text: `${by}撤回了 @${r.agent ?? '成员'} 那次运行改的 ${out.files.length} 个文件（${names}），已恢复成那次运行之前的样子。${notes.length ? notes.join('；') + '。' : ''}`,
      meta: { rolledRun: runId },
    });
    this.p.sync();
    return { files: out.files.length };
  }

  // 工作运行和摘要运行共用的回调
  commonCallbacks(ctx) {
    const { agent, runId } = ctx;
    return {
      activity: (a) => {
        const act = this.activity[runId];
        if (!act) return;
        act.kind = a.kind; act.text = a.kind === 'say' ? tailText(a.text, LIVE_TAIL) : a.text; act.ts = now(); act.streaming = false;
        if (a.kind === 'say') ctx.streamText = '';          // 这段话写完了，运行记录里已经有整段
        this.firstOut(ctx);
        if (a.kind === 'cmd') run(this.db, 'UPDATE runs SET last_cmd=? WHERE id=?', a.text, runId);
        this.p.emit('activity');
      },
      // 逐字输出：成员正在写的一段话又多了几个字。同一段（key 相同）拼起来；推给界面时攒一下，最多每 150 毫秒一次
      stream: (delta, key) => {
        const act = this.activity[runId];
        if (!act || !delta) return;
        if (ctx.streamKey !== key) { ctx.streamKey = key; ctx.streamText = ''; }
        ctx.streamText = (ctx.streamText ?? '') + delta;
        if (ctx.streamText.length > LIVE_MAX) ctx.streamText = ctx.streamText.slice(-LIVE_MAX);
        act.kind = 'say'; act.streaming = true; act.text = tailText(ctx.streamText, LIVE_TAIL); act.ts = now();
        this.firstOut(ctx);
        this.emitActivitySoon();
      },
      rateLimit: (info) => this.env.onRateLimit?.(agent, info),
      pid: (pid) => { if (pid) run(this.db, 'UPDATE runs SET pid=? WHERE id=?', pid, runId); },
    };
  }

  firstOut(ctx) {
    if (ctx.firstOut) return;
    ctx.firstOut = now();
    run(this.db, 'UPDATE runs SET first_out_ts=? WHERE id=?', ctx.firstOut, ctx.runId);
  }
  emitActivitySoon() {
    if (this._actSoon) return;
    this._actSoon = setTimeout(() => { this._actSoon = null; if (!this.disposed) this.p.emit('activity'); }, 150);
  }
  // 正在进行的运行：成员这会儿正在写、还没写完的那段话（写完的段落在运行记录里）。不在运行就是 null
  liveText(runId) {
    const ctx = this.active.get(runId);
    return ctx ? (ctx.streamText ?? '') : null;
  }

  // 把成员的一段回复发到群里（和它中途 qun say 过的话一样就不重复）
  postReply(ctx, text) {
    const t = String(text ?? '').trim();
    if (!t || ctx.said.includes(t)) return;
    ctx.said.push(t);
    this.postMember(ctx, { sender: ctx.agent, text: t, runId: ctx.runId, chainId: ctx.chainId, taskId: ctx.taskId });
  }
  // 成员在一次运行里说的话（最后的回复、中途的回复、qun say）都从这里发。
  // 它干活期间这张卡被别人推进了：照样发到群里，但标成“已过时”，里面 @ 的成员先不叫醒，由群主决定要不要照样送出。
  postMember(ctx, fields) {
    const stale = this.staleInfo(ctx);
    const msg = this.p.post({ ...fields, meta: stale ? { ...(fields.meta ?? {}), stale } : (fields.meta ?? {}) });
    if (!stale) this.routeMentions(msg, { byAgent: true });
    return { ...msg, meta: stale ? { stale } : {} };
  }
  // 这次运行开跑之后，它这张卡被“别人”推进过没有（它自己这次运行做的提交、审查不算）。不调用模型，只查任务卡事件。
  staleInfo(ctx) {
    if (!ctx?.taskId || ctx.cardEv == null) return null;
    const types = Object.keys(STALE_EVENTS);
    const evs = all(this.db, `SELECT id, actor, type, text, data FROM task_events WHERE task_id=? AND id>? AND type IN (${types.map(() => '?').join(',')}) ORDER BY id`,
      ctx.taskId, ctx.cardEv, ...types).filter((e) => J(e.data, {}).run !== ctx.runId);
    if (!evs.length) return null;
    const who = (a) => (a === OWNER ? '群主' : a === '系统' ? '工作台' : `@${a} `);
    const parts = [...new Set(evs.map((e) => e.type === 'reassigned' ? `${who(e.actor)}${clip(e.text, 60)}` : `${who(e.actor)}${STALE_EVENTS[e.type]}`))].slice(-3);
    return { taskId: ctx.taskId, events: evs.map((e) => e.type), text: `它干活期间，任务 ${ctx.taskId} 有了新进展：${parts.join('；')}` };
  }
  // 群主看过“已过时”的那条消息，决定照样送出：里面 @ 的成员照常叫醒
  forwardStale(msgId) {
    const m = this.p.message(msgId);
    if (!m?.meta?.stale) throw new TaskError('这条消息没有标成已过时');
    if (m.meta.stale.forwarded) return { forwarded: false };
    const nm = this.p.patchMessageMeta(m.id, { stale: { ...m.meta.stale, forwarded: true } });
    this.routeMentions(nm, { byAgent: true });
    return { forwarded: true };
  }

  // qun 命令进来时调用：先认出是这位成员的哪个会话在说话，再记一笔“它真的收到并开始动作了”。
  // 认法：命令带来的运行号（QUN_RUN）→ 命令里提到的任务卡 → 这位成员唯一在跑的那个会话。
  noteQunCall(agent, runId = null, taskHint = null) {
    let ctx = runId ? this.active.get(runId) : null;
    if (ctx && ctx.agent !== agent) ctx = null;
    if (!ctx) {
      const mine = this.runsOf(agent).filter((c) => c.kind === 'work');
      ctx = (taskHint && mine.find((c) => c.lane === taskHint || c.taskId === taskHint)) || (mine.length === 1 ? mine[0] : mine.at(-1)) || null;
    }
    if (!ctx) return null;
    run(this.db, 'UPDATE runs SET qun_calls=qun_calls+1 WHERE id=?', ctx.runId);
    const ids = ctx.wakes.map((w) => w.id);
    const r = ids.length
      ? run(this.db, `UPDATE wakes SET state='accepted' WHERE run_id=? AND state IN ('queued','delivered') AND id IN (${ids.map(() => '?').join(',')})`, ctx.runId, ...ids)
      : { changes: 0 };
    const r2 = run(this.db, "UPDATE wakes SET state='accepted' WHERE run_id=? AND state='delivered'", ctx.runId);
    if (r.changes || r2.changes) this.p.sync();
    return ctx;
  }

  finishRun(ctx, res) {
    const { agent, runId } = ctx;
    if (ctx.ended) return;
    ctx.ended = true;
    this.active.delete(runId);
    // 这次运行的 qun 请求目录：留一会儿让最后一个请求处理完再删
    setTimeout(() => fs.rmSync(rpcRunDir(this.p.dir, runId), { recursive: true, force: true }), 5000).unref();
    delete this.activity[runId];
    const usage = res.usage ?? {};
    run(this.db, 'UPDATE runs SET status=?, ended_ts=?, usage=?, error=?, final_text=?, model=COALESCE(?, model), session_id=COALESCE(?, session_id), denied=? WHERE id=?',
      res.status, now(), JSON.stringify(usage), res.error ?? null, clip(res.finalText ?? '', 20000), res.model ?? null, res.sessionId ?? null, ctx.deniedN ?? 0, runId);
    // 连着几次没完成（出错、超时、被系统拦下）：不到 MAX_FAILS 次自动再试，到了就熔断，交给群主
    const missed = ['error', 'timeout'].includes(res.status) || (res.status === 'ok' && ctx.deniedN > 0);
    const streak = missed ? this.failStreak(agent, ctx.lane) : 0;
    this.env.onRunEnd?.(agent, { runId, status: res.status, usage, model: res.model });

    if (ctx.profile) fs.rm(ctx.profile, { force: true }, () => {});
    if (this.snap) this.snapAfter(runId, agent, ctx.lane);      // 拍“之后”，算出这次改了哪些文件（拍完界面会刷新）
    else this.scheduleWtCleanup();      // 卡结束了的话清理它的工作区（有快照时等“之后”拍完再清）
    // 写进去了但成员没读到的插话：不管这次运行怎么结束的，都放回队列，下次再送
    for (const [wakeId, acked] of ctx.injected) {
      if (!acked) run(this.db, "UPDATE wakes SET run_id=NULL, note='' WHERE id=? AND state='queued'", wakeId);
    }

    if (res.status === 'ok') {
      run(this.db, "UPDATE wakes SET state='done', done_ts=? WHERE run_id=?", now(), runId);
      this.postReply(ctx, res.finalText);      // 最后一段回复自动发到群里
      if (ctx.deniedN) this.noticeDenied(ctx, streak);
    } else if (res.status === 'quota') {
      // 额度用尽：保存进度，放回队列等恢复。不自动切到收费 API。
      run(this.db, "UPDATE wakes SET state='queued', note='额度用尽，等恢复后继续', run_id=NULL WHERE run_id=?", runId);
      const first = !((this.cooling[agent] ?? 0) > now());
      this.cooling[agent] = now() + 30 * 60 * 1000;
      if (first) {
        this.p.system(`@${agent} 的额度用尽了，进度已保存，30 分钟后自动再试（也可以改派给别的成员）。不会自动切换到收费 API。原始提示：${clip(res.error ?? '', 200)}`, { chainId: ctx.chainId });
        setTimeout(() => this.kick(), 30 * 60 * 1000 + 1000).unref();
      }
    } else if (res.status === 'superseded') {
      const why = ctx.stopWhy ?? '这次运行已经不需要了';
      run(this.db, "UPDATE wakes SET state='cancelled', note=?, done_ts=? WHERE run_id=?", why, now(), runId);
      this.p.system(`@${agent} 在${this.laneOn(ctx.lane)}的这次运行停下了：${why}。`, { chainId: ctx.chainId });
    } else if (res.status === 'stopped') {
      run(this.db, "UPDATE wakes SET state='cancelled', note='群主停止了这次运行', done_ts=? WHERE run_id=?", now(), runId);
      this.p.system(`群主停止了 @${agent} 的这次运行（${this.laneLabel(ctx.lane)}）。`, { chainId: ctx.chainId });
    } else {
      const why = res.status === 'timeout' ? `超过 ${this.p.settings.runTimeoutMin} 分钟被自动停止` : clip(readableError(res.error), 300);
      // 会话号失效（比如被清理了）：丢掉这条线的会话号，从头开一次
      const lostSession = ctx.wakes.length && one(this.db, 'SELECT resumed FROM runs WHERE id=?', runId)?.resumed
        && /no conversation found|session.*not found|thread.*not found|unknown.*session|could not find|no rollout found/i.test(res.error ?? '');
      const blocked = ctx.deniedN ? `；这次还有 ${ctx.deniedN} 处操作被系统拦下：${this.deniedList(ctx)}` : '';
      if (streak >= MAX_FAILS) {
        // 熔断：不再自动重试。唤醒单标成失败（群主点“重试”可以再来一次），任务卡标成卡住
        run(this.db, "UPDATE wakes SET state='failed', note=?, done_ts=? WHERE run_id=?", `连续 ${streak} 次没有完成：${why}`, now(), runId);
        this.blockTask(ctx.taskId ? this.tasks.get(ctx.taskId) : null, agent, `连续 ${streak} 次没有完成`);
        this.p.post({
          sender: '系统', kind: 'system', chainId: ctx.chainId, taskId: ctx.taskId ?? null,
          text: `@${agent} 在${this.laneOn(ctx.lane)}连续 ${streak} 次没有完成（最近一次：${why}${blocked}），工作台不再自动重试，免得白白消耗额度。@群主 可以点“重试”再试一次，或改派、取消。`,
          meta: { failedRun: runId, mentions: [OWNER] },
        });
      } else if (lostSession) {
        run(this.db, 'DELETE FROM lanes WHERE agent=? AND lane=?', agent, ctx.lane);
        run(this.db, "UPDATE wakes SET state='queued', note='旧会话失效，新开会话重试', run_id=NULL WHERE run_id=?", runId);
      } else if (!ctx.wakes.length) {
        // 没有唤醒单可以放回队列（不该出现），照老样子交给群主
        this.p.post({ sender: '系统', kind: 'system', chainId: ctx.chainId, text: `@${agent} 这次运行（${this.laneLabel(ctx.lane)}）没有完成：${why}${blocked}。`, meta: { run: runId } });
      } else {
        // 自动重试：唤醒单放回队列，过一会儿再送（第 1 次等 1 分钟，第 2 次等 5 分钟）
        const wait = RETRY_WAIT_MIN[streak - 1] ?? RETRY_WAIT_MIN[RETRY_WAIT_MIN.length - 1];
        run(this.db, "UPDATE wakes SET state='queued', note=?, run_id=NULL WHERE run_id=?", `没完成，${wait} 分钟后自动重试（第 ${streak} 次）`, runId);
        this.retryLater(agent, ctx.lane, this.retryWaitMs?.[streak - 1] ?? wait * 60 * 1000);
        this.p.post({
          sender: '系统', kind: 'system', chainId: ctx.chainId, taskId: ctx.taskId ?? null,
          text: `@${agent} 这次运行（${this.laneLabel(ctx.lane)}）没有完成：${why}${blocked}。${wait} 分钟后自动再试（连着 ${MAX_FAILS} 次没完成就停下交给群主，这是第 ${streak} 次）。`,
          meta: { run: runId },
        });
      }
    }
    this.p.sync();
    this.kick();
  }

  // 被拦的几处：在做什么（命令或文件，去掉项目路径前缀）+ 报错的关键词
  deniedList(ctx) {
    const rel = (s) => String(s).split(this.p.dir + '/').join('');
    const reason = (l) => TOOL_DENIED.test(l) ? '工具没放开' : l.startsWith('git push:') ? '不能推送' : /read-only|EROFS|Errno 30/i.test(l) ? '只读' : /改文件被拒绝|writing outside/i.test(l) ? '不在可写范围' : 'operation not permitted';
    return ctx.denied.slice(0, 3).map((d) => d.what ? `「${clip(rel(d.what), 120)}」（${reason(d.line)}）` : `「${clip(rel(d.line), 160)}」`).join(' ')
      + (ctx.deniedN > 3 ? ` 等 ${ctx.deniedN} 处` : '');
  }
  // 被拦的原因：写到了不归它的位置、或者沙箱不让做的事（比如查看进程）；成员程序自带的沙箱套在工作台的沙箱里起不来时，是命令根本没法运行
  // 被拦的有几类：写到了不归它的位置、用了工作台没放开的工具（比如要人点批准的那些）、想推送到远端
  deniedKinds(ctx) {
    const kinds = new Set(ctx.denied.map((d) => TOOL_DENIED.test(d.line) ? 'tool' : d.line.startsWith('git push:') ? 'push' : 'write'));
    return kinds;
  }
  deniedWhy(ctx) {
    if (ctx.denied.some((d) => /no sandbox backend|sandbox_apply/i.test(d.line))) return '它自带的沙箱套在工作台的沙箱里起不来，命令根本没有运行';
    const k = this.deniedKinds(ctx);
    return [k.has('write') && '写到了不归它的位置，或者做了沙箱不允许的事', k.has('tool') && '用了工作台没有放开的工具', k.has('push') && '想推送到远端（推送由群主自己来）']
      .filter(Boolean).join('；');
  }
  // 跑完了，但中间有操作被系统拦下：群里说一声被拦了什么。连着 MAX_FAILS 次都这样，就把任务卡停下交给群主
  noticeDenied(ctx, streak) {
    const { agent, lane } = ctx;
    if (streak >= MAX_FAILS) {
      this.blockTask(ctx.taskId ? this.tasks.get(ctx.taskId) : null, agent, `连续 ${streak} 次运行被系统拦下或没有完成`);
      this.p.post({
        sender: '系统', kind: 'system', chainId: ctx.chainId, taskId: ctx.taskId ?? null,
        text: `@${agent} 在${this.laneOn(lane)}连续 ${streak} 次运行被系统拦下或没有完成，这次被拦的是：${this.deniedList(ctx)}（${this.deniedWhy(ctx)}），再试也一样。@群主 请决定：${this.deniedKinds(ctx).has('write') ? '给它换个写入范围、改派，或者取消' : '改派，或者取消'}。`,
        meta: { run: ctx.runId, mentions: [OWNER] },
      });
    } else {
      this.p.post({
        sender: '系统', kind: 'system', chainId: ctx.chainId, taskId: ctx.taskId ?? null,
        text: `@${agent} 这次运行（${this.laneLabel(lane)}）有 ${ctx.deniedN} 处操作被系统拦下，${this.deniedWhy(ctx)}：${this.deniedList(ctx)}。`,
        meta: { run: ctx.runId },
      });
    }
  }

  // 停止一位成员正在跑的全部会话，或只停某一次运行
  stop(agent) {
    const mine = this.runsOf(agent);
    for (const ctx of mine) this.stopCtx(ctx, 'stopped');
    return mine.length > 0;
  }
  stopRun(runId) {
    const ctx = this.active.get(runId);
    if (!ctx) return false;
    this.stopCtx(ctx, 'stopped');
    return true;
  }
  stopAll() { for (const ctx of this.active.values()) this.stopCtx(ctx, 'stopped'); }

  // ---- 群摘要 ---------------------------------------------------------
  // 由一位便宜的成员（默认 Claude 的快速档）把群里的情况整理成一页，写到 共享区/群摘要.md。
  // 新接手的成员第一次被唤醒时先读这份摘要，再读摘要之后的新消息。
  summaryInfo() {
    const meta = J(this.p.getMeta('summary'), null);
    let text = '';
    try { text = fs.readFileSync(this.p.abs(SUMMARY_FILE), 'utf8'); } catch { /* 还没有摘要 */ }
    const upto = meta?.upto ?? 0;
    return {
      ...(meta ?? {}), upto, path: SUMMARY_FILE,
      text: text.replace(/^<!--[\s\S]*?-->\s*/, '').trim(),
      newCount: one(this.db, "SELECT COUNT(*) AS n FROM messages WHERE id>? AND kind='chat'", upto).n,
      running: [...this.active.values()].some((c) => c.kind === 'summary'),
      agent: meta?.agent ?? null, every: this.p.settings.summaryEvery ?? 30, auto: this.p.settings.summaryAuto !== false,
      writer: this.p.settings.summaryAgent ?? COORDINATOR,
    };
  }

  summarize(by = OWNER) {
    const settings = this.p.settings;
    const agent = settings.summaryAgent ?? COORDINATOR;
    const st = this.env.status();
    if (!st[agent]?.connected) throw new TaskError(`@${agent} 未连接，没法写群摘要。可以在设置里换一位成员来写。`);
    if ([...this.active.values()].some((c) => c.kind === 'summary')) throw new TaskError('群摘要正在整理中，等它写完。');
    if (this.runsOf(agent).length >= this.parallelLimit(agent)) throw new TaskError(`@${agent} 的并行会话都在忙，等它空出一个再更新摘要。`);
    if ((this.cooling[agent] ?? 0) > now()) throw new TaskError(`@${agent} 的额度用尽了，暂时写不了摘要。`);
    const info = this.summaryInfo();
    const fresh = all(this.db, 'SELECT * FROM messages WHERE id>? ORDER BY id LIMIT 400', info.upto).map((r) => this.p.rowToMsg(r));
    if (!fresh.some((m) => m.kind === 'chat')) throw new TaskError('上次摘要之后群里没有新的发言，不用更新。');

    const pick = pickModel({ agent, task: { kind: '摘要', rework: 0 }, settings, reason: 'task' });
    const prompt = buildSummaryPrompt({ project: this.p, tasks: this.tasks, prev: info.text, fresh });
    const runId = 'R' + now().toString(36) + crypto.randomBytes(2).toString('hex');
    const logPath = path.join(this.p.dir, DIRS.internal, 'runs', `${runId}.jsonl`);
    fs.writeFileSync(logPath, JSON.stringify({ t: now(), kind: 'prompt', line: prompt }) + '\n');
    run(this.db,
      `INSERT INTO runs(id,agent,started_ts,status,model,model_by,effort,resumed,wake_ids,log_path,kind,lane) VALUES(?,?,?,?,?,?,?,0,'[]',?,'summary',?)`,
      runId, agent, now(), 'running', pick.model, pick.by, pick.effort ?? null, logPath, SUMMARY_LANE);
    const ctx = { runId, agent, lane: SUMMARY_LANE, kind: 'summary', wakes: [], chainId: null, taskId: null, startedTs: now(), said: [], injected: new Map(), logPath, upto: fresh.at(-1).id, by, count: fresh.length };
    this.activity[runId] = { runId, agent, lane: SUMMARY_LANE, startedTs: ctx.startedTs, model: pick.model, effort: pick.effort ?? null, modelBy: pick.by, level: pick.level, taskId: null, text: '正在更新群摘要…', kind: 'summary' };
    const boundary = this.prepareBoundary(agent, SUMMARY_LANE, runId);
    ctx.profile = boundary.profile;
    this.active.set(runId, ctx);
    try {
      ctx.handle = this.env.adapters[agent].start({
        cwd: this.p.dir, prompt, sessionId: null, ephemeral: true, model: pick.model, effort: pick.effort, identity: null,
        pathPrefix: this.qunDir(agent), logPath, timeoutMs: 6 * 60 * 1000, patchDir: path.join(this.p.dir, DIRS.internal),
        extraEnv: this.memberEnv(runId), sandbox: boundary,
        on: {
          ...this.commonCallbacks(ctx),
          session: (sid, i) => { if (i?.model) { run(this.db, 'UPDATE runs SET model=? WHERE id=?', i.model, runId); if (this.activity[runId]) this.activity[runId].model = i.model; } },
          done: (res) => this.finishSummary(ctx, res),
        },
      });
    } catch (e) {
      this.finishSummary(ctx, { status: 'error', error: `启动失败：${e.message}`, finalText: '' });
      throw new TaskError(`摘要没能开始：${e.message}`);
    }
    if (ctx.handle?.pid) run(this.db, 'UPDATE runs SET pid=? WHERE id=?', ctx.handle.pid, runId);
    this.p.sync();
    return { runId, agent, model: pick.model };
  }

  finishSummary(ctx, res) {
    const { agent, runId } = ctx;
    this.active.delete(runId);
    delete this.activity[runId];
    if (ctx.profile) fs.rm(ctx.profile, { force: true }, () => {});
    const usage = res.usage ?? {};
    run(this.db, 'UPDATE runs SET status=?, ended_ts=?, usage=?, error=?, final_text=?, model=COALESCE(?, model) WHERE id=?',
      res.status, now(), JSON.stringify(usage), res.error ?? null, clip(res.finalText ?? '', 20000), res.model ?? null, runId);
    this.env.onRunEnd?.(agent, { runId, status: res.status, usage, model: res.model });
    const text = String(res.finalText ?? '').replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/, '$1').trim();
    if (res.status === 'ok' && text.length >= 20) {
      const model = one(this.db, 'SELECT model FROM runs WHERE id=?', runId)?.model ?? res.model;
      const head = `<!-- 群摘要：由 @${agent}（${model}）在 ${new Date().toLocaleString('zh-CN', { hour12: false })} 更新，覆盖到群里第 #${ctx.upto} 条消息。这个文件由工作台自动覆盖，不要手改。 -->\n\n`;
      fs.writeFileSync(this.p.abs(SUMMARY_FILE), head + text + '\n');
      this.p.setMeta('summary', JSON.stringify({ upto: ctx.upto, ts: now(), agent, model, runId, by: ctx.by }));
      this.p.post({ sender: '系统', kind: 'system', text: `群摘要已更新（@${agent} 整理，覆盖到第 #${ctx.upto} 条消息）：${SUMMARY_FILE}`, runId });
    } else if (res.status === 'quota') {
      this.cooling[agent] = now() + 30 * 60 * 1000;
      this.p.system(`@${agent} 的额度用尽了，群摘要这次没有更新。`);
    } else if (res.status !== 'stopped') {
      const why = res.status === 'ok' ? '成员没有给出摘要内容' : clip(res.error ?? res.status, 200);
      if (ctx.by === OWNER) this.p.post({ sender: '系统', kind: 'system', text: `群摘要没有更新成功：${why}`, meta: { failedRun: runId } });
    }
    this.p.sync();
    this.kick();
  }

  // 群里空闲下来、而且上次摘要之后又攒了足够多的发言，就自动更新一次
  maybeAutoSummarize() {
    const s = this.p.settings;
    if (s.summaryAuto === false || this.active.size) return;
    if (now() - (this._autoSummaryTs ?? 0) < 10 * 60 * 1000) return;
    if (one(this.db, "SELECT COUNT(*) AS n FROM wakes WHERE state IN ('queued','delivered','accepted')").n) return;
    const upto = J(this.p.getMeta('summary'), null)?.upto ?? 0;
    const n = one(this.db, "SELECT COUNT(*) AS n FROM messages WHERE id>? AND kind='chat'", upto).n;
    if (n < (s.summaryEvery ?? 30)) return;
    this._autoSummaryTs = now();
    try { this.summarize('自动'); } catch { /* 这次写不了就等下次 */ }
  }

  // ---- 给界面的数据 -----------------------------------------------------
  wakesForMessages(ids) {
    if (!ids.length) return {};
    const rows = all(this.db, `SELECT * FROM wakes WHERE source_msg IN (${ids.map(() => '?').join(',')})`, ...ids);
    const out = {};
    for (const w of rows) (out[w.source_msg] ??= []).push({ id: w.id, target: w.target, state: w.state, note: w.note, reason: w.reason });
    return out;
  }
  pendingWakes() {
    return all(this.db, "SELECT * FROM wakes WHERE state IN ('queued','waiting','held','delivered','accepted','failed') ORDER BY id DESC LIMIT 100")
      .map((w) => ({ id: w.id, target: w.target, state: w.state, note: w.note, reason: w.reason, taskId: w.task_id, sourceMsg: w.source_msg, chainId: w.chain_id, ts: w.ts, runId: w.run_id }));
  }
  runs(limit = 60) {
    const rows = all(this.db, 'SELECT * FROM runs ORDER BY started_ts DESC LIMIT ?', limit);
    const changes = this.snap ? this.snap.summaries(rows.map((r) => r.id)) : {};
    return rows.map((r) => ({
      id: r.id, agent: r.agent, startedTs: r.started_ts, endedTs: r.ended_ts, status: r.status, model: r.model, modelBy: r.model_by,
      effort: r.effort, resumed: !!r.resumed, usage: J(r.usage, {}), error: r.error, taskId: r.task_id, lastCmd: r.last_cmd, qunCalls: r.qun_calls,
      firstOutTs: r.first_out_ts, kind: r.kind ?? 'work', lane: r.lane ?? 'main', denied: r.denied ?? 0,
      changes: changes[r.id] ?? null,      // 这次改了几个文件：{ n, adds, dels, rolled, skipped }
    }));
  }
  // 本项目消耗：按成员汇总真实运行报回的 token 数
  spend() {
    const out = {};
    for (const r of all(this.db, "SELECT agent, usage, model FROM runs WHERE status<>'running'")) {
      const u = J(r.usage, {});
      const o = (out[r.agent] ??= { runs: 0, input: 0, cached: 0, output: 0, cost: 0, currency: null });
      o.runs += 1; o.input += u.input ?? 0; o.cached += u.cached ?? 0; o.output += u.output ?? 0;
      if (typeof u.cost === 'number') { o.cost += u.cost; o.currency = u.currency ?? o.currency; }
    }
    return out;
  }
}
