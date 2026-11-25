// 群成员（启用了哪些、各自的分工）、默认审查人、模型档位。
// 成员的出厂资料在 roster.mjs；群主在设置里改的（启用 / 停用、分工）存在 data/settings.json 的 members 里，启动和保存时经 configureMembers 生效。
import { OWNER } from './mentions.mjs';
import { ROSTER, ALL_AGENTS, rowOf } from './roster.mjs';
import { lockOf, appTiers, normalizeEffort, modelLabel } from './models.mjs';

export { OWNER, ALL_AGENTS };

// ---- 群主的设置：启用、停用、改分工 ----------------------------------------------
export const TITLE_MAX = 40;
export const ROLE_MAX = 800;
const fail = (msg) => { const e = new Error(msg); e.userFacing = true; throw e; };
let over = {};          // { Codex: { enabled: false, title: '…', role: '…' } }，只存和出厂不一样的

// 检查群主填的内容。分工留空 = 恢复出厂；和出厂一样的不存，以后出厂分工更新了也能跟着变
export function cleanMemberSettings(input) {
  const out = {};
  for (const r of ROSTER) {
    const v = input?.[r.name];
    if (!v || typeof v !== 'object') continue;
    const o = {};
    if (typeof v.enabled === 'boolean' && v.enabled !== r.enabled) o.enabled = v.enabled;
    if (v.title != null) {
      const t = String(v.title).replace(/\s+/g, ' ').trim();
      if (t.length > TITLE_MAX) fail(`@${r.name} 的一句话分工最多 ${TITLE_MAX} 个字`);
      if (t && t !== r.title) o.title = t;
    }
    if (v.role != null) {
      const t = String(v.role).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
      if (t.length > ROLE_MAX) fail(`@${r.name} 的详细分工最多 ${ROLE_MAX} 个字`);
      if (t && t !== r.role) o.role = t;
    }
    if (Object.keys(o).length) out[r.name] = o;
  }
  if (!ROSTER.some((r) => out[r.name]?.enabled ?? r.enabled)) fail('至少要留一位成员启用');
  return out;
}
export function configureMembers(input) { over = cleanMemberSettings(input ?? {}); return over; }
// 旧版设置升级：以前单独有个“允许 DeepSeek 使用 API key”开关，现在并进了成员表里 DeepSeek 那一行的启用开关
export function upgradeSettings(settings) {
  const s = { ...(settings ?? {}) };
  if ('deepseekApiAllowed' in s) {
    if (s.deepseekApiAllowed === false) s.members = { ...s.members, DeepSeek: { ...s.members?.DeepSeek, enabled: false } };
    delete s.deepseekApiAllowed;
  }
  return s;
}

// 一位成员现在的资料：出厂的 + 群主改的
export function member(name) {
  const r = rowOf(name);
  if (!r) return null;
  const o = over[name] ?? {};
  return { ...r, enabled: o.enabled ?? r.enabled, title: o.title ?? r.title, role: o.role ?? r.role, defaultTitle: r.title, defaultRole: r.role };
}
export const isEnabled = (name) => !!member(name)?.enabled;
export const enabledAgents = () => ALL_AGENTS.filter(isEnabled);
// 协调员：表里标了 coordinator 的那位；它停用了，就由表里第一位启用的成员接
export function coordinator() {
  const pref = ROSTER.find((r) => r.coordinator);
  return pref && isEnabled(pref.name) ? pref.name : enabledAgents()[0] ?? ALL_AGENTS[0];
}

// 一位成员在一个项目里最多同时开几个会话（群主可在设置里改）。出厂值在成员表里
export const DEFAULT_PARALLEL = Object.fromEntries(ROSTER.map((r) => [r.name, r.parallel]));
export const MAX_PARALLEL = 6;

// 默认审查人：谁干的活，就由另一位来审。先找协调员，再按表里的顺序找订阅成员，按量付费的放最后
export function defaultReviewer(owner, connected) {
  const order = [coordinator(), ...ROSTER.filter((r) => !r.payPerUse).map((r) => r.name), ...ROSTER.filter((r) => r.payPerUse).map((r) => r.name)];
  return [...new Set(order)].find((n) => n !== owner && connected.includes(n)) ?? null;
}

