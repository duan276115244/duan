/**
 * 神经网络核心 — NeuralNetwork
 *
 * 纯 TypeScript 实现的前馈神经网络，支持反向传播训练。
 * 作为「段先生」Agent 自主意识的决策基础。
 *
 * 核心能力：
 * 1. 多层前馈网络 — 输入层→隐藏层（可配置）→输出层
 * 2. 激活函数 — sigmoid / tanh / relu / softmax
 * 3. 反向传播 — 梯度下降 + L2 正则化
 * 4. 在线学习 — 支持增量训练，不遗忘旧知识
 * 5. 推理 — 前向传播快速推理
 *
 * 架构隐喻：
 * - 神经元 = 决策单元
 * - 突触权重 = 知识编码
 * - 激活模式 = 思维状态
 * - 训练 = 经验学习
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './structured-logger.js';
import { atomicWriteJsonSync } from './atomic-write.js';

// ============ 类型定义 ============

/** 激活函数类型 */
export type ActivationType = 'sigmoid' | 'tanh' | 'relu' | 'softmax' | 'linear' | 'gelu';

/** 网络层 */
export interface NetworkLayer {
  /** 神经元数量 */
  size: number;
  /** 激活函数 */
  activation: ActivationType;
  /** 权重矩阵 [输入维度][神经元数量] */
  weights: number[][];
  /** 偏置 [神经元数量] */
  biases: number[];
  /** P2-2: 是否启用残差连接 */
  useResidual?: boolean;
  /** P2-2: 是否启用 LayerNorm */
  useLayerNorm?: boolean;
  /** P2-2: LayerNorm 的缩放参数 gamma */
  lnGamma?: number[];
  /** P2-2: LayerNorm 的偏移参数 beta */
  lnBeta?: number[];
}

/** 训练样本 */
export interface TrainingSample {
  /** 输入向量 */
  input: number[];
  /** 目标输出 */
  target: number[];
  /** 样本标签（用于分类） */
  label?: string;
}

/** 训练结果 */
export interface TrainingResult {
  /** 训练轮次 */
  epochs: number;
  /** 最终损失 */
  finalLoss: number;
  /** 损失历史 */
  lossHistory: number[];
  /** 准确率（如果有标签） */
  accuracy?: number;
  /** 训练耗时（ms） */
  durationMs: number;
}

/** 推理结果 */
export interface InferenceResult {
  /** 输出向量 */
  output: number[];
  /** 预测标签（如果有标签映射） */
  predictedLabel?: string;
  /** 置信度（最大输出的 softmax 值） */
  confidence: number;
  /** 各神经元激活值（用于内省） */
  activations: number[][];
}

// ============ 激活函数 ============

function sigmoid(x: number): number {
  if (x < -100) return 0;
  if (x > 100) return 1;
  return 1 / (1 + Math.exp(-x));
}

function sigmoidDerivative(x: number): number {
  const s = sigmoid(x);
  return s * (1 - s);
}

function tanh(x: number): number {
  return Math.tanh(x);
}

function tanhDerivative(x: number): number {
  const t = Math.tanh(x);
  return 1 - t * t;
}

function relu(x: number): number {
  return Math.max(0, x);
}

function reluDerivative(x: number): number {
  return x > 0 ? 1 : 0;
}

/** P2-2: GELU 激活函数（Gaussian Error Linear Unit） */
function gelu(x: number): number {
  // GELU(x) = 0.5 * x * (1 + tanh(sqrt(2/π) * (x + 0.044715 * x³)))
  const c = Math.sqrt(2 / Math.PI);
  return 0.5 * x * (1 + Math.tanh(c * (x + 0.044715 * x * x * x)));
}

function geluDerivative(x: number): number {
  // GELU 的导数近似
  const c = Math.sqrt(2 / Math.PI);
  const tanhArg = c * (x + 0.044715 * x * x * x);
  const tanhVal = Math.tanh(tanhArg);
  const sech2 = 1 - tanhVal * tanhVal;
  const innerDeriv = c * (1 + 3 * 0.044715 * x * x);
  return 0.5 * (1 + tanhVal) + 0.5 * x * sech2 * innerDeriv;
}

/** P2-2: LayerNorm — 对每个样本的特征维度做归一化 */
function layerNorm(
  x: number[],
  gamma: number[],
  beta: number[],
  epsilon: number = 1e-5,
): number[] {
  const n = x.length;
  if (n === 0) return x;

  // 计算均值
  const mean = x.reduce((s, v) => s + v, 0) / n;
  // 计算方差
  const variance = x.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
  const std = Math.sqrt(variance + epsilon);

  // 归一化 + 缩放平移
  return x.map((v, i) => (gamma[i] || 1) * (v - mean) / std + (beta[i] || 0));
}

