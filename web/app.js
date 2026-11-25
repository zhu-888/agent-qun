// 三栏界面（派工看板版：左边是项目树和成员，中间是当前对话，右边是工单）。数据全部来自工作台的真实状态；页面上所有来自成员或文件的文字都按纯文本渲染。
const $ = (s, el = document) => el.querySelector(s);
const OWNER = '群主';

// ---- 图标：自己画的线条图标 --------------------------------------------------
const ICONS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  'arrow-up': '<path d="M12 19.5V5M5.5 11.5 12 5l6.5 6.5"/>',
  paperclip: '<path d="M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l8.2-8.2a3.4 3.4 0 0 1 4.8 4.8l-8.1 8.1a1.8 1.8 0 0 1-2.5-2.5l7.4-7.4"/>',
  chevron: '<path d="m7 9.5 5 5 5-5"/>',
  pause: '<path d="M8.5 5v14M15.5 5v14"/>',
  play: '<path d="M7.5 5.2v13.6a.5.5 0 0 0 .8.4l10.9-6.8a.5.5 0 0 0 0-.8L8.3 4.8a.5.5 0 0 0-.8.4Z"/>',
  sliders: '<path d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20"/><circle cx="15" cy="7" r="2.5"/><circle cx="9" cy="17" r="2.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  warn: '<path d="M12 4.2 2.8 19.5h18.4L12 4.2Z"/><path d="M12 10.2v4.3M12 17v.1"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.6 4.3v4.4h-4.4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.2M12 19v2.2M2.8 12H5M19 12h2.2M5.5 5.5 7 7M17 17l1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5"/>',
  moon: '<path d="M20 14.2A8.3 8.3 0 0 1 9.8 4a8.3 8.3 0 1 0 10.2 10.2Z"/>',
  half: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"/>',
  bell: '<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15l1.5-2Z"/><path d="M10 20.8a2.2 2.2 0 0 0 4 0"/>',
  tray: '<path d="M3.5 13.5 6 5.5h12l2.5 8v4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-4Z"/><path d="M3.5 13.5h5l1 2.5h5l1-2.5h5"/>',
  card: '<rect x="4" y="4.5" width="16" height="15" rx="3"/><path d="M8 9.5h8M8 13.5h5"/>',
  doc: '<path d="M6.5 3.5h7l4 4v11a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"/><path d="M13.5 3.5v4h4"/>',
  more: '<circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/>',
  people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M17.5 14.6c2 .3 3.3 1.7 3.7 4.2"/>',
  compose: '<path d="M11 5H7.5A2.5 2.5 0 0 0 5 7.5v9A2.5 2.5 0 0 0 7.5 19h9a2.5 2.5 0 0 0 2.5-2.5V13"/><path d="M17.7 4.1a1.8 1.8 0 0 1 2.6 2.6l-7.6 7.6-3.4.8.8-3.4 7.6-7.6Z"/>',
  'folder-open': '<path d="M3.5 16.5v-9a2 2 0 0 1 2-2h3.6l2 2.2h6.4a2 2 0 0 1 2 2v1"/><path d="M3.7 17.6 5.9 12a1.5 1.5 0 0 1 1.4-1h12.3a1.2 1.2 0 0 1 1.1 1.6L18.8 18a2 2 0 0 1-1.9 1.3H5a1.4 1.4 0 0 1-1.3-1.7Z"/>',
  pin: '<path d="M9 4.5h6l-.8 5.2 3 3.3H6.8l3-3.3L9 4.5Z"/><path d="M12 13v6.5"/>',
  pencil: '<path d="m4.5 19.5 1.1-4.5L16.4 4.2a1.9 1.9 0 0 1 2.7 0l.7.7a1.9 1.9 0 0 1 0 2.7L9 18.4l-4.5 1.1Z"/>',
  archive: '<rect x="3.5" y="5" width="17" height="4.5" rx="1.5"/><path d="M5 9.5V17a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.5M10 13.5h4"/>',
  diff: '<path d="M8 4.5v9M3.5 9h9"/><path d="M11.5 19.5h9"/><path d="M15.5 4.5 8.5 19.5" opacity=".55"/>',
  undo: '<path d="M8.5 8.5H15a5 5 0 0 1 0 10h-4"/><path d="m11.5 5-3.5 3.5 3.5 3.5"/>',
};
const svgOf = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
function icon(name) { const s = document.createElement('span'); s.className = 'ico'; s.innerHTML = svgOf(name); return s; }
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = svgOf(el.dataset.icon);

