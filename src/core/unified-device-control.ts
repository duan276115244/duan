/**
 * 统一设备控制接口 — UnifiedDeviceControl
 *
 * P2-7: 统一桌面 + 智能家居 + 跨设备控制
 *
 * 核心能力：
 * 1. 设备注册 — 统一注册不同平台设备（Windows/macOS/Linux/Android/iOS/HomeAssistant/MiHome/HomeKit）
 * 2. 设备发现 — 自动发现局域网内可控制设备
 * 3. 状态查询 — 实时获取设备状态
 * 4. 动作执行 — 统一的动作接口（on/off/set_brightness/set_temperature...）
 * 5. 事件订阅 — 设备状态变化通知
 * 6. 场景联动 — 多设备协同工作流
 *
 * 复用：
 * - desktop-control.ts（桌面控制）
 * - universal-desktop.ts（通用桌面操作）
 */

import { EventEmitter } from 'events';
import { logger } from '../core/structured-logger.js';
import type { ToolDef } from './unified-tool-def.js';

// ============ 类型定义 ============

export type DeviceType =
  | 'computer'    // 电脑
  | 'phone'       // 手机
  | 'speaker'     // 音箱
  | 'light'       // 灯光
  | 'thermostat'  // 温控
  | 'tv'          // 电视
  | 'sensor'      // 传感器
  | 'lock'        // 门锁
  | 'curtain'     // 窗帘
  | 'fan'         // 风扇
  | 'air_conditioner' // 空调
  | 'robot_vacuum';    // 扫地机器人

export type DevicePlatform =
  | 'windows'
  | 'macos'
  | 'linux'
  | 'android'
  | 'ios'
  | 'homeassistant'
  | 'mihome'
  | 'homekit'
  | 'local';

export type DeviceStatus = 'online' | 'offline' | 'error' | 'unknown';

export interface DeviceState {
  power: 'on' | 'off';
  brightness?: number;      // 0-100
  temperature?: number;     // 摄氏度
  volume?: number;          // 0-100
  color?: string;           // hex 颜色
  position?: number;        // 0-100（窗帘/舵机位置）
  mode?: string;            // 模式（auto/cool/heat/...）
  battery?: number;         // 0-100
  [key: string]: unknown;
}

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  platform: DevicePlatform;
  status: DeviceStatus;
  state: DeviceState;
  capabilities: string[];   // 支持的动作列表
  location?: string;        // 位置（客厅/卧室/...）
  lastSeen: number;
  metadata?: Record<string, unknown>;
}

export interface DeviceAction {
  deviceId: string;
  action: string;
  params?: Record<string, unknown>;
}

export interface ActionResult {
  success: boolean;
  deviceId: string;
  action: string;
  newState?: Partial<DeviceState>;
  message?: string;
  timestamp: number;
}

export type DeviceEventHandler = (device: Device, event: string, data?: unknown) => void;

// ============ 设备适配器接口 ============

export interface DeviceAdapter {
  platform: DevicePlatform;
  discover(): Promise<Device[]>;
  getState(deviceId: string): Promise<DeviceState>;
  execute(deviceId: string, action: string, params?: Record<string, unknown>): Promise<ActionResult>;
  subscribe(deviceId: string, event: string, handler: DeviceEventHandler): void;
}

// ============ 统一设备控制 ============

export class UnifiedDeviceControl extends EventEmitter {
  private devices: Map<string, Device> = new Map();
  private adapters: Map<DevicePlatform, DeviceAdapter> = new Map();
  private eventHandlers: Map<string, Set<DeviceEventHandler>> = new Map();
  private actionHistory: ActionResult[] = [];
  private readonly maxHistory = 200;
  /** P2-2: 自然语言命令解析器（可选注入） */
  private nlParser: any | null = null;

  /**
   * 注册设备适配器
   */
  registerAdapter(adapter: DeviceAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    logger.info('设备适配器已注册', { module: 'UnifiedDeviceControl', platform: adapter.platform });
  }

  /**
   * 手动注册设备
   */
  registerDevice(device: Device): void {
    this.devices.set(device.id, device);
    this.emit('deviceRegistered', device);
    logger.info('设备已注册', {
      module: 'UnifiedDeviceControl',
      id: device.id,
      name: device.name,
      type: device.type,
      platform: device.platform,
    });
  }

  /**
   * 注销设备
   */
  unregisterDevice(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    this.devices.delete(deviceId);
    this.emit('deviceUnregistered', device);
    return true;
  }

