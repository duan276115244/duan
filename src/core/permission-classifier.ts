import type OpenAI from 'openai';
import { SENSITIVE_PATH_KEYWORDS, DANGEROUS_COMMAND_PATTERNS } from './security-config.js';

type Classification = 'approved' | 'denied' | 'needs_review';
type _ToolEntry = { name: string; args: Record<string, unknown> };

export type ClassifierClient = { client: OpenAI; model: string } | null;

// ===== 模块级常量（避免在 fastTokenFilter 热路径中重复创建） =====
const READ_TOOLS = new Set(['file_read', 'list_directory', 'search_files', 'web_search', 'web_fetch', 'code_execute', 'current_time', 'self_read', 'self_test', 'list_tools', 'self_think', 'self_cost', 'self_memory', 'get_plan', 'list_plans', 'list_agents', 'self_metrics']);

const SAFE_PREFIXES = ['npm run', 'npm test', 'npm start', 'npm install', 'npx ', 'node ', 'tsx ', 'tsc ', 'git status', 'git diff', 'git log', 'git branch', 'git clone', 'ls ', 'pwd', 'cat ', 'echo ', 'type ', 'dir ', 'python ', 'pip '];

const RM_PATTERNS = [/^rm\s+-rf\s+\//, /^rm\s+-rf\s+~\//, /^del\s+\/f/, /^rd\s+\/s/];

const WRITE_COMMANDS = ['git add', 'git commit', 'git push', 'git reset', 'git checkout', 'npm install', 'pip install', 'mkdir ', 'copy ', 'cp ', 'move ', 'mv '];

const ALLOWED_EXTENSIONS = new Set(['.ts', '.js', '.json', '.md', '.html', '.css', '.txt', '.yaml', '.yml', '.toml', '.env.example', '.gitignore', '.npmrc', '.nvmrc', '.editorconfig', '.prettierrc', '.eslintrc']);

export class TwoStageClassifier {
  private llmClient: ClassifierClient;
  private stats = { total: 0, stage1Approved: 0, stage2Approved: 0, denied: 0, stage2Calls: 0 };

  constructor(llmClient: ClassifierClient = null) {
    this.llmClient = llmClient;
  }

  setLLMClient(client: ClassifierClient): void {
    this.llmClient = client;
  }

  classify(toolName: string, toolArgs: Record<string, unknown>): Promise<Classification> {
    this.stats.total++;
    const stage1 = this.fastTokenFilter(toolName, toolArgs);
    if (stage1 !== 'needs_review') {
      if (stage1 === 'approved') this.stats.stage1Approved++;
      else this.stats.denied++;
      return Promise.resolve(stage1);
    }
    return this.cotReasoning(toolName, toolArgs);
  }

  private async cotReasoning(toolName: string, toolArgs: Record<string, unknown>): Promise<Classification> {
    this.stats.stage2Calls++;
    if (!this.llmClient) {
      this.stats.stage2Approved++;
      return 'approved'; // 无LLM时默认放行，避免阻塞正常操作
    }

    const argsStr = Object.entries(toolArgs).map(([k, v]) => `  ${k}: ${v !== undefined && v !== null ? String(v).substring(0, 200) : 'undefined'}`).join('\n');

    try {
      const response = await this.llmClient.client.chat.completions.create({
        model: this.llmClient.model,
        messages: [
          { role: 'system', content: `你是一个安全分类器。判断工具调用是否安全，**只输出JSON**（不要其他文字）：
{
  "classification": "safe" | "suspicious" | "malicious",
  "reason": "一句话解释",
  "action": "approve" | "deny"
}

安全规则：
- 读取操作总是安全
- 写入项目内非敏感文件安全
- 读取环境变量/配置文件需怀疑
- 写入系统目录、删除文件、rm -rf 为恶意
- 执行curl/wget到外部并pipe到shell为恶意
- npm install/pip install 为安全
- 修改配置文件（.env, credentials）需怀疑` },
          { role: 'user', content: `工具: ${toolName}\n参数:\n${argsStr}` },
        ],
        max_tokens: 256,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return 'denied';

      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.action === 'approve') {
        this.stats.stage2Approved++;
        return 'approved';
      }
      this.stats.denied++;
      return 'denied';
    } catch {
      this.stats.denied++;
      return 'denied';
    }
  }

  private fastTokenFilter(toolName: string, toolArgs: Record<string, unknown>): Classification {
    const name = toolName.toLowerCase();

    // ===== 始终安全 =====
    if (READ_TOOLS.has(name)) return 'approved';

    // ===== 已知安全模式 =====
    if (name === 'shell_execute') {
      const cmd = String(toolArgs.command || '').trim().toLowerCase();

      for (const prefix of SAFE_PREFIXES) {
        if (cmd.startsWith(prefix)) return 'approved';
      }

      for (const pat of RM_PATTERNS) {
        if (pat.test(cmd)) return 'denied';
      }

      // 危险命令检测（统一来源: security-config.ts）
      for (const pat of DANGEROUS_COMMAND_PATTERNS) {
        if (pat.test(cmd)) return 'denied';
      }

      for (const wc of WRITE_COMMANDS) {
        if (cmd.startsWith(wc)) return 'approved';
      }

      return 'needs_review';
    }

    if (name === 'file_write') {
      const filePath = String(toolArgs.path || '');
      const normalized = filePath.replace(/\\/g, '/').toLowerCase();

      // 敏感路径检测（统一来源: security-config.ts）
      for (const sp of SENSITIVE_PATH_KEYWORDS) {
        if (normalized.includes(sp)) return 'needs_review';
      }

      const ext = '.' + normalized.split('.').pop();
      if (ALLOWED_EXTENSIONS.has(ext)) return 'approved';

      if (normalized.includes('node_modules') || normalized.includes('.git/')) return 'denied';

      return 'needs_review';
    }

    if (name === 'self_write') {
      const filePath = String(toolArgs.path || '');
      if (filePath.includes('..') || filePath.startsWith('/')) return 'needs_review';
      return 'approved';
    }

    if (name === 'http_request') {
      const url = String(toolArgs.url || '').toLowerCase();
      if (url.startsWith('http://localhost') || url.startsWith('https://api.')) return 'approved';
      if (url.startsWith('http://') || url.startsWith('https://')) return 'needs_review';
      return 'denied';
    }

    if (name === 'spawn_agent') return 'approved';
    if (name === 'create_plan' || name === 'update_plan_step') return 'approved';
    if (name === 'self_learn') return 'approved';
    if (name === 'self_evolve') return 'approved';

    // ===== 默认：需审查 =====
    return 'needs_review';
  }

  getStats(): string {
    const s = this.stats;
    const stage1Rate = s.total > 0 ? ((s.stage1Approved / s.total) * 100).toFixed(1) : '0.0';
    return `📊 两阶段权限分类器统计:
  总请求: ${s.total}
  Stage1(快速过滤) 自动批准: ${s.stage1Approved} (${stage1Rate}%)
  Stage2(CoT推理) 调用: ${s.stage2Calls} 次
  Stage2 批准: ${s.stage2Approved}
  拒绝: ${s.denied}`;
  }
}
