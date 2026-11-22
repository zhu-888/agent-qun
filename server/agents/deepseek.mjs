// @DeepSeek：真实的 DeepSeek Harness 无界面模式（dsh --profile headless --json）。
// DeepSeek 没有订阅额度，只有按量付费的 API key；群主已同意使用 DeepSeek Harness 里存的那把。
// 密钥只在启动进程时放进它的环境变量，不写日志、不写进项目、不在界面显示。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCli, cleanEnv, othersSecrets, clip, deniedLine } from './runner.mjs';

const LAUNCHER = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const CRED_FILE = path.join(os.homedir(), '.dsh/.credentials.yaml');
const QUOTA_RE = /insufficient balance|余额不足|quota|402|payment required/i;

// 官方价格（人民币元 / 百万 token）。群主的 DeepSeek 账号按人民币结算。
// 来源：api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-11-13 查）。peak = 高峰时段，off = 空闲时段。
export const DEEPSEEK_PRICES = {
  'deepseek-flash': { off: { miss: 1, hit: 0.02, out: 4 }, peak: { miss: 2, hit: 0.04, out: 8 } },
  'deepseek-v4-pro': { off: { miss: 4.5, hit: 0.15, out: 13.5 }, peak: { miss: 9, hit: 0.3, out: 27 } },
};
// 高峰：北京时间周一到周五 9:00–12:00、14:00–18:00（法定节假日除外；这里没法判断节假日，按工作日算）
export function isPeak(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000);   // 换算成北京时间
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 9 && h < 12) || (h >= 14 && h < 18));
}
// 按真实运行报回的 token 数估算这次花了多少钱
export function deepseekCost(model, usage, ts = Date.now()) {
  const table = DEEPSEEK_PRICES[model] ?? DEEPSEEK_PRICES['deepseek-flash'];
  const peak = isPeak(ts);
  const p = peak ? table.peak : table.off;
  const cny = ((usage.input ?? 0) * p.miss + (usage.cached ?? 0) * p.hit + (usage.output ?? 0) * p.out) / 1e6;
  return { cny, peak };
}

