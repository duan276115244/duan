/**
 * OfflineCoordinator — 离线协调器
 *
 * v20.0 §5.2 离线能力增强的核心实现。
 *
 * 四大能力：
 * 1. 网络状态检测 — 定期探测网络连通性，通过 EventBus 广播 network.online/offline 事件
 * 2. 本地模型检测 — 检测 Ollama / llama.cpp，提供本地模型查询接口
 * 3. 离线模式切换 — 网络断开时自动切换到本地模型，恢复时切回；支持手动切换
 * 4. 离线知识库 — 内置编程文档摘要（TS/Python/Git/Linux/正则/HTTP/SQL/Docker/npm/VSCode）
 *
 * 设计原则：
 * - 不修改 ModelLibrary / SmartToolSelector 现有逻辑，仅通过 EventBus 事件协同
 * - 网络探测采用"多端点轮询 + 指数退避"，避免单点误判
 * - 本地模型检测复用 NativePlatform.commandExists() + Ollama HTTP API
 * - 离线知识库采用关键词匹配 + TF-IDF 评分（轻量级，无外部依赖）
 *
 * 数据存储：~/.duan/offline/
 *   - status.json    — 网络状态历史
 *   - models.json    — 本地模型检测结果缓存
 *   - knowledge.json — 离线知识库
 *   - mode.json      — 离线模式开关状态
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 网络状态 */
export type NetworkState = 'online' | 'offline' | 'unknown';

/** 网络状态记录 */
export interface NetworkStatusRecord {
  state: NetworkState;
  checkedAt: number;
  latencyMs?: number;
  probedEndpoint?: string;
  error?: string;
}

/** 本地模型类型 */
export type LocalModelType = 'ollama' | 'llama_cpp' | 'other';

/** 本地模型信息 */
export interface LocalModelInfo {
  type: LocalModelType;
  name: string;
  endpoint?: string;
  capabilities?: string[];
  sizeBytes?: number;
  detectedAt: number;
}

/** 离线知识条目 */
export interface OfflineKnowledgeEntry {
  id: string;
  topic: string;
  content: string;
  tags: string[];
  category: string;
  source: string;
}

/** 离线知识查询结果 */
export interface OfflineKnowledgeQueryResult {
  entry: OfflineKnowledgeEntry;
  score: number;
  matchedKeywords: string[];
}

/** 离线模式来源 */
export type OfflineModeSource = 'auto' | 'manual' | 'startup';

/** 离线协调器统计 */
export interface OfflineStats {
  networkState: NetworkState;
  offlineMode: boolean;
  offlineModeSource: OfflineModeSource | null;
  lastCheckedAt: number | null;
  onlineCheckCount: number;
  offlineCheckCount: number;
  localModelCount: number;
  knowledgeEntryCount: number;
  uptime: number;
}

// ============ 内置离线知识库 ============

