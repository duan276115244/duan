#!/bin/bash
# ============================================================
#  段先生 AI Agent 跨平台安装脚本 v15.0
#  支持: Ubuntu/Debian, CentOS/RHEL, macOS, WSL
#  用法:
#    ./install.sh            # 安装
#    ./install.sh uninstall  # 卸载
#    ./install.sh update     # 更新
# ============================================================

set -e

# ============ 颜色定义 ============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ============ 辅助函数 ============
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

separator() {
  echo -e "${CYAN}=========================================${NC}"
}

# ============ 系统检测 ============
detect_os() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    OS="macos"
  elif grep -qi microsoft /proc/version 2>/dev/null; then
    OS="wsl"
  elif [[ -f /etc/debian_version ]]; then
    OS="debian"
  elif [[ -f /etc/redhat-release ]]; then
    OS="rhel"
  elif [[ -f /etc/centos-release ]]; then
    OS="rhel"
  else
    OS="unknown"
  fi
  echo -e "${BOLD}检测到系统: ${CYAN}$OS${NC}"
}

# ============ 检查 Node.js ============
check_node() {
  if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [[ "$NODE_VERSION" -ge 18 ]]; then
      success "Node.js $(node -v) 已安装"
      return 0
    else
      warn "Node.js 版本过低 ($(node -v))，需要 >= 18"
      return 1
    fi
  else
    warn "未检测到 Node.js"
    return 1
  fi
}

# ============ 通过 nvm 安装 Node.js ============
install_node_via_nvm() {
  info "通过 nvm 安装 Node.js 20..."

  # 安装 nvm
  if [[ ! -d "$HOME/.nvm" ]]; then
    info "安装 nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi

  # 加载 nvm
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

  # 安装 Node.js 20
  nvm install 20
  nvm use 20
  nvm alias default 20

  success "Node.js $(node -v) 安装完成"
}

# ============ 检查 Git ============
check_git() {
  if command -v git &>/dev/null; then
    success "Git $(git --version | awk '{print $3}') 已安装"
  else
    warn "未检测到 Git，正在安装..."
    case "$OS" in
      debian|wsl)
        sudo apt-get update -qq && sudo apt-get install -y -qq git
        ;;
      rhel)
        sudo yum install -y git
        ;;
      macos)
        xcode-select --install 2>/dev/null || true
        ;;
      *)
        warn "无法自动安装 Git，请手动安装后重试"
        ;;
    esac
  fi
}

# ============ 安装系统依赖 ============
install_system_deps() {
  info "检查系统依赖..."
  case "$OS" in
    debian|wsl)
      sudo apt-get update -qq
      sudo apt-get install -y -qq curl wget git build-essential python3 2>/dev/null || true
      ;;
    rhel)
      sudo yum install -y curl wget git gcc-c++ make python3 2>/dev/null || true
      ;;
    macos)
      if ! command -v brew &>/dev/null; then
        warn "未检测到 Homebrew，跳过系统依赖安装"
      else
        brew install curl wget python3 2>/dev/null || true
      fi
      ;;
  esac
  success "系统依赖检查完成"
}

