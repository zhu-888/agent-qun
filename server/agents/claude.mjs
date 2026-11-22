// @Claude：真实的 Claude Code CLI，用 Claude 订阅登录。
// 用流式输入（--input-format stream-json）启动：一轮进行中还能把新消息写进去（运行中插话），
// CLI 会把读到的用户消息原样回显一次（--replay-user-messages），我们据此确认“它真的收到了”。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, cleanEnv, othersSecrets, clip, deniedLine } from './runner.mjs';

const pexec = promisify(execFile);
const QUOTA_RE = /hit your\s+[\w\- ]{1,30}?\s*limit|usage limit|out of extra usage/i;
// 成员用了工作台没放开的工具（没人回答权限询问，CLI 自己拒了）：工具结果里是这两种固定说法
const PERM_RE = /requested permissions to use (\S+?),? but you haven'?t granted it|^Permission to use (\S+) (?:has been|was) denied/im;
export function toolDenied(text) {
  const m = PERM_RE.exec(String(text ?? ''));
  return m ? `工具没放开：${m[1] ?? m[2]}` : null;
}
// 成员能用的工具：读写文件、跑命令，加上只读的上网查资料（搜索、打开网页）。能写哪里由沙箱另外圈定
export const CLAUDE_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch';

// 这些环境变量会让 CLI 以为自己嵌套在别的会话里，或者把请求改道到别的服务商 / 按量计费的 API。
// 成员必须用群主的订阅登录，所以启动前全部去掉。
export const CLAUDE_ENV_DROP = {
  dropPrefixes: ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'CLAUDECODE', 'CLAUDE_PREVIEW', 'CLAUDE_PID', 'CLAUDE_EFFORT'],
  dropNames: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'],
};
const DROP = CLAUDE_ENV_DROP;

// 找 claude 命令：先看 PATH，再看桌面 app 自带的那份（取最新版本）
export function findClaudeBin() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = path.join(dir, 'claude');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* 继续找 */ }
  }
  const root = path.join(os.homedir(), 'Library/Application Support/Claude/claude-code');
  const found = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.name === 'claude.app') {
        const bin = path.join(p, 'Contents/MacOS/claude');
        if (fs.existsSync(bin)) found.push(bin);
      } else walk(p, depth + 1);
    }
  };
  walk(root, 0);
  const ver = (p) => (/claude-code\/(\d+)\.(\d+)\.(\d+)/.exec(p) ?? []).slice(1).map(Number);
  found.sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0; });
  return found[0] ?? null;
}

const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

