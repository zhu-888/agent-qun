// 模型目录：每位成员能用哪些模型、每个模型有哪些推理强度；群主自己加的模型；固定只用一个模型的成员。
//
// 清单从哪里来：
//   Claude   → 内置清单（Claude Code 命令行没有“列出模型”的命令）；推理强度是 claude --effort 接受的五档
//   Codex    → Codex 命令行自己维护的模型清单（~/.codex/models_cache.json），读不到时用内置清单
//   DeepSeek → 官方接口 /models 返回的清单，读不到时用内置清单
// 群主自己加的模型存在工作台设置里（data/settings.json 的 customModels）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_AGENTS } from './roster.mjs';

// 成员表里的全部成员（停用的也算：它的模型设置要留着，重新启用时还在）
export const AGENT_NAMES = ALL_AGENTS;
export const TIER_LEVELS = ['快速', '常规', '高'];
// 推理强度从低到高。不同模型支持的范围不一样，以目录里每个模型的 efforts 为准。
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const SIX = [...FIVE, 'ultra'];
const BUILTIN = {
  Claude: [
    { id: 'claude-fable-5-2', label: 'Fable 5.2', efforts: FIVE, defaultEffort: 'high' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: FIVE, defaultEffort: 'high' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: FIVE, defaultEffort: 'medium' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: FIVE, defaultEffort: 'medium' },
  ],
  // 2026-11-13 从 Codex 0.163.0 的模型清单抄下来的，只在读不到清单时用
  Codex: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: SIX, defaultEffort: 'low' },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: SIX, defaultEffort: 'medium' },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: SIX, defaultEffort: 'low' },
    { id: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: SIX, defaultEffort: 'medium' },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: FIVE, defaultEffort: 'medium' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: SIX, defaultEffort: 'low' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: SIX, defaultEffort: 'medium' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: FIVE, defaultEffort: 'medium' },
  ],
  DeepSeek: [
    { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  ],
};
const SOURCE = {
  Claude: '内置清单（Claude 命令行没有列出模型的命令）',
  Codex: 'Codex 命令行自己的模型清单',
  DeepSeek: 'DeepSeek 官方接口 /models',
};

// 可以设成“固定只用一个模型、一个推理强度”的成员，和打开时默认填的模型。出厂不固定，按档位表自动选；
// 群主在设置里打开后，自动选模型、任务卡档位、打回重做都不会换它（按量付费的成员想控制花费时用）。
// deepseek-flash 这个名字由官方指向最新的 Flash：官方更新后自动跟着用新的。
export const LOCKABLE = { DeepSeek: { model: 'deepseek-flash', effort: 'max' } };

const state = {
  custom: {},          // 群主自己加的模型：{ Claude: [{ id, label }], Codex: [...] }
  tiers: {},           // 群主改过的档位：{ Claude: { 高: { model, effort } } }
  lock: {},            // 群主打开的固定模型：{ DeepSeek: { model, effort } }；没有就是不固定
  live: {},            // 从命令行 / 官方接口读到的清单：{ Codex: { models, fetchedTs } }
};

// ---- 读清单 --------------------------------------------------------------
const CODEX_CACHE = path.join(os.homedir(), '.codex/models_cache.json');
export function readCodexModels(file = CODEX_CACHE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const models = (j.models ?? [])
      .filter((m) => m.slug && m.visibility === 'list')
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
      .map((m) => {
        const efforts = (m.supported_reasoning_levels ?? []).map((x) => (typeof x === 'string' ? x : x?.effort)).filter(Boolean);
        return { id: m.slug, label: m.display_name || m.slug, efforts: efforts.length ? efforts : FIVE, defaultEffort: m.default_reasoning_level || 'medium' };
      });
    return models.length ? { models, fetchedTs: Date.parse(j.fetched_at) || null } : null;
  } catch { return null; }
}
export function refreshCodexModels(file) { state.live.Codex = readCodexModels(file); return state.live.Codex; }
// DeepSeek 官方 /models 的返回 → 目录
export function setDeepseekModels(list) {
  const models = (list ?? []).filter((m) => m?.id).map((m) => ({
    id: m.id, label: m.name || m.id,
    efforts: m.effort?.supported_levels?.length ? m.effort.supported_levels : ['low', 'high', 'max'],
    defaultEffort: m.effort?.default_level || 'high',
  }));
  state.live.DeepSeek = models.length ? { models, fetchedTs: Date.now() } : null;
}

