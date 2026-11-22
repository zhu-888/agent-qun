// 成员图标：不随项目发布（是各家公司的商标）。工作台启动时从这台电脑上已经装好的应用里取，
// 用 macOS 自带的 sips 裁掉四周留白、缩成 96 像素，缓存在 data/icons/（不进 git）。
// 应用没装、或者取不出来，那位成员在界面上退回成字母头像，别的都不受影响。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// 一张图标可以有几个来源，按顺序找第一个存在的。只写 app 表示用应用 Info.plist 里登记的应用图标
const SOURCES = {
  claude: [{ app: 'Claude.app' }],
  'codex-light': [{ app: 'ChatGPT.app', file: 'Contents/Resources/icon-codex-light.png' }, { app: 'Codex.app' }],
  'codex-dark': [{ app: 'ChatGPT.app', file: 'Contents/Resources/icon-codex-dark-color.png' }, { app: 'Codex.app' }],
  deepseek: [{ app: 'DeepSeek Harness.app' }],
};
export const ICON_NAMES = Object.keys(SOURCES);

const APP_DIRS = ['/Applications', path.join(os.homedir(), 'Applications')];

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 15000 }, (err, out) => (err ? reject(err) : resolve(String(out)))));
}

async function appIcon(appPath) {
  const plist = path.join(appPath, 'Contents/Info.plist');
  if (!fs.existsSync(plist)) return null;
  let name = (await run('/usr/bin/defaults', ['read', plist, 'CFBundleIconFile']).catch(() => '')).trim();
  if (!name) return null;
  if (!path.extname(name)) name += '.icns';
  const file = path.join(appPath, 'Contents/Resources', name);
  return fs.existsSync(file) ? file : null;
}

async function findSource(name) {
  for (const src of SOURCES[name]) {
    for (const dir of APP_DIRS) {
      const appPath = path.join(dir, src.app);
      if (!fs.existsSync(appPath)) continue;
      const file = src.file ? path.join(appPath, src.file) : await appIcon(appPath);
      if (file && fs.existsSync(file)) return file;
    }
  }
  return null;
}

// 取一张：先转成 1024 的 png，按 macOS 应用图标的标准留白裁成 832，再缩到 96
async function extract(src, out, tmp) {
  const full = path.join(tmp, 'full.png'), crop = path.join(tmp, 'crop.png');
  await run('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '1024', src, '--out', full]);
  await run('/usr/bin/sips', ['-c', '832', '832', full, '--out', crop]);
  await run('/usr/bin/sips', ['-Z', '96', crop, '--out', out]);
}

// 启动时调用一次，不等它。已经取过、而且来源没更新的就跳过
export async function prepareIcons(dataDir) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sips')) return;
  const dir = path.join(dataDir, 'icons');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ICON_NAMES) {
    const out = path.join(dir, `${name}.png`);
    try {
      const src = await findSource(name);
      if (!src) { fs.rmSync(out, { force: true }); continue; }   // 应用卸载了，图标也跟着不显示
      if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) continue;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qun-icon-'));
      try { await extract(src, out, tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    } catch { /* 这一张取不出来就算了，界面退回字母头像 */ }
  }
}

export function iconFile(dataDir, file) {
  const m = /^([a-z-]+)\.png$/.exec(file ?? '');
  if (!m || !ICON_NAMES.includes(m[1])) return null;
  const p = path.join(dataDir, 'icons', file);
  return fs.existsSync(p) ? p : null;
}
