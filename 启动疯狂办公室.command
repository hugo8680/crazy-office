#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  print '请先安装 Node.js 20 或更新版本，然后重新打开本文件。'
  read -r '?按回车结束…'
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  print '请先安装 Python 3.9 或更新版本，然后重新打开本文件。'
  read -r '?按回车结束…'
  exit 1
fi
if [[ ! -d node_modules/undici ]]; then
  npm ci
fi
if [[ ! -f .office-data/provider.json ]]; then
  mkdir -p .office-data
  chmod 700 .office-data
  cp config/provider.example.json .office-data/provider.json
fi
if curl --noproxy '*' --fail --silent --max-time 2 http://127.0.0.1:4173/api/health >/dev/null 2>&1; then
  print '疯狂办公室已在运行。'
  open http://localhost:4173/
  exit 0
fi
print '启动后请保持这个终端窗口打开。同一局域网请使用下方打印的 .local 网址。'
print '首次运行请确保已在本机执行 codex login；模型连接在页面内检查。'
open http://localhost:4173/
npm start
