// 启动一个真实的 CLI 进程：降低优先级（nice）、带超时、可整组停止，按行读它输出的 JSON 事件。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { ROSTER } from '../roster.mjs';

export function runCli({ cmd, args, cwd, env, stdinText, keepStdinOpen = false, timeoutMs, logPath, logSkip = null, sandboxProfile = null, onJson, onText, onExit }) {
  const log = logPath ? fs.createWriteStream(logPath, { flags: 'a' }) : null;
  const writeLog = (kind, line) => log?.write(JSON.stringify({ t: Date.now(), kind, line }) + '\n');

  // nice -n 10：成员跑的命令不和群主抢 CPU
  // sandboxProfile：用 macOS 自带的沙箱把整个进程（连同它启动的所有命令）包起来，限制它能写哪里
  const launch = sandboxProfile ? ['/usr/bin/sandbox-exec', '-f', sandboxProfile, cmd, ...args] : [cmd, ...args];
  const child = spawn('/usr/bin/nice', ['-n', '10', ...launch], {
    cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  writeLog('spawn', (sandboxProfile ? '[沙箱] ' : '') + [cmd, ...args.map((a) => (a.length > 300 ? a.slice(0, 300) + '…' : a))].join(' '));

  let done = false;
  let stopReason = null;
  let finished = false;   // 活干完了、由我们主动收尾（不是被停止，也不是出错）
  let stderrTail = '';

  const lineReader = (stream, handler) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) handler(line);
      }
    });
    stream.on('end', () => { if (buf.trim()) handler(buf); });
  };

  lineReader(child.stdout, (line) => {
    // 逐字输出、启动状态这类刷屏的行不进日志；单行太长的只记开头
    if (!logSkip?.test(line)) writeLog('out', line.length > 60000 ? line.slice(0, 60000) : line);
    let obj = null;
    if (line[0] === '{') { try { obj = JSON.parse(line); } catch { /* 不是 JSON 就当普通文本 */ } }
    try { obj ? onJson?.(obj) : onText?.(line); } catch (e) { writeLog('handler_error', String(e?.stack ?? e)); }
  });
  lineReader(child.stderr, (line) => {
    writeLog('err', line);
    stderrTail = (stderrTail + '\n' + line).slice(-2000);
  });

  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* 已退出 */ } } };
  const stop = (reason = 'stopped') => {
    if (done) return;
    stopReason = stopReason ?? reason;
    killGroup('SIGTERM');
    setTimeout(() => { if (!done) killGroup('SIGKILL'); }, 5000).unref();
  };
  const timer = timeoutMs ? setTimeout(() => stop('timeout'), timeoutMs) : null;

  child.on('error', (err) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    writeLog('spawn_error', String(err));
    log?.end();
    onExit?.({ code: null, signal: null, stopReason: 'spawn_error', stderr: String(err) });
  });
  child.on('close', (code, signal) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    writeLog('exit', `code=${code} signal=${signal} stop=${stopReason ?? ''}${finished ? ' finished' : ''}`);
    log?.end();
    onExit?.({ code, signal, stopReason, finished, stderr: stderrTail.trim() });
  });

  child.stdin.on('error', () => { /* 进程先退出时写入会报错，忽略 */ });
  if (stdinText != null) child.stdin.write(stdinText);
  if (!keepStdinOpen) child.stdin.end();

  return {
    pid: child.pid,
    stop,
    write: (text) => { if (!done) child.stdin.write(text); },
    endInput: () => { try { child.stdin.end(); } catch { /* 已关闭 */ } },
    // 长驻模式的 CLI（比如 codex app-server）不会自己退出：活干完后由我们结束它
    finish: () => {
      if (done || stopReason) return;
      finished = true;
      try { child.stdin.end(); } catch { /* 已关闭 */ }
      killGroup('SIGTERM');
      setTimeout(() => { if (!done) killGroup('SIGKILL'); }, 4000).unref();
    },
    get done() { return done; },
  };
}

// 给成员的进程准备环境变量：去掉会让 CLI 误以为自己是“嵌套运行”的变量，
// 也去掉会把请求改道到别的服务商或按量计费 API 的变量（额度用尽不自动切到收费 API）。
// 各家的 key、令牌：只给用得着的那一家。成员跑的命令能读到自己进程的环境变量，别家的不该放进去
export const PROVIDER_SECRETS = Object.fromEntries(ROSTER.map((r) => [r.name, r.secrets]));     // 每位成员自己的密钥变量名，在成员表里
export const othersSecrets = (me) => Object.entries(PROVIDER_SECRETS).filter(([k]) => k !== me).flatMap(([, v]) => v);
export function cleanEnv(extra = {}, { dropPrefixes = [], dropNames = [] } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (dropNames.includes(k)) continue;
    if (dropPrefixes.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

// 写入被系统拦下（macOS 沙箱、Codex 自带沙箱）时命令和工具报的错。只认报错的固定格式，
// 不认正文里随便提到这几个词的地方（比如读到一份写着“报 operation not permitted”的说明文档）。
const DENY_LINE = /:\s*(operation not permitted|read-only file system)\s*(:|$)|\bEPERM: operation not permitted|\bEROFS: read-only file system|\[Errno (1|30)\] (Operation not permitted|Read-only file system)|writing outside of the project/i;
export function deniedLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    if (DENY_LINE.test(line)) return clip(line.trim().replace(/(?:\uFFFD|\\M-(?:\^[\s\S]|\\[\s\S]|[\s\S]))+/g, '…'), 200);
  }
  return null;
}

export const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
