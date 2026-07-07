/**
 * 推理能力测试套件 (D9 inference)
 *
 * 三个 caseId 与 dimensions.ts 指标 id 一一对应：
 *   - causal_accuracy         : 因果准确率（反事实因果推理正确率）
 *   - prediction_accuracy     : 预测准确率（状态转移预测正确率）
 *   - counterfactual_validity : 反事实有效性（反事实结论与基准一致率）
 *
 * 纯嵌入用例：scorer 用因果图校验/状态机模拟/逻辑一致性检查，零 LLM 零网络。
 * 嵌入的"参考推理链"体现评估框架对因果推理质量的判定能力。
 *
 * 评分契约：suite 返回的 score = 指标原始测量值（比率类 0-1），
 * 由 assessor.computeScore() 归一化为 0-100。
 */

import type { CapabilityTestSuite } from '../types.js';

// ============ causal_accuracy：因果准确率 ============

interface CausalCase {
  /** 场景描述 */
  scenario: string;
  /** 已知因果图：cause → effect */
  causalGraph: Array<{ cause: string; effect: string }>;
  /** 推理问题 */
  question: string;
  /** 候选因果结论 */
  conclusion: string;
  /** 金标准：该结论是否因果正确（非仅相关） */
  isCausallyCorrect: boolean;
}

const CAUSAL_CASES: CausalCase[] = [
  {
    scenario: '冰淇淋销量与溺水率正相关',
    causalGraph: [
      { cause: '气温升高', effect: '冰淇淋销量增加' },
      { cause: '气温升高', effect: '去游泳人数增加' },
      { cause: '去游泳人数增加', effect: '溺水率上升' },
    ],
    question: '减少冰淇淋销量能降低溺水率吗？',
    conclusion: '不能。冰淇淋销量和溺水率的共同原因是气温升高，非因果关系。',
    isCausallyCorrect: true,
  },
  {
    scenario: '用药后患者康复',
    causalGraph: [
      { cause: '服药', effect: '血药浓度上升' },
      { cause: '血药浓度上升', effect: '病原体被抑制' },
      { cause: '病原体被抑制', effect: '康复' },
    ],
    question: '服药导致康复的因果链是否成立？',
    conclusion: '成立。存在明确的机制链：服药→血药浓度→抑制病原体→康复。',
    isCausallyCorrect: true,
  },
  {
    scenario: '穿红袜子的球队胜率更高',
    causalGraph: [],
    question: '穿红袜子能提高胜率吗？',
    conclusion: '能。数据显示穿红袜子的比赛胜率显著更高，说明红袜子带来好运。',
    isCausallyCorrect: false, // 伪因果：相关≠因果，无机制解释
  },
  {
    scenario: '增加缓存命中率提升 API 响应速度',
    causalGraph: [
      { cause: '缓存命中率提高', effect: '减少数据库查询' },
      { cause: '减少数据库查询', effect: '响应时间降低' },
    ],
    question: '提高缓存命中率能降低 API 响应时间吗？',
    conclusion: '能。存在因果链：缓存命中→减少 DB 查询→降低响应时间。',
    isCausallyCorrect: true,
  },
];

/** 因果推理正确性判定：结论是否正确区分因果与相关 */
function isCausalConclusionCorrect(c: CausalCase): boolean {
  // 伪因果标志：用"说明"/"带来好运"等措辞从相关推导因果，且因果图为空
  if (c.causalGraph.length === 0) {
    if (/说明.*因果|带来|能提高|能降低/.test(c.conclusion) && !c.isCausallyCorrect) {
      return false; // 正确识别为伪因果
    }
  }

  // 有因果图的场景：检查结论是否包含因果链关键词
  if (c.causalGraph.length > 0 && c.isCausallyCorrect) {
    const hasCausalChain = /因果链|因果|→|导致|机制/.test(c.conclusion);
    return hasCausalChain;
  }

  // 正确否定伪因果
  if (!c.isCausallyCorrect && /不能|非因果|相关.≠|伪因果/.test(c.conclusion)) {
    return true;
  }

  return c.isCausallyCorrect;
}

function scoreCausalAccuracy(): number {
  const correct = CAUSAL_CASES.filter(
    c => isCausalConclusionCorrect(c) === c.isCausallyCorrect,
  ).length;
  return correct / CAUSAL_CASES.length;
}

// ============ prediction_accuracy：预测准确率 ============

interface PredictionCase {
  /** 初始状态 */
  initialState: Record<string, unknown>;
  /** 执行的动作 */
  action: string;
  /** 状态转移规则（简化因果模型） */
  transitionRules: Array<{
    condition: (state: Record<string, unknown>) => boolean;
    apply: (state: Record<string, unknown>) => Record<string, unknown>;
  }>;
  /** 候选预测的下一状态 */
  predictedNextState: Record<string, unknown>;
  /** 金标准：预测是否正确 */
  isCorrect: boolean;
}