// ---- 小工具 ---------------------------------------------------------------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const md = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const mdhm = (ts) => `${md(ts)} ${hm(ts)}`;
const ago = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 50) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
};
const until = (ts) => {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return '已到重置时间';
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟后`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时后`;
  return `${Math.floor(s / 86400)} 天 ${Math.round((s % 86400) / 3600)} 小时后`;
};
const size = (n) => (n < 1024 ? `${n} 字节` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} 百万` : n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(n));
const base = (p) => p.split('/').pop();
// 消息开头的 @成员（成员表里的全部名字，不分大小写）
const mentionRe = () => new RegExp(`[@＠](?:${(S.app?.members ?? []).map((m) => m.name).join('|') || '(?!)'})\\s*`, 'gi');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式下存不了就算了 */ } },
};
// 成员的图标和颜色来自成员表（S.app.members，服务端的 roster.mjs）。
// 图标是工作台启动时从这台电脑上装好的应用里取出来的（data/icons/，不随项目发布）；取不到的成员、群主和不认识的名字退回成一个字
let MEMBER_ICONS = new Set();
let memberLookKey = '';
function applyMemberLook() {
  const ms = S.app?.members ?? [];
  const key = JSON.stringify(ms.map((m) => [m.name, m.color, m.icon, m.iconDark]));
  if (key === memberLookKey) return;
  memberLookKey = key;
  const css = ms.map((m) => {
    const w = `[data-who="${CSS.escape(m.name)}"]`;
    return [
      m.icon && `.face${w} { background-image: url("${m.icon}"); }`,
      m.iconDark && `:root[data-theme="dark"] .face${w} { background-image: url("${m.iconDark}"); }`,
      `.ag${w} { --who-c: ${m.color.light}; }`,
      `:root[data-theme="dark"] .ag${w} { --who-c: ${m.color.dark}; }`,
      `:root[data-theme="dark"] .msg${w} .msg-head .who { color: ${m.color.dark}; }`,
    ].filter(Boolean).join('\n');
  }).join('\n');
  let el = document.getElementById('member-look');
  if (!el) { el = h('style', { id: 'member-look' }); document.head.append(el); }
  el.textContent = css;
  MEMBER_ICONS = new Set(ms.filter((m) => m.icon).map((m) => m.name));
  // 取不到图标（没装那个应用，或者不是 macOS）时，那位成员退回成两个字母的头像
  for (const m of ms) {
    if (!m.icon) continue;
    const img = new Image();
    img.onerror = () => { MEMBER_ICONS.delete(m.name); renderAll(); };
    img.src = m.icon;
  }
}
function face(who, size = '') {
  if (MEMBER_ICONS.has(who)) return h('span', { class: `face ${size}`, dataset: { who }, 'aria-hidden': 'true' });
  return h('span', { class: `face txt ${size}`, 'aria-hidden': 'true' }, who === OWNER ? '我' : String(who).slice(0, 2));
}
// 成员标记：小图标 + 名字。凡是提到成员的地方都用它
const memTok = (name, title) => h('span', { class: 'mem', title }, face(name, 'xs'), name);
// 钱：统一写两位小数；不到一分钱的写“不到 ¥0.01”
const yuan = (n) => (n > 0 && n < 0.005 ? '不到 ¥0.01' : `¥${Number(n).toFixed(2)}`);

// 下拉菜单开着的时候，不能重画它所在的那一块（一重画，菜单就被关掉了）。
// 浏览器不告诉页面菜单是不是开着，所以自己记：点开的那一刻记下时间；选了一项、焦点离开、或者过了 15 秒，都算关了。
// 以前是看“焦点是不是还在下拉框上”，可选完之后焦点常常还留在上面，结果那一块再也不刷新——选完模型，推理强度的下拉框就出不来。
let menuOpenAt = 0, selectTouchedAt = 0;
document.addEventListener('mousedown', (e) => { if (e.target.tagName === 'SELECT') menuOpenAt = selectTouchedAt = Date.now(); }, true);
document.addEventListener('keydown', (e) => { if (e.target.tagName === 'SELECT' && [' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) menuOpenAt = selectTouchedAt = Date.now(); }, true);
document.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') { menuOpenAt = 0; selectTouchedAt = Date.now(); } }, true);
document.addEventListener('focusout', (e) => { if (e.target.tagName === 'SELECT') menuOpenAt = 0; }, true);
const menuOpenIn = (box) => !!menuOpenAt && Date.now() - menuOpenAt < 15000 && document.activeElement?.tagName === 'SELECT' && box.contains(document.activeElement);

// 通知横幅（右上角滑入，过一会儿自己收起；点一下也会收起）
function toast(text, bad = false) {
  const el = h('div', { class: `banner ${bad ? 'bad' : ''}`, role: bad ? 'alert' : 'status' }, h('span', { class: 'bi' }, icon(bad ? 'warn' : 'check')), h('div', {}, text));
  const box = $('#banners');
  box.prepend(el);
  while (box.children.length > 4) box.lastElementChild.remove();
  const kill = () => { if (!el.isConnected) return; el.classList.add('out'); setTimeout(() => el.remove(), 340); };
  el.addEventListener('click', kill);
  setTimeout(kill, bad ? 6500 : 2800);
}
async function api(path, body, raw) {
  const opt = body === undefined ? { headers: { 'X-Workgroup': '1' } } : {
    method: 'POST',
    headers: { 'X-Workgroup': '1', ...(raw ? {} : { 'Content-Type': 'application/json' }) },
    body: raw ? body : JSON.stringify(body),
  };
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.pair) { location.replace('/pair.html'); throw new Error('还没有配对'); }      // 手机被移除了，或者还没配对
  if (!r.ok) { toast(j.error ?? `请求失败（${r.status}）`, true); throw new Error(j.error ?? r.status); }
  return j;
}

// ---- 外观：跟随系统 / 浅色 / 深色 ------------------------------------------
const THEMES = [['auto', '跟随系统', 'half'], ['light', '浅色', 'sun'], ['dark', '深色', 'moon']];
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const themePref = () => store.get('wg.theme') || 'auto';
function applyTheme() {
  const p = themePref();
  document.documentElement.dataset.theme = p === 'dark' || (p === 'auto' && darkQuery.matches) ? 'dark' : 'light';
}
function setTheme(p) { store.set('wg.theme', p); applyTheme(); renderToolbar(); }
darkQuery.addEventListener('change', applyTheme);

// ---- 状态 -----------------------------------------------------------------
const S = {
  app: null, pid: store.get('wg.pid'), proj: null, activity: {},
  expanded: new Set(), replyTo: null, sayTask: null, tab: 'all', openTimeline: new Set(), pinnedBottom: true, summaryOpen: false,
  seen: null,        // 这个项目里已经画过的消息：只有新来的消息才做出现动画
  openBox: new Set(), // 任务卡里点过“展开全文”的长段落
  cardMode: store.get('wg.cards') === 'full' ? 'full' : 'brief',   // 任务卡显示多少：摘要 / 详细
  cardFlip: new Set(), // 单独点过“详情 / 收起”的任务卡
  outlineAt: null,     // 聊天现在停在我说的哪一句（聊天左边缘那列短线里亮着的那条）
  chat: null,          // 现在看的是哪个对话：数字 = 某个对话，'new' = 新对话，'all' = 整个项目
  lastChat: null,      // 切到“整个项目”之前看的那个对话，方便切回去
  agentOpen: null,     // 点开了哪位成员的详情
  openSteps: new Set(), // 任务卡里点开了“步骤”的那几张
};
const P = (suffix) => `/api/p/${S.pid}/${suffix}`;

async function loadApp() {
  S.app = await api('/api/app');
  document.body.classList.toggle('via-phone', !!S.app.viaPhone);      // 从手机进来的：改设置这类只能在电脑上做的入口收起来
  if (!S.app.projects.some((p) => p.id === S.pid)) S.pid = S.app.projects[0]?.id ?? null;
  if (S.chat == null && S.pid) S.chat = initialChat(S.pid);
  renderToolbar(); renderSidebar();
}
async function loadProject() {
  if (!S.pid) { S.proj = null; S.activity = {}; renderAll(); return; }
  S.proj = await api(P('state'));
  S.activity = S.proj.activity;
  renderAll();
}
// 推送连接：一个标签页只开一条，应用级的事和当前项目的事都走它。
// 浏览器对同一个地址最多同时开 6 条连接；以前每个标签页开两条，同时开三个工作台标签页就占满了，之后所有操作都卡着发不出去。
// 所以：一个标签页一条；切到后台 10 秒后断开，把名额让出来；回到前台再连上，并把状态重新读一遍。
let live = null, liveTimer = null;
function connectProject() {
  clearTimeout(liveTimer);
  live?.close(); live = null;
  if (S.pid) store.set('wg.pid', S.pid);
  if (document.hidden) return;
  const es = new EventSource(`/api/events${S.pid ? `?p=${encodeURIComponent(S.pid)}` : ''}`);
  let t = null;
  es.addEventListener('app', loadAppQuiet);
  es.addEventListener('sync', () => { clearTimeout(t); t = setTimeout(() => { loadProject(); loadAppQuiet(); }, 80); refreshLiveRun(); });
  es.addEventListener('activity', (e) => {
    const before = actShape();
    S.activity = JSON.parse(e.data);
    // 逐字输出时一秒会来好几次：只是字变了，就只重画“正在做”那几行和开着的成员卡片
    if (actShape() === before) { renderLive(); renderAgentPop(); } else { renderToolbar(); renderSidebar(); renderLive(); }
    refreshLiveRun();
  });
  live = es;
}
document.addEventListener('visibilitychange', () => {
  clearTimeout(liveTimer);
  if (document.hidden) { liveTimer = setTimeout(() => { live?.close(); live = null; }, 10000); return; }
  if (live) return;
  connectProject();
  loadApp().then(loadProject).then(markRead).catch(() => {});      // 离开的这段时间里发生了什么，重新读一遍
});
// 换到另一个项目。chat：直接打开那个项目里的哪个对话；不给就回到上次在那个项目里看的对话
function switchProject(id, chat = null) {
  if (id === S.pid) return;
  S.pid = id; S.proj = null; S.activity = {}; S.replyTo = null; S.sayTask = null; S.pinnedBottom = true; S.seen = null; S.summaryOpen = false; S.tab = 'all'; S.outlineAt = null;
  S.lastChat = null; S.chat = chat ?? initialChat(id);
  if (chat != null) store.set(`wg.chat.${id}`, String(chat));
  connectProject(); loadProject().then(markRead);
}
let appT = null;
function loadAppQuiet() {
  clearTimeout(appT);
  appT = setTimeout(async () => {
    S.app = await api('/api/app');
    // 正在看的项目被移除了（比如在另一个标签页里删的）：换到剩下的第一个；一个都不剩就回到空白页
    if (S.pid && !S.app.projects.some((p) => p.id === S.pid)) {
      const next = S.app.projects[0];
      S.pid = null; S.proj = null; S.activity = {}; S.chat = null;
      if (next) switchProject(next.id); else { connectProject(); renderAll(); }
      return;
    }
    renderToolbar(); renderSidebar(); markRead();
  }, 300);
}

function renderAll() { applyMemberLook(); renderToolbar(); renderSidebar(); renderSummary(); renderChat(); renderRail(); renderLive(); renderTasks(); renderComposer(); }

// ---- 菜单（点按钮弹出的那种） ------------------------------------------------
function openMenu(anchor, items, align = 'left') {
  const pop = $('#popover');
  const m = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => {
    if (it === '-') return h('div', { class: 'menu-sep' });
    if (it.header) return h('div', { class: 'menu-label' }, it.header);
    if (it.note) return h('div', { class: 'menu-note' }, it.note);
    return h('button', { class: `menu-item ${it.danger ? 'danger' : ''}`, role: 'menuitem', onclick: () => { closeMenu(); it.onclick?.(); } },
      'checked' in it ? h('span', { class: 'check' }, it.checked ? icon('check') : null) : null,
      it.icon ? icon(it.icon) : null,
      h('span', { class: 'mi-t' }, it.label),
      it.hint ? h('span', { class: 'badge2' }, it.hint) : null);
  }));
  pop.replaceChildren(m);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const x = align === 'right' ? r.right - m.offsetWidth : r.left;
  let y = r.bottom + 6;
  if (y + m.offsetHeight > innerHeight - 10) y = Math.max(10, r.top - m.offsetHeight - 6);
  m.style.left = `${Math.max(10, Math.min(x, innerWidth - m.offsetWidth - 10))}px`;
  m.style.top = `${y}px`;
  m.style.transformOrigin = align === 'right' ? 'top right' : 'top left';
}
function closeMenu() { $('#popover').hidden = true; }
$('#popover').addEventListener('mousedown', (e) => { if (e.target.id === 'popover') closeMenu(); });

// ---- 当前项目、当前对话 -------------------------------------------------------
// 一个项目里有多个对话：群主每提一个需求（一条需求链）就是一个对话，只属于这个项目。S.chat 是现在看的哪一个：
//   数字 = 某个对话；'new' = 新对话（空白页，发出第一句话后变成一个真的对话）；'all' = 整个项目的全部消息
const curProj = () => S.app?.projects.find((p) => p.id === S.pid) ?? null;
const chatInfo = (id = S.chat) => (typeof id === 'number' ? curProj()?.chats.find((c) => c.id === id) ?? null : null);
function initialChat(pid) {
  const p = S.app?.projects.find((x) => x.id === pid);
  const saved = store.get(`wg.chat.${pid}`);
  if (saved === 'all' || saved === 'new') return saved;
  if (saved && p?.chats.some((c) => c.id === Number(saved))) return Number(saved);
  return p?.chats.find((c) => !c.archived)?.id ?? 'new';
}
// 一张任务卡、一条消息属于哪个对话（子任务跟着父任务走）
function taskChat(t) {
  for (let x = t, i = 0; x && i < 8; x = S.proj.tasks.find((k) => k.id === x.parent), i++) if (x.chainId != null) return x.chainId;
  return null;
}
function msgChat(m) {
  if (m.chainId != null) return m.chainId;
  const t = m.taskId && S.proj.tasks.find((k) => k.id === m.taskId);
  return t ? taskChat(t) : null;
}
const inScope = (chain) => S.chat === 'all' || chain === S.chat;
function chatTitleOf(id) {
  return chatInfo(id)?.title ?? S.proj?.messages.find((m) => m.id === id)?.text.replace(mentionRe(), '').slice(0, 40) ?? '对话';
}
function openChat(pid, chat) {
  closeDrawers(); closeAgent();
  if (pid !== S.pid) return switchProject(pid, chat);
  if (typeof S.chat === 'number' && chat !== S.chat) S.lastChat = S.chat;
  S.chat = chat; store.set(`wg.chat.${pid}`, String(chat));
  S.replyTo = null; S.sayTask = null; S.pinnedBottom = true; S.seen = null; S.outlineAt = null; S.tab = 'all';
  renderAll(); markRead();
  if (chat === 'new') $('#input').focus();
}
// 正在看的对话，读到了哪一条：告诉工作台，左栏的“有新消息”圆点才会消掉
const readSent = new Map();
function markRead() {
  const c = chatInfo();
  if (!c) return;
  const key = `${S.pid}:${c.id}`;
  if ((readSent.get(key) ?? 0) >= c.lastId) return;
  readSent.set(key, c.lastId);
  api(P(`chat/${c.id}`), { readId: c.lastId }).catch(() => {});
}

// ---- 中栏顶上那一条：现在看的是哪个对话，右边是状态和常用操作 ----------------------
function togglePause() { if (S.proj) api(P('settings'), { paused: !S.proj.settings.paused }); }
function openProjectFolder(pid = S.pid) { if (pid) api(`/api/p/${pid}/open`, {}); }
// 窄窗口时，左栏和右栏各收成一个抽屉
const narrowRight = matchMedia('(max-width: 1100px)');
function closeDrawers() { document.body.classList.remove('drawer-left', 'drawer-right'); $('#scrim').hidden = true; }
function toggleDrawer(side) {
  const cls = `drawer-${side}`;
  const open = !document.body.classList.contains(cls);
  closeDrawers();
  if (open) { document.body.classList.add(cls); $('#scrim').hidden = false; }
}
function showTasks() { if (narrowRight.matches && !document.body.classList.contains('drawer-right')) toggleDrawer('right'); }
$('#scrim').addEventListener('click', closeDrawers);
addEventListener('resize', () => { if (!$('#scrim').hidden) closeDrawers(); renderAgentPop(); });
function showWaiting(pid = S.pid) { openChat(pid, 'all'); S.tab = 'mine'; renderTasks(); showTasks(); }

function renderToolbar() {
  const p = curProj();
  const paused = !!S.proj?.settings.paused;
  const wait = S.proj?.tasks.filter((t) => t.state === 'awaiting_owner').length ?? 0;
  const running = Object.keys(S.activity ?? {}).length;      // 一位成员可能同时有几个会话
  const bd = S.app?.boundary;
  const title = !p ? '还没有项目' : S.chat === 'new' ? '新对话' : S.chat === 'all' ? '全部消息' : chatTitleOf(S.chat);
  const back = typeof S.chat === 'number' ? S.chat : S.lastChat ?? 'new';
  const ready = p && S.proj;
  $('#mainHead').replaceChildren(...[
    h('button', { class: 'icon-btn only-narrow-left', title: '项目和成员', 'aria-label': '项目和成员', onclick: () => toggleDrawer('left') }, icon('people')),
    h('div', { class: 'mh-title' }, h('h1', { title }, title), p && h('span', { class: 'mh-proj', title: p.dir }, p.name)),
    h('span', { class: 'spacer' }),
    ready && h('div', { class: 'mh-status' },
      paused && h('span', { class: 'st warn', title: '成员暂时不接新活，点右边的播放按钮恢复' }, '已暂停'),
      running ? h('span', { class: 'st', title: '整个项目里正在跑的会话' }, h('span', { class: 'lamp live' }), `${running} 个会话在跑`) : null,
      wait ? h('button', { class: 'st warn', title: '看整个项目里等我验收的任务卡', onclick: () => showWaiting() }, h('span', { class: 'lamp call' }), `${wait} 个等你验收`) : null,
      bd && !bd.ok ? h('span', { class: 'st warn st-bd', title: bd.detail }, icon('warn'), '写入边界：部分未强制') : null),
    ready && h('div', { class: 'segmented', role: 'group', 'aria-label': '看这个对话，还是整个项目' },
      h('button', { class: S.chat !== 'all' ? 'on' : '', 'aria-pressed': S.chat !== 'all' ? 'true' : 'false', title: '只看这个对话的消息和任务卡', onclick: () => { if (S.chat === 'all') openChat(S.pid, back); } }, '本对话'),
      h('button', { class: S.chat === 'all' ? 'on' : '', 'aria-pressed': S.chat === 'all' ? 'true' : 'false', title: '这个项目里所有对话的消息和任务卡，还有收件箱通知和群摘要', onclick: () => { if (S.chat !== 'all') openChat(S.pid, 'all'); } }, '整个项目')),
    h('div', { class: 'mh-actions' },
      ready && bd?.ok && h('span', { class: 'icon-tip st-bd', title: `写入边界：系统强制。${bd.detail}` }, icon('lock')),
      ready && h('button', { class: `icon-btn ${paused ? 'on' : ''}`, title: paused ? '项目已暂停，点这里恢复' : '暂停项目：成员暂时不接新活', 'aria-label': paused ? '恢复项目' : '暂停项目', onclick: togglePause }, icon(paused ? 'play' : 'pause')),
      ready && !S.app?.viaPhone && h('button', { class: 'icon-btn', title: '项目设置', 'aria-label': '项目设置', onclick: settingsDialog }, icon('sliders')),
      h('button', { class: 'btn small only-narrow-right', title: '打开任务卡', onclick: () => toggleDrawer('right') }, '任务', wait ? h('span', { class: 'count' }, wait) : null)),
  ].filter(Boolean));
}

// ---- 两侧栏的宽度：拖分隔条调整。拖得比最窄还窄一截就收起来；收起后点一下边上的小把手（或往外拖）就回来；双击恢复默认宽度 ----
const SIDES = {
  left: { def: 280, min: 220, max: 480, key: 'wg.wLeft', el: '#sidebar', rz: '#rzLeft', drawer: matchMedia('(max-width: 760px)') },
  right: { def: 256, min: 220, max: 560, key: 'wg.wRight', el: '#inspector', rz: '#rzRight', drawer: narrowRight },
};
const MAIN_MIN = 440;          // 中间那栏至少留这么宽
const sideW = {}, sideOpenW = {};
// remember：把这个宽度记成“收起之前的宽度”。拖动途中的宽度不记，不然往里拖着收起时，会把路过的窄宽度记下来
function setSide(side, w, save = true, remember = true) {
  const c = SIDES[side], other = side === 'left' ? 'right' : 'left';
  const room = innerWidth - MAIN_MIN - (SIDES[other].drawer.matches ? 0 : sideW[other] ?? SIDES[other].def);
  const v = w <= 0 ? 0 : Math.round(Math.max(c.min, Math.min(w, c.max, Math.max(c.min, room))));
  sideW[side] = v;
  if (v > 0 && remember) sideOpenW[side] = v;
  $('#app').style.setProperty(`--w-${side}`, `${v}px`);
  // 收起只在它是固定的一栏时才算数；窗口窄到它变成抽屉时，抽屉照常能用
  const collapsed = v === 0 && !c.drawer.matches;
  document.body.classList.toggle(`${side}-collapsed`, collapsed);
  $(c.el).inert = collapsed;
  const rz = $(c.rz);
  rz.setAttribute('aria-valuenow', String(v)); rz.setAttribute('aria-valuemin', '0'); rz.setAttribute('aria-valuemax', String(c.max));
  rz.title = collapsed ? `点一下，或往外拖，把${side === 'left' ? '左' : '右'}栏拉出来` : `拖动调整${side === 'left' ? '左' : '右'}栏宽度；拖到很窄就收起；双击恢复默认`;
  if (save) store.set(c.key, String(v));
}
for (const side of ['left', 'right']) {
  const c = SIDES[side], rz = $(c.rz);
  const saved = store.get(c.key);
  sideOpenW[side] = c.def;
  setSide(side, saved == null || Number.isNaN(Number(saved)) ? c.def : Number(saved), false);
  let drag = null;
  const move = (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
    if (!drag.moved) return;
    const box = $('#app').getBoundingClientRect();
    const raw = side === 'left' ? e.clientX - box.left : box.right - e.clientX;
    setSide(side, raw < c.min - 70 ? 0 : raw, false, false);
  };
  const end = () => {
    if (!drag) return;
    removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
    if (!drag.moved && sideW[side] === 0) setSide(side, sideOpenW[side], false);      // 收起的时候点一下小把手：拉出来
    else if (sideW[side] > 0) sideOpenW[side] = sideW[side];                           // 拖完停在哪个宽度，就记哪个
    drag = null;
    rz.classList.remove('on'); document.body.classList.remove('resizing');
    store.set(c.key, String(sideW[side]));
    closeAgent();
  };
  rz.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { x: e.clientX, moved: false };
    rz.classList.add('on'); document.body.classList.add('resizing');
    // 拖的过程在整个窗口上听：鼠标移得再快、离开这条细线也不会断
    addEventListener('pointermove', move); addEventListener('pointerup', end); addEventListener('pointercancel', end);
  });
  rz.addEventListener('dblclick', () => setSide(side, c.def));
  rz.addEventListener('keydown', (e) => {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft', shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === grow) { e.preventDefault(); setSide(side, sideW[side] === 0 ? c.min : sideW[side] + 16); }
    else if (e.key === shrink) { e.preventDefault(); setSide(side, sideW[side] <= c.min ? 0 : sideW[side] - 16); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSide(side, sideW[side] === 0 ? sideOpenW[side] : 0); }
  });
}
// 窗口大小变了：两侧的宽度重新卡一下范围，别把中间挤没了
addEventListener('resize', () => { for (const side of ['left', 'right']) setSide(side, sideW[side], false); });

// ---- 左栏：照 Codex 应用的样子。顶上是名字、通知、搜索；“新对话”；成员；项目树 ----------
async function refreshQuota() {
  toast('正在重新检测成员和额度…');
  S.app = await api('/api/app/refresh', {});
  renderToolbar(); renderSidebar(); renderComposer();
  toast('已刷新');
}
$('#brandBtn').addEventListener('click', (e) => openMenu(e.currentTarget, [
  { header: '外观' },
  ...THEMES.map(([k, label]) => ({ label, checked: themePref() === k, onclick: () => setTheme(k) })),
  '-', { label: '重新检测成员和额度', icon: 'refresh', onclick: () => refreshQuota().catch(() => {}) },
  ...(S.app?.viaPhone ? [] : [{ label: '手机访问…', onclick: () => phoneDialog() }]),
]));
$('#searchBtn').addEventListener('click', () => openPalette());
$('#newProjBtn').addEventListener('click', () => newProjectDialog());
$('#newChatBtn').addEventListener('click', () => { if (S.pid) openChat(S.pid, 'new'); else newProjectDialog(); });
// 通知：哪个项目有任务卡在等你验收，哪个对话有新消息
function bellItems() {
  const out = [];
  for (const p of S.app?.projects ?? []) {
    if (p.waitingOwner) out.push({ label: p.name, icon: 'tray', hint: `${p.waitingOwner} 张等你验收`, call: true, onclick: () => showWaiting(p.id) });
  }
  for (const p of S.app?.projects ?? []) {
    for (const c of p.chats) {
      if (c.unread && !c.archived && !(p.id === S.pid && c.id === S.chat)) out.push({ label: c.title, icon: 'doc', hint: `${p.name} · 有新消息`, onclick: () => openChat(p.id, c.id) });
    }
  }
  return out;
}
$('#bellBtn').addEventListener('click', (e) => {
  const items = bellItems();
  openMenu(e.currentTarget, items.length ? [{ header: '等你处理的' }, ...items.slice(0, 12)] : [{ note: '现在没有等你处理的事' }], 'right');
});

function renderSidebar() {
  applyMemberLook();
  if (!S.app) return;
  renderAgents(); renderTree(); renderAgentPop();
  const items = bellItems();
  const dot = $('#bellBtn .badge-dot');
  dot.hidden = !items.length;
  dot.classList.toggle('call', items.some((x) => x.call));
}

// ---- 成员：一个小图标，外面一圈是额度还剩多少，下面写着数字。点开看详情、改模型 ----------
// 一位成员现在的状态：灯是什么颜色、写什么字、手上有几个会话
function memberState(m) {
  const acts = Object.values(S.activity ?? {}).filter((x) => x.agent === m.name).sort((x, y) => x.startedTs - y.startedTs);
  const limit = S.proj?.parallel?.[m.name] ?? 1;
  const paused = !!S.proj?.settings.pausedAgents?.includes(m.name);
  const cooling = (S.proj?.cooling?.[m.name] ?? 0) > Date.now();
  const queued = (S.proj?.wakes ?? []).filter((w) => w.target === m.name && ['queued', 'waiting'].includes(w.state)).length;
  let lamp = 'lamp off', state = '未连接';
  if (m.connected) { lamp = 'lamp'; state = queued ? `空闲 · ${queued} 件排队` : '空闲'; }
  if (cooling) { lamp = 'lamp call'; state = '额度用尽，等恢复'; }
  if (paused) { lamp = 'lamp call'; state = '已暂停接活'; }
  if (acts.length) { lamp = 'lamp live'; state = limit > 1 ? `干活中 ${acts.length}/${limit}` : '干活中'; }
  return { acts, limit, paused, lamp, state, idle: lamp === 'lamp' };
}
// 圈上画多少、下面写什么：订阅的成员取最紧的那个额度窗口；按量付费的成员写余额（没有百分比，圈不画进度）
function agentGlance(a) {
  const q = S.app.quota[a.account] ?? {};
  if (!a.connected) return { pct: null, label: '未连接', tone: 'low', tip: `未连接：${a.detail ?? ''}` };
  if (q.state !== 'ok') return { pct: null, label: '—', tone: '', tip: `额度暂不可获取${q.detail ? '：' + q.detail : ''}` };
  if (q.windows?.length) {
    const w = q.windows.reduce((m, x) => (Number(x.remainPct) < Number(m.remainPct) ? x : m));
    const pct = Math.max(0, Math.min(100, Number(w.remainPct) || 0));
    return { pct, label: `${Math.round(pct)}%`, tone: pct <= 0 ? 'out' : pct < 20 ? 'low' : '', tip: q.windows.map((x) => `${x.label}：剩余 ${Math.round(x.remainPct)}%，${resetFull(x)}`).join('\n') };
  }
  const b = q.balance?.balances.find((x) => x.currency === 'CNY') ?? q.balance?.balances[0];
  if (b) return { pct: q.balance.available ? 100 : 0, money: true, label: `${b.currency === 'CNY' ? '¥' : '$'}${Number(b.total).toFixed(2)}`, tone: q.balance.available ? '' : 'out', tip: `按量付费，API 余额 ${b.currency === 'CNY' ? '¥' : '$'}${Number(b.total).toFixed(2)}` };
  return { pct: null, label: '—', tone: '', tip: '' };
}
const RING = 2 * Math.PI * 20;
function ring(pct, tone) {
  const s = document.createElement('span');
  s.className = `ring-svg ${tone}`;
  const arc = pct == null ? '' : `<circle class="rp" cx="22" cy="22" r="20" stroke-dasharray="${((RING * pct) / 100).toFixed(2)} ${RING.toFixed(2)}" transform="rotate(-90 22 22)"/>`;
  s.innerHTML = `<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="rt" cx="22" cy="22" r="20"/>${arc}</svg>`;
  return s;
}
function renderAgents() {
  $('#agentRow').replaceChildren(...S.app.agents.map((a) => {
    const g = agentGlance(a), st = memberState(a);
    return h('button', {
      class: `ag ${S.agentOpen === a.name ? 'on' : ''}`, dataset: { who: a.name }, 'aria-haspopup': 'dialog', 'aria-expanded': S.agentOpen === a.name ? 'true' : 'false',
      'aria-label': `${a.name}：${st.state}，${g.pct == null ? g.label : g.money ? '余额 ' + g.label : '额度剩余 ' + g.label}`, title: `${a.name} · ${st.state}\n${g.tip}\n点开看详情，改模型和推理强度`,
      onclick: () => toggleAgent(a.name),
    },
    h('span', { class: 'ag-ring' }, ring(g.pct, g.tone), face(a.name),
      // 空闲时不亮灯：只有在干活（绿）、要你留意（琥珀）、没接上（空心）时才出现
      st.idle ? null : h('span', { class: st.lamp, style: `--phase:-${Date.now() % 1600}ms` })),
    h('span', { class: `ag-n ${g.tone}` }, g.label));
  }));
}
function closeAgent() { if (!S.agentOpen) return; S.agentOpen = null; $('#agentPop').hidden = true; renderAgents(); }
function toggleAgent(name) { S.agentOpen = S.agentOpen === name ? null : name; renderAgents(); renderAgentPop(); }
function renderAgentPop() {
  const pop = $('#agentPop');
  const a = S.app?.agents.find((x) => x.name === S.agentOpen);
  if (!a) { pop.hidden = true; return; }
  if (menuOpenIn(pop)) return;      // 下拉菜单正开着：先不重画，免得把菜单关掉
  const y = pop.scrollTop;
  pop.replaceChildren(h('div', { class: 'ap-role' }, [a.title, a.billing].filter(Boolean).join(' · ')), memberBlock(a, S.app.quota[a.account] ?? {}, true));
  pop.setAttribute('aria-label', `${a.name} 的详情`);
  pop.hidden = false;
  const r = $('#agentRow').getBoundingClientRect();
  pop.style.top = `${r.bottom + 4}px`;
  pop.style.left = `${Math.max(8, r.left)}px`;
  pop.scrollTop = y;
}
document.addEventListener('mousedown', (e) => {
  if (!S.agentOpen || e.target.closest('#agentPop, #agentRow, #popover, #sheet')) return;
  if (Date.now() - selectTouchedAt < 400) return;      // 刚在下拉菜单里点了一项：这一下不算“点在外面”
  closeAgent();
});

// ---- 项目树：点项目名收起或展开；下面是这个项目里的对话 ------------------------------
const fold = (() => { try { return JSON.parse(store.get('wg.fold') || '{}'); } catch { return {}; } })();
const moreOf = new Set();      // 点过“显示更多”的项目
const archOf = new Set();      // 点开了“已归档”的项目
function toggleFold(pid) { if (fold[pid]) delete fold[pid]; else fold[pid] = 1; store.set('wg.fold', JSON.stringify(fold)); renderTree(); }
// 路径太长时只留最后两段，完整的在提示和修改窗口里
function shortDir(dir) {
  const d = dir.replace(/^\/Users\/[^/]+/, '~');
  const seg = d.split('/');
  return d.length > 30 && seg.length > 3 ? `…/${seg.slice(-2).join('/')}` : d;
}
function chatFlag(c) {
  if (c.waiting) return h('span', { class: 'lamp call c-flag', title: `${c.waiting} 张任务卡等你验收` });
  if (c.stuck) return h('span', { class: 'lamp stop c-flag', title: '有任务卡卡住或被打回' });
  if (c.running) return h('span', { class: 'lamp live c-flag', title: '有成员正在这个对话里干活' });
  if (c.unread) return h('span', { class: 'unread c-flag', title: '有新消息' });
  return null;
}
function renderTree() {
  const box = $('#tree');
  const ps = S.app?.projects ?? [];
  const y = box.scrollTop;
  // 顺序：置顶的 → 各个分组（按名字）→ 没分组的
  const groups = [];
  const pinned = ps.filter((p) => p.pinned);
  if (pinned.length) groups.push(['置顶', pinned]);
  const secs = [...new Set(ps.filter((p) => !p.pinned && p.section).map((p) => p.section))].sort((a, b) => a.localeCompare(b, 'zh'));
  for (const s of secs) groups.push([s, ps.filter((p) => !p.pinned && p.section === s)]);
  const rest = ps.filter((p) => !p.pinned && !p.section);
  if (rest.length) groups.push([groups.length ? '其他' : null, rest]);
  const nodes = [];
  for (const [label, list] of groups) {
    if (label) nodes.push(h('div', { class: 't-sec' }, label));
    for (const p of list) {
      const folded = !!fold[p.id];
      const live = p.chats.filter((c) => !c.archived), gone = p.chats.filter((c) => c.archived);
      const flag = p.waitingOwner ? h('span', { class: 'lamp call p-flag', title: `${p.waitingOwner} 张任务卡等你验收` })
        : p.running.length ? h('span', { class: 'lamp live p-flag', title: `${p.running.join('、')} 正在干活` })
        : live.some((c) => c.unread) ? h('span', { class: 'unread p-flag', title: '有新消息' }) : null;
      nodes.push(h('div', { class: `p-row ${p.id === S.pid ? 'cur' : ''}` },
        h('button', { class: 'p-main', 'aria-expanded': folded ? 'false' : 'true', title: folded ? '点一下展开' : '点一下收起', onclick: () => toggleFold(p.id) },
          icon(folded ? 'folder' : 'folder-open'), h('span', { class: 'p-name' }, p.name)),
        // 鼠标靠近才出现：项目文件夹的路径（点一下修改）、更多、在这个项目里开新对话
        h('button', { class: 'p-path', title: `项目文件夹：${p.dir}\n点一下修改`, 'aria-label': `修改「${p.name}」的项目文件夹，现在是 ${p.dir}`, onclick: () => pathDialog(p) }, shortDir(p.dir)),
        folded || p.id !== S.pid ? flag : null,
        h('span', { class: 'p-tools' },
          h('button', { class: 'icon-btn small', title: '更多：置顶、改名、分组、移除…', 'aria-label': `「${p.name}」的更多操作`, 'aria-haspopup': 'menu', onclick: (e) => projectMenu(e.currentTarget, p) }, icon('more')),
          h('button', { class: 'icon-btn small', title: `在「${p.name}」里开一个新对话`, 'aria-label': `在「${p.name}」里开一个新对话`, onclick: () => openChat(p.id, 'new') }, icon('compose')))));
      if (folded) continue;
      const shown = moreOf.has(p.id) ? live : live.slice(0, 5);
      const chatRow = (c) => h('div', { class: `c-row ${p.id === S.pid && c.id === S.chat ? 'on' : ''} ${c.archived ? 'archived' : ''}` },
        h('button', { class: 'c-main', title: `${c.title}\n${mdhm(c.lastTs)} · ${c.count} 条消息`, 'aria-current': p.id === S.pid && c.id === S.chat ? 'true' : null, onclick: () => openChat(p.id, c.id) }, c.title),
        p.id === S.pid && c.id === S.chat ? null : chatFlag(c),
        h('button', { class: 'icon-btn small c-more', title: '改名、归档', 'aria-label': `对话「${c.title}」的更多操作`, 'aria-haspopup': 'menu', onclick: (e) => chatMenu(e.currentTarget, p, c) }, icon('more')));
      nodes.push(...shown.map(chatRow));
      if (!live.length && !gone.length) nodes.push(h('div', { class: 'c-note' }, '还没有对话'));
      if (live.length > 5) nodes.push(h('button', { class: 'c-note', onclick: () => { moreOf.has(p.id) ? moreOf.delete(p.id) : moreOf.add(p.id); renderTree(); } }, moreOf.has(p.id) ? '收起' : `显示更多（还有 ${live.length - 5} 个）`));
      if (gone.length) {
        nodes.push(h('button', { class: 'c-note', 'aria-expanded': archOf.has(p.id) ? 'true' : 'false', onclick: () => { archOf.has(p.id) ? archOf.delete(p.id) : archOf.add(p.id); renderTree(); } }, archOf.has(p.id) ? '收起已归档的' : `已归档 ${gone.length} 个`));
        if (archOf.has(p.id)) nodes.push(...gone.map(chatRow));
      }
    }
  }
  if (!ps.length) nodes.push(h('div', { class: 'empty' }, '还没有项目，点上面的 + 建一个'));
  box.replaceChildren(...nodes);
  box.scrollTop = y;
  // 换了项目或对话：让左栏里亮着的那一行露出来
  const at = `${S.pid}:${S.chat}`;
  if (at !== treeAt) {
    const row = box.querySelector('.c-row.on');
    if (row || typeof S.chat !== 'number') treeAt = at;        // 刚发出第一句话的新对话，要等列表里有了它那一行再算数
    (row ?? box.querySelector('.p-row.cur'))?.scrollIntoView({ block: 'nearest' });
  }
}
let treeAt = '';

// 问一句话的小窗口（改名、新分组）。取消返回 null，确定返回填的字（可能是空的）
function promptSheet({ title, label, value = '', placeholder = '', okText = '保存', hint = null }) {
  return new Promise((resolve) => {
    let done = false;
    const inp = h('input', { type: 'text', value, placeholder, 'aria-label': label, autocomplete: 'off' });
    const finish = (v) => { if (done) return; done = true; resolve(v); closeSheet(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) finish(inp.value.trim()); });
    sheet({
      title,
      body: h('div', { class: 'form' }, h('div', { class: 'group' },
        h('div', { class: 'rows' }, h('label', { class: 'r' }, h('span', { class: 'rl fixed' }, label), inp)),
        hint && h('div', { class: 'ghint' }, hint))),
      foot: [h('button', { class: 'btn', onclick: () => finish(null) }, '取消'), h('button', { class: 'btn prominent', onclick: () => finish(inp.value.trim()) }, okText)],
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}
const setApp = (r) => { if (r?.app) S.app = r.app; renderToolbar(); renderSidebar(); };
function projectMenu(anchor, p) {
  const secs = [...new Set((S.app?.projects ?? []).map((x) => x.section).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'));
  const meta = (patch) => api(`/api/p/${p.id}/meta`, patch).then(setApp).catch(() => {});
  openMenu(anchor, [
    { label: p.pinned ? '取消置顶' : '置顶', icon: 'pin', onclick: () => meta({ pinned: !p.pinned }) },
    { label: '改名…', icon: 'pencil', onclick: async () => { const v = await promptSheet({ title: '给项目改名', label: '项目名', value: p.name, hint: '只改工作台里显示的名字，文件夹的名字和位置不变' }); if (v && v !== p.name) meta({ name: v }); } },
    { label: '修改路径…', icon: 'folder', onclick: () => pathDialog(p) },
    { label: '在访达中显示', icon: 'folder-open', onclick: () => openProjectFolder(p.id) },
    '-', { header: '放进分组' },
    ...secs.map((s) => ({ label: s, checked: p.section === s, onclick: () => meta({ section: p.section === s ? '' : s }) })),
    { label: '新分组…', icon: 'plus', onclick: async () => { const v = await promptSheet({ title: `把「${p.name}」放进一个新分组`, label: '分组名', placeholder: '例如：课程', okText: '放进去' }); if (v) meta({ section: v }); } },
    '-',
    { label: '全部标为已读', icon: 'check', onclick: () => api(`/api/p/${p.id}/chats`, { readAll: true }).catch(() => {}) },
    { label: '归档全部对话…', icon: 'archive', onclick: async () => {
      if (await confirmSheet({ title: `归档「${p.name}」里的全部对话？`, message: '归档只是从列表里收起来，消息和任务卡都还在；点项目下面的“已归档”可以找回', okText: '全部归档' })) api(`/api/p/${p.id}/chats`, { archiveAll: true }).catch(() => {});
    } },
    '-',
    { label: '从工作台移除…', icon: 'x', danger: true, onclick: async () => {
      const yes = await confirmSheet({ title: `把「${p.name}」从工作台移除？`, message: `只是不再列在这里。文件夹 ${p.dir} 和里面的聊天记录、任务卡、文件都原样留着；以后用同一个文件夹新建项目，它们会回来`, okText: '移除', destructive: true });
      if (!yes) return;
      const r = await api(`/api/p/${p.id}/remove`, {});
      S.app = r.app;
      if (p.id === S.pid) { S.pid = null; S.proj = null; S.activity = {}; const next = S.app.projects[0]; if (next) switchProject(next.id); else { connectProject(); renderAll(); } }
      else setApp();
      toast(`「${p.name}」已从工作台移除，文件都还在`);
    } },
  ], 'right');
}
function chatMenu(anchor, p, c) {
  const patch = (b) => api(`/api/p/${p.id}/chat/${c.id}`, b).catch(() => {});
  openMenu(anchor, [
    { label: '改名…', icon: 'pencil', onclick: async () => { const v = await promptSheet({ title: '给这个对话改名', label: '名字', value: c.title, hint: '留空就恢复成用开头那句话当名字' }); if (v != null) patch({ title: v }); } },
    { label: c.archived ? '取消归档' : '归档', icon: 'archive', onclick: () => patch({ archived: !c.archived }) },
    c.unread ? { label: '标为已读', icon: 'check', onclick: () => patch({ readId: c.lastId }) } : null,
  ], 'right');
}
// 项目文件夹：看它现在在哪，改到别处
function pathDialog(p) {
  const dir = h('input', { type: 'text', value: p.dir, spellcheck: 'false', autocomplete: 'off', 'aria-label': '项目文件夹的路径' });
  const go = async () => {
    const to = dir.value.trim();
    if (!to || to === p.dir) return closeSheet();
    const r = await api(`/api/p/${p.id}/move`, { dir: to });
    closeSheet(); setApp(r);
    if (p.id === S.pid) loadProject();
    toast('项目文件夹已经改到新位置');
  };
  dir.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go(); });
  sheet({
    title: `「${p.name}」的项目文件夹`,
    body: h('div', { class: 'form' }, h('div', { class: 'group' },
      h('div', { class: 'rows' }, h('div', { class: 'r' }, dir,
        h('button', { class: 'btn small', onclick: async () => { const r = await api('/api/app/pick-folder', {}); if (r.dir) dir.value = r.dir; } }, '选择…'))),
      h('div', { class: 'ghint' }, '填一个还不存在的位置（或一个空文件夹），工作台会把整个项目文件夹移过去，聊天记录、任务卡和文件都跟着走。如果你已经在访达里把文件夹挪走了，填它现在的位置就行。有成员正在这个项目里干活时不能改；改完之后，成员各自的会话会从头开始'))),
    foot: [h('button', { class: 'btn', onclick: () => openProjectFolder(p.id) }, '在访达中显示'), h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: closeSheet }, '取消'), h('button', { class: 'btn prominent', onclick: go }, '移到这里')],
  });
  setTimeout(() => { dir.focus(); dir.select(); }, 30);
}

// 额度窗口：一行一个，横条画的是“还剩多少”
const shortLabel = (s) => String(s).replace(/（(.+?)）/g, ' $1').trim();
const resetFull = (w) => (w.resetsAt ? `${mdhm(w.resetsAt)} 重置（${until(w.resetsAt)}）` : w.resetText ? `${zhReset(w.resetText)} 重置`.replace('） 重置', '）重置') : '重置时间未提供');
function resetShort(w) {
  if (w.resetsAt) {
    const d = new Date(w.resetsAt);
    return d.toDateString() === new Date().toDateString() ? hm(w.resetsAt) : `${d.getMonth() + 1}/${d.getDate()}`;
  }
  const m = w.resetText && /^(\d+)月(\d+)日/.exec(zhReset(w.resetText));
  return m ? `${m[1]}/${m[2]}` : '—';
}
function quotaRow(w) {
  const pct = Math.max(0, Math.min(100, Number(w.remainPct) || 0));
  return h('div', { class: `q-row ${pct <= 0 ? 'out' : pct < 20 ? 'low' : ''}`, title: `${w.label}：剩余 ${Math.round(pct)}%（已用 ${Math.round(100 - pct)}%），${resetFull(w)}` },
    h('span', { class: 'ql' }, shortLabel(w.label)),
    h('span', { class: 'qbar' }, h('i', { style: `width:${pct}%` })),
    h('span', { class: 'qp' }, `${Math.round(pct)}%`),
    h('span', { class: 'qr' }, resetShort(w)));
}
function quotaBlock(q, billing) {
  if (q.state === '未连接') return h('div', { class: 'qnone' }, h('b', {}, '未连接'), q.detail ? `：${q.detail}` : '');
  if (q.state !== 'ok') return h('div', { class: 'qnone' }, h('b', {}, '额度暂不可获取'), q.detail ? `：${q.detail}` : '');
  const out = [];
  if (q.windows?.length) {
    out.push(h('div', { class: 'q-row q-head', 'aria-hidden': 'true' }, h('span', { class: 'ql' }, `${/订阅/.test(billing ?? '') ? '订阅' : ''}额度`), h('span', {}), h('span', { class: 'qp' }, '剩余'), h('span', { class: 'qr' }, '重置')));
    out.push(...q.windows.map(quotaRow));
  }
  if (q.balance) {
    for (const b of q.balance.balances.filter((x) => Number(x.total) > 0 || x.currency === 'CNY')) {
      out.push(h('div', { class: 'q-line' }, h('span', {}, `按量付费 · API 余额${b.currency === 'CNY' ? '' : `（${b.currency}）`}`), h('b', {}, `${b.currency === 'CNY' ? '¥' : '$'}${Number(b.total).toFixed(2)}`)));
    }
    if (q.since) out.push(h('div', { class: 'q-line', title: '所有项目合计，按官方余额接口前后相减得到，是真实扣费' },
      h('span', {}, `${mdhm(q.since.ts)} 起实际扣费`), h('b', {}, `¥${q.since.spentCny.toFixed(2)}`)));
    if (!q.balance.available) out.push(h('div', { class: 'qnone' }, '余额不足，接口显示不可用'));
  }
  return out;
}
// 额度下面的一行小字：这个项目用了多少、额度是几点读到的。点开看全部细节
function footLine(account, q, onclick) {
  const sp = S.proj?.spend[account];
  const bits = [];
  if (S.proj) bits.push(!sp ? '本项目还没运行' : sp.currency ? `本项目 ${sp.runs} 次 · 约 ${yuan(sp.cost)}` : `本项目 ${sp.runs} 次运行`);
  if (q.state === 'ok' && q.fetchedTs) bits.push(`${hm(q.fetchedTs)} 更新`);
  if (!bits.length) return null;
  const kids = [bits.join(' · '), q.stale && h('span', { class: 'warn' }, ' · 缓存已过期'), q.error && h('span', { class: 'warn' }, ' · 上次刷新失败')];
  return onclick
    ? h('button', { class: 'm-foot', title: '点开看额度来源、本项目消耗和上次运行的速度', onclick }, kids)
    : h('div', { class: 'm-foot' }, kids);
}

// Claude 命令行给的重置时间是英文（“Nov 17 at 1:59am (Asia/Shanghai)”），换成中文写法；认不出就原样显示
function zhReset(text) {
  const m = /^(\w{3})\w* (\d{1,2})(?:,? at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)(?: \((.+)\))?$/i.exec(String(text).trim());
  if (!m) return text;
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase()) + 1;
  if (!mon) return text;
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'pm') hour += 12;
  return `${mon}月${Number(m[2])}日 ${pad(hour)}:${m[4] ?? '00'}${m[6] ? `（${m[6]} 时间）` : ''}`;
}

const stopBtn = (runId, title) => h('button', { class: 'stop-btn', title, 'aria-label': title, onclick: () => api(P(`run/${runId}/stop`), {}) }, h('i'));
// 最近一次真实运行的速度：首次响应 = 启动到第一个动作；速度 = 输出 token ÷ 第一个动作之后的用时（粗略值）
function lastSpeed(name) {
  const done = S.proj?.runs.find((r) => r.agent === name && r.endedTs && r.firstOutTs && r.kind !== 'summary');
  if (!done) return null;
  const gen = Math.max(1, (done.endedTs - done.firstOutTs) / 1000);
  const speed = done.usage?.output && gen >= 5 ? `${(done.usage.output / gen).toFixed(1)} token/秒，` : '';   // 太短的运行算出来的速度没有意义
  return `上次运行：${speed}首次响应 ${((done.firstOutTs - done.startedTs) / 1000).toFixed(1)} 秒，${ago(done.endedTs)}。速度是输出 token 除以运行用时，包含执行命令的时间，只是粗略值`;
}
// 成员的“···”菜单：把不常看的细节（来源、消耗、速度）和不常用的操作收在这里
function memberMenu(anchor, m, q, own, ctx) {
  const items = [{ header: `@${m.name} · ${m.title}` }];
  if (m.detail) items.push({ note: m.detail });
  if (own && q.state === 'ok') {
    for (const w of q.windows ?? []) items.push({ note: `${w.label}：剩余 ${Math.round(w.remainPct)}%，${resetFull(w)}` });
    if (q.since) items.push({ note: `${mdhm(q.since.ts)} 以来实际扣费 ¥${q.since.spentCny.toFixed(2)}（所有项目合计，按官方余额前后相减，是真实扣费）` });
    items.push({ note: `额度来源：${q.source}。${hm(q.fetchedTs)} 更新（${ago(q.fetchedTs)}）${q.stale ? '，缓存已过期' : ''}${q.plan ? `。套餐 ${q.plan}` : ''}` });
    if (q.note) items.push({ note: q.note });
    if (q.error) items.push({ note: `上次刷新失败：${q.error}` });
  }
  const sp = S.proj?.spend[m.account];
  if (sp) items.push({ note: `本项目：${sp.runs} 次运行，输入 ${tok(sp.input)}（其中缓存命中 ${tok(sp.cached)}）/ 输出 ${tok(sp.output)} token。${sp.currency ? `按官方价估算 ${yuan(sp.cost)}` : '走订阅额度，不另收费'}` });
  const speed = lastSpeed(m.name);
  if (speed) items.push({ note: speed });
  if (ctx.limit > 1) items.push({ note: `最多同时开 ${ctx.limit} 个会话，每张任务卡一个` });
  items.push('-');
  if (S.proj && m.connected) items.push({ label: ctx.paused ? '恢复接活' : '暂停接活', icon: ctx.paused ? 'play' : 'pause', onclick: () => api(P(`agent/${m.name}/${ctx.paused ? 'resume' : 'pause'}`), {}) });
  if (ctx.acts.length > 1) items.push({ label: `停止 @${m.name} 的全部会话`, danger: true, onclick: () => api(P(`agent/${m.name}/stop`), {}) });
  items.push({ label: '重新检测成员和额度', icon: 'refresh', onclick: () => refreshQuota().catch(() => {}) });
  openMenu(anchor, items);
}
function memberBlock(m, q, own) {
  // 这位成员正在跑的会话（并行时不止一个）
  const { acts, limit, paused, lamp, state } = memberState(m);
  const more = (e) => memberMenu(e.currentTarget, m, q, own, { acts, limit, paused });
  const body = [];
  if (!m.connected) body.push(h('div', { class: 'm-fix' }, m.detail, m.fix ? `。${m.fix}` : ''));
  else if (S.proj) {
    const cat = S.app.catalog?.[m.name] ?? { models: [] };
    const lastRun = S.proj.runs.find((r) => r.agent === m.name);
    if (cat.locked) {
      body.push(h('div', { class: 'm-sub', title: '群主指定这位成员只用这一个模型和这一档推理强度；自动选模型、任务卡档位都不会换它。要换，到设置里改“固定用的模型”' },
        h('span', { class: 'fixed' }, '固定 ', h('b', {}, `${modelLabel(m.name, cat.locked.model)} · ${cat.locked.effort}`))));
    } else {
      // 手动指定：先选模型，再选推理强度。旧写法（“模型|档位”的字符串）也认
      const manual = S.proj.settings.memberModel?.[m.name];
      const cur = manual && typeof manual === 'object' ? manual : manual && manual !== 'auto' ? { model: String(manual).split('|')[0], effort: null } : null;
      const curModel = cur ? cat.models.find((x) => x.id === cur.model) : null;
      // 选完马上在界面上改过来（推理强度的下拉框立刻出现），同时告诉工作台；没改成的话再按工作台那边的为准
      const setModel = (model, effort) => {
        const pick = model === 'auto' ? 'auto' : { model, effort: effort ?? cat.models.find((x) => x.id === model)?.defaultEffort ?? null };
        S.proj.settings.memberModel = { ...S.proj.settings.memberModel, [m.name]: pick };
        renderAgentPop();
        api(P(`agent/${m.name}/model`), { model, effort }).catch(() => loadProject());
      };
      body.push(h('div', { class: 'm-sub' },
        h('select', { class: 'pill', title: '这位成员用哪个模型。选“自动”时按任务类型和阶段选；选了具体模型，后面再选推理强度', 'aria-label': `@${m.name} 的模型`, onchange: (e) => { const v = e.target.value; e.target.blur(); setModel(v); } },
          h('option', { value: 'auto', selected: !cur }, '自动选模型'),
          cat.models.map((x) => h('option', { value: x.id, selected: cur?.model === x.id }, x.label + (x.source === 'custom' ? '（自己加的）' : ''))),
          cur && !curModel && h('option', { value: cur.model, selected: true }, cur.model)),
        cur
          ? [h('span', { class: 'lbl' }, '推理'),
            h('select', { class: 'pill effort', title: '推理强度：越高想得越久，也越费额度', 'aria-label': `@${m.name} 的推理强度`, onchange: (e) => { const v = e.target.value; e.target.blur(); setModel(cur.model, v); } },
              (curModel?.efforts ?? S.app.efforts ?? []).map((ef) => h('option', { value: ef, selected: cur.effort === ef }, ef)))]
          : !acts.length && lastRun && h('span', { class: 'last', title: `上次用 ${runModel(lastRun)}（${lastRun.modelBy ?? ''}）` }, `上次 ${modelLabel(m.name, lastRun.model)}`)));
    }
  } else body.push(h('div', { class: 'm-sub' }, [m.billing, m.title].filter(Boolean).join(' · ')));
  if (own && (m.connected || q.state !== '未连接')) body.push(quotaBlock(q, m.billing), footLine(m.account, q, more));
  if (S.proj && m.connected) {
    // 手上接了、但此刻没有会话在跑的任务卡
    const running = new Set(acts.map((x) => x.taskId).filter(Boolean));
    const holding = S.proj.tasks.filter((t) => t.owner === m.name && ['accepted', 'working'].includes(t.state) && !running.has(t.id)).slice(0, 4);
    if (holding.length) body.push(h('div', { class: 'm-hold' }, '手上还有', holding.map((t) => h('button', { class: 'chip task', title: t.title, onclick: () => focusTask(t.id) }, t.id))));
  }
  // 每个正在跑的会话一行：管哪张卡、用什么模型、正在做什么，可以单独停
  for (const act of acts) {
    body.push(h('div', { class: 'session', title: `${runModel(act)}（${act.modelBy ?? ''}）\n${act.text ?? ''}\n这个会话能写：${(act.writable ?? []).join('、') || '无'}` },
      h('div', { class: 'se-txt' },
        h('div', { class: 'se-top' }, h('b', {}, laneName(act)), h('span', {}, runModel(act))),
        actText('se-cmd', act.text, act.kind)),
      stopBtn(act.runId, `停止 @${m.name} 的这个会话`)));
  }
  if (m.warn) body.push(h('div', { class: 'm-warn' }, m.warn));
  return h('div', { class: 'member' },
    h('div', { class: 'm-head' },
      face(m.name),
      h('span', { class: 'm-name', title: m.title }, m.name),
      // 界面会整块重画：用当前时间算出动画相位，圆点的呼吸不会每次重画都从头开始
      h('span', { class: 'm-state' }, h('span', { class: lamp, style: `--phase:-${Date.now() % 1600}ms` }), state),
      h('button', { class: 'icon-btn small', title: `@${m.name} 的详情和操作`, 'aria-label': `@${m.name} 的详情和操作`, 'aria-haspopup': 'menu', onclick: more }, icon('more'))),
    h('div', { class: 'm-body' }, body));
}
// 一个会话管的是哪件事
function laneName(act) { return act.kind === 'summary' ? '群摘要' : act.taskId ?? '日常对话'; }
function modelLabel(agent, model) {
  if (!model) return '';
  return S.app.catalog?.[agent]?.models.find((x) => x.id === model)?.label ?? model;
}
// 一次运行 / 一个会话用的是什么：模型名 · 推理强度
const runModel = (r) => `${modelLabel(r.agent, r.model)}${r.effort ? ' · ' + r.effort : ''}`;

// ---- 中栏：群聊 -------------------------------------------------------------
const PATH_RE = /((?:收件箱|共享区|成员)\/[^\s，。；、）)"'`［\]〔〕]+)/;
// 消息里要画成标记的东西：行内代码、@成员（成员表里的全部名字）和 @群主、文件路径、任务卡号。成员表变了就重建
let tokenReKey = '', tokenReCache = null;
function tokenRe() {
  const names = (S.app?.members ?? []).map((m) => m.name);
  const key = names.join('|');
  if (key !== tokenReKey || !tokenReCache) {
    tokenReKey = key;
    tokenReCache = new RegExp(`(\`[^\`\\n]+\`)|([@＠](?:${[...names, '群主'].join('|')}))|${PATH_RE.source}|(\\bT\\d+\\b)`, 'g');
  }
  return tokenReCache;
}