# ============ 交互式配置向导 ============
configure_api_keys() {
  echo ""
  separator
  echo -e "${BOLD}${CYAN}  API Key 配置向导${NC}"
  separator
  echo ""

  # 如果 .env 不存在，从模板创建
  if [[ ! -f .env ]]; then
    cp .env.example .env
    info "已从模板创建 .env 文件"
  fi

  # 提示用户配置
  echo -e "请选择要配置的 AI 提供商（可多选，用空格分隔）:"
  echo ""
  echo -e "  ${GREEN}1)${NC} DeepSeek      ${YELLOW}(推荐，性价比最高)${NC}"
  echo -e "  ${GREEN}2)${NC} OpenAI         (GPT-4o)"
  echo -e "  ${GREEN}3)${NC} Anthropic      (Claude)"
  echo -e "  ${GREEN}4)${NC} Google         (Gemini)"
  echo -e "  ${GREEN}5)${NC} OpenRouter     (聚合200+模型)"
  echo -e "  ${GREEN}6)${NC} 阿里通义千问    (Qwen)"
  echo -e "  ${GREEN}7)${NC} 智谱           (GLM-4)"
  echo -e "  ${GREEN}8)${NC} Moonshot       (月之暗面)"
  echo -e "  ${GREEN}9)${NC} 字节豆包        (Doubao)"
  echo -e "  ${GREEN}10)${NC} SiliconFlow   (硅基流动)"
  echo -e "  ${GREEN}11)${NC} MiniMax"
  echo -e "  ${GREEN}12)${NC} Groq          (极速免费)"
  echo -e "  ${GREEN}13)${NC} Together AI"
  echo -e "  ${GREEN}14)${NC} Fireworks"
  echo -e "  ${GREEN}15)${NC} Perplexity"
  echo -e "  ${GREEN}16)${NC} xAI           (Grok)"
  echo -e "  ${GREEN}0)${NC} 跳过，稍后手动配置"
  echo ""

  read -rp "请输入编号 [0]: " choices
  choices=${choices:-0}

  if [[ "$choices" == "0" ]]; then
    warn "已跳过 API Key 配置，请稍后手动编辑 .env 文件"
    return
  fi

  # 提供商映射
  declare -A provider_env_map=(
    [1]="DEEPSEEK_API_KEY"
    [2]="OPENAI_API_KEY"
    [3]="ANTHROPIC_API_KEY"
    [4]="GOOGLE_API_KEY"
    [5]="OPENROUTER_API_KEY"
    [6]="ALIYUN_API_KEY"
    [7]="ZHIPU_API_KEY"
    [8]="MOONSHOT_API_KEY"
    [9]="BYTEDANCE_API_KEY"
    [10]="SILICONFLOW_API_KEY"
    [11]="MINIMAX_API_KEY"
    [12]="GROQ_API_KEY"
    [13]="TOGETHER_API_KEY"
    [14]="FIREWORKS_API_KEY"
    [15]="PERPLEXITY_API_KEY"
    [16]="XAI_API_KEY"
  )

  declare -A provider_name_map=(
    [1]="DeepSeek"
    [2]="OpenAI"
    [3]="Anthropic"
    [4]="Google"
    [5]="OpenRouter"
    [6]="阿里通义千问"
    [7]="智谱"
    [8]="Moonshot"
    [9]="字节豆包"
    [10]="SiliconFlow"
    [11]="MiniMax"
    [12]="Groq"
    [13]="Together AI"
    [14]="Fireworks"
    [15]="Perplexity"
    [16]="xAI"
  )

  for choice in $choices; do
    env_key="${provider_env_map[$choice]}"
    provider_name="${provider_name_map[$choice]}"
    if [[ -n "$env_key" ]]; then
      echo ""
      read -rp "请输入 ${provider_name} API Key: " api_key
      if [[ -n "$api_key" ]]; then
        # 更新 .env 文件
        if grep -q "^${env_key}=" .env; then
          sed -i.bak "s|^${env_key}=.*|${env_key}=${api_key}|" .env && rm -f .env.bak
        else
          echo "${env_key}=${api_key}" >> .env
        fi
        success "${provider_name} API Key 已配置"
      else
        warn "${provider_name} API Key 为空，已跳过"
      fi
    fi
  done
}

# ============ 注册 systemd 服务 ============
register_systemd_service() {
  if [[ "$OS" == "macos" ]]; then
    warn "macOS 不支持 systemd，跳过服务注册"
    info "可使用 launchd 或直接运行 npm start"
    return
  fi

  local INSTALL_DIR
  INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

  echo ""
  read -rp "是否注册为 systemd 服务（开机自启）? [y/N]: " register_choice
  if [[ ! "$register_choice" =~ ^[Yy]$ ]]; then
    info "跳过 systemd 服务注册"
    return
  fi

  cat <<EOF | sudo tee /etc/systemd/system/duan-xiansheng.service > /dev/null
[Unit]
Description=段先生 AI Agent
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) ${INSTALL_DIR}/dist/entry.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable duan-xiansheng
  sudo systemctl start duan-xiansheng

  success "systemd 服务已注册并启动"
  info "  启动: sudo systemctl start duan-xiansheng"
  info "  停止: sudo systemctl stop duan-xiansheng"
  info "  状态: sudo systemctl status duan-xiansheng"
  info "  日志: sudo journalctl -u duan-xiansheng -f"
}

