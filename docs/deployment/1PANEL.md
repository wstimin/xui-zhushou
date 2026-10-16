# 1Panel：Node 运行环境或容器编排部署

推荐选一种方式使用。不要让运行环境网站和 Compose 同时绑定相同端口或共享同一 SQLite 数据目录。

## 方式 A：Node.js 运行环境网站

1. 在应用商店准备 OpenResty，在“网站 → 运行环境”中准备 Node.js **24 LTS 或更高**。若当前运行环境模板没有该版本，使用下面的 Compose 方式，它明确使用 Node 24 镜像。
2. 上传并解压 `xui-zhushou-panel.zip` 到自己的项目目录，例如 `/opt/panelark/app`；也支持 GitHub 源码。运行目录选择到有 `package.json`、`panel.cjs` 的层级。
3. 创建 Node 运行环境或对应运行环境网站，启动命令填写 `npm run panel:start`，工作目录选择上传目录，应用内部端口填写 `1888`，实例数为 1。设置项目和数据目录对运行用户可写。
4. 设置环境变量：`PORT=1888`、`HOST=0.0.0.0`、`PANELARK_TRUST_PROXY=true`。把 `PANELARK_DATA_DIR` 指向容器/运行环境中**已持久化的目录**，例如运行环境源码挂载目录里的 `data`；确认它实际映射到宿主机目录。不是看到 `/app/data` 字样就代表已经持久化。
5. 创建“运行环境”类型网站，选择上述 Node 环境并绑定域名。通过网站 SSL 设置申请证书。面板会配置代理到运行环境，按需要关闭代理缓冲并延长读取超时。
6. 等运行日志显示已监听端口，访问域名进入 `/install`。在宿主机对应的数据目录或容器终端读取 `admin-setup-token.txt`，填写安装信息后进入后台。

如果使用的是宿主机原生 Node 而不是容器，可用 `HOST=127.0.0.1`，然后建反向代理网站。若 OpenResty 自身在容器内，需保证代理地址在该容器内可达；不能直接把宿主机 `127.0.0.1` 当成容器宿主机。

## 方式 B：Compose 编排 + OpenResty 反向代理

1. 上传并解压源码或面板上传包到 `/opt/panelark/app`，保留 `Dockerfile`、`docker-compose.yml` 和 `deploy/`。通过 1Panel 的容器编排能力以该目录为构建上下文，或者在面板终端执行下面的命令。
2. 先在 1Panel “容器 → 网络”查看 **OpenResty 已连接的实际网络名称**。在项目 `.env` 中设置：

```dotenv
PANELARK_PORT=1888
PANELARK_BIND_ADDRESS=127.0.0.1
PANELARK_PROXY_NETWORK=这里填写已有的OpenResty网络名称
```

可在 `.env` 额外填写唯一的 `PANELARK_SETUP_TOKEN`，用于首次网页安装。不要复制教程固定值作为令牌。

3. 在编排中使用主配置与附加网络配置；若面板界面不支持多个配置文件，在面板终端运行：

```bash
cd /opt/panelark/app
docker compose -f docker-compose.yml -f deploy/compose.1panel.yml up -d --build
```

`deploy/compose.1panel.yml` 会让应用加入指定的已有 OpenResty 网络，设置 DNS 别名 `panelark-app`。如果 `panelark-app` 已被其他应用使用，请修改别名并同步代理地址。

4. 在 1Panel 创建“反向代理”类型网站，绑定域名，代理目标填写：

```text
http://panelark-app:1888
```

该目标只有加入同一网络的 OpenResty 容器才能访问。若 OpenResty 使用主机网络，通常直接使用 `http://127.0.0.1:1888` 即可，无需额外网络配置。先确认实际网络模式。

5. 在网站申请证书、开启 HTTPS。代理保留 `Host` 和 `X-Forwarded-Proto`，关闭缓冲并设置 `proxy_read_timeout 1200s`，参见[代理配置示例](../../deploy/nginx.conf.example)。
6. 在 1Panel 编排的应用容器终端执行 `cat /app/data/admin-setup-token.txt`，或使用预设令牌；访问域名填写向导，完成后自动登录后台。

## 持久化、更新与端口

- 数据保存在名为 `panelark-data` 的 Docker 卷（实际卷名可能含编排项目前缀）中。备份/迁移需要保留整个卷，尤其 SQLite 和 `panelark.secret`。可用后台加密备份导出业务数据。
- 默认只向宿主机 `127.0.0.1:1888` 发布后端端口；通过共享网络反向代理时同样无需把 1888 暴露公网。
- 更新前备份，替换项目文件后按原来的两个 Compose 配置重新构建、启动。不要执行 `down -v` 或删除数据卷，否则会删除业务数据。面板内更新方式和容器日志见[运维文档](OPERATIONS.md)。
- 目标 VPS 安装走 SSH，不需要给 PanelArk 容器挂载 `/var/run/docker.sock`，不需要开启特权模式。

官方操作参考：[1Panel 创建网站](https://docs.fit2cloud.com/1panel/user_manual/websites/website-create/)。面板版本之间菜单名称不同，应用端口、启动命令、数据持久化与代理网络要求不变。
