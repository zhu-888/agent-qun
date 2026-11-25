// 通用 ACP 接入：任何支持 Agent Client Protocol（agentclientprotocol.com，v1）的命令行都能当群成员。
// 比如 Kimi Code（kimi acp）、Qwen Code（qwen --acp）、Gemini CLI（gemini --acp）、OpenCode（opencode acp）、
// GitHub Copilot CLI（copilot --acp）。成员表（roster.mjs）里写 adapter: 'acp' 和 acp: { command, args }，就用这里。
//
// 协议：JSON-RPC 2.0，经 stdin / stdout 一行一条。每次运行：
//   initialize → session/resume（或 session/load）接着上次的会话；没有就 session/new
//   → （选了模型、推理强度时）session/set_config_option → session/prompt → 读 session/update 通知 → 拿到 stopReason 就收尾
//
// 写入边界：整个进程照样被工作台的 sandbox-exec 包起来（见 boundary.mjs）。所以这里绝不声明 fs / terminal 能力：
// 声明了，成员就会请工作台替它读写文件、跑命令，那些动作发生在工作台自己的进程里，沙箱管不到。
// 成员要用工具时会来问“批不批准”：工作台不弹窗（和其它成员一样一路跑到底），自动选“允许”；能写哪里由沙箱强制。
//
// 和专用接入比少了什么：不能运行中插话（协议 v1 只有取消，新消息排到这一步结束后）；额度条要逐家另做。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { runCli, cleanEnv, othersSecrets, clip, deniedLine } from './runner.mjs';

export const ACP_PROTOCOL_VERSION = 1;
const QUOTA_RE = /quota|rate.?limit|usage limit|insufficient balance|余额不足|额度|402|payment required/i;
const AUTH_RE = /auth(entication|orization)? required|not logged in|unauthori[sz]ed|login required|401/i;
const HANDSHAKE_MS = 60000;           // 第一次启动可能要初始化（比如 npx 下载），给宽一点

const expandHome = (p) => String(p).replace(/^~(?=\/|$)/, os.homedir());

// 在 PATH 和几个常见安装位置里找命令；找到就返回绝对路径
export function findCommand(command, extraDirs = []) {
  if (!command) return null;
  if (command.includes('/')) { const p = expandHome(command); return fs.existsSync(p) ? p : null; }
  const dirs = [...extraDirs.map(expandHome), ...String(process.env.PATH ?? '').split(':'), '/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.npm-global/bin')];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, command);
    try { if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return p; } } catch { /* 这里没有 */ }
  }
  return null;
}

// 有没有登录：看成员表里写的凭据文件。auth.files：这些目录里有文件、或这些文件存在，任一满足就算登录了；
// auth.configHas：[文件, 正则]，配置文件里写了 API key 也算。都没写就不检查（交给运行时报错）
export function loggedIn(auth) {
  if (!auth) return true;
  for (const f of auth.files ?? []) {
    const p = expandHome(f);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory() ? fs.readdirSync(p).some((x) => !x.startsWith('.')) : st.size > 0) return true;
    } catch { /* 没有 */ }
  }
  for (const [f, re] of auth.configHas ?? []) {
    try { if (new RegExp(re).test(fs.readFileSync(expandHome(f), 'utf8'))) return true; } catch { /* 没有 */ }
  }
  return false;
}

// 成员要用工具时选哪个选项：有“总是允许”选它，其次“允许这一次”；都没有就取消（不替它拒绝什么奇怪的东西）
export function pickPermission(options) {
  const list = Array.isArray(options) ? options : [];
  const pick = list.find((o) => o.kind === 'allow_always') ?? list.find((o) => o.kind === 'allow_once');
  return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
}