function inlineText(part) {
  const out = [];
  let last = 0;
  for (const m of part.matchAll(tokenRe())) {
    if (m.index > last) out.push(part.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      const inner = m[1].slice(1, -1);
      const pm = PATH_RE.exec(inner);
      out.push(pm && pm[1] === inner ? fileChip(inner) : h('code', {}, inner));
    } else if (m[2]) out.push(m[2].slice(1) === OWNER ? h('span', { class: 'at owner' }, '@' + OWNER) : memTok(m[2].slice(1)));
    else if (m[3]) out.push(fileChip(m[3].replace(/[.:：]+$/, '')), m[3].match(/[.:：]+$/)?.[0] ?? '');
    else if (m[4]) out.push(S.proj?.tasks.some((t) => t.id === m[4]) ? h('button', { class: 'chip task', onclick: () => focusTask(m[4]) }, m[4]) : m[4]);
  }
  if (last < part.length) out.push(part.slice(last));
  return out;
}
// 成员常用 Markdown 写回复：这里只认代码块、加粗和标题，其余按原文显示
function richText(text) {
  const out = [];
  for (const part of String(text).split(/(```[\s\S]*?```)/g)) {
    if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
      out.push(h('pre', {}, part.slice(3, -3).replace(/^[a-zA-Z0-9]*\n/, '')));
      continue;
    }
    const withHeads = part.replace(/^#{1,4}\s+(.+)$/gm, '**$1**');
    for (const seg of withHeads.split(/(\*\*[^*\n]+\*\*)/g)) {
      if (/^\*\*[^*\n]+\*\*$/.test(seg)) out.push(h('b', {}, inlineText(seg.slice(2, -2))));
      else if (seg) out.push(...inlineText(seg));
    }
  }
  return out;
}
function fileChip(path) { return h('button', { class: 'chip', title: '打开这个文件', onclick: () => openFile(path) }, path); }
function fileCard(f) {
  const name = base(f.path);
  const ext = (/\.([a-z0-9]{1,4})$/i.exec(name)?.[1] ?? '').toLowerCase();
  return h('button', { class: 'filecard', title: `${f.path}\n点开预览`, onclick: () => openFile(f.path) },
    h('span', { class: 'fi' }, ext),
    h('span', { class: 'fn' }, h('span', { class: 'fname' }, name), h('span', { class: 'fmeta' }, [size(f.size), f.sha && `版本 ${f.sha}`].filter(Boolean).join(' · '))));
}