  /**
   * 发现所有平台的设备
   */
  async discoverAll(): Promise<Device[]> {
    const allDiscovered: Device[] = [];
    const discoveries = Array.from(this.adapters.values()).map(async (adapter) => {
      try {
        const devices = await adapter.discover();
        for (const device of devices) {
          this.devices.set(device.id, device);
          allDiscovered.push(device);
        }
        return devices;
      } catch (err) {
        logger.warn('设备发现失败', {
          module: 'UnifiedDeviceControl',
          platform: adapter.platform,
          error: String(err),
        });
        return [];
      }
    });

    await Promise.all(discoveries);
    this.emit('discoveryComplete', allDiscovered);
    logger.info('设备发现完成', { module: 'UnifiedDeviceControl', count: allDiscovered.length });
    return allDiscovered;
  }

  /**
   * 获取所有设备
   */
  listDevices(filter?: {
    type?: DeviceType;
    platform?: DevicePlatform;
    status?: DeviceStatus;
    location?: string;
  }): Device[] {
    let devices = Array.from(this.devices.values());
    if (filter) {
      if (filter.type) devices = devices.filter(d => d.type === filter.type);
      if (filter.platform) devices = devices.filter(d => d.platform === filter.platform);
      if (filter.status) devices = devices.filter(d => d.status === filter.status);
      if (filter.location) devices = devices.filter(d => d.location === filter.location);
    }
    return devices;
  }

  /**
   * 获取单个设备
   */
  getDevice(deviceId: string): Device | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * 查找设备（模糊匹配名称或 ID）
   */
  findDevice(query: string): Device | undefined {
    // 精确 ID 匹配
    const byId = this.devices.get(query);
    if (byId) return byId;

    // 名称模糊匹配
    const queryLower = query.toLowerCase();
    for (const device of this.devices.values()) {
      if (device.name.toLowerCase().includes(queryLower)) {
        return device;
      }
    }

    // 位置 + 类型匹配（如"客厅灯"）
    for (const device of this.devices.values()) {
      const locationMatch = device.location?.toLowerCase().includes(queryLower);
      const typeMatch = device.type.includes(queryLower);
      if (locationMatch || typeMatch) return device;
    }

    return undefined;
  }

  /**
   * 获取设备状态
   */
  async getState(deviceId: string): Promise<DeviceState> {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`设备不存在: ${deviceId}`);

    // 优先从适配器获取实时状态
    const adapter = this.adapters.get(device.platform);
    if (adapter) {
      try {
        const state = await adapter.getState(deviceId);
        device.state = { ...device.state, ...state };
        device.lastSeen = Date.now();
        return device.state;
      } catch (err) {
        logger.warn('获取设备状态失败，使用缓存', {
          module: 'UnifiedDeviceControl',
          deviceId,
          error: String(err),
        });
      }
    }