const BUILTIN_KNOWLEDGE: OfflineKnowledgeEntry[] = [
  {
    id: 'kb-typescript-basics',
    topic: 'TypeScript 基础',
    content: `TypeScript 是 JavaScript 的超集，添加了静态类型系统。

核心概念：
- 类型注解：let x: number = 1; let s: string = 'hi'; let arr: number[] = [1,2];
- 接口：interface Person { name: string; age: number; }
- 泛型：function id<T>(x: T): T { return x; }
- 联合类型：let x: string | number;
- 类型守卫：typeof x === 'string' / instanceof / in
- 枚举：enum Color { Red, Green, Blue }
- 元组：let x: [string, number] = ['hi', 1];
- 可选/默认参数：function f(a: string, b?: number = 0) {}
- 异步：async function f(): Promise<T> { return await fetch(); }

常用工具类型：
- Partial<T> / Required<T> / Readonly<T>
- Pick<T, K> / Omit<T, K>
- Record<K, V> / ReturnType<T> / Parameters<T>

tsconfig.json 关键选项：
- strict: true（开启所有严格检查）
- noImplicitAny / strictNullChecks / strictFunctionTypes
- target: 'ES2020' / module: 'ESNext'
- outDir / rootDir / baseUrl / paths`,
    tags: ['typescript', 'ts', '类型', 'type', 'interface', '泛型', 'generic'],
    category: 'programming',
    source: 'builtin',
  },
  {
    id: 'kb-python-basics',
    topic: 'Python 基础',
    content: `Python 是动态类型解释型语言，强调可读性和简洁。

核心语法：
- 变量：x = 1; s = 'hello'; lst = [1, 2, 3]; d = {'a': 1}
- 类型注解：def f(x: int) -> str: return str(x)
- 列表推导：[x*2 for x in range(10) if x % 2 == 0]
- 字典推导：{k: v for k, v in items if v > 0}
- f-string：f'value={x:.2f}'
- 异步：async def f(): await asyncio.sleep(1)
- 装饰器：@decorator def f(): pass
- 上下文管理：with open('f') as f: data = f.read()
- 异常：try: ... except ValueError as e: ... finally: ...

常用标准库：
- os / sys / pathlib / json / re / datetime
- collections (defaultdict, Counter, namedtuple)
- itertools / functools / typing
- asyncio / aiohttp（异步 HTTP）
- unittest / pytest（测试）

pip 常用命令：
- pip install package
- pip install -r requirements.txt
- pip freeze > requirements.txt
- pip list / pip show package`,
    tags: ['python', 'py', 'pip', '类型注解', 'asyncio', 'list comprehension'],
    category: 'programming',
    source: 'builtin',
  },
  {
    id: 'kb-git-commands',
    topic: 'Git 常用命令',
    content: `Git 是分布式版本控制系统。

基础操作：
- git init / git clone <url>
- git status / git diff / git log --oneline
- git add <file> / git add . / git commit -m 'msg'
- git push / git pull / git fetch

分支管理：
- git branch / git branch <name> / git branch -d <name>
- git checkout <branch> / git checkout -b <name>
- git merge <branch> / git rebase <branch>
- git stash / git stash pop

远程仓库：
- git remote add origin <url>
- git remote -v / git remote remove origin

撤销操作：
- git checkout -- <file>（撤销工作区修改）
- git reset HEAD <file>（取消暂存）
- git reset --hard HEAD（重置到上次提交）
- git revert <commit>（生成反向提交）

标签：
- git tag v1.0 / git tag -a v1.0 -m 'release'
- git push --tags

配置：
- git config --global user.name 'Name'
- git config --global user.email 'email'
- git config --global core.editor 'code --wait'`,
    tags: ['git', 'version control', '分支', 'branch', 'commit', 'merge', 'rebase'],
    category: 'tools',
    source: 'builtin',
  },
  {
    id: 'kb-linux-commands',
    topic: 'Linux 常用命令',
    content: `Linux 常用命令速查。

文件操作：
- ls -la / ls -lh / ls -t（按时间排序）
- cd / pwd / mkdir -p / rm -rf / cp -r / mv
- cat / less / head -n 20 / tail -n 20 / tail -f
- find . -name '*.ts' -type f
- grep -r 'pattern' . / grep -i（忽略大小写）/ grep -v（反向）
- chmod 755 file / chown user:group file
- ln -s target link（软链接）

进程管理：
- ps aux / ps -ef / top / htop
- kill -9 PID / killall process_name
- jobs / fg / bg / nohup command &
- &（后台运行）/ Ctrl+Z（暂停）/ Ctrl+C（终止）

网络：
- ifconfig / ip addr / ip route
- netstat -tlnp / ss -tlnp
- curl -X GET URL / wget URL
- ssh user@host / scp file user@host:path

磁盘：
- df -h / du -sh . / du -sh *
- mount / umount / fdisk -l

包管理：
- apt install / apt remove / apt update / apt upgrade
- yum install / dnf install
- pacman -S / pacman -R`,
    tags: ['linux', 'shell', 'bash', '命令行', 'terminal', 'cli'],
    category: 'tools',
    source: 'builtin',
  },
  {
    id: 'kb-regex',
    topic: '正则表达式',
    content: `正则表达式速查。

元字符：
- . 任意单字符（除换行）
- ^ 行首 / $ 行尾
- \\b 单词边界 / \\B 非单词边界
- \\d 数字 / \\D 非数字 / \\w 字母数字下划线 / \\W 反 / \\s 空白 / \\S 反

量词：
- * 0 或多次 / + 1 或多次 / ? 0 或 1 次
- {n} n 次 / {n,} 至少 n 次 / {n,m} n 到 m 次

字符类：
- [abc] a/b/c / [^abc] 非 / [a-z] 范围

分组：
- (abc) 捕获组 / (?:abc) 非捕获 / (?=abc) 前瞻 / (?!abc) 负前瞻

标志：
- g 全局 / i 忽略大小写 / m 多行 / s . 含换行 / u Unicode

常用模式：
- 邮箱：[\\w.-]+@[\\w.-]+\\.\\w+
- URL：https?://[\\w.-]+(?:/[\\w./-]*)?
- 手机号：1[3-9]\\d{9}
- IP：\\d{1,3}(\\.\\d{1,3}){3}
- 日期：\\d{4}-\\d{2}-\\d{2}

JS 用法：
- /pattern/flags.test(str)
- str.match(/pattern/g)
- str.replace(/pattern/g, 'replacement')
- new RegExp('pattern', 'flags')`,
    tags: ['regex', 'regexp', '正则', 'regular expression', '模式匹配'],
    category: 'programming',
    source: 'builtin',
  },
  {
    id: 'kb-http-status',
    topic: 'HTTP 状态码',
    content: `HTTP 状态码速查。

1xx 信息：
- 100 Continue / 101 Switching Protocols

2xx 成功：
- 200 OK / 201 Created / 202 Accepted / 204 No Content / 206 Partial Content

3xx 重定向：
- 301 Moved Permanently / 302 Found / 304 Not Modified / 307 Temporary Redirect / 308 Permanent Redirect

4xx 客户端错误：
- 400 Bad Request / 401 Unauthorized / 403 Forbidden / 404 Not Found
- 405 Method Not Allowed / 408 Request Timeout / 409 Conflict / 410 Gone
- 413 Payload Too Large / 414 URI Too Long / 415 Unsupported Media Type
- 429 Too Many Requests / 422 Unprocessable Entity

5xx 服务端错误：
- 500 Internal Server Error / 501 Not Implemented / 502 Bad Gateway
- 503 Service Unavailable / 504 Gateway Timeout / 511 Network Authentication Required

常见场景：
- 登录失败：401（未认证）vs 403（已认证但无权限）
- 资源不存在：404
- 表单验证错误：422
- 限流：429（配合 Retry-After 头）
- 服务器宕机：502 / 503`,
    tags: ['http', 'status', '状态码', 'rest', 'api', 'response code'],
    category: 'web',
    source: 'builtin',
  },
  {
    id: 'kb-sql-basics',
    topic: 'SQL 基础',
    content: `SQL 常用语句速查。

查询：
- SELECT * FROM table WHERE condition ORDER BY col DESC LIMIT 10
- SELECT col, COUNT(*) FROM table GROUP BY col HAVING COUNT(*) > 1
- SELECT a.x, b.y FROM a JOIN b ON a.id = b.a_id
- LEFT JOIN / RIGHT JOIN / FULL JOIN / CROSS JOIN
- SELECT DISTINCT col FROM table
- SELECT * FROM table WHERE col IN (1,2,3) / BETWEEN 1 AND 10 / LIKE '%pattern%'
- 子查询：SELECT * FROM (SELECT * FROM t) sub WHERE sub.x > 0

增删改：
- INSERT INTO table (col1, col2) VALUES (v1, v2)
- UPDATE table SET col = val WHERE condition
- DELETE FROM table WHERE condition

聚合函数：
- COUNT / SUM / AVG / MIN / MAX
- COUNT(DISTINCT col)

字符串函数：
- LENGTH / UPPER / LOWER / SUBSTRING / CONCAT / REPLACE / TRIM

日期函数：
- NOW() / CURDATE() / DATE_FORMAT(date, format)
- DATEDIFF(d1, d2) / DATE_ADD(date, INTERVAL n DAY)

索引：
- CREATE INDEX idx_name ON table (col)
- CREATE UNIQUE INDEX idx ON table (col)
- DROP INDEX idx_name ON table

事务：
- BEGIN / COMMIT / ROLLBACK
- SAVEPOINT name / ROLLBACK TO name`,
    tags: ['sql', 'database', '查询', 'query', 'join', '索引', 'index'],
    category: 'data',
    source: 'builtin',
  },
  {
    id: 'kb-docker-basics',
    topic: 'Docker 基础',
    content: `Docker 容器化速查。

核心概念：
- 镜像（Image）：只读模板，含应用 + 依赖
- 容器（Container）：镜像的运行实例
- 仓库（Registry）：镜像存储（Docker Hub / 私有）

常用命令：
- docker pull image:tag / docker push image:tag
- docker build -t name:tag . / docker build -f Dockerfile.dev -t name .
- docker run -d --name c1 -p 8080:80 -v /host:/container image
- docker run -it --rm image bash（交互式 + 退出即删）
- docker ps / docker ps -a / docker images / docker rm c1 / docker rmi image
- docker exec -it c1 bash / docker logs -f c1 / docker stop c1 / docker start c1
- docker cp c1:/path /host / docker inspect c1

Dockerfile 指令：
- FROM node:18-alpine
- WORKDIR /app
- COPY package*.json ./
- RUN npm ci --production
- COPY . .
- EXPOSE 3000
- CMD ["node", "server.js"]
- ENV NODE_ENV=production
- ARG VERSION=1.0
- HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health

docker-compose.yml：
- version: '3.8'
- services: / image: / build: / ports: / volumes: / environment: / depends_on:
- docker-compose up -d / docker-compose down / docker-compose logs -f / docker-compose ps

清理：
- docker system prune -a（删除所有未使用的镜像/容器/网络）
- docker volume prune（删除未使用的卷）`,
    tags: ['docker', '容器', 'container', '镜像', 'image', 'dockerfile', 'compose'],
    category: 'devops',
    source: 'builtin',
  },
  {
    id: 'kb-npm-commands',
    topic: 'npm / yarn / pnpm 命令',
    content: `JavaScript 包管理器命令对照。

npm：
- npm install / npm i（安装 package.json 依赖）
- npm install pkg / npm i pkg（安装到 dependencies）
- npm install -D pkg / npm i --save-dev pkg（安装到 devDependencies）
- npm install -g pkg（全局安装）
- npm uninstall pkg / npm un pkg
- npm update / npm outdated
- npm run script / npm start / npm test
- npm publish / npm version patch|minor|major
- npm list / npm list --depth=0
- npm cache clean --force
- npx command（执行本地/远程包）

yarn：
- yarn / yarn install
- yarn add pkg / yarn add --dev pkg
- yarn add --peer pkg / yarn global add pkg
- yarn remove pkg / yarn upgrade
- yarn run script / yarn script
- yarn list / yarn outdated
- yarn cache clean

pnpm（更省磁盘空间）：
- pnpm install / pnpm add pkg / pnpm add -D pkg
- pnpm remove pkg / pnpm update
- pnpm run script / pnpm test
- pnpm list / pnpm why pkg

npx 用法：
- npx create-react-app my-app
- npx tsc --noEmit
- npx eslint . --fix

版本号语义化：
- ^1.2.3（兼容 1.x.x）
- ~1.2.3（兼容 1.2.x）
- 1.2.3（精确版本）
- latest / next / beta`,
    tags: ['npm', 'yarn', 'pnpm', 'npx', '包管理', 'package manager', 'node'],
    category: 'tools',
    source: 'builtin',
  },
  {
    id: 'kb-vscode-shortcuts',
    topic: 'VSCode 快捷键',
    content: `VSCode 常用快捷键（Windows/Linux，Mac 用 Cmd 替代 Ctrl）。

编辑：
- Ctrl+S 保存 / Ctrl+Shift+S 另存
- Ctrl+Z 撤销 / Ctrl+Y 重做
- Ctrl+C 复制 / Ctrl+V 粘贴 / Ctrl+X 剪切
- Ctrl+F 查找 / Ctrl+H 替换 / Ctrl+Shift+F 全局查找
- Ctrl+D 选中下一个匹配 / Ctrl+K Ctrl+D 跳过匹配
- Ctrl+/ 注释切换 / Shift+Alt+A 块注释
- Alt+Up/Down 行上下移动 / Shift+Alt+Up/Down 行上下复制
- Ctrl+] 缩进 / Ctrl+[ 反缩进
- Tab 接受建议 / Esc 关闭建议

导航：
- Ctrl+P 快速打开文件 / Ctrl+Shift+P 命令面板
- Ctrl+G 跳转行 / Ctrl+Shift+O 跳转符号 / Ctrl+T 跳转工作区符号
- F12 转到定义 / Alt+F12 查看定义 / Ctrl+F12 转到实现
- Shift+F12 查看引用 / F2 重命名符号
- Ctrl+Shift+\\ 跳转匹配括号
- Alt+Left/Right 后退/前进

多光标：
- Alt+Click 添加光标 / Ctrl+Alt+Up/Down 上下添加光标
- Shift+Alt+I 在选中行末添加光标
- Ctrl+U 撤销最后一个光标

窗口/面板：
- Ctrl+\\ 分屏 / Ctrl+1/2/3 切换分屏
- Ctrl+\` 终端 / Ctrl+Shift+\` 新终端
- Ctrl+B 切换侧边栏 / Ctrl+J 切换面板
- Ctrl+Shift+E 资源管理器 / Ctrl+Shift+F 搜索 / Ctrl+Shift+G Git / Ctrl+Shift+D 调试 / Ctrl+Shift+X 扩展

调试：
- F5 启动调试 / F9 切换断点 / F10 单步跳过 / F11 单步进入 / Shift+F11 单步跳出
- F5 继续 / Shift+F5 停止调试`,
    tags: ['vscode', 'shortcut', '快捷键', 'ide', 'editor', '编辑器'],
    category: 'tools',
    source: 'builtin',
  },
];

