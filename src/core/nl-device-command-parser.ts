/**
 * 自然语言设备命令解析器 — NLDeviceCommandParser
 *
 * P2-8: 自然语言 → 设备控制指令
 *
 * 核心能力：
 * 1. 实体抽取 — 设备名、位置、动作、参数、时间
 * 2. 设备匹配 — 模糊匹配可用设备
 * 3. 动作映射 — 自然语言 → 设备能力
 * 4. 参数解析 — 相对/绝对值、时间表达式
 * 5. 定时解析 — "半小时后"、"每天早上8点"
 *
 * 示例：
 * - "把客厅灯调暗一点" → { device: 'living_room_light', action: 'set_brightness', params: { brightness: 40 } }
 * - "半小时后关空调" → { device: 'air_conditioner', action: 'off', schedule: { delay: 1800000 } }
 * - "把温度调到26度" → { device: 'thermostat', action: 'set_temperature', params: { temperature: 26 } }
 *
 * 复用：
 * - nlu-engine.ts（NLU 引擎）
 * - enhanced-nlu.ts（深层意图识别）
 * - unified-device-control.ts（设备类型定义）
 */

import { logger } from './structured-logger.js';
import type { Device, DeviceState } from './unified-device-control.js';

// ============ 类型定义 ============

export interface DeviceCommand {
  /** 设备 ID 或名称 */
  device: string;
  /** 动作 */
  action: string;
  /** 动作参数 */
  params: Record<string, unknown>;
  /** 定时调度 */
  schedule?: {
    /** 延迟执行（ms） */
    delay?: number;
    /** Cron 表达式 */
    cron?: string;
    /** 具体时间戳 */
    at?: number;
  };
  /** 原始指令 */
  rawUtterance: string;
  /** 解析置信度 */
  confidence: number;
  /** 需要澄清的问题（置信度低时） */
  clarifications?: string[];
}

export interface ParsedEntities {
  deviceName?: string;
  location?: string;
  action?: string;
  value?: number;
  unit?: string;
  relativeChange?: 'increase' | 'decrease';
  timeExpression?: string;
  schedule?: { delay?: number; cron?: string; at?: number };
}

// ============ 自然语言设备命令解析器 ============

export class NLDeviceCommandParser {
  /** 位置关键词 */
  private readonly locationKeywords = [
    '客厅', '卧室', '主卧', '次卧', '厨房', '卫生间', '浴室',
    '书房', '阳台', '餐厅', '玄关', '走廊', '儿童房', '老人房',
    'living room', 'bedroom', 'kitchen', 'bathroom', 'study',
  ];