export function readDshKey() {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, source: '环境变量 DEEPSEEK_API_KEY' };
  try {
    for (const line of fs.readFileSync(CRED_FILE, 'utf8').split('\n')) {
      const m = /^\s*DEEPSEEK_API_KEY:\s*(.+?)\s*$/.exec(line);
      if (m) {
        const key = m[1].replace(/^["']|["']$/g, '');
        if (key) return { key, source: 'DeepSeek Harness 里存的 API key' };
      }
    }
  } catch { /* 没有这个文件 */ }
  return null;
}

export const deepseek = {
  name: 'DeepSeek',
  enabled: true,   // 由 main.mjs 按设置覆盖

  async detect() {
    if (!fs.existsSync(LAUNCHER)) return { connected: false, detail: '没有找到 DeepSeek Harness', fix: '安装 DeepSeek Harness 桌面 app 后重启工作台' };
    if (!this.enabled) return { connected: false, detail: '已安装，但群主没有允许使用按量付费的 API key', fix: '在设置里打开“允许 DeepSeek 使用 API key”' };
    const k = readDshKey();
    if (!k) return { connected: false, detail: '已安装，但没有找到 DeepSeek API key', fix: '在 DeepSeek Harness 的模型设置里填 API key' };
    return { connected: true, detail: `DeepSeek Harness 无界面模式 · ${k.source}`, billing: '按量 API' };
  },

  // DeepSeek Harness 的无界面模式一次只答一个任务，原生不支持运行中插话
  canInject: false,

  start({ cwd, prompt, sessionId, model, effort, pathPrefix, logPath, timeoutMs, patchDir, ephemeral = false, extraEnv = {}, sandbox = null, on }) {
    if (ephemeral) sessionId = null;
    const k = readDshKey();
    const args = [LAUNCHER, '--profile', 'headless'];
    // 用一个补丁文件指定模型和推理强度
    const entries = [];
    // 模型名、推理强度要拼进 YAML：只认规规矩矩的名字，带换行、引号的一律不要（否则能往配置里加别的设置）
    if (model && !/^[A-Za-z0-9][A-Za-z0-9._:\[\]\/-]{1,79}$/.test(model)) throw new Error(`模型名不对：${String(model).slice(0, 40)}`);
    if (effort && !/^[a-z]{2,10}$/.test(effort)) throw new Error(`推理强度不对：${String(effort).slice(0, 20)}`);
    if (model) {
      entries.push(`- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: deepseek-official\n    model: ${model}\n${effort ? `    reasoningEffort: ${effort}\n` : ''}`);
    }
    // DeepSeek Harness 0.2.2 起会给每条 shell 命令再套一层它自己的沙箱。工作台已经用 sandbox-exec 把整个进程包起来了，
    // 沙箱不能套沙箱，它的命令就全被拒绝（“no sandbox backend is usable … refusing to run the command unconfined”）。
    // 所以在工作台的沙箱里运行时，关掉它自己那层；能写哪里照样由外层沙箱强制。只影响新开的会话（旧会话开头就定下了）。
    if (sandbox?.profile) {
      entries.push('- id: permission\n  name: "@deepseek-ai/dsh-permission-presets"\n  config:\n    defaultPreset: danger-full-access\n');
    }
    if (entries.length) {
      // 文件名用内容的摘要：模型名里的 / 和 .. 拼不出别的路径
      const body = entries.join('');
      const patch = path.join(patchDir, `dsh-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 12)}.yml`);
      fs.writeFileSync(patch, body);
      args.push('--patch', patch);
    }
    args.push('--json');
    if (sessionId) args.push('--session-id', sessionId);
    args.push('-');

    let finalText = '';
    let error = null;
    let sid = sessionId ?? null;
    const usage = { input: 0, cached: 0, output: 0 };
    const calls = new Map();            // 工具调用号 → 它在做什么（被系统拦下时报给工作台）

    return runCli({
      cmd: '/bin/sh', args, cwd, stdinText: prompt, timeoutMs, logPath, sandboxProfile: sandbox?.profile ?? null,
      env: cleanEnv({ PATH: `${pathPrefix}:${process.env.PATH}`, ...extraEnv, DEEPSEEK_API_KEY: k?.key ?? '' }, { dropNames: othersSecrets('DeepSeek') }),
      onJson(ev) {
        switch (ev.type) {
          case 'session': sid = ev.sessionId ?? sid; on.session?.(ephemeral ? null : sid, { model }); break;
          case 'tool_call': {
            const i = ev.input ?? {};
            const text = i.command ?? i.cmd ?? i.file_path ?? i.path ?? i.pattern ?? '';
            const isCmd = /bash|shell|exec|terminal|command/i.test(ev.tool ?? '');
            on.activity?.({ kind: isCmd ? 'cmd' : 'tool', text: isCmd ? clip(text, 240) : `${ev.tool} ${clip(text, 160)}` });
            if (ev.callId) calls.set(ev.callId, isCmd ? clip(text, 240) : `${ev.tool} ${clip(text, 160)}`);
            break;
          }
          case 'tool_result': {
            const err = typeof ev.error === 'string' ? ev.error : ev.error ? JSON.stringify(ev.error) : '';
            const hit = deniedLine(`${ev.result ?? ''}\n${err}`);
            if (hit) on.denied?.(hit, calls.get(ev.callId));
            break;
          }
          // DeepSeek Harness 的无界面模式一段话写完才整段给出（不逐字），界面就按整段刷新
          case 'text': if (ev.text?.trim()) on.activity?.({ kind: 'say', text: ev.text.trim() }); break;
          case 'status':
            if (ev.phase === 'step_end' && ev.usage) {
              usage.input += ev.usage.inputTokens ?? 0;
              usage.cached += ev.usage.cacheReadTokens ?? 0;
              usage.output += ev.usage.outputTokens ?? 0;
            }
            if (ev.phase === 'turn_end' && ev.reason?.kind === 'error') error = ev.reason.error?.message ?? '运行出错';
            break;
          case 'final': finalText = ev.text ?? ''; break;
        }
      },
      onExit({ code, stopReason, stderr }) {
        let status = 'ok';
        if (stopReason) status = stopReason;
        else if (error || code !== 0) status = 'error';
        const errText = error ?? (status === 'error' ? clip(stderr, 600) : null);
        if (status === 'error' && QUOTA_RE.test(`${errText}`)) status = 'quota';
        const cost = deepseekCost(model ?? 'deepseek-flash', usage);
        on.done?.({ status, finalText: status === 'ok' ? finalText : '', usage: { input: usage.input + usage.cached, cached: usage.cached, output: usage.output, cost: cost.cny, currency: 'CNY', peak: cost.peak }, error: errText, sessionId: ephemeral ? null : sid, model: model ?? 'deepseek-flash' });
      },
    });
  },

  // 官方模型清单（不收费）：有哪些模型、各支持哪些推理强度
  async models() {
    const k = readDshKey();
    if (!k) return null;
    const r = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${k.key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`模型清单接口返回 ${r.status}`);
    return (await r.json()).data ?? [];
  },

  // 官方余额接口
  async balance() {
    const k = readDshKey();
    if (!k) return null;
    const r = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${k.key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`余额接口返回 ${r.status}`);
    const j = await r.json();
    return { available: j.is_available, balances: (j.balance_infos ?? []).map((b) => ({ currency: b.currency, total: b.total_balance, granted: b.granted_balance, toppedUp: b.topped_up_balance })) };
  },
};