// ---- 目录 ----------------------------------------------------------------
export function lockOf(agent) {
  return state.lock[agent] ? { ...state.lock[agent] } : null;
}
export function catalog(agent) {
  const base = (state.live[agent]?.models ?? BUILTIN[agent] ?? []).map((m) => ({ ...m, source: state.live[agent] ? 'live' : 'builtin' }));
  const seen = new Set(base.map((m) => m.id));
  const lock = lockOf(agent);
  // 固定的那个模型不在读到的清单里（比如断网读不到、或官方改了名字）：照样列出来，不然界面上没法显示
  if (lock && !seen.has(lock.model)) { base.push({ id: lock.model, label: lock.model, efforts: [lock.effort], defaultEffort: lock.effort, source: 'missing' }); seen.add(lock.model); }
  const efforts = customEfforts(agent);
  const custom = (state.custom[agent] ?? []).filter((m) => !seen.has(m.id))
    .map((m) => ({ id: m.id, label: m.label || m.id, efforts, defaultEffort: efforts.includes('medium') ? 'medium' : 'high', source: 'custom' }));
  return [...base, ...custom];
}
// 自己加的模型能选哪几档推理强度（不知道它的真实范围，按这位成员的常见范围给）
export function customEfforts(agent) { return agent === 'DeepSeek' ? ['low', 'high', 'max'] : FIVE; }
export const findModel = (agent, id) => catalog(agent).find((m) => m.id === id) ?? null;
export const modelLabel = (agent, id) => findModel(agent, id)?.label ?? id;
// 这个模型不支持这一档推理强度时，退回它的默认档；目录里没有的模型原样放行
export function normalizeEffort(agent, id, effort) {
  const m = findModel(agent, id);
  if (!m) return effort ?? null;
  return m.efforts.includes(effort) ? effort : (m.defaultEffort ?? m.efforts[0] ?? null);
}
export const appTiers = () => state.tiers;
export function catalogView() {
  return Object.fromEntries(AGENT_NAMES.map((a) => [a, {
    models: catalog(a), locked: lockOf(a), lockable: LOCKABLE[a] ?? null, customEfforts: customEfforts(a),
    source: state.live[a] ? SOURCE[a] : a === 'Claude' ? SOURCE.Claude : SOURCE[a] ? `内置清单（没读到${SOURCE[a]}）` : '内置清单',
    fetchedTs: state.live[a]?.fetchedTs ?? null,
  }]));
}

// ---- 设置：检查群主填的内容，再生效 ---------------------------------------------
const fail = (msg) => { const e = new Error(msg); e.userFacing = true; throw e; };
// 模型名只能是这些字符：不会带换行、引号，拼进配置文件也改不了别的设置
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]\/-]{1,79}$/;
const ID_RE = MODEL_ID_RE;
export function cleanCustomModels(input) {
  const out = {};
  for (const a of AGENT_NAMES) {
    const list = input?.[a];
    if (!Array.isArray(list) || !list.length) continue;
    const seen = new Set();
    out[a] = [];
    for (const m of list) {
      const id = String(m?.id ?? '').trim();
      if (!ID_RE.test(id)) fail(`模型名「${id.slice(0, 40)}」不对：要写命令行认的那个名字，只能有字母、数字和 . _ - : / [ ]`);
      if (seen.has(id)) continue;
      seen.add(id);
      out[a].push({ id, label: String(m?.label ?? '').trim().slice(0, 40) || id });
    }
    if (out[a].length > 30) fail('每位成员最多加 30 个模型');
  }
  return out;
}
// 先把自己加的模型生效，再检查档位和固定模型（它们可以用到刚加的模型）
export function configureModels({ customModels, tiers, lock } = {}) {
  state.custom = cleanCustomModels(customModels ?? {});
  const t = {};
  for (const a of AGENT_NAMES) {
    for (const lv of TIER_LEVELS) {
      const v = tiers?.[a]?.[lv];
      if (!v?.model || !findModel(a, v.model)) continue;      // 引用了已经删掉的模型：这一档回到默认
      (t[a] ??= {})[lv] = { model: v.model, effort: normalizeEffort(a, v.model, v.effort) };
    }
  }
  state.tiers = t;
  const l = {};
  for (const a of Object.keys(LOCKABLE)) {
    const v = lock?.[a];
    if (!v?.model) continue;
    const id = String(v.model).trim();
    if (!ID_RE.test(id)) fail(`模型名「${id.slice(0, 40)}」不对`);
    // 清单里有这个模型就按它支持的推理强度来；清单里没有（读不到清单时）就照填的用
    const m = (state.live[a]?.models ?? BUILTIN[a] ?? []).find((x) => x.id === id);
    const effort = m ? (m.efforts.includes(v.effort) ? v.effort : m.defaultEffort) : (EFFORTS.includes(v.effort) ? v.effort : LOCKABLE[a].effort);
    l[a] = { model: id, effort };
  }
  state.lock = l;
  return { customModels: state.custom, tiers: state.tiers, lock: state.lock };
}
// 只给测试用：恢复出厂状态
export function resetModels() { state.custom = {}; state.tiers = {}; state.lock = {}; state.live = {}; }
