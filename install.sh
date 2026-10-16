#!/usr/bin/env bash

# ==============================================================================
#  PanelArk 面板方舟 - 一键安装、更新与 SSL 管理脚本
#  支持系统: Ubuntu 20.04+, Debian 11+, CentOS 8+ / Rocky Linux / AlmaLinux
# ==============================================================================

set -e
set -o pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

RELEASE_URL="${RELEASE_URL:-https://github.com/wstimin/xui-zhushou/releases/latest/download/xui-zhushou-linux.tar.gz}"
RELEASE_CHECKSUM_URL="${RELEASE_CHECKSUM_URL:-https://github.com/wstimin/xui-zhushou/releases/latest/download/SHA256SUMS}"
TARGET_DIR="/opt/3xui-deploy-assistant"
APP_NAME="3xui-deploy-assistant"
SSL_DIR="/etc/3xui-assistant/ssl"
PANELARK_STATE_DIR="/var/lib/panelark"
DEFAULT_PORT="1888"
APP_PORT="${PORT:-$DEFAULT_PORT}"
MIN_NODE_MAJOR="24"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTIVE_PROJECT_DIR="$TARGET_DIR"
SHORTCUT_DIR="/usr/local/bin"
INSTALL_LOCK_FILE="/var/lock/panelark-install.lock"

