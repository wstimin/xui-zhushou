# PanelArk 阶段 8 正式发布与更新说明

## 发布签名

正式发布使用 Ed25519 对 `release-manifest.json` 签名。GitHub Actions 需要配置仓库 Secret：

```text
PANELARK_RELEASE_PRIVATE_KEY
```

Secret 内容是 PEM 格式 Ed25519 私钥。工作流只在内存环境变量中使用私钥，从中导出公钥并写入发布包的 `release-public-key.pem`。私钥不会进入构建包或 Actions Artifact。

签名清单固定包含产品、版本、通道、发布时间、最低兼容版本、更新包 HTTPS 地址、SHA-256、更新说明和适配器目录描述。修改任一字段都会导致签名验证失败。

## 在线更新流程

1. 超级管理员选择稳定或测试通道并检查更新。
2. 服务端通过内置 Ed25519 公钥验证清单，拒绝不匹配通道、HTTP 地址和无效版本。
3. 管理员确认安装后，系统使用本机托管密钥创建 `managed_pre_update` 加密快照。
4. 服务端下载更新包并验证 SHA-256，校验通过后直接启动独立更新执行器，不再等待第二次确认。
5. 执行器校验归档路径并解压到同级临时目录；正式包直接使用内置锁定依赖，旧包缺少依赖时才限时补齐。
6. 执行器原子切换目录、重启 PM2，并用 `/api/health` 验证目标版本。
7. 健康检查失败时自动切回旧目录并重新启动旧版本。

更新状态写入独立数据目录的 `update-state.json`，不随应用目录替换。浏览器在服务重启后继续轮询同一状态并显示完成或回滚结果。

在线应用更新只允许在 Linux 生产环境执行。开发环境可验证签名、SHA-256、页面和状态机，但不会替换本地项目目录。

## 适配器独立更新

签名发布清单可引用 `adapter-catalog.json`。系统验证其 SHA-256 后，只接受适配器名称、说明、分类、排序和启用状态等声明式字段，不下载或执行远端 JavaScript。紧急下架会立即影响公开目录和新任务创建。

适配器执行代码仍随签名核心发布包更新，避免远端目录成为任意代码执行入口。

## 生产安全基线

- 生产环境启用 CSP、HSTS、`frame-ancestors 'none'`、严格 Referrer Policy 和 Permissions Policy。
- 建议配置 `PANELARK_REQUIRE_HTTPS=true`。
- 只有可信反向代理才可配置 `PANELARK_TRUST_PROXY=true`。
- 管理会话使用 HttpOnly、SameSite=Strict、Priority=High Cookie，并对写操作验证 CSRF。
- 所有管理员应启用 TOTP 2FA，并定期撤销闲置会话。
- 定时备份密码通过 `PANELARK_BACKUP_PASSPHRASE` 注入，不写入数据库。
- 发布构建使用 `npm ci --omit=dev --ignore-scripts` 将锁定的生产依赖打入正式包，生产依赖审计必须为零。

## 发布验收

每次推送 `main` 必须同时递增 `package.json` 与 `package-lock.json` 版本；工作流拒绝复用已经发布的版本。工作流依次执行测试、类型检查、安装脚本语法检查、生产构建、发布包最小化校验、签名、公钥嵌入、归档与 SHA-256 生成，随后自动创建对应版本标签和 GitHub Release。发布包不得包含源码、运行数据库、`.env`、SSH 凭据或签名私钥。
