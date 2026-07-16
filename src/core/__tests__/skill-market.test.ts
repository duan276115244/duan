import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillMarket, getSkillMarket } from '../skill-market.js';
import type { MarketSkill } from '../skill-market.js';

// ============ 测试工具 ============

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-market-test-'));
}

function newMarket(): SkillMarket {
  const dir = path.join(tmpDir, 'skill-market');
  const m = new SkillMarket(dir);
  m.initialize();
  return m;
}

function makeSkill(overrides: Partial<MarketSkill> = {}): MarketSkill {
  return {
    id: 'test-skill',
    name: 'test-skill',
    version: '1.0.0',
    description: '测试技能',
    author: 'tester',
    type: 'slash_command',
    category: 'coding',
    tags: ['test'],
    content: JSON.stringify({ template: 'hello $ARGUMENTS' }),
    rating: 0,
    ratingCount: 0,
    downloads: 0,
    reports: 0,
    hidden: false,
    builtin: false,
    maintenanceStatus: 'active',
    publishedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ============ 测试用例 ============

describe('SkillMarket', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    SkillMarket._resetInstance();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    SkillMarket._resetInstance();
  });

  // ========== 初始化 ==========

  describe('初始化', () => {
    it('应创建数据目录并加载空数据', () => {
      const dir = path.join(tmpDir, 'market');
      const m = new SkillMarket(dir);
      m.initialize();
      expect(fs.existsSync(dir)).toBe(true);
      expect(m.getStats().totalSkills).toBeGreaterThan(0); // 内置技能
    });

    it('应注入 10 个内置技能', () => {
      const m = newMarket();
      const stats = m.getStats();
      expect(stats.totalSkills).toBe(10);
    });

    it('重复初始化不应重复注入内置技能', () => {
      const dir = path.join(tmpDir, 'market');
      const m1 = new SkillMarket(dir);
      m1.initialize();
      const count1 = m1.getStats().totalSkills;
      const m2 = new SkillMarket(dir);
      m2.initialize();
      const count2 = m2.getStats().totalSkills;
      expect(count2).toBe(count1);
    });
  });

  // ========== 发布 ==========

  describe('publish', () => {
    it('应成功发布新技能', () => {
      const m = newMarket();
      const skill = makeSkill({ id: 'publish-1', author: 'user1' });
      const result = m.publish(skill);
      expect(result.success).toBe(true);
      expect(result.skillId).toBe('publish-1');
      expect(m.getInfo('publish-1')).not.toBeNull();
    });

    it('ID 冲突时无 overwrite 应失败', () => {
      const m = newMarket();
      const skill = makeSkill({ id: 'conflict-1', author: 'user1' });
      expect(m.publish(skill).success).toBe(true);
      const result = m.publish(skill);
      expect(result.success).toBe(false);
      expect(result.error).toContain('已存在');
    });

    it('ID 冲突时 overwrite=true 应覆盖', () => {
      const m = newMarket();
      const skill = makeSkill({ id: 'overwrite-1', author: 'user1', description: 'v1' });
      m.publish(skill);
      const updated = makeSkill({ id: 'overwrite-1', author: 'user1', description: 'v2' });
      const result = m.publish(updated, { overwrite: true });
      expect(result.success).toBe(true);
      expect(m.getInfo('overwrite-1')?.description).toBe('v2');
    });

    it('发布时不应覆盖已有 downloads/rating/reports', () => {
      const m = newMarket();
      const skill = makeSkill({ id: 'keep-stats', author: 'user1' });
      m.publish(skill);
      // 模拟下载和评分
      void m.install('keep-stats');
      m.rate('keep-stats', 'u1', 5);
      // 覆盖发布
      const updated = makeSkill({ id: 'keep-stats', author: 'user1', description: 'new' });
      m.publish(updated, { overwrite: true });
      const got = m.getInfo('keep-stats');
      expect(got?.downloads).toBe(1);
      expect(got?.ratingCount).toBe(1);
      expect(got?.rating).toBe(5);
    });

    it('单作者发布达到上限应失败', () => {
      const m = newMarket();
      // 发布 50 个（达到上限）
      for (let i = 0; i < 50; i++) {
        const s = makeSkill({ id: `max-${i}`, author: 'spam-author' });
        const r = m.publish(s);
        expect(r.success).toBe(true);
      }
      // 第 51 个应失败
      const s = makeSkill({ id: 'max-50', author: 'spam-author' });
      const r = m.publish(s);
      expect(r.success).toBe(false);
      expect(r.error).toContain('上限');
    });

    it('不同作者不应相互影响上限', () => {
      const m = newMarket();
      for (let i = 0; i < 50; i++) {
        m.publish(makeSkill({ id: `a1-${i}`, author: 'author1' }));
      }
      // author2 应仍可发布
      const r = m.publish(makeSkill({ id: 'a2-0', author: 'author2' }));
      expect(r.success).toBe(true);
    });
  });

  // ========== 下架 ==========

  describe('unpublish', () => {
    it('作者应能下架自己的技能', () => {
      const m = newMarket();
      m.publish(makeSkill({ id: 'unp-1', author: 'user1' }));
      const r = m.unpublish('unp-1', 'user1');
      expect(r.success).toBe(true);
      expect(m.getInfo('unp-1')).toBeNull();
    });

    it('非作者不能下架', () => {
      const m = newMarket();
      m.publish(makeSkill({ id: 'unp-2', author: 'user1' }));
      const r = m.unpublish('unp-2', 'user2');
      expect(r.success).toBe(false);
      expect(r.error).toContain('只能下架');
    });

    it('内置技能不能下架', () => {
      const m = newMarket();
      const r = m.unpublish('builtin-sc-git-review', '段先生');
      expect(r.success).toBe(false);
      expect(r.error).toContain('内置');
    });

    it('下架不存在的技能应失败', () => {
      const m = newMarket();
      const r = m.unpublish('nonexistent', 'user1');
      expect(r.success).toBe(false);
    });
  });

  // ========== 搜索 ==========

  describe('search', () => {
    it('空查询应返回所有可见技能', () => {
      const m = newMarket();
      const results = m.search('');
      expect(results.length).toBe(10);
    });

    it('名称完全匹配应得最高相关性', () => {
      const m = newMarket();
      const results = m.search('git-review');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].skill.name).toBe('git-review');
      expect(results[0].relevance).toBe(100);
    });

    it('名称包含应得 80 相关性', () => {
      const m = newMarket();
      const results = m.search('test');
      // 应匹配 test-gen / test-engineer-tdd
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].relevance).toBe(80);
    });

    it('描述包含应得 50 相关性', () => {
      const m = newMarket();
      const results = m.search('审查');
      expect(results.length).toBeGreaterThan(0);
      // git-review 描述含"审查"
      expect(results.some(r => r.skill.id === 'builtin-sc-git-review')).toBe(true);
    });

    it('标签过滤应生效', () => {
      const m = newMarket();
      const results = m.search('', { tag: 'security' });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.skill.tags.includes('security'))).toBe(true);
    });

    it('类型过滤应生效', () => {
      const m = newMarket();
      const results = m.search('', { type: 'persona' });
      expect(results.length).toBe(2);
      expect(results.every(r => r.skill.type === 'persona')).toBe(true);
    });

    it('隐藏技能默认不出现', () => {
      const m = newMarket();
      m.hide('builtin-sc-git-review');
      const results = m.search('git-review');
      expect(results.length).toBe(0);
    });

    it('includeHidden=true 应包含隐藏技能', () => {
      const m = newMarket();
      m.hide('builtin-sc-git-review');
      const results = m.search('git-review', { includeHidden: true });
      expect(results.length).toBe(1);
    });

    it('limit 应限制返回数', () => {
      const m = newMarket();
      const results = m.search('', { limit: 3 });
      expect(results.length).toBe(3);
    });

    it('综合评分排序：高评分 + 高下载应在前面', () => {
      const m = newMarket();
      const results = m.search(''); // 空查询中性分
      // security-checklist（rating 4.9, downloads 892）应在前列
      const top5 = results.slice(0, 5).map(r => r.skill.id);
      expect(top5).toContain('builtin-skillpkg-security-checklist');
    });
  });

  // ========== getInfo / listAvailable / listFeatured ==========

  describe('getInfo / listAvailable / listFeatured', () => {
    it('getInfo 不存在的 ID 返回 null', () => {
      const m = newMarket();
      expect(m.getInfo('nonexistent')).toBeNull();
    });

    it('listAvailable 应返回所有可见技能', () => {
      const m = newMarket();
      const list = m.listAvailable();
      expect(list.length).toBe(10);
    });

    it('listAvailable 应过滤隐藏', () => {
      const m = newMarket();
      m.hide('builtin-sc-git-review');
      const list = m.listAvailable();
      expect(list.length).toBe(9);
      expect(list.find(s => s.id === 'builtin-sc-git-review')).toBeUndefined();
    });

    it('listFeatured 应按综合评分排序', () => {
      const m = newMarket();
      const list = m.listFeatured(5);
      expect(list.length).toBe(5);
      // 验证排序：第 1 个的评分 * 下载量 应不低于第 5 个
      const first = list[0];
      const last = list[4];
      expect(first.rating * first.downloads).toBeGreaterThanOrEqual(last.rating * last.downloads);
    });

    it('listFeatured 默认 limit=10', () => {
      const m = newMarket();
      const list = m.listFeatured();
      expect(list.length).toBe(10);
    });
  });

  // ========== 安装 / 卸载 ==========

  describe('install / uninstall', () => {
    it('无 installer 时应成功记录安装', async () => {
      const m = newMarket();
      const r = await m.install('builtin-sc-git-review');
      expect(r.success).toBe(true);
      expect(m.listInstalled().length).toBe(1);
    });

    it('安装后 downloads 应 +1', async () => {
      const m = newMarket();
      const before = m.getInfo('builtin-sc-git-review')!.downloads;
      await m.install('builtin-sc-git-review');
      const after = m.getInfo('builtin-sc-git-review')!.downloads;
      expect(after).toBe(before + 1);
    });

    it('重复安装应失败', async () => {
      const m = newMarket();
      await m.install('builtin-sc-git-review');
      const r = await m.install('builtin-sc-git-review');
      expect(r.success).toBe(false);
      expect(r.message).toContain('已安装');
    });

    it('安装不存在的技能应失败', async () => {
      const m = newMarket();
      const r = await m.install('nonexistent');
      expect(r.success).toBe(false);
    });

    it('安装隐藏技能应失败', async () => {
      const m = newMarket();
      m.hide('builtin-sc-git-review');
      const r = await m.install('builtin-sc-git-review');
      expect(r.success).toBe(false);
      expect(r.message).toContain('隐藏');
    });

    it('自定义 installer 应被调用', async () => {
      const m = newMarket();
      let called = false;
      const r = await m.install('builtin-sc-git-review', async (skill) => {
        called = true;
        return { success: true, message: `installed ${skill.name}`, installPath: '/tmp/test' };
      });
      expect(called).toBe(true);
      expect(r.success).toBe(true);
      expect(r.installPath).toBe('/tmp/test');
    });

    it('installer 失败时不应记录安装', async () => {
      const m = newMarket();
      const r = await m.install('builtin-sc-git-review', async () => {
        return { success: false, message: 'install failed' };
      });
      expect(r.success).toBe(false);
      expect(m.listInstalled().length).toBe(0);
      // downloads 也不应增加
      expect(m.getInfo('builtin-sc-git-review')!.downloads).toBe(318);
    });

    it('uninstall 应移除安装记录', async () => {
      const m = newMarket();
      await m.install('builtin-sc-git-review');
      const r = m.uninstall('builtin-sc-git-review');
      expect(r.success).toBe(true);
      expect(m.listInstalled().length).toBe(0);
    });

    it('uninstall 未安装的应失败', () => {
      const m = newMarket();
      const r = m.uninstall('builtin-sc-git-review');
      expect(r.success).toBe(false);
    });
  });

  // ========== 评分 ==========

  describe('rate', () => {
    it('应成功评分并更新平均分', () => {
      const m = newMarket();
      const before = m.getInfo('builtin-sc-git-review')!.ratingCount;
      const r = m.rate('builtin-sc-git-review', 'user1', 5);
      expect(r.success).toBe(true);
      const skill = m.getInfo('builtin-sc-git-review')!;
      // 内置预设 ratingCount 是"市场宣传值"，实际评分记录从 0 开始
      // rate 后 ratingCount = 旧预设值 + 1（因 rate 重算为 filtered.length）
      // 但 ratings.json 初始为空，所以 filtered.length = 1，ratingCount 被重置为 1
      expect(skill.ratingCount).toBe(1);
      expect(skill.rating).toBe(5);
      // 旧值应大于 0（内置预设）
      expect(before).toBeGreaterThan(0);
    });

    it('评分必须 1-5', () => {
      const m = newMarket();
      expect(m.rate('builtin-sc-git-review', 'user1', 0).success).toBe(false);
      expect(m.rate('builtin-sc-git-review', 'user1', 6).success).toBe(false);
    });

    it('评分必须为整数', () => {
      const m = newMarket();
      expect(m.rate('builtin-sc-git-review', 'user1', 3.5).success).toBe(false);
    });

    it('同一用户重复评分应覆盖', () => {
      const m = newMarket();
      m.rate('builtin-sc-git-review', 'user1', 3);
      const before = m.getInfo('builtin-sc-git-review')!.ratingCount;
      m.rate('builtin-sc-git-review', 'user1', 5);
      const after = m.getInfo('builtin-sc-git-review')!.ratingCount;
      expect(after).toBe(before); // 数量不变
    });

    it('评分不存在的技能应失败', () => {
      const m = newMarket();
      const r = m.rate('nonexistent', 'user1', 5);
      expect(r.success).toBe(false);
    });

    it('getRatings 应返回所有评分', () => {
      const m = newMarket();
      m.rate('builtin-sc-git-review', 'u1', 5);
      m.rate('builtin-sc-git-review', 'u2', 4);
      const list = m.getRatings('builtin-sc-git-review');
      expect(list.length).toBe(2);
    });

    it('评分带评论应保存', () => {
      const m = newMarket();
      m.rate('builtin-sc-git-review', 'u1', 5, '非常好用');
      const list = m.getRatings('builtin-sc-git-review');
      expect(list[0].comment).toBe('非常好用');
    });
  });

  // ========== 举报 ==========

  describe('report', () => {
    it('应成功举报', () => {
      const m = newMarket();
      const r = m.report('builtin-sc-git-review', 'user1', '恶意代码');
      expect(r.success).toBe(true);
      expect(m.getReports('builtin-sc-git-review').length).toBe(1);
    });

    it('同一用户重复举报应失败', () => {
      const m = newMarket();
      m.report('builtin-sc-git-review', 'user1', '原因1');
      const r = m.report('builtin-sc-git-review', 'user1', '原因2');
      expect(r.success).toBe(false);
    });

    it('空原因应失败', () => {
      const m = newMarket();
      const r = m.report('builtin-sc-git-review', 'user1', '');
      expect(r.success).toBe(false);
    });

    it('达到阈值 5 次应自动隐藏', () => {
      const m = newMarket();
      for (let i = 1; i <= 5; i++) {
        const r = m.report('builtin-sc-git-review', `user${i}`, '低质量');
        expect(r.success).toBe(true);
      }
      const skill = m.getInfo('builtin-sc-git-review')!;
      expect(skill.hidden).toBe(true);
      expect(skill.reports).toBe(5);
    });

    it('举报不存在的技能应失败', () => {
      const m = newMarket();
      const r = m.report('nonexistent', 'user1', '原因');
      expect(r.success).toBe(false);
    });
  });

  // ========== 隐藏 / 取消隐藏 ==========

  describe('hide / unhide', () => {
    it('hide 应标记隐藏', () => {
      const m = newMarket();
      const r = m.hide('builtin-sc-git-review');
      expect(r.success).toBe(true);
      expect(m.getInfo('builtin-sc-git-review')!.hidden).toBe(true);
    });

    it('重复 hide 应失败', () => {
      const m = newMarket();
      m.hide('builtin-sc-git-review');
      const r = m.hide('builtin-sc-git-review');
      expect(r.success).toBe(false);
    });

    it('unhide 应取消隐藏', () => {
      const m = newMarket();
      m.hide('builtin-sc-git-review');
      const r = m.unhide('builtin-sc-git-review');
      expect(r.success).toBe(true);
      expect(m.getInfo('builtin-sc-git-review')!.hidden).toBe(false);
    });

    it('未隐藏时 unhide 应失败', () => {
      const m = newMarket();
      const r = m.unhide('builtin-sc-git-review');
      expect(r.success).toBe(false);
    });

    it('隐藏不存在的技能应失败', () => {
      const m = newMarket();
      const r = m.hide('nonexistent');
      expect(r.success).toBe(false);
    });
  });

  // ========== 统计 ==========

  describe('getStats', () => {
    it('初始统计应正确', () => {
      const m = newMarket();
      const stats = m.getStats();
      expect(stats.totalSkills).toBe(10);
      expect(stats.installedCount).toBe(0);
      expect(stats.hiddenCount).toBe(0);
      expect(stats.totalDownloads).toBeGreaterThan(0);
    });

    it('byType 应正确分类', () => {
      const m = newMarket();
      const stats = m.getStats();
      expect(stats.byType.slash_command).toBe(2);
      expect(stats.byType.subagent_preset).toBe(2);
      expect(stats.byType.persona).toBe(2);
      expect(stats.byType.skill_package).toBe(2);
      expect(stats.byType.generated_skill).toBe(2);
    });

    it('byCategory 应正确分类', () => {
      const m = newMarket();
      const stats = m.getStats();
      expect(stats.byCategory.coding).toBeGreaterThan(0);
      expect(stats.byCategory.security).toBe(1);
      expect(stats.byCategory.data).toBe(1);
    });

    it('安装后 installedCount 应 +1', async () => {
      const m = newMarket();
      await m.install('builtin-sc-git-review');
      expect(m.getStats().installedCount).toBe(1);
    });

    it('隐藏后 hiddenCount 应 +1', () => {
      const m = newMarket();
      m.hide('builtin-sc-git-review');
      expect(m.getStats().hiddenCount).toBe(1);
    });
  });

  // ========== 持久化 ==========

  describe('持久化', () => {
    it('发布的技能应持久化到 registry.json', () => {
      const dir = path.join(tmpDir, 'market');
      const m1 = new SkillMarket(dir);
      m1.initialize();
      m1.publish(makeSkill({ id: 'persist-1', author: 'user1' }));

      // 新实例加载同一目录
      const m2 = new SkillMarket(dir);
      m2.initialize();
      expect(m2.getInfo('persist-1')).not.toBeNull();
    });

    it('评分应持久化到 ratings.json', () => {
      const dir = path.join(tmpDir, 'market');
      const m1 = new SkillMarket(dir);
      m1.initialize();
      m1.rate('builtin-sc-git-review', 'user1', 5);

      const m2 = new SkillMarket(dir);
      m2.initialize();
      const ratings = m2.getRatings('builtin-sc-git-review');
      expect(ratings.length).toBe(1);
      expect(ratings[0].rating).toBe(5);
    });

    it('安装记录应持久化到 installed.json', async () => {
      const dir = path.join(tmpDir, 'market');
      const m1 = new SkillMarket(dir);
      m1.initialize();
      await m1.install('builtin-sc-git-review');

      const m2 = new SkillMarket(dir);
      m2.initialize();
      expect(m2.listInstalled().length).toBe(1);
    });

    it('举报记录应持久化到 reports.json', () => {
      const dir = path.join(tmpDir, 'market');
      const m1 = new SkillMarket(dir);
      m1.initialize();
      m1.report('builtin-sc-git-review', 'user1', '测试');

      const m2 = new SkillMarket(dir);
      m2.initialize();
      expect(m2.getReports('builtin-sc-git-review').length).toBe(1);
    });
  });

  // ========== LLM 工具 ==========

  describe('getToolDefinitions', () => {
    it('应返回 8 个工具定义', () => {
      const m = newMarket();
      const tools = m.getToolDefinitions();
      expect(tools.length).toBe(8);
      expect(tools.every(t => typeof t.execute === 'function')).toBe(true);
    });

    it('skill_market_search 工具应返回搜索结果', async () => {
      const m = newMarket();
      const tools = m.getToolDefinitions();
      const searchTool = tools.find(t => t.name === 'skill_market_search')!;
      const result = JSON.parse(await searchTool.execute({ query: 'git' }));
      expect(result.count).toBeGreaterThan(0);
      expect(result.results[0]).toHaveProperty('compositeScore');
    });

    it('skill_market_list featured 模式应返回推荐', async () => {
      const m = newMarket();
      const tools = m.getToolDefinitions();
      const listTool = tools.find(t => t.name === 'skill_market_list')!;
      const result = JSON.parse(await listTool.execute({ mode: 'featured', limit: 3 }));
      expect(result.mode).toBe('featured');
      expect(result.count).toBe(3);
    });

    it('skill_market_info 工具应返回详情', async () => {
      const m = newMarket();
      const tools = m.getToolDefinitions();
      const infoTool = tools.find(t => t.name === 'skill_market_info')!;
      const result = JSON.parse(await infoTool.execute({ id: 'builtin-sc-git-review' }));
      expect(result.id).toBe('builtin-sc-git-review');
      expect(result).toHaveProperty('content');
    });

    it('skill_market_publish 工具应发布技能', async () => {
      const m = newMarket();
      const tools = m.getToolDefinitions();
      const pubTool = tools.find(t => t.name === 'skill_market_publish')!;
      const skillJson = JSON.stringify(makeSkill({ id: 'tool-pub-1', author: 'user1' }));
      const result = JSON.parse(await pubTool.execute({ skill_json: skillJson }));
      expect(result.success).toBe(true);
      expect(m.getInfo('tool-pub-1')).not.toBeNull();
    });

    it('skill_market_publish 无效 JSON 应失败', async () => {
      const m = newMarket();
      const tools = m.getToolDefinitions();
      const pubTool = tools.find(t => t.name === 'skill_market_publish')!;
      const result = JSON.parse(await pubTool.execute({ skill_json: 'not json' }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('解析失败');
    });

    it('skill_market_install 工具应安装技能', async () => {
      const m = newMarket();
      const tools = m.getToolDefinitions();
      const instTool = tools.find(t => t.name === 'skill_market_install')!;
      const result = JSON.parse(await instTool.execute({ id: 'builtin-sc-git-review' }));
      expect(result.success).toBe(true);
    });

    it('skill_market_rate 工具应评分', async () => {
      const m = newMarket();
      const tools = m.getToolDefinitions();
      const rateTool = tools.find(t => t.name === 'skill_market_rate')!;
      const result = JSON.parse(await rateTool.execute({ id: 'builtin-sc-git-review', user_id: 'u1', rating: 5 }));
      expect(result.success).toBe(true);
    });

    it('skill_market_report 工具应举报', async () => {
      const m = newMarket();
      const tools = m.getToolDefinitions();
      const repTool = tools.find(t => t.name === 'skill_market_report')!;
      const result = JSON.parse(await repTool.execute({ id: 'builtin-sc-git-review', reporter_id: 'u1', reason: '测试举报' }));
      expect(result.success).toBe(true);
    });

    it('skill_market_stats 工具应返回统计', async () => {
      const m = newMarket();
      const tools = m.getToolDefinitions();
      const statsTool = tools.find(t => t.name === 'skill_market_stats')!;
      const result = JSON.parse(await statsTool.execute({}));
      expect(result.totalSkills).toBe(10);
    });
  });

  // ========== 单例 ==========

  describe('单例', () => {
    it('getInstance 应返回同一实例', () => {
      SkillMarket._resetInstance();
      const a = SkillMarket.getInstance();
      const b = SkillMarket.getInstance();
      expect(a).toBe(b);
    });

    it('getSkillMarket 应返回单例', () => {
      const a = getSkillMarket();
      const b = getSkillMarket();
      expect(a).toBe(b);
    });
  });

  // ========== 边缘情况 ==========

  describe('边缘情况', () => {
    it('损坏的 registry.json 应降级为空', () => {
      const dir = path.join(tmpDir, 'market');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'registry.json'), 'not json{', 'utf-8');
      const m = new SkillMarket(dir);
      // 不应抛出
      m.initialize();
      // 内置技能仍应注入
      expect(m.getStats().totalSkills).toBe(10);
    });

    it('损坏的 ratings.json 应降级为空', () => {
      const dir = path.join(tmpDir, 'market');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ratings.json'), 'not json{', 'utf-8');
      const m = new SkillMarket(dir);
      m.initialize();
      expect(m.getRatings('builtin-sc-git-review').length).toBe(0);
    });

    it('空的 registry.json 应正常处理', () => {
      const dir = path.join(tmpDir, 'market');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ skills: [] }), 'utf-8');
      const m = new SkillMarket(dir);
      m.initialize();
      expect(m.getStats().totalSkills).toBe(10); // 内置仍注入
    });

    it('registry.json 中无效条目应被跳过', () => {
      const dir = path.join(tmpDir, 'market');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({
        skills: [
          { id: 'valid-1', name: 'valid', type: 'slash_command', category: 'coding', tags: [], content: '{}', version: '1', description: 'd', author: 'a' },
          { id: '', name: 'invalid-no-id' }, // 无效
          { id: 'invalid-no-name', name: '' }, // 无效
        ],
      }), 'utf-8');
      const m = new SkillMarket(dir);
      m.initialize();
      expect(m.getInfo('valid-1')).not.toBeNull();
      expect(m.getStats().totalSkills).toBe(11); // 1 有效 + 10 内置
    });
  });
});