load_runtime_config() {
  local config_dir=""
  if [ -f "$ACTIVE_PROJECT_DIR/.env" ]; then
    config_dir="$ACTIVE_PROJECT_DIR"
  elif [ -f "$SCRIPT_DIR/.env" ]; then
    config_dir="$SCRIPT_DIR"
  fi

  if [ -n "$config_dir" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$config_dir/.env"
    set +a
  fi
  APP_PORT="${PORT:-$DEFAULT_PORT}"
}

read_installed_version() {
  if [ -f "$TARGET_DIR/VERSION" ]; then
    tr -d '[:space:]' < "$TARGET_DIR/VERSION"
  else
    echo "unknown"
  fi
}

download_release_package() {
  local work_dir archive_file checksum_file package_dir expected_checksum actual_checksum release_archive_name
  work_dir=$(mktemp -d)
  archive_file="$work_dir/xui-zhushou-linux.tar.gz"
  checksum_file="$work_dir/SHA256SUMS"
  package_dir="$work_dir/package"
  mkdir -p "$package_dir"

  echo -e "${YELLOW}[INFO] 正在下载远端最新构建包...${NC}"
  if ! curl -fL --retry 3 --connect-timeout 15 "$RELEASE_URL" -o "$archive_file"; then
    rm -rf "$work_dir"
    echo -e "${RED}[ERROR] 构建包下载失败，请检查 GitHub 连接或 RELEASE_URL。${NC}"
    return 1
  fi

  if ! curl -fL --retry 3 --connect-timeout 15 "$RELEASE_CHECKSUM_URL" -o "$checksum_file"; then
    rm -rf "$work_dir"
    echo -e "${RED}[ERROR] 构建包校验文件下载失败，已停止安装。${NC}"
    return 1
  fi

  release_archive_name="${RELEASE_URL##*/}"
  expected_checksum=$(awk -v name="$release_archive_name" '$2 == name { print $1; exit }' "$checksum_file")
  actual_checksum=$(sha256sum "$archive_file" | awk '{ print $1 }')
  if [ -z "$expected_checksum" ] || [ "$expected_checksum" != "$actual_checksum" ]; then
    rm -rf "$work_dir"
    echo -e "${RED}[ERROR] 构建包 SHA-256 校验失败，已停止安装。${NC}"
    return 1
  fi
  echo -e "${GREEN}[OK] 构建包完整性校验通过。${NC}"

  if ! tar -xzf "$archive_file" -C "$package_dir"; then
    rm -rf "$work_dir"
    echo -e "${RED}[ERROR] 构建包无法解压，文件可能不完整。${NC}"
    return 1
  fi

  if [ ! -f "$package_dir/VERSION" ] || [ ! -f "$package_dir/dist/server.cjs" ] || [ ! -f "$package_dir/package.json" ]; then
    rm -rf "$work_dir"
    echo -e "${RED}[ERROR] 构建包结构无效，已停止安装。${NC}"
    return 1
  fi

  DOWNLOADED_WORK_DIR="$work_dir"
  DOWNLOADED_PACKAGE_DIR="$package_dir"
}

restore_previous_release() {
  echo -e "${YELLOW}[ROLLBACK] 正在恢复安装前版本...${NC}"
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  rm -rf "$TARGET_DIR"
  if [ -d "$BACKUP_DIR" ]; then
    mv "$BACKUP_DIR" "$TARGET_DIR"
    cd "$TARGET_DIR"
    APP_VERSION=$(read_installed_version)
    export APP_VERSION
    pm2 start ecosystem.config.cjs --update-env >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
    echo -e "${GREEN}[ROLLBACK] 已恢复上一版本。${NC}"
  else
    echo -e "${YELLOW}[ROLLBACK] 首次安装前没有可恢复版本，已移除失败构建包。${NC}"
  fi
}

verify_running_release() {
  local protocol cert_path key_path health_url health_output attempt
  protocol="http"
  cert_path="${SSL_CERT:-$SSL_DIR/cert.pem}"
  key_path="${SSL_KEY:-$SSL_DIR/key.pem}"
  if [ -f "$cert_path" ] && [ -f "$key_path" ]; then
    protocol="https"
  fi
  health_url="${protocol}://127.0.0.1:${APP_PORT}/api/health"

  for attempt in $(seq 1 15); do
    health_output=$(curl -skf --max-time 5 "$health_url" 2>/dev/null || true)
    if printf '%s' "$health_output" | grep -Fq "\"version\":\"${APP_VERSION}\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

check_root() {
  if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[ERROR] 请使用 root 权限或 sudo 执行此脚本！${NC}"
    exit 1
  fi
}

detect_pkg_manager() {
  if command -v apt-get &> /dev/null; then
    PKG_MANAGER="apt"
  elif command -v dnf &> /dev/null; then
    PKG_MANAGER="dnf"
  elif command -v yum &> /dev/null; then
    PKG_MANAGER="yum"
  else
    echo -e "${RED}[ERROR] 未能识别的包管理器，请确保系统为 Ubuntu/Debian/CentOS/Rocky Linux！${NC}"
    exit 1
  fi
}

pause_if_tty() {
  if [ -t 0 ]; then
    read -r -p "按回车键返回主菜单..." || true
  fi
}

install_base_deps() {
  echo -e "${BLUE}[INFO] 正在检查并补全运行构建包所需的基础依赖...${NC}"
  if [ "$PKG_MANAGER" = "apt" ]; then
    env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get update -y > /dev/null 2>&1 || true
    env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y curl ca-certificates gnupg lsof net-tools socat openssl tar > /dev/null 2>&1
  else
    $PKG_MANAGER update -y > /dev/null 2>&1 || true
    $PKG_MANAGER install -y curl ca-certificates lsof net-tools socat openssl tar > /dev/null 2>&1
  fi
}

install_node_runtime() {
  local setup_script setup_url installed_major
  setup_script=$(mktemp)
  if [ "$PKG_MANAGER" = "apt" ]; then
    setup_url="https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x"
  else
    setup_url="https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x"
  fi

  echo -e "${BLUE}[INFO] 正在下载并执行 NodeSource Node.js ${MIN_NODE_MAJOR} LTS 安装配置...${NC}"
  if ! curl -fsSL --retry 3 --connect-timeout 15 "$setup_url" -o "$setup_script"; then
    rm -f "$setup_script"
    echo -e "${RED}[ERROR] NodeSource 配置脚本下载失败，已停止安装。${NC}"
    return 1
  fi
  if ! env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a bash "$setup_script"; then
    rm -f "$setup_script"
    echo -e "${RED}[ERROR] NodeSource 软件源配置失败，已停止安装。${NC}"
    return 1
  fi
  rm -f "$setup_script"

  if [ "$PKG_MANAGER" = "apt" ]; then
    env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y nodejs > /dev/null 2>&1
  else
    $PKG_MANAGER install -y nodejs > /dev/null 2>&1
  fi
  hash -r

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo -e "${RED}[ERROR] Node.js 安装后未检测到 node 与 npm，已停止安装。${NC}"
    return 1
  fi
  installed_major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
  if ! [[ "$installed_major" =~ ^[0-9]+$ ]] || [ "$installed_major" -lt "$MIN_NODE_MAJOR" ]; then
    echo -e "${RED}[ERROR] Node.js 安装后版本仍低于 ${MIN_NODE_MAJOR}（当前: $(node -v 2>/dev/null || echo 未知)），已停止安装。${NC}"
    return 1
  fi
  echo -e "${GREEN}[OK] Node.js 与 npm 已安装并验证: $(node -v) / npm $(npm -v)${NC}"
}

get_public_ip() {
  SERVER_IP=$(curl -fsS4 --connect-timeout 3 --max-time 5 https://api.ipify.org || curl -fsS4 --connect-timeout 3 --max-time 5 https://ipv4.icanhazip.com || echo "您的服务器公网IP")
}

configure_firewall() {
  load_runtime_config
  echo -e "${BLUE}[INFO] 正在检测并放行系统防火墙端口 (${APP_PORT}, 80)...${NC}"
  
  # 放行 UFW 防火墙 (Ubuntu/Debian)
  if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "active"; then
    echo -e "${YELLOW}[INFO] 检测到 UFW 防火墙已开启，放行 ${APP_PORT}/tcp 及 80/tcp 端口...${NC}"
    ufw allow "${APP_PORT}/tcp" >/dev/null 2>&1 || true
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw reload >/dev/null 2>&1 || true
    echo -e "${GREEN}[OK] UFW 防火墙端口设置成功！${NC}"
  fi

  # 放行 Firewalld 防火墙 (CentOS/RHEL/AlmaLinux)
  if command -v firewall-cmd &>/dev/null && systemctl is-active --quiet firewalld; then
    echo -e "${YELLOW}[INFO] 检测到 Firewalld 防火墙已开启，放行 ${APP_PORT}/tcp 及 80/tcp 端口...${NC}"
    firewall-cmd --zone=public --add-port="${APP_PORT}/tcp" --permanent >/dev/null 2>&1 || true
    firewall-cmd --zone=public --add-port=80/tcp --permanent >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    echo -e "${GREEN}[OK] Firewalld 防火墙端口设置成功！${NC}"
  fi

  # 放行 iptables
  if command -v iptables &>/dev/null; then
    if ! iptables -C INPUT -p tcp --dport "$APP_PORT" -j ACCEPT >/dev/null 2>&1; then
      iptables -I INPUT -p tcp --dport "$APP_PORT" -j ACCEPT >/dev/null 2>&1 || true
    fi
    if ! iptables -C INPUT -p tcp --dport 80 -j ACCEPT >/dev/null 2>&1; then
      iptables -I INPUT -p tcp --dport 80 -j ACCEPT >/dev/null 2>&1 || true
    fi
  fi
}

install_shortcut() {
  local name shortcut_path
  mkdir -p "$SHORTCUT_DIR"
  for name in pa sy; do
    shortcut_path="$SHORTCUT_DIR/$name"
    if [ -e "$shortcut_path" ] || [ -L "$shortcut_path" ]; then
      if ! grep -Fq "$TARGET_DIR/install.sh" "$shortcut_path" 2>/dev/null; then
        echo -e "${RED}[ERROR] $shortcut_path 已被其他程序使用，未覆盖。${NC}"
        return 1
      fi
    fi
  done
  for name in pa sy; do
    shortcut_path="$SHORTCUT_DIR/$name"
    cat <<EOF > "$shortcut_path"
#!/usr/bin/env bash
# PanelArk managed shortcut
if [ -f "$TARGET_DIR/install.sh" ]; then
  exec bash "$TARGET_DIR/install.sh" "\$@"
else
  echo "[ERROR] 部署助手脚本文件未找到，请重新运行一键安装命令！"
  exit 1
fi
EOF
    chmod 755 "$shortcut_path"
  done
  echo -e "${GREEN}[OK] 输入 pa 即可打开管理菜单；旧命令 sy 继续兼容。${NC}"
}

service_status() {
  if [ ! -f "$TARGET_DIR/dist/server.cjs" ]; then echo "未安装"; return; fi
  if ! command -v pm2 >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then echo "运行环境缺失"; return; fi
  pm2 jlist 2>/dev/null | node -e '
    let input=""; process.stdin.on("data", d=>input+=d); process.stdin.on("end",()=>{
      try { const p=JSON.parse(input).find(p=>p.name===process.argv[1]);
        const s=p?.pm2_env?.status; console.log(s==="online"?"运行中":s==="stopped"?"已停止":s||"未启动");
      } catch { console.log("状态读取失败"); }
    });' "$APP_NAME" || echo "状态读取失败"
}

repair_shortcut() {
  require_installation || return 1
  install_shortcut
  pause_if_tty
}

require_installation() {
  if [ ! -f "$TARGET_DIR/dist/server.cjs" ] || [ ! -f "$TARGET_DIR/ecosystem.config.cjs" ]; then
    echo -e "${YELLOW}[INFO] 尚未安装，请先选择首次安装。${NC}"; return 1
  fi
  if ! command -v pm2 >/dev/null 2>&1; then
    echo -e "${RED}[ERROR] PM2 不可用，请检查运行环境；未重复安装应用。${NC}"; return 1
  fi
}

manage_service() {
  local action="$1"
  require_installation || return 1
  cd "$TARGET_DIR"
  load_runtime_config
  case "$action" in
    start) pm2 startOrReload ecosystem.config.cjs --update-env ;;
    stop) pm2 stop "$APP_NAME" ;;
    restart) pm2 startOrReload ecosystem.config.cjs --update-env ;;
  esac
  pm2 save >/dev/null
  if [ "$action" != stop ]; then
    APP_VERSION=$(read_installed_version)
    if ! verify_running_release; then echo -e "${RED}[ERROR] 服务未通过健康检查，请使用 pa logs 排查。${NC}"; return 1; fi
  fi
  echo -e "${GREEN}[OK] 操作完成，当前状态：$(service_status)${NC}"
  pause_if_tty
}

