/**
 * ModelFineTuner 测试 — §3.5 模型微调能力
 *
 * 覆盖：初始化 / 数据收集 / 数据格式化 / 数据集 / 训练任务 / 模型注册 / 持久化 / 统计 / LLM 工具 / 单例 / 边缘情况
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ModelFineTuner,
  getModelFineTuner,
  type FineTuningDataSource,
  type LearningRecordLite,
  type InteractionPairLite,
  type TrainingExample,
  type TrainingFormat,
  type TrainingJob,
  type DatasetInfo,
  type TrainedModelInfo,
  type TrainingJobConfig,
} from '../model-fine-tuner.js';

// ============ 测试工具 ============

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'finetuner-test-'));
}

function newFineTuner(): ModelFineTuner {
  const dir = path.join(tmpDir, 'finetune');
  const ft = new ModelFineTuner(dir);
  ft.initialize();
  return ft;
}

/** 构造 mock 数据源 */
function makeMockSource(overrides: Partial<FineTuningDataSource> = {}): FineTuningDataSource {
  return {
    getLearningRecords: () => [],
    getInteractionHistory: () => [],
    ...overrides,
  };
}

/** 构造学习记录 */
function makeRecord(overrides: Partial<LearningRecordLite> = {}): LearningRecordLite {
  const now = Date.now();
  return {
    id: `rec-${now}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'best_practice',
    category: 'coding',
    content: '使用 const 优于 let',
    context: '在 TypeScript 中声明变量',
    source: 'interaction',
    confidence: 0.9,
    frequency: 5,
    outcome: 'positive',
    tags: ['typescript', 'coding'],
    ...overrides,
  };
}

/** 构造交互对 */
function makeInteraction(overrides: Partial<InteractionPairLite> = {}): InteractionPairLite {
  const now = Date.now();
  return {
    id: `inter-${now}-${Math.random().toString(36).slice(2, 6)}`,
    input: '如何写一个 Promise',
    output: 'new Promise((resolve, reject) => { ... })',
    feedback: 'positive',
    timestamp: now,
    tags: ['javascript', 'async'],
    ...overrides,
  };
}

/** 等待训练任务完成 */
async function waitForJobCompletion(ft: ModelFineTuner, jobId: string, timeoutMs = 5000): Promise<TrainingJob> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = ft.getTrainingJobStatus(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return job;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`);
}

// ============ 测试用例 ============

