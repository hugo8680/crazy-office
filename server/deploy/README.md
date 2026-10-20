# Go API 与独立客户端部署

本目录是 v4 Go 服务端的部署入口。客户端 Nginx 配置位于 `client/deploy/`。旧 Node 服务单元、站点模板与说明已归档至 `server/docs/legacy-deploy/`，用于核对历史版本和紧急回退。

## 目录与服务

- 客户端：`/opt/office.laisengou.com/client/releases/<版本>`，`client/current` 指向当前静态版本。
- 服务端：`/opt/office.laisengou.com/server/releases/<版本>`，`server/current` 指向当前 Go 版本。
- 数据：继续使用 `/opt/office.laisengou.com/data`，不放进任一发布包。
- 私有配置：继续使用 `/opt/office.laisengou.com/office.env`，root 所有，0600。
- 新服务：`office-api.service`，office-lab 低权限用户，监听 `127.0.0.1:8080`。
- 域名：`https://office.laisengou.com`；静态页面由 Nginx 提供，`/api/` 反代 Go。

新单元的 `ExecStart` 用 `/usr/bin/env` 覆盖旧配置中的 HOST、PORT、OFFICE_DATA_DIR。其余登录散列、会话密钥和模型配置继续读取原私有文件；不需要复制到客户端。模型继续直连现有服务，不新增代理。Go 运行进程不需要 Node、Python 或本地编译工具。

## 独立构建

客户端在 `client/` 运行：

```sh
npm ci
npm run check
npm test
npm run build
```

服务端在 `server/` 运行：

```sh
make check
make test
make build-linux GOOS=linux GOARCH=amd64
make release VERSION=20261020-server-v4
```

宿主机发布脚本面向 Linux，需要 `sh`、`flock`、GNU coreutils、`curl`、`systemctl`，客户端发布还需要 `nginx`。两个项目使用各自发布锁，互不共用构建工具。

Go 最低版本以 `go.mod` 为准。交叉构建使用 `CGO_ENABLED=0`，发布输出为 `build/release/office-api`、只读示例资料、配置示例和 SHA-256 清单。私有模型参数、业务数据、备份、历史运行记录和 `.office-data` 不进入发布包。`make release` 从新的暂存目录生成产物，再替换 `build/release`，重复打包不会残留已删除文件；`PACKAGE_DIR` 仅允许位于 `build/` 内。

## 首次迁移

按以下顺序执行，不能同时让旧 Node 和新 Go 对同一数据运行自动任务。

1. 保存当前服务状态、旧 Nginx 站点、旧 `current` 指向和自动派工配置；记录其他站点摘要。
2. 停止未来自动派工，确认活动任务和待审批业务已经完成，或由业务负责人明确处理。停用派工不代表已有任务结束。
3. 创建完整私有数据备份。SQLite 必须在线备份或停服务后完整复制，不能只复制正在使用的主库而遗漏 WAL。身份库、运行结果和自动派工配置一并保存，并在隔离目录试恢复。
4. 在隔离副本上运行 Go，检查原账号、项目、库存、审批历史、任务结果与旧数据兼容；不得以测试账号替换正式员工。
5. 上传客户端构建与 Go 发布包，验证摘要。在 `client/releases/` 放好静态版本，并安装 locations 文件。
6. 将 `office-api.service` 安装为 `/etc/systemd/system/office-api.service`；执行 `systemctl daemon-reload`。先不启动，保留旧 `office-lab.service`。
7. 停止旧 `office-lab`，再执行 `release.sh <已验证的Go发布目录> <版本号>`。脚本拒绝在旧服务仍运行时切换，启动 Go 后检查 `/api/livez`。
8. 以 `client/deploy/office.nginx.conf` 替换该域名的站点内容，运行 `nginx -t` 后 reload。reload 异步启动新工作进程，域名健康检查须有界重试并确认 `/api/livez` 返回 Go 版本，不能把旧工作进程的瞬时连接拒绝直接判定为新服务故障。不要覆盖其他虚拟主机。
9. 验证匿名页面跳转、原账号登录、员工会话、邀请链接、权限、报价来源、报告下载、SSE、2D／3D 和原业务记录。`/api/livez` 仅证明 API 进程可服务；模型和业务检查须登录后另验。
10. 确认两项目都通过验收后启用 `office-api` 开机启动，停用旧 `office-lab` 开机启动；按保存的配置恢复自动派工。复核其他站点摘要未变。

客户端发布脚本不改 Nginx 站点文件。首次迁移的站点安装由部署负责人完成，并在 reload 前运行语法检查。

## 后续独立发布与回滚

客户端只发布静态目录，见 `client/deploy/release.sh` 和 `rollback.sh`；不会重启 API。

服务端独立发布：先停未来任务、等待活动业务、核验备份，再运行 `release.sh`。脚本使用独立发布锁、暂存目录与原子软链接切换，拒绝重复版本号和目录穿越；记录前一 Go 版本，在新进程存活检查失败时恢复前一 Go 版本。首次 Go 发布若失败，会停止 Go，由负责人恢复旧站点和 `office-lab` 服务。

服务端回滚：

```sh
./deploy/rollback.sh <已有Go版本号>
```

回滚不把旧备份覆盖到在线数据。应用版本与库结构必须兼容；不兼容时停止写入，在隔离环境核对恢复方案后再处理。

旧版一体化紧急回退：停止 `office-api`，恢复旧 Nginx 站点，执行 `nginx -t`，启动 `office-lab` 并验证，再恢复原派工配置。旧路径 `/opt/office.laisengou.com/current` 和旧数据始终保留。不能同时运行两个调度器。

## 运维检查

```sh
systemctl status office-api --no-pager
journalctl -u office-api -n 80 --no-pager
curl --fail -H 'Host: office.laisengou.com' http://127.0.0.1:8080/api/livez
nginx -t
```

不要把 `office.env`、登录 Cookie、API Key 或备份文件内容打印到日志和工单。常规状态探测不调用真实模型；登录后的显式模型连接检查可能产生 API 费用。

## 容器入口

`server/Dockerfile` 与 `client/Dockerfile` 可各自构建镜像。服务端运行镜像没有 Node/Python；公司数据单独挂载到 `/var/lib/office`，容器用户 UID/GID 为 10001，目录需授予对应权限。生产仍需 HTTPS 与正确的 `OFFICE_PUBLIC_ORIGIN`，不能把 API 端口直接暴露公网。

容器网络、实际镜像启动及生产代理链需单独验收。systemd + 主机 Nginx 是当前服务器切换方案，不将未执行的 Docker 构建或启动写成已通过。
