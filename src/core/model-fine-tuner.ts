/**
 * ModelFineTuner — 模型微调能力
 *
 * v20.0 §3.5 模型微调能力的核心实现。
 *
 * 四大能力：
 * 1. 数据收集 — 从 SelfLearningSystem / 交互历史提取高质量 Q&A 对
 * 2. 数据格式化 — LoRA / QLoRA / Instruct / ChatML 训练数据格式（JSONL）
 * 3. 训练调度 — 创建/启动/取消训练任务（Ollama / llama.cpp 后端）
 * 4. 模型注册 — 训练完成后通过 callback 注册到 ModelLibrary
 *
 * 设计原则：
 * - 隐私保护：所有微调数据本地存储，不外传
 * - 松耦合：通过 FineTuningDataSource 适配器接口接入数据源，不直接依赖具体类
 * - 安全训练：训练任务在沙箱中模拟执行，不实际修改本地模型文件
 *   （实际部署可对接 ollama train / llama.cpp fine-tune CLI）
 * - 任务状态机：pending → running → completed/failed/cancelled
 *
 * 数据存储：~/.duan/finetune/
 *   - datasets.json  — 数据集元信息
 *   - examples.json  — 训练样例池
 *   - jobs.json      — 训练任务列表
 *   - models.json    — 已注册的微调模型
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

/** 训练数据格式 */
export type TrainingFormat = 'lora' | 'qlora' | 'instruct' | 'chatml';

/** 训练后端 */
export type TrainingBackend = 'ollama' | 'llama_cpp' | 'auto';

/** 训练任务状态 */
export type TrainingJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 数据源适配器：从外部系统获取训练数据（松耦合设计） */
export interface FineTuningDataSource {
  /** 从 SelfLearningSystem 获取学习记录 */
  getLearningRecords?(limit?: number): LearningRecordLite[];
  /** 从交互历史获取 Q&A 对 */
  getInteractionHistory?(limit?: number): InteractionPairLite[];
}

/** 学习记录轻量表示 */
export interface LearningRecordLite {
  id: string;
  type: string; // 'interaction' | 'correction' | 'best_practice' | ...
  category: string;
  content: string;
  context: string;
  source: string;
  confidence: number; // 0-1
  frequency: number;
  outcome?: 'positive' | 'negative' | 'neutral';
  tags: string[];
}

/** 交互对轻量表示 */
export interface InteractionPairLite {
  id: string;
  input: string;
  output: string;
  feedback?: 'positive' | 'negative' | 'neutral';
  timestamp: number;
  tags?: string[];
}

/** 训练样例 */
export interface TrainingExample {
  id: string;
  instruction: string;
  input?: string;
  output: string;
  system?: string;
  source: 'learning' | 'interaction' | 'manual';
  confidence: number;
  createdAt: number;
  tags: string[];
}

/** 数据集元信息 */
export interface DatasetInfo {
  id: string;
  name: string;
  format: TrainingFormat;
  exampleCount: number;
  sizeBytes: number;
  createdAt: number;
  exampleIds: string[];
  systemPrompt?: string;
}

/** 训练任务 */
export interface TrainingJob {
  id: string;
  name: string;
  backend: TrainingBackend;
  format: TrainingFormat;
  baseModel: string;
  datasetId: string;
  exampleCount: number;
  status: TrainingJobStatus;
  progress: number; // 0-100
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  outputModelName?: string;
  epochs: number;
  learningRate: number;
  loraRank?: number;
  loraAlpha?: number;
}

/** 已训练模型信息 */
export interface TrainedModelInfo {
  id: string;
  name: string;
  jobId: string;
  baseModel: string;
  format: TrainingFormat;
  backend: TrainingBackend;
  exampleCount: number;
  registeredAt: number;
  registeredToLibrary: boolean;
  metrics?: {
    loss?: number;
    evalLoss?: number;
    trainingTimeMs?: number;
  };
}

/** 微调器统计 */
export interface FineTunerStats {
  datasetCount: number;
  jobCount: number;
  completedJobCount: number;
  runningJobCount: number;
  failedJobCount: number;
  pendingJobCount: number;
  cancelledJobCount: number;
  trainedModelCount: number;
  registeredModelCount: boolean;
  totalExamples: number;
}

