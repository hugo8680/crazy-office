#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}"
command -v node >/dev/null || { print "请先安装 Node.js 20.19+。"; exit 1; }
[[ -d node_modules/vite ]] || npm ci
print "客户端：http://localhost:4173/。服务端请单独启动 server/启动服务端.command。"
open http://localhost:4173/
exec npm run dev