// ---- 群摘要 ---------------------------------------------------------------
function makeSummary() { return api(P('summary'), {}).then((r) => toast(`已让 @${r.agent} 整理群摘要`)).catch(() => {}); }
function renderSummary() {
  const bar = $('#summaryBar');
  if (!S.proj || S.chat !== 'all') { bar.replaceChildren(); return; }      // 群摘要是整个项目的：只在“整个项目”里显示
  const sm = S.proj.summary ?? {};
  const kids = [h('b', {}, icon('doc'), '群摘要')];
  if (sm.running) kids.push(h('span', { class: 'muted' }, memTok(sm.writer), ' 正在整理…'));
  else if (sm.text) kids.push(h('span', { class: 'muted', title: `模型 ${sm.model ?? ''}，${sm.by === '自动' ? '自动更新' : '群主点的更新'}` },
    memTok(sm.agent), ` 整理 · ${mdhm(sm.ts)} · ${sm.newCount ? `之后又有 ${sm.newCount} 条发言` : '已是最新'}`));
  else kids.push(h('span', { class: 'muted', title: '让一位成员把群里的情况整理成一页，新接手的成员会先读它' }, '还没有，可以让一位成员把群里的情况整理成一页'));
  kids.push(h('span', { class: 'spacer' }));
  if (sm.text) {
    kids.push(h('button', { class: 'linkbtn', onclick: () => { S.summaryOpen = !S.summaryOpen; renderSummary(); } }, S.summaryOpen ? '收起' : '展开'));
    kids.push(h('button', { class: 'linkbtn', onclick: () => openFile(sm.path) }, '打开文件'));
  }
  const nothingNew = !!sm.text && !sm.newCount;
  kids.push(h('button', {
    class: 'btn small', disabled: sm.running || nothingNew, title: nothingNew ? '上次整理之后群里没有新的发言' : `由 @${sm.writer} 用快速档模型整理`,
    onclick: makeSummary,
  }, sm.text ? '更新' : '生成摘要'));
  const parts = [h('div', { class: 'sum-head' }, kids)];
  if (S.summaryOpen && sm.text) parts.push(h('div', { class: 'sum-body msg-body' }, richText(sm.text)));
  bar.replaceChildren(...parts);
}

function delivText(w) {
  if (w.state === 'delivered' && w.note?.startsWith('已送到')) return inlineText(w.note);
  if (w.state === 'queued' && /已写入/.test(w.note ?? '')) return [memTok(w.target), '已写进会话，等它读到'];
  if (w.state === 'queued' && /正在干活/.test(w.note ?? '')) return [memTok(w.target), '已入队，等它这一步结束'];
  return [memTok(w.target), DELIV[w.state] ?? w.state];
}
const DELIV = { waiting: '等前置任务', queued: '已入队', delivered: '已送达', accepted: '已接单', done: '已处理', failed: '送达失败', held: '已拦下', cancelled: '已取消' };