# ============ 卸载 ============
do_uninstall() {
  separator
  echo -e "${BOLD}${RED}  卸载段先生 AI Agent${NC}"
  separator

  # 停止 systemd 服务
  if [[ -f /etc/systemd/system/duan-xiansheng.service ]]; then
    info "停止 systemd 服务..."
    sudo systemctl stop duan-xiansheng 2>/dev/null || true
    sudo systemctl disable duan-xiansheng 2>/dev/null || true
    sudo rm -f /etc/systemd/system/duan-xiansheng.service
    sudo systemctl daemon-reload
    success "systemd 服务已移除"
  fi

  read -rp "确认删除 node_modules 和构建产物? [y/N]: " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    rm -rf node_modules dist frontend/node_modules frontend/dist
    success "已清理 node_modules 和构建产物"
  fi

  read -rp "确认删除 .env 配置文件? [y/N]: " confirm_env
  if [[ "$confirm_env" =~ ^[Yy]$ ]]; then
    rm -f .env
    success "已删除 .env"
  fi

  echo ""
  success "卸载完成"
}

# ============ 更新 ============
do_update() {
  separator
  echo -e "${BOLD}${CYAN}  更新段先生 AI Agent${NC}"
  separator

  info "拉取最新代码..."
  if command -v git &>/dev/null && [[ -d .git ]]; then
    git pull --rebase || warn "Git 拉取失败，请手动处理冲突"
  else
    warn "未检测到 Git 仓库，跳过代码更新"
  fi

  info "更新依赖..."
  npm ci 2>/dev/null || npm install

  info "重新构建..."
  npm run build

  # 重启 systemd 服务
  if [[ -f /etc/systemd/system/duan-xiansheng.service ]]; then
    sudo systemctl restart duan-xiansheng
    success "systemd 服务已重启"
  fi

  echo ""
  success "更新完成"
}

# ============ 主安装流程 ============
do_install() {
  separator
  echo -e "${BOLD}${CYAN}  段先生 AI Agent 安装程序 v15.0${NC}"
  separator
  echo ""

  # 1. 系统检测
  detect_os

  # 2. 安装系统依赖
  install_system_deps

  # 3. 检查 Git
  check_git

  # 4. 检查/安装 Node.js
  if ! check_node; then
    install_node_via_nvm
  fi

  # 5. 安装项目依赖
  info "安装项目依赖..."
  npm ci 2>/dev/null || npm install
  success "项目依赖安装完成"

  # 6. 构建
  info "编译 TypeScript..."
  npm run build
  success "构建完成"

  # 7. 创建数据目录
  mkdir -p .duan/sessions .duan/context .duan/screenshots .duan/skills .duan/visual
  success "数据目录已创建"

  # 8. 配置向导
  configure_api_keys

  # 9. systemd 服务注册
  register_systemd_service

  # 10. 完成
  echo ""
  separator
  echo -e "${BOLD}${GREEN}  安装完成！${NC}"
  separator
  echo ""
  echo -e "启动方式："
  echo -e "  ${CYAN}Web模式:${NC}   npm start"
  echo -e "  ${CYAN}开发模式:${NC}   npm run dev:web-server"
  echo -e "  ${CYAN}Docker:${NC}    docker build -t duan . && docker run -p 3001:3001 duan"
  echo ""
  echo -e "配置 API 密钥："
  echo -e "  编辑 ${CYAN}.env${NC} 文件，或运行 ${CYAN}./install.sh${NC} 重新配置"
  echo ""
}

# ============ 入口 ============
case "${1:-}" in
  uninstall)
    do_uninstall
    ;;
  update)
    do_update
    ;;
  *)
    do_install
    ;;
esac
