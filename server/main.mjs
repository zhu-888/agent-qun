// 工作台主程序：本机 HTTP 服务 + 实时推送。平时只监听 127.0.0.1；
// 群主打开“手机访问”后，另外只在 Tailscale 地址上再听一份（见 remote.mjs）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Project, DIRS, now, opensAsProgram } from './project.mjs';
import { Dispatcher } from './dispatcher.mjs';
import { serveRpc } from './rpc.mjs';
import { TaskError } from './tasks.mjs';
import { Quota } from './quota.mjs';
import { sandboxStatus, inTempArea } from './boundary.mjs';
import { ALL_AGENTS, member, enabledAgents, coordinator, configureMembers, cleanMemberSettings, upgradeSettings, DEFAULT_KIND_LEVEL, LEVELS, tiersFor } from './members.mjs';
import { ROSTER } from './roster.mjs';
import { configureModels, catalogView, refreshCodexModels, setDeepseekModels, lockOf, findModel, normalizeEffort, EFFORTS } from './models.mjs';
import { Remote, RemoteError, phoneAllowed, tailscaleIp } from './remote.mjs';
import { claude } from './agents/claude.mjs';
import { codex } from './agents/codex.mjs';
import { deepseek, DEEPSEEK_PRICES, isPeak } from './agents/deepseek.mjs';
import { prepareIcons, iconFile, ICON_NAMES } from './icons.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const WEB_DIR = path.join(APP_DIR, 'web');
const PROJECTS_ROOT = path.join(APP_DIR, '项目');
const PORT = Number(process.env.PORT ?? 7788);
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- 应用级设置和项目登记 -------------------------------------------------
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const REGISTRY_FILE = path.join(DATA_DIR, 'projects.json');
let appSettings = upgradeSettings(readJson(SETTINGS_FILE, {}));      // 旧版的“允许 DeepSeek 使用 API key”并进成员表的启用开关
// 群主改过的成员（启用 / 停用、分工）：启动时生效。存的内容不对就按出厂的来
try { appSettings.members = configureMembers(appSettings.members); }
catch (e) { console.error('设置里的成员配置不对，先按出厂的来：', e.message); appSettings.members = configureMembers({}); }
let registry = readJson(REGISTRY_FILE, []);
// 群主自己加的模型、改过的档位、固定模型：启动时生效。存的内容不对就当没有，不让它挡住启动
try { configureModels({ customModels: appSettings.customModels, tiers: appSettings.tiers, lock: appSettings.modelLock }); }
catch (e) { console.error('设置里的模型配置不对，先按默认的来：', e.message); configureModels({}); }

// 成员表里每一行的 adapter 对应这里的一个接入文件。加新成员时在这里登记（见 roster.mjs 开头的说明）
const ADAPTER_MODULES = { claude, codex, deepseek };
const adapters = Object.fromEntries(ROSTER.map((r) => {
  if (!ADAPTER_MODULES[r.adapter]) throw new Error(`成员表里 ${r.name} 的接入方式「${r.adapter}」没有在 main.mjs 的 ADAPTER_MODULES 里登记`);
  return [r.name, ADAPTER_MODULES[r.adapter]];
}));
const OFF = { connected: false, disabled: true, detail: '已停用：在设置 →「成员」里可以打开', fix: '到设置 →「成员」里打开它' };
let agentStatus = Object.fromEntries(ALL_AGENTS.map((a) => [a, member(a).enabled ? { connected: false, detail: '正在检测…' } : OFF]));
const status = () => agentStatus;

const projects = new Map();   // id → { project, disp, stopRpc, clients:Set }
const appClients = new Set();
const remote = new Remote({ file: path.join(DATA_DIR, 'remote.json') });

const quota = new Quota({ adapters, status, onChange: () => broadcastApp(), baselineFile: path.join(DATA_DIR, 'deepseek-baseline.json') });

async function detectAgents() {
  codex.mode = appSettings.codexMode === 'exec' ? 'exec' : 'app-server';
  const entries = await Promise.all(ALL_AGENTS.map(async (a) => {
    if (!member(a).enabled) return [a, OFF];        // 停用的不去检测它的命令行（按量付费的成员也就不会去读它的 key）
    try { return [a, await adapters[a].detect()]; } catch (e) { return [a, { connected: false, detail: `检测失败：${e.message}` }]; }
  }));
  agentStatus = Object.fromEntries(entries);
  // 模型清单：Codex 读它自己的清单文件；DeepSeek 问官方接口（不收费）。读不到就用内置清单
  refreshCodexModels();
  if (agentStatus.DeepSeek?.connected) { try { setDeepseekModels(await deepseek.models()); } catch { /* 读不到就保持上一次的 */ } }
  broadcastApp();
  for (const { disp } of projects.values()) disp.kick();
}