function softmax(arr: number[]): number[] {
  const maxVal = Math.max(...arr);
  const exps = arr.map(x => Math.exp(x - maxVal));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

function activate(x: number, type: ActivationType): number {
  switch (type) {
    case 'sigmoid': return sigmoid(x);
    case 'tanh': return tanh(x);
    case 'relu': return relu(x);
    case 'gelu': return gelu(x);
    case 'linear': return x;
    case 'softmax': return x; // softmax 在层级别处理
    default: return sigmoid(x);
  }
}

function activateDerivative(x: number, type: ActivationType): number {
  switch (type) {
    case 'sigmoid': return sigmoidDerivative(x);
    case 'tanh': return tanhDerivative(x);
    case 'relu': return reluDerivative(x);
    case 'gelu': return geluDerivative(x);
    case 'linear': return 1;
    default: return sigmoidDerivative(x);
  }
}

// ============ 神经网络 ============

export class NeuralNetwork {
  /** 网络层 */
  private layers: NetworkLayer[] = [];

  /** 输入维度 */
  private inputSize: number;

  /** 标签映射（输出索引→标签名） */
  private labelMap: Map<number, string> = new Map();

  /** 学习率 */
  private learningRate: number = 0.01;

  /** L2 正则化系数 */
  private l2Lambda: number = 0.001;

  /** 训练次数统计 */
  private trainingCount: number = 0;

  /** 模型文件路径 */
  private modelPath?: string;

  private log = logger.child({ module: 'NeuralNetwork' });

  constructor(options: {
    inputSize: number;
    layers?: Array<{ size: number; activation: ActivationType; useResidual?: boolean; useLayerNorm?: boolean }>;
    learningRate?: number;
    l2Lambda?: number;
    modelPath?: string;
  }) {
    this.inputSize = options.inputSize;
    this.learningRate = options.learningRate ?? 0.01;
    this.l2Lambda = options.l2Lambda ?? 0.001;
    this.modelPath = options.modelPath;

    if (options.layers && options.layers.length > 0) {
      this.buildNetwork(options.layers);
    }

    // 尝试加载已保存的模型
    if (this.modelPath) {
      this.loadModel();
    }
  }

  /** 构建网络层 */
  private buildNetwork(layerConfigs: Array<{ size: number; activation: ActivationType; useResidual?: boolean; useLayerNorm?: boolean }>): void {
    this.layers = [];
    let prevSize = this.inputSize;

    for (const config of layerConfigs) {
      const layer: NetworkLayer = {
        size: config.size,
        activation: config.activation,
        weights: this.initWeights(prevSize, config.size),
        biases: new Array(config.size).fill(0),
        // P2-2: 残差连接要求输入输出维度相同
        useResidual: config.useResidual && prevSize === config.size,
        // P2-2: LayerNorm 参数初始化
        useLayerNorm: config.useLayerNorm,
        lnGamma: config.useLayerNorm ? new Array(config.size).fill(1) : undefined,
        lnBeta: config.useLayerNorm ? new Array(config.size).fill(0) : undefined,
      };
      this.layers.push(layer);
      prevSize = config.size;
    }
  }

  /** 初始化权重（Xavier 初始化） */
  private initWeights(inputSize: number, outputSize: number): number[][] {
    const limit = Math.sqrt(6 / (inputSize + outputSize));
    const weights: number[][] = [];
    for (let i = 0; i < outputSize; i++) {
      const row: number[] = [];
      for (let j = 0; j < inputSize; j++) {
        row.push((Math.random() * 2 - 1) * limit);
      }
      weights.push(row);
    }
    return weights;
  }

  /** 设置标签映射 */
  setLabelMap(labels: string[]): void {
    this.labelMap.clear();
    for (let i = 0; i < labels.length; i++) {
      this.labelMap.set(i, labels[i]);
    }
  }

  // ========== 前向传播 ==========

  /**
   * 前向传播
   * @returns [各层激活值, 各层加权输入]
   */
  private forward(input: number[]): { activations: number[][]; zValues: number[][] } {
    const activations: number[][] = [input];
    const zValues: number[][] = [];

    let currentInput = input;

    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l];
      const z: number[] = new Array(layer.size).fill(0);
      const a: number[] = new Array(layer.size).fill(0);

      for (let i = 0; i < layer.size; i++) {
        // 加权求和
        let sum = layer.biases[i];
        for (let j = 0; j < currentInput.length; j++) {
          sum += layer.weights[i][j] * currentInput[j];
        }
        z[i] = sum;

        // 激活
        if (layer.activation === 'softmax') {
          // softmax 需要整层一起处理
          continue;
        } else {
          a[i] = activate(sum, layer.activation);
        }
      }

      // softmax 特殊处理
      if (layer.activation === 'softmax') {
        const softmaxOutput = softmax(z);
        for (let i = 0; i < layer.size; i++) {
          a[i] = softmaxOutput[i];
        }
      }

      // P2-2: LayerNorm 归一化（在激活之后）
      let layerOutput = a;
      if (layer.useLayerNorm && layer.lnGamma && layer.lnBeta) {
        layerOutput = layerNorm(a, layer.lnGamma, layer.lnBeta);
      }

      // P2-2: 残差连接 output = layer(x) + x
      if (layer.useResidual && currentInput.length === layerOutput.length) {
        for (let i = 0; i < layerOutput.length; i++) {
          layerOutput[i] += currentInput[i];
        }
      }

      zValues.push(z);
      activations.push(layerOutput);
      currentInput = layerOutput;
    }

    return { activations, zValues };
  }

  /**
   * 推理
   */
  predict(input: number[]): InferenceResult {
    const { activations } = this.forward(input);
    const output = activations[activations.length - 1];

    // 计算置信度
    const maxIdx = output.indexOf(Math.max(...output));
    const confidence = output[maxIdx];

    // 预测标签
    const predictedLabel = this.labelMap.get(maxIdx);

    return {
      output,
      predictedLabel,
      confidence,
      activations,
    };
  }

  // ========== 反向传播 ==========

  /**
   * 训练单个样本
   */
  private trainSample(input: number[], target: number[]): number {
    const { activations, zValues } = this.forward(input);

    // 计算输出层误差
    const outputLayer = this.layers[this.layers.length - 1];
    const outputActivation = activations[activations.length - 1];

    const deltas: number[][] = [];

    // 输出层 delta
    const outputDelta: number[] = new Array(outputLayer.size).fill(0);
    for (let i = 0; i < outputLayer.size; i++) {
      const error = outputActivation[i] - target[i];
      if (outputLayer.activation === 'softmax') {
        outputDelta[i] = error;
      } else {
        outputDelta[i] = error * activateDerivative(zValues[this.layers.length - 1][i], outputLayer.activation);
      }
    }
    deltas.unshift(outputDelta);

    // 隐藏层 delta（反向传播）
    for (let l = this.layers.length - 2; l >= 0; l--) {
      const layer = this.layers[l];
      const nextLayer = this.layers[l + 1];
      const delta: number[] = new Array(layer.size).fill(0);

      for (let i = 0; i < layer.size; i++) {
        let sum = 0;
        for (let j = 0; j < nextLayer.size; j++) {
          sum += nextLayer.weights[j][i] * deltas[0][j];
        }
        delta[i] = sum * activateDerivative(zValues[l][i], layer.activation);
      }
      deltas.unshift(delta);
    }

    // 更新权重和偏置
    for (let l = 0; l < this.layers.length; l++) {
      const layer = this.layers[l];
      const layerInput = activations[l];
      const layerDelta = deltas[l];

      for (let i = 0; i < layer.size; i++) {
        // 更新偏置
        layer.biases[i] -= this.learningRate * layerDelta[i];

        // 更新权重（含 L2 正则化）
        for (let j = 0; j < layerInput.length; j++) {
          const gradient = layerDelta[i] * layerInput[j];
          const regularization = this.l2Lambda * layer.weights[i][j];
          layer.weights[i][j] -= this.learningRate * (gradient + regularization);
        }
      }
    }

    // 计算损失（交叉熵或 MSE）
    let loss = 0;
    if (outputLayer.activation === 'softmax') {
      // 交叉熵
      for (let i = 0; i < target.length; i++) {
        const p = Math.max(outputActivation[i], 1e-15);
        loss -= target[i] * Math.log(p);
      }
    } else {
      // MSE
      for (let i = 0; i < target.length; i++) {
        loss += Math.pow(outputActivation[i] - target[i], 2);
      }
      loss /= target.length;
    }

    return loss;
  }

  /**
   * 训练网络
   */
  train(samples: TrainingSample[], epochs: number = 100, batchSize?: number): TrainingResult {
    const startTime = Date.now();
    const lossHistory: number[] = [];
    let correctCount = 0;

    for (let epoch = 0; epoch < epochs; epoch++) {
      let epochLoss = 0;
      let batchCount = 0;

      // 打乱样本顺序
      const shuffled = [...samples].sort(() => Math.random() - 0.5);

      const batch = batchSize ?? shuffled.length;
      for (let i = 0; i < shuffled.length; i += batch) {
        const batchSamples = shuffled.slice(i, i + batch);
        for (const sample of batchSamples) {
          epochLoss += this.trainSample(sample.input, sample.target);
          batchCount++;

          // 统计准确率
          if (sample.label) {
            const result = this.predict(sample.input);
            if (result.predictedLabel === sample.label) {
              correctCount++;
            }
          }
        }
      }

      epochLoss /= batchCount;
      lossHistory.push(epochLoss);

      // 每 10 轮打印一次
      if (epoch % 10 === 0 || epoch === epochs - 1) {
        this.log.debug('训练进度', { epoch, loss: epochLoss.toFixed(6) });
      }
    }

    this.trainingCount += epochs;

    const accuracy = samples[0]?.label
      ? correctCount / (samples.length * epochs)
      : undefined;

    const result: TrainingResult = {
      epochs,
      finalLoss: lossHistory[lossHistory.length - 1],
      lossHistory,
      accuracy,
      durationMs: Date.now() - startTime,
    };

    this.log.info('训练完成', {
      epochs,
      finalLoss: result.finalLoss.toFixed(6),
      accuracy: accuracy?.toFixed(4),
      durationMs: result.durationMs,
      totalTrainingCount: this.trainingCount,
    });

    // 保存模型
    if (this.modelPath) {
      this.saveModel();
    }

    return result;
  }

  /**
   * 在线学习（单样本增量训练）
   */
  learnOnline(input: number[], target: number[], label?: string): void {
    const sample: TrainingSample = { input, target, label };
    this.train([sample], 1);

    // 在线学习后保存
    if (this.modelPath) {
      this.saveModel();
    }
  }

  // ========== 模型持久化 ==========

  /** 保存模型 */
  saveModel(): void {
    if (!this.modelPath) return;
    try {
      const dir = path.dirname(this.modelPath);
      fs.mkdirSync(dir, { recursive: true });

      const data = {
        inputSize: this.inputSize,
        layers: this.layers,
        labelMap: Array.from(this.labelMap.entries()),
        learningRate: this.learningRate,
        l2Lambda: this.l2Lambda,
        trainingCount: this.trainingCount,
      };
      atomicWriteJsonSync(this.modelPath, data);
    } catch (err: unknown) {
      this.log.error('保存模型失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  /** 加载模型 */
  loadModel(): void {
    if (!this.modelPath || !fs.existsSync(this.modelPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.modelPath, 'utf-8'));
      this.inputSize = data.inputSize;
      this.layers = data.layers;
      this.labelMap = new Map(data.labelMap);
      this.learningRate = data.learningRate ?? this.learningRate;
      this.l2Lambda = data.l2Lambda ?? this.l2Lambda;
      this.trainingCount = data.trainingCount ?? 0;
      this.log.info('模型已加载', { trainingCount: this.trainingCount, layers: this.layers.length });
    } catch (err: unknown) {
      this.log.error('加载模型失败', { error: (err instanceof Error ? err.message : String(err)) });
    }
  }

  // ========== 工具方法 ==========

  /** 获取网络结构信息 */
  getArchitecture(): { inputSize: number; layers: Array<{ size: number; activation: string }>; trainingCount: number; labelCount: number } {
    return {
      inputSize: this.inputSize,
      layers: this.layers.map(l => ({ size: l.size, activation: l.activation })),
      trainingCount: this.trainingCount,
      labelCount: this.labelMap.size,
    };
  }

  /**
   * 获取神经元激活模式（用于内省）
   */
  getActivationPattern(input: number[]): {
    layerActivations: number[][];
    strongestNeurons: Array<{ layer: number; neuron: number; activation: number }>;
  } {
    const result = this.predict(input);
    const strongestNeurons: Array<{ layer: number; neuron: number; activation: number }> = [];

    for (let l = 1; l < result.activations.length; l++) {
      const activations = result.activations[l];
      for (let n = 0; n < activations.length; n++) {
        strongestNeurons.push({
          layer: l - 1,
          neuron: n,
          activation: activations[n],
        });
      }
    }

    strongestNeurons.sort((a, b) => b.activation - a.activation);

    return {
      layerActivations: result.activations,
      strongestNeurons: strongestNeurons.slice(0, 10),
    };
  }
}
