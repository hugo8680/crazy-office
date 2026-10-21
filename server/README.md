# 疯狂办公室 · Server

原生 Go 服务端，运行不依赖 Node.js、npm 或 Python。客户端源码和构建产物由 `../client` 独立维护，本项目只提供 API、事件流和业务文件。

## 开发

需要 Go 1.26+。

```sh
go mod download
go run ./cmd/office
```

默认监听 `127.0.0.1:8080`。客户端开发服务器将 4173 端口的 `/api` 请求转发过来。开发环境没有公开来源及登录配置时使用本机管理员；公开部署必须配置原有账号散列、会话密钥和 HTTPS 来源。开发时不要加载生产登录密钥。

可通过 `HOST`、`PORT`、`OFFICE_DATA_DIR`、`OFFICE_ASSETS_DIR` 配置运行，或使用 `--listen`、`--data-dir`。入口在成功取得监听端口后才恢复任务，端口冲突的第二个进程不会改写在途记录。

## 真实模型

本轮指定接入 TokenDance 的 `qwen3.7-plus`，使用明确的 `tokendance` provider。实际协议、业务样本及生产结果须补入 [v4.1 验收清单](docs/ERP-UI-ACCEPTANCE-v4.1-20261020.md)，配置示例不代表已验收完成。模型选型与密钥只在服务端：

```ini
OFFICE_PROVIDER=tokendance
OFFICE_MODEL=qwen3.7-plus
OFFICE_TOKENDANCE_URL=https://tokendance.space/gateway/v1/chat/completions
TOKENDANCE_API_KEY=<仅填写到私有环境文件>
```

供应商使用 HTTPS 直连；本项目不要求为服务器新增代理。只向所选 provider 的受限端点发送相应密钥，不将凭据交给客户端。失败按真实失败记录，不回退为模拟结果。

私有环境文件可显式加载，权限须为 0600：

```sh
OFFICE_PROVIDER=tokendance go run ./cmd/office \
  --env-file .office-data/tokendance-private.env
```

既有 DashScope、OpenAI 兼容服务、Codex CLI 及 Ollama 能力保留为可显式选择的接入，不自动替代本轮指定模型。历史百炼配置使用 `OFFICE_PROVIDER=dashscope`、`DASHSCOPE_API_KEY` 及 `OFFICE_DASHSCOPE_URL`。环境变量优先；私有 `provider.json` 仅保存非秘密选择，不修改全局配置。

连接探测和实际处理可能产生供应商费用。普通状态查询只读缓存，不能把缓存 `ready` 或健康检查当作业务样本已通过。生产密钥、密码、身份库、任务原文和邀请凭证不得提交版本库。

## 目录

- `cmd/office`：API 启动、端口所有权、配置和优雅关闭。
- `cmd/verify-erp`：显式开启的真实模型隔离验收。
- `cmd/verify-lab`：原实验室七场景的真实模型隔离验收。
- `internal/httpapi`：现有 `/api` 契约及 HTTP 访问边界。
- `internal/identity`、`access`、`network`：员工、邀请、口令、会话及来源校验。
- `internal/erp`：原生 SQLite 事务、权限、审批、库存、借还、任务与事实报表。
- `internal/erpflow`：八类 ERP 工作、两个独立虚拟岗位、工具与复核门槛。
- `internal/model`、`agent`、`tools`：真实模型、保留的实验室场景、工具执行、历史调度兼容、事件与文件。
- `internal/report`：沿用现有文档样式的安全 HTML 与打印版。
- `data`、`config`：可发布的公开示例和公司背景；不放私有运行数据。
- `docs`：PRD、实施记录、迁移与验收。

## 数据兼容

生产继续使用 `/opt/office.laisengou.com/data`，本机默认为 `.office-data`。保留原 SQLite 表、JSON 字段、身份文件、scrypt 口令格式、会话签名、历史任务和业务文件。原有路径无需复制到客户端。

