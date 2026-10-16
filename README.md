# PanelArk

PanelArk（面板方舟）是面向多种 VPS 面板与工具的一键部署平台，已完成真实 CDK 商业授权、安全 SSH 预检、持久化任务引擎、多面板适配器、运营后台、加密迁移和签名在线更新闭环。

## PanelArk 管理后台与 CDK

- 用户端地址：`http://服务器IP:1888/`
- 管理后台默认地址：`http://服务器IP:1888/admin`；超级管理员可在“站点配置”修改路径，保存后旧路径立即失效并自动跳转到新地址。
- 首次启动且未设置 `PANELARK_SETUP_TOKEN` 时，初始化令牌写入 `data/admin-setup-token.txt`；完成超级管理员初始化后该文件自动删除。
- 系统不会自动创建任何 CDK。首次管理员初始化后，请从后台创建正式套餐和批次并安全保存一次性显示的授权码。
- CDK 明文只在后台批次生成成功时显示一次，数据库仅保存不可逆哈希和末四位提示。
- 购买按钮、购买链接、客服链接和站点公告均可从后台配置，外部链接必须使用 HTTPS。
- 本地开发的数据库、密钥和初始化令牌默认位于 `data/`；一键安装脚本会把生产数据放在更新不会覆盖的 `/var/lib/panelark`。迁移服务器前必须备份该目录。

目录中的适配器均执行真实 SSH 安装命令和安装后验证；标记为“待实机验收”的项目应在目标发行版上完成验收后再对外开放。

## 主要能力

- 使用 SSH 密码或私钥连接 VPS，检测系统、架构、systemd、内存和权限。
- 安装 3x-ui，并显示精简的阶段进度，不向浏览器暴露完整脚本输出。
- 可自定义面板管理员用户名和密码；留空时自动生成安全凭据，同时自动生成面板端口和 Web 路径。
- 面板搭建完成后自动带入 API Token，节点创建直接调用管理 API。
- 创建 VLESS、VMess、Trojan、Shadowsocks 入站和分享链接。
- Reality 密钥对由目标 3x-ui 面板实时生成。
- TLS 节点复用面板安装阶段读取的 Web 证书路径，页面不要求手工填写证书路径。
- 可向当前 Xray 模板注入 SOCKS5 出站、入站路由和多代理随机负载均衡。
- 浏览器历史只保存非敏感元数据，不保存密码、Token、分享链接或 SOCKS 凭据。

## 一键安装助手

支持 Ubuntu 20.04+、Debian 11+、CentOS 8+、Rocky Linux 和 AlmaLinux。请先切换到 `root` 用户，然后执行以下命令打开原有交互菜单：

```bash
bash <(curl -fsSL --retry 3 https://raw.githubusercontent.com/wstimin/xui-zhushou/main/install.sh)
```

需要跳过菜单、直接执行安装或更新时使用：

```bash
bash <(curl -fsSL --retry 3 https://raw.githubusercontent.com/wstimin/xui-zhushou/main/install.sh) install
```

上述 `raw.githubusercontent.com` 地址只用于获取管理脚本。GitHub Actions 会在远端执行测试、类型检查和生产构建，并生成 Linux 生产构建包；管理脚本随后从 GitHub Latest Release 下载 `xui-zhushou-linux.tar.gz` 和 `SHA256SUMS`。VPS 不会下载应用源码，也不会执行 Vite、TypeScript 或其他源码构建。默认访问地址为：

```text
http://服务器IP:1888
```

云厂商安全组需要放行助手端口，默认为 `1888/tcp`。申请助手自身的域名证书时还需要临时放行 `80/tcp`。

安装完成后可以运行 `sy` 打开管理菜单：

```text
[1] 安装或更新助手（下载远端生产构建包）
[2] 仅为助手申请域名 SSL 证书并推送到面板
[3] 查看服务与证书状态
[4] 检查服务器环境
[5] 诊断域名访问
[6] 卸载助手
```

常用维护命令：

```bash
sy
pm2 status
pm2 logs 3xui-deploy-assistant
sudo bash /opt/3xui-deploy-assistant/install.sh install
```

一键脚本默认从 GitHub Releases 下载 `xui-zhushou-linux.tar.gz`，通过 `SHA256SUMS` 校验完整性后部署到 `/opt/3xui-deploy-assistant`。通过 `sy` 或 `sudo bash install.sh install` 更新时，会保留现有 `.env` 配置和 `/etc/3xui-assistant/ssl` 证书目录，仅替换应用构建包并重启 PM2；不会重新申请、安装或覆盖 SSL 证书。新构建包启动失败或运行版本校验不一致时会自动恢复上一版本。

检查服务器当前代码和运行版本：

```bash
cat /opt/3xui-deploy-assistant/VERSION
curl -s http://127.0.0.1:1888/api/health
```

`VERSION` 与健康检查返回的 `version` 应一致。当前整体版本为 `2.1.3`。

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

两套脚本使用独立的安装逻辑。官方脚本使用其无人值守环境变量；推荐脚本按实际交互顺序自动回答端口和 TLS 选项。安装完成后，两种脚本都会通过官方 `x-ui setting` 命令写入用户填写的用户名、密码、端口和 Web 路径，并在确认命令返回成功后重启服务。推荐脚本优先适配更多客户端。该脚本安装时要求配置 TLS：有域名使用域名证书，无域名使用 IP 证书。后端读取面板的实际证书状态、证书路径和 API Token；没有现成 Token 时会在安装完成后读取一次。安装成功弹窗显示本次任务实际返回的访问地址、账号密码与 Token；敏感交付结果只保存在当前服务进程内，并在 CDK 核销后清除，数据库任务记录只保存脱敏结果。

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

本地开发需要 Node.js 20 或更高版本：

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
PANELARK_BETA_MANIFEST_URL=
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
