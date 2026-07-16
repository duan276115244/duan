#!/bin/bash
#==============================================================
# v20.0 §4.2 国产系统环境检测脚本
#
# 检测 CPU 架构、OS 发行版、Node.js、系统依赖，
# 为统信 UOS / 银河麒麟 / 麒麟桌面版提供安装指引。
#
# 用法：bash scripts/check-native-env.sh
#==============================================================

set -euo pipefail

# ============ 颜色输出 ============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; }

# ============ 检测结果标记 ============
HAS_ERRORS=0
HAS_WARNINGS=0

check_pass() { ok "$*"; }
check_fail() { fail "$*"; HAS_ERRORS=$((HAS_ERRORS + 1)); }
check_warn() { warn "$*"; HAS_WARNINGS=$((HAS_WARNINGS + 1)); }

# ============ CPU 架构检测 ============
detect_arch() {
    local arch
    arch=$(uname -m)
    info "CPU 架构: ${arch}"

    case "$arch" in
        x86_64|amd64)
            check_pass "x86_64 架构 — 官方 Node.js / Electron 直接支持"
            ;;
        aarch64|arm64)
            check_pass "ARM64 架构 — 飞腾/鲲鹏，官方 Node.js / Electron ARM64 支持"
            ;;
        loongarch64)
            check_warn "LoongArch64 架构 — 需龙芯团队维护的 loongnix-node，Electron 需社区版"
            echo "       安装指引："
            echo "       1. Node.js: https://github.com/loongson/"
            echo "       2. 编译源码: ./configure --prefix=/usr/local && make && sudo make install"
            ;;
        mips64el)
            check_warn "MIPS64el 架构（旧龙芯）— 兼容性受限，建议升级到 LoongArch"
            ;;
        *)
            check_fail "未知架构: ${arch}"
            ;;
    esac
}

# ============ OS 发行版检测 ============
detect_distro() {
    local distro_id=""
    local distro_name=""
    local distro_version=""

    if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        source /etc/os-release
        distro_id="${ID:-unknown}"
        distro_name="${NAME:-Unknown}"
        distro_version="${VERSION_ID:-${VERSION:-}}"
    elif [[ -f /etc/lsb-release ]]; then
        # shellcheck disable=SC1091
        source /etc/lsb-release
        distro_id="${DISTRIB_ID:-unknown}" | tr '[:upper:]' '[:lower:]'
        distro_name="${DISTRIB_DESCRIPTION:-Unknown}"
        distro_version="${DISTRIB_RELEASE:-}"
    else
        check_fail "无法检测 Linux 发行版（/etc/os-release 和 /etc/lsb-release 均不存在）"
        return
    fi

    distro_id=$(echo "$distro_id" | tr '[:upper:]' '[:lower:]')
    info "操作系统: ${distro_name} ${distro_version} (ID: ${distro_id})"

    case "$distro_id" in
        uos|uniontech)
            check_pass "统信 UOS — 国产系统已适配"
            ;;
        kylin|kylinos)
            check_pass "银河麒麟 — 国产系统已适配"
            ;;
        deepin)
            check_pass "深度操作系统 — 国产系统已适配"
            ;;
        ubuntu|debian)
            check_warn "${distro_name} — 通用 Linux，可运行但非国产适配目标"
            ;;
        centos|rhel|fedora)
            check_warn "${distro_name} — 通用 Linux，可运行但非国产适配目标"
            ;;
        *)
            check_warn "未识别的发行版: ${distro_name} — 尝试通用 Linux 模式"
            ;;
    esac
}

# ============ 包管理器检测 ============
detect_package_manager() {
    local pm=""
    if command -v dnf &>/dev/null; then
        pm="dnf"
    elif command -v yum &>/dev/null; then
        pm="yum"
    elif command -v apt &>/dev/null; then
        pm="apt"
    elif command -v apt-get &>/dev/null; then
        pm="apt-get"
    elif command -v pacman &>/dev/null; then
        pm="pacman"
    elif command -v zypper &>/dev/null; then
        pm="zypper"
    else
        check_fail "未找到包管理器（apt/yum/dnf/pacman/zypper）"
        return
    fi

    check_pass "包管理器: ${pm}"
}