ERP 数据库在 `erp/office-erp.sqlite`，身份库在 `erp/identities.json`，ERP 模型记录在 `erp/runs/`；实验室历史任务仍以任务编号分目录保存，当前客户端不提供新建实验室任务的入口。本轮发布须保存并暂停旧实验室自动派工，不能在 ERP 页面之外继续生成不可见的新任务。后台运行与文件下载均检查授权。模型不能直接审批、写库存、改角色或运行任意宿主命令。

管理员 `POST /api/erp/backup` 保存业务库、身份库副本及摘要清单，文件在私有 `backups/`。恢复先到隔离目录验证，不覆盖运行中的生产库。正式升级前做完整备份，并在无活动任务时切换。

## 检查、测试和构建

```sh
make check
make test
make build
make build-linux
make release VERSION=<版本号>
```

`make test` 包含 Go race 检查，`make build` 生成 `bin/office-api`，`make release` 生成独立 Linux 二进制、配置、示例和 SHA-256 清单。使用纯 Go SQLite，`CGO_ENABLED=0`，生产不需要安装编译器或语言运行时。

真实模型验收明确启用，写入新的隔离数据目录，不使用实际公司审批：

```sh
OFFICE_REAL_ERP_ACCEPTANCE=1 go run ./cmd/verify-erp \
  --private-config=.office-data/tokendance-private.env
```

私有配置中的 provider 必须与实际调用一致；不得用旧百炼结果证明 TokenDance 已通过。测试替身仅用于确定性、异常和协议测试，不能当作真实模型验收。真实样本仍须逐份核对内容与来源，并把失败及限制保留在新证据目录。

原实验室验收命令仅供维护历史兼容时使用，不属于本轮 ERP 页面或自动派工流程，可选择场景、串行执行：

```sh
OFFICE_REAL_LAB_ACCEPTANCE=1 go run ./cmd/verify-lab \
  --private-config=.office-data/dashscope-private.env
```

两种验收都只在新建私有隔离目录中操作；审批由明确标记的脚本测试账号提供，不冒充正式公司人员审批。技术链路结果与内容复核分别保存，旧失败证据不覆盖。网页无价或拒绝访问时如实列待询价，不编造有效报价。

## 独立部署

服务二进制目录为 `/opt/office.laisengou.com/server/current`，服务名 `office-api`，API 端口 8080。私有环境文件和持久数据继续放在代码目录以外。

首次迁移步骤见 [部署与回滚](deploy/README.md)。后续服务端单独发布使用 `deploy/release.sh`、`deploy/rollback.sh`；客户端静态发布由 `../client/deploy` 管理。每次通过测试后更新服务器并检查登录、接口、模型、事件流和交付，保留可回滚版本。`GET /api/livez` 用于进程存活检查，带认证的 `/api/health` 读取模型缓存及工作状态；需要验证真实供应商连接时，使用有权限的显式检查并记录结果，不以存活或缓存状态代替业务验收。

本项目提供 Dockerfile 作为独立打包入口；实际生产使用原生 Go 二进制。容器运行验收与原生部署验收分别记录。

### 员工名册导入

员工实名及邮箱名册保存在服务器私有数据目录，不随客户端静态文件或公开代码发布。`GET /api/erp/organization` 仅向已登录员工返回实际账号的工位与部门关系；停用账号不出现在地图目录中。工位职级与业务权限分别保存，兼任岗位共用同一个登录账号。

`bin/import-roster` 读取审核后的 JSON 名册，格式见 `config/employee-roster.example.json`。默认只预览；提交前停止 API 服务，备份身份库，随后使用 `--apply --offline`。初始密码由 `--initial-password-file` 指定的 0600 文件或 `OFFICE_ROSTER_INITIAL_PASSWORD` 环境变量提供，不接受明文命令行密码参数。已有账号的密码、角色、状态、ID、会话版本及邀请记录保持不变；同邮箱姓名不一致时中止导入，避免覆盖另一人的账号。

```sh
bin/import-roster --identity-file /private/data/erp/identities.json --roster /private/provisioning/employee-roster.json --dry-run
bin/import-roster --identity-file /private/data/erp/identities.json --roster /private/provisioning/employee-roster.json --initial-password-file /private/provisioning/initial-password --apply --offline --verify-logins
```

