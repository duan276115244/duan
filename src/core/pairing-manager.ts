/**
 * 配对管理器（PairingManager）
 *
 * 参考 OpenClaw 的配对码授权机制：
 * - 管理员生成一次性配对码（6位数字，5分钟过期）
 * - 陌生用户在聊天中输入配对码完成绑定
 * - 已配对用户持久化存储，重启不丢失
 * - 支持按通道（feishu/telegram/discord...）独立管理
 *
 * 持久化文件：~/.duan/paired-users.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomInt } from 'crypto';
import { duanPath } from './duan-paths.js';
import { atomicWriteJsonSync } from './atomic-write.js';

/** 已配对用户记录 */
export interface PairedUser {
  /** 通道类型：feishu / telegram / discord / wecom / dingtalk / slack / wechat / whatsapp / teams / qq / email / sms / wechat_oa / serverchan / bark */
  channelType: string;
  /** 通道内用户唯一标识（如飞书 open_id、Telegram chat_id、Discord user_id） */
  userId: string;
  /** 用户显示名（可选，便于管理员识别） */
  displayName?: string;
  /** 配对时间（ISO 字符串） */
  pairedAt: string;
  /** 配对码（用于审计） */
  pairedByCode: string;
}

/** 待使用配对码 */
export interface PairingCode {
  code: string;
  /** 生成时间（毫秒时间戳） */
  createdAt: number;
  /** 过期时间（毫秒时间戳） */
  expiresAt: number;
  /** 是否已使用 */
  used: boolean;
  /** 备注说明（可选，如"给张三的配对码"） */
  note?: string;
}

/** 配对码配置 */
const PAIRING_CODE_LENGTH = 6;
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 配对管理器单例
 */
export class PairingManager {
  private static instance: PairingManager;
  private pairedUsers: PairedUser[] = [];
  private pendingCodes: PairingCode[] = [];
  private configPath: string;

