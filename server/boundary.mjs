// 写入边界：两个会话不能同时改同一个文件。
//
// 规则分两层：
//   1. 归属：项目里每个可写的位置，同一时间只归一张没结束的任务卡（它的“写入范围”）。范围互不重叠，建卡和申请时就检查。
//   2. 强制：每个会话启动时，由操作系统把项目文件夹设成“只有本会话的范围可写，其它一律只读”。
//      · Claude、DeepSeek：用 macOS 自带的沙箱（sandbox-exec）把整个进程包起来。
//      · Codex：沙箱不能套沙箱，所以用它自带的沙箱——工作目录设成草稿目录，再把本会话的范围加进可写目录。
//   越界写入会直接报 “operation not permitted”，不靠成员自觉。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DIRS } from './project.mjs';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const REVIEW_DIR = `${DIRS.shared}/审查`;
export const MAIN_DRAFT = '日常';

// 把“写入范围”的一项规整成项目内的相对目录（统一以 / 结尾）。只能是 共享区/ 下面的目录。
export function normalizeScopeEntry(project, entry) {
  let rel = project.rel(String(entry ?? '').trim());
  if (!rel) throw new Error(`写入范围「${entry}」不在项目文件夹里`);
  rel = rel.replace(/\/+$/, '');
  const first = rel.split('/')[0];
  if (first !== DIRS.shared) throw new Error(`写入范围只能是「${DIRS.shared}/」下面的目录（「${DIRS.inbox}」对所有成员只读，「${DIRS.members}」下的草稿目录自动分配，不用申请）`);
  if (rel === DIRS.shared) throw new Error(`不能把整个「${DIRS.shared}/」划给一张任务卡，请写到它下面的某个目录`);
  if (rel === REVIEW_DIR || rel.startsWith(REVIEW_DIR + '/')) throw new Error(`「${REVIEW_DIR}/」是留给审查人放审查记录的，自动分配，不能申请`);
  if (/\.[A-Za-z0-9]{1,8}$/.test(path.basename(rel)) && !fs.existsSync(path.join(project.dir, rel))) {
    // 看起来像文件名：范围要写目录，文件放在目录里
    throw new Error(`写入范围要写目录，不是单个文件。比如把「${rel}」改成「${path.dirname(rel)}/」（不能是整个 ${DIRS.shared}/）`);
  }
  const link = symlinkIn(project.dir, rel);
  if (link) throw new Error(`写入范围里不能有符号链接：「${link}」是个链接（链接可以指向项目里任何地方，借它就能写到范围外面）`);
  const abs = path.join(project.dir, rel);
  if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) throw new Error(`写入范围要写目录，「${rel}」是个文件`);
  return rel + '/';
}

// 从项目根往下逐级看，路径里有没有符号链接；有就返回第一个链接的相对路径
export function symlinkIn(root, rel) {
  let cur = root;
  for (const part of String(rel).split('/').filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; }      // 后面的还没建出来
    if (st.isSymbolicLink()) return path.relative(root, cur).split(path.sep).join('/');
  }
  return null;
}

// 两项范围是否重叠（相同，或者一个在另一个里面）
export function scopesOverlap(a, b) {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

// 沙箱能不能用：工作台自己如果已经在沙箱里（沙箱不能套沙箱），或者系统没有这个命令，就不能强制
let sandboxState = null;
export function sandboxStatus() {
  if (sandboxState) return sandboxState;
  try {
    execFileSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore', timeout: 5000 });
    sandboxState = { ok: true };
  } catch (e) {
    sandboxState = { ok: false, reason: fs.existsSync(SANDBOX_EXEC) ? '系统沙箱启动不了（工作台自己可能已经运行在沙箱里）' : '这台电脑上没有 sandbox-exec' };
  }
  return sandboxState;
}

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// 生成沙箱规则：默认都允许 → 项目文件夹禁止写 → 只放开这个会话的范围
// 每个放开的目录同时写上它的真实路径（比如 /var → /private/var 这种系统自带的链接）；
// 但如果它在项目里面、真实路径却跑到了别处，说明中间有成员建的符号链接，那就只认字面路径，不跟着链接放开
//   denyPorts：本机这些端口不许连（工作台自己的端口：成员不能绕过 qun 直接调工作台的接口，那些接口是给群主用的）
export function seatbeltProfile(projectDir, writableAbs, { denyPorts = [] } = {}) {
  const rootReal = real(projectDir);
  const roots = [...new Set([projectDir, rootReal])];
  const realOf = (p) => {
    const r = real(p), rel = path.relative(projectDir, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return r;
    return r === path.join(rootReal, rel) ? r : null;
  };
  const allow = [...new Set(writableAbs.flatMap((p) => [p, realOf(p)]).filter(Boolean))];
  return [
    '(version 1)',
    '; AgentQun：这个会话在项目文件夹里只能写下面放开的目录，其它位置只读；不能连工作台自己的端口',
    '(allow default)',
    `(deny file-write* ${roots.map((r) => `(subpath ${q(r)})`).join(' ')})`,
    allow.length ? `(allow file-write* ${allow.map((p) => `(subpath ${q(p)})`).join(' ')})` : '',
    ...denyPorts.filter((n) => Number.isInteger(n) && n > 0 && n < 65536).map((n) => `(deny network-outbound (remote tcp "localhost:${n}"))`),
    '',
  ].join('\n');
}

// 项目文件夹不能放在临时目录里：Codex 自带的沙箱总是允许写临时目录，放在那里边界就不成立了
export function inTempArea(dir) {
  // 文件夹可能还没建出来：先找到它已经存在的那一级上层目录，取真实路径，再把剩下的部分接回去
  let base = path.resolve(dir);
  const rest = [];
  while (!fs.existsSync(base) && path.dirname(base) !== base) { rest.unshift(path.basename(base)); base = path.dirname(base); }
  const d = path.join(real(base), ...rest) + path.sep;
  const temps = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/var/tmp', '/private/var/tmp'];
  return temps.flatMap((t) => [t, real(t)]).map((t) => t + path.sep).some((t) => d.startsWith(t));
}
