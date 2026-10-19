# office.laisengou.com

生产应用目录 `/opt/office.laisengou.com/current`，持久化工作区 `/opt/office.laisengou.com/data`；两者分离，升级只替换 current 软链接，不能删除 data。

- `office-lab.service`：独立低权限用户运行 Node，监听 `127.0.0.1:4173`，开机启动、异常重启。
- `office-model.service`：独立 Ollama CPU 模型，监听 `127.0.0.1:11434`，不开放公网，不需要代理和云端 API Key。
- Nginx：仅新增 `zz-office.laisengou.com.conf`，转发 HTTPS 与 SSE，关闭代理缓冲。其他站点配置保持原文件。
- Python：`/opt/office.laisengou.com/runtime/python/bin/python3`，不会替换系统解释器。
- TLS：单独 Certbot 配置目录与自动续期任务 `/etc/cron.d/office-laisengou`。

## 服务端配置

`/opt/office.laisengou.com/office.env` 为 root 所有，权限 0600。配置 `HOST=127.0.0.1`、`PORT=4173`、`OFFICE_PUBLIC_ORIGIN=https://office.laisengou.com`、`OFFICE_DATA_DIR`、`OFFICE_PYTHON`，以及模型和登录变量。

公网登录需要 `OFFICE_ACCESS_USERNAME`、`OFFICE_ACCESS_PASSWORD_HASH` 和至少 32 字节随机 `OFFICE_SESSION_SECRET`。散列用 `server/access.mjs` 的 `hashAccessPassword()` 生成；不要提交密码、散列、会话密钥和模型密钥。会话 Cookie 限 HTTPS、HttpOnly、SameSite=Strict，有效 12 小时。更换会话密钥会使已有会话失效。

本地模型配置：

```ini
OFFICE_PROVIDER=ollama
OFFICE_MODEL=qwen3:4b-instruct-2507-q4_K_M
OFFICE_OLLAMA_URL=http://127.0.0.1:11434
OFFICE_MODEL_TIMEOUT_MS=600000
OFFICE_PROBE_TIMEOUT_MS=120000
OFFICE_MODEL_RETRIES=0
OFFICE_OLLAMA_CONTEXT=16384
OFFICE_OLLAMA_THREADS=6
```

模型和 Python 均来自官方发布资产，下载后校验 SHA-256；来源记录在各自安装目录。服务器没有安装代理，也没有复制个人 Codex 登录凭据。

当前服务器使用 CPU 推理，一项多岗位任务包含多次模型决策、工具执行和交接，可能持续数分钟。自动派工不会叠加正在执行的任务。工具的执行回执与模型的文字总结分别展示，实际未通过的测试和审校项始终保留。

模型服务通过 `LLAMA_ARG_CACHE_RAM=512` 将历史提示缓存限定在 512 MiB，保留 `MemoryMax=10G`。默认 8 GiB 的历史缓存叠加模型与长上下文会触发服务内存上限；安装脚本已包含此配置。参数依据 [llama.cpp 官方运行文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)，并已用所安装二进制的 `--help` 核对。

## 发布

先完成 `npm test`、`npm run check`，打包 dist、server、scripts、tools、data、config、deploy、package*.json 与已安装的 undici 依赖。排除 `.office-data`、`.env`、`.git`、个人资料、录屏和运行产物。

解压到新的 `releases/<版本>`，文件为 root 所有、应用只读。原子替换 current 软链接，再重启 `office-lab`；Nginx 修改前必须 `nginx -t`。模型无需随前端升级重启。回滚时切回上一个 release 并重启应用。

更新前先查询当前运行任务，等待任务与真人审批完成或由使用者取消；服务重启会明确标记中断任务，不假装自动续跑。

## 自动派工

登录后：底部“更多操作” → “自动派工”。默认随机间隔 3–5 分钟；任务存在或等待真人审批时暂停新派发。执行在后台，不需要浏览器保持打开。服务重启后重新计算间隔，不补跑错过的次数。

公司依据保存在 `data/company/profile.json`，来源与核实时间可查。默认任务是内部数据库原型、交付计划草案和公开服务器报价研究；配置、预算及人日成本均为任务假设。不能将草案写为既有公司事实。

真实财务、入职、投资、网络任务需要相应资料才进入自动范围。资料存于私有 data/automation.json 的 taskInputs，可通过已认证接口配置；状态接口不返回原文。任何审批仍由真实员工执行。

## 检查

```sh
systemctl status office-lab office-model
journalctl -u office-lab --since '10 minutes ago'
nginx -t
```

登录后可请求 `/api/health`、`/api/automation` 和 `/api/runs`。连接检查为 `/api/provider/check`。启动会做一次真实模型探测；自动派工开启且模型连接失败时采用 5–30 分钟退避恢复探测。正常状态查询不调用模型。