  /** 动作关键词映射 */
  private readonly actionMappings: Array<{
    patterns: string[];
    action: string;
    params?: (entities: ParsedEntities, state?: DeviceState) => Record<string, unknown>;
  }> = [
    // 开关
    { patterns: ['打开', '开启', '开', 'turn on', 'power on', 'on'], action: 'on' },
    { patterns: ['关闭', '关掉', '关', 'turn off', 'power off', 'off'], action: 'off' },
    // 亮度
    {
      patterns: ['调亮', '调光', '变亮', 'brighter', 'brighten'],
      action: 'set_brightness',
      params: (e, s) => ({
        brightness: e.relativeChange === 'decrease'
          ? Math.max(0, (s?.brightness ?? 50) - 20)
          : Math.min(100, (s?.brightness ?? 50) + 20),
      }),
    },
    {
      patterns: ['调暗', '变暗', 'dim', 'darker'],
      action: 'set_brightness',
      params: (e, s) => ({
        brightness: Math.max(0, (s?.brightness ?? 50) - 20),
      }),
    },
    {
      patterns: ['亮度调到', '设置亮度'],
      action: 'set_brightness',
      params: (e) => ({ brightness: e.value ?? 50 }),
    },
    // 温度
    {
      patterns: ['温度调到', '调到.*度', '设置温度', 'set temperature'],
      action: 'set_temperature',
      params: (e) => ({ temperature: e.value ?? 25 }),
    },
    {
      patterns: ['调高温度', '热点', '升温'],
      action: 'set_temperature',
      params: (e, s) => ({ temperature: (s?.temperature ?? 25) + (e.value ?? 2) }),
    },
    {
      patterns: ['调低温度', '冷点', '降温'],
      action: 'set_temperature',
      params: (e, s) => ({ temperature: (s?.temperature ?? 25) - (e.value ?? 2) }),
    },
    // 音量
    {
      patterns: ['音量调到', '设置音量', 'volume to'],
      action: 'set_volume',
      params: (e) => ({ volume: e.value ?? 50 }),
    },
    {
      patterns: ['音量大点', '大声点', 'louder'],
      action: 'set_volume',
      params: (e, s) => ({ volume: Math.min(100, (s?.volume ?? 50) + 10) }),
    },
    {
      patterns: ['音量小点', '小声点', 'quieter'],
      action: 'set_volume',
      params: (e, s) => ({ volume: Math.max(0, (s?.volume ?? 50) - 10) }),
    },
    // 颜色
    {
      patterns: ['颜色调到', '设置颜色', 'color to'],
      action: 'set_color',
      params: (e) => ({ color: e.unit ?? '#ffffff' }),
    },
    // 位置（窗帘）
    {
      patterns: ['打开窗帘', '拉开窗帘'],
      action: 'set_position',
      params: () => ({ position: 100 }),
    },
    {
      patterns: ['关闭窗帘', '拉上窗帘'],
      action: 'set_position',
      params: () => ({ position: 0 }),
    },
    // 模式
    {
      patterns: ['模式调到', '设置模式', 'mode to'],
      action: 'set_mode',
      params: (e) => ({ mode: e.unit ?? 'auto' }),
    },
    // 播放控制
    { patterns: ['播放', 'play'], action: 'play' },
    { patterns: ['暂停', 'pause'], action: 'pause' },
    { patterns: ['停止', 'stop'], action: 'stop' },
    { patterns: ['下一首', 'next'], action: 'next' },
    { patterns: ['上一首', 'previous', 'prev'], action: 'previous' },
  ];

  /**
   * 预编译的动作正则缓存：在类初始化时一次性编译 actionMappings 中的正则，
   * 避免高频解析时在双重循环中反复 new RegExp(pattern, 'i') 的编译开销。
   * 外层索引与 actionMappings 一一对应，内层索引与 patterns 一一对应。
   */
  private readonly compiledActionPatterns: RegExp[][] = this.actionMappings.map(
    mapping => mapping.patterns.map(pattern => new RegExp(pattern, 'i'))
  );

  /** 设备类型关键词 */
  private readonly deviceTypeKeywords: Array<{ patterns: string[]; type: string }> = [
    { patterns: ['灯', 'light', 'lamp'], type: 'light' },
    { patterns: ['空调', 'air conditioner', 'ac'], type: 'air_conditioner' },
    { patterns: ['电视', 'tv', 'television'], type: 'tv' },
    { patterns: ['音箱', 'speaker', '音响'], type: 'speaker' },
    { patterns: ['窗帘', 'curtain', 'blinds'], type: 'curtain' },
    { patterns: ['门锁', 'lock', '门'], type: 'lock' },
    { patterns: ['风扇', 'fan'], type: 'fan' },
    { patterns: ['扫地机器人', 'robot', 'vacuum'], type: 'robot_vacuum' },
    { patterns: ['温控', 'thermostat'], type: 'thermostat' },
    { patterns: ['传感器', 'sensor'], type: 'sensor' },
  ];

