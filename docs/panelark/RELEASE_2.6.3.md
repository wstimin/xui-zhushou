# v2.6.3：3x-ui 官方脚本与官方登录信息交付

此版本通过全部测试，但发布被既有生产依赖的安全审计拦截，未生成正式 Release；下述修复连同依赖补丁由 v2.6.4 发布。

## 已确认的问题

- 自动安装仍强制选择旧的 `recommended`，指向魔改仓库；普通安装入口也默认使用该来源，与 Official 标识不符。
- 安装后再次修改账号、端口和路径，随后读取的官方结果文件可能仍是修改前的内容；配置成功判断还依赖英文输出。
- 部分路径使用预设账号、密码或根据 SSL 请求猜测协议；IP 证书和证书申请失败时可能生成错误登录地址。
- Token 缺失时依赖旧版 HTTP 管理接口，官方版本变化会影响交付。

## 修复

3x-ui 全部安装入口只使用 `https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh`。旧 `recommended` 请求映射到官方，自定义来源明确拒绝。既有魔改面板的节点兼容能力保留，不会自动重装或迁移服务器上的旧面板。

官方脚本通过无人值守环境变量接收配置。先完整下载临时脚本，下载失败不执行；不发送旧交互答案，也不在安装后再次改写账号或依据英文提示判断成功。

官方读取流程：

1. 确认 `x-ui` 服务运行并读取 `/etc/x-ui/install-result.env`，使用 Bash 正确解析官方 `%q` 转义。
2. `x-ui setting -show` 查询当前端口、路径，`x-ui setting -getCert` 查询证书。与结果文件核对，发现过期信息直接失败。
3. 优先使用官方结果中的 Token，缺失时调用 `x-ui setting -getApiToken`，不依赖旧 HTTP 获取接口。
4. 使用读取的账号密码真实登录，再用读取的 Token 请求入站列表。两者验证通过才交付结果。

密码通过 Base64 无损传输，不截断空格、引号、等号或非 ASCII 字符；读取输出不写入任务事件。缺失结果、服务未启动、CLI 查询失败和 Token 无效有明确错误，不使用计划参数补造成功，也不自动重置已有账号。

## 验证范围

新增 `server/three-xui-install.test.ts`：官方来源、兼容旧参数、特殊字符密码、IP TLS、真实证书状态、结果缺失与配置不一致；受控真实 HTTP 服务验证用户名密码和 Bearer Token。Linux 还执行真实 Bash，解析官方格式文件并调用受控 CLI，核对不改密码、仅缺 Token 时查询，以及结果文件缺失时报错。

适配器、自动流程、旧普通安装入口统一复用来源策略与官方结果读取器。继续执行项目全量回归、类型检查、正式构建与发布包验证。本轮不更新客户服务器、不在客户服务器上安装或覆盖 3x-ui。

官方依据：[安装说明](https://github.com/MHSanaei/3x-ui/wiki/Installation)、[官方安装脚本](https://github.com/MHSanaei/3x-ui/blob/master/install.sh)、[官方 CLI](https://github.com/MHSanaei/3x-ui/blob/master/main.go)。