export const claude = {
  name: 'Claude',
  bin: null,
  canInject: true,

  async detect() {
    this.bin = findClaudeBin();
    if (!this.bin) return { connected: false, detail: '没有找到 claude 命令', fix: '安装 Claude Code 或 Claude 桌面 app 后重启工作台' };
    try {
      const v = (await pexec(this.bin, ['--version'], { timeout: 10000, env: cleanEnv({}, DROP) })).stdout.trim();
      const st = await pexec(this.bin, ['auth', 'status'], { timeout: 10000, env: cleanEnv({}, DROP) })
        .then((r) => r.stdout, (e) => String(e.stdout ?? ''));
      let info = {};
      try { info = JSON.parse(st); } catch { /* 旧版本输出不是 JSON */ }
      if (info.loggedIn) {
        const sub = info.subscriptionType ? ` · ${info.subscriptionType}` : '';
        const viaApi = info.authMethod && !/claude\.?ai|oauth|subscription/i.test(info.authMethod);
        return {
          connected: true, detail: `${v} · 已登录${sub}`, billing: viaApi ? `按量 API（${info.authMethod}）` : '订阅',
          warn: viaApi ? '当前登录方式不是 Claude 订阅，会按量计费' : null,
        };
      }
      return { connected: false, detail: `${v} 已安装，但命令行没有登录`, fix: `在终端运行："${this.bin}" auth login` };
    } catch (e) {
      return { connected: false, detail: `claude 命令无法运行：${clip(e.message, 120)}`, fix: '检查 Claude Code 安装' };
    }
  },

  // ephemeral：一次性的小活（比如写群摘要），不续接成员的会话、不存会话、不给工具
  start({ cwd, prompt, sessionId, model, effort, identity, pathPrefix, logPath, timeoutMs, ephemeral = false, extraEnv = {}, sandbox = null, mdExcludes = null, on }) {
    // --strict-mcp-config：不带群主 claude.ai 账号上的连接器（邮箱、网盘等），群成员只碰项目文件夹
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--strict-mcp-config'];
    if (ephemeral) args.push('--no-session-persistence', '--tools', '');
    // --include-partial-messages：边写边把字吐出来，界面上“正在做”那一行逐字显示
    else args.push('--permission-mode', 'acceptEdits', '--allowedTools', CLAUDE_TOOLS, '--include-partial-messages');
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (identity) args.push('--append-system-prompt', identity);
    if (sessionId && !ephemeral) args.push('--resume', sessionId);
    // 从任务卡的 git 工作区启动时：项目根上的 CLAUDE.md 和工作区里那份是同一份，跳过免得读两遍
    if (mdExcludes?.length) args.push('--settings', JSON.stringify({ claudeMdExcludes: mdExcludes }));

    let finalText = '';
    let error = null;
    let sid = sessionId ?? null;
    let actualModel = model;
    let quota = false;
    let closed = false;                 // 已经收尾，不再接受插话
    const pending = [];                 // 写进去了、还没被回显确认的插话：[{ key, text }]
    const usage = { input: 0, cached: 0, output: 0, notionalUsd: null, turns: 0 };
    const toolText = new Map();         // 工具调用号 → 它在做什么（被系统拦下时报给工作台）
    const blocks = new Map();           // 正在逐字吐的段落：序号 → 这一段的标识（同一段的字拼在一起）

    const handle = runCli({
      cmd: this.bin, args, cwd, stdinText: userLine(prompt), keepStdinOpen: true, timeoutMs, logPath, sandboxProfile: sandbox?.profile ?? null,
      logSkip: /^\{"type":"stream_event"/,      // 逐字的碎片不进日志，整段写完后的那条会进
      env: cleanEnv({ PATH: `${pathPrefix}:${process.env.PATH}`, ...extraEnv }, { ...DROP, dropNames: [...(DROP.dropNames ?? []), ...othersSecrets('Claude')] }),
      onJson(ev) {
        if (ev.type === 'system' && ev.subtype === 'init') {
          sid = ev.session_id ?? sid;
          actualModel = ev.model ?? actualModel;
          on.session?.(ephemeral ? null : sid, { model: actualModel, apiKeySource: ev.apiKeySource });
        } else if (ev.type === 'system' && ev.subtype === 'thinking_tokens' && !ephemeral) {
          on.activity?.({ kind: 'think', text: `已经想了约 ${ev.estimated_tokens} token` });
        } else if (ev.type === 'user' && ev.isReplay) {
          // CLI 回显了一条它读到的用户消息：如果是我们插进去的，就算“已送到”
          const ct = ev.message?.content;
          const text = typeof ct === 'string' ? ct : (ct ?? []).map((b) => b.text ?? '').join('');
          const i = pending.findIndex((x) => x.text === text);
          if (i >= 0) { const [hit] = pending.splice(i, 1); on.injected?.(hit.key); }
        } else if (ev.type === 'stream_event') {
          // 逐字输出：一段文字开始、吐字。只管说的话，思考过程和工具参数不显示
          // 思考：内容不给，只显示“正在想”（开着思考时，回复常常要等想完才整段出来）
          const e = ev.event ?? {};
          if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') on.activity?.({ kind: 'think', text: '' });
          if (e.type === 'message_start') blocks.clear();
          else if (e.type === 'content_block_start' && e.content_block?.type === 'text') blocks.set(e.index, `${ev.uuid ?? ''}:${e.index}`);
          else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && blocks.has(e.index)) on.stream?.(e.delta.text ?? '', blocks.get(e.index));
        } else if (ev.type === 'user') {
          // 工具的结果：有操作被系统拦下，或者用了没放开的工具，告诉工作台（运行结束时群里会说明被拦了什么）
          for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
            if (b?.type !== 'tool_result') continue;
            const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c?.text ?? '').join('\n');
            const hit = deniedLine(text) ?? (b.is_error ? toolDenied(text) : null);
            if (hit) on.denied?.(hit, toolText.get(b.tool_use_id));
          }
        } else if (ev.type === 'assistant') {
          if (ev.error === 'rate_limit') quota = true;
          for (const b of ev.message?.content ?? []) {
            if (b.type === 'text' && b.text?.trim()) {
              on.activity?.({ kind: 'say', text: b.text.trim() });
              if (QUOTA_RE.test(b.text) && ev.isApiErrorMessage) quota = true;
            } else if (b.type === 'tool_use') {
              const i = b.input ?? {};
              const text = b.name === 'Bash' ? clip(i.command, 240)
                : `${b.name} ${clip(i.file_path ?? i.pattern ?? i.path ?? i.url ?? i.query ?? '', 160)}`;
              on.activity?.({ kind: b.name === 'Bash' ? 'cmd' : 'tool', text });
              if (b.id) toolText.set(b.id, text);
            }
          }
        } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
          on.rateLimit?.(ev.rate_limit_info);
        } else if (ev.type === 'result') {
          const text = typeof ev.result === 'string' ? ev.result : '';
          sid = ev.session_id ?? sid;
          const u = ev.usage ?? {};
          usage.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          usage.cached += u.cache_read_input_tokens ?? 0;
          usage.output += u.output_tokens ?? 0;
          usage.turns += ev.num_turns ?? 0;
          if (typeof ev.total_cost_usd === 'number') usage.notionalUsd = ev.total_cost_usd;
          if (ev.is_error) {
            error = clip(text || ev.subtype || '运行出错', 600);
            if (QUOTA_RE.test(text)) quota = true;
          }
          if (pending.length && !ev.is_error) {
            // 还有插话没被读到：CLI 会接着开下一轮处理它。这一轮的回复先发到群里。
            if (text.trim()) on.reply?.(text);
          } else {
            finalText = ev.is_error ? '' : text;
            closed = true;
            handle.endInput();        // 关掉输入，CLI 自己退出
          }
        }
      },
      onExit({ code, stopReason, stderr }) {
        closed = true;
        let status = 'ok';
        if (stopReason) status = stopReason;
        else if (quota) status = 'quota';
        else if (error || code !== 0) status = 'error';
        const errText = error ?? (status === 'error' ? clip(stderr, 600) : null);
        if (status === 'error' && QUOTA_RE.test(`${errText}`)) status = 'quota';
        on.done?.({ status, finalText: status === 'ok' ? finalText : '', usage, error: errText, sessionId: ephemeral ? null : sid, model: actualModel });
      },
    });

    return {
      get pid() { return handle.pid; },
      stop: (reason) => handle.stop(reason),
      // 运行中插话：写进去就返回 true；之后 CLI 回显时会触发 on.injected(key)
      inject(text, key) {
        if (closed || handle.done) return false;
        pending.push({ key, text });
        handle.write(userLine(text));
        return true;
      },
    };
  },
};
