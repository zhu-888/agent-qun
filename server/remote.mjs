// 手机访问：总开关、一次性配对码、已配对的设备、Tailscale 地址。
// 工作台平时只听 127.0.0.1。打开“手机访问”后，另外只在这台 Mac 的 Tailscale 地址上再听一份——
// 这个地址只有登录了同一个 Tailscale 账号的设备连得到，公网和同一个 Wi-Fi 上的其他设备都连不到。
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const CODE_TTL = 5 * 60 * 1000;      // 配对码 5 分钟内有效
const CODE_TRIES = 5;                // 一个配对码最多输错 5 次
const LOCK_FAILS = 10;               // 10 分钟内累计输错 10 次，锁 10 分钟
const LOCK_MS = 10 * 60 * 1000;
const MAX_DEVICES = 5;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sameText = (a, b) => { const x = Buffer.from(sha(a)), y = Buffer.from(sha(b)); return crypto.timingSafeEqual(x, y); };

// Tailscale 给每台设备分一个 100.64.0.0/10 里的地址
export function tailscaleIp() {
  if (process.env.WG_TEST_REMOTE_IP) return process.env.WG_TEST_REMOTE_IP;      // 只给自动测试用：没装 Tailscale 也能把手机那条路走一遍
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 100 && y >= 64 && y <= 127) return a.address;
    }
  }
  return null;
}

export class RemoteError extends Error {}

export class Remote {
  constructor({ file }) {
    this.file = file;
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 第一次用 */ }
    this.enabled = !!saved.enabled;
    this.devices = Array.isArray(saved.devices) ? saved.devices : [];
    this.code = null;                // { value, expires, tries }
    this.fails = [];                 // 最近输错配对码的时刻
    this.lockedUntil = 0;
    this.seenSaved = 0;
  }

  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ enabled: this.enabled, devices: this.devices }, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }

  setEnabled(on) { this.enabled = !!on; if (!this.enabled) this.code = null; this.save(); }

  newCode() {
    if (!this.enabled) throw new RemoteError('先打开“允许手机访问”');
    if (this.devices.length >= MAX_DEVICES) throw new RemoteError(`最多配对 ${MAX_DEVICES} 台设备，先移除一台`);
    this.code = { value: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), expires: Date.now() + CODE_TTL, tries: 0 };
    return this.code;
  }

  // 手机输入配对码。成功后返回放进 cookie 的那串；配对码只能用一次
  pair(input, name) {
    const t = Date.now();
    if (!this.enabled) throw new RemoteError('手机访问没有打开');
    if (t < this.lockedUntil) throw new RemoteError('输错次数太多，请十分钟后再试');
    if (!this.code || t > this.code.expires) { this.code = null; throw new RemoteError('配对码已经失效，请在电脑上重新生成'); }
    if (!sameText(String(input ?? '').replace(/\D/g, ''), this.code.value)) {
      this.fails = this.fails.filter((x) => t - x < LOCK_MS); this.fails.push(t);
      if (this.fails.length >= LOCK_FAILS) { this.lockedUntil = t + LOCK_MS; this.fails = []; this.code = null; }
      else if (++this.code.tries >= CODE_TRIES) this.code = null;
      throw new RemoteError(this.code ? '配对码不对' : '输错次数太多，这个配对码作废了，请在电脑上重新生成');
    }
    this.code = null;
    const id = crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    const clean = String(name ?? '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 40) || '手机';
    this.devices.push({ id, name: clean, hash: sha(secret), createdAt: t, lastSeen: t });
    this.save();
    return `${id}.${secret}`;
  }

  // 从请求的 cookie 里认出是哪台已配对的设备；认不出就是 null
  auth(cookieHeader) {
    if (!this.enabled) return null;
    const m = /(?:^|;\s*)wg_dev=([^;]+)/.exec(String(cookieHeader ?? ''));
    if (!m) return null;
    const [id, secret] = m[1].split('.');
    const d = this.devices.find((x) => x.id === id);
    if (!d || !secret || !sameText(sha(secret), d.hash)) return null;
    d.lastSeen = Date.now();
    if (d.lastSeen - this.seenSaved > 60000) { this.seenSaved = d.lastSeen; try { this.save(); } catch { /* 记不下“最近使用”不要紧 */ } }
    return d;
  }

  revoke(id) {
    const n = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length !== n) this.save();
  }

  view(port, listening) {
    const ip = tailscaleIp();
    const code = this.code && Date.now() < this.code.expires ? { value: this.code.value, expires: this.code.expires } : null;
    return {
      enabled: this.enabled, ip, listening, url: ip ? `http://${ip}:${port}` : null, code,
      devices: this.devices.map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen })),
    };
  }
}

// 手机上能做的事：看、发消息、建任务卡、传文件、验收和打回、让成员停下或暂停。
// 改设置、换模型、建/删/搬项目、在 Mac 上打开文件、管理手机访问本身，都只能在电脑上做。
export function phoneAllowed(method, parts) {
  if (parts[0] !== 'api') return method === 'GET';
  const [, a, , what, , act] = parts;
  if (method === 'GET') {
    if (a === 'events') return true;
    if (a === 'app') return parts.length === 2;
    return a === 'p' && ['state', 'file', 'run'].includes(what);
  }
  if (method !== 'POST') return false;
  if (a === 'app') return parts[2] === 'refresh';
  if (a !== 'p') return false;
  if (['say', 'upload', 'chat', 'chats', 'summary', 'hold', 'settings'].includes(what)) return true;   // settings：只放行“暂停/恢复项目”，在 main 里再筛一遍
  if (what === 'task') return ['approve', 'reject', 'reassign', 'cancel'].includes(act);
  if (what === 'agent') return ['stop', 'pause', 'resume'].includes(act);
  if (what === 'run') return act === 'stop';
  if (what === 'wake') return act === 'retry';
  if (what === 'msg') return act === 'forward';
  return false;
}
