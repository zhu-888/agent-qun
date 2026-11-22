// @Codex：真实的 Codex CLI，用 ChatGPT 订阅登录。
//
// 默认走 `codex app-server`（JSON-RPC）：它支持把新消息送进正在进行的一轮（turn/steer，运行中插话）。
// app-server 起不来时退回 `codex exec --json`（不能插话，新消息排队到这一步结束）。
// 两种方式用的是同一套会话记录，可以互相续接。沙箱都限制成只能写项目文件夹。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCli, cleanEnv, othersSecrets, clip, deniedLine } from './runner.mjs';

const pexec = promisify(execFile);
const QUOTA_RE = /usage limit|usageLimitExceeded|rate limit reached|quota|you'?ve hit your/i;

// codex 把命令包在 /bin/zsh -lc "..." 里，界面上只显示里面那句
function cleanCmd(cmd) {
  const m = /^\S*(?:zsh|bash|sh)\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(String(cmd ?? ''));
  return clip(m ? m[2] : String(cmd ?? ''), 240);
}

// 写入边界：Codex 的沙箱只让命令写“工作目录 + 额外的可写目录”（还有系统临时目录）。
// 工作目录设成这个会话的草稿目录，本会话的写入范围作为额外可写目录传进去；项目里其它位置它就写不了。
// 联网：Codex 的沙箱默认不让命令联网。成员要能上网查资料（只读），所以干活的会话打开联网；能写哪里不变。
export function sandboxArgs(sandbox, ephemeral = false) {
  const net = ephemeral ? [] : ['-c', 'sandbox_workspace_write.network_access=true'];
  if (!sandbox?.writableAbs) return net;
  const home = sandbox.cwdAbs ?? sandbox.draftAbs;      // 工作目录本身总是可写，不用再列
  const roots = sandbox.writableAbs.filter((p) => p !== home);
  return ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`, ...net];
}

// ---- app-server 模式 ------------------------------------------------------
function startAppServer({ cwd, prompt, sessionId, model, effort, pathPrefix, logPath, timeoutMs, ephemeral = false, extraEnv = {}, sandbox = null, on }, onHandshakeFail) {
  const args = ['app-server', ...sandboxArgs(sandbox, ephemeral)];
  if (sandbox?.cwdAbs || sandbox?.draftAbs) cwd = sandbox.cwdAbs ?? sandbox.draftAbs;      // 草稿目录，或者这张卡的 git 工作区
  if (model) args.push('-c', `model="${model}"`);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);

  let nextId = 0;
  const waiters = new Map();          // 请求号 → 回调
  let threadId = null;
  let turnId = null;
  let turnActive = false;
  let closed = false;
  let handedOff = false;              // 已经退回 exec 模式，这个进程的结果不再上报
  let finalText = '';
  let error = null;
  let quota = false;
  const pending = [];                 // 已经写进去、还没确认被读到的插话：[{ key, text }]
  const queuedTurns = [];             // 这一轮刚结束才到的插话：接着开下一轮
  const usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
  let lastCommentary = '';            // 没有“最终回复”时，用最后一段说明顶上

  const send = (obj) => handle.write(JSON.stringify(obj) + '\n');
  const call = (method, params, cb) => { const id = ++nextId; waiters.set(id, cb ?? (() => {})); send({ id, method, params }); };
  const input = (text) => [{ type: 'text', text }];
  const fail = (why) => {
    if (threadId || handedOff) { error = error ?? why; finish(); return; }
    handedOff = true;                 // 握手阶段就失败：换 exec 模式重来
    handle.stop('handoff');
    onHandshakeFail(why);
  };
  const finish = () => { if (closed) return; closed = true; handle.finish(); };
  const startTurn = (text) => {
    turnActive = true;
    call('turn/start', { threadId, input: input(text) }, (res) => {
      if (res.error) { turnActive = false; return fail(`开始这一轮失败：${res.error.message}`); }
      turnId = res.result?.turn?.id ?? turnId;
    });
  };

  const handle = runCli({
    cmd: 'codex', args, cwd, keepStdinOpen: true, timeoutMs, logPath,
    logSkip: /"method":"(item\/[A-Za-z]+\/(delta|outputDelta|terminalInteraction)|mcpServer\/|turn\/moderationMetadata|thread\/readState|remoteControl\/)/,
    env: cleanEnv({ PATH: `${pathPrefix}:${process.env.PATH}`, ...extraEnv }, { dropNames: othersSecrets('Codex') }),
    onJson(msg) {
      // 我们发出的请求的回应
      if (msg.id != null && !msg.method) { const cb = waiters.get(msg.id); waiters.delete(msg.id); cb?.(msg); return; }
      // 服务端反过来问我们（比如要人批准）：沙箱已设成不询问，万一问了就拒绝，免得卡住
      if (msg.id != null && msg.method) { send({ id: msg.id, error: { code: -32000, message: '工作台不处理交互请求' } }); return; }
      const p = msg.params ?? {};
      switch (msg.method) {
        case 'item/started':
          if (p.item?.type === 'commandExecution') on.activity?.({ kind: 'cmd', text: cleanCmd(p.item.command) });
          else if (p.item?.type === 'reasoning') on.activity?.({ kind: 'think', text: '' });      // 在想（内容不显示）
          break;
        case 'item/agentMessage/delta':          // 逐字输出：同一段话的字按段落号拼在一起
          if (p.delta) on.stream?.(p.delta, p.itemId ?? '');
          break;
        case 'item/completed': {
          const it = p.item ?? {};
          if (it.type === 'agentMessage' && it.text?.trim()) {
            if (it.phase === 'final_answer') finalText = it.text;
            else lastCommentary = it.text;
            on.activity?.({ kind: 'say', text: it.text.trim() });
          } else if (it.type === 'userMessage') {
            // 服务端确认读到了一条用户消息：如果是我们插进去的，就算“已送到”
            const text = (it.content ?? []).map((c) => c.text ?? '').join('');
            const i = pending.findIndex((x) => x.text === text);
            if (i >= 0) { const [hit] = pending.splice(i, 1); on.injected?.(hit.key); }
          } else if (it.type === 'commandExecution') {
            const hit = deniedLine(it.aggregatedOutput);          // 命令写到了沙箱不让写的地方
            if (hit) on.denied?.(hit, cleanCmd(it.command));
          } else if (it.type === 'fileChange' && it.status === 'declined') {
            on.denied?.('改文件被拒绝', clip(`改文件 ${(it.changes ?? []).map((c) => c.path).join('、')}`, 200));
          }
          break;
        }
        case 'thread/tokenUsage/updated': {
          const u = p.tokenUsage?.last ?? {};           // last = 刚结束的这一次模型调用
          usage.input += u.inputTokens ?? 0; usage.cached += u.cachedInputTokens ?? 0;
          usage.output += u.outputTokens ?? 0; usage.reasoning += u.reasoningOutputTokens ?? 0;
          break;
        }
        case 'account/rateLimits/updated':
          if (p.rateLimits) on.rateLimit?.(p.rateLimits);
          break;
        case 'error':
          if (p.error?.codexErrorInfo === 'usageLimitExceeded' || QUOTA_RE.test(p.error?.message ?? '')) quota = true;
          if (!p.willRetry) error = p.error?.message ?? error;
          break;
        case 'turn/completed': {
          turnActive = false;
          const st = p.turn?.status;
          if (st === 'failed') error = p.turn?.error?.message ?? error ?? '这一轮失败了';
          const text = finalText || lastCommentary;
          if (queuedTurns.length && st === 'completed') {
            // 这一轮结束后才到的插话：先把这一轮的回复发到群里，再接着开下一轮
            if (text.trim()) on.reply?.(text);
            finalText = ''; lastCommentary = '';
            startTurn(queuedTurns.shift());
          } else {
            finalText = text;
            finish();
          }
          break;
        }
      }
    },
    onExit({ code, stopReason, finished, stderr }) {
      closed = true;
      if (handedOff) return;
      let status = 'ok';
      if (stopReason) status = stopReason;
      else if (quota) status = 'quota';
      else if (error || !finished) status = 'error';
      const errText = error ?? (status === 'error' ? clip(stderr, 600) || `app-server 意外退出（${code}）` : null);
      if (status === 'error' && QUOTA_RE.test(`${errText}`)) status = 'quota';
      on.done?.({ status, finalText: status === 'ok' ? finalText : '', usage, error: errText, sessionId: ephemeral ? null : threadId, model });
    },
  });

  // 握手：initialize → initialized → thread/start 或 thread/resume → turn/start
  const handshakeTimer = setTimeout(() => { if (!threadId && !closed) fail('app-server 25 秒内没有完成握手'); }, 25000);
  call('initialize', { clientInfo: { name: 'workgroup', title: 'AgentQun', version: '0.1.0' }, capabilities: { experimentalApi: true } }, (res) => {
    if (res.error) return fail(`initialize 失败：${res.error.message}`);
    send({ method: 'initialized', params: {} });
    const params = { cwd, approvalPolicy: 'never', sandbox: 'workspace-write' };
    const resume = sessionId && !ephemeral;
    call(resume ? 'thread/resume' : 'thread/start', resume ? { threadId: sessionId, excludeTurns: true, ...params } : { ...params, ...(ephemeral ? { ephemeral: true } : {}) }, (r) => {
      clearTimeout(handshakeTimer);
      if (r.error) return fail(`${resume ? '续接会话' : '新开会话'}失败：${r.error.message}`);
      threadId = r.result?.thread?.id ?? sessionId;
      on.session?.(ephemeral ? null : threadId, { model: r.result?.model ?? model });
      startTurn(prompt);
    });
  });

  return {
    get pid() { return handle.pid; },
    stop: (reason) => { clearTimeout(handshakeTimer); handle.stop(reason); },
    inject(text, key) {
      if (closed || handedOff || !threadId || handle.done) return false;
      pending.push({ key, text });
      if (!turnActive) { queuedTurns.push(text); return true; }
      call('turn/steer', { threadId, input: input(text), expectedTurnId: turnId }, (res) => {
        // 这一轮刚好结束、插不进去了：排到下一轮
        if (res.error && !closed) { if (turnActive) queuedTurns.push(text); else startTurn(text); }
      });
      return true;
    },
  };
}

// ---- exec 模式（退路） ------------------------------------------------------
function startExec({ cwd, prompt, sessionId, model, effort, pathPrefix, logPath, timeoutMs, ephemeral = false, extraEnv = {}, sandbox = null, on }) {
  const common = ['--json', '--skip-git-repo-check', ...sandboxArgs(sandbox, ephemeral)];
  if (sandbox?.cwdAbs || sandbox?.draftAbs) cwd = sandbox.cwdAbs ?? sandbox.draftAbs;      // 草稿目录，或者这张卡的 git 工作区
  if (model) common.push('-m', model);
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
  if (ephemeral) common.push('--ephemeral');
  // 只允许写项目文件夹；resume 不接受 -s/-C，所以用 -c 和 cwd 表达同样的限制
  const args = sessionId && !ephemeral
    ? ['exec', 'resume', ...common, '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', sessionId, '-']
    : ['exec', ...common, '-s', 'workspace-write', '-C', cwd, '-'];

  let finalText = '';
  let usage = null;
  let error = null;
  let sid = sessionId ?? null;

  const handle = runCli({
    cmd: 'codex', args, cwd, stdinText: prompt, timeoutMs, logPath,
    env: cleanEnv({ PATH: `${pathPrefix}:${process.env.PATH}`, ...extraEnv }, { dropNames: othersSecrets('Codex') }),
    onJson(ev) {
      switch (ev.type) {
        case 'thread.started': sid = ev.thread_id; on.session?.(ephemeral ? null : sid); break;
        case 'turn.started': on.session?.(ephemeral ? null : sid); break;
        case 'item.started':
          if (ev.item?.type === 'command_execution') on.activity?.({ kind: 'cmd', text: cleanCmd(ev.item.command) });
          break;
        case 'item.completed': {
          const it = ev.item ?? {};
          if (it.type === 'agent_message' && it.text) { finalText = it.text; on.activity?.({ kind: 'say', text: it.text.trim() }); }
          else if (it.type === 'error' && it.message) error = it.message;
          else if (it.type === 'command_execution') { const hit = deniedLine(it.aggregated_output); if (hit) on.denied?.(hit, cleanCmd(it.command)); }
          break;
        }
        case 'turn.completed':
          usage = {
            input: ev.usage?.input_tokens ?? 0, cached: ev.usage?.cached_input_tokens ?? 0,
            output: ev.usage?.output_tokens ?? 0, reasoning: ev.usage?.reasoning_output_tokens ?? 0,
          };
          break;
        case 'turn.failed': error = ev.error?.message ?? '运行失败'; break;
        case 'error':
          if (!/reconnecting|falling back/i.test(ev.message ?? '')) error = ev.message ?? '出错';
          break;
      }
    },
    onExit({ code, stopReason, stderr }) {
      let status = 'ok';
      if (stopReason) status = stopReason;
      else if (error || code !== 0) status = 'error';
      const errText = error ?? (status === 'error' ? clip(stderr, 600) : null);
      if (status === 'error' && QUOTA_RE.test(`${errText} ${stderr}`)) status = 'quota';
      on.done?.({ status, finalText, usage, error: errText, sessionId: ephemeral ? null : sid, model });
    },
  });
  return { get pid() { return handle.pid; }, stop: (r) => handle.stop(r), inject: () => false };
}

export const codex = {
  name: 'Codex',
  bin: 'codex',
  canInject: true,
  ownSandbox: true,       // 用自带沙箱划写入范围（工作目录是草稿目录）
  mode: 'app-server',     // 可在 data/settings.json 里用 codexMode: "exec" 改回去

  async detect() {
    try {
      const v = (await pexec('codex', ['--version'], { timeout: 8000 })).stdout.trim();
      const st = await pexec('codex', ['login', 'status'], { timeout: 8000 }).then((r) => r.stdout + r.stderr, (e) => String(e.stdout ?? '') + String(e.stderr ?? ''));
      const ok = /logged in/i.test(st) && !/not logged in/i.test(st);
      return ok
        ? { connected: true, detail: `${v} · ${st.trim().split('\n')[0]}`, billing: '订阅' }
        : { connected: false, detail: `${v} 已安装，但没有登录`, fix: '在终端运行：codex login' };
    } catch (e) {
      return { connected: false, detail: '没有找到 codex 命令', fix: '安装并登录 Codex CLI 后重启工作台' };
    }
  },

  start(opts) {
    if (this.mode === 'exec') return startExec(opts);
    const proxy = {
      cur: null,
      get pid() { return proxy.cur?.pid; },
      stop: (r) => proxy.cur?.stop(r),
      inject: (text, key) => proxy.cur?.inject(text, key) ?? false,
    };
    proxy.cur = startAppServer(opts, (why) => {
      opts.on.activity?.({ kind: 'boot', text: `app-server 没起来（${clip(why, 80)}），改用 exec 模式` });
      proxy.cur = startExec(opts);
      opts.on.pid?.(proxy.cur.pid);
    });
    return proxy;
  },
};
