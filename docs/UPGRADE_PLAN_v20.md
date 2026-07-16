# 段先生 v20.0 全方位升级优化方案

> 基于 Claude Code / Cursor / Devin / MetaGPT / AutoGPT 等主流 Agent 深度对标分析，结合国产操作系统（统信 UOS / 麒麟 Kylin）适配需求，制定 v19.0 → v20.0 升级路线图。

---

## 一、现状评估

### 1.1 已具备的核心优势（保持强化）

| 维度 | 现有能力 |
|------|---------|
| 三端架构 | CLI / Web / Desktop 共享 bootstrap，已实现 |
| 主循环 | Plan/Execute/Reflect/Learn 四阶段闭环 |
| 工具系统 | 140+ 内置工具 + 智能选择器 + 三层熔断 |
| 记忆系统 | 分层记忆 L0/L1/L2 + FTS5 + 向量检索 + 知识图谱 |
| 自进化 | Gödel Agent + 代码 git 快照 + 自愈 + 竞品对比 |
| 多 Agent | SubAgent / Team / Three-Agent / Handoff / Background |
| 安全 | 4 级沙箱 + RBAC/ABAC + AES-256-GCM + AuditLogger |
| MCP | 3 种传输 + 三层防护 |
| 模型层 | 60+ 内置模型 + LRU + 供应商热切换 |

### 1.2 对标主流 Agent 的关键差距