// ---- 项目 ---------------------------------------------------------------
function openProject(entry) {
  if (projects.has(entry.id)) return projects.get(entry.id);
  const project = new Project(entry);
  const disp = new Dispatcher(project, {
    adapters, status, appDir: APP_DIR, port: PORT,
    onRateLimit: (agent, info) => { if (agent === 'Claude') quota.noteClaudeEvent(info); else if (agent === 'Codex') quota.noteCodexEvent(info); },
    // Claude 的高档模型（Fable）有单独的每周额度；剩余不到 15% 时自动选模型会降一档
    highTierLow: (agent) => {
      if (agent !== 'Claude') return false;
      if (!/fable/i.test(tiersFor('Claude', project.settings).高?.model ?? '')) return false;   // 高档已经换成别的模型，就不看 Fable 的额度了
      const w = quota.data.Claude?.windows?.find((x) => /fable/i.test(x.label));
      return w ? w.remainPct < 15 : false;
    },
    onRunEnd: (agent) => { setTimeout(() => quota.refresh(agent), 1500); },
  });
  const ctx = { project, disp, clients: new Set(), stopRpc: serveRpc(disp) };
  project.watchInbox();
  project.on('sync', () => { push(ctx, 'sync'); broadcastAppSoon(); });
  project.on('activity', () => push(ctx, 'activity', disp.activity));
  projects.set(entry.id, ctx);
  disp.kick();
  return ctx;
}

function cleanName(name) {
  name = String(name ?? '').trim();
  if (!name) throw new TaskError('项目要有名字');
  if (/[\/\\:]/.test(name)) throw new TaskError('项目名里不能有 / \\ :');
  return name.slice(0, 60);
}
const expandDir = (dir) => path.resolve(String(dir).trim().replace(/^~(?=\/|$)/, os.homedir()));
// 项目文件夹的规矩：不同项目的文件夹不能相同、不能互相包含，也不能在系统临时目录里
function checkProjectDir(dir, selfId = null) {
  if (registry.some((p) => p.id !== selfId && (dir === p.dir || dir.startsWith(p.dir + path.sep) || p.dir.startsWith(dir + path.sep)))) throw new TaskError('这个文件夹和已有项目的文件夹相同或互相包含，不同项目要用互不包含的文件夹');
  if (inTempArea(dir)) throw new TaskError('项目文件夹不能放在系统的临时目录里：那里所有成员都能随便写，写入边界守不住。请换一个位置。');
}
function createProject({ name, dir }) {
  name = cleanName(name);
  dir = dir ? expandDir(dir) : path.join(PROJECTS_ROOT, name);
  const clash = registry.find((p) => p.dir === dir);
  if (clash) return clash;
  checkProjectDir(dir);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { id: 'p' + crypto.createHash('sha1').update(dir).digest('hex').slice(0, 10), name, dir, createdTs: now() };
  registry.push(entry);
  writeJson(REGISTRY_FILE, registry);
  const ctx = openProject(entry);
  ctx.project.system(`「${name}」工作群已建好。把文件放进「${DIRS.inbox}」文件夹，群里会收到一次通知；成员之间通过「${DIRS.shared}」交接。`);
  broadcastApp();
  return entry;
}

