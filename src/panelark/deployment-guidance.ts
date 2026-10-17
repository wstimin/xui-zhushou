export function deploymentGuidance(reason: string): string[] {
  if (/认证失败|authentication|用户名或密码|私钥|SSH 密码/i.test(reason)) return ['核对服务器 IP、SSH 端口、用户名及密码／私钥。', '确认 SSH 允许该账号登录，然后重新连接。'];
  if (/超时|不可达|连接失败|refused|network|DNS|解析/i.test(reason)) return ['确认服务器在线，SSH 端口已在云厂商安全组放行。', '检查服务器能否访问官方软件源和容器仓库，网络恢复后重试。'];
  if (/端口|防火墙|安全组|占用/i.test(reason)) return ['系统不会停止或覆盖服务器已有业务。请迁移冲突服务，或换用干净服务器。', '若面板已安装但公网打不开，请在云厂商安全组放行结果中列出的 TCP 端口。'];
  if (/磁盘|内存|空间|至少需要/i.test(reason)) return ['按项目卡片的最低配置扩容内存或磁盘，或清理可确认无用的数据。', '完成后重新连接服务器并选择项目。'];
  if (/系统|架构|systemd|不支持/i.test(reason)) return ['使用项目卡片列出的 Linux 版本与 CPU 架构。', '需要 systemd 的项目请使用完整 VPS 系统，而不是受限容器。'];
  if (/sudo|root|权限/i.test(reason)) return ['使用 root，或具有免密 sudo 权限的 SSH 账号。', '请服务器管理员修正权限后重新连接。'];
  if (/已安装|已有|现有|覆盖/i.test(reason)) return ['自动流程不会覆盖已有面板或数据，请使用原有入口登录。', '如确需重装，请先备份并由管理员卸载旧项目，或使用新的干净服务器。'];
  if (/核销|授权|CDK/i.test(reason)) return ['若已显示登录信息，请先复制或下载保存，不要重复安装。', '联系站点管理员提供任务编号，核对授权记录和剩余次数。'];
  return ['请保存本页的失败原因与任务编号，联系站点管理员排查。', '若安装中途失败，服务器可能留有部分文件；检查残留后再重试，不要盲目重复安装。'];
}