// 会话的配置项里，找某一类（model / thought_level）里叫这个值的选项
export function findConfigValue(configOptions, category, want) {
  if (!want) return null;
  for (const o of configOptions ?? []) {
    if (o?.category !== category && !(category === 'model' && /^model$/i.test(o?.id ?? ''))) continue;
    const flat = (o.options ?? []).flatMap((x) => (Array.isArray(x?.options) ? x.options : [x]));      // 选项可以分组
    const hit = flat.find((x) => x?.value === want || x?.name === want);
    if (hit) return { configId: o.id, value: hit.value, label: hit.name ?? hit.value };
  }
  return null;
}
const currentOf = (configOptions, category) => {
  const o = (configOptions ?? []).find((x) => x?.category === category);
  if (!o) return null;
  const flat = (o.options ?? []).flatMap((x) => (Array.isArray(x?.options) ? x.options : [x]));
  return flat.find((x) => x?.value === o.currentValue)?.name ?? o.currentValue ?? null;
};

// 一次工具调用在界面上怎么显示
function toolText(tc) {
  const i = tc.rawInput ?? {};
  const cmd = i.command ?? i.cmd ?? (Array.isArray(i.argv) ? i.argv.join(' ') : null);
  if (tc.kind === 'execute' || cmd) return { kind: 'cmd', text: clip(String(cmd ?? tc.title ?? ''), 240) };
  const where = (tc.locations ?? []).map((l) => l.path).filter(Boolean).join('、') || i.file_path || i.path || i.pattern || '';
  return { kind: 'tool', text: clip(`${tc.title ?? tc.kind ?? '工具'}${where && !String(tc.title ?? '').includes(where) ? ' ' + where : ''}`, 200) };
}
// 工具结果里的文字（用来认出被沙箱拦下的报错）
function contentText(content) {
  return (Array.isArray(content) ? content : []).map((c) => c?.content?.text ?? c?.text ?? '').join('\n');
}

