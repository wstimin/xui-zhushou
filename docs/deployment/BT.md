# 宝塔：上传项目 → 绑定域名 → 网页安装

## 1. 准备运行环境并上传

在宝塔安装 Nginx 和 Node.js 24 LTS（较老的 Node 管理插件可能需要更新）。从 [Release](https://github.com/wstimin/xui-zhushou/releases/latest) 下载 `xui-zhushou-panel.zip`，上传并解压到例如 `/www/wwwroot/panelark`。

支持上传完整 GitHub 源码 ZIP；注意多一层 `xui-zhushou-main` 解压目录时，项目目录必须选到实际含 `package.json` 与 `panel.cjs` 的那一层。

## 2. 创建 Node 项目

在“网站 → Node 项目”或 Node.js 管理器中新增项目：

| 设置 | 填写内容 |
| --- | --- |
| 名称 | `panelark` |
| 项目 / 运行目录 | `/www/wwwroot/panelark` |
| Node.js | 24 LTS 或更高 |
| npm 启动脚本 | `panel:start`（完整命令 `npm run panel:start`） |
| 若面板要求启动文件 | 选择 `panel.cjs`；参数留空 |
| 应用端口 | `1888`，不要与已有项目冲突 |
| 运行用户 | 使用宝塔的非特权运行用户，例如 `www` |
| 实例数 | `1`；SQLite 同一数据目录不要启动多个实例 |
| 开机启动 | 开启 |

可在面板环境变量设置（或复制 `.env.example` 为项目 `.env` 后修改）：

```dotenv
PORT=1888
HOST=127.0.0.1
PANELARK_DATA_DIR=/www/panelark-data
PANELARK_TRUST_PROXY=true
```

使用面板文件管理器创建 `/www/panelark-data` 并把所有者设置成运行用户。项目目录首次安装依赖/构建也需要写权限。数据目录必须独立于公开静态网站，更新时保留。若需要自己预设安装令牌，在面板额外添加唯一的 `PANELARK_SETUP_TOKEN`，不要使用教程中的固定密码。

提交并等待日志出现 `[HTTP] PanelArk`。预编译上传包自动安装生产依赖；纯源码首次启动会自动构建，耗时取决于网络和服务器资源。不要同时运行宝塔进程和手动 PM2 进程。

## 3. 绑定域名与 HTTPS

在 Node 项目设置中开启域名映射 / 绑定域名，目标为 `http://127.0.0.1:1888`。或创建反向代理网站，将该域名所有请求转发到上述地址。

在网站 SSL 配置中申请/导入证书并开启 HTTPS。代理需要：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_buffering off;
proxy_read_timeout 1200s;
```

完整 `location /` 示例见 [`deploy/nginx.conf.example`](../../deploy/nginx.conf.example)。只在站点实际的代理位置配置，不要在同一个 `server` 中添加两个重复的 `location /`。没有特殊需要时无需开放公网 1888。

## 4. 打开向导

访问 `https://你的域名/`，自动进入安装向导。在文件管理器读取 `/www/panelark-data/admin-setup-token.txt`，或填写自己预设的安装令牌，然后填写站点与管理员信息。成功后点击“进入管理后台”。

首次安装向导不能正常出现时，先确认不是静态/PHP网站、不是错误解压层级，并检查 Node 项目日志和端口。

## 5. 更新、备份与恢复

通过后台先导出加密备份；备份独立数据目录。停止宝塔 Node 项目，上传新版预编译包覆盖程序，保留 `.env` 和数据目录。若用源码更新，删除旧 `dist` 后重新启动以触发构建，或先执行 `npm ci --include=dev --ignore-scripts && npm run build`。依赖锁文件变更时先通过面板执行 `npm ci --omit=dev --ignore-scripts`（源码构建阶段需包含开发依赖）。

更新完由宝塔重新启动。不要对宝塔托管项目运行 `sy install`，它会创建另一套独立安装目录和 PM2 项目。更多问题见[运维文档](OPERATIONS.md)。
