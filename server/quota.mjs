// 真实额度。每个来源都是成员自己的命令行或官方接口报回来的数，工作台不碰任何登录凭据（DeepSeek 余额除外，它用群主已同意使用的 API key）。
//   Claude   → 运行 `claude -p "/usage"`（不消耗额度），以及每次真实运行里 CLI 发出的 rate_limit_event
//   Codex    → `codex app-server` 的 account/rateLimits/read（做法参考 steipete/CodexBar，MIT）
//   DeepSeek → 官方余额接口 GET https://api.deepseek.com/user/balance
// 读不到就如实标“暂不可获取”，超过 15 分钟没更新标“缓存已过期”。
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs';
import { cleanEnv } from './agents/runner.mjs';

const pexec = promisify(execFile);
export const STALE_MS = 15 * 60 * 1000;

const windowLabel = (mins) => (mins === 300 ? '5 小时' : mins === 10080 ? '每周' : mins ? `${Math.round(mins / 60)} 小时窗口` : '窗口');
const CLAUDE_LABELS = [
  [/^current session/i, '5 小时'],
  [/^current week \(all models\)/i, '每周（全部模型）'],
  [/^current week \((.+)\)/i, (m) => `每周（${m[1].replace(/ only$/i, '')}）`],
];
const CLAUDE_EVENT_LABELS = { five_hour: '5 小时', seven_day: '每周（全部模型）' };

export class Quota {
  constructor({ adapters, status, onChange, baselineFile = null }) {
    this.baselineFile = baselineFile;
    this.adapters = adapters;
    this.status = status;
    this.onChange = onChange;
    this.data = {};       // account → { windows, balance, source, fetchedTs, error, plan }
    this.busy = {};
  }

  view() {
    const st = this.status();
    const out = {};
    for (const name of Object.keys(this.adapters)) {
      const d = this.data[name];
      const base = { account: name, billing: st[name]?.billing ?? null };
      if (!st[name]?.connected) { out[name] = { ...base, state: '未连接', detail: st[name]?.detail ?? '' }; continue; }
      if (!d || (!d.windows?.length && !d.balance)) { out[name] = { ...base, state: '暂不可获取', detail: d?.error ?? '还没有读到数据', fetchedTs: d?.fetchedTs ?? null, source: d?.source ?? null }; continue; }
      out[name] = { ...base, state: 'ok', ...d, stale: Date.now() - d.fetchedTs > STALE_MS };
    }
    return out;
  }

  set(name, patch) {
    this.data[name] = { ...(this.data[name] ?? {}), ...patch };
    this.onChange?.();
  }

  async refresh(name) {
    if (this.busy[name]) return;
    if (!this.status()[name]?.connected) return;
    this.busy[name] = true;
    try {
      if (name === 'Codex') await this.refreshCodex();
      else if (name === 'Claude') await this.refreshClaude();
      else if (name === 'DeepSeek') await this.refreshDeepSeek();
    } catch (e) {
      this.set(name, { error: String(e.message ?? e).slice(0, 200), errorTs: Date.now() });
    } finally { this.busy[name] = false; }
  }
  refreshAll() { return Promise.all(Object.keys(this.adapters).map((n) => this.refresh(n))); }

