# 段先生 v17.0 Dockerfile — 多阶段构建
# 支持：amd64 / arm64（树莓派）

# ===== 阶段1：构建 =====
FROM node:20-slim AS builder

WORKDIR /app

# 安装构建依赖
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# 复制 package 文件
COPY package*.json ./
COPY tsconfig.json ./

# 安装依赖
RUN npm ci

# 复制源码
COPY src/ ./src/
COPY templates/ ./templates/
COPY skills/ ./skills/

# 构建
RUN npm run build

# ===== 阶段2：运行时 =====
FROM node:20-slim AS runtime

WORKDIR /app

# 安装运行时依赖（ffmpeg for 语音, chromium for 浏览器自动化）
RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromium \
    fonts-wqy-zenhei \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 复制构建产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/skills ./skills

# 创建数据目录
RUN mkdir -p /app/.duan /app/data /app/logs

# 环境变量
ENV NODE_ENV=production
ENV WEB_PORT=3000
ENV API_PORT=8080
ENV LOG_LEVEL=info

# 暴露端口
EXPOSE 3000 8080

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/api/v1/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# 启动
CMD ["node", "dist/entry.js", "web"]