function closeProject(id) {
  const ctx = projects.get(id);
  if (!ctx) return null;
  ctx.disp.dispose(); ctx.stopRpc(); ctx.project.close();
  projects.delete(id);
  return ctx;
}
// 改项目文件夹的位置：把整个文件夹移过去（或者，群主已经在访达里把它挪走了，就改成指向新位置）。
// 聊天记录、任务卡、文件都在文件夹里，跟着一起走；成员各自的会话记录是按文件夹存的，换了位置接不上，所以从新会话开始。
function moveProject(entry, to) {
  if (!String(to ?? '').trim()) throw new TaskError('路径不能为空');
  const dir = expandDir(to);
  if (dir === entry.dir) return entry;
  if (dir.startsWith(entry.dir + path.sep)) throw new TaskError('不能把项目文件夹移到它自己里面');
  checkProjectDir(dir, entry.id);
  const ctx = projects.get(entry.id);
  if (ctx?.disp.active.size) throw new TaskError('有成员正在这个项目里干活，等它们停下（或先点停止）再改路径');
  const hasState = (d) => fs.existsSync(path.join(d, DIRS.internal, 'state.db'));
  const oldThere = fs.existsSync(entry.dir);
  let adopt = false;        // 新位置已经是这个工作群的文件夹（群主自己挪过去的）：只改指向，不移动
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw new TaskError('这个路径是一个文件，不是文件夹');
    if (hasState(dir)) {
      if (oldThere && hasState(entry.dir)) throw new TaskError('那个文件夹里已经有另一份工作群记录了，两份没法合并。请换一个还不存在的位置');
      adopt = true;
    } else if (fs.readdirSync(dir).some((n) => n !== '.DS_Store')) {
      throw new TaskError('那个文件夹里已经有别的东西了。请填一个还不存在的位置，或者一个空文件夹');
    }
  } else if (!oldThere) throw new TaskError('原来的文件夹找不到了，新位置也不存在。请先确认文件夹现在在哪里');
  const clients = ctx?.clients ?? new Set();
  closeProject(entry.id);
  const old = entry.dir;
  try {
    if (!adopt) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });     // 只会是空文件夹（上面检查过）
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(old, dir);
    }
  } catch (e) {
    const back = openProject(entry);
    for (const c of clients) back.clients.add(c);
    throw new TaskError(e.code === 'EXDEV' ? '新位置在另一个磁盘上，工作台没法直接移过去。请先在访达里把文件夹拖过去，再回来把路径改成新位置' : `没能移动文件夹：${e.message}`);
  }
  entry.dir = dir;
  writeJson(REGISTRY_FILE, registry);
  const next = openProject(entry);
  for (const c of clients) next.clients.add(c);
  next.project.db.prepare('DELETE FROM lanes').run();
  next.project.system(`群主把项目文件夹从 ${old} 改到了 ${dir}。聊天记录、任务卡和文件都跟着过来了；成员各自的会话从头开始。`);
  broadcastApp();
  return entry;
}
// 从工作台里移除一个项目：只是不再列出来，文件夹和里面的东西原样留着
function removeProject(entry) {
  const ctx = projects.get(entry.id);
  if (ctx?.disp.active.size) throw new TaskError('有成员正在这个项目里干活，先停下再移除');
  closeProject(entry.id);
  // 正在看这个项目的页面连接不用关：那条连接同时还收应用级的通知，页面收到通知后自己会换到别的项目
  registry = registry.filter((p) => p.id !== entry.id);
  writeJson(REGISTRY_FILE, registry);
  broadcastApp();
}

