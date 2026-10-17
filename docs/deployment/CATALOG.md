# 通过 PanelArk 安装建站与 AI 面板

本页介绍通过已运行的 PanelArk 给目标服务器安装项目。PanelArk 自身的部署方式见[部署总览](README.md)。

## 分类与项目

| 分类 | 项目 | 默认访问端口 | 初始化方式 |
| --- | --- | --- | --- |
| 建站面板 | 1Panel、aaPanel、宝塔 Linux 面板 | 以项目卡片和最终交付结果为准 | 交付结果提供登录信息 |
| AI 面板 | New API | 3000，可修改 | 首次进入网页创建管理员 |
| AI 面板 | One API | 3002，可修改 | 新建实例使用 root / 123456，首次登录立即修改 |
| AI 面板 | CLIProxyAPI（CPA） | 8317，可修改 | 使用交付结果中的管理密钥进入 `/management.html` |

New API、One API 和 CPA 分别使用独立端口、容器名和数据目录，可以共存。项目卡片会显示适用的 Linux 系统、CPU 架构、内存、磁盘和自动安装依赖说明；是否适合安装还需结合目标服务器的真实环境检查。

前台不展示内部测试、验收状态或测试服务器信息。公开目录接口只返回正式产品信息，内部适配器验收字段保留在后端及受权限控制的管理接口中。未连接目标服务器、或尚未检测某个项目的安装状态时，不会默认显示已安装或未安装。

AI 面板的自动安装范围是 Ubuntu 20.04+、Debian 11+、Rocky/AlmaLinux 8+、CentOS Stream 9+，需要 amd64 或 arm64、systemd 和可访问官方源的网络；至少预留 1 GB 可用磁盘。宝塔在此基础上仅开放 amd64，Rocky/AlmaLinux 要求 9+。Windows、BSD、Alpine/OpenWrt、32 位系统及不在范围内的发行版不开放这四项自动安装。

## 网页操作

1. 验证可用 CDK，连接目标服务器并确认 SSH 指纹。
2. 完成环境检测，打开“面板部署”，选择“建站面板”或“AI 面板”。
3. 选择项目。AI 项目可以调整主服务端口；宝塔由官方安装器生成安全端口。
4. 点击检查并准备安装。系统检查端口占用，提示或处理本机防火墙；需要时到云厂商控制台放行安全组。
5. 安装完成后，复制实际访问地址和交付信息。密钥等敏感内容只通过当前授权任务交付，任务数据库保存脱敏结果。

## 宝塔 Linux 面板

安装器使用[宝塔官方下载页](https://www.bt.cn/new/download.html)提供的 12 系列稳定版脚本。已有 `bt` 命令或 `/etc/init.d/bt` 时主动停止安装，避免覆盖已有面板。请使用满足卡片要求的干净系统，已有网站运行环境时官方安装器也可能拒绝继续。

部署后读取服务器实际的面板端口、安全入口和 `bt default` 信息，并根据面板 SSL 状态返回 HTTP 或 HTTPS 地址。宝塔端口由官方脚本生成，请按交付地址检查云厂商安全组。若浏览器提示自签名证书，请核对服务器后为面板配置受信证书。

宝塔面板的预检门槛为 1 GB 可用磁盘；5 GB 是建站使用的预留建议，不是纯面板安装的硬性要求。安装其他运行环境、数据库和网站还需要额外空间。由于宝塔官方对 ARM 的部分软件兼容性存在限制，本适配器目前不开放 ARM 自动安装。

通过 SSH 可重新查看入口和运行状态：

```bash
bt default
bt status
```

## AI 面板的自动依赖与数据

缺少 Docker Engine 或 Compose 时，PanelArk 自动安装、启动并验证运行环境，然后继续安装项目。New API 和 One API 使用单容器 SQLite 方案，无需用户另外准备 MySQL 或 Redis。大规模业务可按上游文档规划数据库和缓存。

| 项目 | 容器名 | 宿主机持久化目录 |
| --- | --- | --- |
| New API | panelark-new-api | `/opt/panelark/new-api/data`、`/opt/panelark/new-api/logs` |
| One API | panelark-one-api | `/opt/panelark/one-api/data` |
| CPA | panelark-cliproxyapi | `/opt/panelark/cliproxyapi`，包含配置、认证文件、日志与插件 |

已有同名容器时复用并启动原容器，保留配置和数据；若新填写的主端口与原映射不同，安装会停止并提示原端口。更换端口不等于自动迁移现有容器。安装后检查容器运行状态和真实 HTTP 健康接口；CPA 还会验证管理密钥与客户端 API Key。

## CPA 登录与回调端口

首次安装生成随机管理密钥和客户端 API Key，原始凭据文件为 `/opt/panelark/cliproxyapi/credentials.env`，权限为 `600`。管理密钥用于网页管理，API Key 用于客户端调用，两者用途不同。

CPA 使用官方容器映射中的 OAuth 回调端口：`8085`、`1455`、`54545`、`51121`、`11451`。主端口不能使用这些值；安装前同时检查这些端口。若与现有服务冲突，应先迁移冲突服务或更换目标服务器。云安全组需要按使用的提供商放行相应回调端口。

安装完成后在管理中心选择提供商，由账号所有者完成 OAuth 或填写自己的上游 API Key。安装器不会自动登录第三方账号。完成授权并添加模型后，客户端 Base URL 使用 `http://服务器地址:主端口/v1`。正式对外使用时请通过已有 Nginx、OpenResty 或反向代理配置域名和 HTTPS。

修改管理密钥、API Key 或账号认证后，以当前 CPA 配置为准；原始凭据文件应同步维护。备份 CPA 时需同时备份配置和认证目录，妥善保管其中的密钥与令牌。

上游参考：[New API](https://github.com/QuantumNous/new-api)、[One API](https://github.com/songquanpeng/one-api)、[CLIProxyAPI 配置](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml)、[CPA 容器映射](https://github.com/router-for-me/CLIProxyAPI/blob/main/docker-compose.yml)。