# ============ Node.js 检测 ============
detect_node() {
    if ! command -v node &>/dev/null; then
        check_fail "Node.js 未安装 — 需 v18+"
        echo "       安装指引："
        case "$(uname -m)" in
            loongarch64)
                echo "       龙芯：请从 https://github.com/loongson/ 获取 loongnix-node"
                echo "       或源码编译: https://nodejs.org/en/download/source-code/"
                ;;
            *)
                echo "       推荐 nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
                echo "       然后: nvm install 20 && nvm use 20"
                ;;
        esac
        return
    fi

    local node_version
    node_version=$(node -v | sed 's/v//')
    local major_version
    major_version=$(echo "$node_version" | cut -d. -f1)

    if [[ "$major_version" -lt 18 ]]; then
        check_fail "Node.js 版本过低: v${node_version}（需 v18+）"
    else
        check_pass "Node.js: v${node_version}"

        # 检查架构匹配
        local node_arch
        node_arch=$(node -e "process.stdout.write(process.arch)")
        local system_arch
        system_arch=$(uname -m)
        case "$system_arch" in
            x86_64|amd64)
                if [[ "$node_arch" != "x64" ]]; then
                    check_warn "Node.js 架构 ${node_arch} 与系统 ${system_arch} 不匹配"
                fi
                ;;
            aarch64|arm64)
                if [[ "$node_arch" != "arm64" ]]; then
                    check_warn "Node.js 架构 ${node_arch} 与系统 ${system_arch} 不匹配"
                fi
                ;;
        esac
    fi
}

# ============ 系统依赖检测 ============
detect_system_deps() {
    info "检测系统依赖..."

    # Chromium / Chrome
    if command -v chromium &>/dev/null || \
       command -v chromium-browser &>/dev/null || \
       command -v google-chrome &>/dev/null || \
       command -v google-chrome-stable &>/dev/null; then
        check_pass "Chromium/Chrome 已安装"
    else
        check_warn "Chromium/Chrome 未安装 — 浏览器自动化功能需要"
        echo "       安装命令:"
        if command -v apt &>/dev/null; then
            echo "         sudo apt install -y chromium"
        elif command -v dnf &>/dev/null; then
            echo "         sudo dnf install -y chromium"
        elif command -v yum &>/dev/null; then
            echo "         sudo yum install -y chromium"
        fi
    fi

    # ffmpeg
    if command -v ffmpeg &>/dev/null; then
        check_pass "ffmpeg 已安装"
    else
        check_warn "ffmpeg 未安装 — 语音/视频功能需要"
        echo "       安装命令:"
        if command -v apt &>/dev/null; then
            echo "         sudo apt install -y ffmpeg"
        elif command -v dnf &>/dev/null; then
            echo "         sudo dnf install -y ffmpeg"
        elif command -v yum &>/dev/null; then
            echo "         sudo yum install -y ffmpeg"
        fi
    fi

    # 桌面自动化工具（Linux）
    if [[ "$(uname -s)" == "Linux" ]]; then
        # xdotool — 窗口操作
        if command -v xdotool &>/dev/null; then
            check_pass "xdotool 已安装"
        else
            check_warn "xdotool 未安装 — 桌面自动化需要"
        fi

        # scrot 或 ImageMagick — 截图
        if command -v scrot &>/dev/null || command -v import &>/dev/null; then
            check_pass "截图工具已安装 (scrot/ImageMagick)"
        else
            check_warn "截图工具未安装 — 需要 scrot 或 ImageMagick"
        fi

        # wmctrl — 窗口管理
        if command -v wmctrl &>/dev/null; then
            check_pass "wmctrl 已安装"
        else
            check_warn "wmctrl 未安装 — 窗口管理需要"
        fi

        # xclip / xsel — 剪贴板
        if command -v xclip &>/dev/null || command -v xsel &>/dev/null; then
            check_pass "剪贴板工具已安装 (xclip/xsel)"
        else
            check_warn "剪贴板工具未安装 — 需要 xclip 或 xsel"
        fi

        # notify-send — 通知
        if command -v notify-send &>/dev/null; then
            check_pass "notify-send 已安装"
        else
            check_warn "notify-send 未安装 — 系统通知需要"
        fi
    fi
}

# ============ 主流程 ============
main() {
    echo "================================"
    echo " 段先生 Agent — 国产系统环境检测"
    echo " v20.0 §4.2"
    echo "================================"
    echo ""

    detect_arch
    echo ""

    detect_distro
    echo ""

    detect_package_manager
    echo ""

    detect_node
    echo ""

    detect_system_deps
    echo ""

    echo "================================"
    if [[ $HAS_ERRORS -gt 0 ]]; then
        fail "检测完成：${HAS_ERRORS} 个错误，${HAS_WARNINGS} 个警告"
        echo "请修复上述错误后再运行段先生 Agent。"
        exit 1
    elif [[ $HAS_WARNINGS -gt 0 ]]; then
        warn "检测完成：${HAS_WARNINGS} 个警告"
        echo "建议安装缺失的依赖以获得完整功能。"
        exit 0
    else
        check_pass "检测完成：所有检查通过"
        echo "环境就绪，可以运行段先生 Agent。"
        exit 0
    fi
}

main "$@"
