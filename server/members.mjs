// 群成员、分工、模型档位。
import { OWNER } from './mentions.mjs';
import { lockOf, appTiers, normalizeEffort, modelLabel } from './models.mjs';

export { OWNER };
export const COORDINATOR = 'Claude';
export const AGENTS = ['Claude', 'Codex', 'DeepSeek'];

export const MEMBERS = {
  Claude: {
    account: 'Claude',
    accountLabel: 'Claude 订阅',
    title: '协调员 · 干活主力 · 需求与审查',
    role:
      '你是默认协调员、需求和审查负责人，也是干活的主力：方案、界面、文档和一般的代码实现默认由你承担，不只做拆单和审查。' +
      '没人被点名的需求由你接：把它拆成任务卡，写清负责人、交付物和验收条件。派活时看各成员是否已连接、额度还剩多少，谁的额度多就多偏向谁。' +
      '你自己写的东西必须交给 Codex 审，不能自己审自己。',
  },
  Codex: {
    account: 'Codex',
    accountLabel: 'ChatGPT 订阅（Codex）',
    title: '工程负责人',
    role:
      '你是工程负责人：做自动化脚本、接入、集成和测试。遇到不明文件格式可以直接 @DeepSeek。' +
      '完成后提交实际文件、运行方法和测试结果，交给 Claude 审查。工程量大或你的额度紧张时，Claude 会分担实现，你改做审查。',
  },
  DeepSeek: {
    account: 'DeepSeek',
    accountLabel: 'DeepSeek API（按量付费）',
    payPerUse: true,
    title: '逆向与兼容性分析',
    role:
      '你负责对群主自有或获授权的软件、文件格式和版本差异做分析：对照样例找出字段变化，提交样例、证据、结论和未知项，再交给 Codex 实现。' +
      '只分析项目里提供的材料。',
  },
};

// 一位成员在一个项目里最多同时开几个会话（群主可在设置里改）。
// Claude 是干活主力，默认开得多；DeepSeek 按量付费，默认不并行。
export const DEFAULT_PARALLEL = { Claude: 3, Codex: 2, DeepSeek: 1 };
export const MAX_PARALLEL = 6;

// 默认审查人：谁干的活，就由另一位来审。
export function defaultReviewer(owner, connected) {
  const prefer = owner === 'Claude' ? ['Codex', 'DeepSeek'] : ['Claude', 'Codex', 'DeepSeek'];
  return prefer.find((n) => n !== owner && connected.includes(n)) ?? null;
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
    if (MEMBERS[agent]?.payPerUse) { if (up !== level) why += '（被打回过；按量付费不自动升档，要升请在任务卡上改）'; }
    else if (up !== level) { level = up; why += '，被打回过所以升一档'; }
  }
  // 高档模型的额度快用完时，自动降一档，把剩下的留给真正需要的任务
  if (level === '高' && highTierLow) { level = '常规'; why += '，但高档额度不足所以降一档'; }
  const t = tiers[level] ?? tiers.常规;
  return { model: t.model, effort: t.effort, by: `自动：${why}`, level };
}
