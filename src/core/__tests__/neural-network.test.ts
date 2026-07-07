import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NeuralNetwork } from '../neural-network.js';

describe('NeuralNetwork', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nn-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('构造与初始化', () => {
    it('无层配置时创建空网络', () => {
      const nn = new NeuralNetwork({ inputSize: 3 });
      const arch = nn.getArchitecture();
      expect(arch.inputSize).toBe(3);
      expect(arch.layers).toHaveLength(0);
      expect(arch.trainingCount).toBe(0);
      expect(arch.labelCount).toBe(0);
    });

    it('根据配置构建多层网络', () => {
      const nn = new NeuralNetwork({
        inputSize: 2,
        layers: [
          { size: 4, activation: 'relu' },
          { size: 3, activation: 'softmax' },
        ],
      });
      const arch = nn.getArchitecture();
      expect(arch.layers).toHaveLength(2);
      expect(arch.layers[0].size).toBe(4);
      expect(arch.layers[0].activation).toBe('relu');
      expect(arch.layers[1].activation).toBe('softmax');
    });

    it('应用自定义学习率与 L2 系数', () => {
      const nn = new NeuralNetwork({
        inputSize: 2,
        layers: [{ size: 2, activation: 'sigmoid' }],
        learningRate: 0.05,
        l2Lambda: 0.01,
      });
      // 通过训练行为间接验证（不抛错即视为接受配置）
      const result = nn.train(
        [
          { input: [0.1, 0.2], target: [0.9] },
        ],
        5,
      );
      expect(result.epochs).toBe(5);
    });
  });

  describe('前向传播与推理', () => {
    it('predict 返回与输出层维度一致的向量', () => {
      const nn = new NeuralNetwork({
        inputSize: 3,
        layers: [
          { size: 4, activation: 'relu' },
          { size: 2, activation: 'sigmoid' },
        ],
      });
      const result = nn.predict([0.5, 0.1, 0.9]);
      expect(result.output).toHaveLength(2);
      // sigmoid 输出落在 [0,1]
      for (const v of result.output) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.activations.length).toBeGreaterThanOrEqual(2);
    });

    it('softmax 输出之和接近 1', () => {
      const nn = new NeuralNetwork({
        inputSize: 2,
        layers: [{ size: 3, activation: 'softmax' }],
      });
      const result = nn.predict([0.3, 0.7]);
      const sum = result.output.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
    });

    it('setLabelMap 后预测返回标签', () => {
      const nn = new NeuralNetwork({
        inputSize: 2,
        layers: [{ size: 2, activation: 'softmax' }],
      });
      nn.setLabelMap(['cat', 'dog']);
      const result = nn.predict([0.4, 0.6]);
      expect(['cat', 'dog']).toContain(result.predictedLabel);
    });
  });

  describe('训练与学习', () => {
    it('训练后损失历史长度等于 epochs', () => {
      const nn = new NeuralNetwork({
        inputSize: 2,
        layers: [
          { size: 4, activation: 'tanh' },
          { size: 1, activation: 'sigmoid' },
        ],
      });
      const result = nn.train(
        [
          { input: [0, 0], target: [0] },
          { input: [1, 1], target: [1] },
        ],
        20,
      );
      expect(result.lossHistory).toHaveLength(20);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('XOR 训练后损失下降', () => {
      const nn = new NeuralNetwork({
        inputSize: 2,
        layers: [
          { size: 4, activation: 'tanh' },
          { size: 1, activation: 'sigmoid' },
        ],
        learningRate: 0.1,
      });
      const samples = [
        { input: [0, 0], target: [0] },
        { input: [0, 1], target: [1] },
        { input: [1, 0], target: [1] },
        { input: [1, 1], target: [0] },
      ];
      const result = nn.train(samples, 200);
      // 损失应明显下降
      expect(result.finalLoss).toBeLessThan(result.lossHistory[0]);
    });

    it('带标签训练后计算准确率', () => {
      const nn = new NeuralNetwork({
        inputSize: 2,
        layers: [{ size: 2, activation: 'softmax' }],
        learningRate: 0.05,
      });
      nn.setLabelMap(['a', 'b']);
      const result = nn.train(
        [
          { input: [0.1, 0.9], target: [1, 0], label: 'a' },
          { input: [0.9, 0.1], target: [0, 1], label: 'b' },
        ],
        10,
      );
      expect(result.accuracy).toBeGreaterThanOrEqual(0);
      expect(result.accuracy).toBeLessThanOrEqual(1);
    });

    it('learnOnline 增量训练不抛错', () => {
      const nn = new NeuralNetwork({
        inputSize: 2,
        layers: [{ size: 1, activation: 'sigmoid' }],
      });
      expect(() => nn.learnOnline([0.5, 0.5], [1])).not.toThrow();
      expect(nn.getArchitecture().trainingCount).toBeGreaterThan(0);
    });
  });

  describe('模型持久化', () => {
    it('saveModel / loadModel 往返保持结构', () => {
      const modelPath = path.join(tmpDir, 'model.json');
      const nn = new NeuralNetwork({
        inputSize: 2,
        layers: [
          { size: 3, activation: 'relu' },
          { size: 2, activation: 'softmax' },
        ],
        modelPath,
      });
      nn.setLabelMap(['x', 'y']);
      nn.train([{ input: [0.1, 0.2], target: [1, 0] }], 3);

      // 加载到新实例
      const nn2 = new NeuralNetwork({ inputSize: 2, modelPath });
      const arch = nn2.getArchitecture();
      expect(arch.layers).toHaveLength(2);
      expect(arch.labelCount).toBe(2);
      expect(arch.trainingCount).toBeGreaterThan(0);
    });

    it('modelPath 不存在时不抛错', () => {
      const modelPath = path.join(tmpDir, 'nonexistent.json');
      expect(() => new NeuralNetwork({ inputSize: 2, modelPath })).not.toThrow();
    });
  });

  describe('激活模式分析', () => {
    it('getActivationPattern 返回最强神经元', () => {
      const nn = new NeuralNetwork({
        inputSize: 3,
        layers: [
          { size: 5, activation: 'relu' },
          { size: 2, activation: 'sigmoid' },
        ],
      });
      const pattern = nn.getActivationPattern([0.4, 0.5, 0.6]);
      expect(pattern.layerActivations.length).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(pattern.strongestNeurons)).toBe(true);
      expect(pattern.strongestNeurons.length).toBeLessThanOrEqual(10);
    });
  });
});
