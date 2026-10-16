# Docker Compose 部署

适用于独立 Docker 主机或面板容器编排。支持完整源码及 Release 面板上传包；Dockerfile 会自动识别是否需要源码构建。

## 启动

把程序解压到例如 `/opt/panelark/app`，保留 Dockerfile、Compose 配置、package-lock.json、面板包中的 dist 等文件。在该目录执行：

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 panelark
```

程序以非 root 用户运行，内部端口为 1888；默认只绑定到宿主机 `127.0.0.1:1888`。在宿主机 Nginx 反向代理到该地址并绑定域名/HTTPS，然后浏览器访问域名进入安装向导。OpenResty 在另一个容器内时，使用 [1Panel 共享网络配置](1PANEL.md#方式-bcompose-编排--openresty-反向代理)。

读取生成的安装令牌：

```bash
docker compose exec panelark cat /app/data/admin-setup-token.txt
```

或者启动前在项目 `.env` 设置自己的唯一 `PANELARK_SETUP_TOKEN`。Docker Compose `.env` 用于变量替换，不会被复制进镜像；SQLite 和密钥保存在持久化卷 `/app/data` 中。

## 自定义端口

宿主机端口通过 `.env` 修改，反向代理目标同步修改：

```dotenv
PANELARK_PORT=2888
PANELARK_BIND_ADDRESS=127.0.0.1
```

容器内仍为 1888；共享网络方式的 `http://panelark-app:1888` 不需修改。如果改用远程代理，只对受信任代理开放后端端口，避免直接暴露信任代理头的应用端口。

## 数据与更新

更新前在后台导出加密备份并备份完整数据卷。使用新的源码或上传包替换程序，执行 `docker compose up -d --build` 重建。保留原编排项目名和数据卷名称；不要运行 `docker compose down -v`。

容器/面板部署由外部进程管理器更新应用；后台会提示使用面板更新，不会尝试在容器内运行 PM2/systemd。签名检查、加密备份和适配器目录更新仍然可用。用 GitHub 原始源码构建的镜像没有自动嵌入 Release 公钥；需要签名目录检查时使用面板 Release 包作为构建上下文，或通过环境变量配置经过核验的 `PANELARK_UPDATE_PUBLIC_KEY`。

目标 VPS 使用 SSH 管理，因此容器不需要 root、宿主机 Docker Socket 或 Docker 特权模式。目标 VPS 凭据只在任务执行时使用，不应放在镜像、Compose 文件或项目 `.env`。