function renderChat() {
  const chat = $('#chat');
  if (!S.proj) {
    const none = !S.app?.projects.length;
    chat.replaceChildren(h('div', { class: 'hero' },
      h('h2', {}, none ? '建一个工作群' : '正在打开项目…'),
      none && h('p', {}, '一个项目就是一个工作群，对应一个本地文件夹。说目标，或者 @ 某位成员，他们会拆任务、交接、相互审查，最后把成果交给你验收。'),
      none && h('button', { class: 'btn prominent', onclick: newProjectDialog }, icon('plus'), '新建项目')));
    return;
  }
  if (S.chat === 'new') {
    // 新对话：一张空白页。发出第一句话，它就成了这个项目里的一个对话
    chat.replaceChildren(h('div', { class: 'hero center' },
      h('div', { class: 'hero-faces' }, (S.app?.agents ?? []).map((a) => face(a.name, 'l'))),
      h('h2', {}, `在「${S.proj.name}」里做什么？`),
      h('p', {}, '说目标，或者 @ 一位成员。这个对话只属于这个项目')));
    return;
  }
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  const keep = chat.scrollTop;
  const first = S.seen == null;
  if (first) S.seen = new Set();
  const nodes = [];
  let lastDay = '';
  const byId = new Map(S.proj.messages.map((m) => [m.id, m]));
  // 一次运行可能说了好几段话：“改了几个文件”只挂在它最后一段话下面
  const lastOfRun = new Map();
  for (const m of S.proj.messages) if (m.runId && m.kind === 'chat') lastOfRun.set(m.runId, m.id);
  for (const m of S.proj.messages) {
    if (!inScope(msgChat(m))) continue;        // 只画现在看的这个对话
    const day = md(m.ts);
    if (day !== lastDay) { nodes.push(h('div', { class: 'day' }, day)); lastDay = day; }
    const fresh = !first && !S.seen.has(m.id) ? 'new' : '';
    S.seen.add(m.id);
    if (m.kind !== 'chat') { nodes.push(sysRow(m, fresh)); continue; }
    const me = m.sender === OWNER;
    const run = m.runId ? S.proj.runs.find((r) => r.id === m.runId) : null;
    const long = m.text.length > 420 || m.text.split('\n').length > 7;
    const open = S.expanded.has(m.id);
    const wakes = S.proj.wakesByMsg[m.id] ?? [];
    const quoted = m.replyTo ? byId.get(m.replyTo) : null;
    // 成员的话靠左平铺：头像、名字、模型、时间，下面是正文。群主自己的话靠右（样式里按 .me 处理）
    nodes.push(h('article', { class: `msg ${me ? 'me' : ''} ${m.meta?.stale ? 'stale' : ''} ${fresh}`, id: `m${m.id}`, dataset: { who: m.sender } },
      face(m.sender),
      h('div', { class: 'msg-main' },
        h('div', { class: 'msg-head' },
          h('span', { class: 'who' }, m.sender),
          run && h('span', { class: 'model', title: `${run.effort ? '推理 ' + run.effort + '；' : ''}${run.modelBy ?? ''}` }, modelLabel(m.sender, run.model)),
          h('time', { class: 'time' }, hm(m.ts)),
          m.taskId && h('button', { class: 'chip task', title: '看这张任务卡', onclick: () => focusTask(m.taskId) }, m.taskId)),
        quoted && h('button', { class: 'quote', title: '跳到被回复的那条消息', onclick: () => $(`#m${quoted.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }, `回复 ${quoted.sender}：${quoted.text.slice(0, 80)}`),
        h('div', { class: `msg-body ${long && !open ? 'clamp' : ''}` }, richText(m.text)),
        m.files.length ? h('div', { class: 'files' }, m.files.map(fileCard)) : null,
        m.meta?.stale ? staleNote(m) : null,
        h('div', { class: 'msg-foot' },
          wakes.map((w) => h('span', { class: `deliv ${w.state}`, title: w.note || '' }, delivText(w),
            w.state === 'failed' && h('button', { onclick: () => api(P(`wake/${w.id}/retry`), {}) }, '重试'))),
          long && h('button', { onclick: () => { open ? S.expanded.delete(m.id) : S.expanded.add(m.id); renderChat(); } }, open ? '收起' : '展开全文'),
          run?.changes?.n && lastOfRun.get(run.id) === m.id ? changeBtn(run) : null,
          run && h('button', { onclick: () => runDialog(run.id) }, '查看过程'),
          h('button', { onclick: () => { S.replyTo = m.id; S.sayTask = null; $('#asTask').checked = false; renderComposer(); $('#input').focus(); } }, '回复')))));
  }
  if (!nodes.length) nodes.push(h('div', { class: 'empty' }, '这里还没有消息，在下面说目标，或者 @ 一位成员'));
  chat.replaceChildren(...nodes);
  chat.scrollTop = nearBottom || S.pinnedBottom ? chat.scrollHeight : keep;
  S.pinnedBottom = false;
}
// 成员干活期间，它这张卡被别人推进了：这条话写的时候还不知道后来的进展。里面 @ 的成员先没叫醒，由群主决定要不要照样送出
function staleNote(m) {
  const s = m.meta.stale;
  const peers = (m.mentions ?? []).filter((n) => n !== OWNER);
  const waiting = peers.length && !s.forwarded;
  const kids = [h('span', { class: 'stale-tag' }, '已过时'), h('span', {}, `${s.text}。`)];
  if (s.forwarded) kids.push(h('span', {}, '你已让它照样送出。'));
  else if (peers.length) {
    kids.push(h('span', {}, ...richText(`这条里的 ${peers.map((n) => '@' + n).join(' ')} 先没有叫醒。`)));
    kids.push(h('button', { class: 'btn small', onclick: () => api(P(`msg/${m.id}/forward`), {}) }, '照样送出'));
  }
  return h('div', { class: `stale-note ${waiting ? 'wait' : ''}` }, kids);
}

function sysRow(m, fresh) {
  // 提醒群主的消息做成通知条；对应的任务已经处理完（不再等验收、不再卡住）就恢复成普通小字
  const task = m.taskId ? S.proj.tasks.find((t) => t.id === m.taskId) : null;
  const still = !task || ['awaiting_owner', 'blocked'].includes(task.state) || m.meta?.hold != null || m.meta?.failedRun;
  const need = still && ((m.meta?.mentions ?? []).includes(OWNER) || /@群主/.test(m.text));
  const body = [h('time', { class: 'time' }, hm(m.ts)), h('span', {}, richText(m.text))];
  if (m.files?.length) body.push(h('div', { class: 'files' }, m.files.map(fileCard)));
  const acts = [];
  if (m.meta?.hold != null && (S.proj.wakes ?? []).some((w) => w.state === 'held' && w.chainId === m.meta.hold)) {
    acts.push(h('button', { class: 'btn small prominent', onclick: () => api(P(`hold/${m.meta.hold}/release`), { extra: 6 }) }, '放行，再交接 6 次'));
  }
  if (m.meta?.failedRun) {
    const w = (S.proj.wakes ?? []).filter((x) => x.state === 'failed' && (x.runId == null || x.runId === m.meta.failedRun));
    if (w.length) acts.push(h('button', { class: 'btn small', onclick: () => Promise.all(w.map((x) => api(P(`wake/${x.id}/retry`), {}))) }, '重试'));
    acts.push(h('button', { class: 'btn small', onclick: () => runDialog(m.meta.failedRun) }, '查看过程'));
  } else if (m.meta?.run) {
    acts.push(h('button', { class: 'btn small', onclick: () => runDialog(m.meta.run) }, '查看过程'));
  }
  if (acts.length) body.push(h('div', { class: 'acts' }, acts));
  if (need) return h('div', { class: `sys need ${fresh}`, id: `m${m.id}` }, h('span', { class: 'bell' }, icon('bell')), h('div', { class: 'sbody' }, body));
  return h('div', { class: `sys ${fresh}`, id: `m${m.id}` }, body);
}

// ---- 聊天左边缘的一列短线：一条线 = 我说过的一句话 ------------------------------
// 指上去弹出那句话的预览（确认是不是它），点一下，聊天直接跳到那条消息并亮一下
// 这句话引出的任务卡现在怎么样了：琥珀＝有卡在等你，红＝有卡卡住，绿＝还在做，对勾＝都做完了
function chainTone(m) {
  const ts = (S.proj?.tasks ?? []).filter((t) => t.originMsg === m.id || (m.chainId != null && t.chainId === m.chainId));
  if (!ts.length) return null;
  if (ts.some((t) => t.state === 'awaiting_owner')) return ['call', '有任务卡在等你验收'];
  if (ts.some((t) => ['blocked', 'rejected'].includes(t.state))) return ['stop', '有任务卡卡住或被打回'];
  if (ts.some((t) => !['done', 'cancelled'].includes(t.state))) return ['go', '任务还在做'];
  return ['done', '任务都做完了'];
}
let railSig = '';
function renderRail() {
  const rail = $('#rail');
  // 只算现在看的这个对话里我说过的话；新对话的空白页上没有
  const mine = S.chat === 'new' ? [] : (S.proj?.messages ?? []).filter((m) => m.kind === 'chat' && m.sender === OWNER && inScope(msgChat(m)));
  rail.hidden = mine.length < 2;                  // 只说过一句话时用不着
  // 内容没变就不重画：不然鼠标正指着的那条线会被换掉，预览跟着闪
  const sig = `${S.pid}|${S.chat}|` + mine.map((m) => `${m.id}:${chainTone(m)?.[0] ?? ''}`).join(',');
  if (sig !== railSig) {
    railSig = sig;
    hideTip(true);
    rail.replaceChildren(...mine.map((m) => h('button', {
      class: `tick ${chainTone(m)?.[0] === 'call' ? 'call' : ''}`, dataset: { mid: m.id },
      'aria-label': `${mdhm(m.ts)} 我说的：${m.text.slice(0, 60)}`,
      onclick: () => jumpToMessage(m.id),
      onmouseenter: (e) => showTip(e.currentTarget, m), onmouseleave: hideTip,
      onfocus: (e) => showTip(e.currentTarget, m), onblur: hideTip,
    }, h('i'))));
  }
  markOutline();
  spyOutline();      // 聊天内容变了（或者短到不用滚动）：重新看一眼现在停在哪一句
}
// 预览：时间、@ 了谁、那句话的开头几行、它引出的任务卡的状态
let tipTimer = 0;
function showTip(el, m) {
  clearTimeout(tipTimer);
  const tip = $('#railTip'), wrap = $('#chatWrap');
  const tone = chainTone(m);
  const names = (m.mentions ?? []).filter((x) => x !== OWNER);
  const parts = [
    h('div', { class: 'tip-head' }, h('time', {}, mdhm(m.ts)), names.length ? h('span', { class: 'faces' }, names.map((x) => face(x, 'xs'))) : null),
    h('div', { class: 'tip-text' }, m.text.replace(new RegExp(`^(?:${mentionRe().source})+`), '') || m.text),
  ];
  if (tone) parts.push(h('div', { class: 'tip-foot' }, tone[0] === 'done' ? icon('check') : h('span', { class: `lamp ${tone[0]}` }), tone[1]));
  tip.replaceChildren(...parts);
  tip.hidden = false;
  const r = el.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  const y = r.top + r.height / 2 - w.top - tip.offsetHeight / 2;
  tip.style.top = `${Math.max(8, Math.min(y, wrap.clientHeight - tip.offsetHeight - 8))}px`;
}
// 稍等一下再收：鼠标沿着短线一条条滑过去时，预览只换内容、不闪
function hideTip(now = false) {
  clearTimeout(tipTimer);
  if (now === true) $('#railTip').hidden = true;
  else tipTimer = setTimeout(() => { $('#railTip').hidden = true; }, 120);
}
let spyLock = 0;
function jumpToMessage(id) {
  const el = $(`#m${id}`);
  if (!el) return;
  closeDrawers();
  spyLock = Date.now() + 900;                 // 滚动途中先别改高亮，免得一路闪过去
  S.outlineAt = id; markOutline();
  el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1700);
}
function markOutline() {
  for (const el of $('#rail').querySelectorAll('.tick')) el.classList.toggle('on', Number(el.dataset.mid) === S.outlineAt);
}
// 聊天滚到哪里，哪条短线就亮：从聊天窗口顶上往下一点的位置往上数，最近的一句我的发言；滚到底时取最后一句看得见的
function spyOutline() {
  if (Date.now() < spyLock) return;
  const chat = $('#chat');
  const box = chat.getBoundingClientRect();
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 4;
  const line = atBottom ? box.bottom : box.top + 96;
  let cur = null;
  for (const el of chat.querySelectorAll('.msg.me')) { if (el.getBoundingClientRect().top <= line) cur = Number(el.id.slice(1)); else break; }
  if (cur === S.outlineAt) return;
  S.outlineAt = cur; markOutline();
  const on = $('#rail .tick.on'), rail = $('#rail');
  if (on && rail.scrollHeight > rail.clientHeight) rail.scrollTop = on.offsetTop - rail.clientHeight / 2;   // 短线多到一屏放不下时，让亮着的那条留在中间
}
let spyTimer = 0;
$('#chat').addEventListener('scroll', () => { if (!spyTimer) spyTimer = setTimeout(() => { spyTimer = 0; spyOutline(); }, 80); }, { passive: true });

// 正在跑的会话有哪些（不管它们在写什么字）：没变就不用重画左栏和顶栏
const actShape = () => Object.values(S.activity ?? {}).map((a) => `${a.runId}:${a.agent}:${a.taskId ?? ''}`).sort().join('|');
// 成员说的话（逐字吐出来的）只显示最新的字：放不下时省略号打在左边
const actText = (cls, text, kind) => h('div', { class: `${cls} ${kind === 'say' ? 'say' : ''}` }, kind === 'say' ? h('span', {}, text ?? '') : kind === 'cmd' && cls === 'se-cmd' ? `$ ${text}` : text ?? '');

// 正在运行的会话：输入框上方一行一个。按运行编号复用同一个节点，只改里面的文字。点开看这次到目前的全部过程
const liveRows = new Map();
function renderLive() {
  const box = $('#live');
  const acts = Object.values(S.activity ?? {}).sort((x, y) => x.startedTs - y.startedTs);
  const ids = new Set(acts.map((a) => a.runId));
  for (const [id, el] of liveRows) if (!ids.has(id)) { el.remove(); liveRows.delete(id); }
  for (const a of acts) {
    let el = liveRows.get(a.runId);
    if (!el) {
      const canInject = S.app?.agents.find((x) => x.name === a.agent)?.canInject;
      const limit = a.agent === 'Codex' ? '只能写项目文件夹' : '限项目文件夹内工作';
      el = h('div', { class: 'live-row new', title: '点开看它这次到目前为止的全部过程', onclick: (e) => { if (!e.target.closest('button')) runDialog(a.runId); } },
        h('span', { class: 'lamp live' }),
        memTok(a.agent), h('span', { class: 'lane' }, laneName(a)), h('span', { class: 'verb' }), h('span', { class: 'cmd' }),
        a.kind === 'summary'
          ? h('span', { class: 'perm' }, '只输出摘要')
          : h('span', { class: 'perm', title: `${limit}。${canInject ? '现在 @ 它，消息会直接送进它正在进行的会话' : '它这种运行方式不能中途插话，新消息会排到这一步结束后'}` }, canInject ? '可插话' : '不能插话'),
        stopBtn(a.runId, `停止 @${a.agent} 的这个会话`));
      liveRows.set(a.runId, el);
    }
    box.append(el);            // 已经在里面的节点只是挪到正确的顺序，不会重建
    $('.verb', el).textContent = { cmd: '正在运行', say: '正在说', think: '正在想' }[a.kind] ?? '正在做';
    const cmd = $('.cmd', el);
    cmd.classList.toggle('say', a.kind === 'say');
    if (a.kind === 'say') { const sp = cmd.firstElementChild?.tagName === 'SPAN' ? cmd.firstElementChild : cmd.appendChild(h('span')); if (cmd.childNodes.length > 1) cmd.replaceChildren(sp); sp.textContent = a.text ?? ''; }
    else cmd.textContent = a.text ?? '';
    cmd.title = a.text ?? '';
  }
}

// ---- 输入框 ---------------------------------------------------------------
const input = $('#input');
function growInput() { input.style.height = 'auto'; input.style.height = `${Math.min(168, input.scrollHeight)}px`; }
function mention(a) {
  if (!a.connected) return toast(`@${a.name} 未连接：${a.detail}`, true);
  if (!input.value.includes('@' + a.name)) input.value = `@${a.name} ` + input.value;
  input.focus(); growInput();
}
function renderComposer() {
  $('#atChips').replaceChildren(...(S.app?.agents ?? []).map((a) => h('button', {
    class: `atchip ${a.connected ? '' : 'off'}`, title: a.connected ? `@${a.name}：${a.title}` : `@${a.name} 未连接`, onclick: () => mention(a),
  }, face(a.name, 'xs'), a.name)));
  const bar = $('#replyBar');
  const m = S.replyTo && S.proj?.messages.find((x) => x.id === S.replyTo);
  const st = S.sayTask && S.proj?.tasks.find((x) => x.id === S.sayTask);
  const cancel = h('button', { class: 'linkbtn', onclick: () => { S.replyTo = null; S.sayTask = null; $('#asTask').checked = true; renderComposer(); } }, '取消');
  bar.hidden = !m && !st;
  if (st) bar.replaceChildren(h('span', { class: 't' }, `跟进任务 ${st.id}「${st.title}」：这句话会送到正在做这张卡的会话，不另建任务卡`), cancel);
  else if (m) bar.replaceChildren(h('span', { class: 't' }, `回复 ${m.sender}：${m.text.slice(0, 100)}`), cancel);
  $('#sendBtn').disabled = !S.proj;
  input.disabled = !S.proj;
  // “要审查”只对新建的任务卡有用：不建任务卡（或者是在跟进一张已有的卡）时变淡
  const taskOn = $('#asTask').checked;
  $('#needReview').disabled = !taskOn;
  $('#reviewRow').classList.toggle('off', !taskOn);
}
$('#asTask').addEventListener('change', () => renderComposer());
async function sendMessage() {
  const text = input.value.trim();
  if (!text || !S.proj) return;
  $('#sendBtn').disabled = true;
  try {
    const r = await api(P('say'), { text, replyTo: S.replyTo, taskId: S.sayTask, asTask: $('#asTask').checked, review: $('#needReview').checked, chatId: typeof S.chat === 'number' ? S.chat : null });
    // 新对话里发出的第一句话：它现在是一个真的对话了
    if (S.chat === 'new' && r.msg?.chainId != null) { S.chat = r.msg.chainId; store.set(`wg.chat.${S.pid}`, String(S.chat)); S.seen = null; }
    input.value = ''; growInput(); S.replyTo = null; S.sayTask = null; S.pinnedBottom = true; $('#asTask').checked = true; $('#needReview').checked = true; renderComposer();
  } finally { $('#sendBtn').disabled = !S.proj; }
}
$('#sendBtn').addEventListener('click', sendMessage);
input.addEventListener('input', growInput);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
async function upload(files) {
  const list = [...files];
  if (!S.proj || !list.length) return;
  for (const f of list) await api(P(`upload?name=${encodeURIComponent(f.name)}`), await f.arrayBuffer(), true);
  toast(`已放进收件箱：${list.map((f) => f.name).join('、')}`);
}
$('#attachBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => { try { await upload(e.target.files); } finally { e.target.value = ''; } });
const mainPane = $('#main');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
mainPane.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !S.proj) return; e.preventDefault(); dragDepth++; mainPane.classList.add('dropping'); });
mainPane.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
mainPane.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) mainPane.classList.remove('dropping'); });
mainPane.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; mainPane.classList.remove('dropping'); upload(e.dataTransfer.files).catch(() => {}); });

// ---- 右栏：任务卡 -----------------------------------------------------------
const EV = {
  created: '派单', accepted: '接单', step: '进度', submitted: '提交', review_passed: '审查通过', review_failed: '审查未过',
  approved: '验收通过', rejected: '群主打回', reopened: '退回重做', reassigned: '改派', blocked: '卡住', cancelled: '取消', model: '模型',
};
function renderTasks() {
  const head = $('#taskHead'), list = $('#taskList');
  if (!S.proj) {
    head.replaceChildren(h('div', { class: 'col-head' }, h('h2', {}, '任务')));
    list.replaceChildren(h('div', { class: 'empty' }, '建好项目后，任务卡会出现在这里'));
    return;
  }
  if (menuOpenIn(list)) return;     // 下拉菜单正开着：先不重画，免得把菜单关掉
  const scoped = typeof S.chat === 'number';       // 看某个对话时，只列这个对话引出的任务卡
  const ts = scoped ? S.proj.tasks.filter((t) => taskChat(t) === S.chat) : S.proj.tasks;
  const n = (f) => ts.filter(f).length;
  const waiting = n((t) => t.state === 'awaiting_owner');
  const open = n((t) => !['done', 'cancelled', 'awaiting_owner'].includes(t.state));
  const tabs = [['all', '全部', ts.length], ['mine', '待验收', waiting], ['open', '进行中', open], ['done', '已完成', n((t) => t.state === 'done')]];
  head.replaceChildren(
    h('div', { class: 'col-head' },
      h('h2', {}, '任务'),
      h('span', { class: 'col-note' }, [scoped ? '本对话' : '整个项目', ts.length ? `${open} 进行中` : null, waiting ? `${waiting} 等你验收` : null].filter(Boolean).join(' · ')),
      h('span', { class: 'spacer' }),
      // 摘要：每张卡只留要紧的几行；详细：全部摊开
      h('div', { class: 'segmented mini', role: 'group', 'aria-label': '任务卡显示多少内容' }, [['brief', '摘要'], ['full', '详细']].map(([k, label]) =>
        h('button', { class: S.cardMode === k ? 'on' : '', 'aria-pressed': S.cardMode === k ? 'true' : 'false', title: k === 'brief' ? '每张卡只显示要紧的几行' : '每张卡显示全部内容',
          onclick: () => { S.cardMode = k; S.cardFlip.clear(); store.set('wg.cards', k); renderTasks(); } }, label)))),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label, count]) =>
      h('button', { class: `${S.tab === k ? 'on' : ''} ${k === 'mine' && count ? 'alert' : ''}`, role: 'tab', 'aria-selected': S.tab === k ? 'true' : 'false', onclick: () => { S.tab = k; renderTasks(); } }, label, h('b', {}, count)))));
  const match = (t) => S.tab === 'all' || (S.tab === 'mine' && t.state === 'awaiting_owner')
    || (S.tab === 'open' && !['done', 'cancelled', 'awaiting_owner'].includes(t.state)) || (S.tab === 'done' && t.state === 'done');
  const roots = ts.filter((t) => !t.parent).sort((a, b) => (b.state === 'awaiting_owner') - (a.state === 'awaiting_owner') || b.seq - a.seq);
  const nodes = [];
  for (const r of roots) {
    const kids = ts.filter((t) => t.parent === r.id);
    if (!match(r) && !kids.some(match)) continue;
    nodes.push(taskCard(r, false));
    for (const k of kids) if (S.tab === 'all' || match(k) || match(r)) nodes.push(taskCard(k, true));
  }
  if (!nodes.length) nodes.push(h('div', { class: 'empty' }, ts.length ? '这个分类下没有任务' : scoped ? '这个对话还没有任务卡' : '还没有任务，在群里说目标或 @ 成员，就会建出任务卡'));
  const y = list.scrollTop;
  list.replaceChildren(...nodes);
  list.scrollTop = y;
}