  private constructor() {
    const configDir = duanPath();
    this.configPath = path.join(configDir, 'paired-users.json');
    // 确保 ~/.duan/ 目录存在
    try {
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
        console.info(`[PairingManager] 创建配置目录: ${configDir}`);
      }
    } catch (e) {
      console.error(`[PairingManager] 创建配置目录失败: ${(e as Error).message}`);
    }
    this.load();
  }

  static getInstance(): PairingManager {
    if (!PairingManager.instance) {
      PairingManager.instance = new PairingManager();
    }
    return PairingManager.instance;
  }

  /** 从磁盘加载已配对用户和未使用配对码 */
  private load(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        this.pairedUsers = Array.isArray(data.pairedUsers) ? data.pairedUsers : [];
        this.pendingCodes = Array.isArray(data.pendingCodes) ? data.pendingCodes : [];
        // 清理过期配对码
        const now = Date.now();
        this.pendingCodes = this.pendingCodes.filter(c => c.expiresAt > now && !c.used);
      }
    } catch (e) {
      console.error('[PairingManager] 加载配对数据失败:', (e as Error).message);
      this.pairedUsers = [];
      this.pendingCodes = [];
    }
  }

  /** 持久化到磁盘 */
  private save(): void {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      atomicWriteJsonSync(this.configPath, {
        pairedUsers: this.pairedUsers,
        pendingCodes: this.pendingCodes,
      });
    } catch (e) {
      console.error('[PairingManager] 保存配对数据失败:', (e as Error).message);
    }
  }

  /**
   * 生成配对码
   * @param note 备注说明（可选）
   * @returns 6 位数字配对码
   */
  generateCode(note?: string): string {
    // 清理过期配对码
    const now = Date.now();
    this.pendingCodes = this.pendingCodes.filter(c => c.expiresAt > now && !c.used);

    // 生成 6 位数字配对码
    const code = String(randomInt(0, 1000000)).padStart(PAIRING_CODE_LENGTH, '0');
    const pairingCode: PairingCode = {
      code,
      createdAt: now,
      expiresAt: now + PAIRING_CODE_TTL_MS,
      used: false,
      note,
    };
    this.pendingCodes.push(pairingCode);
    this.save();
    console.info(`[PairingManager] 生成配对码: ${code}${note ? ` (备注: ${note})` : ''}，5分钟内有效`);
    return code;
  }

  /**
   * 验证配对码并绑定用户
   * @param code 用户输入的配对码
   * @param channelType 通道类型
   * @param userId 通道内用户 ID
   * @param displayName 用户显示名（可选）
   * @returns true=配对成功，false=配对码无效/已过期/已使用
   */
  verifyAndPair(code: string, channelType: string, userId: string, displayName?: string): boolean {
    const now = Date.now();
    // 查找匹配的配对码
    const pairingCode = this.pendingCodes.find(c =>
      c.code === code && !c.used && c.expiresAt > now
    );
    if (!pairingCode) {
      return false;
    }

    // 标记配对码已使用
    pairingCode.used = true;

    // 检查是否已配对（避免重复）
    const existing = this.pairedUsers.find(u =>
      u.channelType === channelType && u.userId === userId
    );
    if (!existing) {
      this.pairedUsers.push({
        channelType,
        userId,
        displayName,
        pairedAt: new Date().toISOString(),
        pairedByCode: code,
      });
    }

    // 清理已使用的配对码
    this.pendingCodes = this.pendingCodes.filter(c => !c.used);
    this.save();
    console.info(`[PairingManager] 用户配对成功: ${channelType}/${userId}${displayName ? ` (${displayName})` : ''}`);
    return true;
  }

  /**
   * 检查用户是否已配对
   * @param channelType 通道类型
   * @param userId 通道内用户 ID
   * @returns true=已配对（允许使用），false=未配对
   */
  isPaired(channelType: string, userId: string): boolean {
    return this.pairedUsers.some(u =>
      u.channelType === channelType && u.userId === userId
    );
  }

  /**
   * 列出所有已配对用户
   * @param channelType 可选，按通道过滤
   */
  listPairedUsers(channelType?: string): PairedUser[] {
    if (channelType) {
      return this.pairedUsers.filter(u => u.channelType === channelType);
    }
    return [...this.pairedUsers];
  }

  /**
   * 列出所有待使用配对码
   */
  listPendingCodes(): PairingCode[] {
    const now = Date.now();
    return this.pendingCodes.filter(c => c.expiresAt > now && !c.used);
  }

  /**
   * 批准配对码（参考 OpenClaw 的 pairing approve 命令）
   *
   * OpenClaw 流程：陌生用户发消息 → 机器人自动生成配对码并回复 → 管理员批准
   *
   * @param channelType 通道类型（如 feishu）
   * @param code 配对码
   * @returns true=批准成功，false=配对码无效/已过期
   */
  approve(channelType: string, code: string): { success: boolean; message: string } {
    const now = Date.now();
    const pairingCode = this.pendingCodes.find(c =>
      c.code === code && !c.used && c.expiresAt > now
    );

    if (!pairingCode) {
      return { success: false, message: `配对码 ${code} 无效或已过期` };
    }

    // 标记配对码已使用（批准即视为使用）
    pairingCode.used = true;

    // 从配对码的备注中提取用户信息（格式: "自动配对请求(feishu/ou_xxx)"）
    const note = pairingCode.note || '';
    const match = note.match(/\((\w+)\/([^)]+)\)/);
    if (match) {
      const chType = match[1];
      const userId = match[2];
      // 检查是否已配对
      const existing = this.pairedUsers.find(u =>
        u.channelType === chType && u.userId === userId
      );
      if (!existing) {
        this.pairedUsers.push({
          channelType: chType,
          userId,
          displayName: `${chType}用户`,
          pairedAt: new Date().toISOString(),
          pairedByCode: code,
        });
      }
    }

    // 清理已使用的配对码
    this.pendingCodes = this.pendingCodes.filter(c => !c.used);
    this.save();
    console.info(`[PairingManager] 管理员批准配对码: ${code} (通道: ${channelType})`);
    return { success: true, message: `配对码 ${code} 已批准` };
  }

  /**
   * 解除用户配对
   * @param channelType 通道类型
   * @param userId 通道内用户 ID
   * @returns true=解除成功，false=用户未配对
   */
  unpair(channelType: string, userId: string): boolean {
    const before = this.pairedUsers.length;
    this.pairedUsers = this.pairedUsers.filter(u =>
      !(u.channelType === channelType && u.userId === userId)
    );
    const removed = this.pairedUsers.length < before;
    if (removed) {
      this.save();
      console.info(`[PairingManager] 解除配对: ${channelType}/${userId}`);
    }
    return removed;
  }

  /**
   * 手动添加白名单用户（无需配对码）
   * @param channelType 通道类型
   * @param userId 通道内用户 ID
   * @param displayName 显示名（可选）
   */
  addWhitelist(channelType: string, userId: string, displayName?: string): void {
    const existing = this.pairedUsers.find(u =>
      u.channelType === channelType && u.userId === userId
    );
    if (!existing) {
      this.pairedUsers.push({
        channelType,
        userId,
        displayName,
        pairedAt: new Date().toISOString(),
        pairedByCode: 'manual',
      });
      this.save();
      console.info(`[PairingManager] 手动添加白名单: ${channelType}/${userId}`);
    }
  }

  /**
   * 清除某通道的所有配对用户
   */
  clearChannel(channelType: string): number {
    const before = this.pairedUsers.length;
    this.pairedUsers = this.pairedUsers.filter(u => u.channelType !== channelType);
    const removed = before - this.pairedUsers.length;
    if (removed > 0) {
      this.save();
      console.info(`[PairingManager] 清除通道 ${channelType} 的 ${removed} 个配对用户`);
    }
    return removed;
  }
}