  // ---- Codex ----------------------------------------------------------
  refreshCodex() {
    return new Promise((resolve, reject) => {
      const c = spawn('codex', ['-s', 'read-only', '-a', 'never', 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'], cwd: os.tmpdir() });
      const send = (o) => c.stdin.write(JSON.stringify(o) + '\n');
      let buf = '';
      let settled = false;
      const finish = (err) => { if (settled) return; settled = true; clearTimeout(timer); try { c.kill(); } catch { /* 已退出 */ } err ? reject(err) : resolve(); };
      const timer = setTimeout(() => finish(new Error('codex app-server 20 秒内没有回应')), 20000);
      c.on('error', (e) => finish(e));
      c.on('close', () => finish(new Error('codex app-server 提前退出')));
      c.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.id === 1) { send({ method: 'initialized', params: {} }); send({ id: 2, method: 'account/rateLimits/read', params: {} }); }
          else if (o.id === 2) {
            if (o.error) return finish(new Error(o.error.message ?? '读取失败'));
            const rl = o.result?.rateLimits ?? {};
            const windows = [];
            for (const w of [rl.primary, rl.secondary]) {
              if (!w || typeof w.usedPercent !== 'number') continue;
              windows.push({ label: windowLabel(w.windowDurationMins), usedPct: w.usedPercent, remainPct: Math.max(0, 100 - w.usedPercent), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null });
            }
            const credits = o.result?.rateLimitResetCredits?.availableCount;
            this.set('Codex', {
              windows, plan: rl.planType ?? null, source: 'Codex 命令行（codex app-server · account/rateLimits/read）', fetchedTs: Date.now(), error: null,
              note: typeof credits === 'number' && credits > 0 ? `账号里有 ${credits} 次免费重置额度的机会` : null,
              reached: !!rl.rateLimitReachedType,
            });
            finish();
          }
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'workgroup', title: 'AgentQun', version: '0.1.0' } } });
    });
  }

  // ---- Claude ---------------------------------------------------------
  async refreshClaude() {
    const bin = this.adapters.Claude.bin;
    if (!bin) throw new Error('没有找到 claude 命令');
    const env = cleanEnv({}, { dropPrefixes: ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'CLAUDECODE', 'CLAUDE_PREVIEW', 'CLAUDE_PID', 'CLAUDE_EFFORT'], dropNames: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'] });
    const { stdout } = await pexec(bin, ['--strict-mcp-config', '--settings', '{"disableAllHooks":true}', '-p', '/usage'], { timeout: 45000, env, cwd: os.tmpdir() });
    const windows = [];
    for (const line of stdout.split('\n')) {
      const m = /^\s*(Current [^:]+):\s*(\d{1,3})%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/i.exec(line);
      if (!m) continue;
      let label = m[1];
      for (const [re, to] of CLAUDE_LABELS) { const mm = re.exec(m[1]); if (mm) { label = typeof to === 'function' ? to(mm) : to; break; } }
      const used = Number(m[2]);
      windows.push({ label, usedPct: used, remainPct: Math.max(0, 100 - used), resetsAt: null, resetText: m[3] ?? null });
    }
    if (!windows.length) throw new Error('claude /usage 的输出里没有找到额度行');
    // 运行时事件里有精确的重置时间戳，能对上的就补进去
    for (const w of windows) { const ev = this.claudeEvents?.[w.label]; if (ev?.resetsAt) w.resetsAt = ev.resetsAt; }
    this.set('Claude', { windows, plan: /subscription/i.test(stdout) ? '订阅' : null, source: 'Claude 命令行（claude -p "/usage"）', fetchedTs: Date.now(), error: null });
  }

  // 真实运行里 CLI 发出的限额事件
  noteClaudeEvent(info) {
    this.claudeEvents ??= {};
    for (const [key, w] of Object.entries(info.unifiedWindows ?? {})) {
      const label = CLAUDE_EVENT_LABELS[key] ?? `每周（${key.replace(/^seven_day_/, '')}）`;
      this.claudeEvents[label] = { resetsAt: w.resetsAt ? w.resetsAt * 1000 : null, utilization: w.utilization, status: w.status };
      const cur = this.data.Claude?.windows?.find((x) => x.label === label);
      if (cur && w.resetsAt) cur.resetsAt = w.resetsAt * 1000;
    }
    if (info.status && info.status !== 'allowed') this.set('Claude', { reached: true });
  }

  // Codex 在真实运行里随时推送的限额更新（app-server 的 account/rateLimits/updated）
  noteCodexEvent(rl) {
    const windows = [];
    for (const w of [rl.primary, rl.secondary]) {
      if (!w || typeof w.usedPercent !== 'number') continue;
      windows.push({ label: windowLabel(w.windowDurationMins), usedPct: w.usedPercent, remainPct: Math.max(0, 100 - w.usedPercent), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null });
    }
    if (!windows.length) return;
    this.set('Codex', { windows, plan: rl.planType ?? this.data.Codex?.plan ?? null, source: 'Codex 命令行（运行中推送的限额更新）', fetchedTs: Date.now(), error: null, reached: !!rl.rateLimitReachedType });
  }

  // ---- DeepSeek -------------------------------------------------------
  async refreshDeepSeek() {
    const b = await this.adapters.DeepSeek.balance();
    if (!b) throw new Error('没有 API key');
    // 记下第一次读到的余额，之后显示“从那时起实际减少了多少”——这是真实扣费，比按 token 估算更准
    const cny = Number(b.balances.find((x) => x.currency === 'CNY')?.total);
    let since = null;
    if (Number.isFinite(cny) && this.baselineFile) {
      let base = null;
      try { base = JSON.parse(fs.readFileSync(this.baselineFile, 'utf8')); } catch { /* 还没有基准 */ }
      if (!base || !Number.isFinite(base.cny) || cny > base.cny) { base = { ts: Date.now(), cny }; fs.writeFileSync(this.baselineFile, JSON.stringify(base)); }
      since = { ts: base.ts, startCny: base.cny, spentCny: Math.round((base.cny - cny) * 100) / 100 };
    }
    this.set('DeepSeek', { balance: b, since, windows: [], source: 'DeepSeek 官方余额接口（/user/balance）', fetchedTs: Date.now(), error: null });
  }
}