// ============ 网络探测端点 ============

/** 多端点轮询，避免单点误判 */
const PROBE_ENDPOINTS: Array<{ url: string; host: string; port: number; path: string }> = [
  { url: 'https://www.baidu.com', host: 'www.baidu.com', port: 443, path: '/' },
  { url: 'https://www.google.com', host: 'www.google.com', port: 443, path: '/generate_204' },
  { url: 'https://1.1.1.1', host: '1.1.1.1', port: 443, path: '/' },
];

// ============ OfflineCoordinator 主类 ============

/** 网络探测超时（毫秒） */
const PROBE_TIMEOUT_MS = 5000;
/** 默认探测间隔 */
const DEFAULT_PROBE_INTERVAL_MS = 60_000;
/** 最大历史记录数 */
const MAX_HISTORY = 100;

export class OfflineCoordinator {
  private static _instance: OfflineCoordinator | null = null;

  private dataDir: string;
  private statusPath: string;
  private modelsPath: string;
  private knowledgePath: string;
  private modePath: string;

  private networkState: NetworkState = 'unknown';
  private lastCheckedAt: number | null = null;
  private onlineCheckCount = 0;
  private offlineCheckCount = 0;
  private history: NetworkStatusRecord[] = [];
  private startedAt: number;

  private localModels: LocalModelInfo[] = [];
  private lastModelDetectedAt: number | null = null;