view_logs() {
  require_installation || return 1
  pm2 logs "$APP_NAME" --lines 100 --nostream
  pause_if_tty
}

view_setup_token() {
  require_installation || return 1
  load_runtime_config
  local data_dir="${PANELARK_DATA_DIR:-$TARGET_DIR/data}"
  [[ "$data_dir" = /* ]] || data_dir="$TARGET_DIR/$data_dir"
  if [ -n "${PANELARK_SETUP_TOKEN:-}" ]; then
    echo "安装令牌：$PANELARK_SETUP_TOKEN"
  elif [ -f "$data_dir/admin-setup-token.txt" ]; then
    echo "安装令牌（请勿分享）："; cat "$data_dir/admin-setup-token.txt"
  else
    echo "未找到首次安装令牌；若已经创建管理员，这是安装入口锁定后的正常状态。"
  fi
  pause_if_tty
}

update_assistant() {
  require_installation || return 1
  local manifest_file candidate current comparison
  manifest_file=$(mktemp)
  if ! curl -fsSL --retry 3 --connect-timeout 10 --max-time 60 "${RELEASE_MANIFEST_URL:-${RELEASE_URL%/*}/release-manifest.json}" -o "$manifest_file"; then
    rm -f "$manifest_file"; echo "[ERROR] 无法检查新版本，未下载或安装应用。"; return 1
  fi
  # Verify the small manifest before using its version or pinned package URL.
  if ! candidate=$(node - "$manifest_file" "$TARGET_DIR/release-public-key.pem" <<'NODE'
const fs = require('node:fs'), crypto = require('node:crypto');
try {
  const { signature, ...m } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (m.product !== 'PanelArk' || m.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(m.version) || !crypto.verify(null, Buffer.from(JSON.stringify(m)), fs.readFileSync(process.argv[3]), Buffer.from(signature, 'base64'))) throw Error('签名或版本无效');
  const url = new URL(m.packageUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('更新地址无效');
  console.log(m.version); console.log(m.packageUrl);
} catch (e) { console.error('[ERROR] 更新清单验证失败：' + e.message); process.exit(1); }
NODE
  ); then rm -f "$manifest_file"; return 1; fi
  rm -f "$manifest_file"
  EXPECTED_RELEASE_VERSION=$(printf '%s\n' "$candidate" | head -n1)
  current=$(read_installed_version)
  comparison=$(node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number)); if(a.length!==3||b.length!==3||[...a,...b].some(n=>!Number.isInteger(n)))process.exit(1); console.log(a.reduce((r,n,i)=>r||Math.sign(n-b[i]),0));' "$EXPECTED_RELEASE_VERSION" "$current") || { echo "[ERROR] 当前版本无法识别，未执行更新。"; return 1; }
  if [ "$comparison" -le 0 ]; then
    echo "[OK] 当前 v$current 已是最新或更高版本，不下载、不重复安装、不重启。"
    pause_if_tty; return 0
  fi
  echo "[INFO] 更新 v$current → v$EXPECTED_RELEASE_VERSION；保留配置、业务数据和证书。"
  RELEASE_URL=$(printf '%s\n' "$candidate" | tail -n1)
  RELEASE_CHECKSUM_URL="${RELEASE_URL%/*}/SHA256SUMS"
  INSTALL_MODE=update install_assistant
}

check_environment() {
  load_runtime_config
  echo -e "${CYAN}============================================================${NC}"
  echo -e "${BOLD}            🔍 本系统与 Linux 服务器运行环境检测            ${NC}"
  echo -e "${CYAN}============================================================${NC}"
  
  # 1. 操作系统
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_NAME=$PRETTY_NAME
  else
    OS_NAME=$(uname -s)
  fi
  echo -e "🖥️  ${BOLD}操作系统:${NC} ${GREEN}${OS_NAME}${NC}"
  
  # 2. CPU 与 内存/磁盘
  CPU_ARCH=$(uname -m)
  MEM_TOTAL=$(free -m 2>/dev/null | awk '/Mem:/ {print $2}' || echo "未知")
  MEM_USED=$(free -m 2>/dev/null | awk '/Mem:/ {print $3}' || echo "未知")
  DISK_AVAIL=$(df -h / 2>/dev/null | awk 'NR==2 {print $4}' || echo "未知")
  echo -e "⚙️  ${BOLD}硬件资源:${NC} CPU 架构: ${CPU_ARCH} | 内存使用: ${MEM_USED}MB / ${MEM_TOTAL}MB | 剩余磁盘: ${DISK_AVAIL}"
  
  # 3. 网络 IP
  get_public_ip
  echo -e "🌐 ${BOLD}公网 IPv4:${NC} ${GREEN}${SERVER_IP}${NC}"
  
  # 4. 软件依赖状态
  echo -e "\n${BOLD}📦 核心依赖环境状态:${NC}"
  
  if command -v node &> /dev/null; then
    NODE_VER=$(node -v)
    echo -e "  - Node.js:        ${GREEN}已安装 (${NODE_VER})${NC}"
  else
    echo -e "  - Node.js:        ${RED}未安装${NC}"
  fi

  if command -v pm2 &> /dev/null; then
    echo -e "  - PM2 守护管理:   ${GREEN}已安装${NC}"
  else
    echo -e "  - PM2 守护管理:   ${YELLOW}未安装${NC}"
  fi

  if [ -f "$HOME/.acme.sh/acme.sh" ]; then
    echo -e "  - acme.sh 证书脚本: ${GREEN}已安装${NC}"
  else
    echo -e "  - acme.sh 证书脚本: ${YELLOW}未安装${NC}"
  fi

  # 5. 本系统及端口占用状态
  echo -e "\n${BOLD}🔌 核心服务端口占用检测:${NC}"
  for PORT_NUM in 80 443 "$APP_PORT"; do
    if lsof -i:$PORT_NUM >/dev/null 2>&1 || netstat -tlpn 2>/dev/null | grep -q ":$PORT_NUM "; then
      PROC_NAME=$(lsof -i:$PORT_NUM 2>/dev/null | awk 'NR==2 {print $1}' || echo "已占用")
      echo -e "  - 端口 ${PORT_NUM}: ${RED}被占用 (${PROC_NAME})${NC}"
    else
      echo -e "  - 端口 ${PORT_NUM}: ${GREEN}空闲 (可正常使用)${NC}"
    fi
  done
  
  echo -e "\n${GREEN}[OK] 环境检测完成！${NC}"
  echo "------------------------------------------------------------"
  pause_if_tty
}

install_assistant() {
  if [ -f "$TARGET_DIR/dist/server.cjs" ] && [ "${INSTALL_MODE:-install}" != update ]; then
    echo "[OK] 已安装 v$(read_installed_version)，不会重复安装。需要更新请使用菜单 [11] 或 update 子命令（pa update）。"
    pause_if_tty; return 0
  fi
  if ! command -v flock >/dev/null 2>&1; then echo "[ERROR] 缺少 util-linux/flock，无法安全锁定安装任务。"; return 1; fi
  exec 9>"$INSTALL_LOCK_FILE"
  if ! flock -n 9; then echo "[ERROR] 另一安装/更新任务正在执行，请勿重复运行。"; return 1; fi
  if [ -f "$TARGET_DIR/dist/server.cjs" ]; then
    if [ "${INSTALL_MODE:-install}" != update ] || [ "$(read_installed_version)" = "${EXPECTED_RELEASE_VERSION:-}" ]; then
      echo "[OK] 当前版本已安装，跳过重复操作。"; return 0
    fi
  fi
  echo -e "${CYAN}============================================================${NC}"
  echo -e "${BOLD}             🚀 安装 / 更新 PanelArk 面板方舟             ${NC}"
  echo -e "${CYAN}============================================================${NC}"

  detect_pkg_manager
  echo -e "${BLUE}[1/5] 检查并补全系统必要依赖...${NC}"
  install_base_deps

  echo -e "${BLUE}[2/5] 下载 GitHub Actions 生成的最新生产构建包...${NC}"
  download_release_package || {
    pause_if_tty
    return 1
  }
  APP_VERSION=$(tr -d '[:space:]' < "$DOWNLOADED_PACKAGE_DIR/VERSION")
  if [ -n "${EXPECTED_RELEASE_VERSION:-}" ] && [ "$APP_VERSION" != "$EXPECTED_RELEASE_VERSION" ]; then
    rm -rf "$DOWNLOADED_WORK_DIR"; echo "[ERROR] 下载版本与已验证清单不一致，未安装。"; return 1
  fi
  if [ -z "$APP_VERSION" ]; then
    rm -rf "$DOWNLOADED_WORK_DIR"
    echo -e "${RED}[ERROR] 构建包没有有效版本号，已停止安装。${NC}"
    pause_if_tty
    return 1
  fi
  echo -e "${GREEN}[VERSION] 本次将部署构建包版本: v${APP_VERSION}${NC}"

  echo -e "${BLUE}[3/5] 检查并补全 Node.js 运行环境...${NC}"
  NEED_NODE_INSTALL=false
  if ! command -v node &> /dev/null; then
    NEED_NODE_INSTALL=true
    echo -e "${YELLOW}[INFO] 未检测到 Node.js 环境，准备自动安装 Node.js ${MIN_NODE_MAJOR} LTS...${NC}"
  else
    NODE_MAJOR_VER=$(node -v | cut -d'.' -f1 | sed 's/v//')
    if [ "$NODE_MAJOR_VER" -lt "$MIN_NODE_MAJOR" ] || ! command -v npm >/dev/null 2>&1; then
      NEED_NODE_INSTALL=true
      echo -e "${YELLOW}[WARN] 当前 Node.js/npm 环境不符合要求，准备自动升级至 Node.js ${MIN_NODE_MAJOR} LTS...${NC}"
    else
      echo -e "${GREEN}[OK] Node.js 环境正常: $(node -v)${NC}"
    fi
  fi

  if [ "$NEED_NODE_INSTALL" = true ]; then
    if ! install_node_runtime; then
      rm -rf "$DOWNLOADED_WORK_DIR"
      pause_if_tty
      return 1
    fi
  fi

  echo -e "${BLUE}[4/5] 安装生产运行依赖并切换到新构建包...${NC}"
  cd "$DOWNLOADED_PACKAGE_DIR"
  if ! npm ci --omit=dev --ignore-scripts; then
    rm -rf "$DOWNLOADED_WORK_DIR"
    echo -e "${RED}[ERROR] 生产运行依赖安装失败，旧版本未被替换。${NC}"
    pause_if_tty
    return 1
  fi

  if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}正在全局安装 PM2 进程管理器...${NC}"
    npm install -g pm2 > /dev/null 2>&1
  fi

  if [ -f "$TARGET_DIR/.env" ]; then
    cp -p "$TARGET_DIR/.env" "$DOWNLOADED_PACKAGE_DIR/.env"
    echo -e "${GREEN}[OK] 已保留现有 .env 配置。${NC}"
  else
    cp "$DOWNLOADED_PACKAGE_DIR/.env.example" "$DOWNLOADED_PACKAGE_DIR/.env"
    chmod 600 "$DOWNLOADED_PACKAGE_DIR/.env"
    echo -e "${GREEN}[OK] 已创建 .env 配置文件。${NC}"
  fi

  # PanelArk business data must live outside the replaceable release directory.
  # Older installations are migrated once from TARGET_DIR/data.
  existing_panelark_data_dir=$(sed -n 's/^PANELARK_DATA_DIR=//p' "$DOWNLOADED_PACKAGE_DIR/.env" | tail -n1)
  if [ -z "$existing_panelark_data_dir" ]; then
    if grep -q '^PANELARK_DATA_DIR=' "$DOWNLOADED_PACKAGE_DIR/.env"; then
      sed -i "s|^PANELARK_DATA_DIR=.*|PANELARK_DATA_DIR=${PANELARK_STATE_DIR}|" "$DOWNLOADED_PACKAGE_DIR/.env"
    else
      printf '\nPANELARK_DATA_DIR=%s\n' "$PANELARK_STATE_DIR" >> "$DOWNLOADED_PACKAGE_DIR/.env"
    fi
    existing_panelark_data_dir="$PANELARK_STATE_DIR"
  fi
  if [ "$existing_panelark_data_dir" = "$PANELARK_STATE_DIR" ]; then
    mkdir -p "$PANELARK_STATE_DIR"
    chmod 700 "$PANELARK_STATE_DIR"
    if [ -d "$TARGET_DIR/data" ]; then
      cp -a "$TARGET_DIR/data/." "$PANELARK_STATE_DIR/"
      echo -e "${GREEN}[OK] PanelArk 数据已迁移并保留在 ${PANELARK_STATE_DIR}。${NC}"
    fi
  else
    echo -e "${GREEN}[OK] 已保留自定义 PanelArk 数据目录: ${existing_panelark_data_dir}${NC}"
  fi

  BACKUP_DIR="${TARGET_DIR}.previous"
  rm -rf "$BACKUP_DIR"
  if [ -d "$TARGET_DIR" ]; then
    mv "$TARGET_DIR" "$BACKUP_DIR"
  fi
  mkdir -p "$(dirname "$TARGET_DIR")"
  mv "$DOWNLOADED_PACKAGE_DIR" "$TARGET_DIR"
  rm -rf "$DOWNLOADED_WORK_DIR"

  ACTIVE_PROJECT_DIR="$TARGET_DIR"
  cd "$ACTIVE_PROJECT_DIR"
  load_runtime_config
  APP_VERSION=$(read_installed_version)
  export APP_VERSION

  # 更新只替换应用构建包；.env、独立数据目录与 /etc 下的 SSL 证书保持不变。
  if pm2 list 2>/dev/null | grep -q "$APP_NAME"; then
    echo -e "${YELLOW}检测到 PanelArk 正在运行，正在重启服务...${NC}"
    if ! pm2 startOrReload ecosystem.config.cjs --update-env; then
      echo -e "${RED}[ERROR] 新构建包启动失败。${NC}"
      restore_previous_release
      pause_if_tty
      return 1
    fi
  else
    echo -e "${GREEN}正在启动 PM2 服务进程 (端口: ${APP_PORT})...${NC}"
    if ! pm2 start ecosystem.config.cjs; then
      echo -e "${RED}[ERROR] 新构建包启动失败。${NC}"
      restore_previous_release
      pause_if_tty
      return 1
    fi
  fi

  echo -e "${BLUE}[INFO] 正在验证新构建包健康状态和运行版本...${NC}"
  if ! verify_running_release; then
    echo -e "${RED}[ERROR] 新构建包未能通过健康检查或运行版本不一致。${NC}"
    restore_previous_release
    pause_if_tty
    return 1
  fi
  echo -e "${GREEN}[OK] 运行健康检查通过，当前版本为 v${APP_VERSION}。${NC}"

  if command -v systemctl &>/dev/null; then
    pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
  fi
  pm2 save > /dev/null 2>&1 || true
  rm -rf "$BACKUP_DIR"

  echo -e "${BLUE}[5/5] 配置系统防火墙放行与快捷调出命令...${NC}"
  configure_firewall
  install_shortcut

  get_public_ip

  echo -e "${GREEN}\n============================================================"
  echo " 🎉 PanelArk 面板方舟已成功安装/更新并在后台稳定运行！"
  echo "============================================================"
  echo -e "${NC}"

  echo -e "⚡ ${BOLD}快捷调出菜单命令:${NC} 输入 ${GREEN}${BOLD}pa${NC} 即可随时打开控制菜单（兼容 sy）"
  echo -e "📦 ${BOLD}当前部署版本:${NC} ${GREEN}v${APP_VERSION}${NC}"

  if [ -f "$SSL_DIR/cert.pem" ] && [ -f "$SSL_DIR/key.pem" ]; then
    echo -e "🔒 访问协议: ${GREEN}HTTPS (已应用 SSL 安全加密防护)${NC}"
    echo -e "🌐 面板访问地址: ${CYAN}https://${SERVER_IP}:${APP_PORT}${NC}"
  else
    echo -e "🔓 访问协议: ${YELLOW}HTTP (未配置 SSL 证书)${NC}"
    echo -e "🌐 面板访问地址: ${CYAN}http://${SERVER_IP}:${APP_PORT}${NC}"
    echo -e "💡 提示: 您可在菜单选择 [2] 为本面板申请域名 SSL 证书并开启 HTTPS 访问。"
  fi

  echo -e "\n${YELLOW}⚠️ 【重要】如果安装完成后浏览器无法打开页面，请检查：${NC}"
  echo -e "  1. ${BOLD}云厂商安全组/防火墙${NC}: 请登录阿里云/腾讯云/AWS/甲骨文云后台，在【安全组入站规则】中放行 ${YELLOW}${APP_PORT}${NC} 及 ${YELLOW}80${NC} 端口(TCP)！"
  echo -e "  2. ${BOLD}VPS 系统防火墙${NC}: 脚本已自动尝试放行 ufw / firewalld / iptables。如仍受阻，可尝试运行: ${CYAN}ufw allow ${APP_PORT}/tcp${NC}"
  echo -e "  3. ${BOLD}查看服务状态${NC}: 随时输入 ${CYAN}pa${NC} 选择 [3] 查看信息，或运行 ${CYAN}pm2 status${NC} 查看运行状态。"
  echo "============================================================"
  pause_if_tty
}

issue_ssl_cert() {
  load_runtime_config
  echo -e "${CYAN}============================================================${NC}"
  echo -e "${BOLD}     🔒 申请 Let's Encrypt 域名 SSL 证书并应用推送到本面板     ${NC}"
  echo -e "${CYAN}============================================================${NC}"
  
  get_public_ip
  echo -e "📍 当前 VPS 公网 IP: ${GREEN}${SERVER_IP}${NC}\n"
  
  read -p "请输入已正确解析到当前 IP (${SERVER_IP}) 的域名: " DOMAIN_NAME
  if [ -z "$DOMAIN_NAME" ]; then
    echo -e "${RED}[ERROR] 域名不能为空！${NC}"
    pause_if_tty
    return 1
  fi

  read -p "请输入联系邮箱 (留空自动使用 admin@$DOMAIN_NAME): " EMAIL_ADDR
  if [ -z "$EMAIL_ADDR" ]; then
    EMAIL_ADDR="admin@$DOMAIN_NAME"
  fi

  # 1. 检查并安装 acme.sh
  if [ ! -f "$HOME/.acme.sh/acme.sh" ]; then
    echo -e "\n${BLUE}[1/4] 正在安装 acme.sh 自动化证书脚本...${NC}"
    curl https://get.acme.sh | sh -s email="$EMAIL_ADDR" > /dev/null 2>&1
    source "$HOME/.bashrc" >/dev/null 2>&1 || true
  fi

  ACME_BIN="$HOME/.acme.sh/acme.sh"
  if [ ! -f "$ACME_BIN" ]; then
    echo -e "${RED}[ERROR] acme.sh 安装失败，请检查网络通信！${NC}"
    pause_if_tty
    return 1
  fi

  # 设置默认证书商为 Let's Encrypt
  "$ACME_BIN" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true

  # 2. 80 端口无缝借用与自动恢复逻辑
  echo -e "\n${BLUE}[2/4] 检测 80 端口占用状态 (借用 80 端口进行 HTTP 独立验证)...${NC}"
  STOPPED_SERVICE=""

  if lsof -i:80 >/dev/null 2>&1 || netstat -tlpn 2>/dev/null | grep -q ":80 "; then
    OCCUPIED_PROC=$(lsof -i:80 2>/dev/null | awk 'NR==2 {print $1}' || echo "")
    if [ -n "$OCCUPIED_PROC" ]; then
      echo -e "${YELLOW}[INFO] 检测到 80 端口当前被服务 '${OCCUPIED_PROC}' 占用。${NC}"
      echo -e "${YELLOW}[INFO] 正在临时暂停该服务以借用 80 端口申请证书...${NC}"
      
      if systemctl is-active --quiet "$OCCUPIED_PROC"; then
        systemctl stop "$OCCUPIED_PROC"
        STOPPED_SERVICE="$OCCUPIED_PROC"
      elif command -v nginx &>/dev/null && systemctl is-active --quiet nginx; then
        systemctl stop nginx
        STOPPED_SERVICE="nginx"
      elif command -v apache2 &>/dev/null && systemctl is-active --quiet apache2; then
        systemctl stop apache2
        STOPPED_SERVICE="apache2"
      elif command -v httpd &>/dev/null && systemctl is-active --quiet httpd; then
        systemctl stop httpd
        STOPPED_SERVICE="httpd"
      fi
    fi
  fi

  # 清理/恢复机制函数
  restore_service() {
    if [ -n "$STOPPED_SERVICE" ]; then
      echo -e "${YELLOW}[INFO] 证书申请流程结束，正在重启被借用 80 端口的服务 (${STOPPED_SERVICE})...${NC}"
      systemctl start "$STOPPED_SERVICE" || true
      echo -e "${GREEN}[OK] 80 端口已完全释放并成功恢复原服务正常运行！${NC}"
    fi
  }

  # 3. 申请证书
  echo -e "\n${BLUE}[3/4] 正在向 Let's Encrypt 发起 80 端口 HTTP-01 验证申请 (${DOMAIN_NAME})...${NC}"
  
  mkdir -p "$SSL_DIR"

  set +e
  "$ACME_BIN" --issue -d "$DOMAIN_NAME" --standalone --httpport 80
  ACME_EXIT_CODE=$?
  set -e

  # 无论成功或失败，立即恢复 80 端口的服务！
  restore_service

  if [ $ACME_EXIT_CODE -ne 0 ]; then
    echo -e "${RED}\n[ERROR] SSL 证书申请失败！请确认以下事项：${NC}"
    echo -e "${RED}  1. 域名 ${DOMAIN_NAME} 是否已被 DNS 解析并指向当前 IP (${SERVER_IP})！${NC}"
    echo -e "${RED}  2. 云服务商防火墙/安全组是否放行了 80 端口入口流量！${NC}"
    pause_if_tty
    return 1
  fi

  # 4. 安装/导出证书并推送到本系统
  echo -e "\n${BLUE}[4/4] 正在安装证书文件并应用到 PanelArk...${NC}"
  "$ACME_BIN" --install-cert -d "$DOMAIN_NAME" \
    --key-file "$SSL_DIR/key.pem" \
    --fullchain-file "$SSL_DIR/cert.pem" \
    --reloadcmd "pm2 restart $APP_NAME >/dev/null 2>&1" >/dev/null 2>&1
  chmod 600 "$SSL_DIR/key.pem"
  chmod 644 "$SSL_DIR/cert.pem"

  echo -e "${GREEN}[SUCCESS] 证书申请成功并已保存至: ${SSL_DIR}/${NC}"

  # 自动重启 PM2 部署助手，使得 server.ts 自动加载 HTTPS 证书
  if pm2 list 2>/dev/null | grep -q "$APP_NAME"; then
    echo -e "${BLUE}[INFO] 正在重启 PanelArk PM2 进程以平滑升级至 HTTPS...${NC}"
    pm2 restart "$APP_NAME" --update-env
    echo -e "${GREEN}[SUCCESS] 本面板已完成 HTTPS 证书配置与应用更新！${NC}"
  fi

  echo -e "\n${GREEN}============================================================"
  echo -e " 🎉 SSL 证书已成功安装并应用到 PanelArk！"
  echo -e "============================================================"
  echo -e "🔒 绑定域名: ${CYAN}${DOMAIN_NAME}${NC}"
  echo -e "🌐 安全访问地址: ${CYAN}https://${DOMAIN_NAME}:${APP_PORT}${NC}"
  echo -e "📄 证书路径:   ${SSL_DIR}/cert.pem"
  echo -e "🔑 密钥路径:   ${SSL_DIR}/key.pem"
  echo "============================================================"

  pause_if_tty
}

view_panel_info() {
  load_runtime_config
  echo -e "${CYAN}============================================================${NC}"
  echo -e "${BOLD}              📊 当前 PanelArk 与 SSL 运行状态              ${NC}"
  echo -e "${CYAN}============================================================${NC}"

  get_public_ip
  echo -e "🌐 ${BOLD}服务器公网 IP:${NC} ${GREEN}${SERVER_IP}${NC}"
  APP_VERSION=$(read_installed_version)
  echo -e "📦 ${BOLD}当前构建包版本:${NC} ${GREEN}v${APP_VERSION}${NC}"

  # 1. Read only this application's PM2 state, not the first unrelated process.
  echo -e "\n${BOLD}1️⃣  PanelArk PM2 服务状态:${NC}"
  if [ -f "$TARGET_DIR/dist/server.cjs" ]; then
    PM2_STATUS=$(service_status)
    echo -e "   - 进程名称: ${CYAN}${APP_NAME}${NC}"
    echo -e "   - 运行状态: ${GREEN}${PM2_STATUS}${NC}"
    echo -e "   - 监听端口: ${CYAN}${APP_PORT}${NC}"
    echo -e "   - 快捷调出指令: ${GREEN}pa${NC}（兼容 sy）"
  else
    echo -e "   - 运行状态: ${RED}未启动或未安装${NC}"
  fi

  # 2. SSL 证书与访问协议信息
  echo -e "\n${BOLD}2️⃣  SSL 安全证书与面板访问入口:${NC}"
  if [ -f "$SSL_DIR/cert.pem" ] && [ -f "$SSL_DIR/key.pem" ]; then
    DOMAIN_IN_CERT=$(openssl x509 -subject -noout -in "$SSL_DIR/cert.pem" 2>/dev/null | sed -n 's/.*CN = \([^,]*\).*/\1/p' || echo "未知")
    EXPIRE_DATE=$(openssl x509 -enddate -noout -in "$SSL_DIR/cert.pem" 2>/dev/null | cut -d= -f2 || echo "未知")
    
    echo -e "   - 证书状态: ${GREEN}已配置生效 (HTTPS 访问模式)${NC}"
    echo -e "   - 绑定域名: ${CYAN}${DOMAIN_IN_CERT}${NC}"
    echo -e "   - 证书到期: ${CYAN}${EXPIRE_DATE}${NC}"
    echo -e "   - 域名 HTTPS 链接: ${GREEN}https://${DOMAIN_IN_CERT}:${APP_PORT}${NC}"
    echo -e "   - IP   HTTPS 链接: ${GREEN}https://${SERVER_IP}:${APP_PORT}${NC}"
  else
    echo -e "   - 证书状态: ${YELLOW}未配置 SSL 证书 (当前为 HTTP 访问模式)${NC}"
    echo -e "   - IP   HTTP  链接: ${CYAN}http://${SERVER_IP}:${APP_PORT}${NC}"
  fi

  echo -e "\n${CYAN}============================================================${NC}"
  pause_if_tty
}

uninstall_all() {
  echo -e "${RED}============================================================${NC}"
  echo -e "${BOLD}                 ⚠️  卸载与彻底清除本面板项目                 ${NC}"
  echo -e "${RED}============================================================${NC}"
  
  echo -e "${YELLOW}此操作将停止 PM2 守护进程，并删除一键安装在 ${TARGET_DIR} 的项目与快捷命令。${NC}"
  if [ "$SCRIPT_DIR" != "$TARGET_DIR" ]; then
    echo -e "${YELLOW}当前脚本位于 ${SCRIPT_DIR}，该本地源码目录不会被删除。${NC}"
  fi
  read -p "确认要继续卸载本面板吗？[y/N]: " CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo -e "${GREEN}已取消卸载操作。${NC}"
    pause_if_tty
    return
  fi

  echo -e "\n${BLUE}[1/3] 停止并删除 PM2 面板守护进程...${NC}"
  if command -v pm2 &>/dev/null; then
    pm2 stop "$APP_NAME" >/dev/null 2>&1 || true
    pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
  fi

  echo -e "${BLUE}[2/3] 清理 PanelArk 项目目录 (${TARGET_DIR}) 及快捷调出指令...${NC}"
  rm -rf "$TARGET_DIR"
  for shortcut in /usr/local/bin/pa /usr/local/bin/sy /usr/bin/sy; do
    if grep -Fq "$TARGET_DIR/install.sh" "$shortcut" 2>/dev/null; then rm -f "$shortcut"; fi
  done

  read -p "是否同时删除保存的 SSL 证书文件 (${SSL_DIR})？[y/N]: " REMOVE_SSL
  if [[ "$REMOVE_SSL" == "y" || "$REMOVE_SSL" == "Y" ]]; then
    echo -e "${BLUE}[3/3] 正在删除面板 SSL 证书与配置...${NC}"
    rm -rf "/etc/3xui-assistant"
    echo -e "${GREEN}[OK] 面板 SSL 证书文件已完全清理！${NC}"
  fi

  echo -e "${GREEN}\nPanelArk 程序与本项目快捷命令已卸载；业务数据未删除，请保留或自行备份 ${PANELARK_STATE_DIR} 及自定义数据目录。${NC}\n"
  exit 0
}

diagnose_domain_access() {
  load_runtime_config
  echo -e "${CYAN}============================================================${NC}"
  echo -e "${BOLD}         🔍 域名访问失败一键诊断与问题排除工具          ${NC}"
  echo -e "${CYAN}============================================================${NC}"

  get_public_ip
  echo -e "📍 当前 VPS 本机公网 IP: ${GREEN}${SERVER_IP}${NC}\n"

  read -p "请输入您无法访问的域名 (例: node.yourdomain.com): " DOMAIN_NAME
  if [ -z "$DOMAIN_NAME" ]; then
    echo -e "${RED}[ERROR] 域名不能为空！${NC}"
    pause_if_tty
    return 1
  fi

  echo -e "\n${BLUE}[1/4] 正在查询域名 DNS 解析记录 (A记录)...${NC}"
  
  # 优先使用 ping/nslookup/dig 或 python/curl 提取 DNS 解析 IP
  RESOLVED_IP=""
  if command -v getent &>/dev/null; then
    RESOLVED_IP=$(getent ahosts "$DOMAIN_NAME" 2>/dev/null | awk '{print $1}' | head -n1)
  fi
  if [ -z "$RESOLVED_IP" ] && command -v ping &>/dev/null; then
    RESOLVED_IP=$(ping -c 1 "$DOMAIN_NAME" 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || echo "")
  fi
  if [ -z "$RESOLVED_IP" ]; then
    RESOLVED_IP=$(curl -s --connect-timeout 5 "https://1.1.1.1/dns-query?name=${DOMAIN_NAME}&type=A" -H "accept: application/dns-json" 2>/dev/null | grep -oE '"data":"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"' | cut -d'"' -f4 | head -n1 || echo "")
  fi

  if [ -z "$RESOLVED_IP" ]; then
    echo -e "${RED}❌ [诊断结果] 域名 DNS 查询失败！未能获取 ${DOMAIN_NAME} 的 IP 解析记录。${NC}"
    echo -e "${YELLOW}👉 解决办法:${NC}"
    echo -e "   1. 请登录您的域名提供商 (Cloudflare / 阿里云 / 腾讯云 / Namecheap)。"
    echo -e "   2. 添加一条 ${BOLD}A 记录${NC}: 主机记录填写子域或@，记录值填您的 VPS IP: ${GREEN}${SERVER_IP}${NC}。"
    echo -e "   3. DNS 解析生效可能需要 1~5 分钟，请稍后再试。"
    pause_if_tty
    return 1
  fi

  echo -e "   - 域名 ${DOMAIN_NAME} 解析到的 IP 为: ${CYAN}${RESOLVED_IP}${NC}"

  if [ "$RESOLVED_IP" != "$SERVER_IP" ]; then
    echo -e "${RED}\n❌ [诊断结果] 域名解析 IP 与当前 VPS 本机 IP 不匹配！${NC}"
    echo -e "${RED}   解析出的 IP: ${RESOLVED_IP}${NC}"
    echo -e "${GREEN}   本机真实 IP: ${SERVER_IP}${NC}"
    echo -e "${YELLOW}👉 常见原因与解决办法:${NC}"
    echo -e "   原因 A: 您的 A 记录填错成了其他 IP。请修改 A 记录指向 ${GREEN}${SERVER_IP}${NC}。"
    echo -e "   原因 B: 您在 Cloudflare 开启了【小黄云 CDN 代理】！"
    echo -e "          ⚠️  Cloudflare 默认不代理 ${APP_PORT} 等多数非标准端口的 HTTP/HTTPS 流量！"
    echo -e "          👉 请登录 Cloudflare，将 DNS 记录的【Proxy status (代理状态)】改为【DNS only (仅 DNS/灰色云朵)】！"
  else
    echo -e "${GREEN}✅ [诊断通过] 域名 DNS 已正确指向当前 VPS 本机 IP (${SERVER_IP})！${NC}"
  fi

  echo -e "\n${BLUE}[2/4] 检查面板 SSL 证书配置状态...${NC}"
  SSL_CONFIGURED=false
  if [ -f "$SSL_DIR/cert.pem" ] && [ -f "$SSL_DIR/key.pem" ]; then
    SSL_CONFIGURED=true
    echo -e "${GREEN}✅ 已开启 SSL 安全加密证书 (HTTPS 模式)${NC}"
  else
    echo -e "${YELLOW}⚠️  未配置 SSL 证书 (HTTP 模式)${NC}"
  fi

  echo -e "\n${BLUE}[3/4] 诊断正确的浏览器访问链接格式...${NC}"
  echo -e "${YELLOW}⚠️ 【极度重要】域名访问时必须加上端口号 :${APP_PORT} 格式！${NC}"
  
  if [ "$SSL_CONFIGURED" = true ]; then
    echo -e "📌 您应该在浏览器输入的完整正确链接为:"
    echo -e "   👉 ${GREEN}${BOLD}https://${DOMAIN_NAME}:${APP_PORT}${NC}"
    echo -e "\n🚫 常见错误输错方式:"
    echo -e "   ❌ http://${DOMAIN_NAME}:${APP_PORT} (错在使用了 http 而非 https)"
    echo -e "   ❌ https://${DOMAIN_NAME} (错在漏掉了端口号 :${APP_PORT})"
  else
    echo -e "📌 您应该在浏览器输入的完整正确链接为:"
    echo -e "   👉 ${GREEN}${BOLD}http://${DOMAIN_NAME}:${APP_PORT}${NC}"
    echo -e "\n🚫 常见错误输错方式:"
    echo -e "   ❌ https://${DOMAIN_NAME}:${APP_PORT} (错在使用了 https 协议但系统未配置 SSL)"
    echo -e "   ❌ http://${DOMAIN_NAME} (错在漏掉了端口号 :${APP_PORT})"
  fi

  echo -e "\n${BLUE}[4/4] 检查云服务器安全组/防火墙 ${APP_PORT} 端口...${NC}"
  echo -e "如果按照上述【正确链接】依然无法打开，通常是云厂商控制台安全组未放行 ${APP_PORT} 端口。"
  echo -e "👉 请登录阿里云/腾讯云/AWS/甲骨文云控制台，在【安全组入站规则】添加 TCP: ${APP_PORT} 放行规则！"

  echo -e "\n${CYAN}============================================================${NC}"
  pause_if_tty
}

run_menu_action() {
  local result
  # An action failure must stop that action without terminating the menu.
  set +e
  ( set -e; "$@" )
  result=$?
  set -e
  if [ "$result" -ne 0 ]; then
    echo -e "${RED}[ERROR] 操作未完成（退出码 $result），请检查上方错误；可以返回菜单重试。${NC}"
    pause_if_tty
  fi
  return 0
}

show_menu() {
  local CHOICE
  while true; do
    if [ -t 1 ] && [ -n "${TERM:-}" ]; then clear || true; fi
    echo -e "${CYAN}"
    echo "============================================================"
    echo "          🚀 PanelArk 面板方舟一键管理工具          "
    echo "============================================================"
    echo -e "${NC}"
    echo -e " 版本：$(read_installed_version)  |  状态：$(service_status)  |  快捷命令：pa"
    echo "------------------------------------------------------------"
    echo -e " ${BOLD}[1]${NC} 首次安装 PanelArk（已安装则跳过）"
    echo -e " ${BOLD}[2]${NC} 仅申请域名 SSL 证书并推送到面板 (不安装或更新应用)"
    echo -e " ${BOLD}[3]${NC} 查看当前面板配置与运行状态信息"
    echo -e " ${BOLD}[4]${NC} 检测 VPS 系统与网络运行环境"
    echo -e " ${BOLD}[5]${NC} 🔍 一键诊断与解决【域名无法访问】问题"
    echo -e " ${BOLD}[6]${NC} 卸载与清除 PanelArk 项目"
    echo -e " ${BOLD}[7]${NC} 启动服务"
    echo -e " ${BOLD}[8]${NC} 停止服务"
    echo -e " ${BOLD}[9]${NC} 重启服务"
    echo -e " ${BOLD}[10]${NC} 查看最近 100 行运行日志"
    echo -e " ${BOLD}[11]${NC} 检查并更新版本（相同版本不重复安装）"
    echo -e " ${BOLD}[12]${NC} 查看首次网页安装令牌（敏感信息）"
    echo -e " ${BOLD}[13]${NC} 修复 pa / sy 快捷命令"
    echo -e " ${BOLD}[0]${NC} 退出脚本"
    echo "============================================================"
    
    if ! read -r -p "请输入菜单功能编号 [0-13]: " CHOICE; then echo; return 0; fi
    case "$CHOICE" in
      1) run_menu_action install_assistant ;;
      2) run_menu_action issue_ssl_cert ;;
      3) run_menu_action view_panel_info ;;
      4) run_menu_action check_environment ;;
      5) run_menu_action diagnose_domain_access ;;
      6) uninstall_all ;;
      7) run_menu_action manage_service start ;;
      8) run_menu_action manage_service stop ;;
      9) run_menu_action manage_service restart ;;
      10) run_menu_action view_logs ;;
      11) run_menu_action update_assistant ;;
      12) run_menu_action view_setup_token ;;
      13) run_menu_action repair_shortcut ;;
      0) echo -e "${GREEN}感谢使用！退出管理脚本。${NC}"; exit 0 ;;
      *) echo -e "${RED}输入无效，请输入 0-13 之间的编号！${NC}"; sleep 1 ;;
    esac
  done
}

main() {
  check_root
  case "${1:-menu}" in
    menu)
      if [ -t 0 ]; then show_menu
      elif { true </dev/tty; } 2>/dev/null; then show_menu </dev/tty
      else echo "[ERROR] pa 菜单需要交互终端；自动化请明确使用 pa install / update / status 等子命令。"; return 1
      fi
      ;;
    install|deploy)
      install_assistant
      ;;
    update|upgrade)
      update_assistant
      ;;
    start|stop|restart) manage_service "$1" ;;
    logs|log) view_logs ;;
    token) view_setup_token ;;
    shortcut) repair_shortcut ;;
    cert|ssl)
      issue_ssl_cert
      ;;
    status|info)
      view_panel_info
      ;;
    env|check)
      check_environment
      ;;
    uninstall|clean)
      uninstall_all
      ;;
    *)
      echo "用法：pa [menu|install|update|start|stop|restart|status|logs|token|env|cert|uninstall|shortcut]"
      return 1
      ;;
  esac
}

# Sourcing is used only by shell regression tests; it must not install anything.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
