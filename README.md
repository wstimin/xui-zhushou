# PanelArk

当前发布版本：v2.6.1。

PanelArk（面板方舟）是面向多种 VPS 面板与工具的一键部署平台，已完成真实 CDK 商业授权、安全 SSH 预检、持久化任务引擎、多面板适配器、运营后台、加密迁移和签名在线更新闭环。

## 部署方式与网页安装

支持两套独立流程：**一键脚本在 SSH 终端完成安装与管理员初始化，打开网页直接使用，不经过网页安装向导**；**宝塔 / 1Panel 上传项目后启动 Node.js、绑定域名，再打开网页安装向导**。后者首次访问首页自动进入 `/install`，检查环境并填写站点、安装令牌和管理员信息。两种方式都使用内置 SQLite，无需另装 MySQL。

- [完整部署文档](docs/deployment/README.md)
- [宝塔上传与域名部署](docs/deployment/BT.md)
- [1Panel Node / Compose 部署](docs/deployment/1PANEL.md)
- [Docker Compose 部署](docs/deployment/DOCKER.md)
- [备份、更新与故障排查](docs/deployment/OPERATIONS.md)
- [目录项目安装：宝塔与 AI 面板](docs/deployment/CATALOG.md)
- [下载面板上传包 xui-zhushou-panel.zip](https://github.com/wstimin/xui-zhushou/releases/latest/download/xui-zhushou-panel.zip)

面板项目选择 Node.js 24 LTS，启动脚本 `panel:start`（`npm run panel:start`），或直接选择启动文件 `panel.cjs`。源码缺少 `dist` 时首次启动会自动构建；Release 上传包已经预编译，仅安装生产依赖。绑定域名前请先配置好 Node 项目或容器运行环境，不能只创建静态/PHP网站。

## PanelArk 管理后台与 CDK

- [后台管理功能与角色权限说明](docs/deployment/ADMIN.md)：超级管理员拥有全部后台业务管理权限，包括任务售后、套餐批次、管理员、资源、备份和审计管理。
- [后台全栏目实操验收记录](docs/panelark/ADMIN_ACCEPTANCE_2.5.2.md)：页面事件调用真实 HTTP / SQLite，核对文件、导出、重新加载与失败场景，不只检查按钮。
- 后台采用紧凑工作台布局：CDK／套餐／批次分标签管理，新增表单按需弹出，次要行操作收纳在“更多”菜单；暖黑金色与亮色主题、原有字号和管理权限保持不变。参见 [v2.6.0 布局说明](docs/panelark/RELEASE_2.6.0.md)。
- 系统更新页切换时先显示“读取中”，不再误报签名公钥未配置；安全基线检查独立加载，请求失败可刷新重试。参见 [v2.6.1 修复说明](docs/panelark/RELEASE_2.6.1.md)。

- 用户端地址：`http://服务器IP:1888/`
- 管理后台默认地址：`http://服务器IP:1888/admin`；超级管理员可在“站点配置”修改路径，保存后旧路径立即失效并自动跳转到新地址。
- 一键脚本首次安装在终端设置管理员用户名、密码（6 至 128 位）和后台路径；密码留空时随机生成，成功后仅显示一次。非交互安装自动生成管理员密码；也可在执行安装前通过环境变量 `PANELARK_ADMIN_USERNAME`、`PANELARK_ADMIN_PASSWORD`、`PANELARK_ADMIN_PATH`、`PANELARK_SITE_URL` 指定，不会把密码写入配置文件。
- 宝塔 / 1Panel / 容器部署首次启动且未设置 `PANELARK_SETUP_TOKEN` 时，令牌写入数据目录 `admin-setup-token.txt`，网页初始化完成后自动删除。一键脚本不用令牌，也不会开放网页初始化接口。
- 系统不会自动创建任何 CDK。首次管理员初始化后，请从后台创建正式套餐和批次；超级管理员与运营管理员可随时重新查看、复制、导出完整 CDK。
- 新生成的 CDK 同时保存验证哈希、末四位提示和 AES-256-GCM 加密副本，明文只在有权限的管理操作中返回。支持按状态、套餐、批次或授权码搜索，导出全部筛选结果（不限当前页）或选中记录为 TXT / CSV；支持单条编辑次数、有效期和状态，以及单条／批量删除、批量启停。旧版哈希记录仍可验证，但无法还原明文；持有原码的管理员可在编辑中绑定匹配的原码，之后即可查看和导出。详见 [CDK 管理说明](docs/deployment/CDK.md)。
- 购买按钮、购买链接、客服链接和站点公告均可从后台配置，外部链接必须使用 HTTPS。
- 用户端不设首页和关于，直接进入面板部署；导航保留面板部署、工具箱、部署文档和独立资源推荐区。购买入口只保留在 CDK 验证同一行，点击时服务器读取最新保存的链接再跳转；关闭购买开关会隐藏入口并禁止跳转。后台保存后用户端自动同步按钮配置，也可在后台测试已保存的购买链接。
- “购买链接”和“客服链接”是独立配置：购买 CDK 按钮只使用购买链接。后台分别显示已保存地址、提示未保存的购买修改，保存成功弹窗会列出两者，修改客服地址不会改变购买跳转。
- 2FA 为可选功能。未启用的账号仅需用户名和密码；启用的账号在密码验证通过后才显示动态验证码输入框。后台登录页和顶部栏均支持明暗主题切换，与用户端共用主题偏好。
- 后台与用户端共用原始暖象牙 / 暖黑深棕＋金色主题，不使用蓝灰配色；确认、输入、成功和错误提示均为站内居中主题弹窗，支持取消和 Esc，不使用浏览器原生弹窗。
- CDK、任务、目录、资源、管理员、备份、审计和登录会话均支持分页、总数、首页/末页、每页 10/20/50/100 条。服务端按页查询，旧的 100/300/500 条截断已移除；批次选择仍能读取全部套餐。
- 本地开发的数据库、密钥和初始化令牌默认位于 `data/`；一键安装脚本会把生产数据放在更新不会覆盖的 `/var/lib/panelark`。迁移服务器前必须备份该目录。

目录中的适配器均执行真实 SSH 安装命令和安装后验证；标记为“待实机验收”的项目应在目标发行版上完成验收后再对外开放。

项目卡片与自动部署流程展示适用的 Linux 系统、CPU 架构、资源要求和自动安装依赖说明，不展示内部测试或验收标签；安装前仍执行真实兼容性检查，不承诺任意 Linux 系统均可安装。AI 面板仅开放 Ubuntu 20.04+、Debian 11+、Rocky/AlmaLinux 8+、CentOS Stream 9+ 的 systemd 系统；宝塔仅开放 amd64，且 Rocky/AlmaLinux 需要 9+。维护者可查阅[实机验收记录](docs/panelark/ACCEPTANCE_2.3.1.md)，记录不等同于全部系统均已验证。

## 主要能力

- 使用 SSH 密码或私钥连接 VPS，检测系统、架构、systemd、内存和权限。
- 项目卡片与自动部署流程会提前显示支持系统、最低资源、架构和自动依赖，避免开始安装后才发现限制。
- 部署 Portainer、Nginx Proxy Manager、哪吒监控、Uptime Kuma、New API、One API 或 CLIProxyAPI 时，如未检测到 Docker，服务端会自动安装并验证 Docker Engine 与 Compose 后继续部署，无需用户手工准备。
- 目录按用途分为建站面板、代理面板、AI 面板、Docker 面板、监控面板等；1Panel、aaPanel 与宝塔 Linux 面板统一归入“建站面板”，New API、One API 与 CLIProxyAPI 统一归入“AI 面板”。
- CLIProxyAPI 会自动生成管理密钥和 API Key，但第三方账号 OAuth 必须由账号所有者在管理中心手动授权；系统不会采集或代填第三方账号密码。
- 安装 3x-ui，并显示精简的阶段进度，不向浏览器暴露完整脚本输出。
- 可自定义面板管理员用户名和密码；留空时自动生成安全凭据，同时自动生成面板端口和 Web 路径。
- 面板搭建完成后自动带入 API Token，节点创建直接调用管理 API。
- 创建 VLESS、VMess、Trojan、Shadowsocks 入站和分享链接。
- Reality 密钥对由目标 3x-ui 面板实时生成。
- TLS 节点复用面板安装阶段读取的 Web 证书路径，页面不要求手工填写证书路径。
- 可向当前 Xray 模板注入 SOCKS5 出站、入站路由和多代理随机负载均衡。
- 浏览器历史只保存非敏感元数据，不保存密码、Token、分享链接或 SOCKS 凭据。

## 目标服务器全自动部署

验证 CDK 后显示总次数、已用次数、使用中次数与剩余次数。用户填写服务器 SSH 信息并选择项目即可等待结果；系统自动处理指纹、环境、基础依赖、Docker、可调端口和本机防火墙，不再要求安装过程中手动确认。不支持的系统、无法安全处理的端口冲突或已有项目会直接返回原因与建议，不覆盖现有业务。

成功后返回真实登录信息，New API、One API、Portainer、Nginx Proxy Manager、CasaOS、Marzban、哪吒、Uptime Kuma 自动初始化并校验账号；Hiddify 读取实际管理员专属入口。第三方 OAuth、上游 API Key 与云厂商安全组不属于可代办的本机安装操作。详见[自动部署与交付说明](docs/deployment/AUTOMATIC.md)。

## 一键安装助手

支持 Ubuntu 20.04+、Debian 11+、CentOS 8+、Rocky Linux 和 AlmaLinux。请先切换到 `root` 用户，然后执行以下命令打开交互管理菜单：

```bash
bash <(curl -fsSL --retry 3 https://raw.githubusercontent.com/wstimin/xui-zhushou/main/install.sh)
```

需要跳过菜单、直接执行首次安装时使用（已安装会跳过，不重复安装）：

```bash
bash <(curl -fsSL --retry 3 https://raw.githubusercontent.com/wstimin/xui-zhushou/main/install.sh) install
```

上述 `raw.githubusercontent.com` 地址只用于获取管理脚本。GitHub Actions 会在远端使用 Node.js 24 LTS 执行测试、类型检查和生产构建，并生成 Linux 生产构建包；管理脚本随后从 GitHub Latest Release 下载 `xui-zhushou-linux.tar.gz` 和 `SHA256SUMS`。VPS 不会下载应用源码，也不会执行 Vite、TypeScript 或其他源码构建；缺少运行环境时，脚本会自动安装并验证 Node.js 24 LTS、npm 与 PM2。默认访问地址为：

```text
http://服务器IP:1888
```

云厂商安全组需要放行助手端口，默认为 `1888/tcp`。申请助手自身的域名证书时还需要临时放行 `80/tcp`。

安装完成后在 SSH 终端输入 `pa` 即可打开交互管理菜单（保留 `sy` 兼容）。输入 `pa` 或未知参数不会执行安装；无交互终端时必须明确指定子命令。

```text
[1] 首次安装助手（已安装则跳过）
[2] 仅为助手申请域名 SSL 证书并推送到面板
[3] 查看完整配置、账号、访问入口与运行状态
[4] 检查服务器环境
[5] 诊断域名访问
[6] 卸载助手
[7] 启动服务
[8] 停止服务
[9] 重启服务
[10] 查看最近 100 行运行日志
[11] 仅检测新版本（不下载、不安装）
[12] 终端初始化管理员（已初始化则保留）
[13] 修复 pa / sy 快捷命令
[14] 重置管理员密码
[15] 手动更新版本（确认后执行）
[0] 退出
```

常用维护命令：

```bash
pa
pa status
pa start
pa stop
pa restart
pa logs
pa check-update # 仅检测版本，不下载、不安装、不重启
pa update       # 明确执行更新，交互终端再次确认
pa init      # 仅在尚未初始化时使用，不覆盖既有账号
pa password  # 可信 SSH 终端内重置超级管理员密码
```

一键脚本首次安装从 GitHub Releases 下载构建包，通过 `SHA256SUMS` 校验完整性后部署到 `/opt/panelark`，PM2 进程名为 `panelark`。旧安装保留 `/opt/3xui-deploy-assistant` 路径和数据不搬迁，只迁移本项目旧进程名。更新请运行 `pa update`：先验证签名清单、比较版本，仅在新版本更高时下载对应版本包；相同或更低版本不会下载安装包、安装依赖或重启服务。安装/更新使用互斥锁。更新保留现有 `.env`、独立业务数据和 `/etc/3xui-assistant/ssl` 证书，仅替换程序并重启 PM2；健康检查失败时自动恢复上一版本。停止、启动和日志操作只管理本项目，不会安装应用。

从 v2.2.1 及更早版本升级到 v2.2.2，请先执行下面的新版管理脚本，完成进程名称迁移后再使用 `pa update` 或后台在线更新（旧脚本不认识新进程名，不能用于这次迁移）：

```bash
bash <(curl -fsSL --retry 3 https://raw.githubusercontent.com/wstimin/xui-zhushou/main/install.sh) update
```

若已有管理员，升级保留原账号、密码和后台路径；尚未初始化则由终端完成初始化。宝塔 / 1Panel 项目继续由面板托管，不使用此独立安装菜单管理。

`pa status` 会显示站点名称、前后台完整地址、后台路径、管理员账号、监听端口、版本、PID、进程资源、Node/PM2 版本、程序/数据/日志位置、SSL 与健康状态。管理员密码只保存哈希，不能反查明文；忘记密码使用 `pa password`，不会重新安装应用或清空业务数据。

检查服务器当前代码和运行版本：

```bash
pa status
curl -s http://127.0.0.1:1888/api/health
```

`VERSION` 与健康检查返回的 `version` 应一致。当前整体版本为 `2.6.1`。

后台“检测更新”只验证签名清单并显示版本、说明，不下载、不安装、不重启。发现新版本后，手动点击“下载并安装更新”并在站内居中弹窗确认一次，系统会使用本机托管密钥创建更新前快照，再连续完成下载、校验、切换、重启、健康检查和失败回滚，不要求输入更新密码。正式发布包内置锁定的生产依赖，避免在线更新再次等待 npm 下载；旧发布包缺少依赖时仍会限时补齐。生产安装需保留 systemd、PM2 与 Node.js 24 LTS 的可用性。v2.2.6 及更早版本若旧后台停在 50% 或更新无进展，可先在 SSH 终端运行 `pa update` 升级到新版流程。

正式版后台只提供稳定更新通道。若通过终端升级后仍残留旧版“等待应用”的 50% 状态，服务会自动识别当前版本已经更高，将旧状态归档为 100% 完成并禁止误降级；完成、失败或回滚后进度条动画也会停止。

“检测更新”只读取并展示版本结果，不计入安装进度，也不会保留动画进度条。进度条只在真正下载更新包、应用更新或重启服务时显示。

v2.4.1 起，系统更新页会在服务健康、实际版本与完成状态一致后自动重新加载新页面，并返回更新页；保留自定义后台路径，防止重复刷新。只检测版本、重启暂时离线、更新失败或回滚不会触发刷新。HTML 禁止缓存，新版页面按构建版本判断是否需要刷新，不影响用户端安装结果的保留规则。从旧前端首次升级时，仍需手动刷新一次以加载这项修复。

助手支持的服务器系统不代表每个面板都支持同样的发行版。请以项目卡片和部署文档的系统、架构、内存及磁盘要求为准；例如 Hiddify 需要 Ubuntu 22.04，CasaOS 要求至少 5 GB 可用磁盘。实际安装还需要目标服务器能够访问软件源、官方脚本和容器镜像仓库。

## 远端构建与发布

每次推送到 `main` 前，必须同时递增 `package.json` 与 `package-lock.json` 的版本。GitHub Actions 会拒绝已经存在对应版本标签的提交；新版本通过测试、类型检查、安装脚本语法检查、生产构建与构建包校验后，会自动创建版本标签和 GitHub Release，并发布以下文件：

```text
xui-zhushou-linux-v2.0.0.tar.gz
xui-zhushou-linux.tar.gz
SHA256SUMS
release-manifest.json
adapter-catalog.json
```

一键安装脚本固定下载 `releases/latest/download/xui-zhushou-linux.tar.gz`，后台在线更新还会验证 `release-manifest.json` 的 Ed25519 签名以及更新包 SHA-256。新版本发布完成后，服务器可在管理后台查看真实下载、切换、重启、健康检查或自动回滚状态。

## 3x-ui 安装脚本

这里有两个不同用途的 `install.sh`，不要混淆：

- `xui-zhushou/install.sh`：安装和管理本 Web 助手。
- `mogai-3xui/install.sh`：本助手默认用于远程安装 3x-ui 面板。

助手默认并推荐使用基于官方 2.9.4 修改 UI、客户端兼容范围更广的脚本：

```bash
bash <(curl -Ls https://raw.githubusercontent.com/wstimin/mogai-3xui/main/install.sh)
```

界面中仍可单独选择官方脚本：

```text
https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh
```

两套脚本使用独立的安装逻辑。官方脚本使用其无人值守环境变量；推荐脚本按实际交互顺序自动回答端口和 TLS 选项。安装完成后，两种脚本都会通过官方 `x-ui setting` 命令写入用户填写的用户名、密码、端口和 Web 路径，并在命令返回成功后重启服务。推荐脚本优先适配更多客户端。该脚本安装时要求配置 TLS：有域名使用域名证书，无域名使用 IP 证书。后端读取面板的实际证书状态、证书路径和 API Token；没有现成 Token 时会在安装完成后读取一次。安装成功弹窗显示本次任务实际返回的访问地址、账号密码与 Token；自动安装的敏感交付结果只通过当前页面内存凭证返回，CDK 核销不会清除；结果不会自动关闭，支持复制和下载。刷新或离开页面后不可重新查看，手动关闭时清除服务端结果；任务历史不保存完整交付凭据。

自定义 3x-ui 安装脚本只接受 HTTPS URL。非 root SSH 用户必须具备 `sudo -n` 免密 sudo 权限。

## 节点与鉴权

支持的主要组合：

- `VLESS + TCP + Reality`
- VLESS、VMess、Trojan 配合 TCP、WebSocket、gRPC、mKCP，并按协议规则选择 None 或 TLS
- `Shadowsocks + TCP + None`

当前 Reality 稳定实现限定为 `VLESS + TCP`。

节点创建要求提供 API Token，并直接使用 `Authorization: Bearer <token>` 调用 `/panel/api/**`，不再执行重复登录、认证检查、Token 获取或设置读取。普通协议和 TLS 通常只发起一次创建请求；Reality 额外调用一次面板密钥生成接口。TLS 直接复用面板安装阶段读取的证书路径。只有配置 SOCKS 链式路由时，才会使用账号密码 Session 读写 Xray 全局配置。本项目不使用 2FA 输入。

## TLS 证书复用

TLS 节点要求目标 3x-ui 面板已经配置可用的 Web TLS 证书。面板搭建完成后，助手会读取一次：

```text
POST /panel/setting/defaultSettings
```

接口返回的 `defaultCert` 和 `defaultKey` 是目标服务器上的真实路径。它们会随安装结果带入节点页面，并直接写入新入站的 `tlsSettings.certificates`，正式创建时不会再次请求。手动录入旧面板且没有缓存路径时，页面保留一次性读取按钮。

页面不会提供服务器证书路径输入框。默认 SNI 使用面板连接域名；如果面板通过 IP 访问但证书签发给域名，可以只填写证书域名作为 SNI。

## 环境配置

本地开发需要 Node.js 24 或更高版本：

```bash
npm ci
npm run dev
```

生产检查与构建：

```bash
npm run test
npm run lint
npm run build
npm start
```

复制 `.env.example` 为 `.env` 后可设置：

```env
PORT=1888
PANELARK_DATA_DIR=
PANELARK_SETUP_TOKEN=
APP_AUTH_TOKEN=
SSL_CERT=
SSL_KEY=
PANELARK_REQUIRE_HTTPS=false
PANELARK_TRUST_PROXY=false
PANELARK_BACKUP_PASSPHRASE=
PANELARK_UPDATE_PUBLIC_KEY=
PANELARK_UPDATE_MANIFEST_URL=
```

- `PORT`：助手监听端口，安装脚本会同步用于防火墙和访问提示。
- `PANELARK_DATA_DIR`：可选的运行数据目录，默认是项目目录下的 `data/`。
- `PANELARK_SETUP_TOKEN`：可选的首次管理员初始化令牌；未设置时自动生成到数据目录。
- `APP_AUTH_TOKEN`：可选的助手 API 保护。设置后，请由受信任的反向代理添加 `Authorization: Bearer <token>` 或 `X-App-Token` 请求头。
- `SSL_CERT` / `SSL_KEY`：助手自身 HTTPS 证书路径。两者留空时，服务端也会自动检查 `/etc/3xui-assistant/ssl/cert.pem` 和 `/etc/3xui-assistant/ssl/key.pem`。
- `PANELARK_REQUIRE_HTTPS`：生产环境设为 `true` 后拒绝明文 HTTP 请求。
- `PANELARK_TRUST_PROXY`：仅在可信反向代理正确设置转发协议头时启用。
- `PANELARK_BACKUP_PASSPHRASE`：定时加密备份使用的密码，不会写入数据库。
- 更新公钥默认来自正式发布包内的 `release-public-key.pem`；更新地址可通过环境变量切换到受控镜像。

## SOCKS 路由

SOCKS 功能修改的是 3x-ui 全局 Xray 模板，不只是单个入站。助手会保留原模板并使用唯一 tag 添加出站和路由；后续步骤失败时会尝试恢复原模板并删除刚创建的入站。修改前仍建议在 3x-ui 中备份配置。

支持以下输入格式：

```text
socks5://user:password@127.0.0.1:1080
127.0.0.1:1080:user:password
127.0.0.1:1080
```

## 安全说明

SSH 密码、私钥、面板密码和 API Token 都会经过助手后端。不要在不可信网络中通过明文 HTTP 使用公开部署的助手。公网部署建议启用助手自身 HTTPS，并限制来源 IP，或放在带认证的 HTTPS 反向代理之后。

助手会尝试放行 VPS 本机防火墙，但无法可靠修改云厂商安全组。助手端口、3x-ui 面板端口以及创建的节点入站端口仍需在云控制台手工放行。

## 验证范围

仓库包含后端单元测试，覆盖 URL 与端口验证、Shell 转义、推荐与官方安装命令、Reality/TLS 入站、订阅 URL 和 SOCKS 模板注入。发布检查还包括 TypeScript 类型检查、Vite/服务端生产构建和 `install.sh` Bash 语法检查。

自动化测试使用受控 SSH 与 HTTP 测试服务，不会连接外部 VPS，也不会向外部 3x-ui 面板写入配置。正式开放某个适配器前仍需完成对应系统版本的实机验收。
