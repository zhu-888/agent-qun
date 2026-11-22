#!/bin/zsh
# 双击这个文件就能启动工作台，并在浏览器里打开。关掉这个终端窗口就是退出。
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-7788}"

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 24 或更新的版本（https://nodejs.org），再双击这个文件。"
  read -r "?按回车关闭"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "当前 Node.js 版本是 $(node -v)，工作台需要 24 或更新的版本。"
  read -r "?按回车关闭"
  exit 1
fi

if curl -s -m 2 "http://127.0.0.1:$PORT/api/app" >/dev/null 2>&1; then
  echo "工作台已经在运行，直接打开浏览器。"
  open "http://127.0.0.1:$PORT/"
  exit 0
fi

( sleep 1.5; open "http://127.0.0.1:$PORT/" ) &
echo "正在启动工作台（http://127.0.0.1:$PORT）。关闭这个窗口或按 Ctrl+C 退出。"
exec node --no-warnings server/main.mjs