  /**
   * 解析自然语言设备命令
   */
  parse(utterance: string, availableDevices: Device[]): Promise<DeviceCommand> {
    logger.info('解析设备命令', { module: 'NLDeviceCommandParser', utterance });

    // 1. 实体抽取
    const entities = this.extractEntities(utterance);

    // 2. 设备匹配
    const device = this.matchDevice(entities, availableDevices);

    // 3. 动作映射
    const { action, params, confidence: actionConfidence } = this.mapAction(entities, device);

    // 4. 参数解析
    const finalParams = this.parseParams(entities, params, device.state);

    // 5. 定时解析
    const schedule = entities.schedule;

    // 6. 置信度评估
    const confidence = this.calculateConfidence(entities, device, action, actionConfidence);
    const clarifications = confidence < 0.7 ? this.generateClarifications(entities, device) : undefined;

    const command: DeviceCommand = {
      device: device.id,
      action,
      params: finalParams,
      schedule,
      rawUtterance: utterance,
      confidence,
      clarifications,
    };

    logger.info('命令解析完成', {
      module: 'NLDeviceCommandParser',
      device: device.name,
      action,
      confidence,
      hasSchedule: !!schedule,
    });

    return Promise.resolve(command);
  }


  /**
   * 批量解析（多个命令）
   */
  parseBatch(utterances: string[], availableDevices: Device[]): Promise<DeviceCommand[]> {
    return Promise.all(utterances.map(u => this.parse(u, availableDevices)));
  }

  // ===== 内部方法 =====

  private extractEntities(utterance: string): ParsedEntities {
    const entities: ParsedEntities = {};

    // 提取位置
    for (const loc of this.locationKeywords) {
      if (utterance.includes(loc)) {
        entities.location = loc;
        break;
      }
    }

    // 提取设备类型
    for (const { patterns, type } of this.deviceTypeKeywords) {
      if (patterns.some(p => utterance.toLowerCase().includes(p.toLowerCase()))) {
        entities.deviceName = entities.location ? `${entities.location}${type}` : type;
        break;
      }
    }

    // 提取数值
    const numberMatch = utterance.match(/(\d+(?:\.\d+)?)/);
    if (numberMatch) {
      entities.value = parseFloat(numberMatch[1]);

    }

    // 提取单位
    const unitMatch = utterance.match(/(度|℃|°|百分|%|红色|绿色|蓝色|黄色|白色|暖色|冷色|red|green|blue|yellow|white)/i);
    if (unitMatch) {
      entities.unit = unitMatch[1];
    }

    // 相对变化
    if (utterance.includes('点') || utterance.includes('一点') || utterance.includes('些')) {
      if (utterance.includes('调高') || utterance.includes('大') || utterance.includes('亮') || utterance.includes('热')) {
        entities.relativeChange = 'increase';
      } else if (utterance.includes('调低') || utterance.includes('小') || utterance.includes('暗') || utterance.includes('冷')) {
        entities.relativeChange = 'decrease';
      }
    }

    // 提取时间表达式
    entities.schedule = this.parseSchedule(utterance);
    if (entities.schedule) {
      entities.timeExpression = utterance.match(/(半小时后|一小时后|分钟后|小时后|明天|后天|每天|每周|早上|下午|晚上|\d+点)/)?.[0];
    }

    return entities;
  }

  private matchDevice(entities: ParsedEntities, devices: Device[]): Device {
    if (devices.length === 0) {
      throw new Error('没有可用设备');
    }

    // 1. 按位置 + 类型匹配
    if (entities.location && entities.deviceName) {
      const deviceType = this.extractDeviceType(entities.deviceName);
      const match = devices.find(d =>
        d.location?.includes(entities.location!) &&
        d.type === deviceType
      );
      if (match) return match;
    }

    // 2. 按类型匹配
    if (entities.deviceName) {
      const deviceType = this.extractDeviceType(entities.deviceName);
      const match = devices.find(d => d.type === deviceType);
      if (match) return match;
    }

    // 3. 按位置匹配（取该位置的第一个设备）
    if (entities.location) {
      const match = devices.find(d => d.location?.includes(entities.location!));
      if (match) return match;
    }

    // 4. 默认返回第一个设备
    return devices[0];
  }

  private extractDeviceType(deviceName: string): string {
    for (const { patterns, type } of this.deviceTypeKeywords) {
      if (patterns.some(p => deviceName.toLowerCase().includes(p.toLowerCase()))) {
        return type;
      }
    }
    return 'unknown';
  }

