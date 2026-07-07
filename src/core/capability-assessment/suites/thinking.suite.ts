/**
 * 思考能力测试套件 (D1 thinking)
 *
 * 三个 caseId 与 dimensions.ts 指标 id 一一对应：
 *   - reasoning_depth           : 推理深度（多步分解题，scorer 检 ≥3 步）
 *   - hypothesis_falsifiability : 假设可证伪性（3 假设，scorer 判定与金标准一致率）
 *   - solution_validity         : 解法有效性（3 道逻辑题，关键词匹配正确率）
 *
 * 纯嵌入用例：scorer 用正则/关键词匹配，零 LLM 零网络。
 * 嵌入的推理 trace 是"参考解"——体现评估框架对推理质量的判定能力，
 * 为后续接入真实 agent trace 建立稳定基线。
 *
 * 评分契约：suite 返回的 score 字段 = 指标的原始测量值（比率类 0-1），
 * 由 assessor.computeScore() 归一化为 0-100。
 */

import type { CapabilityTestSuite } from '../types.js';

// ============ reasoning_depth：推理深度 ============

interface ReasoningCase {
  problem: string;
  trace: string;
}

const REASONING_CASES: ReasoningCase[] = [
  {
    problem: '排查"用户登录后立即被登出"的问题',
    trace: `1. 复现问题：清缓存后登录，观察 Network 面板
2. 检查 cookie 设置：发现 SameSite=None 但未设 Secure
3. 验证根因：Chrome 80+ 拒绝未设 Secure 的 SameSite=None cookie
4. 修复：在 Set-Cookie 加上 Secure 属性
5. 回归：再次登录确认 session 保持`,
  },
  {
    problem: '优化数据库慢查询',
    trace: `步骤1：EXPLAIN ANALYZE 查看执行计划，发现全表扫描
步骤2：检查 WHERE 条件字段是否有索引
步骤3：添加联合索引后查询从 2.3s 降至 12ms`,
  },
  {
    problem: '判断接口返回 500 是否是后端 bug',
    trace: `查看日志发现是参数校验失败返回 500。
应该是 400 而不是 500。`,
  },
];

/**
 * 统计推理 trace 中的分解步骤数：
 * 匹配数字编号 (1. / 1、 / 1))、"步骤N"、或 bullet (- /*) 开头的行
 */
function countDecompositionSteps(trace: string): number {
  const lines = trace.split('\n');
  return lines.filter(l => /^\s*(\d+[.、)]|步骤\s*\d|[-*]\s)/.test(l)).length;
}

function scoreReasoningDepth(): number {
  const passed = REASONING_CASES.filter(c => countDecompositionSteps(c.trace) >= 3).length;
  return passed / REASONING_CASES.length;
}

// ============ hypothesis_falsifiability：假设可证伪性 ============

interface HypothesisCase {
  hypothesis: string;
  /** 人工标注的金标准：该假设是否可证伪 */
  isFalsifiable: boolean;
}

const HYPOTHESIS_CASES: HypothesisCase[] = [
  {
    hypothesis: '如果将缓存 TTL 从 5 分钟降至 1 分钟，缓存命中率会下降 10%-15%（可通过 A/B 测试观测命中率指标验证）',
    isFalsifiable: true,
  },
  {
    hypothesis: '用户流失是因为产品体验不好（无法通过具体观测证伪）',
    isFalsifiable: false,
  },
  {
    hypothesis: '将线程池从 200 降到 50 后，P99 延迟若上升超过 50ms 则假设"线程数不影响延迟"不成立',
    isFalsifiable: true,
  },
];

/** 可证伪性标记词：检测假设是否包含可观测/可测试的证伪条件 */
const FALSIFIABILITY_MARKERS: RegExp[] = [
  /如果?.{0,30}(则|那么).{0,20}(不成立|失败|下降|上升|为假)/,
  /可通过.{0,20}(验证|观测|测试|测量|实验)/,
  /若.{0,30}(则|那么).{0,15}(不|失败|下降|上升)/,
  /A\/B\s*测试/,
  /可(观测|测量|量化)/,
  /指标.*(验证|判定)/,
];

function isFalsifiable(hypothesis: string): boolean {
  return FALSIFIABILITY_MARKERS.some(re => re.test(hypothesis));
}

function scoreHypothesisFalsifiability(): number {
  const correct = HYPOTHESIS_CASES.filter(
    c => isFalsifiable(c.hypothesis) === c.isFalsifiable,
  ).length;
  return correct / HYPOTHESIS_CASES.length;
}

// ============ solution_validity：解法有效性 ============

interface LogicPuzzle {
  question: string;
  candidateAnswer: string;
  /** 正确答案的关键词（正则字符串，匹配到即判正确） */
  correctAnswerPattern: string;
}

const LOGIC_PUZZLES: LogicPuzzle[] = [
  {
    question: '甲乙丙三人，甲说"乙在说谎"，乙说"丙在说谎"，丙说"甲和乙都在说谎"。谁说真话？',
    candidateAnswer: '乙说真话。推理：假设甲说真话→乙说谎→丙说真话→甲说谎，矛盾。故甲说谎→乙说真话→丙说谎，自洽。',
    correctAnswerPattern: '乙',
  },
  {
    question: '一个笼子里有鸡和兔，共 35 个头 94 只脚，鸡和兔各多少？',
    candidateAnswer: '设鸡 x 只兔 y 只。x+y=35, 2x+4y=94。解得 x=23, y=12。鸡 23 只兔 12 只。',
    correctAnswerPattern: '鸡.?23|23.*鸡|x\\s*=\\s*23',
  },
  {
    question: '如果今天是周三，那么"后天的大前天"是星期几？',
    candidateAnswer: '今天是周三。后天=周五，大前天=从周五往前数三天=周二。答案是周二。',
    correctAnswerPattern: '周二|星期二',
  },
];

function scoreSolutionValidity(): number {
  let correct = 0;
  for (const p of LOGIC_PUZZLES) {
    const re = new RegExp(p.correctAnswerPattern, 'i');
    if (re.test(p.candidateAnswer)) correct++;
  }
  return correct / LOGIC_PUZZLES.length;
}

// ============ 套件实例 ============

const thinkingSuite: CapabilityTestSuite = {
  dimension: 'thinking',
  name: '思考能力测试套件',
  run(): Promise<Array<{ caseId: string; score: number; raw?: unknown }>> {
    return Promise.resolve([
      {
        caseId: 'reasoning_depth',
        score: scoreReasoningDepth(),
        raw: { cases: REASONING_CASES.length, threshold: 3 },
      },
      {
        caseId: 'hypothesis_falsifiability',
        score: scoreHypothesisFalsifiability(),
        raw: { cases: HYPOTHESIS_CASES.length },
      },
      {
        caseId: 'solution_validity',
        score: scoreSolutionValidity(),
        raw: { puzzles: LOGIC_PUZZLES.length },
      },
    ]);
  },
};

export default thinkingSuite;
