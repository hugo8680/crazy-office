# 疯狂办公室 · Client

办公室客户端。保留现有 2D／3D 场景、人物、动效、员工工作台和业务交互，通过同域 `/api` 调用 Go 服务。这里不保存员工身份库、业务台账、模型密钥或任务执行逻辑。

## 开发

需要 Node.js 20.19+ 或 22.12+。本机已使用 Node.js 20.20 完成构建和测试。

```sh
npm ci
npm run dev
```

打开 `http://localhost:4173/`。开发服务器默认将 `/api` 转发到 `http://127.0.0.1:8080`；启动 API 的方法见 `../server/README.md`。可用 `OFFICE_API_TARGET` 覆盖目标：

```sh
OFFICE_API_TARGET=http://127.0.0.1:8080 npm run dev
```

登录入口为 `/login`，员工邀请和密码设置入口为 `/join#token=...`。邀请令牌只放 URL fragment，客户端读取后立即清除，不进入访问日志。办公室页面仍以房间、员工和场景内工作台作为入口。

## 检查、测试与构建

```sh
npm run check
npm test
npm run build
```

`src/` 是源码，`tests/` 只负责客户端和交互测试，`dist/` 是发布目录。构建保留场景资源，输出 `asset-manifest.json` 记录文件摘要。`npm run preview` 在 4173 端口预览构建，并使用同样的 `/api` 代理。

## 独立部署

生产静态目录：`/opt/office.laisengou.com/client/current`。API 进程和数据由服务端独立管理，客户端发布不重启 Go，不改公司数据。

1. 本地运行检查、测试与构建，将 `dist/` 传到服务器临时目录。
2. 校验 `asset-manifest.json` 对应的文件摘要。
3. 服务器执行 `deploy/release.sh <已验证的dist目录> <版本号>`。脚本使用客户端发布锁，在暂存目录完成复制后原子切换 `current`，已有版本不覆盖。服务器需提供 `flock`、GNU coreutils 和 Nginx；不会调用 Node。
4. 验证匿名访问跳转登录、账号登录、2D／3D、工作台、邀请入口，以及长任务事件流。

首次由旧版一体化服务迁移时，按 `../server/deploy/README.md` 操作。Nginx 站点为 `deploy/office.nginx.conf`，公共 locations 文件放在 `/opt/office.laisengou.com/client/nginx.locations.conf`。先运行 `nginx -t`，再切换该域名配置；其他站点保持原样。

部署规则：

- `/login`、`/join` 和静态资源公开；办公室页面使用 Nginx `auth_request` 检查真实会话。
- `/api` 原样反代 `127.0.0.1:8080`，JSON 权限由 Go 校验，不能以静态页鉴权代替 API 鉴权。
- SSE 关闭代理缓冲与缓存，读取超时 300 秒。
- `.mjs` 使用 JavaScript MIME 类型；CSS、图片等沿用标准 MIME 配置。
- 静态目录只放 `dist/` 内容，不放工作区根目录、环境文件或运行数据。

回滚只切客户端版本：

```sh
./deploy/rollback.sh <已有客户端版本号>
```

回滚后检查与当前 API 的接口兼容性。涉及接口变更的发布须先通过双方契约测试。

## 容器

```sh
docker build -t crazy-office-client:4.0.0 .
```

运行镜像时提供 `OFFICE_API_UPSTREAM`，默认 `office-server:8080`。该名字须能在容器网络内解析。镜像仅含静态资源与 Nginx，监听 8080；对外生产访问仍通过 HTTPS。模型和登录密钥只交给服务端容器。

容器配置提供独立打包入口；正式切换前还需在目标容器网络中验证域名、HTTPS、会话和事件流。本次环境若没有 Docker daemon，不能将 Dockerfile 语法准备写成容器运行验收已完成。