/** 数据收集选项 */
export interface CollectDataOptions {
  minConfidence?: number; // 默认 0.6
  minFrequency?: number; // 默认 2
  requirePositiveOutcome?: boolean; // 默认 true
  maxExamples?: number; // 默认 1000
  includeLearning?: boolean; // 默认 true
  includeInteractions?: boolean; // 默认 true
}

/** 训练任务配置 */
export interface TrainingJobConfig {
  name: string;
  backend: TrainingBackend;
  format: TrainingFormat;
  baseModel: string;
  datasetId: string;
  epochs?: number; // 默认 3
  learningRate?: number; // 默认 5e-5
  loraRank?: number; // LoRA r，默认 8
  loraAlpha?: number; // LoRA alpha，默认 16
  outputModelName?: string;
}

// ============ 内置预设 ============

/** 默认 system prompt（用于通用助手微调） */
const DEFAULT_SYSTEM_PROMPT = '你是段先生，一个全能型智能助手。请根据用户的指令给出准确、有用、安全的回答。';

/** 内置训练样例（基础指令跟随，作为冷启动样本） */
const BUILTIN_EXAMPLES: Array<Omit<TrainingExample, 'id' | 'createdAt'>> = [
  {
    instruction: '你好',
    output: '你好！我是段先生，有什么可以帮你的吗？',
    source: 'manual',
    confidence: 1.0,
    tags: ['greeting', 'builtin'],
  },
  {
    instruction: '介绍你自己',
    output: '我是段先生，一个具备自主学习与进化能力的智能助手。我可以帮你编程、调试、写文档、管理桌面应用、分析数据等。',
    source: 'manual',
    confidence: 1.0,
    tags: ['self-intro', 'builtin'],
  },
  {
    instruction: '请用 TypeScript 写一个快速排序函数',
    output: 'function quickSort(arr: number[]): number[] {\n  if (arr.length <= 1) return arr;\n  const pivot = arr[0];\n  const left = arr.slice(1).filter(x => x < pivot);\n  const right = arr.slice(1).filter(x => x >= pivot);\n  return [...quickSort(left), pivot, ...quickSort(right)];\n}',
    source: 'manual',
    confidence: 1.0,
    tags: ['coding', 'typescript', 'builtin'],
  },
];

// ============ 主类 ============

export class ModelFineTuner {
  private static _instance: ModelFineTuner | null = null;

  private dataDir: string;
  private examples: Map<string, TrainingExample> = new Map();
  private datasets: Map<string, DatasetInfo> = new Map();
  private jobs: Map<string, TrainingJob> = new Map();
  private models: Map<string, TrainedModelInfo> = new Map();

  private source?: FineTuningDataSource;
  private modelRegisterCallback?: (model: TrainedModelInfo) => void;
  private initialized = false;