// ---- 模型档位 ----------------------------------------------------------
// “自动选模型”时用的三档：高 / 常规 / 快速。每一档是一个模型加一档推理强度（effort）。
// 这是出厂默认；群主可以在设置里把每一档换成目录里的任何模型（见 models.mjs）。
// DeepSeek 按量付费，模型只有一个，三档只差推理强度；群主也可以在设置里让它固定只用一个（models.mjs 的 LOCKABLE）。
export const DEFAULT_TIERS = {
  Claude: {
    高: { model: 'claude-fable-5-2', effort: 'high', label: 'Fable 5.2' },
    常规: { model: 'claude-opus-5-5', effort: 'high', label: 'Opus 5.5' },
    快速: { model: 'claude-sonnet-5-5', effort: 'medium', label: 'Sonnet 5.5' },
  },
  Codex: {
    高: { model: 'gpt-6-astra', effort: 'xhigh', label: 'gpt-6-astra · xhigh' },
    常规: { model: 'gpt-6-astra', effort: 'medium', label: 'gpt-6-astra · medium' },
    快速: { model: 'gpt-6-astra', effort: 'low', label: 'gpt-6-astra · low' },
  },
  DeepSeek: {
    高: { model: 'deepseek-flash', effort: 'max', label: 'DeepSeek-V4.1-Flash · max' },
    常规: { model: 'deepseek-flash', effort: 'high', label: 'DeepSeek-V4.1-Flash · high' },
    快速: { model: 'deepseek-flash', effort: 'low', label: 'DeepSeek-V4.1-Flash · low' },
  },
};

// 任务类型 → 档位 的默认对照表（群主可在项目设置里改）。
export const DEFAULT_KIND_LEVEL = {
  方案: '高', 排查: '高', 终审: '高',
  协调: '常规', 实现: '常规', 分析: '常规', 审查: '常规', 文档: '常规',
  摘要: '快速', 整理: '快速',
  闲聊: '快速',      // 不建任务卡的对话：问一句、说一声这类
};
export const LEVELS = ['快速', '常规', '高'];

// 这位成员现在三档各用什么：出厂默认 ← 群主在设置里改的 ← 项目里单独改的。固定模型的成员三档都是那一个。
export function tiersFor(agent, settings) {
  const lock = lockOf(agent);
  const out = {};
  for (const lv of LEVELS) {
    const t = lock ? { ...lock } : { ...DEFAULT_TIERS[agent]?.[lv], ...(appTiers()[agent]?.[lv] ?? {}), ...(settings?.tiers?.[agent]?.[lv] ?? {}) };
    out[lv] = { model: t.model, effort: t.effort ?? null, label: `${modelLabel(agent, t.model)}${t.effort ? ' · ' + t.effort : ''}` };
  }
  return out;
}

// 选模型：固定模型的成员 > 任务上指定 > 成员上手动指定 > 任务卡上的档位 > 按任务类型查表。打回重做升一档。
export function pickModel({ agent, task, settings, reason, highTierLow = false }) {
  const lock = lockOf(agent);
  if (lock) return { model: lock.model, effort: lock.effort, by: '固定：群主指定这位成员只用这一个模型', level: null };
  const tiers = tiersFor(agent, settings);
  const manual = settings?.memberModel?.[agent];
  if (task?.model) {
    return { model: task.model, effort: tiers.常规?.effort, by: '群主指定（任务）', level: null };
  }
  if (manual && manual !== 'auto') {
    // 现在的写法：{ model, effort }，界面上先选模型、再选推理强度
    if (typeof manual === 'object') {
      return { model: manual.model, effort: normalizeEffort(agent, manual.model, manual.effort), by: '群主指定（固定模型）', level: null };
    }
    // 旧写法 “模型|档位”（同一个模型在不同档位推理强度不同）
    const [m, lv] = String(manual).split('|');
    const tier = tiers[lv] ?? Object.values(tiers).find((v) => v.model === m);
    return { model: m, effort: tier?.effort ?? tiers.常规?.effort, by: `群主指定（固定${lv ? ' ' + lv + '档' : ''}）`, level: lv ?? null };
  }
  const table = { ...DEFAULT_KIND_LEVEL, ...(settings?.kindLevel ?? {}) };
  let level = '常规';
  let why = '默认常规档';
  if (reason === 'review_request') { level = table.审查; why = '审查任务'; }
  else if (reason === 'coordinate') { level = table.协调; why = '协调派单'; }
  else if (reason === 'chat') { level = table.闲聊 ?? '快速'; why = '不建任务卡的对话'; }
  else if (task) {
    if (task.level && LEVELS.includes(task.level) && task.level_set) { level = task.level; why = `任务卡标注「${task.level}」档`; }
    else { level = table[task.kind] ?? '常规'; why = `任务类型「${task.kind}」`; }
  }
  if (task && task.rework > 0) {
    const up = LEVELS[Math.min(LEVELS.indexOf(level) + 1, LEVELS.length - 1)];
    // 按量付费的成员升档等于多花钱，这要群主自己决定，所以不自动升
    if (member(agent)?.payPerUse) { if (up !== level) why += '（被打回过；按量付费不自动升档，要升请在任务卡上改）'; }
    else if (up !== level) { level = up; why += '，被打回过所以升一档'; }
  }
  // 高档模型的额度快用完时，自动降一档，把剩下的留给真正需要的任务
  if (level === '高' && highTierLow) { level = '常规'; why += '，但高档额度不足所以降一档'; }
  const t = tiers[level] ?? tiers.常规;
  return { model: t.model, effort: t.effort, by: `自动：${why}`, level };
}