  private knowledge: Map<string, OfflineKnowledgeEntry> = new Map();
  private keywordIndex: Map<string, Set<string>> = new Map(); // keyword → entryIds

  private offlineMode = false;
  private offlineModeSource: OfflineModeSource | null = null;

  private monitorTimer: NodeJS.Timeout | null = null;
  private monitoring = false;

  private eventBus: EventBus;
  private log = logger.child({ module: 'OfflineCoordinator' });

  /** 构造函数支持 dataDir 用于测试隔离 */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? duanPath('offline');
    this.statusPath = path.join(this.dataDir, 'status.json');
    this.modelsPath = path.join(this.dataDir, 'models.json');
    this.knowledgePath = path.join(this.dataDir, 'knowledge.json');
    this.modePath = path.join(this.dataDir, 'mode.json');
    this.eventBus = EventBus.getInstance();
    this.startedAt = Date.now();
  }

  static getInstance(): OfflineCoordinator {
    if (!OfflineCoordinator._instance) {
      OfflineCoordinator._instance = new OfflineCoordinator();
    }
    return OfflineCoordinator._instance;
  }

  static _resetInstance(): void {
    OfflineCoordinator._instance = null;
  }

  /** 初始化 */
  async initialize(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.loadStatus();
    this.loadModels();
    this.loadKnowledge();
    this.loadMode();
    this.injectBuiltinKnowledge();
    this.log.info('OfflineCoordinator 初始化完成', {
      networkState: this.networkState,
      offlineMode: this.offlineMode,
      localModels: this.localModels.length,
      knowledgeEntries: this.knowledge.size,
    });
  }

  // ============ 网络状态检测 ============

  /** 当前是否在线 */
  isOnline(): boolean {
    return this.networkState === 'online';
  }

  /** 获取网络状态 */
  getNetworkState(): NetworkState {
    return this.networkState;
  }

  /** 获取最近一次检查记录 */
  getLastCheck(): NetworkStatusRecord | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  /**
   * 探测一次网络连通性
   * 策略：多端点轮询，任一可达即视为在线
   */
  async probe(): Promise<NetworkStatusRecord> {
    const record: NetworkStatusRecord = {
      state: 'unknown',
      checkedAt: Date.now(),
    };

    for (const endpoint of PROBE_ENDPOINTS) {
      try {
        const latency = await this.probeEndpoint(endpoint.host, endpoint.port, endpoint.path);
        record.state = 'online';
        record.latencyMs = latency;
        record.probedEndpoint = endpoint.url;
        break;
      } catch (err: unknown) {
        record.error = err instanceof Error ? err.message : String(err);
      }
    }

    if (record.state !== 'online') {
      record.state = 'offline';
    }

    this.updateNetworkState(record);
    return record;
  }

  /** 探测单个端点（TCP 连接 + HTTP HEAD） */
  private probeEndpoint(host: string, port: number, path: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const req = http.request(
        {
          host,
          port,
          path,
          method: 'HEAD',
          timeout: PROBE_TIMEOUT_MS,
          headers: { 'User-Agent': 'DuanAgent/20.0 OfflineProbe' },
        },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) {
            resolve(Date.now() - start);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('probe timeout'));
      });
      req.end();
    });
  }

  /** 更新网络状态并广播事件 */
  private updateNetworkState(record: NetworkStatusRecord): void {
    const prevState = this.networkState;
    this.networkState = record.state;
    this.lastCheckedAt = record.checkedAt;

    if (record.state === 'online') {
      this.onlineCheckCount += 1;
    } else {
      this.offlineCheckCount += 1;
    }

    this.history.push(record);
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }

    this.persistStatus();

    // 状态变化时广播事件
    if (prevState !== record.state) {
      if (record.state === 'offline') {
        void this.eventBus.emit('network.offline', {
          prevState,
          checkedAt: record.checkedAt,
          error: record.error,
        });
        this.log.warn('网络已断开', { error: record.error });
        // 自动启用离线模式
        this.enableOfflineMode('auto');
      } else if (record.state === 'online' && prevState === 'offline') {
        void this.eventBus.emit('network.online', {
          prevState,
          checkedAt: record.checkedAt,
          latencyMs: record.latencyMs,
        });
        this.log.info('网络已恢复', { latencyMs: record.latencyMs });
        // 自动禁用离线模式（仅当是 auto 启用时）
        if (this.offlineModeSource === 'auto') {
          this.disableOfflineMode();
        }
      }
    }
  }

  /** 启动周期性监测 */
  startMonitoring(intervalMs: number = DEFAULT_PROBE_INTERVAL_MS): void {
    if (this.monitoring) {
      this.log.warn('监测已在运行');
      return;
    }
    this.monitoring = true;
    // 立即探测一次
    void this.probe().catch(() => {});
    // 周期性探测
    this.monitorTimer = setInterval(() => {
      void this.probe().catch((err: unknown) => {
        this.log.warn('周期探测失败', { error: err instanceof Error ? err.message : String(err) });
      });
    }, intervalMs);
    this.log.info('网络监测已启动', { intervalMs });
  }

  /** 停止监测 */
  stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.monitoring = false;
    this.log.info('网络监测已停止');
  }

  /** 是否正在监测 */
  isMonitoring(): boolean {
    return this.monitoring;
  }

  // ============ 本地模型检测 ============

  /**
   * 检测本地模型（Ollama / llama.cpp）
   */
  async detectLocalModels(): Promise<LocalModelInfo[]> {
    const models: LocalModelInfo[] = [];
    const now = Date.now();

    // 1. 检测 Ollama（HTTP API）
    try {
      const ollamaModels = await this.detectOllama();
      models.push(...ollamaModels);
    } catch (err: unknown) {
      this.log.debug('Ollama 检测失败', { error: err instanceof Error ? err.message : String(err) });
    }

    // 2. 检测 llama.cpp（命令行 + 常见路径）
    try {
      const llamaModels = await this.detectLlamaCpp();
      models.push(...llamaModels);
    } catch (err: unknown) {
      this.log.debug('llama.cpp 检测失败', { error: err instanceof Error ? err.message : String(err) });
    }

    this.localModels = models;
    this.lastModelDetectedAt = now;
    this.persistModels();

    if (models.length > 0) {
      void this.eventBus.emit('local.model.detected', {
        count: models.length,
        types: models.map(m => m.type),
      });
      this.log.info('检测到本地模型', { count: models.length });
    } else {
      this.log.info('未检测到本地模型');
    }

    return models;
  }

  /** 检测 Ollama 实例 */
  private async detectOllama(): Promise<LocalModelInfo[]> {
    const OLLAMA_API = 'http://localhost:11434';
    return new Promise<LocalModelInfo[]>((resolve, reject) => {
      const req = http.request(
        `${OLLAMA_API}/api/tags`,
        { method: 'GET', timeout: 3000 },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as { models?: Array<{ name: string; size?: number; details?: { capabilities?: string[] } }> };
              const models: LocalModelInfo[] = (parsed.models ?? []).map(m => ({
                type: 'ollama' as const,
                name: m.name,
                endpoint: OLLAMA_API,
                capabilities: m.details?.capabilities,
                sizeBytes: m.size,
                detectedAt: Date.now(),
              }));
              resolve(models);
            } catch (err: unknown) {
              reject(err);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('ollama probe timeout'));
      });
      req.end();
    });
  }

  /** 检测 llama.cpp（命令行 + 常见模型路径） */
  private async detectLlamaCpp(): Promise<LocalModelInfo[]> {
    const models: LocalModelInfo[] = [];

    // 检测 llama-cli / main 二进制
    const commands = ['llama-cli', 'main', 'llama.cpp'];
    let foundCmd: string | null = null;
    for (const cmd of commands) {
      if (await this.commandExists(cmd)) {
        foundCmd = cmd;
        break;
      }
    }

    if (foundCmd) {
      models.push({
        type: 'llama_cpp',
        name: foundCmd,
        endpoint: 'cli',
        detectedAt: Date.now(),
      });
    }

    // 检测常见 GGUF 模型路径
    const modelPaths = [
      path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.llama', 'models'),
      path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', 'models'),
      '/usr/local/share/llama-models',
      '/opt/llama-models',
    ];

    for (const dir of modelPaths) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.gguf'));
          for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            models.push({
              type: 'llama_cpp',
              name: file,
              endpoint: fullPath,
              sizeBytes: stat.size,
              detectedAt: Date.now(),
            });
          }
        }
      } catch {
        // 忽略路径访问错误
      }
    }

    return models;
  }

  /** 检测命令是否存在（跨平台） */
  private async commandExists(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      const isWindows = process.platform === 'win32';
      const checkCmd = isWindows ? `where ${cmd}` : `which ${cmd}`;
      exec(checkCmd, (err: unknown) => {
        resolve(!err);
      });
    });
  }

  /** 是否有可用本地模型 */
  hasLocalModel(): boolean {
    return this.localModels.length > 0;
  }

  /** 获取所有本地模型 */
  getLocalModels(): LocalModelInfo[] {
    return [...this.localModels];
  }

  /** 获取最佳本地模型（按能力过滤） */
  getBestLocalModel(capability?: string): LocalModelInfo | null {
    if (this.localModels.length === 0) return null;
    if (!capability) return this.localModels[0];
    // 优先匹配能力的模型
    const withCap = this.localModels.find(m => m.capabilities?.includes(capability));
    return withCap ?? this.localModels[0];
  }

  /** 获取 Ollama 模型 */
  getOllamaModels(): LocalModelInfo[] {
    return this.localModels.filter(m => m.type === 'ollama');
  }

  /** 获取 llama.cpp 模型 */
  getLlamaCppModels(): LocalModelInfo[] {
    return this.localModels.filter(m => m.type === 'llama_cpp');
  }

  // ============ 离线模式 ============

  /** 是否处于离线模式 */
  isOfflineMode(): boolean {
    return this.offlineMode;
  }

  /** 获取离线模式来源 */
  getOfflineModeSource(): OfflineModeSource | null {
    return this.offlineModeSource;
  }

  /** 启用离线模式 */
  enableOfflineMode(source: OfflineModeSource = 'manual'): void {
    if (this.offlineMode && this.offlineModeSource === source) return;
    this.offlineMode = true;
    this.offlineModeSource = source;
    this.persistMode();
    void this.eventBus.emit('offline.mode.toggled', {
      offlineMode: true,
      source,
      networkState: this.networkState,
    });
    this.log.info('离线模式已启用', { source, networkState: this.networkState });
  }

  /** 禁用离线模式 */
  disableOfflineMode(): void {
    if (!this.offlineMode) return;
    this.offlineMode = false;
    this.offlineModeSource = null;
    this.persistMode();
    void this.eventBus.emit('offline.mode.toggled', {
      offlineMode: false,
      source: null,
      networkState: this.networkState,
    });
    this.log.info('离线模式已禁用');
  }

  /** 切换离线模式 */
  toggleOfflineMode(): boolean {
    if (this.offlineMode) {
      this.disableOfflineMode();
    } else {
      this.enableOfflineMode('manual');
    }
    return this.offlineMode;
  }

  // ============ 离线知识库 ============

  /** 查询离线知识库（关键词匹配 + TF-IDF 评分） */
  queryOfflineKnowledge(query: string, limit: number = 5): OfflineKnowledgeQueryResult[] {
    const keywords = this.extractKeywords(query);
    if (keywords.length === 0) return [];

    const results: OfflineKnowledgeQueryResult[] = [];
    for (const entry of this.knowledge.values()) {
      const matchedKeywords: string[] = [];
      let score = 0;

      // topic 完全匹配加权
      if (entry.topic.toLowerCase().includes(query.toLowerCase())) {
        score += 50;
      }

      // 关键词匹配
      for (const kw of keywords) {
        const entryIds = this.keywordIndex.get(kw);
        if (entryIds?.has(entry.id)) {
          score += 20;
          matchedKeywords.push(kw);
        }
        // 内容包含关键词
        if (entry.content.toLowerCase().includes(kw)) {
          score += 5;
          if (!matchedKeywords.includes(kw)) {
            matchedKeywords.push(kw);
          }
        }
      }

      if (score > 0) {
        results.push({ entry, score, matchedKeywords });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** 添加自定义离线知识 */
  addOfflineKnowledge(entry: Omit<OfflineKnowledgeEntry, 'id'> & Partial<Pick<OfflineKnowledgeEntry, 'id'>>): { success: boolean; id?: string; error?: string } {
    if (!entry.topic || !entry.content) {
      return { success: false, error: 'topic 和 content 不能为空' };
    }
    const id = entry.id ?? `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fullEntry: OfflineKnowledgeEntry = {
      id,
      topic: entry.topic,
      content: entry.content,
      tags: entry.tags ?? [],
      category: entry.category ?? 'custom',
      source: entry.source ?? 'user',
    };
    this.knowledge.set(id, fullEntry);
    this.indexEntry(fullEntry);
    this.persistKnowledge();
    this.log.info('添加离线知识', { id, topic: entry.topic });
    return { success: true, id };
  }

  /** 删除离线知识 */
  removeOfflineKnowledge(id: string): { success: boolean; error?: string } {
    if (!this.knowledge.has(id)) {
      return { success: false, error: `条目 "${id}" 不存在` };
    }
    this.knowledge.delete(id);
    // 清理关键词索引
    for (const [kw, ids] of this.keywordIndex) {
      ids.delete(id);
      if (ids.size === 0) {
        this.keywordIndex.delete(kw);
      }
    }
    this.persistKnowledge();
    return { success: true };
  }

  /** 获取所有离线知识条目 */
  getAllKnowledge(): OfflineKnowledgeEntry[] {
    return Array.from(this.knowledge.values());
  }

  /** 按分类获取离线知识 */
  getKnowledgeByCategory(category: string): OfflineKnowledgeEntry[] {
    return Array.from(this.knowledge.values()).filter(e => e.category === category);
  }

  // ============ 统计 ============

  getStats(): OfflineStats {
    return {
      networkState: this.networkState,
      offlineMode: this.offlineMode,
      offlineModeSource: this.offlineModeSource,
      lastCheckedAt: this.lastCheckedAt,
      onlineCheckCount: this.onlineCheckCount,
      offlineCheckCount: this.offlineCheckCount,
      localModelCount: this.localModels.length,
      knowledgeEntryCount: this.knowledge.size,
      uptime: Date.now() - this.startedAt,
    };
  }

  // ============ LLM 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'offline_status',
        description: '获取离线协调器状态（网络状态/离线模式/本地模型数/知识库条目数/检查次数）',
        parameters: {},
        readOnly: true,
        execute: async () => JSON.stringify(this.getStats()),
      },
      {
        name: 'offline_probe',
        description: '主动探测网络连通性（多端点轮询，返回当前网络状态和延迟）',
        parameters: {},
        readOnly: true,
        execute: async () => {
          const record = await this.probe();
          return JSON.stringify(record);
        },
      },
      {
        name: 'offline_mode_toggle',
        description: '启用/禁用/切换离线模式（离线模式下优先使用本地模型和离线工具）',
        parameters: {
          action: { type: 'string', description: '操作：enable|disable|toggle', required: true },
          source: { type: 'string', description: '来源标记：auto|manual|startup，默认 manual', required: false },
        },
        execute: async (args: { action: string; source?: OfflineModeSource }) => {
          const source = args.source ?? 'manual';
          if (args.action === 'enable') {
            this.enableOfflineMode(source);
          } else if (args.action === 'disable') {
            this.disableOfflineMode();
          } else if (args.action === 'toggle') {
            this.toggleOfflineMode();
          } else {
            return JSON.stringify({ success: false, error: 'action 必须为 enable|disable|toggle' });
          }
          return JSON.stringify({ success: true, offlineMode: this.offlineMode, source: this.offlineModeSource });
        },
      },
      {
        name: 'offline_models_detect',
        description: '检测本地可用的 AI 模型（Ollama 实例 + llama.cpp 二进制 + GGUF 模型文件）',
        parameters: {},
        execute: async () => {
          const models = await this.detectLocalModels();
          return JSON.stringify({
            count: models.length,
            models: models.map(m => ({
              type: m.type,
              name: m.name,
              endpoint: m.endpoint,
              capabilities: m.capabilities,
              sizeMB: m.sizeBytes ? Math.round(m.sizeBytes / 1024 / 1024) : undefined,
            })),
          });
        },
      },
      {
        name: 'offline_models_list',
        description: '列出已检测到的本地模型（不触发重新检测）',
        parameters: {},
        readOnly: true,
        execute: async () => {
          const models = this.getLocalModels();
          return JSON.stringify({
            count: models.length,
            models: models.map(m => ({
              type: m.type,
              name: m.name,
              endpoint: m.endpoint,
              capabilities: m.capabilities,
            })),
          });
        },
      },
      {
        name: 'offline_knowledge_query',
        description: '查询离线知识库（内置编程文档摘要：TS/Python/Git/Linux/正则/HTTP/SQL/Docker/npm/VSCode + 用户自定义）',
        parameters: {
          query: { type: 'string', description: '查询关键词', required: true },
          limit: { type: 'number', description: '最多返回数，默认5', required: false },
        },
        readOnly: true,
        execute: async (args: { query: string; limit?: number }) => {
          const results = this.queryOfflineKnowledge(args.query, args.limit);
          return JSON.stringify({
            count: results.length,
            results: results.map(r => ({
              id: r.entry.id,
              topic: r.entry.topic,
              category: r.entry.category,
              score: r.score,
              matchedKeywords: r.matchedKeywords,
              content: r.entry.content,
            })),
          });
        },
      },
      {
        name: 'offline_knowledge_add',
        description: '添加自定义离线知识条目（断网时可查询）',
        parameters: {
          topic: { type: 'string', description: '主题', required: true },
          content: { type: 'string', description: '内容', required: true },
          tags_json: { type: 'string', description: '标签 JSON 数组，如 ["a","b"]', required: false },
          category: { type: 'string', description: '分类，默认 custom', required: false },
        },
        execute: async (args: { topic: string; content: string; tags_json?: string; category?: string }) => {
          let tags: string[] = [];
          if (args.tags_json) {
            try {
              tags = JSON.parse(args.tags_json);
            } catch {
              return JSON.stringify({ success: false, error: 'tags_json 解析失败' });
            }
          }
          const result = this.addOfflineKnowledge({
            topic: args.topic,
            content: args.content,
            tags,
            category: args.category ?? 'custom',
            source: 'user',
          });
          return JSON.stringify(result);
        },
      },
      {
        name: 'offline_knowledge_list',
        description: '列出离线知识库所有条目（支持按分类过滤）',
        parameters: {
          category: { type: 'string', description: '过滤分类，不填则返回全部', required: false },
        },
        readOnly: true,
        execute: async (args: { category?: string }) => {
          const list = args.category ? this.getKnowledgeByCategory(args.category) : this.getAllKnowledge();
          return JSON.stringify({
            count: list.length,
            entries: list.map(e => ({
              id: e.id,
              topic: e.topic,
              category: e.category,
              tags: e.tags,
              source: e.source,
            })),
          });
        },
      },
    ];
  }

  // ============ 持久化 ============

  private loadStatus(): void {
    try {
      if (!fs.existsSync(this.statusPath)) return;
      const data = JSON.parse(fs.readFileSync(this.statusPath, 'utf-8')) as {
        networkState?: NetworkState;
        lastCheckedAt?: number;
        onlineCheckCount?: number;
        offlineCheckCount?: number;
        history?: NetworkStatusRecord[];
      };
      this.networkState = data.networkState ?? 'unknown';
      this.lastCheckedAt = data.lastCheckedAt ?? null;
      this.onlineCheckCount = data.onlineCheckCount ?? 0;
      this.offlineCheckCount = data.offlineCheckCount ?? 0;
      this.history = data.history ?? [];
    } catch {
      // 降级为默认值
    }
  }

  private persistStatus(): void {
    atomicWriteJsonSync(this.statusPath, {
      networkState: this.networkState,
      lastCheckedAt: this.lastCheckedAt,
      onlineCheckCount: this.onlineCheckCount,
      offlineCheckCount: this.offlineCheckCount,
      history: this.history,
    });
  }

  private loadModels(): void {
    try {
      if (!fs.existsSync(this.modelsPath)) return;
      const data = JSON.parse(fs.readFileSync(this.modelsPath, 'utf-8')) as { models?: LocalModelInfo[] };
      this.localModels = data.models ?? [];
    } catch {
      this.localModels = [];
    }
  }

  private persistModels(): void {
    atomicWriteJsonSync(this.modelsPath, { models: this.localModels, detectedAt: this.lastModelDetectedAt });
  }

  private loadKnowledge(): void {
    try {
      if (!fs.existsSync(this.knowledgePath)) return;
      const data = JSON.parse(fs.readFileSync(this.knowledgePath, 'utf-8')) as { entries?: OfflineKnowledgeEntry[] };
      for (const entry of data.entries ?? []) {
        if (entry.id && entry.topic) {
          this.knowledge.set(entry.id, entry);
          this.indexEntry(entry);
        }
      }
    } catch {
      // 降级为空
    }
  }

  private persistKnowledge(): void {
    const entries = Array.from(this.knowledge.values());
    atomicWriteJsonSync(this.knowledgePath, { entries });
  }

  private loadMode(): void {
    try {
      if (!fs.existsSync(this.modePath)) return;
      const data = JSON.parse(fs.readFileSync(this.modePath, 'utf-8')) as { offlineMode?: boolean; source?: OfflineModeSource };
      this.offlineMode = data.offlineMode ?? false;
      this.offlineModeSource = data.source ?? null;
    } catch {
      // 降级为 false
    }
  }

  private persistMode(): void {
    atomicWriteJsonSync(this.modePath, {
      offlineMode: this.offlineMode,
      source: this.offlineModeSource,
      updatedAt: Date.now(),
    });
  }

  // ============ 知识库索引 ============

  private injectBuiltinKnowledge(): void {
    for (const entry of BUILTIN_KNOWLEDGE) {
      if (!this.knowledge.has(entry.id)) {
        this.knowledge.set(entry.id, entry);
        this.indexEntry(entry);
      }
    }
    this.persistKnowledge();
  }

  private indexEntry(entry: OfflineKnowledgeEntry): void {
    // topic 分词
    const topicWords = this.extractKeywords(entry.topic);
    for (const w of topicWords) {
      const set = this.keywordIndex.get(w) ?? new Set<string>();
      set.add(entry.id);
      this.keywordIndex.set(w, set);
    }
    // tags 索引
    for (const tag of entry.tags) {
      const tagLower = tag.toLowerCase();
      const set = this.keywordIndex.get(tagLower) ?? new Set<string>();
      set.add(entry.id);
      this.keywordIndex.set(tagLower, set);
    }
  }

  /** 从文本提取关键词（简单分词：英文按空格/标点，中文按字） */
  private extractKeywords(text: string): string[] {
    const lower = text.toLowerCase();
    // 英文单词
    const englishWords = lower.match(/[a-z]+/g) ?? [];
    // 中文（2-4 字组合）
    const chinese = lower.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [];
    // 过滤停用词
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'but', '的', '了', '是', '在', '和', '与']);
    return [...englishWords, ...chinese].filter(w => !stopWords.has(w) && w.length > 1);
  }
}

/** 获取单例 */
export function getOfflineCoordinator(): OfflineCoordinator {
  return OfflineCoordinator.getInstance();
}