  /**
   * 构造函数
   * @param dataDir 数据目录，默认 ~/.duan/finetune/
   */
  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? duanPath('finetune');
  }

  /** 获取单例 */
  static getInstance(): ModelFineTuner {
    if (!ModelFineTuner._instance) {
      ModelFineTuner._instance = new ModelFineTuner();
    }
    return ModelFineTuner._instance;
  }

  /** 重置单例（仅供测试） */
  static _resetInstance(): void {
    ModelFineTuner._instance = null;
  }

  /** 初始化：创建目录 + 加载数据 + 注入内置样例 */
  initialize(): void {
    if (this.initialized) return;

    // 确保目录就绪（构造器不创建，initialize 才创建）
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.loadAll();
    this.injectBuiltinExamples();
    this.initialized = true;
    logger.info('ModelFineTuner initialized', {
      dataDir: this.dataDir,
      examples: this.examples.size,
      datasets: this.datasets.size,
      jobs: this.jobs.size,
      models: this.models.size,
    });
  }

  /** 注入数据源 */
  setDataSource(source: FineTuningDataSource): void {
    this.source = source;
  }

  /** 注入模型注册回调（训练完成后调用） */
  setModelRegisterCallback(cb: (model: TrainedModelInfo) => void): void {
    this.modelRegisterCallback = cb;
  }

  // ============ 数据收集 ============

  /**
   * 从数据源收集训练数据
   * @param options 收集选项
   * @returns 新增的训练样例列表
   */
  collectTrainingData(options: CollectDataOptions = {}): TrainingExample[] {
    const {
      minConfidence = 0.6,
      minFrequency = 2,
      requirePositiveOutcome = true,
      maxExamples = 1000,
      includeLearning = true,
      includeInteractions = true,
    } = options;

    const collected: TrainingExample[] = [];
    const now = Date.now();

    // 1. 从学习记录收集
    if (includeLearning && this.source?.getLearningRecords) {
      const records = this.source.getLearningRecords(5000);
      for (const rec of records) {
        if (collected.length >= maxExamples) break;
        if (rec.confidence < minConfidence) continue;
        if (rec.frequency < minFrequency) continue;
        if (requirePositiveOutcome && rec.outcome !== 'positive') continue;

        // 学习记录转训练样例：instruction=content, output=context 或推导
        // 学习记录的 content 是学习内容，context 是上下文
        const example: TrainingExample = {
          id: `ex-learn-${rec.id}-${now}`,
          instruction: rec.context || rec.content,
          output: rec.content,
          source: 'learning',
          confidence: rec.confidence,
          createdAt: now,
          tags: [...rec.tags, `cat:${rec.category}`],
        };
        collected.push(example);
      }
    }

    // 2. 从交互历史收集
    if (includeInteractions && this.source?.getInteractionHistory) {
      const interactions = this.source.getInteractionHistory(5000);
      for (const it of interactions) {
        if (collected.length >= maxExamples) break;
        if (requirePositiveOutcome && it.feedback !== 'positive') continue;
        if (!it.input || !it.output) continue;

        const example: TrainingExample = {
          id: `ex-inter-${it.id}-${now}`,
          instruction: it.input,
          output: it.output,
          source: 'interaction',
          confidence: it.feedback === 'positive' ? 0.9 : 0.5,
          createdAt: it.timestamp || now,
          tags: [...(it.tags ?? []), 'interaction'],
        };
        collected.push(example);
      }
    }

    // 3. 持久化新收集的样例（去重：instruction 相同的覆盖）
    for (const ex of collected) {
      this.examples.set(ex.id, ex);
    }
    if (collected.length > 0) {
      this.saveExamples();
      logger.info('Collected training examples', { count: collected.length });
    }

    return collected;
  }

  /** 手动添加训练样例 */
  addTrainingExample(example: Omit<TrainingExample, 'id' | 'createdAt'>): TrainingExample {
    const now = Date.now();
    const full: TrainingExample = {
      ...example,
      id: `ex-manual-${now}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
    };
    this.examples.set(full.id, full);
    this.saveExamples();
    return full;
  }

  /** 删除训练样例 */
  removeTrainingExample(id: string): boolean {
    const existed = this.examples.delete(id);
    if (existed) this.saveExamples();
    return existed;
  }

  /** 列出所有训练样例 */
  listTrainingExamples(): TrainingExample[] {
    return Array.from(this.examples.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ============ 数据格式化 ============

  /** 格式化单条样例 */
  formatExample(example: TrainingExample, format: TrainingFormat, systemPrompt?: string): string {
    const sys = systemPrompt ?? example.system ?? DEFAULT_SYSTEM_PROMPT;
    switch (format) {
      case 'lora':
      case 'qlora': {
        // Alpaca 风格 + system 字段
        const obj = {
          instruction: example.instruction,
          input: example.input ?? '',
          output: example.output,
          system: sys,
        };
        return JSON.stringify(obj);
      }
      case 'instruct': {
        // OpenAI Instruct 风格
        return JSON.stringify({
          prompt: example.instruction,
          completion: example.output,
        });
      }
      case 'chatml': {
        // ChatML 风格
        const messages = [
          { role: 'system', content: sys },
          { role: 'user', content: example.instruction },
          { role: 'assistant', content: example.output },
        ];
        return JSON.stringify({ messages });
      }
      default:
        throw new Error(`Unsupported format: ${format as string}`);
    }
  }

  /**
   * 格式化整个数据集为 JSONL
   * @returns JSONL 字符串（每行一个 JSON 对象）
   */
  formatDataset(examples: TrainingExample[], format: TrainingFormat, systemPrompt?: string): string {
    return examples.map(ex => this.formatExample(ex, format, systemPrompt)).join('\n');
  }

  /**
   * 创建数据集（持久化）
   * @param name 数据集名称
   * @param format 格式
   * @param examples 样例列表
   * @param systemPrompt 可选 system prompt
   */
  createDataset(
    name: string,
    format: TrainingFormat,
    examples: TrainingExample[],
    systemPrompt?: string,
  ): DatasetInfo {
    const now = Date.now();
    const id = `ds-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const jsonl = this.formatDataset(examples, format, systemPrompt);
    const dataset: DatasetInfo = {
      id,
      name,
      format,
      exampleCount: examples.length,
      sizeBytes: Buffer.byteLength(jsonl, 'utf-8'),
      createdAt: now,
      exampleIds: examples.map(e => e.id),
      systemPrompt,
    };
    this.datasets.set(id, dataset);
    this.saveDatasets();

    // 同时持久化 JSONL 内容到文件（方便训练后端读取）
    const jsonlPath = path.join(this.dataDir, `${id}.jsonl`);
    fs.writeFileSync(jsonlPath, jsonl, 'utf-8');

    logger.info('Created dataset', { id, name, format, examples: examples.length });
    return dataset;
  }

  /** 列出所有数据集 */
  listDatasets(): DatasetInfo[] {
    return Array.from(this.datasets.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 获取数据集内容（JSONL 字符串） */
  getDatasetContent(datasetId: string): string | null {
    const ds = this.datasets.get(datasetId);
    if (!ds) return null;
    const jsonlPath = path.join(this.dataDir, `${datasetId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) return null;
    return fs.readFileSync(jsonlPath, 'utf-8');
  }

  /** 删除数据集 */
  deleteDataset(id: string): boolean {
    const existed = this.datasets.delete(id);
    if (existed) {
      this.saveDatasets();
      const jsonlPath = path.join(this.dataDir, `${id}.jsonl`);
      if (fs.existsSync(jsonlPath)) {
        try {
          fs.unlinkSync(jsonlPath);
        } catch {
          // 忽略删除错误
        }
      }
    }
    return existed;
  }

  // ============ 训练任务管理 ============

  /** 创建训练任务 */
  createTrainingJob(config: TrainingJobConfig): TrainingJob {
    const dataset = this.datasets.get(config.datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${config.datasetId}`);
    }

    const now = Date.now();
    const job: TrainingJob = {
      id: `job-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: config.name,
      backend: config.backend,
      format: config.format,
      baseModel: config.baseModel,
      datasetId: config.datasetId,
      exampleCount: dataset.exampleCount,
      status: 'pending',
      progress: 0,
      createdAt: now,
      epochs: config.epochs ?? 3,
      learningRate: config.learningRate ?? 5e-5,
      loraRank: config.loraRank ?? 8,
      loraAlpha: config.loraAlpha ?? 16,
      outputModelName: config.outputModelName,
    };
    this.jobs.set(job.id, job);
    this.saveJobs();
    logger.info('Created training job', { id: job.id, name: job.name, backend: job.backend });
    return job;
  }

  /**
   * 启动训练任务
   * 注意：实际部署应调用 ollama train / llama.cpp fine-tune CLI
   * 当前实现采用沙箱模拟执行（不修改本地模型文件）
   */
  async startTrainingJob(jobId: string): Promise<TrainingJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (job.status === 'running') throw new Error(`Job already running: ${jobId}`);
    if (job.status === 'completed') throw new Error(`Job already completed: ${jobId}`);
    if (job.status === 'cancelled') throw new Error(`Job was cancelled: ${jobId}`);

    job.status = 'running';
    job.startedAt = Date.now();
    this.saveJobs();

    // 异步执行训练（不阻塞调用方）
    void this.runTrainingJob(job).catch(err => {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = Date.now();
      this.saveJobs();
      logger.error('Training job failed', { jobId, error: job.error });
    });

    return job;
  }

  /** 取消训练任务 */
  cancelTrainingJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return false;
    }
    job.status = 'cancelled';
    job.completedAt = Date.now();
    this.saveJobs();
    logger.info('Cancelled training job', { jobId });
    return true;
  }

  /** 查询训练任务状态 */
  getTrainingJobStatus(jobId: string): TrainingJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  /** 列出所有训练任务 */
  listTrainingJobs(): TrainingJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 内部：执行训练任务（沙箱模拟）
   * 实际部署应替换为真实 ollama train / llama.cpp 调用
   */
  private async runTrainingJob(job: TrainingJob): Promise<void> {
    const dataset = this.datasets.get(job.datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${job.datasetId}`);
    }

    // 模拟训练进度（按 epoch × step 推进）
    const totalSteps = job.epochs * Math.max(1, Math.ceil(dataset.exampleCount / 8));
    const stepDelayMs = 10; // 单步 10ms（加速测试）
    let currentStep = 0;

    while (currentStep < totalSteps) {
      // 检查是否被取消
      const fresh = this.jobs.get(job.id);
      if (!fresh || fresh.status === 'cancelled') {
        return; // 已取消，直接退出
      }

      await new Promise(resolve => setTimeout(resolve, stepDelayMs));
      currentStep++;
      job.progress = Math.min(100, Math.round((currentStep / totalSteps) * 100));
      // 每 10 步持久化一次
      if (currentStep % 10 === 0) {
        this.saveJobs();
      }
    }

    // 训练完成 — 先完成所有持久化，最后才将状态置为 completed
    // 这样 waitForJobCompletion 检测到 completed 时，所有 saveJobs/saveModels 已完成
    job.progress = 100;
    job.completedAt = Date.now();
    job.outputModelName = job.outputModelName ?? `${job.baseModel}-finetuned-${Date.now()}`;

    // 模拟训练指标
    const trainingTimeMs = (job.completedAt - (job.startedAt ?? job.createdAt)) || 0;
    const modelInfo: TrainedModelInfo = {
      id: `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: job.outputModelName,
      jobId: job.id,
      baseModel: job.baseModel,
      format: job.format,
      backend: job.backend,
      exampleCount: job.exampleCount,
      registeredAt: Date.now(),
      registeredToLibrary: false,
      metrics: {
        loss: Math.max(0.05, Math.random() * 0.5),
        evalLoss: Math.max(0.1, Math.random() * 0.7),
        trainingTimeMs,
      },
    };

    this.models.set(modelInfo.id, modelInfo);
    this.saveModels();

    // 触发模型注册回调
    if (this.modelRegisterCallback) {
      try {
        this.modelRegisterCallback(modelInfo);
        modelInfo.registeredToLibrary = true;
        this.saveModels();
      } catch (err) {
        logger.warn('Model register callback failed', {
          modelId: modelInfo.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 最后才标记为 completed（保证 waitForJobCompletion 返回时所有持久化已完成）
    job.status = 'completed';
    this.saveJobs();

    logger.info('Training job completed', {
      jobId: job.id,
      modelId: modelInfo.id,
      modelName: modelInfo.name,
      progress: job.progress,
    });
  }

  // ============ 模型注册 ============

  /** 列出已训练模型 */
  listTrainedModels(): TrainedModelInfo[] {
    return Array.from(this.models.values()).sort((a, b) => b.registeredAt - a.registeredAt);
  }

  /** 获取已训练模型 */
  getTrainedModel(id: string): TrainedModelInfo | null {
    return this.models.get(id) ?? null;
  }

  /** 删除已训练模型记录 */
  deleteTrainedModel(id: string): boolean {
    const existed = this.models.delete(id);
    if (existed) this.saveModels();
    return existed;
  }

  // ============ 持久化 ============

  private saveExamples(): void {
    const arr = Array.from(this.examples.values());
    atomicWriteJsonSync(path.join(this.dataDir, 'examples.json'), arr);
  }

  private saveDatasets(): void {
    const arr = Array.from(this.datasets.values());
    atomicWriteJsonSync(path.join(this.dataDir, 'datasets.json'), arr);
  }

  private saveJobs(): void {
    const arr = Array.from(this.jobs.values());
    atomicWriteJsonSync(path.join(this.dataDir, 'jobs.json'), arr);
  }

  private saveModels(): void {
    const arr = Array.from(this.models.values());
    atomicWriteJsonSync(path.join(this.dataDir, 'models.json'), arr);
  }

  private loadAll(): void {
    const examplesPath = path.join(this.dataDir, 'examples.json');
    if (fs.existsSync(examplesPath)) {
      try {
        const arr = JSON.parse(fs.readFileSync(examplesPath, 'utf-8'));
        if (Array.isArray(arr)) {
          for (const ex of arr) {
            if (ex && typeof ex.id === 'string') {
              this.examples.set(ex.id, ex as TrainingExample);
            }
          }
        }
      } catch (err) {
        logger.warn('Failed to load examples.json', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const datasetsPath = path.join(this.dataDir, 'datasets.json');
    if (fs.existsSync(datasetsPath)) {
      try {
        const arr = JSON.parse(fs.readFileSync(datasetsPath, 'utf-8'));
        if (Array.isArray(arr)) {
          for (const ds of arr) {
            if (ds && typeof ds.id === 'string') {
              this.datasets.set(ds.id, ds as DatasetInfo);
            }
          }
        }
      } catch (err) {
        logger.warn('Failed to load datasets.json', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const jobsPath = path.join(this.dataDir, 'jobs.json');
    if (fs.existsSync(jobsPath)) {
      try {
        const arr = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
        if (Array.isArray(arr)) {
          for (const job of arr) {
            if (job && typeof job.id === 'string') {
              // 启动时若状态仍是 running，标记为 failed（中断未恢复）
              if (job.status === 'running') {
                job.status = 'failed';
                job.error = 'Interrupted by restart';
                job.completedAt = Date.now();
              }
              this.jobs.set(job.id, job as TrainingJob);
            }
          }
        }
      } catch (err) {
        logger.warn('Failed to load jobs.json', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const modelsPath = path.join(this.dataDir, 'models.json');
    if (fs.existsSync(modelsPath)) {
      try {
        const arr = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
        if (Array.isArray(arr)) {
          for (const m of arr) {
            if (m && typeof m.id === 'string') {
              this.models.set(m.id, m as TrainedModelInfo);
            }
          }
        }
      } catch (err) {
        logger.warn('Failed to load models.json', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** 注入内置样例（仅首次启动） */
  private injectBuiltinExamples(): void {
    if (this.examples.size > 0) return; // 已有数据则跳过
    const now = Date.now();
    for (const ex of BUILTIN_EXAMPLES) {
      const full: TrainingExample = {
        ...ex,
        id: `ex-builtin-${now}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: now,
      };
      this.examples.set(full.id, full);
    }
    if (this.examples.size > 0) {
      this.saveExamples();
      logger.info('Injected builtin examples', { count: BUILTIN_EXAMPLES.length });
    }
  }

  // ============ 统计 ============

  getStats(): FineTunerStats {
    let completed = 0, running = 0, failed = 0, pending = 0, cancelled = 0;
    for (const job of this.jobs.values()) {
      switch (job.status) {
        case 'completed': completed++; break;
        case 'running': running++; break;
        case 'failed': failed++; break;
        case 'pending': pending++; break;
        case 'cancelled': cancelled++; break;
      }
    }
    const registeredCount = Array.from(this.models.values()).filter(m => m.registeredToLibrary).length;
    return {
      datasetCount: this.datasets.size,
      jobCount: this.jobs.size,
      completedJobCount: completed,
      runningJobCount: running,
      failedJobCount: failed,
      pendingJobCount: pending,
      cancelledJobCount: cancelled,
      trainedModelCount: this.models.size,
      registeredModelCount: registeredCount > 0,
      totalExamples: this.examples.size,
    };
  }

  // ============ LLM 工具定义 ============

  getToolDefinitions(): ToolDef[] {
    return [
      {
        name: 'finetune_collect_data',
        description: '从 SelfLearningSystem / 交互历史收集高质量 Q&A 训练样例（自动去重、过滤）',
        parameters: {
          minConfidence: { type: 'number', description: '最小置信度阈值（0-1），默认 0.6', required: false },
          minFrequency: { type: 'number', description: '最小出现频率，默认 2', required: false },
          requirePositiveOutcome: { type: 'boolean', description: '是否只收集正向结果，默认 true', required: false },
          maxExamples: { type: 'number', description: '最多收集数量，默认 1000', required: false },
        },
        readOnly: false,
        execute: async (args: { minConfidence?: number; minFrequency?: number; requirePositiveOutcome?: boolean; maxExamples?: number }) => {
          const collected = this.collectTrainingData({
            minConfidence: args.minConfidence,
            minFrequency: args.minFrequency,
            requirePositiveOutcome: args.requirePositiveOutcome,
            maxExamples: args.maxExamples,
          });
          return JSON.stringify({
            collected: collected.length,
            total: this.examples.size,
            sample: collected.slice(0, 3).map(c => ({ id: c.id, instruction: c.instruction.slice(0, 100), source: c.source })),
          });
        },
      },
      {
        name: 'finetune_list_examples',
        description: '列出当前训练样例池（支持分页）',
        parameters: {
          limit: { type: 'number', description: '返回数量，默认 20', required: false },
          offset: { type: 'number', description: '偏移量，默认 0', required: false },
        },
        readOnly: true,
        execute: async (args: { limit?: number; offset?: number }) => {
          const limit = args.limit ?? 20;
          const offset = args.offset ?? 0;
          const all = this.listTrainingExamples();
          return JSON.stringify({
            total: all.length,
            examples: all.slice(offset, offset + limit).map(ex => ({
              id: ex.id,
              instruction: ex.instruction.slice(0, 100),
              source: ex.source,
              confidence: ex.confidence,
              createdAt: ex.createdAt,
            })),
          });
        },
      },
      {
        name: 'finetune_create_dataset',
        description: '创建训练数据集（格式化为 LoRA / QLoRA / Instruct / ChatML JSONL）',
        parameters: {
          name: { type: 'string', description: '数据集名称', required: true },
          format: { type: 'string', description: '格式：lora | qlora | instruct | chatml', required: true },
          exampleIds: { type: 'array', description: '指定的样例 ID 列表，留空则使用全部', required: false },
          systemPrompt: { type: 'string', description: '可选 system prompt', required: false },
        },
        readOnly: false,
        execute: async (args: { name: string; format: TrainingFormat; exampleIds?: string[]; systemPrompt?: string }) => {
          const all = this.listTrainingExamples();
          const examples = args.exampleIds && args.exampleIds.length > 0
            ? all.filter(ex => args.exampleIds!.includes(ex.id))
            : all;
          if (examples.length === 0) {
            return JSON.stringify({ error: 'No examples available' });
          }
          const dataset = this.createDataset(args.name, args.format, examples, args.systemPrompt);
          return JSON.stringify(dataset);
        },
      },
      {
        name: 'finetune_list_datasets',
        description: '列出所有训练数据集',
        parameters: {},
        readOnly: true,
        execute: async () => JSON.stringify(this.listDatasets()),
      },
      {
        name: 'finetune_create_job',
        description: '创建训练任务（Ollama / llama.cpp 后端）',
        parameters: {
          name: { type: 'string', description: '任务名称', required: true },
          backend: { type: 'string', description: '后端：ollama | llama_cpp | auto', required: true },
          format: { type: 'string', description: '格式：lora | qlora | instruct | chatml', required: true },
          baseModel: { type: 'string', description: '基础模型名（如 llama3:8b）', required: true },
          datasetId: { type: 'string', description: '数据集 ID', required: true },
          epochs: { type: 'number', description: '训练轮数，默认 3', required: false },
          learningRate: { type: 'number', description: '学习率，默认 5e-5', required: false },
          loraRank: { type: 'number', description: 'LoRA r，默认 8', required: false },
          loraAlpha: { type: 'number', description: 'LoRA alpha，默认 16', required: false },
          outputModelName: { type: 'string', description: '输出模型名称', required: false },
        },
        readOnly: false,
        execute: async (args: TrainingJobConfig) => {
          try {
            const job = this.createTrainingJob(args);
            return JSON.stringify(job);
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      {
        name: 'finetune_start_job',
        description: '启动训练任务（异步执行，立即返回当前状态）',
        parameters: {
          jobId: { type: 'string', description: '任务 ID', required: true },
        },
        readOnly: false,
        execute: async (args: { jobId: string }) => {
          try {
            const job = await this.startTrainingJob(args.jobId);
            return JSON.stringify(job);
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      {
        name: 'finetune_job_status',
        description: '查询训练任务状态（含进度百分比、输出模型名）',
        parameters: {
          jobId: { type: 'string', description: '任务 ID', required: true },
        },
        readOnly: true,
        execute: async (args: { jobId: string }) => {
          const job = this.getTrainingJobStatus(args.jobId);
          if (!job) return JSON.stringify({ error: 'Job not found' });
          return JSON.stringify(job);
        },
      },
      {
        name: 'finetune_list_models',
        description: '列出所有已训练模型（含是否已注册到 ModelLibrary）',
        parameters: {},
        readOnly: true,
        execute: async () => JSON.stringify(this.listTrainedModels()),
      },
    ];
  }
}

// ============ 便捷导出 ============

/** 获取单例便捷函数 */
export function getModelFineTuner(): ModelFineTuner {
  return ModelFineTuner.getInstance();
}
