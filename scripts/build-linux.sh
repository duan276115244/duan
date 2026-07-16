#!/bin/bash
#==============================================================
# v20.0 §4.2 Linux 构建脚本
#
# 在 Linux 环境（含 Docker）构建段先生 Agent 桌面端安装包。
# 支持架构：x86_64 / ARM64
# 支持格式：AppImage / deb / rpm
#
# 用法：
#   bash scripts/build-linux.sh                    # 默认当前架构 AppImage
#   bash scripts/build-linux.sh --arch x64         # 指定 x64
#   bash scripts/build-linux.sh --arch arm64       # 指定 arm64
#   bash scripts/build-linux.sh --target deb       # 指定 deb 格式
#   bash scripts/build-linux.sh --all              # 构建所有目标格式
#
# 注意：必须在 Linux 环境运行（跨平台打包会失败）
#==============================================================

set -euo pipefail

# ============ 颜色输出 ============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ============ 参数解析 ============
ARCH=""
TARGET="AppImage"
BUILD_ALL=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --arch)
            ARCH="$2"
            shift 2
            ;;
        --target)
            TARGET="$2"
            shift 2
            ;;
        --all)
            BUILD_ALL=true
            shift
            ;;
        --help|-h)
            echo "用法: bash scripts/build-linux.sh [--arch x64|arm64] [--target AppImage|deb|rpm] [--all]"
            exit 0
            ;;
        *)
            fail "未知参数: $1"
            ;;
    esac
done

# ============ 环境检查 ============

# 必须在 Linux 运行
if [[ "$(uname -s)" != "Linux" ]]; then
    fail "此脚本必须在 Linux 环境运行（当前: $(uname -s)）"
fi

# 自动检测架构
if [[ -z "$ARCH" ]]; then
    case "$(uname -m)" in
        x86_64|amd64)  ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        loongarch64)
            warn "LoongArch64 架构 — Electron 官方暂不支持，将构建 CLI/Web 版本"
            ARCH="loong64"
            ;;
        *)
            fail "不支持的架构: $(uname -m)"
            ;;
    esac
fi

info "构建架构: ${ARCH}"
info "构建目标: ${BUILD_ALL:-false} == true ? 'all' : ${TARGET}"

# 检查 Node.js
if ! command -v node &>/dev/null; then
    fail "Node.js 未安装"
fi
ok "Node.js: $(node -v)"

# 检查项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ ! -f "package.json" ]]; then
    fail "未找到 package.json，请确认在项目根目录运行"
fi

ok "项目根目录: ${PROJECT_ROOT}"

# ============ 安装依赖 ============
info "安装 npm 依赖..."
if [[ ! -d "node_modules" ]]; then
    npm ci --no-audit --no-fund || fail "npm ci 失败"
else
    info "node_modules 已存在，跳过安装（如需重装请删除 node_modules）"
fi

# ============ 构建前端 ============
info "构建前端..."
if [[ -d "frontend" ]]; then
    cd frontend
    if [[ ! -d "node_modules" ]]; then
        npm ci --no-audit --no-fund || fail "前端依赖安装失败"
    fi
    npx vite build || fail "前端构建失败"
    cd "$PROJECT_ROOT"
    ok "前端构建完成"
else
    warn "未找到 frontend/ 目录，跳过前端构建"
fi

# ============ 构建后端（TypeScript 编译） ============
info "编译 TypeScript..."
npx tsc || fail "TypeScript 编译失败"
ok "后端编译完成"

# ============ Electron 构建 ============

# LoongArch 不支持 Electron，只构建 CLI/Web
if [[ "$ARCH" == "loong64" ]]; then
    warn "LoongArch64 架构跳过 Electron 构建"
    info "构建完成：CLI / Web 模式可用"
    info "启动方式：npm run duan (CLI) 或 npm run duan:web (Web)"
    exit 0
fi

# 检查 electron-builder
if ! npx electron-builder --version &>/dev/null; then
    fail "electron-builder 不可用，请运行 npm install"
fi

# 构建目标
if [[ "$BUILD_ALL" == "true" ]]; then
    info "构建所有 Linux 目标（AppImage + deb + rpm）..."
    npx electron-builder --linux AppImage --$ARCH \
        || fail "AppImage 构建失败"
    npx electron-builder --linux deb --$ARCH \
        || warn "deb 构建失败（可能缺少 dpkg-deb）"
    npx electron-builder --linux rpm --$ARCH \
        || warn "rpm 构建失败（可能缺少 rpmbuild）"
else
    info "构建 ${TARGET} (${ARCH})..."
    npx electron-builder --linux "${TARGET}" --${ARCH} \
        || fail "${TARGET} 构建失败"
fi

# ============ 构建结果 ============
echo ""
echo "================================"
ok "构建完成！"

RELEASE_DIR="${PROJECT_ROOT}/release"
if [[ -d "$RELEASE_DIR" ]]; then
    info "构建产物位于: ${RELEASE_DIR}"
    echo ""
    ls -lh "$RELEASE_DIR"/*.AppImage "$RELEASE_DIR"/*.deb "$RELEASE_DIR"/*.rpm 2>/dev/null || true
fi

echo ""
info "安装方式："
echo "  AppImage: chmod +x *.AppImage && ./*.AppImage"
echo "  deb:      sudo dpkg -i *.deb"
echo "  rpm:      sudo rpm -i *.rpm"
echo "================================"
