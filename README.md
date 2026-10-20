# 疯狂办公室工作区

工作区包含两个独立项目：

- `client`：办公室客户端，负责 2D／3D 场景、人物、动画、表单和交互。独立使用 npm 开发、检查、测试、构建和发布。
- `server`：Go API，负责登录与角色、业务台账、Agent 协作、真实工具、审批、自动派工和文件交付。独立使用 Go 开发、测试、构建和发布。

打开 `疯狂办公室.code-workspace` 可同时加载两个项目。两边通过同域 `/api` 协作，不互相导入源码或依赖对方的构建工具。

## 本地运行

服务端，在 `server`：

```sh
go run ./cmd/office
```

客户端，在另一个终端的 `client`：

```sh
npm ci
npm run dev
```

访问 `http://localhost:4173/`。客户端开发端口为 4173，Go API 为 `127.0.0.1:8080`。模型配置和数据只在 `server` 中维护，详见两个项目各自的 README。原有两个 `.command` 启动入口也分别放在各自项目中。

## 验证与发布

客户端运行 `npm run check && npm test && npm run build`，发布 `client/dist/`。服务端运行 `make check && make test && make release`，发布 Go 二进制和服务端示例配置。双方各自带有部署、回滚脚本和容器构建入口，分别见 [客户端发布](client/README.md) 与 [服务端部署](server/deploy/README.md)。

生产入口为 `https://office.laisengou.com/`。Nginx 提供客户端静态页面并反代 `/api`；Go API 只监听服务器回环地址。客户端更新不重启 Go，服务端更新不替换客户端；跨接口变更先完成双方兼容检查再切换。每次开发完成并通过测试后部署，发布前备份、完成活动任务，发布后验证并保留回滚点。

产品需求仍以 [PRD](server/docs/PRD.md) 为基线。架构、兼容边界及迁移验收见 [Go 迁移说明](server/docs/GO-MIGRATION.md)。
