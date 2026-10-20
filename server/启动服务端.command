#!/bin/zsh
set -eu
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}"
command -v go >/dev/null || { print "请先安装 Go 1.26+。"; exit 1; }
print "服务端：http://127.0.0.1:8080/。客户端请在 client 中单独启动。"
if [[ -f .office-data/dashscope-private.env ]]; then
  export OFFICE_PROVIDER="${OFFICE_PROVIDER:-dashscope}"
  exec go run ./cmd/office --env-file .office-data/dashscope-private.env
fi
exec go run ./cmd/office
