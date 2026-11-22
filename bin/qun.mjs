#!/usr/bin/env node
// 成员用的群命令。它只做一件事：把参数写成一个请求文件交给工作台，等结果打印出来。
// 用法由工作台生成的包装脚本带上 --project 和 --agent，成员只需要写：qun task accept T2
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const take = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const project = take('--project');
const agent = take('--agent');
if (!project || !agent) {
  console.error('qun 要通过工作台生成的包装脚本运行');
  process.exit(2);
}

let stdin = '';
if (argv.includes('-') && !process.stdin.isTTY) {
  try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* 没有输入 */ }
}

// 每次运行一个请求目录：QUN_RUN 是工作台启动这个会话时放进环境变量的运行号。工作台按目录认是谁在说话
const run = process.env.QUN_RUN ?? '';
if (!/^R[0-9A-Za-z]{2,30}$/.test(run)) {
  console.error('qun 只能在工作台启动的成员会话里用（没有找到这次运行的编号 QUN_RUN）');
  process.exit(2);
}
const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const reqDir = path.join(project, '.workgroup', 'rpc', 'req', run);
const resFile = path.join(project, '.workgroup', 'rpc', 'res', run, `${id}.json`);
try {
  fs.writeFileSync(path.join(reqDir, `${id}.tmp`), JSON.stringify({ agent, argv, stdin, run, cwd: process.cwd(), ts: Date.now() }));
  fs.renameSync(path.join(reqDir, `${id}.tmp`), path.join(reqDir, `${id}.json`));
} catch (e) {
  console.error(`qun 写不了请求文件：${e.message}`);
  process.exit(2);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  if (fs.existsSync(resFile)) {
    let res;
    try { res = JSON.parse(fs.readFileSync(resFile, 'utf8')); } catch { sleep(50); continue; }
    (res.ok ? console.log : console.error)(res.text);
    process.exit(res.ok ? 0 : 1);
  }
  sleep(80);
}
console.error('工作台 30 秒内没有回应（可能没在运行）。请稍后再试，或在回复里说明情况。');
process.exit(2);