导入一次原子保存全部账号及审计记录，重复执行不重置密码、不增加重复账号、不重复记审计。`--verify-logins` 验证本次新增账号的登录及部门、工位映射，输出汇总数字，不输出密码。导入后重启 API，再检查员工会话、组织目录和审批权限。创建账号时的指定初始口令仅用于该离线导入入口；普通邀请和修改密码仍采用原有密码规则。

### 信息公开栏

`GET /api/erp/bulletin` 仅向登录员工返回 `board.training`、`dashboard`、`video`、`messages`。训练成绩默认空；看板仅聚合现有权限可见的项目、待完成任务、产品种类、未结单据数量，不返回金额、员工绩效、业务名称、客户或业务编号。

- 留言：`POST /api/erp/bulletin/messages`，输入 `_requestId`、`body`。正文为纯文本，最多600个字符，作者及时间从服务器账号生成。每位员工间隔15秒、每小时最多10条，删除后仍计入限频；相同请求重试不会重复发布。`POST /api/erp/bulletin/messages/:id/delete` 输入 `_requestId`、`expectedVersion`，仅作者或管理员可软删除。最新100条及分页游标由 `GET /api/erp/bulletin/messages?before=...` 返回；客户端须使用 `textContent` 或 HTML 转义渲染文本。
- 训练成绩：`POST /api/erp/bulletin/training` 由管理员或经理录入。`entries` 每次1至250条，字段为实际 `employeeId`、`periodStart`、`periodEnd`、`completedCount`、`accuracy`、`expectedVersion`，另有可选内部批次参考 `sourceRef`。准确率为0至100、最多两位小数；创建版本为0，修改须提交当前版本。员工必须真实存在且在职。整批事务、幂等及审计保存实际提交值；排行榜按完成量、准确率排序，同分同名次。默认读取最新已录入周期，可用 `periodStart`、`periodEnd` 查询指定周期；没有训练流水时不自动构造分数。
- 宣传片：`POST /api/erp/bulletin/video` 仅管理员可设置，输入 `_requestId`、`src`、`title`、`expectedVersion`（首次0）。空地址表示未配置。站内只接受 `/media/`、`/assets/` 下的 MP4、WebM、Ogg 媒体；外部地址须为 HTTPS 且位于服务端官方域名名单，不允许用户名密码、任意外部主机、路径穿越、查询凭据或脚本地址。官方扩展域名由服务器环境变量 `OFFICE_BULLETIN_VIDEO_HOSTS` 逗号分隔指定，不接受客户端扩展名单。服务器不主动抓取视频地址。

公开栏使用三张独立的追加式表，迁移版本为6；与原有业务表、备份、幂等和审计共用 SQLite 事务。默认不写入留言、视频地址或训练成绩。降级回滚应保留新增表及数据；部署时核对原业务表指纹，不应把新增空表误认为原业务记录发生变化。

### 在线办公室位置与座位

`PUT /api/erp/presence` 支持 `operation: heartbeat | move | sit | stand`。心跳只续期，不读取其坐标或节点字段；其余动作必须提交最近一次响应的 `expectedRevision`。`move` 接受地图坐标；`sit` 接受组织中的 `seatId`，或本部门/公共区内的 `x,y`；`stand` 原地起身。坐下位置之间至少相距 18px；同一位置并发抢占只有一个请求成功，旧版本返回 409。

登录后在真实主部门建立位置，部门及可坐区域以服务端员工目录为准，页面传入的角色或部门不会改变权限。多部门员工可使用各所属部门的座位。签名浏览器会话绑定服务端内存租约，同 Cookie 的标签页共享位置，不同独立登录通过新登录接管；旧登录无法续期或退出新登录的位置。离座、移动、退出、停用、部门调动失去座位权限及 45 秒未续期均释放座位。服务重启后全部离线；在线位置不写入业务数据库，浏览器租约标识不公开。