describe('ModelFineTuner', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    ModelFineTuner._resetInstance();
  });

  afterEach(() => {
    ModelFineTuner._resetInstance();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ========== 初始化 ==========

  describe('初始化', () => {
    it('应创建数据目录并加载空数据', () => {
      const dir = path.join(tmpDir, 'finetune');
      const ft = new ModelFineTuner(dir);
      ft.initialize();
      expect(fs.existsSync(dir)).toBe(true);
      expect(ft.getStats().datasetCount).toBe(0);
      expect(ft.getStats().jobCount).toBe(0);
      expect(ft.getStats().trainedModelCount).toBe(0);
    });

    it('应注入内置冷启动样例', () => {
      const ft = newFineTuner();
      const examples = ft.listTrainingExamples();
      expect(examples.length).toBeGreaterThanOrEqual(3);
      expect(examples.some(e => e.tags.includes('builtin'))).toBe(true);
    });

    it('已存在样例时不重复注入', () => {
      const dir = path.join(tmpDir, 'finetune');
      const ft1 = new ModelFineTuner(dir);
      ft1.initialize();
      const count1 = ft1.listTrainingExamples().length;

      const ft2 = new ModelFineTuner(dir);
      ft2.initialize();
      const count2 = ft2.listTrainingExamples().length;

      expect(count2).toBe(count1);
    });

    it('应加载已持久化的数据', () => {
      const dir = path.join(tmpDir, 'finetune');
      const ft1 = new ModelFineTuner(dir);
      ft1.initialize();
      ft1.addTrainingExample({
        instruction: '测试指令',
        output: '测试输出',
        source: 'manual',
        confidence: 0.8,
        tags: ['test'],
      });
      const exampleCount = ft1.listTrainingExamples().length;

      const ft2 = new ModelFineTuner(dir);
      ft2.initialize();
      expect(ft2.listTrainingExamples().length).toBe(exampleCount);
    });

    it('多次 initialize 应幂等', () => {
      const ft = newFineTuner();
      const count = ft.listTrainingExamples().length;
      ft.initialize();
      ft.initialize();
      expect(ft.listTrainingExamples().length).toBe(count);
    });
  });

  // ========== 数据收集 ==========

  describe('数据收集', () => {
    it('无数据源应返回空', () => {
      const ft = newFineTuner();
      const collected = ft.collectTrainingData();
      expect(collected.length).toBe(0);
    });

    it('应从学习记录收集', () => {
      const ft = newFineTuner();
      ft.setDataSource(makeMockSource({
        getLearningRecords: () => [
          makeRecord({ id: 'r1', confidence: 0.9, frequency: 5, outcome: 'positive' }),
          makeRecord({ id: 'r2', confidence: 0.3, frequency: 1, outcome: 'negative' }),
        ],
      }));

      const collected = ft.collectTrainingData();
      expect(collected.length).toBe(1); // 只 r1 满足条件
      expect(collected[0].source).toBe('learning');
    });

    it('应从交互历史收集', () => {
      const ft = newFineTuner();
      ft.setDataSource(makeMockSource({
        getInteractionHistory: () => [
          makeInteraction({ id: 'i1', feedback: 'positive' }),
          makeInteraction({ id: 'i2', feedback: 'negative' }),
        ],
      }));

      const collected = ft.collectTrainingData({ requirePositiveOutcome: true });
      expect(collected.length).toBe(1);
      expect(collected[0].source).toBe('interaction');
    });

    it('应支持过滤负向结果', () => {
      const ft = newFineTuner();
      ft.setDataSource(makeMockSource({
        getLearningRecords: () => [
          makeRecord({ id: 'r1', outcome: 'positive' }),
          makeRecord({ id: 'r2', outcome: 'negative' }),
        ],
        getInteractionHistory: () => [
          makeInteraction({ id: 'i1', feedback: 'positive' }),
          makeInteraction({ id: 'i2', feedback: 'negative' }),
        ],
      }));

      const collected = ft.collectTrainingData({ requirePositiveOutcome: false });
      expect(collected.length).toBe(4);
    });

    it('应支持置信度阈值', () => {
      const ft = newFineTuner();
      ft.setDataSource(makeMockSource({
        getLearningRecords: () => [
          makeRecord({ id: 'r1', confidence: 0.95, frequency: 5, outcome: 'positive' }),
          makeRecord({ id: 'r2', confidence: 0.65, frequency: 5, outcome: 'positive' }),
        ],
      }));

      const collected = ft.collectTrainingData({ minConfidence: 0.9 });
      expect(collected.length).toBe(1);
    });

    it('应支持频率阈值', () => {
      const ft = newFineTuner();
      ft.setDataSource(makeMockSource({
        getLearningRecords: () => [
          makeRecord({ id: 'r1', frequency: 10, outcome: 'positive', confidence: 0.9 }),
          makeRecord({ id: 'r2', frequency: 1, outcome: 'positive', confidence: 0.9 }),
        ],
      }));

      const collected = ft.collectTrainingData({ minFrequency: 5 });
      expect(collected.length).toBe(1);
    });

    it('应支持 maxExamples 上限', () => {
      const ft = newFineTuner();
      const records: LearningRecordLite[] = [];
      for (let i = 0; i < 100; i++) {
        records.push(makeRecord({
          id: `r${i}`,
          confidence: 0.9,
          frequency: 5,
          outcome: 'positive',
        }));
      }
      ft.setDataSource(makeMockSource({ getLearningRecords: () => records }));

      const collected = ft.collectTrainingData({ maxExamples: 10 });
      expect(collected.length).toBe(10);
    });

    it('应支持禁用学习记录来源', () => {
      const ft = newFineTuner();
      ft.setDataSource(makeMockSource({
        getLearningRecords: () => [makeRecord({ id: 'r1', outcome: 'positive' })],
        getInteractionHistory: () => [makeInteraction({ id: 'i1', feedback: 'positive' })],
      }));

      const collected = ft.collectTrainingData({ includeLearning: false });
      expect(collected.length).toBe(1);
      expect(collected[0].source).toBe('interaction');
    });

    it('收集后应持久化到 examples.json', () => {
      const dir = path.join(tmpDir, 'finetune');
      const ft = new ModelFineTuner(dir);
      ft.initialize();
      ft.setDataSource(makeMockSource({
        getLearningRecords: () => [makeRecord({ id: 'r1', outcome: 'positive' })],
      }));

      ft.collectTrainingData();
      const examplesPath = path.join(dir, 'examples.json');
      expect(fs.existsSync(examplesPath)).toBe(true);
      const arr = JSON.parse(fs.readFileSync(examplesPath, 'utf-8'));
      expect(Array.isArray(arr)).toBe(true);
      // 内置 3 + 收集 1 = 4
      expect(arr.length).toBe(4);
    });

    it('应支持手动添加训练样例', () => {
      const ft = newFineTuner();
      const before = ft.listTrainingExamples().length;
      const ex = ft.addTrainingExample({
        instruction: '测试',
        output: '结果',
        source: 'manual',
        confidence: 0.9,
        tags: ['test'],
      });
      expect(ex.id).toBeDefined();
      expect(ft.listTrainingExamples().length).toBe(before + 1);
    });

    it('应支持删除训练样例', () => {
      const ft = newFineTuner();
      const ex = ft.addTrainingExample({
        instruction: '测试',
        output: '结果',
        source: 'manual',
        confidence: 0.9,
        tags: ['test'],
      });
      const before = ft.listTrainingExamples().length;
      const removed = ft.removeTrainingExample(ex.id);
      expect(removed).toBe(true);
      expect(ft.listTrainingExamples().length).toBe(before - 1);
    });

    it('删除不存在的样例应返回 false', () => {
      const ft = newFineTuner();
      expect(ft.removeTrainingExample('non-existent')).toBe(false);
    });
  });

  // ========== 数据格式化 ==========

  describe('数据格式化', () => {
    it('应正确格式化 LoRA 样例', () => {
      const ft = newFineTuner();
      const ex: TrainingExample = {
        id: 'test-1',
        instruction: '你好',
        output: '你好！',
        source: 'manual',
        confidence: 1.0,
        createdAt: Date.now(),
        tags: [],
      };
      const formatted = ft.formatExample(ex, 'lora');
      const parsed = JSON.parse(formatted);
      expect(parsed.instruction).toBe('你好');
      expect(parsed.output).toBe('你好！');
      expect(parsed.system).toBeDefined();
      expect(parsed.input).toBe('');
    });

    it('应正确格式化 QLoRA 样例', () => {
      const ft = newFineTuner();
      const ex: TrainingExample = {
        id: 'test-1',
        instruction: '你好',
        input: '附加输入',
        output: '你好！',
        source: 'manual',
        confidence: 1.0,
        createdAt: Date.now(),
        tags: [],
      };
      const formatted = ft.formatExample(ex, 'qlora');
      const parsed = JSON.parse(formatted);
      expect(parsed.input).toBe('附加输入');
      expect(parsed.system).toBeDefined();
    });

    it('应正确格式化 Instruct 样例', () => {
      const ft = newFineTuner();
      const ex: TrainingExample = {
        id: 'test-1',
        instruction: '写一个函数',
        output: 'function() {}',
        source: 'manual',
        confidence: 1.0,
        createdAt: Date.now(),
        tags: [],
      };
      const formatted = ft.formatExample(ex, 'instruct');
      const parsed = JSON.parse(formatted);
      expect(parsed.prompt).toBe('写一个函数');
      expect(parsed.completion).toBe('function() {}');
    });

    it('应正确格式化 ChatML 样例', () => {
      const ft = newFineTuner();
      const ex: TrainingExample = {
        id: 'test-1',
        instruction: '你好',
        output: '你好！',
        source: 'manual',
        confidence: 1.0,
        createdAt: Date.now(),
        tags: [],
      };
      const formatted = ft.formatExample(ex, 'chatml');
      const parsed = JSON.parse(formatted);
      expect(parsed.messages).toBeInstanceOf(Array);
      expect(parsed.messages.length).toBe(3);
      expect(parsed.messages[0].role).toBe('system');
      expect(parsed.messages[1].role).toBe('user');
      expect(parsed.messages[2].role).toBe('assistant');
    });

    it('应支持自定义 system prompt', () => {
      const ft = newFineTuner();
      const ex: TrainingExample = {
        id: 'test-1',
        instruction: '你好',
        output: '你好！',
        source: 'manual',
        confidence: 1.0,
        createdAt: Date.now(),
        tags: [],
      };
      const formatted = ft.formatExample(ex, 'lora', '自定义 system');
      const parsed = JSON.parse(formatted);
      expect(parsed.system).toBe('自定义 system');
    });

    it('应优先使用样例自身的 system', () => {
      const ft = newFineTuner();
      const ex: TrainingExample = {
        id: 'test-1',
        instruction: '你好',
        output: '你好！',
        system: '样例 system',
        source: 'manual',
        confidence: 1.0,
        createdAt: Date.now(),
        tags: [],
      };
      const formatted = ft.formatExample(ex, 'lora');
      const parsed = JSON.parse(formatted);
      expect(parsed.system).toBe('样例 system');
    });

    it('formatDataset 应生成 JSONL 字符串', () => {
      const ft = newFineTuner();
      const examples: TrainingExample[] = [
        { id: '1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
        { id: '2', instruction: 'b', output: 'B', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const jsonl = ft.formatDataset(examples, 'lora');
      const lines = jsonl.split('\n');
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).instruction).toBe('a');
      expect(JSON.parse(lines[1]).instruction).toBe('b');
    });
  });

  // ========== 数据集 ==========

  describe('数据集', () => {
    it('应创建数据集并持久化 JSONL 文件', () => {
      const ft = newFineTuner();
      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
        { id: 'ex2', instruction: 'b', output: 'B', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试集', 'lora', examples);
      expect(ds.id).toBeDefined();
      expect(ds.exampleCount).toBe(2);
      expect(ds.sizeBytes).toBeGreaterThan(0);
      expect(ft.listDatasets().length).toBe(1);

      // JSONL 文件应存在
      const jsonlPath = path.join((ft as unknown as { dataDir: string }).dataDir, `${ds.id}.jsonl`);
      expect(fs.existsSync(jsonlPath)).toBe(true);
    });

    it('应通过 ID 获取数据集内容', () => {
      const ft = newFineTuner();
      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试集', 'lora', examples);
      const content = ft.getDatasetContent(ds.id);
      expect(content).not.toBeNull();
      const lines = content!.split('\n');
      expect(lines.length).toBe(1);
    });

    it('获取不存在的数据集内容应返回 null', () => {
      const ft = newFineTuner();
      expect(ft.getDatasetContent('non-existent')).toBeNull();
    });

    it('应支持删除数据集', () => {
      const ft = newFineTuner();
      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试集', 'lora', examples);
      const removed = ft.deleteDataset(ds.id);
      expect(removed).toBe(true);
      expect(ft.listDatasets().length).toBe(0);
    });

    it('删除数据集应同时删除 JSONL 文件', () => {
      const dir = path.join(tmpDir, 'finetune');
      const ft = new ModelFineTuner(dir);
      ft.initialize();
      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试集', 'lora', examples);
      const jsonlPath = path.join(dir, `${ds.id}.jsonl`);
      expect(fs.existsSync(jsonlPath)).toBe(true);
      ft.deleteDataset(ds.id);
      expect(fs.existsSync(jsonlPath)).toBe(false);
    });

    it('应按创建时间倒序排列数据集', () => {
      const ft = newFineTuner();
      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      ft.createDataset('ds1', 'lora', examples);
      // 等待一毫秒确保 createdAt 不同
      const ds2 = ft.createDataset('ds2', 'lora', examples);
      const list = ft.listDatasets();
      expect(list[0].id).toBe(ds2.id); // 最新的在前
    });
  });

  // ========== 训练任务 ==========

  describe('训练任务', () => {
    function setupDataset(ft: ModelFineTuner, exampleCount = 5): DatasetInfo {
      const examples: TrainingExample[] = [];
      for (let i = 0; i < exampleCount; i++) {
        examples.push({
          id: `ex${i}`,
          instruction: `指令${i}`,
          output: `输出${i}`,
          source: 'manual',
          confidence: 1.0,
          createdAt: 0,
          tags: [],
        });
      }
      return ft.createDataset('测试集', 'lora', examples);
    }

    it('应创建训练任务', () => {
      const ft = newFineTuner();
      const ds = setupDataset(ft);
      const job = ft.createTrainingJob({
        name: '测试任务',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
      });
      expect(job.id).toBeDefined();
      expect(job.status).toBe('pending');
      expect(job.progress).toBe(0);
      expect(job.exampleCount).toBe(5);
      expect(job.epochs).toBe(3); // 默认值
      expect(ft.listTrainingJobs().length).toBe(1);
    });

    it('创建任务时数据集不存在应抛错', () => {
      const ft = newFineTuner();
      expect(() => ft.createTrainingJob({
        name: '测试任务',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: 'non-existent',
      })).toThrow(/Dataset not found/);
    });

    it('应启动训练任务并完成', async () => {
      const ft = newFineTuner();
      const ds = setupDataset(ft, 3);
      const job = ft.createTrainingJob({
        name: '测试任务',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 1,
      });

      await ft.startTrainingJob(job.id);
      const finalJob = await waitForJobCompletion(ft, job.id);
      expect(finalJob.status).toBe('completed');
      expect(finalJob.progress).toBe(100);
      expect(finalJob.outputModelName).toBeDefined();
      expect(finalJob.completedAt).toBeDefined();
    });

    it('启动不存在的任务应抛错', async () => {
      const ft = newFineTuner();
      await expect(ft.startTrainingJob('non-existent')).rejects.toThrow(/Job not found/);
    });

    it('重复启动任务应抛错', async () => {
      const ft = newFineTuner();
      const ds = setupDataset(ft, 3);
      const job = ft.createTrainingJob({
        name: '测试任务',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 1,
      });
      await ft.startTrainingJob(job.id);
      await expect(ft.startTrainingJob(job.id)).rejects.toThrow(/already running|already completed/);
      // 等待训练完成，避免 afterEach 删除目录后异步任务仍调 saveJobs
      await waitForJobCompletion(ft, job.id);
    });

    it('应取消训练任务', () => {
      const ft = newFineTuner();
      const ds = setupDataset(ft, 100); // 大数据集让训练时间足够长
      const job = ft.createTrainingJob({
        name: '测试任务',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 100,
      });

      // 创建 pending 状态的任务直接取消
      const cancelled = ft.cancelTrainingJob(job.id);
      expect(cancelled).toBe(true);
      const finalJob = ft.getTrainingJobStatus(job.id);
      expect(finalJob?.status).toBe('cancelled');
    });

    it('取消已完成的任务应失败', async () => {
      const ft = newFineTuner();
      const ds = setupDataset(ft, 2);
      const job = ft.createTrainingJob({
        name: '测试任务',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 1,
      });
      await ft.startTrainingJob(job.id);
      await waitForJobCompletion(ft, job.id);
      const cancelled = ft.cancelTrainingJob(job.id);
      expect(cancelled).toBe(false);
    });

    it('查询任务状态应返回完整对象', () => {
      const ft = newFineTuner();
      const ds = setupDataset(ft);
      const job = ft.createTrainingJob({
        name: '测试任务',
        backend: 'llama_cpp',
        format: 'qlora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
      });
      const status = ft.getTrainingJobStatus(job.id);
      expect(status).not.toBeNull();
      expect(status?.backend).toBe('llama_cpp');
      expect(status?.format).toBe('qlora');
    });

    it('查询不存在的任务应返回 null', () => {
      const ft = newFineTuner();
      expect(ft.getTrainingJobStatus('non-existent')).toBeNull();
    });

    it('应支持自定义 LoRA 参数', () => {
      const ft = newFineTuner();
      const ds = setupDataset(ft);
      const job = ft.createTrainingJob({
        name: '测试任务',
        backend: 'ollama',
        format: 'qlora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 5,
        learningRate: 1e-4,
        loraRank: 16,
        loraAlpha: 32,
      });
      expect(job.epochs).toBe(5);
      expect(job.learningRate).toBe(1e-4);
      expect(job.loraRank).toBe(16);
      expect(job.loraAlpha).toBe(32);
    });

    it('应支持自定义输出模型名', async () => {
      const ft = newFineTuner();
      const ds = setupDataset(ft, 2);
      const job = ft.createTrainingJob({
        name: '测试任务',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 1,
        outputModelName: 'my-custom-model',
      });
      await ft.startTrainingJob(job.id);
      const finalJob = await waitForJobCompletion(ft, job.id);
      expect(finalJob.outputModelName).toBe('my-custom-model');
    });

    it('重启后 running 状态的任务应标记为 failed', () => {
      const dir = path.join(tmpDir, 'finetune');
      const ft1 = new ModelFineTuner(dir);
      ft1.initialize();
      const ds = ft1.createDataset('测试集', 'lora', [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ]);
      const job = ft1.createTrainingJob({
        name: '测试',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
      });
      // 手动修改状态模拟 running 中断
      job.status = 'running';
      (ft1 as unknown as { saveJobs: () => void }).saveJobs();

      // 重新加载
      const ft2 = new ModelFineTuner(dir);
      ft2.initialize();
      const reloaded = ft2.getTrainingJobStatus(job.id);
      expect(reloaded?.status).toBe('failed');
      expect(reloaded?.error).toContain('Interrupted');
    });
  });

  // ========== 模型注册 ==========

  describe('模型注册', () => {
    it('训练完成后应生成模型记录', async () => {
      const ft = newFineTuner();
      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
        { id: 'ex2', instruction: 'b', output: 'B', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试集', 'lora', examples);
      const job = ft.createTrainingJob({
        name: '测试',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 1,
      });
      await ft.startTrainingJob(job.id);
      await waitForJobCompletion(ft, job.id);

      const models = ft.listTrainedModels();
      expect(models.length).toBe(1);
      expect(models[0].baseModel).toBe('llama3:8b');
      expect(models[0].jobId).toBe(job.id);
      expect(models[0].metrics?.loss).toBeGreaterThan(0);
    });

    it('应通过 callback 注册到 ModelLibrary', async () => {
      const ft = newFineTuner();
      let registeredModel: TrainedModelInfo | null = null;
      ft.setModelRegisterCallback((m) => { registeredModel = m; });

      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试集', 'lora', examples);
      const job = ft.createTrainingJob({
        name: '测试',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 1,
      });
      await ft.startTrainingJob(job.id);
      await waitForJobCompletion(ft, job.id);

      expect(registeredModel).not.toBeNull();
      expect(registeredModel?.name).toBeDefined();

      const models = ft.listTrainedModels();
      expect(models[0].registeredToLibrary).toBe(true);
    });

    it('callback 抛错不应影响任务完成', async () => {
      const ft = newFineTuner();
      ft.setModelRegisterCallback(() => { throw new Error('注册失败'); });

      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试集', 'lora', examples);
      const job = ft.createTrainingJob({
        name: '测试',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 1,
      });
      await ft.startTrainingJob(job.id);
      const finalJob = await waitForJobCompletion(ft, job.id);
      expect(finalJob.status).toBe('completed');
      // 模型记录应仍存在
      expect(ft.listTrainedModels().length).toBe(1);
      // registeredToLibrary 应为 false
      expect(ft.listTrainedModels()[0].registeredToLibrary).toBe(false);
    });

    it('应支持查询和删除模型', async () => {
      const ft = newFineTuner();
      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试集', 'lora', examples);
      const job = ft.createTrainingJob({
        name: '测试',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 1,
      });
      await ft.startTrainingJob(job.id);
      await waitForJobCompletion(ft, job.id);

      const models = ft.listTrainedModels();
      const modelId = models[0].id;

      expect(ft.getTrainedModel(modelId)).not.toBeNull();
      expect(ft.deleteTrainedModel(modelId)).toBe(true);
      expect(ft.getTrainedModel(modelId)).toBeNull();
    });

    it('查询不存在的模型应返回 null', () => {
      const ft = newFineTuner();
      expect(ft.getTrainedModel('non-existent')).toBeNull();
    });
  });

  // ========== 持久化 ==========

  describe('持久化', () => {
    it('重启后应恢复数据集/任务/模型', async () => {
      const dir = path.join(tmpDir, 'finetune');
      const ft1 = new ModelFineTuner(dir);
      ft1.initialize();

      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
        { id: 'ex2', instruction: 'b', output: 'B', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft1.createDataset('测试集', 'lora', examples);
      const job = ft1.createTrainingJob({
        name: '测试',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 1,
      });
      await ft1.startTrainingJob(job.id);
      await waitForJobCompletion(ft1, job.id);

      // 重启
      const ft2 = new ModelFineTuner(dir);
      ft2.initialize();

      expect(ft2.listDatasets().length).toBe(1);
      expect(ft2.listTrainingJobs().length).toBe(1);
      expect(ft2.listTrainedModels().length).toBe(1);
      expect(ft2.listTrainingExamples().length).toBeGreaterThanOrEqual(2);
    });

    it('损坏的 JSON 应被忽略', () => {
      const dir = path.join(tmpDir, 'finetune');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'examples.json'), '{invalid json', 'utf-8');
      fs.writeFileSync(path.join(dir, 'datasets.json'), 'not a json', 'utf-8');

      const ft = new ModelFineTuner(dir);
      // 不应抛错
      ft.initialize();
      expect(ft.listTrainingExamples().length).toBe(3); // 内置样例
    });
  });

  // ========== 统计 ==========

  describe('统计', () => {
    it('初始统计应正确', () => {
      const ft = newFineTuner();
      const stats = ft.getStats();
      expect(stats.datasetCount).toBe(0);
      expect(stats.jobCount).toBe(0);
      expect(stats.completedJobCount).toBe(0);
      expect(stats.runningJobCount).toBe(0);
      expect(stats.failedJobCount).toBe(0);
      expect(stats.pendingJobCount).toBe(0);
      expect(stats.cancelledJobCount).toBe(0);
      expect(stats.trainedModelCount).toBe(0);
      expect(stats.registeredModelCount).toBe(false);
      expect(stats.totalExamples).toBe(3); // 内置
    });

    it('应正确统计各类任务状态', async () => {
      const ft = newFineTuner();
      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试集', 'lora', examples);

      // pending 任务
      ft.createTrainingJob({
        name: 'p1', backend: 'ollama', format: 'lora',
        baseModel: 'm1', datasetId: ds.id,
      });

      // completed 任务
      const job2 = ft.createTrainingJob({
        name: 'p2', backend: 'ollama', format: 'lora',
        baseModel: 'm1', datasetId: ds.id, epochs: 1,
      });
      await ft.startTrainingJob(job2.id);
      await waitForJobCompletion(ft, job2.id);

      // cancelled 任务
      const job3 = ft.createTrainingJob({
        name: 'p3', backend: 'ollama', format: 'lora',
        baseModel: 'm1', datasetId: ds.id,
      });
      ft.cancelTrainingJob(job3.id);

      const stats = ft.getStats();
      expect(stats.jobCount).toBe(3);
      expect(stats.completedJobCount).toBe(1);
      expect(stats.pendingJobCount).toBe(1);
      expect(stats.cancelledJobCount).toBe(1);
      expect(stats.trainedModelCount).toBe(1);
    });
  });

  // ========== LLM 工具 ==========

  describe('LLM 工具', () => {
    it('应返回 8 个工具定义', () => {
      const ft = newFineTuner();
      const tools = ft.getToolDefinitions();
      expect(tools.length).toBe(8);
      const names = tools.map(t => t.name);
      expect(names).toContain('finetune_collect_data');
      expect(names).toContain('finetune_list_examples');
      expect(names).toContain('finetune_create_dataset');
      expect(names).toContain('finetune_list_datasets');
      expect(names).toContain('finetune_create_job');
      expect(names).toContain('finetune_start_job');
      expect(names).toContain('finetune_job_status');
      expect(names).toContain('finetune_list_models');
    });

    it('每个工具都应有 name/description/parameters/execute', () => {
      const ft = newFineTuner();
      const tools = ft.getToolDefinitions();
      for (const t of tools) {
        expect(t.name).toBeDefined();
        expect(t.description).toBeDefined();
        expect(t.parameters).toBeDefined();
        expect(typeof t.execute).toBe('function');
      }
    });

    it('finetune_list_datasets 工具应返回数据集列表', async () => {
      const ft = newFineTuner();
      const tool = ft.getToolDefinitions().find(t => t.name === 'finetune_list_datasets')!;
      const result = await tool.execute({});
      const parsed = JSON.parse(result);
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('finetune_create_dataset 工具应创建数据集', async () => {
      const ft = newFineTuner();
      const tool = ft.getToolDefinitions().find(t => t.name === 'finetune_create_dataset')!;
      const result = await tool.execute({
        name: '工具创建数据集',
        format: 'lora',
      });
      const parsed = JSON.parse(result);
      expect(parsed.id).toBeDefined();
      expect(parsed.exampleCount).toBeGreaterThan(0);
    });

    it('finetune_create_job 工具应创建任务', async () => {
      const ft = newFineTuner();
      // 先创建数据集
      const dsTool = ft.getToolDefinitions().find(t => t.name === 'finetune_create_dataset')!;
      const dsResult = await dsTool.execute({ name: '测试', format: 'lora' });
      const ds = JSON.parse(dsResult);

      const tool = ft.getToolDefinitions().find(t => t.name === 'finetune_create_job')!;
      const result = await tool.execute({
        name: '测试任务',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
      });
      const parsed = JSON.parse(result);
      expect(parsed.id).toBeDefined();
      expect(parsed.status).toBe('pending');
    });

    it('finetune_create_job 工具数据集不存在应返回 error', async () => {
      const ft = newFineTuner();
      const tool = ft.getToolDefinitions().find(t => t.name === 'finetune_create_job')!;
      const result = await tool.execute({
        name: '测试任务',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: 'non-existent',
      });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });

    it('finetune_job_status 工具应返回任务状态', async () => {
      const ft = newFineTuner();
      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试集', 'lora', examples);
      const job = ft.createTrainingJob({
        name: '测试', backend: 'ollama', format: 'lora',
        baseModel: 'llama3:8b', datasetId: ds.id,
      });

      const tool = ft.getToolDefinitions().find(t => t.name === 'finetune_job_status')!;
      const result = await tool.execute({ jobId: job.id });
      const parsed = JSON.parse(result);
      expect(parsed.id).toBe(job.id);
      expect(parsed.status).toBe('pending');
    });

    it('finetune_job_status 工具任务不存在应返回 error', async () => {
      const ft = newFineTuner();
      const tool = ft.getToolDefinitions().find(t => t.name === 'finetune_job_status')!;
      const result = await tool.execute({ jobId: 'non-existent' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });

    it('finetune_list_models 工具应返回模型列表', async () => {
      const ft = newFineTuner();
      const tool = ft.getToolDefinitions().find(t => t.name === 'finetune_list_models')!;
      const result = await tool.execute({});
      const parsed = JSON.parse(result);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(0);
    });

    it('finetune_collect_data 工具应收集数据', async () => {
      const ft = newFineTuner();
      ft.setDataSource(makeMockSource({
        getLearningRecords: () => [makeRecord({ id: 'r1', outcome: 'positive' })],
      }));
      const tool = ft.getToolDefinitions().find(t => t.name === 'finetune_collect_data')!;
      const result = await tool.execute({});
      const parsed = JSON.parse(result);
      expect(parsed.collected).toBe(1);
      expect(parsed.total).toBe(4); // 内置 3 + 收集 1
    });

    it('finetune_list_examples 工具应支持分页', async () => {
      const ft = newFineTuner();
      const tool = ft.getToolDefinitions().find(t => t.name === 'finetune_list_examples')!;
      const result = await tool.execute({ limit: 2, offset: 0 });
      const parsed = JSON.parse(result);
      expect(parsed.total).toBe(3);
      expect(parsed.examples.length).toBe(2);
    });
  });

  // ========== 单例 ==========

  describe('单例', () => {
    it('getInstance 应返回同一实例', () => {
      // 注意：使用单例会污染默认数据目录，所以测试前后要 reset
      ModelFineTuner._resetInstance();
      const a = ModelFineTuner.getInstance();
      const b = ModelFineTuner.getInstance();
      expect(a).toBe(b);
      ModelFineTuner._resetInstance();
    });

    it('_resetInstance 应重置单例', () => {
      ModelFineTuner._resetInstance();
      const a = ModelFineTuner.getInstance();
      ModelFineTuner._resetInstance();
      const b = ModelFineTuner.getInstance();
      expect(a).not.toBe(b);
      ModelFineTuner._resetInstance();
    });

    it('getModelFineTuner 便捷函数应等同 getInstance', () => {
      ModelFineTuner._resetInstance();
      const a = getModelFineTuner();
      const b = ModelFineTuner.getInstance();
      expect(a).toBe(b);
      ModelFineTuner._resetInstance();
    });
  });

  // ========== 边缘情况 ==========

  describe('边缘情况', () => {
    it('未初始化时调用方法不应崩溃', () => {
      const dir = path.join(tmpDir, 'finetune');
      const ft = new ModelFineTuner(dir);
      // 未调用 initialize 直接调用方法
      expect(() => ft.listTrainingExamples()).not.toThrow();
      expect(() => ft.listDatasets()).not.toThrow();
      expect(() => ft.listTrainingJobs()).not.toThrow();
      expect(() => ft.getStats()).not.toThrow();
    });

    it('空数据集创建任务应仍可启动', async () => {
      const ft = newFineTuner();
      const ds = ft.createDataset('空集', 'lora', []);
      const job = ft.createTrainingJob({
        name: '空测试',
        backend: 'ollama',
        format: 'lora',
        baseModel: 'llama3:8b',
        datasetId: ds.id,
        epochs: 1,
      });
      await ft.startTrainingJob(job.id);
      const finalJob = await waitForJobCompletion(ft, job.id);
      expect(finalJob.status).toBe('completed');
    });

    it('setDataSource 多次调用应覆盖', () => {
      const ft = newFineTuner();
      ft.setDataSource(makeMockSource({
        getLearningRecords: () => [makeRecord({ id: 'r1', outcome: 'positive' })],
      }));
      ft.setDataSource(makeMockSource({
        getLearningRecords: () => [makeRecord({ id: 'r2', outcome: 'positive' })],
      }));
      const collected = ft.collectTrainingData();
      expect(collected.length).toBe(1);
      expect(collected[0].tags).toContain('cat:coding');
    });

    it('setModelRegisterCallback 多次调用应覆盖', async () => {
      const ft = newFineTuner();
      let callCount = 0;
      ft.setModelRegisterCallback(() => { callCount++; });
      ft.setModelRegisterCallback(() => { callCount += 10; });

      const examples: TrainingExample[] = [
        { id: 'ex1', instruction: 'a', output: 'A', source: 'manual', confidence: 1.0, createdAt: 0, tags: [] },
      ];
      const ds = ft.createDataset('测试', 'lora', examples);
      const job = ft.createTrainingJob({
        name: '测试', backend: 'ollama', format: 'lora',
        baseModel: 'llama3:8b', datasetId: ds.id, epochs: 1,
      });
      await ft.startTrainingJob(job.id);
      await waitForJobCompletion(ft, job.id);
      expect(callCount).toBe(10); // 只触发后注入的 callback
    });

    it('不支持的格式应抛错', () => {
      const ft = newFineTuner();
      const ex: TrainingExample = {
        id: '1', instruction: 'a', output: 'A',
        source: 'manual', confidence: 1.0, createdAt: 0, tags: [],
      };
      expect(() => ft.formatExample(ex, 'unknown' as TrainingFormat)).toThrow(/Unsupported format/);
    });
  });
});
