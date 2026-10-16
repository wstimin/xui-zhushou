# PanelArk 部署文档

本项目是 Node.js 服务，内置 SQLite 数据库。支持一键脚本、宝塔 Node 项目、1Panel Node 运行环境及 Docker Compose。宝塔/1Panel 在这里用于托管 **PanelArk 本身**，不是要求先安装本项目目录里的目标面板。

| 部署方式 | 适用场景 | 详细步骤 |
| --- | --- | --- |
| 一键脚本 | 独立 Linux VPS，脚本管理 Node、PM2 和更新 | [一键安装](../../README.md#一键安装助手) |
| 宝塔 | 在已有宝塔中上传源码或预编译包、绑定域名 | [宝塔部署](BT.md) |
| 1Panel | Node 运行环境网站，或容器编排后反向代理 | [1Panel 部署](1PANEL.md) |
| Docker Compose | 使用独立容器运行、持久化数据卷 | [Docker 部署](DOCKER.md) |
| 更新与恢复 | 数据保留、面板接管更新、错误排查 | [运维与故障排查](OPERATIONS.md) |

## 安装包选择

- 推荐上传 [Latest Release 的 `xui-zhushou-panel.zip`](https://github.com/wstimin/xui-zhushou/releases/latest/download/xui-zhushou-panel.zip)。内含预编译前后端、面板启动文件、容器配置和部署文档；首次启动只安装生产依赖，节省服务器构建资源。
- 也支持 GitHub **Code → Download ZIP** 的完整源码。解压后进入有 `package.json`、`panel.cjs` 的实际项目根目录。启动 `panel.cjs` 时，缺少 `dist` 会自动安装构建依赖并构建。
- 两种方式都需要面板提供 Node.js **24 LTS 或更高**及 npm；仅上传到 PHP/静态网站目录并绑定域名不能执行 Node.js 后端。
- 包的 SHA-256 可对照同一 Release 的 `SHA256SUMS`。下载后不要把 `.env`、数据库或密钥放入公开静态文件目录。

## 共同准备

1. 域名 A/AAAA 指向运行 PanelArk 的服务器。仅配置自己能正常使用的 IPv4/IPv6 记录。
2. 由宝塔 Nginx / 1Panel OpenResty 监听公网 80/443、绑定域名并申请证书。
3. 应用内部监听 1888；可以在环境变量 `PORT` 中修改，网站反向代理目标也需同步。若同机已有一键脚本实例，请换端口和独立数据目录，避免两个进程读写同一 SQLite。
4. 准备至少 1 GB 内存和足够磁盘空间；源码首次构建建议 2 GB 以上内存。项目安装到目标 VPS 时，各目标项目仍有独立系统/资源要求。
5. 程序运行用户必须能读取项目文件、写入 `PANELARK_DATA_DIR`。不要为解决权限问题把整个目录设为 777。

## 网页安装向导

服务启动、域名绑定后，访问 `https://你的域名/`，未初始化的站点会自动进入 `/install`：

1. 确认 Node.js、SQLite、数据目录与业务密钥四项检测通过。SQLite 由系统自动连接，**不用安装 MySQL、不用填写数据库密码**。
2. 填写站点名称、完整域名地址和后台路径。填写域名仅保存站点信息，DNS、反向代理和证书仍由面板配置。
3. 输入安装令牌、管理员用户名和强密码。令牌来自数据目录中的 `admin-setup-token.txt`，可通过面板文件管理器或容器终端读取；也可在首次启动前设置自己的随机 `PANELARK_SETUP_TOKEN`（建议 24 位以上）。网页不会公开令牌。
4. 点击“完成安装并连接站点”。站点配置、管理员和安装状态一起提交；完成后自动登录，点击“进入管理后台”或“打开用户首页”。请保存自定义后台路径。
5. 安装完成后 `/install` 只能显示已安装状态，重复初始化会被拒绝。无需删除程序文件。请从面板移除临时 `PANELARK_SETUP_TOKEN` 环境变量后再按需重启。

安装后，在后台创建套餐和 CDK、设置购买/客服入口；在用户首页验证 CDK 后填写 **目标 VPS** 的 SSH 信息、核对指纹并选择项目。网页安装向导设置的是本平台，不会自动连接尚未提供凭据的 VPS。

## 主要环境变量

| 变量 | 默认 / 含义 |
| --- | --- |
| `PORT` | `1888`，程序内部端口 |
| `HOST` | `0.0.0.0`；同机原生 Node 可用 `127.0.0.1`，容器内必须保留 `0.0.0.0` |
| `PANELARK_DATA_DIR` | 面板启动默认项目 `data/`；推荐设置为替换程序时不会被覆盖的绝对路径，容器须持久化挂载 |
| `PANELARK_SETUP_TOKEN` | 可选首次安装令牌，未设置时自动生成令牌文件 |
| `PANELARK_TRUST_PROXY` | 面板代理可设 `true`；只允许受信任代理访问后端端口，代理须正确传递 `X-Forwarded-Proto` |
| `PANELARK_DEPLOYMENT_MODE` | `panel:start` 自动使用 `panel`，镜像自动使用 `docker`；面板/容器负责更新服务 |
| `PANELARK_BACKUP_PASSPHRASE` | 可选，启用定时加密备份时设置，至少 12 位；务必另行保管 |

推荐让证书在面板反向代理处终止，后端使用 HTTP。该方式不需要向 Node 项目传入 `SSL_CERT` / `SSL_KEY`。完整变量示例见 [`.env.example`](../../.env.example)。

官方参考：[宝塔 Node.js 部署](https://docs.bt.cn/practical-tutorials/nodejs-pm2-deployment/)、[宝塔域名与映射](https://docs.bt.cn/practical-tutorials/nextjs-deployment/)、[1Panel 创建网站](https://docs.fit2cloud.com/1panel/user_manual/websites/website-create/)。菜单名称可能随面板版本不同，以本项目的端口、目录与命令要求为准。