// 一个项目里的对话列表：标题、最后一条消息的时间、有没有没读的、它引出的任务卡在什么状态
const chatTitle = (text) => String(text ?? '').replace(/[@＠](?:Claude|Codex|DeepSeek)\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || '（没有文字）';
function chatList(ctx) {
  const { project, disp } = ctx;
  const meta = project.chatMeta();
  const tasks = disp.tasks.list();
  const running = new Set([...disp.active.values()].map((c) => c.chainId).filter((x) => x != null));
  return project.chatRows().map((r) => {
    const mt = meta[r.id] ?? {};
    const mine = tasks.filter((t) => t.chainId === r.id);
    return {
      id: r.id, title: mt.title || chatTitle(r.text), named: !!mt.title, firstTs: r.firstTs, lastTs: r.lastTs, lastId: r.lastId, count: r.n,
      // 没记过“读到哪”的老对话算已读，不然第一次打开会满屏都是未读
      unread: mt.readId != null && r.lastId > mt.readId, archived: !!mt.archived,
      waiting: mine.filter((t) => t.state === 'awaiting_owner').length,
      open: mine.filter((t) => !['done', 'cancelled'].includes(t.state)).length,
      stuck: mine.some((t) => ['blocked', 'rejected'].includes(t.state)),
      running: running.has(r.id),
    };
  });
}

// ---- 推送 ---------------------------------------------------------------
function sse(res) {
  res.on('error', () => {});      // 连接出错只影响它自己，不往外抛
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
}
// 往页面的连接上写一段。连接已经关了就跳过；写的时候出错也不能把整个工作台带倒
const writeTo = (res, text) => { if (res.writableEnded || res.destroyed) return; try { res.write(text); } catch { /* 这条连接坏了，等它自己关掉 */ } };
const send = (res, event, data) => writeTo(res, `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
function push(ctx, event, data) { for (const res of ctx.clients) send(res, event, data); }
function broadcastApp() { for (const res of appClients) send(res, 'app', {}); }
// 任何一个项目有动静，左栏的对话列表都要跟着变：攒一下再通知，免得一连串小变化刷太多次
let appSoon = null;
function broadcastAppSoon() { if (appSoon) return; appSoon = setTimeout(() => { appSoon = null; broadcastApp(); }, 400); }
setInterval(() => {
  for (const res of appClients) writeTo(res, ': ping\n\n');
  for (const ctx of projects.values()) for (const res of ctx.clients) writeTo(res, ': ping\n\n');
}, 20000).unref();

// ---- 给界面的数据 ---------------------------------------------------------
function appState() {
  return {
    projects: registry.map((p) => {
      const ctx = projects.get(p.id);
      const tasks = ctx ? ctx.disp.tasks.list() : [];
      return {
        id: p.id, name: p.name, dir: p.dir, pinned: !!p.pinned, section: p.section ?? null,
        chats: ctx ? chatList(ctx) : [],
        waitingOwner: tasks.filter((t) => t.state === 'awaiting_owner').length,
        open: tasks.filter((t) => !['done', 'cancelled'].includes(t.state)).length,
        running: ctx ? [...new Set([...ctx.disp.active.values()].map((c) => c.agent))] : [],
      };
    }),
    // agents：启用的成员（群里、成员栏、@ 按钮都只列它们）；members：成员表的全部成员（设置里的成员表、旧消息的头像和颜色要用）
    agents: enabledAgents().map((a) => {
      const m = member(a);
      return { name: a, account: a, accountLabel: m.accountLabel, title: m.title, payPerUse: m.payPerUse, coordinator: a === coordinator(), canInject: !!adapters[a].canInject && !(a === 'Codex' && codex.mode === 'exec'), ...agentStatus[a] };
    }),
    members: ALL_AGENTS.map((a) => {
      const m = member(a);
      return {
        name: a, enabled: m.enabled, title: m.title, role: m.role, defaultTitle: m.defaultTitle, defaultRole: m.defaultRole,
        accountLabel: m.accountLabel, payPerUse: m.payPerUse, coordinator: a === coordinator(), color: m.color,
        icon: ICON_NAMES.includes(m.id) ? `/icons/${m.id}.png` : null, iconDark: ICON_NAMES.includes(`${m.id}-dark`) ? `/icons/${m.id}-dark.png` : null,
        connected: !!agentStatus[a]?.connected, detail: agentStatus[a]?.detail ?? '',
      };
    }),
    quota: quota.view(),
    settings: appSettings,
    // tiers：自动选模型时三档各用什么（出厂默认 + 群主在设置里改的）；catalog：每位成员能选的全部模型和各自支持的推理强度
    tiers: Object.fromEntries(ALL_AGENTS.map((a) => [a, tiersFor(a)])), catalog: catalogView(), efforts: EFFORTS,
    kindLevel: DEFAULT_KIND_LEVEL, levels: LEVELS,
    deepseekPrices: { prices: DEEPSEEK_PRICES, peakNow: isPeak() },
    projectsRoot: PROJECTS_ROOT,
    // 写入边界是不是由操作系统强制的（Claude、DeepSeek 靠系统沙箱；Codex 靠它自带的沙箱，总是生效）
    boundary: { ...sandboxStatus(), detail: sandboxStatus().ok ? '每个会话只能写自己那张任务卡的范围，由操作系统强制' : `Claude 和 DeepSeek 的系统级限制没有生效：${sandboxStatus().reason}。只有 Codex 是强制的。` },
  };
}

function projectState(ctx) {
  const { project, disp } = ctx;
  const messages = project.messages({ limit: 500 });
  const tasks = disp.tasks.list().map((t) => ({ ...t, events: disp.tasks.events(t.id), changedFiles: disp.tasks.changedSinceSubmit(t) }));
  return {
    id: project.id, name: project.name, dir: project.dir, settings: project.settings,
    messages, wakesByMsg: disp.wakesForMessages(messages.map((m) => m.id)),
    tasks, wakes: disp.pendingWakes(), activity: disp.activity, runs: disp.runs(80), spend: disp.spend(),
    cooling: disp.cooling, files: project.listFiles(), summary: disp.summaryInfo(),
    parallel: Object.fromEntries(ALL_AGENTS.map((a) => [a, disp.parallelLimit(a)])),
  };
}

// ---- HTTP ---------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req, limit = 30 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > limit) { reject(new TaskError('内容太大')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.jsonl', '.py', '.js', '.mjs', '.ts', '.sh', '.yml', '.yaml', '.toml', '.html', '.css', '.xml', '.log', '.sql', '.ini', '.cfg']);

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  const host = String(req.headers.host ?? '');
  const viaPhone = !LOOPBACK.has(req.socket.localAddress);      // 从 Tailscale 那个地址进来的，就是手机
  if (!viaPhone) {
    // 只接受来自本机页面的请求
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(res, 403, { error: '只能从本机访问' });
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return json(res, 403, { error: '来源不对' });
      if (req.headers['x-workgroup'] !== '1') return json(res, 403, { error: '缺少请求标记' });
    }
  } else {
    if (!remote.enabled) return json(res, 403, { error: '手机访问没有打开' });
    // 地址栏里只能是这台 Mac 的 Tailscale 地址或它的 ts.net 名字，别的网页借不了这条路
    const hostName = host.replace(/:\d+$/, '');
    if (hostName !== tailscaleIp() && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(hostName)) return json(res, 403, { error: '地址不对' });
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return json(res, 403, { error: '来源不对' });
      if (req.headers['x-workgroup'] !== '1') return json(res, 403, { error: '缺少请求标记' });
    }
    // 没配对之前只给配对页和它要用的样式、图标
    if (req.method === 'POST' && parts.join('/') === 'api/pair') {
      const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
      const cookie = remote.pair(b.code, b.name);
      broadcastApp();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `wg_dev=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
      return res.end('{}');
    }
    const open = req.method === 'GET' && (['pair.html', 'app.css'].includes(parts.join('/')) || (parts[0] === 'icons' && parts.length === 2));
    const device = open ? null : remote.auth(req.headers.cookie);
    if (!open && !device) {
      if (parts[0] === 'api') return json(res, 401, { error: '这台设备还没有配对', pair: true });
      res.writeHead(302, { Location: '/pair.html', 'Cache-Control': 'no-store' }); return res.end();
    }
    if (!open && !phoneAllowed(req.method, parts)) return json(res, 403, { error: '这个操作只能在电脑上做' });
    res.deviceId = device?.id;
  }

  // 成员图标在 data/icons/（启动时从本机应用里取的，不随项目发布）；没有就 404，界面退回字母头像
  if (parts[0] === 'icons' && parts.length === 2) {
    const file = iconFile(DATA_DIR, parts[1]);
    if (!file) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  if (parts[0] !== 'api') {
    const rel = parts.length ? parts.join('/') : 'index.html';
    const file = path.join(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('没有这个页面'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }

  const body = async () => { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

  // ---- 推送：一个标签页只开这一条连接，应用级的事（app）和它正在看的那个项目的事（sync、activity）都走它 ----
  // 浏览器对同一个地址最多同时开 6 条连接。以前每个标签页开两条，开三个标签页就把名额占满，之后页面上所有操作都发不出去。
  if (parts[1] === 'events') {
    sse(res);
    appClients.add(res);
    const entry = registry.find((p) => p.id === url.searchParams.get('p'));
    const ctx = entry ? openProject(entry) : null;
    if (ctx) { ctx.clients.add(res); send(res, 'activity', ctx.disp.activity); }
    req.on('close', () => { appClients.delete(res); for (const c of projects.values()) c.clients.delete(res); });
    return;
  }

  // ---- 应用级 ----
  if (parts[1] === 'app') {
    if (req.method === 'GET' && parts.length === 2) return json(res, 200, viaPhone ? { ...appState(), viaPhone: true } : appState());
    if (parts[2] === 'events') { res.writeHead(204); return res.end(); }      // 老页面用的那条连接：回 204，浏览器就不会再连了（见下面的 /api/events）
    // 下面这些会动东西（重新检测、改设置、弹出选文件夹的窗口）：只收带工作台标记的 POST，别的网页用 <img> 之类的 GET 触发不了
    if (req.method !== 'POST') return json(res, 405, { error: '这个接口只收 POST' });
    if (parts[2] === 'refresh') { await detectAgents(); await quota.refreshAll(); return json(res, 200, appState()); }
    if (parts[2] === 'settings') {
      const b = await body();
      const next = { ...appSettings };
      for (const k of ['codexMode']) if (k in b) next[k] = b[k];
      // 成员表：先检查，模型那边也没问题了再一起生效
      let members = null;
      if ('members' in b) {
        try { members = cleanMemberSettings(b.members); } catch (e) { throw e.userFacing ? new TaskError(e.message) : e; }
      }
      if ('customModels' in b || 'tiers' in b || 'modelLock' in b) {
        const prev = { customModels: appSettings.customModels, tiers: appSettings.tiers, lock: appSettings.modelLock };
        try {
          const ok = configureModels({ customModels: b.customModels ?? prev.customModels, tiers: b.tiers ?? prev.tiers, lock: b.modelLock ?? prev.lock });
          next.customModels = ok.customModels; next.tiers = ok.tiers; next.modelLock = ok.lock;
        } catch (e) {
          configureModels(prev);                       // 填错了：恢复原来的，告诉界面哪里不对
          throw e.userFacing ? new TaskError(e.message) : e;
        }
      }
      if (members) next.members = configureMembers(members);
      appSettings = next;
      writeJson(SETTINGS_FILE, appSettings);
      await detectAgents();
      if (members) for (const { project, disp } of projects.values()) { project.ensureLayout(); try { disp.checkStale(); } catch { /* 下一分钟还会再查 */ } }
      return json(res, 200, appState());
    }
    if (parts[2] === 'pick-folder') {
      const dir = await new Promise((resolve) => execFile('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "选择项目文件夹")'], { timeout: 120000 }, (err, out) => resolve(err ? null : out.trim().replace(/\/$/, ''))));
      return json(res, 200, { dir });
    }
  }
  // ---- 手机访问的管理：只能在电脑上做（手机那边在 phoneAllowed 里就被挡住了） ----
  if (parts[1] === 'remote') {
    // 这里会返回配对码：GET 也要带工作台标记（别的网页发不出带这个标记的请求）
    if (req.headers['x-workgroup'] !== '1') return json(res, 403, { error: '缺少请求标记' });
    if (req.method === 'POST') {
      const b = await body();
      if (parts[2] === 'enable') { remote.setEnabled(b.on); syncRemoteListener(); }
      else if (parts[2] === 'code') remote.newCode();
      else if (parts[2] === 'revoke') { remote.revoke(String(b.id)); dropDevice(String(b.id)); }
      else return json(res, 404, { error: '没有这个接口' });
    }
    return json(res, 200, remote.view(PORT, !!remoteServer));
  }
  if (parts[1] === 'projects' && req.method === 'POST') {
    const b = await body();
    return json(res, 200, { project: createProject(b), app: appState() });
  }

  // ---- 项目级 ----
  if (parts[1] === 'p') {
    const entry = registry.find((p) => p.id === parts[2]);
    if (!entry) return json(res, 404, { error: '没有这个项目' });
    const ctx = openProject(entry);
    const { project, disp } = ctx;
    const tasks = disp.tasks;
    const [, , , what, a, b2] = parts;

    if (req.method === 'GET') {
      if (what === 'state') return json(res, 200, projectState(ctx));
      if (what === 'events') { res.writeHead(204); return res.end(); }        // 同上：老页面的连接，让它放手
      if (what === 'file') {
        const abs = project.abs(url.searchParams.get('path') ?? '');
        // realInside：项目里的符号链接可能指向项目外（比如 ~/.ssh），那种不给看
        if (!abs || !fs.existsSync(abs) || !project.realInside(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: '项目里没有这个文件' });
        const st = fs.statSync(abs);
        const ext = path.extname(abs).toLowerCase();
        const isText = TEXT_EXT.has(ext) || st.size < 200000 && !fs.readFileSync(abs).subarray(0, 4000).includes(0);
        if (!isText) return json(res, 200, { path: project.rel(abs), size: st.size, binary: true });
        const max = 400000;
        const buf = fs.readFileSync(abs);
        return json(res, 200, { path: project.rel(abs), size: st.size, mtime: Math.round(st.mtimeMs), ext, text: buf.subarray(0, max).toString('utf8'), truncated: buf.length > max });
      }
      // 一次运行改了什么：文件列表 + 逐行对比（来自改动快照）
      if (what === 'run' && b2 === 'diff') {
        if (!disp.snap) return json(res, 404, { error: '改动快照没有开启' });
        return json(res, 200, await disp.snap.diff(String(a)).catch((e) => { throw new TaskError(e.message); }));
      }
      if (what === 'run') {
        const r = disp.runs(500).find((x) => x.id === a);
        const logPath = path.join(project.dir, DIRS.internal, 'runs', `${path.basename(a ?? '')}.jsonl`);
        if (!r || !fs.existsSync(logPath)) return json(res, 404, { error: '没有这次运行的记录' });
        const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(0, 4000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        return json(res, 200, { run: r, lines, live: disp.liveText(r.id) });      // live：还在跑时，正在写、还没写完的那段话
      }
    }

    if (req.method === 'POST') {
      if (what === 'upload') {
        const name = path.basename(String(url.searchParams.get('name') ?? '')).replace(/[\x00-\x1f]/g, '');
        if (!name || name.startsWith('.')) throw new TaskError('文件名不对');
        const buf = await readBody(req);
        let target = path.join(project.dir, DIRS.inbox, name);
        if (fs.existsSync(target) && !fs.readFileSync(target).equals(buf)) {
          const ext = path.extname(name);
          target = path.join(project.dir, DIRS.inbox, `${path.basename(name, ext)}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}${ext}`);
        }
        fs.writeFileSync(target, buf);
        setTimeout(() => project.scanInbox(), 900);
        return json(res, 200, { path: project.rel(target) });
      }
      const b = await body();
      if (what === 'say') {
        const text = String(b.text ?? '').trim();
        if (!text) throw new TaskError('消息不能为空');
        const msg = disp.ownerSay({ text, replyTo: b.replyTo ?? null, files: b.files ?? [], asTask: b.asTask !== false, taskId: b.taskId ? String(b.taskId).toUpperCase() : null, chatId: b.chatId != null ? Number(b.chatId) : null, review: b.review !== false });
        if (msg.chainId != null) project.patchChat(msg.chainId, { readId: msg.id });     // 自己刚说的话，当然算读过了
        return json(res, 200, { msg });
      }
      // 项目本身：改名、置顶、放进哪个分组
      if (what === 'meta') {
        if ('name' in b) { entry.name = cleanName(b.name); project.rename(entry.name); }
        if ('pinned' in b) { if (b.pinned) entry.pinned = true; else delete entry.pinned; }
        if ('section' in b) { const sec = String(b.section ?? '').replace(/\s+/g, ' ').trim().slice(0, 30); if (sec) entry.section = sec; else delete entry.section; }
        writeJson(REGISTRY_FILE, registry);
        broadcastApp();
        return json(res, 200, { app: appState() });
      }
      if (what === 'move') { moveProject(entry, b.dir); return json(res, 200, { app: appState() }); }
      if (what === 'remove') { removeProject(entry); return json(res, 200, { app: appState() }); }
      // 一个对话：改名、归档、记下读到哪一条
      if (what === 'chat') {
        const id = Number(a);
        if (!project.isChat(id)) throw new TaskError('这个项目里没有这个对话');
        project.patchChat(id, b);
        return json(res, 200, {});
      }
      // 这个项目的全部对话：全部标成已读，或全部归档
      if (what === 'chats') {
        for (const r of project.chatRows()) {
          if (b.readAll) project.patchChat(r.id, { readId: r.lastId });
          if (b.archiveAll) project.patchChat(r.id, { archived: true });
        }
        return json(res, 200, {});
      }
      if (what === 'task') {
        const act = b2;
        let t;
        if (act === 'approve') t = tasks.approve(a);
        else if (act === 'reject') t = tasks.reject(a, b.reason);
        else if (act === 'reassign') t = tasks.reassign(a, '群主', b.to, b.reason ?? '');
        else if (act === 'cancel') t = tasks.cancel(a, '群主', b.reason ?? '');
        else if (act === 'model') t = tasks.setModel(a, b.model);
        else if (act === 'level') t = tasks.setLevel(a, b.level);
        else throw new TaskError('不认识的任务操作');
        return json(res, 200, { task: t });
      }
      if (what === 'agent') {
        if (!ALL_AGENTS.includes(a)) throw new TaskError('没有这个成员');
        const s = project.settings;
        if (b2 === 'stop') return json(res, 200, { stopped: disp.stop(a) });
        if (b2 === 'pause') { project.patchSettings({ pausedAgents: [...new Set([...(s.pausedAgents ?? []), a])] }); return json(res, 200, {}); }
        if (b2 === 'resume') { project.patchSettings({ pausedAgents: (s.pausedAgents ?? []).filter((x) => x !== a) }); disp.kick(); return json(res, 200, {}); }
        if (b2 === 'model') {
          // 'auto' = 按任务自动选；否则固定一个模型，再配一档推理强度（这个模型不支持那一档就用它的默认档）
          let v = 'auto';
          if (b.model && b.model !== 'auto') {
            const id = String(b.model);
            if (lockOf(a)) throw new TaskError(`@${a} 固定只用一个模型，要换请到设置里改`);
            if (!findModel(a, id)) throw new TaskError('模型目录里没有这个模型，先到设置里把它加上');
            v = { model: id, effort: normalizeEffort(a, id, b.effort) };
          }
          project.patchSettings({ memberModel: { ...s.memberModel, [a]: v } });
          return json(res, 200, {});
        }
        if (b2 === 'new-session') { project.db.prepare('DELETE FROM lanes WHERE agent=?').run(a); project.sync(); return json(res, 200, {}); }
      }
      if (what === 'settings') {
        const allow = viaPhone ? ['paused'] : ['hopLimit', 'runTimeoutMin', 'paused', 'kindLevel', 'summaryAgent', 'summaryEvery', 'summaryAuto', 'parallel'];
        const patch = Object.fromEntries(Object.entries(b).filter(([k]) => allow.includes(k)));
        const s = project.patchSettings(patch);
        if ('paused' in patch) {
          project.system(patch.paused ? '群主暂停了这个项目：排队中的唤醒先不送达，正在跑的会跑完这一步。' : '群主恢复了这个项目。');
          if (!patch.paused) disp.kick();
        }
        if ('parallel' in patch) disp.kick();   // 上限调大了，排队的可以马上开跑
        return json(res, 200, { settings: s });
      }
      if (what === 'summary') return json(res, 200, disp.summarize('群主'));
      if (what === 'run' && b2 === 'stop') return json(res, 200, { stopped: disp.stopRun(a) });
      // 撤回一次运行改的文件。会删文件、覆盖文件，所以只能在这台电脑上点，手机上不行
      if (what === 'run' && b2 === 'rollback') {
        if (viaPhone) throw new TaskError('撤回改动只能在电脑上操作');
        return json(res, 200, await disp.rollbackRun(String(a), '群主'));
      }
      if (what === 'hold') { disp.releaseHold(Number(a), Number(b.extra ?? 6)); return json(res, 200, {}); }
      if (what === 'wake' && b2 === 'retry') { disp.retryFailed(Number(a)); return json(res, 200, {}); }
      if (what === 'msg' && b2 === 'forward') return json(res, 200, disp.forwardStale(Number(a)));
      if (what === 'open') {
        const abs = b.path ? project.abs(b.path) : project.dir;
        if (!abs || !fs.existsSync(abs) || !project.realInside(abs)) throw new TaskError('项目里没有这个文件');
        // 成员写出来的程序（.command、.app、带执行权限的文件……）用“默认应用打开”会直接运行，而且在沙箱外。这种只在访达里显示
        const runs = !b.reveal && opensAsProgram(abs);
        execFile('/usr/bin/open', b.reveal || runs ? ['-R', abs] : [abs], () => {});
        return json(res, 200, runs ? { note: `「${path.basename(abs)}」打开就会运行程序，为了安全只在访达里显示。确认没问题的话，自己在访达里打开。` } : {});
      }
    }
  }
  return json(res, 404, { error: '没有这个接口' });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// 每个回复都带上：不许别的网页用 iframe 把工作台嵌进去（防点击劫持），不许浏览器猜文件类型
const SAFE_HEADERS = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const handle = (req, res) => {
  for (const [k, v] of Object.entries(SAFE_HEADERS)) res.setHeader(k, v);
  route(req, res).catch((e) => {
    const mine = e instanceof TaskError || e instanceof RemoteError;
    if (!mine && !(e instanceof SyntaxError)) console.error(e);
    if (!res.headersSent) json(res, mine || e instanceof SyntaxError ? 400 : 500, { error: e.message });
    else res.end();
  });
};
const server = http.createServer(handle);

// ---- 手机访问用的第二个监听：只开在 Tailscale 地址上 ----
// 开关打开、而且这台 Mac 上有 Tailscale 地址时才开；关掉开关或 Tailscale 断了就收掉，连着的手机一起断开。
let remoteServer = null, remoteIp = null;
const remoteSockets = new Set();
function syncRemoteListener() {
  const ip = remote.enabled ? tailscaleIp() : null;
  if (ip === remoteIp) return;
  if (remoteServer) { remoteServer.close(); for (const s of remoteSockets) s.destroy(); remoteSockets.clear(); remoteServer = null; }
  remoteIp = ip;
  if (ip) {
    const srv = http.createServer(handle);
    srv.on('connection', (s) => { remoteSockets.add(s); s.on('close', () => remoteSockets.delete(s)); });
    srv.on('error', (e) => { console.error(`手机访问没能开在 ${ip}:${PORT}：${e.message}`); if (remoteServer === srv) { remoteServer = null; remoteIp = null; } broadcastApp(); });
    srv.listen(PORT, ip, () => { console.log(`手机访问已打开：http://${ip}:${PORT}（只有同一个 Tailscale 账号下的设备连得到）`); broadcastApp(); });
    remoteServer = srv;
  }
  broadcastApp();
}
// 移除一台设备：它正开着的页面立刻断开
function dropDevice(id) {
  for (const res of [...appClients]) {
    if (res.deviceId !== id) continue;
    appClients.delete(res); for (const c of projects.values()) c.clients.delete(res);
    res.socket?.destroy();
  }
}

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`AgentQun · AI 工作群已启动：http://127.0.0.1:${PORT}`);
  prepareIcons(DATA_DIR);
  await detectAgents();
  for (const [a, s] of Object.entries(agentStatus)) console.log(`  @${a}：${s.connected ? '已连接' : '未连接'} —— ${s.detail}${s.fix ? '（' + s.fix + '）' : ''}`);
  for (const entry of registry) { try { openProject(entry); } catch (e) { console.error(`打开项目「${entry.name}」失败：`, e.message); } }
  quota.refreshAll();
  setInterval(() => quota.refreshAll(), 5 * 60 * 1000).unref();
  setInterval(() => detectAgents(), 3 * 60 * 1000).unref();
  syncRemoteListener();
  setInterval(syncRemoteListener, 20000).unref();
});

function shutdown() {
  for (const ctx of projects.values()) { ctx.disp.stopAll(); ctx.disp.dispose(); ctx.stopRpc(); ctx.project.close(); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