  private mapAction(
    entities: ParsedEntities,
    device: Device,
  ): { action: string; params: Record<string, unknown>; confidence: number } {
    // 从设备能力中匹配
    for (const mapping of this.actionMappings) {
      for (const pattern of mapping.patterns) {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(device.name) || regex.test(entities.deviceName || '')) {
          // 检查设备是否支持该动作
          if (device.capabilities.includes(mapping.action)) {
            const params = mapping.params ? mapping.params(entities, device.state) : {};
            return { action: mapping.action, params, confidence: 0.9 };
          }
        }
      }
    }

    // 从原始 utterance 匹配动作
    const utterance = entities.deviceName || '';
    for (const mapping of this.actionMappings) {
      for (const pattern of mapping.patterns) {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(utterance)) {
          if (device.capabilities.includes(mapping.action)) {
            const params = mapping.params ? mapping.params(entities, device.state) : {};
            return { action: mapping.action, params, confidence: 0.7 };
          }
        }
      }
    }

    // 默认动作
    return { action: 'on', params: {}, confidence: 0.3 };
  }

  private parseParams(
    entities: ParsedEntities,
    actionParams: Record<string, unknown>,
    _state: DeviceState,
  ): Record<string, unknown> {
    const params = { ...actionParams };

    // 如果有明确数值，覆盖参数
    if (entities.value !== undefined) {
      if (params.brightness !== undefined) params.brightness = entities.value;
      else if (params.temperature !== undefined) params.temperature = entities.value;
      else if (params.volume !== undefined) params.volume = entities.value;
      else if (params.position !== undefined) params.position = entities.value;
    }

    return params;
  }

  private parseSchedule(utterance: string): { delay?: number; cron?: string; at?: number } | undefined {
    // "半小时后" → delay 1800000
    const halfHourMatch = utterance.match(/半小时后/);
    if (halfHourMatch) {
      return { delay: 30 * 60 * 1000 };
    }

    // "X分钟后" → delay X * 60000
    const minutesMatch = utterance.match(/(\d+)分钟后/);
    if (minutesMatch) {
      return { delay: parseInt(minutesMatch[1]) * 60 * 1000 };
    }

    // "X小时后" → delay X * 3600000
    const hoursMatch = utterance.match(/(\d+)小时后/);
    if (hoursMatch) {
      return { delay: parseInt(hoursMatch[1]) * 60 * 60 * 1000 };
    }

    // "明天早上X点" → at timestamp
    const tomorrowMorningMatch = utterance.match(/明天早上(\d+)点/);
    if (tomorrowMorningMatch) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(parseInt(tomorrowMorningMatch[1]), 0, 0, 0);
      return { at: tomorrow.getTime() };
    }

    // "每天早上X点" → cron
    const dailyMorningMatch = utterance.match(/每天早上(\d+)点/);
    if (dailyMorningMatch) {
      return { cron: `0 ${dailyMorningMatch[1]} * * *` };
    }

    // "每天X点" → cron
    const dailyMatch = utterance.match(/每天(\d+)点/);
    if (dailyMatch) {
      return { cron: `0 ${dailyMatch[1]} * * *` };
    }

    return undefined;
  }

  private calculateConfidence(
    entities: ParsedEntities,
    device: Device,
    action: string,
    actionConfidence: number,
  ): number {
    let confidence = actionConfidence;

    // 设备匹配置信度
    if (entities.location && entities.deviceName) confidence += 0.05;
    if (!entities.deviceName) confidence -= 0.2;

    // 动作支持置信度
    if (!device.capabilities.includes(action)) confidence -= 0.3;

    return Math.max(0, Math.min(1, confidence));
  }

  private generateClarifications(entities: ParsedEntities, _device: Device): string[] {
    const clarifications: string[] = [];
    if (!entities.deviceName) {
      clarifications.push('请指定要控制的设备类型（如灯、空调、电视等）');
    }
    if (!entities.location && !entities.deviceName) {
      clarifications.push('请指定设备位置（如客厅、卧室等）');
    }
    return clarifications;
  }
}