    return device.state;
  }

  /**
   * 执行设备动作
   */
  async execute(action: DeviceAction): Promise<ActionResult> {
    const device = this.devices.get(action.deviceId);
    if (!device) {
      return {
        success: false,
        deviceId: action.deviceId,
        action: action.action,
        message: `设备不存在: ${action.deviceId}`,
        timestamp: Date.now(),
      };
    }

    // 检查设备是否支持该动作
    if (!device.capabilities.includes(action.action)) {
      return {
        success: false,
        deviceId: action.deviceId,
        action: action.action,
        message: `设备 ${device.name} 不支持动作: ${action.action}`,
        timestamp: Date.now(),
      };
    }

    // 通过适配器执行
    const adapter = this.adapters.get(device.platform);
    let result: ActionResult;

    if (adapter) {
      try {
        result = await adapter.execute(action.deviceId, action.action, action.params);
      } catch (err) {
        result = {
          success: false,
          deviceId: action.deviceId,
          action: action.action,
          message: `执行失败: ${String(err)}`,
          timestamp: Date.now(),
        };
      }
    } else {
      // 无适配器，模拟执行（用于测试/桌面控制）
      result = this.simulateAction(device, action);
    }

    // 更新设备状态
    if (result.success && result.newState) {
      device.state = { ...device.state, ...result.newState };
    }
    device.lastSeen = Date.now();

    // 记录历史
    this.actionHistory.push(result);
    if (this.actionHistory.length > this.maxHistory) {
      this.actionHistory.shift();
    }

    this.emit('actionExecuted', result);
    logger.info('设备动作执行', {
      module: 'UnifiedDeviceControl',
      device: device.name,
      action: action.action,
      success: result.success,
    });

    return result;
  }

  /**
   * 批量执行动作
   */
  async executeBatch(actions: DeviceAction[], mode: 'sequential' | 'parallel' = 'parallel'): Promise<ActionResult[]> {
    if (mode === 'parallel') {
      return Promise.all(actions.map(a => this.execute(a)));
    }
    const results: ActionResult[] = [];
    for (const action of actions) {
      results.push(await this.execute(action));
    }
    return results;
  }

  /**
   * 订阅设备事件
   */
  subscribe(deviceId: string, event: string, handler: DeviceEventHandler): void {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`设备不存在: ${deviceId}`);

    const key = `${deviceId}:${event}`;
    if (!this.eventHandlers.has(key)) {
      this.eventHandlers.set(key, new Set());
    }
    this.eventHandlers.get(key)!.add(handler);

    // 通过适配器订阅
    const adapter = this.adapters.get(device.platform);
    if (adapter) {
      adapter.subscribe(deviceId, event, (dev, evt, data) => {
        this.emit('deviceEvent', { device: dev, event: evt, data });
        handler(dev, evt, data);
      });
    }
  }

  /**
   * 获取动作历史
   */
  getActionHistory(limit?: number): ActionResult[] {
    return limit ? this.actionHistory.slice(-limit) : [...this.actionHistory];
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalDevices: number;
    onlineDevices: number;
    byType: Record<string, number>;
    byPlatform: Record<string, number>;
    totalActions: number;
    successRate: number;
  } {
    const devices = Array.from(this.devices.values());
    const byType: Record<string, number> = {};
    const byPlatform: Record<string, number> = {};

    for (const d of devices) {
      byType[d.type] = (byType[d.type] || 0) + 1;
      byPlatform[d.platform] = (byPlatform[d.platform] || 0) + 1;
    }

    const successfulActions = this.actionHistory.filter(a => a.success).length;

    return {
      totalDevices: devices.length,
      onlineDevices: devices.filter(d => d.status === 'online').length,
      byType,
      byPlatform,
      totalActions: this.actionHistory.length,
      successRate: this.actionHistory.length > 0 ? successfulActions / this.actionHistory.length : 0,
    };
  }

  // ===== 内部方法 =====

  private simulateAction(device: Device, action: DeviceAction): ActionResult {
    const newState: Partial<DeviceState> = {};

    switch (action.action) {
      case 'on':
        newState.power = 'on';
        break;
      case 'off':
        newState.power = 'off';
        break;
      case 'set_brightness':
        newState.brightness = Number(action.params?.brightness ?? 50);
        break;
      case 'set_temperature':
        newState.temperature = Number(action.params?.temperature ?? 25);
        break;
      case 'set_volume':
        newState.volume = Number(action.params?.volume ?? 50);
        break;
      case 'set_color':
        newState.color = String(action.params?.color ?? '#ffffff');
        break;
      case 'set_position':
        newState.position = Number(action.params?.position ?? 50);
        break;
      case 'set_mode':
        newState.mode = String(action.params?.mode ?? 'auto');
        break;
    }

    return {
      success: true,
      deviceId: device.id,
      action: action.action,
      newState,
      message: `模拟执行: ${action.action}`,
      timestamp: Date.now(),
    };
  }

  // ===== P2-2: 自然语言解析器注入 =====

  /**
   * 注入自然语言命令解析器
   * 注入后，iot_nl_command 工具将可用，支持自然语言设备控制
   */
  setNLParser(parser: any): void {
    this.nlParser = parser;
    logger.info('自然语言命令解析器已注入', { module: 'UnifiedDeviceControl' });
  }

  // ===== P2-1/P2-2: Agent Loop 工具定义 =====

  /**
   * 获取工具定义 — 暴露设备控制能力给 Agent 主循环
   */
  getToolDefinitions(): ToolDef[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const system = this;

    return [
      {
        name: 'iot_discover',
        description: '发现局域网内所有可控制的 IoT 设备（HomeAssistant/MiHome/HomeKit/MQTT）。返回设备列表，包含设备ID、名称、类型、平台、支持的动作。',
        readOnly: true,
        parameters: {},
        execute: async () => {
          try {
            const devices = await system.discoverAll();
            return JSON.stringify({
              success: true,
              count: devices.length,
              devices: devices.map(d => ({
                id: d.id,
                name: d.name,
                type: d.type,
                platform: d.platform,
                capabilities: d.capabilities,
              })),
            });
          } catch (err: any) {
            return `设备发现失败: ${err.message || String(err)}`;
          }
        },
      },
      {
        name: 'iot_list',
        description: '列出已注册的所有设备。可选按类型（light/thermostat/tv/fan/curtain/lock/sensor 等）或平台过滤。',
        readOnly: true,
        parameters: {
          type: {
            type: 'string',
            description: '按设备类型过滤（可选）',
            required: false,
          },
          platform: {
            type: 'string',
            description: '按平台过滤（homeassistant/mihome/homekit/mqtt）',
            required: false,
          },
        },
        execute: async (args) => {
          const filter: any = {};
          if (args.type) filter.type = args.type;
          if (args.platform) filter.platform = args.platform;
          const devices = system.listDevices(Object.keys(filter).length > 0 ? filter : undefined);
          return JSON.stringify({
            count: devices.length,
            devices: devices.map(d => ({
              id: d.id,
              name: d.name,
              type: d.type,
              platform: d.platform,
              capabilities: d.capabilities,
              state: d.state,
            })),
          });
        },
      },
      {
        name: 'iot_state',
        description: '查询指定设备的当前状态（电源/亮度/温度/音量等）。',
        readOnly: true,
        parameters: {
          deviceId: {
            type: 'string',
            description: '设备ID',
            required: true,
          },
        },
        execute: async (args) => {
          try {
            const state = await system.getState(args.deviceId as string);
            return JSON.stringify({ deviceId: args.deviceId, state });
          } catch (err: any) {
            return `状态查询失败: ${err.message || String(err)}`;
          }
        },
      },
      {
        name: 'iot_control',
        description: '控制 IoT 设备执行指定动作。常用动作：on（开）、off（关）、set_brightness（设置亮度0-100）、set_temperature（设置温度）、set_volume（设置音量）、set_color（设置颜色）。',
        readOnly: false,
        parameters: {
          deviceId: {
            type: 'string',
            description: '设备ID',
            required: true,
          },
          action: {
            type: 'string',
            description: '动作名称（如 on/off/set_brightness/set_temperature/set_volume/set_color）',
            required: true,
          },
          params: {
            type: 'string',
            description: '动作参数（JSON格式），如 {"brightness":80} 或 {"temperature":26}',
            required: false,
          },
        },
        execute: async (args) => {
          try {
            let params: Record<string, unknown> = {};
            if (args.params) {
              try {
                params = JSON.parse(args.params as string);
              } catch {
                return '参数格式无效，请提供合法的 JSON';
              }
            }
            const result = await system.execute({
              deviceId: args.deviceId as string,
              action: args.action as string,
              params,
            });
            return JSON.stringify(result);
          } catch (err: any) {
            return `设备控制失败: ${err.message || String(err)}`;
          }
        },
      },
      {
        name: 'iot_nl_command',
        description: '通过自然语言控制 IoT 设备。自动解析中文/英文命令并执行。例如："打开客厅的灯"、"把卧室空调调到26度"、"关闭所有灯"。',
        readOnly: false,
        parameters: {
          utterance: {
            type: 'string',
            description: '自然语言命令（如"打开客厅的灯"、"把空调调到26度"）',
            required: true,
          },
        },
        execute: async (args) => {
          if (!system.nlParser) {
            return '自然语言命令解析器未注入，无法解析命令。请直接使用 iot_control 工具。';
          }
          try {
            const utterance = args.utterance as string;
            const availableDevices = system.listDevices();
            if (availableDevices.length === 0) {
              return '没有已注册的设备。请先调用 iot_discover 发现设备。';
            }
            const command = await system.nlParser.parse(utterance, availableDevices);
            if (command.clarifications && command.clarifications.length > 0) {
              return JSON.stringify({
                success: false,
                confidence: command.confidence,
                clarifications: command.clarifications,
                message: '命令不够明确，请澄清以下问题',
              });
            }
            const result = await system.execute({
              deviceId: command.device,
              action: command.action,
              params: command.params || {},
            });
            return JSON.stringify({
              success: result.success,
              parsedCommand: {
                device: command.device,
                action: command.action,
                params: command.params,
              },
              confidence: command.confidence,
              result: result.message,
            });
          } catch (err: any) {
            return `自然语言命令执行失败: ${err.message || String(err)}`;
          }
        },
      },
    ];
  }
}