// row：成员表里的那一行（name、acp: { command, args, auth, loginFix, ... }）
export function acpAdapter(row) {
  const cfg = row.acp ?? {};
  const name = row.name;
  return {
    name,
    canInject: false,           // ACP v1 只能取消，不能把新消息塞进正在进行的一轮
    bin: null,

    async detect() {
      const bin = findCommand(cfg.command, cfg.searchDirs ?? []);
      this.bin = bin;
      if (!bin) return { connected: false, detail: `没有找到 ${cfg.command} 命令`, fix: cfg.installFix ?? `安装 ${name} 的命令行后重启工作台` };
      const version = await new Promise((resolve) => execFile(bin, cfg.versionArgs ?? ['--version'], { timeout: 8000 }, (err, out) => resolve(err ? '' : String(out).trim().split('\n')[0])));
      if (!loggedIn(cfg.auth)) return { connected: false, detail: `${version || cfg.command} 已安装，但没有登录`, fix: cfg.loginFix ?? `在终端里登录 ${cfg.command}` };
      return { connected: true, detail: `${version || cfg.command} · ACP`, billing: cfg.billing ?? null };
    },

    start({ cwd, prompt, sessionId, model, effort, pathPrefix, logPath, timeoutMs, ephemeral = false, extraEnv = {}, sandbox = null, on }) {
      const bin = this.bin ?? findCommand(cfg.command, cfg.searchDirs ?? []);
      if (!bin) throw new Error(`没有找到 ${cfg.command} 命令`);
      if (ephemeral) sessionId = null;
      cwd = path.resolve(cwd);

      let nextId = 0;
      const waiters = new Map();
      let sid = null;
      let closed = false;
      let replaying = false;          // session/load 会把以前的对话重放一遍：那些不算这次说的
      let cur = '';                   // 正在说的这一段
      let curId = null;
      let lastSaid = '';              // 上一段说完的话（最后一段为空时拿它当回复）
      let segNo = 0;
      let finalText = '';
      let error = null;
      let status = null;
      let usage = null;
      let cost = null;
      let modelShown = model ?? null;
      let stopping = null;            // 群主或工作台叫停：停的原因（stopped / superseded …）
      const calls = new Map();        // 工具调用号 → 界面上显示的文字

      const send = (obj) => handle.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
      const call = (method, params) => new Promise((resolve) => { const id = ++nextId; waiters.set(id, resolve); send({ id, method, params }); });
      const finish = () => { if (closed) return; closed = true; clearTimeout(hsTimer); handle.finish(); };
      const failNow = (why) => { error = error ?? why; finish(); };
      const endSegment = () => {
        const t = cur.trim();
        if (t) { lastSaid = t; on.activity?.({ kind: 'say', text: t }); }
        cur = ''; curId = null;
      };

      const handle = runCli({
        cmd: bin, args: cfg.args ?? [], cwd, keepStdinOpen: true, timeoutMs, logPath, sandboxProfile: sandbox?.profile ?? null,
        logSkip: /"sessionUpdate":"(agent_message_chunk|agent_thought_chunk|usage_update|available_commands_update)"/,
        env: cleanEnv({ PATH: `${pathPrefix}:${process.env.PATH}`, ...(cfg.env ?? {}), ...extraEnv }, { dropNames: othersSecrets(name) }),
        onJson(msg) {
          // 我们发出的请求的回应
          if (msg.id != null && !msg.method) { const cb = waiters.get(msg.id); waiters.delete(msg.id); cb?.(msg); return; }
          // 成员反过来问我们
          if (msg.id != null && msg.method) {
            if (msg.method === 'session/request_permission') {
              send({ id: msg.id, result: pickPermission(msg.params?.options) });
              return;
            }
            // 没声明 fs / terminal / 其它能力，按协议它不该来问；万一问了就明确拒绝，免得它干等
            send({ id: msg.id, error: { code: -32601, message: `工作台不提供 ${msg.method}` } });
            return;
          }
          if (msg.method !== 'session/update' || replaying) return;
          const u = msg.params?.update ?? {};
          switch (u.sessionUpdate) {
            case 'agent_message_chunk': {
              const text = u.content?.type === 'text' ? u.content.text ?? '' : '';
              if (!text) break;
              if (u.messageId && curId && u.messageId !== curId) endSegment();      // 换了一段话
              if (!curId) { curId = u.messageId ?? `s${++segNo}`; }
              cur += text;
              on.stream?.(text, curId);
              break;
            }
            case 'agent_thought_chunk': on.activity?.({ kind: 'think', text: '' }); break;
            case 'tool_call': {
              endSegment();
              const t = toolText(u);
              if (u.toolCallId) calls.set(u.toolCallId, t.text);
              on.activity?.(t);
              break;
            }
            case 'tool_call_update': {
              if (u.status === 'failed' || u.status === 'completed') {
                const out = `${contentText(u.content)}\n${typeof u.rawOutput === 'string' ? u.rawOutput : u.rawOutput ? JSON.stringify(u.rawOutput) : ''}`;
                const hit = deniedLine(out);
                if (hit) on.denied?.(hit, calls.get(u.toolCallId));
              }
              break;
            }
            case 'usage_update':
              if (u.cost?.amount != null) cost = { amount: u.cost.amount, currency: u.cost.currency ?? null };
              break;
            case 'config_option_update': {
              const m = currentOf(u.configOptions, 'model');
              if (m) modelShown = m;
              break;
            }
          }
        },
        onExit({ code, stopReason, finished, stderr }) {
          closed = true;
          clearTimeout(hsTimer);
          endSegment();
          let st = 'ok';
          if (stopReason) st = stopReason;
          else if (stopping) st = stopping;
          else if (status) st = status;
          else if (error || !finished) st = 'error';
          const errText = error ?? (st === 'error' ? clip(stderr, 600) || `${cfg.command} 意外退出（${code}）` : null);
          if (st === 'error' && QUOTA_RE.test(`${errText}`) && !AUTH_RE.test(`${errText}`)) st = 'quota';
          on.done?.({ status: st, finalText: st === 'ok' ? finalText : '', usage, error: errText, sessionId: ephemeral ? null : sid, model: modelShown });
        },
      });

      const hsTimer = setTimeout(() => { if (!sid && !closed) failNow(`${cfg.command} ${HANDSHAKE_MS / 1000} 秒内没有完成握手`); }, HANDSHAKE_MS);

      (async () => {
        const init = await call('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // 不声明 fs / terminal：读写文件、跑命令都由成员自己在沙箱里做
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'agentqun', title: 'AgentQun', version: '0.1.0' },
        });
        if (closed) return;
        if (init.error) return failNow(`initialize 失败：${init.error.message}`);
        const caps = init.result?.agentCapabilities ?? {};
        const base = { cwd, mcpServers: [] };
        let configOptions = null;

        // 接着上次的会话：能 resume 就 resume（不重放），否则 load（会重放，忽略那些）；都不行或失败就开新的
        if (sessionId) {
          let r = null;
          if (caps.sessionCapabilities?.resume) r = await call('session/resume', { ...base, sessionId });
          else if (caps.loadSession) { replaying = true; r = await call('session/load', { ...base, sessionId }); replaying = false; }
          if (closed) return;
          if (r && !r.error) { sid = sessionId; configOptions = r.result?.configOptions ?? null; }
          else if (r?.error && AUTH_RE.test(r.error.message ?? '')) return failNow(`${name} 还没登录：${cfg.loginFix ?? r.error.message}`);
          else on.activity?.({ kind: 'boot', text: `上次的会话接不上了${r?.error ? `（${clip(r.error.message, 60)}）` : ''}，开一个新会话` });
        }
        if (!sid) {
          const r = await call('session/new', base);
          if (closed) return;
          if (r.error) return failNow(AUTH_RE.test(r.error.message ?? '') ? `${name} 还没登录：${cfg.loginFix ?? r.error.message}` : `新开会话失败：${r.error.message}`);
          sid = r.result?.sessionId;
          configOptions = r.result?.configOptions ?? null;
        }
        clearTimeout(hsTimer);
        // 群主选了模型、推理强度：成员自己的配置项里有这个值才设，没有就用它的默认（在运行记录里说一声）
        for (const [category, want] of [['model', model], ['thought_level', effort]]) {
          if (!want) continue;
          const hit = findConfigValue(configOptions, category, want);
          if (!hit) { if (configOptions) on.activity?.({ kind: 'boot', text: `${name} 没有「${want}」这个${category === 'model' ? '模型' : '推理强度'}，用它自己的默认` }); continue; }
          const r = await call('session/set_config_option', { sessionId: sid, configId: hit.configId, value: hit.value });
          if (closed) return;
          if (!r.error) { configOptions = r.result?.configOptions ?? configOptions; if (category === 'model') modelShown = hit.label; }
        }
        if (!model) modelShown = currentOf(configOptions, 'model') ?? modelShown;
        on.session?.(ephemeral ? null : sid, { model: modelShown });

        const res = await call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: prompt }] });
        if (closed) return;
        endSegment();
        if (res.error) return failNow(res.error.message ?? '这一轮出错了');
        const stop = res.result?.stopReason;
        const u = res.result?.usage;
        if (u) {
          usage = { input: u.inputTokens ?? 0, cached: u.cachedReadTokens ?? 0, output: u.outputTokens ?? 0, reasoning: u.thoughtTokens ?? 0 };
          if (cost) Object.assign(usage, { cost: cost.amount, currency: cost.currency });
        } else if (cost) usage = { input: 0, cached: 0, output: 0, cost: cost.amount, currency: cost.currency };
        finalText = lastSaid;
        if (stop === 'cancelled') status = stopping ?? 'stopped';
        else if (stop === 'refusal') error = `${name} 拒绝了这个请求`;
        else if (stop === 'max_tokens' || stop === 'max_turn_requests') finalText = (finalText ? finalText + '\n\n' : '') + `（${name} 达到了单轮${stop === 'max_tokens' ? '输出长度' : '步数'}上限，这一步没做完）`;
        finish();
      })().catch((e) => failNow(String(e?.message ?? e)));

      return {
        get pid() { return handle.pid; },
        // 停止：先按协议请它取消这一轮，给它 1.5 秒自己收尾（存好会话），还没退就结束进程
        stop: (reason = 'stopped') => {
          clearTimeout(hsTimer);
          if (!sid || closed || handle.done) return handle.stop(reason);
          stopping = reason;
          try { send({ method: 'session/cancel', params: { sessionId: sid } }); } catch { /* 进程可能已经退出 */ }
          setTimeout(() => handle.stop(reason), 1500).unref?.();
        },
        inject: () => false,
      };
    },
  };
}