| 对标产品 | 对方优势 | 我们的差距 | 升级方向 |
|---------|---------|-----------|---------|
| **Claude Code** | CLAUDE.md 多层级记忆文件 | 项目级约定只在 project_memory，未分层到仓库/子目录 | §2.1 项目记忆分层 |
| Claude Code | 扩展思考 4 级预算（think < think hard < think harder < ultrathink） | 仅 6 阶段固定思考，无预算分级 | §2.2 思考预算分级 |
| Claude Code | Subagent 并行 + 专用子代理 | 已有 SubAgent 但未做"专用子代理"预设 | §2.3 专用子代理预设 |
| Claude Code | 自定义斜杠命令（.claude/commands/*.md） | 无用户自定义命令机制 | §2.4 斜杠命令系统 |
| Claude Code | 工具许可清单 4 种管理方式 | 仅 RBAC，缺会话级/项目级许可 | §2.5 分级许可清单 |
| **Cursor** | 代码库索引（向量嵌入 + 语义检索） | 有 FTS5 + 向量，但未对全项目建索引 | §3.1 代码库语义索引 |
| Cursor | 动态上下文发现（文件作为原语，按需发现） | 上下文需用户指定，无主动发现 | §3.2 动态上下文发现 |
| Cursor | 多文件协同编辑 | 单文件工具为主 | §3.3 多文件协同 |
| **Devin** | 全自主沙箱 VM（端到端构建部署） | 沙箱有，但未做"全自主工程任务" | §3.4 自主工程任务 |
| Devin | 自主训练/微调模型 | 无 | §3.5 模型微调能力 |
| **MetaGPT** | 多角色协作（PM/架构师/工程师） | 多 Agent 有，但无"角色人格" | §3.6 角色人格系统 |
| **AutoGPT** | 长期目标分解 + 自主迭代 | 主循环有，但缺"长期目标追踪" | §3.7 长期目标追踪 |

---

## 二、超强大脑升级（核心智能层）

### 2.1 项目记忆分层（对标 CLAUDE.md）

**目标**：建立 `~/.duan/memory/` + `<repo>/.duan/memory/` + `<subdir>/.duan/memory/` 三级记忆体系。

**实现要点**：
- 新增 `ProjectMemoryLoader`：启动时扫描当前工作目录向上递归查找 `.duan/memory/*.md`
- 优先级：子目录 > 仓库根 > 用户全局，后者被前者覆盖
- 内容注入：加载到 `enhancedSystemPrompt` 的 `项目约定` 区块
- `/memory` 命令：运行时查看/编辑/合并记忆文件
- 自动学习：用户每次说"记住这个"时，自动写入对应层级的 `.duan/memory/conventions.md`

### 2.2 思考预算分级（对标 ultrathink）

**目标**：从固定 6 阶段思考升级为 4 级可调预算。

**实现要点**：
- 关键词触发：`想一下`（L1）< `仔细想`（L2）< `深入思考`（L3）< `极限思考`（L4）
- L1：仅 CoT 单阶段，~500 tokens
- L2：CoT + 边缘情况，~1500 tokens
- L3：完整 6 阶段（问题分解/约束/方案/边缘/风险/经验），~3000 tokens
- L4：6 阶段 + ToT 树搜索（3 分支并行）+ Gödel 自指校验，~6000 tokens
- `ExtendedThinkingService` 扩展 `budget` 参数，按级别动态裁剪阶段深度

### 2.3 专用子代理预设（对标 Claude Code Subagents）

**目标**：预置 8 类专用子代理，用户可一键调用或主循环自动派发。

**预设子代理**：
1. **代码审查员**：专做 PR review，检查风格/安全/性能
2. **测试工程师**：专写测试，TDD 流程
3. **架构师**：专做系统设计，输出架构图
4. **调试专家**：专做 bug 定位，日志分析
5. **文档撰写者**：专写 README/API 文档
6. **安全审计员**：专做漏洞扫描
7. **性能优化师**：专做 profiling + 优化
8. **研究助理**：专做技术调研，Web 搜索

**实现要点**：
- 新增 `src/agents/presets/` 目录，每类一个 `.ts` 文件，导出 `{ name, systemPrompt, tools, model }`
- `SubAgentOrchestrator` 新增 `dispatchPreset(name, task)` 方法
- 主循环通过意图识别自动派发（如检测到"审查"关键词 → 代码审查员）
- 用户可 `/subagent code-reviewer 审查 src/ 的安全性` 直接调用

### 2.4 斜杠命令系统（对标 .claude/commands）

**目标**：用户可创建自定义命令模板，支持 `$ARGUMENTS` 占位符。

**实现要点**：
- 命令目录：`~/.duan/commands/*.md`（全局）+ `<repo>/.duan/commands/*.md`（项目级）
- 文件名即命令名：`fix-issue.md` → `/fix-issue`
- 模板支持：`$ARGUMENTS`（参数）、`$CLIPBOARD`（剪贴板）、`$FILE:path`（文件内容）
- 内置命令示例：`/init`（生成 .duan/memory）、`/review`、`/test`、`/deploy`
- CLI / Web / Desktop 三端统一支持

### 2.5 分级许可清单（对标 Claude Code permissions）

**目标**：4 种方式管理工具许可，提升安全与便利平衡。

**实现要点**：
- 会话级：用户说"允许文件编辑" → 当前会话生效
- 项目级：`.duan/settings.json` 的 `allowedTools` 数组
- 全局级：`~/.duan/settings.json`
- CLI 标志：`duan --allow Edit --allow "Bash(git:*)"` 
- 与现有 RBAC 融合：RBAC 管角色，许可清单管会话级覆盖

---

## 三、工程能力升级（对标 Cursor / Devin）

### 3.1 代码库语义索引（对标 Cursor codebase indexing）

**目标**：对整个项目建立向量索引，支持"这个函数在哪用"、"日志系统怎么工作"等语义查询。

**实现要点**：
- 新增 `CodebaseIndexer`：
  - AST 解析（TypeScript / JavaScript / Python / Java / Go / Rust）
  - 符号提取（函数/类/变量定义 + 引用）
  - 向量化（复用现有 embedding 模型）
  - 增量更新（文件变更时仅重索引该文件）
- 索引存储：`<repo>/.duan/index/`（SQLite + FTS5 + 向量）
- 查询接口：`searchSemantic(query)` / `findReferences(symbol)` / `getCallGraph()`
- 与 `SmartToolSelector` 联动：检测到代码任务时自动查询索引

### 3.2 动态上下文发现（对标 Cursor dynamic discovery）

**目标**：Agent 主动发现相关文件，而非用户指定。

**实现要点**：
- `ContextDiscoverer`：
  - 从用户问题提取关键词 → 查代码库索引
  - 从当前打开文件 → 找相关文件（import / 调用关系）
  - 从 git diff → 找最近变更文件
- 上下文预算：token 限制下动态裁剪（保留最相关 N 个文件）
- 透明化：在思考阶段输出"我发现这些文件相关：..."

### 3.3 多文件协同编辑

**目标**：一次任务跨多个文件修改，保持一致性。

**实现要点**：
- `MultiFileEditor` 工具：接收 `{ edits: [{file, oldString, newString}, ...] }`
- 原子性：全部成功才提交，任一失败回滚
- 一致性校验：修改后自动跑 typecheck / lint
- 与 `CodebaseIndexer` 联动：修改函数定义时提示更新所有引用

### 3.4 自主工程任务（对标 Devin）

**目标**：接收高层需求 → 自主完成"设计 + 编码 + 测试 + 部署"全链路。

**实现要点**：
- `AutonomousEngineer` 模式：
  - 输入："实现一个用户登录功能"
  - 自主分解：数据库 schema → API → 前端 → 测试 → 文档
  - 每步调用对应专用子代理
  - 沙箱内执行，失败自动回滚 + 重试
- 部署能力：集成 Docker / k8s / Vercel / Netlify 部署工具
- 端到端验证：部署后自动跑端到端测试

### 3.5 模型微调能力

**目标**：基于用户历史数据微调本地模型（Ollama / llama.cpp）。

**实现要点**：
- 新增 `ModelFineTuner`：
  - 数据收集：从 `SelfLearningSystem` 提取高质量 Q&A 对
  - 数据格式化：LoRA / QLoRA 训练数据格式
  - 训练调度：调用 `ollama train` 或 `llama.cpp` fine-tune
  - 模型注册：训练完成后自动注册到 `ModelLibrary`
- 隐私保护：微调数据不出本地

### 3.6 角色人格系统（对标 MetaGPT）

**目标**：为子代理注入"职业人格"，提升输出质量。

**实现要点**：
- `PersonaSystem`：
  - 每个角色有独立人格档案：技能树 / 思维方式 / 输出风格 / 知识库
  - 角色间通信协议（如架构师输出 → 工程师接收）
- 预设角色：产品经理 / 架构师 / 前端工程师 / 后端工程师 / 测试工程师 / DevOps / 技术作家
- 用户可自定义角色：`/persona create "数据科学家" --skills "Python,SQL,ML"`

### 3.7 长期目标追踪（对标 AutoGPT）

**目标**：支持长期目标分解 + 进度追踪 + 自主迭代。

**实现要点**：
- `GoalTracker`：
  - 目标树：长期目标 → 里程碑 → 子任务
  - 进度持久化：`~/.duan/goals/<goal-id>.json`
  - 自主迭代：检测到空闲时，自动推进下一个子任务
  - 中断恢复：启动时加载未完成目标，询问是否继续
- 目标模板：`重构项目` / `学习新技术` / `完成产品迭代`

---

## 四、国产操作系统适配

### 4.1 目标系统与架构

| 系统 | 版本 | CPU 架构 | 内核基础 |
|------|------|---------|---------|
| 统信 UOS | V20 / V25 | x86_64 / ARM64 / LoongArch64 | Debian |
| 银河麒麟 | V10 / SP1 / SP3 | x86_64 / ARM64（飞腾/鲲鹏）/ LoongArch64（龙芯） | Ubuntu / CentOS |
| 麒麟桌面版 | V10 | x86_64 / ARM64 | Ubuntu |

### 4.2 适配策略（分层）

#### 4.2.1 Node.js 运行时适配
- **x86_64**：官方 Node.js 二进制直接可用
- **ARM64**：官方提供 ARM64 二进制（飞腾/鲲鹏可用）
- **LoongArch64**：需用龙芯团队维护的 [loongnix-node](https://github.com/loongson/)，或源码编译
- **检测脚本**：`scripts/check-native-env.sh` 自动检测架构并提示安装方式

#### 4.2.2 Electron 桌面端适配
- **关键约束**：Electron 必须在目标 Linux 环境打包（跨平台打包会失败）
- **方案**：
  - 新增 `scripts/build-linux.sh`：在 Linux 环境（含 Docker）执行 `electron-builder --linux`
  - 目标格式：`AppImage`（通用）+ `deb`（UOS/麒麟）+ `rpm`（麒麟服务器版）
  - 架构矩阵：`x64` + `arm64`（LoongArch 暂不支持 Electron 官方，需评估）

#### 4.2.3 原生依赖替换
| 当前依赖 | 问题 | 替换方案 |
|---------|------|---------|
| `puppeteer` | 下载 Chromium 二进制，不支持 LoongArch | 改用系统 Chrome / Chromium（UOS/麒麟预装或源内） |
| `screenshot-desktop` | 调用平台特定二进制 | 已跨平台，但需测试 ARM64 |
| `ffmpeg-static` | 静态二进制不支持 LoongArch | 改用系统 ffmpeg（`apt install ffmpeg`） |
| `electron` | 官方不支持 LoongArch | LoongArch 版 Electron（龙芯社区维护） |

#### 4.2.4 系统集成
- **桌面快捷方式**：生成 `.desktop` 文件（UOS/麒麟标准）
- **系统托盘**：Electron Tray 在 Linux 使用 AppIndicator，需装 `libappindicator-gtk3`
- **文件关联**：注册 MIME 类型
- **自启动**：写入 `~/.config/autostart/`
- **软件源**：构建 `.deb` 上传 UOS 软件商店 / 麒麟软件仓库

#### 4.2.5 系统服务适配
- **systemd 服务**：提供 `duan-agent.service`，支持开机自启
- **D-Bus 集成**：注册系统服务，支持其他应用调用
- **通知中心**：对接 UOS/麒麟通知中心（`notify-send`）
- **输入法**：确保 Electron 支持 fcitx / ibus

### 4.3 适配验证清单

- [ ] x86_64 UOS V20：CLI / Web / Desktop 三端启动
- [ ] ARM64（飞腾）麒麟 V10：CLI / Web / Desktop
- [ ] LoongArch64 麒麟 V10：CLI / Web（Desktop 待 Electron 支持）
- [ ] 系统托盘 / 桌面快捷方式 / 自启动
- [ ] 截图 / 浏览器自动化（puppeteer + 系统 Chromium）
- [ ] 语音 TTS（系统 ffmpeg）
- [ ] 中文输入法（fcitx）
- [ ] 软件包安装（.deb / .rpm）

### 4.4 国产化增强功能

- **WPS 集成**：办公工具支持 WPS（UOS/麒麟预装）
- **统信签名**：`.deb` 包使用统信开发者签名（上架软件商店要求）
- **麒麟安全策略**：适配麒麟 SEC_buf 安全模块
- **国密算法**：配置加密从 AES-256-GCM 增加 SM4 选项（国密合规）

---

## 五、其他差异化升级

### 5.1 多模态能力增强
- 语音输入：集成 Whisper / 阿里语音识别
- 图像理解：复用 `ModelLibrary.call()` 的 vision 能力
- 屏幕理解：截图 + 视觉模型分析（对标 Devin）
- 文档解析：PDF / Word / Excel / PPT 内容提取

### 5.2 离线能力
- 本地模型优先：检测 Ollama / llama.cpp，默认走本地
- 离线工具包：基础文件操作 / 计算器 / 日历不依赖网络
- 知识库离线：内置维基百科摘要 / 编程文档快照

### 5.3 协作能力
- 多用户共享会话：WebSocket 实时协作
- 团队知识库：共享 `.duan/memory/` 到团队
- 任务派发：团队成员任务分配与追踪

### 5.4 学习增强
- 主动提问：检测到知识盲区时主动问用户
- 技能市场：用户分享自定义斜杠命令 / 子代理 / 角色
- 进度可视化：学习曲线 / 能力雷达图

---

## 六、实施优先级建议

### P0（核心突破，2-4 周）
1. §2.1 项目记忆分层 — 立即提升所有任务的上下文质量
2. §2.2 思考预算分级 — 复杂问题解决能力质变
3. §3.1 代码库语义索引 — 代码任务体验质变
4. §4.2 国产系统基础适配（x86_64 + ARM64）— 满足国产化要求

### P1（工程能力，4-8 周）
5. §2.3 专用子代理预设 — 任务自动化质变
6. §3.2 动态上下文发现 — 减少用户手动指定
7. §3.3 多文件协同编辑 — 大型重构能力
8. §2.4 斜杠命令系统 — 用户自定义工作流
9. §4.4 国产化增强（WPS / 国密 / 签名）

### P2（差异化，8-12 周）
10. §3.4 自主工程任务（Devin 能力）
11. §3.6 角色人格系统
12. §2.5 分级许可清单
13. §3.7 长期目标追踪
14. §5.1 多模态增强
15. §4.2.3 LoongArch64 适配

### P3（长期演进）
16. §3.5 模型微调能力
17. §5.2 离线能力增强
18. §5.3 协作能力
19. §5.4 学习增强

---

## 七、风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 升级影响现有功能 | 严格遵守项目约束：备份原程序 + 不改现有逻辑 + 可回滚 |
| LoongArch 生态不全 | 降级为 CLI/Web 模式，Desktop 待社区支持 |
| 索引占用磁盘 | 配置上限 + 增量更新 + 用户可关闭 |
| 子代理 token 消耗 | 预算控制 + 失败降级为单 Agent |
| 国密合规复杂度 | 保留 AES-256-GCM 默认，SM4 作为可选 |

---

## 八、验收标准

- **智能层**：复杂任务（如"重构认证模块"）可自主完成，人工干预 < 20%
- **工程层**：代码库语义查询准确率 > 85%，多文件编辑原子性 100%
- **国产化**：UOS / 麒麟 x86_64 + ARM64 三端可运行，通过统信/麒麟兼容性认证
- **差异化**：角色人格 / 长期目标 / 模型微调 至少完成 2 项
- **性能**：思考预算 L4 响应 < 30s，代码库索引 10k 文件 < 5min