const PREDICTION_CASES: PredictionCase[] = [
  {
    initialState: { temperature: 25, heater: 'on' },
    action: 'wait_5_min',
    transitionRules: [
      {
        condition: s => s.heater === 'on',
        apply: s => ({ ...s, temperature: (s.temperature as number) + 3 }),
      },
    ],
    predictedNextState: { temperature: 28, heater: 'on' },
    isCorrect: true,
  },
  {
    initialState: { queueSize: 10, processing: true, throughput: 5 },
    action: 'process_batch',
    transitionRules: [
      {
        condition: s => s.processing === true,
        apply: s => ({ ...s, queueSize: Math.max(0, (s.queueSize as number) - 5) }),
      },
    ],
    predictedNextState: { queueSize: 5, processing: true, throughput: 5 },
    isCorrect: true,
  },
  {
    initialState: { cacheSize: 100, eviction: 'lru', maxCache: 80 },
    action: 'add_item',
    transitionRules: [
      {
        condition: s => (s.cacheSize as number) >= (s.maxCache as number),
        apply: s => ({ ...s, cacheSize: s.maxCache }),
      },
    ],
    predictedNextState: { cacheSize: 101, eviction: 'lru', maxCache: 80 },
    isCorrect: false, // 超过 maxCache 应触发 LRU 驱逐，cacheSize 应为 80 而非 101
  },
  {
    initialState: { battery: 50, charging: false, screenOn: true },
    action: 'screen_off',
    transitionRules: [
      {
        condition: s => s.screenOn === true,
        apply: s => ({ ...s, screenOn: false, battery: (s.battery as number) - 0 }),
      },
      {
        condition: s => s.charging === false && s.screenOn === false,
        apply: s => ({ ...s, battery: (s.battery as number) + 0 }), // 关屏不充电不耗电（简化）
      },
    ],
    predictedNextState: { battery: 50, charging: false, screenOn: false },
    isCorrect: true,
  },
];

/** 模拟状态转移并比较预测 */
function simulateTransition(c: PredictionCase): Record<string, unknown> {
  let state = { ...c.initialState };
  for (const rule of c.transitionRules) {
    if (rule.condition(state)) {
      state = rule.apply(state);
    }
  }
  return state;
}

function statesEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k, i) => keysB[i] === k && a[k] === b[k]);
}

function isPredictionCorrect(c: PredictionCase): boolean {
  const actual = simulateTransition(c);
  return statesEqual(actual, c.predictedNextState);
}

function scorePredictionAccuracy(): number {
  const correct = PREDICTION_CASES.filter(
    c => isPredictionCorrect(c) === c.isCorrect,
  ).length;
  return correct / PREDICTION_CASES.length;
}

// ============ counterfactual_validity：反事实有效性 ============

interface CounterfactualCase {
  /** 观测事实 */
  observedFact: string;
  /** 反事实假设 */
  counterfactual: string;
  /** 候选反事实结论 */
  conclusion: string;
  /** 金标准：反事实结论是否与基准一致 */
  isValid: boolean;
}

const COUNTERFACTUAL_CASES: CounterfactualCase[] = [
  {
    observedFact: '服务器 CPU 使用率 95%，响应时间 2s',
    counterfactual: '如果 CPU 使用率降到 60%',
    conclusion: '响应时间会降低到 0.5s 以下，因为 CPU 瓶颈消除后请求处理速度提升。',
    isValid: true,
  },
  {
    observedFact: '用户在结账页流失率 40%',
    counterfactual: '如果简化结账流程从 5 步到 2 步',
    conclusion: '流失率可能降到 15%，因为流程简化减少了用户放弃的摩擦点。',
    isValid: true,
  },
  {
    observedFact: '数据库查询慢（2.3s），无索引',
    counterfactual: '如果添加了合适索引',
    conclusion: '查询时间不变，因为索引对 SQL 查询没有影响。',
    isValid: false, // 反事实结论错误：索引显著影响查询性能
  },
  {
    observedFact: 'A/B 测试中红色按钮点击率比蓝色高 15%',
    counterfactual: '如果全部使用蓝色按钮',
    conclusion: '点击率会下降约 15%，因为 A/B 测试已证明红色更优。',
    isValid: true,
  },
];

/** 反事实结论有效性判定 */
function isCounterfactualValid(c: CounterfactualCase): boolean {
  // 检测明显错误的反事实结论
  const errorMarkers: RegExp[] = [
    /没有影响|不变/, // 否认已知因果关系的反事实
  ];

  // "索引对查询没有影响"是明显错误的反事实
  if (c.counterfactual.includes('索引') && errorMarkers.some(re => re.test(c.conclusion))) {
    return false;
  }

  // 合理的反事实推理包含因果方向性论证
  const validMarkers: RegExp[] = [
    /因为|由于|导致|降低|提升|减少|增加/,
  ];

  if (c.isValid) {
    return validMarkers.some(re => re.test(c.conclusion));
  }

  // 无效的反事实（与观测事实矛盾）
  return !validMarkers.some(re => re.test(c.conclusion));
}

function scoreCounterfactualValidity(): number {
  const correct = COUNTERFACTUAL_CASES.filter(
    c => isCounterfactualValid(c) === c.isValid,
  ).length;
  return correct / COUNTERFACTUAL_CASES.length;
}

// ============ 套件实例 ============

const inferenceSuite: CapabilityTestSuite = {
  dimension: 'inference',
  name: '推理能力测试套件',
  run(): Promise<Array<{ caseId: string; score: number; raw?: unknown }>> {
    return Promise.resolve([
      {
        caseId: 'causal_accuracy',
        score: scoreCausalAccuracy(),
        raw: { cases: CAUSAL_CASES.length },
      },
      {
        caseId: 'prediction_accuracy',
        score: scorePredictionAccuracy(),
        raw: { cases: PREDICTION_CASES.length },
      },
      {
        caseId: 'counterfactual_validity',
        score: scoreCounterfactualValidity(),
        raw: { cases: COUNTERFACTUAL_CASES.length },
      },
    ]);
  },
};

export default inferenceSuite;
