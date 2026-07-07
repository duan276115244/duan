/**
 * 动态 Skill 生成系统 — SkillGenerator
 *
 * 基于自然语言任务需求自动生成完整的 Skill 包（SKILL.md），
 * 支持技能版本控制与回滚、多维度质量评估、可视化管理接口。
 *
 * 核心能力：
 * - NL→Skill: 用户用自然语言描述需求，自动生成 SKILL.md
 * - 模块化设计：生成的技能可灵活组合与扩展
 * - 版本控制：语义化版本 + 回滚
 * - 质量评估：生成技能执行成功率追踪（目标 85%+）
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { logger } from './structured-logger.js';
import { EventBus } from './event-bus.js';
import { duanPath } from './duan-paths.js';

const DEFAULT_SKILLS_DIR = duanPath('generated-skills');

export interface SkillMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  requires: string[];
  successRate: number;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SkillVersion {
  version: string;
  manifest: string;
  checksum: string;
  createdAt: number;
  message: string;
}

export interface SkillQualityReport {
  skillId: string;
  overallScore: number;
  dimensions: {
    correctness: number;
    completeness: number;
    usability: number;
    performance: number;
  };
  executionSuccessRate: number;
  sampleSize: number;
  recommendations: string[];
}

export class SkillGenerator {
  private log = logger.child({ module: 'SkillGenerator' });
  private skills: Map<string, SkillMeta> = new Map();
  private versions: Map<string, SkillVersion[]> = new Map();
  private qualityLog: Map<string, { success: boolean; duration: number }[]> = new Map();
  private readonly SUCCESS_TARGET = 0.85;
  /** 持久化目录（支持依赖注入） */
  private readonly skillsDir: string;

  constructor(options?: { dataDir?: string }) {
    this.skillsDir = options?.dataDir
      ? path.join(options.dataDir, 'generated-skills')
      : DEFAULT_SKILLS_DIR;
    fs.mkdirSync(this.skillsDir, { recursive: true });
    this.loadState();
  }

  async generateFromNL(description: string, llmCall: (prompt: string) => Promise<string | null>): Promise<SkillMeta | null> {
    const prompt = `你是一个技能生成专家。根据用户的自然语言需求，生成一个完整的 AI 技能（SKILL.md 格式）。

用户需求: "${description}"

请生成 YAML frontmatter + Markdown 正文，格式如下：
---
id: kebab-case-id
name: 技能名称
version: 1.0.0
description: 一句话描述
category: development|research|writing|data|design|communication|automation
tags: [tag1, tag2]
requires: []
---
## 功能描述
详细说明这个技能做什么

## 使用场景
列出适用场景

## 工作流程
1. 步骤一
2. 步骤二

## 示例
- 输入示例
- 输出示例

## 注意事项
- 注意事项

只返回 SKILL.md 内容，不要其他解释。`;

    const result = await llmCall(prompt);
    if (!result) return null;

    const id = this.extractId(result) || this.generateId(description);
    const existing = this.skills.get(id);
    const version = existing ? this.bumpVersion(existing.version) : '1.0.0';

    const meta: SkillMeta = {
      id,
      name: this.extractField(result, 'name') || id,
      version,
      description: this.extractField(result, 'description') || description,
      author: 'SkillGenerator',
      category: this.extractField(result, 'category') || 'automation',
      tags: this.extractTags(result),
      requires: this.extractList(result, 'requires'),
      successRate: 0,
      usageCount: 0,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    const filePath = path.join(this.skillsDir, `${id}.md`);
    fs.writeFileSync(filePath, result, 'utf-8');

    const existingVersions = this.versions.get(id) || [];
    existingVersions.push({
      version,
      manifest: result,
      checksum: this.checksum(result),
      createdAt: Date.now(),
      message: existing ? `从自然语言更新: ${description}` : `从自然语言生成: ${description}`,
    });
    this.versions.set(id, existingVersions);
    this.skills.set(id, meta);

    if (existing) {
      this.persistState();
      this.log.info('技能已更新', { id, version });
    } else {
      this.persistState();
      this.log.info('技能已生成', { id, version, description });
    }

    EventBus.getInstance().emit('skill.generated', { id, name: meta.name, version }, { source: 'SkillGenerator' }).catch(() => {});
    return meta;
  }

  getSkill(id: string): SkillMeta | undefined {
    return this.skills.get(id);
  }

  listSkills(): SkillMeta[] {
    return Array.from(this.skills.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSkillContent(id: string): string | null {
    const filePath = path.join(this.skillsDir, `${id}.md`);
    try {
      if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
    } catch {}
    return null;
  }

  getVersionHistory(id: string): SkillVersion[] {
    return this.versions.get(id) || [];
  }

  rollback(id: string, version: string): boolean {
    const versions = this.versions.get(id);
    if (!versions) return false;
    const target = versions.find(v => v.version === version);
    if (!target) return false;
    const filePath = path.join(this.skillsDir, `${id}.md`);
    try {
      fs.writeFileSync(filePath, target.manifest, 'utf-8');
      const meta = this.skills.get(id);
      if (meta) {
        const newVersion = this.bumpVersion(meta.version);
        meta.version = newVersion;
        meta.updatedAt = Date.now();
        versions.push({
          version: newVersion,
          manifest: target.manifest,
          checksum: this.checksum(target.manifest),
          createdAt: Date.now(),
          message: `回滚到 ${version}`,
        });
        this.persistState();
      }
      this.log.info('技能已回滚', { id, from: meta?.version, to: version });
      return true;
    } catch {
      return false;
    }
  }

  deleteSkill(id: string): boolean {
    const filePath = path.join(this.skillsDir, `${id}.md`);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      this.skills.delete(id);
      this.versions.delete(id);
      this.qualityLog.delete(id);
      this.persistState();
      this.log.info('技能已删除', { id });
      return true;
    } catch {
      return false;
    }
  }

  recordExecution(id: string, success: boolean, duration: number): void {
    const meta = this.skills.get(id);
    if (!meta) return;
    meta.usageCount++;
    const log = this.qualityLog.get(id) || [];
    log.push({ success, duration });
    if (log.length > 100) log.shift();
    this.qualityLog.set(id, log);
    const successCount = log.filter(r => r.success).length;
    meta.successRate = log.length > 0 ? successCount / log.length : 0;
    this.persistState();
  }

  generateQualityReport(id: string): SkillQualityReport | null {
    const meta = this.skills.get(id);
    if (!meta) return null;
    const log = this.qualityLog.get(id) || [];
    const sampleSize = log.length;
    const successRate = sampleSize > 0 ? log.filter(r => r.success).length / sampleSize : 0;
    const avgDuration = sampleSize > 0 ? log.reduce((s, r) => s + r.duration, 0) / sampleSize : 0;
    const content = this.getSkillContent(id);

    const correctness = Math.min(1, successRate + 0.1);
    const completeness = content && content.length > 200 ? Math.min(1, content.length / 2000) : 0.3;
    const usability = Math.min(1, (meta.usageCount / 20) + (meta.tags.length / 10));
    const performance = Math.min(1, avgDuration > 0 ? 1 - (avgDuration / 30000) : 0.5);

    const overallScore = correctness * 0.35 + completeness * 0.25 + usability * 0.2 + performance * 0.2;

    const recommendations: string[] = [];
    if (correctness < 0.7) recommendations.push('执行成功率偏低，建议检查技能逻辑');
    if (completeness < 0.5) recommendations.push('技能描述不够详细，建议补充使用场景和示例');
    if (meta.usageCount < 5) recommendations.push('使用次数较少，建议更多调用以评估效果');
    if (!meta.tags.includes('tested')) recommendations.push('建议在技能描述中添加 tested 标签标记已验证状态');

    return {
      skillId: id,
      overallScore,
      dimensions: { correctness, completeness, usability, performance },
      executionSuccessRate: successRate,
      sampleSize,
      recommendations,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getToolDefinitions(llmCall: (prompt: string) => Promise<string | null>): Array<{ name: string; description: string; parameters: Record<string, any>; execute: (args: any) => any }> {
    return [
      {
        name: 'skill_generate',
        description: '根据自然语言描述自动生成一个完整技能（SKILL.md），包含版本控制和质量评估',
        parameters: {
          description: { type: 'string', description: '技能功能描述（自然语言）', required: true },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (args: any) => {
          const meta = await this.generateFromNL(args.description, llmCall);
          if (!meta) return '❌ 技能生成失败，请稍后重试';
          return `✅ 技能已生成: ${meta.name} (v${meta.version})\nID: ${meta.id}\n分类: ${meta.category}\n描述: ${meta.description}`;
        },
      },
      {
        name: 'skill_list',
        description: '列出所有已生成的技能及其版本和成功率',
        parameters: {},
        execute: () => {
          const list = this.listSkills();
          if (list.length === 0) return '暂无已生成的技能';
          return list.map(s =>
            `  ${s.id} — ${s.name} v${s.version} | 成功率: ${(s.successRate * 100).toFixed(0)}% | 使用: ${s.usageCount}次`
          ).join('\n');
        },
      },
      {
        name: 'skill_quality',
        description: '获取指定技能的质量评估报告',
        parameters: {
          id: { type: 'string', description: '技能ID', required: true },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: (args: any) => {
          const report = this.generateQualityReport(args.id);
          if (!report) return `❌ 未找到技能: ${args.id}`;
          return JSON.stringify(report, null, 2);
        },
      },
      {
        name: 'skill_rollback',
        description: '将技能回滚到指定版本',
        parameters: {
          id: { type: 'string', description: '技能ID', required: true },
          version: { type: 'string', description: '目标版本号', required: true },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: (args: any) => {
          const ok = this.rollback(args.id, args.version);
          return ok ? `✅ 已回滚 ${args.id} 到 ${args.version}` : `❌ 回滚失败`;
        },
      },
    ];
  }

  private extractId(content: string): string | null {
    const m = content.match(/^id:\s*(\S+)/m);
    return m ? m[1] : null;
  }

  private extractField(content: string, field: string): string | null {
    const m = content.match(new RegExp(`^${field}:\\s*(.+)`, 'm'));
    return m ? m[1].trim() : null;
  }

  private extractTags(content: string): string[] {
    const m = content.match(/^tags:\s*\[(.+)\]/m);
    if (!m) return [];
    return m[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, ''));
  }

  private extractList(content: string, field: string): string[] {
    const m = content.match(new RegExp(`^${field}:\\s*\\[(.+)\\]`, 'm'));
    if (!m) return [];
    return m[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, ''));
  }

  private generateId(description: string): string {
    return description
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 40) || `skill-${Date.now()}`;
  }

  /**
   * 语义化版本递增（SemVer规范）
   * @param current 当前版本号 (x.y.z)
   * @param changeType 变更类型：major(breaking)/minor(feature)/patch(fix)
   */
  private bumpVersion(current: string, changeType: 'major' | 'minor' | 'patch' = 'patch'): string {
    const parts = current.split('.').map(n => parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);

    switch (changeType) {
      case 'major':
        parts[0]++;
        parts[1] = 0;
        parts[2] = 0;
        break;
      case 'minor':
        parts[1]++;
        parts[2] = 0;
        break;
      case 'patch':
      default:
        parts[2]++;
        break;
    }
    return parts.join('.');
  }

  /**
   * SHA-256 加密校验和（替代不安全的 DJB2 哈希）
   * 防止碰撞风险，确保版本内容完整性验证可靠
   */
  private checksum(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 32);
  }

  /**
   * 比较两个版本号大小
   * @returns 正数 v1>v2，负数 v1<v2，0 相等
   */
  compareVersions(v1: string, v2: string): number {
    const p1 = v1.split('.').map(n => parseInt(n, 10) || 0);
    const p2 = v2.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const a = p1[i] || 0;
      const b = p2[i] || 0;
      if (a !== b) return a - b;
    }
    return 0;
  }

  /**
   * 生成两个版本间的差异摘要
   */
  diffVersions(skillId: string, v1: string, v2: string): { added: string[]; removed: string[]; modified: string[] } | null {
    const versions = this.versions.get(skillId);
    if (!versions) return null;

    const ver1 = versions.find(v => v.version === v1);
    const ver2 = versions.find(v => v.version === v2);
    if (!ver1 || !ver2) return null;

    // 基于 checksum 判断是否有变更
    const result = { added: [] as string[], removed: [] as string[], modified: [] as string[] };

    if (ver1.checksum !== ver2.checksum) {
      result.modified.push('manifest content changed');
    }

    // 版本号变化
    if (this.compareVersions(v2, v1) > 0) {
      result.added.push(`version bumped: ${v1} → ${v2}`);
    } else if (this.compareVersions(v2, v1) < 0) {
      result.removed.push(`version downgraded: ${v1} → ${v2}`);
    }

    // 变更消息
    if (ver2.message && ver2.message !== ver1.message) {
      result.added.push(`changelog: ${ver2.message}`);
    }

    return result;
  }

  private loadState(): void {
    try {
      const path_ = path.join(this.skillsDir, 'registry.json');
      if (fs.existsSync(path_)) {
        const raw = JSON.parse(fs.readFileSync(path_, 'utf-8'));
        this.skills = new Map(Object.entries(raw.skills || {}));
        if (raw.versions) {
          for (const [id, vers] of Object.entries(raw.versions)) {
            this.versions.set(id, vers as SkillVersion[]);
          }
        }
        if (raw.qualityLog) {
          for (const [id, log] of Object.entries(raw.qualityLog)) {
            this.qualityLog.set(id, log as { success: boolean; duration: number }[]);
          }
        }
      }
    } catch { this.log.warn('技能注册表加载失败'); }
  }

  private persistState(): void {
    try {
      const data = JSON.stringify({
        skills: Object.fromEntries(this.skills),
        versions: Object.fromEntries(this.versions),
        qualityLog: Object.fromEntries(this.qualityLog),
      });
      const tmp = path.join(this.skillsDir, `registry.${process.pid}.tmp`);
      fs.writeFileSync(tmp, data, 'utf-8');
      fs.renameSync(tmp, path.join(this.skillsDir, 'registry.json'));
    } catch { this.log.warn('技能注册表持久化失败'); }
  }
}