function followUp(t) {
  S.sayTask = t.id; S.replyTo = null; $('#asTask').checked = false;
  if (!input.value.includes('@' + t.owner)) input.value = `@${t.owner} ` + input.value;
  renderComposer(); input.focus(); growInput();
}
async function cancelTask(t) {
  const yes = await confirmSheet({ title: `取消任务 ${t.id}？`, message: `「${t.title}」取消后不再继续。`, okText: '取消任务', cancelText: '先留着', destructive: true });
  if (yes) api(P(`task/${t.id}/cancel`), {});
}
// 任务卡里的长段落（核对方法、证据、审查意见）默认只显示五行，点“展开全文”看全部
function clampP(key, label, text, tight = false) {
  const long = tight ? text.length > 60 || text.split('\n').length > 2 : text.length > 220 || text.split('\n').length > 5;
  const open = S.openBox.has(key);
  return [
    h('p', { class: long && !open ? 'clamp5' : '' }, label && h('span', { class: 'muted' }, label), richText(text)),
    long && h('button', { class: 'linkbtn more', onclick: () => { open ? S.openBox.delete(key) : S.openBox.add(key); renderTasks(); } }, open ? '收起' : '展开全文'),
  ];
}
// 步骤进度那一行：“步骤 2/5  ▬▬  正在：……”。点一下展开每一步：做完的打勾，正在做的亮灯
function stepBlock(t, steps) {
  const total = t.stepTotal || 0;
  const handedIn = ['in_review', 'awaiting_owner', 'done'].includes(t.state);      // 已经交上来了
  const at = t.state === 'done' && total ? total : total ? Math.min(t.stepAt || 0, total) : 0;
  const allDone = t.state === 'done' || (handedIn && total > 0 && at >= total);
  const last = steps.at(-1);
  const now = allDone ? '全部做完'
    : t.state === 'blocked' ? `卡住了${t.stepText || last?.text ? '：' + (t.stepText || last.text) : ''}`
    : handedIn ? '已提交'
    : t.stepText ? `正在：${t.stepText}` : last ? last.text : '还没开始';
  const open = S.openSteps.has(t.id);
  const kids = [h('button', {
    class: `steps-head ${allDone ? 'done' : ''}`, 'aria-expanded': open ? 'true' : 'false', disabled: !steps.length,
    title: steps.length ? (open ? '收起每一步' : '展开，看每一步') : '', onclick: () => { open ? S.openSteps.delete(t.id) : S.openSteps.add(t.id); renderTasks(); },
  },
  h('b', {}, total ? `步骤 ${at}/${total}` : '进度'),
  total ? h('span', { class: 'bar' }, h('i', { style: `width:${Math.round((100 * at) / total)}%` })) : null,
  h('span', { class: 'steps-now', title: now }, now),
  steps.length ? icon('chevron') : null)];
  if (open) {
    kids.push(h('ol', { class: 'steps-list' },
      steps.map((e, i) => {
        const done = handedIn || i < steps.length - 1;       // 报了下一步，上一步就算做完了；交上来之后全部算做完
        return h('li', { class: done ? 'done' : 'now' },
          done ? icon('check') : h('span', { class: `lamp ${t.state === 'blocked' ? 'stop' : 'go'}` }),
          h('span', { class: 'sn' }, e.data?.at ? `第 ${e.data.at} 步` : '进度'),
          h('span', { class: 'st-t' }, e.text),
          h('time', {}, hm(e.ts)));
      }),
      !handedIn && total && at < total ? h('li', { class: 'todo' }, h('span', { class: 'lamp off' }), h('span', { class: 'sn' }, `还有 ${total - at} 步`), h('span', { class: 'st-t' }, '没开始')) : null));
  }
  return h('div', { class: 'steps' }, kids);
}
// 状态灯的颜色：绿＝在干，琥珀＝叫你，红＝停了；其余是灰的
const TASK_TONE = { accepted: 'go', working: 'go', in_review: 'go', awaiting_owner: 'call', blocked: 'stop', rejected: 'stop' };
function taskCard(t, child) {
  const acts = Object.values(S.activity ?? {}).filter((a) => a.taskId === t.id);   // 正在这张卡上干活的会话
  const run = S.proj.runs.find((r) => r.taskId === t.id);
  const closed = ['done', 'cancelled'].includes(t.state);
  const awaiting = t.state === 'awaiting_owner';
  // 摘要模式下只留要紧的：标题、状态、进度、等你验收的成果和审查意见、最近一条过程。点“详情”看这张卡的全部
  const full = (S.cardMode === 'full') !== S.cardFlip.has(t.id);
  const flip = () => { S.cardFlip.has(t.id) ? S.cardFlip.delete(t.id) : S.cardFlip.add(t.id); renderTasks(); };
  const card = h('div', { class: `card ${child ? 'child' : ''} ${awaiting ? 'await' : ''} ${closed ? 'closed' : ''} ${full ? 'full' : 'brief'}`, id: `task-${t.id}` });
  // 工单的抬头：状态灯 + 状态，右边是工单号；下面是标题、负责人和审查人
  const tone = TASK_TONE[t.state] ?? '';
  const meta = [
    full ? `${t.creator === OWNER ? '群主' : t.creator} 建` : null, full && t.parent ? `属于 ${t.parent}` : null,
    t.after.length ? `等 ${t.after.join('、')}` : null,
  ].filter(Boolean).join(' · ');
  card.append(
    h('div', { class: 'card-state' },
      t.state === 'done' ? icon('check') : h('span', { class: `lamp ${acts.length ? 'live' : tone || (closed ? 'off' : '')}` }),
      h('span', { class: `sl ${tone}` }, awaiting ? '等你验收' : t.stateLabel),
      t.rework ? h('span', { class: 'bad' }, `返工 ${t.rework} 次`) : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'tid' }, t.id),
      h('button', { class: 'linkbtn', 'aria-expanded': full ? 'true' : 'false', title: full ? '只显示要紧的几行' : '显示这张卡的全部内容', onclick: flip }, full ? '收起' : '详情')),
    h('div', { class: 'card-title' }, t.title),
    h('div', { class: 'card-meta' },
      memTok(t.owner, '负责人'),
      t.reviewer ? [h('span', {}, '审查'), memTok(t.reviewer, '审查人')] : t.noReview ? h('span', { title: '建这张卡时你选了不用审查' }, '不用审查') : full ? h('span', {}, '无审查人') : null,
      meta ? h('span', { class: 'mt' }, meta) : null));
  if (full) {
    const locked = t.state === 'done' || t.frozen;
    card.append(h('dl', { class: 'kv' },
      t.deliver && [h('dt', {}, '交付物'), h('dd', {}, t.deliver)], t.accept && [h('dt', {}, '验收条件'), h('dd', {}, t.accept)],
      t.state !== 'cancelled' && [
        h('dt', { title: '只有负责这张卡的会话能写这些目录；别的会话（包括同一位成员的另一个会话）写不进去' }, '写入范围'),
        h('dd', {}, (t.scope ?? []).map((d) => h('button', { class: 'chip', title: '在访达中打开', onclick: () => api(P('open'), { path: d }).catch(() => toast('这个目录还没有建出来')) }, d)),
          h('span', { class: 'lock' }, locked && icon('lock'), t.state === 'done' ? '已完成，已锁定' : t.frozen ? '已提交，已锁定' : `只有 @${t.owner} 做这张卡的会话能写`))],
      t.wt && [
        h('dt', { title: '项目是 git 仓库：这张卡在自己的工作区里改代码，别的卡看不到，项目里的原件也不受影响' }, 'git 工作区'),
        h('dd', {}, wtLine(t))]));
  }

  // 步骤进度：做到第几步、一共几步、现在在做什么。点一下展开，看每一步是几点开始的、哪些已经做完
  const evs = t.events ?? [];
  const steps = evs.filter((e) => e.type === 'step');
  if (t.state !== 'cancelled' && (t.stepTotal || steps.length)) card.append(stepBlock(t, steps));
  if (t.submission && (full || awaiting)) {
    const s = t.submission;
    card.append(h('div', { class: 'box' },
      h('h4', {}, '成果', h('span', { class: 'h4m' }, `第 ${s.round} 轮`), memTok(s.by), h('span', { class: 'h4m' }, `${hm(s.ts)} 提交`)),
      h('div', { class: 'files' }, s.files.map(fileCard)),
      full && clampP(`${t.id}:run:${s.round}`, '运行/核对方法：', s.run),
      clampP(`${t.id}:evidence:${s.round}`, '提交人的证据：', s.evidence, !full),
      full && s.commit && h('p', { class: 'muted' }, s.branch ? `分支 ${s.branch} 的提交 ${s.commit}` : `提交号 ${s.commit}`)));
  }
  // git 工作区：合并没成、正在解冲突、没合并的分支留着
  const wt = t.wt;
  if (wt?.conflict && !wt.merged && !closed && (full || awaiting)) {
    const files = wt.conflict.files ?? [];
    card.append(h('div', { class: 'box fail' },
      h('h4', {}, `没能合并进 ${wt.conflict.into}`),
      h('p', {}, wt.conflict.why ?? `和 ${wt.conflict.into} 现在的内容有冲突，冲突在：${files.join('、')}`),
      awaiting && h('p', { class: 'muted' }, `点“打回”，工作台会把 ${wt.conflict.into} 的最新改动合进这张卡的工作区，让 @${t.owner} 解决冲突后重新提交。`)));
  }
  if (wt?.syncing?.files?.length && !closed) {
    card.append(h('div', { class: 'box' }, h('h4', {}, '正在解冲突'),
      h('p', {}, `${wt.syncing.into} 的最新改动已经合进工作区，这些文件有冲突要 @${t.owner} 改：${wt.syncing.files.join('、')}`)));
  }
  if (t.changedFiles?.length && (full || !closed)) {
    card.append(h('div', { class: 'box fail' },
      h('h4', {}, '有成果文件在提交之后被改过'),
      h('p', {}, `任务卡登记和审查的是提交时的版本，下面这些文件现在的内容已经不一样了：${t.changedFiles.join('、')}`),
      h('p', { class: 'muted' }, `可以打回，让 ${t.owner} 重新提交当前版本`)));
  }
  if (t.review) {
    const r = t.review;
    if (full || awaiting) card.append(h('div', { class: `box ${r.pass ? 'pass' : 'fail'}` },
      h('h4', {}, `审查${r.pass ? '通过' : '未通过'}`, memTok(r.by), h('span', { class: 'h4m' }, hm(r.ts))),
      clampP(`${t.id}:review:${r.ts}`, null, r.evidence, !full),
      full && r.files?.length ? h('div', { class: 'files' }, r.files.map(fileCard)) : null));
  } else if (awaiting && !t.reviewer && !S.proj.tasks.some((k) => k.parent === t.id)) {
    card.append(h('div', { class: 'box fail' }, h('h4', {}, '这份成果没有经过成员审查'), h('p', {}, t.noReview ? '建这张卡时你选了不用审查' : '提交时没有第二位已连接的成员')));
  }

  // 模型：实际用的是哪个，自动还是指定
  if (full && (!closed || run)) {
    const levels = S.app.levels ?? [];
    card.append(h('div', { class: 'modelline' },
      run ? h('span', { title: `${runModel(run)}（${run.modelBy ?? ''}）` }, `模型：${runModel(run)}（${run.modelBy ?? ''}）`) : h('span', {}, '模型：还没运行'),
      !closed && !S.app.catalog?.[t.owner]?.locked && h('select', { class: 'pill', title: '改这张任务卡的模型档位', 'aria-label': `${t.id} 的模型档位`, onchange: (e) => { const v = e.target.value; e.target.blur(); api(P(`task/${t.id}/level`), { level: v }); } },
        h('option', { value: '', selected: !t.level_set, disabled: true }, '自动'),
        levels.map((lv) => h('option', { value: lv, selected: t.level_set && t.level === lv }, `${lv}档`)))));
  }

  // 过程记录：摘要模式只留最近两条
  const evLine = (e, last, max) => h('div', { class: `ev ${last ? 'last' : ''}` }, h('time', {}, hm(e.ts)),
    h('span', {}, `${e.actor === OWNER ? '群主' : e.actor} ${EV[e.type] ?? e.type}${e.text ? '：' + e.text.slice(0, max) : ''}`));
  if (full) {
    const openTl = S.openTimeline.has(t.id);
    const shown = openTl ? evs : evs.slice(-3);
    card.append(h('div', { class: 'timeline' },
      shown.map((e, i) => evLine(e, i === shown.length - 1, openTl ? 600 : 90)),
      evs.length > 3 && h('button', { class: 'linkbtn', onclick: () => { openTl ? S.openTimeline.delete(t.id) : S.openTimeline.add(t.id); renderTasks(); } }, openTl ? '收起过程' : `查看全部 ${evs.length} 条过程`)));
  } else if (!closed && evs.length) {
    const tail = evs.slice(-2);
    card.append(h('div', { class: 'timeline' }, tail.map((e, i) => evLine(e, i === tail.length - 1, 90))));
  }

  // 操作：常用的直接放按钮，少用的收进“更多”菜单
  const actions = h('div', { class: 'actions' });
  const rest = h('span', { class: 'rest' });      // 不常用的操作：靠右的一排小字
  if (awaiting) {
    actions.append(
      h('button', {
        class: 'btn small ok', title: mergesOnApprove(t) ? `验收通过后，这张卡的改动会合并进项目的 ${t.wt.baseBranch} 分支（只在这台电脑上，不推送）` : '',
        onclick: () => api(P(`task/${t.id}/approve`), {}).then((r) => toast(r.task?.wt?.merged ? `${t.id} 已验收，改动已合并进 ${r.task.wt.merged.into}` : `${t.id} 已验收通过`)).catch(() => {}),
      }, icon('check'), mergesOnApprove(t) ? '验收并合并' : '验收通过'),
      h('button', { class: 'btn small destructive', onclick: () => rejectDialog(t) }, '打回'));
  }
  for (const a of acts) actions.append(h('button', { class: 'btn small destructive', onclick: () => api(P(`run/${a.runId}/stop`), {}) }, `停止 ${a.agent}`));
  const changed = S.proj.runs.some((r) => r.taskId === t.id && r.changes?.n);
  if (changed && closed && full) rest.append(h('button', { class: 'linkbtn', onclick: () => changesOfTask(t) }, '查看改动'));
  if (run && closed && full) rest.append(h('button', { class: 'linkbtn', onclick: () => runsOfTask(t) }, '查看过程'));
  if (t.state === 'done' && full) rest.append(h('button', { class: 'linkbtn', onclick: () => rejectDialog(t) }, '重新打回'));
  if (!closed) {
    const others = S.app.agents.filter((a) => a.name !== t.owner && a.connected);
    rest.append(h('button', { class: 'icon-btn small', title: '更多：查看过程、查看改动、跟进、改派、打回、取消', 'aria-label': `${t.id} 的更多操作`, 'aria-haspopup': 'menu', onclick: (e) => openMenu(e.currentTarget, [
      run ? { label: '查看过程', icon: 'doc', onclick: () => runsOfTask(t) } : null,
      changed ? { label: '查看改动', icon: 'diff', onclick: () => changesOfTask(t) } : null,
      { label: '跟进：对负责人说一句', icon: 'compose', onclick: () => followUp(t) },      // 它正在干活的话，这句话会直接送进它的会话
      '-',
      others.length ? { header: '改派给' } : null,
      ...others.map((a) => ({ label: `@${a.name}`, onclick: () => api(P(`task/${t.id}/reassign`), { to: a.name }) })),
      others.length ? '-' : null,
      !awaiting ? { label: '打回…', onclick: () => rejectDialog(t) } : null,
      { label: '取消任务…', danger: true, onclick: () => cancelTask(t) },
    ], 'right') }, icon('more')));
  }
  if (rest.children.length) actions.append(rest);
  if (actions.children.length) card.append(actions);
  return card;
}
// 验收时会不会合并：顶层卡、有工作区、还没合并过
const mergesOnApprove = (t) => !!t.wt && !t.parent && !t.wt.merged && (t.wt.live || !!t.submission?.sha);
// 任务卡详情里“git 工作区”那一行
function wtLine(t) {
  const wt = t.wt;
  if (wt.merged) return h('span', {}, `已合并进 ${wt.merged.into}`, h('span', { class: 'muted' }, ` · ${hm(wt.merged.ts)}`));
  if (wt.live) {
    return [h('button', { class: 'chip', title: '在访达中打开这张卡的工作区', onclick: () => api(P('open'), { path: wt.dir }).catch(() => {}) }, wt.branch),
      h('span', { class: 'lock' }, `从 ${wt.baseBranch} 的 ${wt.baseCommit} 分出来${t.parent ? '，审查通过后合进父任务' : '，验收时合并'}`)];
  }
  return h('span', { class: 'muted' }, wt.kept ? `工作区已清理，没合并的改动留在分支 ${wt.branch}` : '工作区已清理');
}
function focusTask(id) {
  const t = S.proj?.tasks.find((x) => x.id === id);
  if (t && typeof S.chat === 'number' && taskChat(t) !== S.chat) openChat(S.pid, taskChat(t) ?? 'all');   // 这张卡在别的对话里：先过去
  S.tab = 'all'; renderTasks(); showTasks();
  const el = $(`#task-${id}`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

// ---- 面板（从屏幕中间弹出的那种） ---------------------------------------------
let sheetOnClose = null;
function sheet({ title = null, body, foot = [], flush = false, size = '', onClose = null }) {
  const box = $('#sheetBox');
  const prev = sheetOnClose; sheetOnClose = null; prev?.();      // 被新面板顶替，也算关闭
  box.className = size;
  const parts = [];
  if (title != null) parts.push(h('div', { class: 's-top' }, h('h3', {}, title), h('button', { class: 'close-btn', title: '关闭（Esc）', 'aria-label': '关闭', onclick: closeSheet }, icon('x'))));
  parts.push(h('div', { class: `s-body ${flush ? 'flush' : ''}` }, body));
  if (foot.length) parts.push(h('div', { class: 's-foot' }, foot));
  box.replaceChildren(...parts);
  sheetOnClose = onClose;
  $('#sheet').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; const f = sheetOnClose; sheetOnClose = null; f?.(); }
$('#sheet').addEventListener('mousedown', (e) => { if (e.target.id === 'sheet') closeSheet(); });
// 确认框：代替浏览器自带的那种
function confirmSheet({ title, message, okText = '好', cancelText = '取消', destructive = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => { if (answered) return; answered = true; resolve(v); closeSheet(); };
    const ok = h('button', { class: `btn ${destructive ? 'destructive solid' : 'prominent'}`, onclick: () => done(true) }, okText);
    sheet({
      size: 'alertbox', body: h('div', { class: 'alert' }, h('h3', {}, title), message && h('p', {}, message)),
      foot: [h('button', { class: 'btn', onclick: () => done(false) }, cancelText), ok],
      onClose: () => { if (!answered) { answered = true; resolve(false); } },
    });
    setTimeout(() => ok.focus(), 30);
  });
}

// ---- 手机访问：总开关、配对码、已配对的设备。只在电脑上能打开这个面板 ----
async function phoneDialog() {
  let v = await api('/api/remote');
  let timer = null;
  const box = h('div', {});
  const act = async (path, body) => { try { v = await api(`/api/remote/${path}`, body); draw(); } catch { /* 出错已经提示过了 */ } };
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
  const group = (label, rows, hint) => h('div', { class: 'group' }, label && h('div', { class: 'glabel' }, label), h('div', { class: 'rows' }, rows), hint && h('div', { class: 'ghint' }, hint));
  function draw() {
    const sw = h('input', { type: 'checkbox', class: 'switch', checked: v.enabled, onchange: () => act('enable', { on: sw.checked }) });
    const left = v.code ? Math.max(0, Math.ceil((v.code.expires - Date.now()) / 1000)) : 0;
    const state = !v.enabled ? null
      : !v.ip ? h('div', { class: 'r' }, h('span', { class: 'rl' }, '这台 Mac 上没有找到 Tailscale', h('small', {}, '装好 Tailscale 并登录后，这里会自动变成可用，不用重启工作台')))
      : h('div', { class: 'r' }, h('span', { class: 'rl' }, '手机上打开这个地址', h('small', {}, v.listening ? '手机也要装 Tailscale，登录同一个账号' : '正在打开…')),
          h('button', { class: 'btn small', title: '复制地址', onclick: () => navigator.clipboard.writeText(v.url).then(() => toast('地址已复制')) }, v.url.replace('http://', '')));
    box.replaceChildren(...[
      group(null, [
        h('label', { class: 'r' }, h('span', { class: 'rl' }, '允许手机访问', h('small', {}, '只对你自己 Tailscale 账号下的设备开放；关掉后已连接的手机立刻断开')), sw),
        state,
      ].filter(Boolean)),
      v.enabled && v.ip && group('配对', [
        h('div', { class: 'r' },
          h('span', { class: 'rl' }, v.code ? h('span', { class: 'pair-code' }, v.code.value) : '新手机第一次打开时要输入配对码',
            h('small', {}, v.code ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后失效，只能用一次` : '配对码 5 分钟内有效')),
          h('button', { class: 'btn small', onclick: () => act('code', {}) }, v.code ? '换一个' : '生成配对码')),
      ]),
      group('已配对的设备', v.devices.length
        ? v.devices.map((d) => h('div', { class: 'r' }, h('span', { class: 'rl' }, d.name, h('small', {}, `最近使用：${ago(d.lastSeen)}`)),
            h('button', { class: 'btn small destructive', onclick: () => act('revoke', { id: d.id }) }, '移除')))
        : [h('div', { class: 'r' }, h('span', { class: 'rl' }, h('small', {}, '还没有')))],
        '手机上能看进度、发消息、建任务卡、传文件、验收和打回；改设置、换模型、建或删项目只能在电脑上做。'),
    ].filter(Boolean));
  }
  draw();
  timer = setInterval(async () => { try { const r = await fetch('/api/remote', { headers: { 'X-Workgroup': '1' } }); if (r.ok) { v = await r.json(); if (!box.contains(document.activeElement) || document.activeElement.tagName !== 'INPUT') draw(); } } catch { /* 下一轮再试 */ } }, 2000);
  sheet({ title: '手机访问', body: box, onClose: () => clearInterval(timer) });
}

function rejectDialog(t) {
  const ta = h('textarea', { class: 'field', rows: 4, placeholder: '哪里不对，要改成什么样（成员会收到这段话）' });
  const go = async () => {
    if (!ta.value.trim()) return toast('请写打回原因', true);
    await api(P(`task/${t.id}/reject`), { reason: ta.value.trim() });
    closeSheet(); toast(`${t.id} 已打回`);
  };
  sheet({
    title: `打回任务 ${t.id}「${t.title}」`,
    body: h('div', { class: 'form' }, h('div', { class: 'group' }, h('div', { class: 'glabel' }, '打回原因'), ta,
      h('div', { class: 'ghint' }, `打回后会唤醒负责人 @${t.owner} 重做，并在任务卡上记一次返工。`))),
    foot: [h('button', { class: 'btn', onclick: closeSheet }, '先不打回'), h('button', { class: 'btn destructive solid', onclick: go }, '打回')],
  });
  setTimeout(() => ta.focus(), 30);
}

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}
// 文件预览：表格文件按表格显示，文本按原文显示
async function openFile(path) {
  let f;
  try { f = await api(P(`file?path=${encodeURIComponent(path)}`)); } catch { return; }
  const info = h('span', { class: 'info', title: f.path }, `${f.path} · ${size(f.size)}${f.mtime ? ' · 改于 ' + mdhm(f.mtime) : ''}`);
  const foot = [
    info,
    h('button', { class: 'btn', onclick: () => api(P('open'), { path: f.path, reveal: true }) }, '在访达中显示'),
    h('button', { class: 'btn prominent', onclick: async () => { const r = await api(P('open'), { path: f.path }); if (r.note) toast(r.note); } }, '用默认应用打开'),
  ];
  if (f.binary) return sheet({ title: base(f.path), body: h('div', { class: 'empty' }, '这不是文本文件，请用默认应用打开'), foot });
  if (/\.(csv|tsv)$/i.test(f.path)) {
    const rows = parseCsv(f.ext === '.tsv' ? f.text.replace(/\t/g, ',') : f.text);
    const [head = [], ...data] = rows;
    const isNum = (v) => /^-?[\d,]+(\.\d+)?$/.test(v.trim());
    const table = h('table', { class: 'csv' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), head.map((c) => h('th', {}, c)))),
      h('tbody', {}, data.slice(0, 500).map((r, i) => h('tr', {}, h('td', { class: 'num faint' }, i + 1), r.map((c) => h('td', { class: isNum(c) ? 'num' : '', title: c }, c))))));
    info.textContent += ` · ${data.length} 行数据 × ${head.length} 列${data.length > 500 ? '（只显示前 500 行）' : ''}`;
    return sheet({ title: base(f.path), body: table, foot, flush: true, size: 'wide' });
  }
  sheet({ title: base(f.path), body: h('pre', { class: 'filetext' }, f.text + (f.truncated ? '\n\n……（文件太长，只显示开头）' : '')), foot, flush: true, size: 'wide' });
}

const STATUS = { ok: '完成', error: '出错', timeout: '超时', stopped: '被停止', quota: '额度用尽', running: '进行中', interrupted: '被中断' };
// 开着的“还在跑的运行”面板：成员每有动静就重新取一次（最多 0.7 秒一次），跑完再取最后一次就停
let liveRun = null, liveRunTimer = 0;
function refreshLiveRun() {
  if (!liveRun || liveRunTimer) return;
  liveRunTimer = setTimeout(() => { liveRunTimer = 0; if (liveRun && !$('#sheet').hidden) runDialog(liveRun.runId, true); }, 700);
}
async function runDialog(runId, refresh = false) {
  let d;
  try { d = await api(P(`run/${runId}`)); } catch { return; }
  if (refresh && (liveRun?.runId !== runId || $('#sheet').hidden)) return;      // 取回来时面板已经关了或换了
  const r = d.run;
  const rows = [];
  for (const l of d.lines) {
    if (l.kind === 'prompt') { rows.push(h('details', { class: 'logrow' }, h('summary', {}, `${hm(l.t)} 工作台发给 @${r.agent} 的内容（点开看）`), l.line)); continue; }
    if (l.kind === 'err') { rows.push(h('div', { class: 'logrow err' }, h('span', { class: 'lk' }, hm(l.t)), l.line.slice(0, 1200))); continue; }
    if (l.kind === 'inject') { rows.push(h('div', { class: 'logrow inject' }, h('span', { class: 'lk' }, `${hm(l.t)} 运行中插话`), l.line.slice(0, 1500))); continue; }
    if (l.kind !== 'out') continue;
    let ev; try { ev = JSON.parse(l.line); } catch { continue; }
    const add = (cls, label, text) => text && rows.push(h('div', { class: `logrow ${cls}` }, h('span', { class: 'lk' }, `${hm(l.t)} ${label}`), String(text).slice(0, 3000)));
    // Codex
    if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') add('cmd', `命令（退出码 ${ev.item.exit_code}）`, `${ev.item.command}\n${(ev.item.aggregated_output ?? '').slice(0, 1500)}`);
    else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') add('say', '说', ev.item.text);
    else if (ev.type === 'turn.failed' || ev.type === 'error') add('err', '错误', ev.error?.message ?? ev.message);
    // Codex（app-server 模式）
    else if (ev.method === 'item/completed' && ev.params?.item?.type === 'commandExecution') add('cmd', `命令（退出码 ${ev.params.item.exitCode}）`, `${ev.params.item.command}\n${(ev.params.item.aggregatedOutput ?? '').slice(0, 1500)}`);
    else if (ev.method === 'item/completed' && ev.params?.item?.type === 'agentMessage') add('say', '说', ev.params.item.text);
    else if (ev.method === 'error') add('err', '错误', ev.params?.error?.message);
    else if (ev.method === 'turn/completed' && ev.params?.turn?.status === 'failed') add('err', '错误', ev.params.turn.error?.message);
    // Claude
    else if (ev.type === 'assistant') for (const b of ev.message?.content ?? []) {
      if (b.type === 'text') add('say', '说', b.text);
      else if (b.type === 'tool_use') add('cmd', b.name === 'Bash' ? '命令' : b.name, b.name === 'Bash' ? b.input?.command : JSON.stringify(b.input).slice(0, 600));
    }
    else if (ev.type === 'user') for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
      if (b.type === 'tool_result') add('', '结果', typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join('\n'));
    }
    // DeepSeek Harness
    else if (ev.type === 'tool_call') add('cmd', ev.tool, ev.input?.command ?? JSON.stringify(ev.input).slice(0, 600));
    else if (ev.type === 'tool_result') add('', '结果', typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result));
    else if (ev.type === 'text') add('say', '说', ev.text);
    else if (ev.type === 'status' && ev.reason?.kind === 'error') add('err', '错误', ev.reason.error?.message);
  }
  const running = d.live != null;
  if (running && d.live.trim()) rows.push(h('div', { class: 'logrow say writing' }, h('span', { class: 'lk' }, '正在写…'), d.live));
  const u = r.usage ?? {};
  const cap = (text, cls = '') => h('span', { class: `capsule ${cls}` }, text);
  const ob = refresh ? $('#sheetBox .s-body') : null;
  const keep = ob && { top: ob.scrollTop, bottom: ob.scrollHeight - ob.scrollTop - ob.clientHeight < 40 };
  if (liveRun) liveRun.swapping = true;       // 自己刷新自己，不算关闭
  sheet({
    title: `@${r.agent} 的一次真实运行${r.kind === 'summary' ? '（整理群摘要）' : ''} · ${STATUS[r.status] ?? r.status}`,
    body: [
      h('div', { class: 'runmeta' },
        cap(`${mdhm(r.startedTs)} 开始${r.endedTs ? '，用时 ' + Math.round((r.endedTs - r.startedTs) / 1000) + ' 秒' : ''}`),
        cap(`模型 ${runModel(r)}（${r.modelBy ?? ''}）`),
        cap(r.resumed ? '接着上次的会话' : '新开会话'),
        cap(`调用 qun ${r.qunCalls} 次`),
        cap(`输入 ${tok(u.input ?? 0)}（其中缓存 ${tok(u.cached ?? 0)}）/ 输出 ${tok(u.output ?? 0)} token`),
        typeof u.cost === 'number' && cap(`估算花费 ${yuan(u.cost)}${u.peak ? '（高峰价）' : ''}`, 'warn')),
      r.error ? h('div', { class: 'runerr' }, `错误：${r.error}`) : null,
      h('div', { class: 'loglist' }, rows.length ? rows : h('div', { class: 'empty' }, running ? '刚开始，还没有动静' : '这次运行没有可显示的过程')),
    ], size: 'wide',
    onClose: () => { if (liveRun?.runId === runId && !liveRun.swapping) liveRun = null; },
  });
  // 还在跑：停在最下面看最新的；重新取回来时，原来停在哪就还在哪（原来在最下面就跟到最下面）
  const nb = $('#sheetBox .s-body');
  if (keep && !keep.bottom) nb.scrollTop = keep.top;
  else if (running) nb.scrollTop = nb.scrollHeight;
  liveRun = running ? { runId } : null;
}
function runsOfTask(t) {
  const runs = S.proj.runs.filter((r) => r.taskId === t.id);
  if (runs.length === 1) return runDialog(runs[0].id);
  sheet({
    title: `任务 ${t.id} 的运行记录`, size: 'mid',
    body: h('div', { class: 'rows' }, h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, ['成员', '开始', '结果', '模型', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, runs.map((r) => h('tr', {}, h('td', {}, memTok(r.agent)), h('td', {}, mdhm(r.startedTs)), h('td', {}, STATUS[r.status] ?? r.status),
        h('td', { title: r.modelBy ?? '' }, runModel(r)), h('td', {}, h('button', { class: 'btn small', onclick: () => runDialog(r.id) }, '查看过程'))))))),
  });
}

// ---- 改动：这一次运行改了哪些文件、改了什么；不满意可以撤回 ----------------------
const FILE_STATE = { A: '新增', M: '修改', D: '删除' };
function changeText(c) {
  return [`改了 ${c.n} 个文件`,
    c.adds || c.dels ? h('span', { class: 'chg-n' }, h('b', { class: 'plus' }, `+${c.adds}`), ' ', h('b', { class: 'minus' }, `−${c.dels}`)) : null,
    c.rolled ? h('span', { class: 'chg-rolled' }, '已撤回') : null];
}
function changeBtn(run) {
  return h('button', { class: `chg ${run.changes.rolled ? 'rolled' : ''}`, title: '看这一次改了什么；不满意可以撤回', onclick: () => diffDialog(run.id) }, ...changeText(run.changes));
}
// 把 git 的逐行对比按文件切开：路径 → { lines, binary }
function splitDiff(text) {
  const out = new Map();
  let cur = null;
  const flush = () => { if (cur?.path) out.set(cur.path, cur); };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); cur = { lines: [], binary: false, path: null, minus: null, body: false }; continue; }
    if (!cur) continue;
    if (!cur.body) {
      if (line.startsWith('--- ')) { cur.minus = line === '--- /dev/null' ? null : line.slice(6).replace(/\t$/, ''); continue; }
      if (line.startsWith('+++ ')) { cur.path = line === '+++ /dev/null' ? cur.minus : line.slice(6).replace(/\t$/, ''); continue; }   // 删除的文件，路径在 --- 那行
      if (line.startsWith('Binary files ')) {
        cur.binary = true;
        const m = /^Binary files (?:a\/(.+?)|\/dev\/null) and (?:b\/(.+)|\/dev\/null) differ$/.exec(line);
        cur.path = m?.[2] ?? m?.[1] ?? null;
        continue;
      }
      if (!line.startsWith('@@')) continue;
      cur.body = true;
    }
    if (line) cur.lines.push(line);
  }
  flush();
  return out;
}
async function diffDialog(runId) {
  let d;
  try { d = await api(P(`run/${runId}/diff`)); } catch { return; }
  const run = S.proj.runs.find((r) => r.id === runId);
  const sections = splitDiff(d.text);
  const common = (p) => { const dir = d.dirs.find((x) => p.startsWith(x)); return dir ? p.slice(dir.length) : p; };
  const adds = d.files.reduce((s, f) => s + (f.a ?? 0), 0), dels = d.files.reduce((s, f) => s + (f.d ?? 0), 0);
  const cap = (text, cls = '') => h('span', { class: `capsule ${cls}` }, text);
  let shown = 0;
  const LIMIT = 6000;
  const blocks = d.files.map((f, i) => {
    const sec = sections.get(f.p);
    const head = h('div', { class: 'dfile-head' }, h('span', { class: `fst ${f.s}` }, FILE_STATE[f.s] ?? f.s), h('span', { class: 'dpath', title: f.p }, common(f.p)),
      h('span', { class: 'spacer' }), f.bin ? h('span', { class: 'faint' }, '二进制') : h('span', { class: 'chg-n' }, h('b', { class: 'plus' }, `+${f.a ?? 0}`), ' ', h('b', { class: 'minus' }, `−${f.d ?? 0}`)));
    let body;
    if (f.bin || sec?.binary) body = h('div', { class: 'dnote' }, '二进制文件，没法逐行对比');
    else if (!sec) body = h('div', { class: 'dnote' }, d.truncated ? '对比内容太长，这个文件没显示出来' : '没有可显示的内容');
    else if (shown >= LIMIT) body = h('div', { class: 'dnote' }, '前面的文件已经显示了很多行，这个文件不再展开');
    else {
      const lines = sec.lines.slice(0, LIMIT - shown);
      shown += lines.length;
      body = h('div', { class: 'dlines' }, lines.map((l) => h('div', { class: `dl ${l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'hunk' : l.startsWith('\\') ? 'hunk' : ''}` }, l || ' ')));
    }
    return h('section', { class: 'dfile', id: `df-${i}` }, head, body);
  });
  const list = h('div', { class: 'dlist' }, d.files.map((f, i) => h('button', { class: 'drow', onclick: () => $(`#df-${i}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) },
    h('span', { class: `fst ${f.s}` }, FILE_STATE[f.s] ?? f.s), h('span', { class: 'dpath' }, common(f.p)), h('span', { class: 'spacer' }),
    f.bin ? h('span', { class: 'faint' }, '二进制') : h('span', { class: 'chg-n' }, h('b', { class: 'plus' }, `+${f.a ?? 0}`), ' ', h('b', { class: 'minus' }, `−${f.d ?? 0}`)))));
  const foot = [];
  if (!d.rolled && !S.app?.viaPhone && d.files.length) {
    foot.push(h('span', { class: 'faint foot-note' }, '撤回只动这一次改过的文件；其中有文件之后又被改过，就整个不撤回'));
    foot.push(h('button', { class: 'btn destructive', onclick: () => rollbackRun(runId, d) }, icon('undo'), '撤回这次改动'));
  }
  foot.push(h('button', { class: 'btn', onclick: closeSheet }, '关闭'));
  sheet({
    title: `@${d.agent} 这一次改了什么`,
    body: [
      h('div', { class: 'runmeta' },
        run && cap(`${mdhm(run.startedTs)} 开始`),
        d.taskId && cap(`任务 ${d.taskId}`),
        cap(`${d.files.length} 个文件 +${adds} −${dels}`),
        d.rolled && cap(`${mdhm(d.rolled.ts)} 已撤回`, 'warn'),
        d.skipped.length > 0 && cap(`${d.skipped.length} 个超过 5 MB 的文件没拍快照`, 'warn'),
        run && h('button', { class: 'btn small', onclick: () => runDialog(runId) }, '查看过程')),
      d.files.length > 1 ? list : null,
      d.truncated ? h('div', { class: 'runerr' }, '改动太多，逐行对比只显示了前面一部分') : null,
      h('div', { class: 'dfiles' }, blocks),
    ],
    foot, size: 'wide',
  });
}
async function rollbackRun(runId, d) {
  const ok = await confirmSheet({
    title: '撤回这次改动？',
    message: `把 @${d.agent} 这一次改的 ${d.files.length} 个文件恢复成它动手之前的样子：新加的文件会删掉，改过和删掉的文件会恢复。之后有人又改过其中的文件，就整个不撤回，不会抹掉后来的工作。撤回后没法再自动恢复。`,
    okText: '撤回', destructive: true,
  });
  if (!ok) return;
  try { const r = await api(P(`run/${runId}/rollback`), {}); toast(`已撤回 ${r.files} 个文件`); } catch { /* 原因已经提示过了 */ }
}
function changesOfTask(t) {
  const runs = S.proj.runs.filter((r) => r.taskId === t.id && r.changes?.n);
  if (runs.length === 1) return diffDialog(runs[0].id);
  sheet({
    title: `任务 ${t.id} 每一次改了什么`, size: 'mid',
    body: h('div', { class: 'rows' }, h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, ['成员', '开始', '改动', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, runs.map((r) => h('tr', {}, h('td', {}, memTok(r.agent)), h('td', {}, mdhm(r.startedTs)), h('td', { class: 'chg' }, ...changeText(r.changes)),
        h('td', {}, h('button', { class: 'btn small', onclick: () => diffDialog(r.id) }, '查看'))))))),
  });
}

function newProjectDialog() {
  const name = h('input', { type: 'text', placeholder: '例如：订单导出整理' });
  const dir = h('input', { type: 'text', placeholder: '留空则放在工作台的「项目」文件夹里' });
  const create = async () => {
    if (!name.value.trim()) return toast('请填项目名', true);
    const r = await api('/api/projects', { name: name.value.trim(), dir: dir.value.trim() || undefined });
    S.app = r.app; closeSheet(); switchProject(r.project.id);
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) create(); });
  sheet({
    title: '新建项目',
    body: h('div', { class: 'form' }, h('div', { class: 'group' },
      h('div', { class: 'rows' },
        h('label', { class: 'r' }, h('span', { class: 'rl fixed' }, '项目名'), name),
        h('div', { class: 'r' }, h('span', { class: 'rl fixed' }, '项目文件夹'), dir,
          h('button', { class: 'btn small', onclick: async () => { const r = await api('/api/app/pick-folder', {}); if (r.dir) { dir.value = r.dir; if (!name.value) name.value = base(r.dir); } } }, '选择…'))),
      h('div', { class: 'ghint' }, '一个项目 = 一个工作群 = 一个文件夹。工作台会在文件夹里建「收件箱」「共享区」和每位成员自己的工作目录；不同项目的聊天、任务和文件互不相通。'))),
    foot: [h('button', { class: 'btn', onclick: closeSheet }, '取消'), h('button', { class: 'btn prominent', onclick: create }, '建群')],
  });
  setTimeout(() => name.focus(), 30);
}

function settingsDialog() {
  if (!S.proj) return toast('先建一个项目', true);
  const s = S.proj.settings;
  const num = (attrs) => h('input', { type: 'number', ...attrs });
  const hop = num({ min: 2, max: 60, value: s.hopLimit });
  const tmo = num({ min: 3, max: 180, value: s.runTimeoutMin });
  const table = { ...S.app.kindLevel, ...(s.kindLevel ?? {}) };
  const sels = {};
  // ---- 成员表：启用 / 停用、分工。对所有项目生效 ----
  const mem = Object.fromEntries((S.app.members ?? []).map((m) => {
    const on = h('input', { type: 'checkbox', class: 'switch', checked: m.enabled, 'aria-label': `启用 @${m.name}` });
    const title = h('input', { type: 'text', value: m.title, maxlength: 40, placeholder: m.defaultTitle, 'aria-label': `@${m.name} 的一句话分工` });
    const role = h('textarea', { class: 'field', rows: 4, maxlength: 800, placeholder: m.defaultRole, 'aria-label': `@${m.name} 的详细分工` });
    role.value = m.role;
    const box = h('div', { class: 'r mem-edit', hidden: true },
      h('div', { class: 'me-f' },
        h('label', {}, h('span', {}, '一句话分工', h('small', {}, '协调员按它派活，群里和成员栏也显示它')), title),
        h('label', {}, h('span', {}, '详细分工', h('small', {}, '写给这位成员自己看的工作说明')), role),
        h('div', { class: 'me-act' }, h('button', { class: 'btn small', onclick: () => { title.value = m.defaultTitle; role.value = m.defaultRole; } }, '恢复出厂分工'))));
    const sub = h('small', {});
    const drawSub = () => { sub.textContent = [title.value.trim() || m.defaultTitle, m.accountLabel, !on.checked ? '已停用' : m.connected ? null : '未连接'].filter(Boolean).join(' · '); };
    title.addEventListener('input', drawSub); on.addEventListener('change', drawSub); drawSub();
    const edit = h('button', { class: 'btn small', 'aria-expanded': 'false', onclick: () => { box.hidden = !box.hidden; edit.setAttribute('aria-expanded', String(!box.hidden)); edit.textContent = box.hidden ? '改分工' : '收起'; } }, '改分工');
    const head = h('div', { class: 'r' }, h('span', { class: 'rl' }, memTok(m.name), m.coordinator && h('span', { class: 'tag', title: '没人被点名的需求由它接' }, '协调员'), sub), edit, on);
    return [m.name, { on, title, role, nodes: [head, box] }];
  }));
  const sm = S.proj.summary ?? {};
  const sumAgent = h('select', { class: 'pill' }, S.app.agents.map((a) => h('option', { value: a.name, selected: a.name === sm.writer }, `@${a.name}（${S.app.tiers[a.name]?.快速?.label ?? ''}${a.payPerUse ? '，按量付费' : ''}）`)));
  const sumEvery = num({ min: 5, max: 500, value: sm.every ?? 30 });
  const sumAuto = h('input', { type: 'checkbox', class: 'switch', checked: sm.auto !== false });
  const par = Object.fromEntries(S.app.agents.map((a) => [a.name, num({ min: 1, max: 6, value: S.proj.parallel?.[a.name] ?? 1 })]));
  const row = (label, small, control) => h('label', { class: 'r' }, h('span', { class: 'rl' }, label, small && h('small', {}, small)), control);
  const group = (label, rows, hint) => h('div', { class: 'group' }, label && h('div', { class: 'glabel' }, label), h('div', { class: 'rows' }, rows), hint && h('div', { class: 'ghint' }, hint));
  const themeSeg = h('div', { class: 'segmented' });
  const drawTheme = () => themeSeg.replaceChildren(...THEMES.map(([k, label]) => h('button', { class: themePref() === k ? 'on' : '', onclick: () => { setTheme(k); drawTheme(); } }, label)));
  drawTheme();
  // ---- 模型：目录里的全部模型都能选，选完模型再选推理强度 ----
  const cat = S.app.catalog ?? {};
  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
  const allNames = (S.app.members ?? []).map((m) => m.name);
  const onNames = S.app.agents.map((a) => a.name);
  const custom = Object.fromEntries(allNames.map((a) => [a, [...(S.app.settings.customModels?.[a] ?? [])]]));
  const modelsOf = (a) => {
    const base = (cat[a]?.models ?? []).filter((x) => x.source !== 'custom');
    const ef = cat[a]?.customEfforts ?? FIVE;
    const mine = (custom[a] ?? []).filter((c) => !base.some((b) => b.id === c.id)).map((c) => ({ id: c.id, label: c.label || c.id, efforts: ef, defaultEffort: ef.includes('medium') ? 'medium' : ef[0], source: 'custom' }));
    return [...base, ...mine];
  };
  const pairs = [];
  // 一对下拉框：模型 + 推理强度。换了模型，推理强度的选项跟着变，并回到这个模型的默认档
  const modelPair = (a, val, label) => {
    const ms = h('select', { class: 'pill', 'aria-label': `${label}的模型` });
    const es = h('select', { class: 'pill', 'aria-label': `${label}的推理强度`, title: '推理强度：越高想得越久，也越费额度' });
    const drawE = () => {
      const m = modelsOf(a).find((x) => x.id === val.model);
      const list = m?.efforts ?? S.app.efforts ?? FIVE;
      if (!list.includes(val.effort)) val.effort = m?.defaultEffort ?? list[0];
      es.replaceChildren(...list.map((ef) => h('option', { value: ef, selected: ef === val.effort }, ef)));
    };
    const draw = () => {
      const list = modelsOf(a);
      ms.replaceChildren(...list.map((x) => h('option', { value: x.id, selected: x.id === val.model }, x.label + (x.source === 'custom' ? '（自己加的）' : ''))));
      if (!list.some((x) => x.id === val.model)) ms.append(h('option', { value: val.model, selected: true }, `${val.model}（已不在目录里）`));
      drawE();
    };
    ms.addEventListener('change', () => { val.model = ms.value; val.effort = modelsOf(a).find((x) => x.id === val.model)?.defaultEffort ?? val.effort; drawE(); });
    es.addEventListener('change', () => { val.effort = es.value; });
    draw();
    pairs.push(draw);
    return { ms, es };
  };
  // 设了固定模型的成员不看档位表，表里就不列它
  // 档位表只列有模型清单的成员：走 ACP、没有内置清单的成员用它自己的默认模型（想指定就在“自己加的模型”里加）
  const tierAgents = allNames.filter((a) => !cat[a]?.locked && (cat[a]?.models?.length ?? 0) > 0);
  const tierVal = Object.fromEntries(tierAgents.map((a) => [a, Object.fromEntries([...S.app.levels].reverse().map((lv) => [lv, { model: S.app.tiers[a]?.[lv]?.model, effort: S.app.tiers[a]?.[lv]?.effort }]))]));
  const tierRows = tierAgents.filter((a) => onNames.includes(a)).flatMap((a) => Object.keys(tierVal[a]).map((lv) => {
    const { ms, es } = modelPair(a, tierVal[a][lv], `@${a} ${lv}档`);
    return h('tr', {}, h('td', {}, memTok(a)), h('td', {}, `${lv}档`), h('td', {}, ms), h('td', {}, es));
  }));
  // 固定模型：出厂不固定。打开后这位成员只用这一个模型和这一档推理强度
  const lockWho = onNames.find((a) => cat[a]?.lockable) ?? null;
  const lockVal = { ...(cat[lockWho]?.locked ?? cat[lockWho]?.lockable ?? {}) };
  const lockPair = lockWho ? modelPair(lockWho, lockVal, `@${lockWho} 固定用`) : null;
  const lockOn = h('input', { type: 'checkbox', class: 'switch', checked: !!cat[lockWho]?.locked, 'aria-label': `@${lockWho} 固定只用一个模型` });
  const syncLock = () => { lockPair.ms.disabled = lockPair.es.disabled = !lockOn.checked; };
  if (lockPair) { lockOn.addEventListener('change', syncLock); syncLock(); }
  const price = (id) => { const pr = S.app.deepseekPrices?.prices?.[id]?.off; return pr ? `输入 ¥${pr.miss}、输出 ¥${pr.out}` : '价格表里还没有'; };
  const dsPrices = (cat.DeepSeek?.models ?? []).map((x) => `${x.label}：${price(x.id)}`).join('；');
  // 自己加的模型
  const addWho = h('select', { class: 'pill', 'aria-label': '给哪位成员加模型' }, onNames.map((a) => h('option', { value: a }, `@${a}`)));
  const addId = h('input', { type: 'text', placeholder: '命令行认的模型名，例如 gpt-7-sol', 'aria-label': '模型名', spellcheck: 'false', autocomplete: 'off' });
  const addName = h('input', { type: 'text', placeholder: '显示的名字（可不填）', 'aria-label': '显示的名字' });
  const customBox = h('div', { class: 'rows' });
  const drawCustom = () => {
    const rows = onNames.flatMap((a) => (custom[a] ?? []).map((c) => h('div', { class: 'r' },
      h('span', { class: 'rl' }, c.label || c.id, h('small', {}, `${a} · ${c.id}`)),
      h('button', { class: 'btn small destructive', onclick: () => { custom[a] = custom[a].filter((x) => x !== c); drawCustom(); pairs.forEach((d) => d()); } }, '删掉'))));
    if (!rows.length) rows.push(h('div', { class: 'r' }, h('span', { class: 'rl faint' }, '还没有自己加的模型')));
    customBox.replaceChildren(...rows, h('div', { class: 'r wrap' }, addWho, addId, addName, h('button', { class: 'btn small', onclick: addCustom }, '加上')));
  };
  const addCustom = () => {
    const a = addWho.value, id = addId.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:\[\]\/-]{1,79}$/.test(id)) return toast('模型名要写命令行认的那个名字，只能有字母、数字和 . _ - : / [ ]', true);
    if (modelsOf(a).some((x) => x.id === id)) return toast(`@${a} 的目录里已经有 ${id} 了`, true);
    custom[a] = [...(custom[a] ?? []), { id, label: addName.value.trim() || id }];
    addId.value = ''; addName.value = '';
    drawCustom(); pairs.forEach((d) => d());
    toast(`已加到 @${a} 的目录里，点“保存”后生效`);
  };
  drawCustom();

  const save = async () => {
    const kindLevel = Object.fromEntries(Object.entries(sels).map(([k, el]) => [k, el.value]));
    await api(P('settings'), { hopLimit: Number(hop.value), runTimeoutMin: Number(tmo.value), kindLevel,
      summaryAgent: sumAgent.value, summaryEvery: Number(sumEvery.value), summaryAuto: sumAuto.checked,
      parallel: { ...(s.parallel ?? {}), ...Object.fromEntries(Object.entries(par).map(([k, el]) => [k, Number(el.value)])) } });
    const members = Object.fromEntries(Object.entries(mem).map(([k, v]) => [k, { enabled: v.on.checked, title: v.title.value, role: v.role.value }]));
    const lock = lockPair ? { ...Object.fromEntries(Object.entries(cat).filter(([a, c]) => a !== lockWho && c.locked).map(([a, c]) => [a, c.locked])), ...(lockOn.checked ? { [lockWho]: lockVal } : {}) } : undefined;
    S.app = await api('/api/app/settings', { members, customModels: custom, tiers: tierVal, ...(lock ? { modelLock: lock } : {}) });
    closeSheet(); toast('已保存'); renderAll(); loadProject();
  };
  sheet({
    title: `设置 ·「${S.proj.name}」`, size: 'mid',
    body: h('div', { class: 'form' },
      group('成员', Object.values(mem).flatMap((v) => v.nodes),
        '对所有项目生效。停用的成员不会被唤醒，也不出现在群里和 @ 按钮里；它手上的任务卡会停着，等你改派，或重新打开它接着做。按量付费的成员打开就表示允许它用自己的 API key；订阅额度用尽时不会自动换成收费 API。'),
      group('交接和运行', [
        row('成员之间最多自动交接几次', '一条需求里超过这个次数，就停下来问你', hop),
        row('单次运行最长多少分钟', '超时自动停止', tmo)]),
      group('同时开几个会话', S.app.agents.map((a) => row(memTok(a.name), a.payPerUse ? '按量付费，开多了花钱更快' : null, par[a.name])),
        '每张任务卡一个会话；同一位成员的几个会话各写各的范围，互相改不到。'),
      group('任务类型 → 模型档位', h('table', { class: 'plain' },
        h('thead', {}, h('tr', {}, h('th', {}, '任务类型'), h('th', {}, '档位'), onNames.map((a) => h('th', {}, `${a} 用`)))),
        h('tbody', {}, Object.keys(table).map((kind) => {
          const cells = onNames.map((a) => [a, h('td', { class: 'muted' })]);
          const fill = () => { for (const [a, td] of cells) td.textContent = S.app.tiers[a]?.[sel.value]?.label ?? ''; };
          const sel = sels[kind] = h('select', { class: 'pill', onchange: fill }, S.app.levels.map((lv) => h('option', { value: lv, selected: table[kind] === lv }, lv)));
          fill();
          return h('tr', {}, h('td', {}, kind), h('td', {}, sel), cells.map(([, td]) => td));
        }))),
        `成员的模型选“自动”时按这张表选；订阅成员的任务被打回重做会自动升一档。“闲聊”指不建任务卡的对话（问一句、说一声），默认用快速档，省额度。${onNames.filter((a) => cat[a]?.locked).map((a) => `@${a} 设了固定模型，不看这张表。`).join('')}`),
      group('自动选模型时，三档各用哪个模型', h('table', { class: 'plain' },
        h('thead', {}, h('tr', {}, ['成员', '档位', '模型', '推理强度'].map((x) => h('th', {}, x)))),
        h('tbody', {}, tierRows)),
        `对所有项目生效。目录里的模型都能选：${cat.Codex?.source ?? ''}里现在有 ${(cat.Codex?.models ?? []).filter((x) => x.source !== 'custom').length} 个，Claude 有 ${(cat.Claude?.models ?? []).filter((x) => x.source !== 'custom').length} 个。想让某位成员一直用同一个模型，在左栏它的下拉框里直接选。`),
      lockPair && group(`@${lockWho} 固定用一个模型`, [
        h('label', { class: 'r' }, h('span', { class: 'rl' }, '固定只用这一个', h('small', {}, '打开后，自动选模型、任务卡档位、打回重做，都不会换它')), lockOn),
        h('div', { class: 'r' }, h('span', { class: 'rl' }, '模型和推理强度'), lockPair.ms, lockPair.es)],
        lockWho === 'DeepSeek' ? `按量付费，对所有项目生效。想控制花费时打开。deepseek-flash 这个名字由官方指向最新的 Flash，官方更新后自动用新的。空闲时段每百万 token：${dsPrices}（高峰时段翻倍）。` : '对所有项目生效。想控制花费时打开。'),
      group('自己加的模型', customBox,
        '以后出了新模型、目录里还没有，就在这里加：选成员，填命令行认的模型名。加完它会出现在上面和左栏的下拉框里。名字填错的话运行时会报错，删掉重加即可。'),
      group('群摘要', [
        row('由谁来写', '用它的快速档模型', sumAgent),
        row('群里空闲时自动更新', null, sumAuto),
        row('每攒够多少条新发言更新一次', null, sumEvery)]),
      group('外观', [h('div', { class: 'r' }, h('span', { class: 'rl' }, '浅色或深色', h('small', {}, '只影响这台电脑上的这个浏览器，立即生效')), themeSeg)])),
    foot: [h('button', { class: 'btn', onclick: closeSheet }, '取消'), h('button', { class: 'btn prominent', onclick: save }, '保存')],
  });
}

// ---- ⌘K：搜索项目、任务卡、成员、文件，或者执行操作 ---------------------------
const PAL = { items: [], idx: 0 };
function paletteSource() {
  const out = [];
  const add = (group, it) => out.push({ group, ...it });
  if (S.pid) add('操作', { title: '新对话', icon: 'compose', sub: curProj()?.name ?? '', run: () => openChat(S.pid, 'new') });
  add('操作', { title: '新建项目…', icon: 'plus', run: newProjectDialog });
  if (S.proj) {
    const paused = S.proj.settings.paused;
    const sm = S.proj.summary ?? {};
    const wait = S.proj.tasks.filter((t) => t.state === 'awaiting_owner').length;
    if (wait) add('操作', { title: `看等我验收的 ${wait} 张任务卡`, icon: 'tray', run: () => showWaiting() });
    add('操作', { title: '项目设置…', icon: 'sliders', run: settingsDialog });
    add('操作', { title: paused ? '恢复项目' : '暂停项目', icon: paused ? 'play' : 'pause', sub: paused ? '成员重新开始接活' : '成员暂时不接新活', run: togglePause });
    if (!sm.running && (!sm.text || sm.newCount)) add('操作', { title: sm.text ? '更新群摘要' : '生成群摘要', icon: 'doc', sub: `由 @${sm.writer} 整理`, run: makeSummary });
    add('操作', { title: '在访达中显示项目文件夹', icon: 'folder', run: openProjectFolder });
  }
  add('操作', { title: '重新检测成员和额度', icon: 'refresh', run: () => refreshQuota().catch(() => {}) });
  for (const [k, label, ic] of THEMES) add('外观', { title: `外观：${label}`, icon: ic, sub: themePref() === k ? '当前' : '', run: () => setTheme(k) });
  for (const p of S.app?.projects ?? []) add('项目', { title: p.name, icon: 'folder', sub: p.id === S.pid ? '当前项目' : p.waitingOwner ? `${p.waitingOwner} 个待验收` : '', run: () => switchProject(p.id) });
  for (const p of S.app?.projects ?? []) for (const c of p.chats) add('对话', { title: c.title, icon: 'doc', sub: p.name + (c.archived ? ' · 已归档' : ''), onlySearch: p.id !== S.pid || c.archived, run: () => openChat(p.id, c.id) });
  for (const t of S.proj?.tasks ?? []) add('任务卡', { title: `${t.id} ${t.title}`, icon: 'card', sub: `@${t.owner} · ${t.stateLabel}`, run: () => focusTask(t.id) });
  for (const a of S.app?.agents ?? []) add('成员', { title: `@${a.name}`, who: a.name, sub: a.connected ? a.title : '未连接', run: () => mention(a) });
  for (const f of S.proj?.files ?? []) add('文件', { title: base(f.path), icon: 'doc', sub: f.path, onlySearch: true, run: () => openFile(f.path) });
  return out;
}
function renderPalette() {
  const words = $('#paletteInput').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const perGroup = {};
  PAL.items = paletteSource().filter((it) => {
    if (!words.length ? it.onlySearch : !words.every((w) => `${it.title} ${it.sub ?? ''} ${it.group}`.toLowerCase().includes(w))) return false;
    perGroup[it.group] = (perGroup[it.group] ?? 0) + 1;
    return perGroup[it.group] <= (words.length ? 12 : 8);
  });
  PAL.idx = Math.max(0, Math.min(PAL.idx, PAL.items.length - 1));
  const list = $('#paletteList');
  const nodes = [];
  let group = '';
  PAL.items.forEach((it, i) => {
    if (it.group !== group) { group = it.group; nodes.push(h('div', { class: 'p-group' }, group)); }
    nodes.push(h('button', { class: `p-item ${i === PAL.idx ? 'on' : ''}`, dataset: { i }, onclick: () => runPalette(i), onmousemove: () => { if (PAL.idx !== i) { PAL.idx = i; markPalette(); } } },
      it.who ? face(it.who, 's') : h('span', { class: 'pi-ic' }, icon(it.icon)),
      h('span', { class: 'pi-t' }, it.title), it.sub ? h('span', { class: 'pi-s' }, it.sub) : null));
  });
  if (!nodes.length) nodes.push(h('div', { class: 'empty' }, '没有找到，可以搜项目名、对话、任务卡、成员、文件名，或者“设置”“暂停”这样的操作'));
  list.replaceChildren(...nodes);
}
function markPalette() {
  for (const el of $('#paletteList').querySelectorAll('.p-item')) el.classList.toggle('on', Number(el.dataset.i) === PAL.idx);
}
function runPalette(i) { const it = PAL.items[i]; if (!it) return; closePalette(); it.run(); }
function openPalette() {
  closeMenu();
  $('#palette').hidden = false;
  const i = $('#paletteInput'); i.value = ''; PAL.idx = 0;
  renderPalette(); i.focus();
}
function closePalette() { $('#palette').hidden = true; }
$('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });
$('#paletteInput').addEventListener('input', () => { PAL.idx = 0; renderPalette(); });
$('#paletteInput').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!PAL.items.length) return;
    PAL.idx = (PAL.idx + (e.key === 'ArrowDown' ? 1 : -1) + PAL.items.length) % PAL.items.length;
    markPalette();
    $('#paletteList .p-item.on')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') { e.preventDefault(); runPalette(PAL.idx); }
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('#palette').hidden) openPalette(); else closePalette();
    return;
  }
  if (e.key !== 'Escape') return;
  if (!$('#palette').hidden) closePalette();
  else if (!$('#popover').hidden) closeMenu();
  else if (!$('#sheet').hidden) closeSheet();
  else if (S.agentOpen) closeAgent();
  else closeDrawers();
});

// ---- 启动 -----------------------------------------------------------------
applyTheme();
try {
  await loadApp();
  await loadProject();
  markRead();
  // 等页面载入完成再开推送连接：载入途中就开的话，标签页上的转圈会一直转
  if (document.readyState === 'complete') connectProject();
  else addEventListener('load', () => setTimeout(connectProject, 0), { once: true });
} catch (e) {
  renderAll();
  toast(`连不上工作台：${e.message}。确认工作台还开着，然后刷新这个页面。`, true);
}
setInterval(() => { renderSidebar(); }, 30000);   // 让“几分钟前”“多久后重置”保持新鲜
