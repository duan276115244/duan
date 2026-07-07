import type express from 'express';
import { ConfigManager } from '../../config.js';
import { UnifiedConfigManager, type UnifiedProfile } from '../../core/unified-config.js';
import OpenAI from 'openai';

export function registerConfigRoutes(app: express.Application): void {
  const configManager = new ConfigManager();
  const unified = UnifiedConfigManager.getInstance();

  // ============================================================
  // 新版 RESTful API — /api/config/*
  // 三端统一配置源，支持实时同步
  // ============================================================

  /** GET /api/config/unified - 获取完整 v2.0 配置（脱敏，apiKey 显示为 ****）
   *  注意：不使用 /api/config 路径，避免与 system-routes.ts 的扁平格式 GET /api/config 冲突 */
  app.get('/api/config/unified', (_req, res) => {
    try {
      const config = unified.getMaskedConfig();
      res.json({
        success: true,
        data: config,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: '获取配置失败: ' + (error as Error).message });
    }
  });

  /** PUT /api/config - 全量更新配置 */
  app.put('/api/config', (req, res) => {
    try {
      const partial = req.body;
      if (!partial || typeof partial !== 'object') {
        return res.status(400).json({ success: false, message: '请求体必须是配置对象' });
      }
      unified.updateConfig(partial);
      // 返回脱敏配置
      res.json({
        success: true,
        message: '配置已更新',
        data: unified.getMaskedConfig(),
      });
    } catch (error) {
      res.status(500).json({ success: false, message: '更新配置失败: ' + (error as Error).message });
    }
  });

  /** POST /api/config/profile - 新增/更新单个配置 */
  app.post('/api/config/profile', (req, res) => {
    try {
      const { profileId, provider, apiKey, model, baseUrl, label } = req.body;

      if (!provider || !apiKey || !model) {
        return res.status(400).json({ success: false, message: '缺少必要字段: provider, apiKey, model' });
      }

      const id = profileId || `profile-${provider}-${Date.now()}`;
      const profile: UnifiedProfile = {
        provider,
        apiKey,
        model,
        baseUrl: baseUrl || '',
        label: label || provider,
      };

      unified.upsertProfile(id, profile);
      res.json({
        success: true,
        message: '配置已保存',
        profileId: id,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: '保存配置失败: ' + (error as Error).message });
    }
  });

  /** DELETE /api/config/profile/:id - 删除指定配置 */
  app.delete('/api/config/profile/:id', (req, res) => {
    try {
      const { id } = req.params;
      const removed = unified.removeProfile(id);
      if (!removed) {
        return res.status(404).json({ success: false, message: `配置 ${id} 不存在` });
      }
      res.json({ success: true, message: '配置已删除' });
    } catch (error) {
      res.status(500).json({ success: false, message: '删除配置失败: ' + (error as Error).message });
    }
  });

  /** GET /api/config/status - 获取同步状态 */
  app.get('/api/config/status', (_req, res) => {
    try {
      const status = unified.getSyncStatus();
      res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: '获取状态失败: ' + (error as Error).message });
    }
  });

  /** PUT /api/config/preferences - 更新偏好设置 */
  app.put('/api/config/preferences', (req, res) => {
    try {
      const prefs = req.body;
      if (!prefs || typeof prefs !== 'object') {
        return res.status(400).json({ success: false, message: '请求体必须是偏好对象' });
      }
      const updated = unified.updatePreferences(prefs);
      res.json({ success: true, message: '偏好已更新', data: updated });
    } catch (error) {
      res.status(500).json({ success: false, message: '更新偏好失败: ' + (error as Error).message });
    }
  });

  /** PUT /api/config/active/:id - 设置激活的配置 */
  app.put('/api/config/active/:id', (req, res) => {
    try {
      const { id } = req.params;
      const ok = unified.setActiveProfile(id);
      if (!ok) {
        return res.status(404).json({ success: false, message: `配置 ${id} 不存在` });
      }
      res.json({ success: true, message: '已设为激活配置' });
    } catch (error) {
      res.status(500).json({ success: false, message: '设置失败: ' + (error as Error).message });
    }
  });

  // ============================================================
  // 旧版兼容 API — /api/duan/config/*（保持向后兼容）
  // ============================================================

  app.get('/api/duan/config', (_req, res) => {
    const config = configManager.getConfig();
    res.json({
      profiles: config.profiles,
      defaultProfileId: config.defaultProfileId,
      mobileChannels: config.mobileChannels || [],
      workspace: config.workspace,
    });
  });

  app.post('/api/duan/config/profiles', (req, res) => {
    try {
      const { id, provider, label, apiKey, model, baseURL, isDefault } = req.body;

      if (!provider || !apiKey || !model) {
        return res.status(400).json({ success: false, message: '缺少必要字段' });
      }

      const profile = {
        id: id || `${provider}:${Date.now()}`,
        provider,
        label: label || provider,
        apiKey,
        model,
        baseURL: baseURL || '',
      };

      configManager.addProfile(profile);

      if (isDefault) {
        configManager.setDefaultProfile(profile.id);
      }

      res.json({ success: true, message: '添加成功', profile });
    } catch (error) {
      res.status(500).json({ success: false, message: '添加失败: ' + (error as Error).message });
    }
  });

  app.delete('/api/duan/config/profiles/:id', (req, res) => {
    try {
      const { id } = req.params;
      configManager.removeProfile(id);
      res.json({ success: true, message: '删除成功' });
    } catch (error) {
      res.status(500).json({ success: false, message: '删除失败: ' + (error as Error).message });
    }
  });

  app.post('/api/duan/config/default/:id', (req, res) => {
    try {
      const { id } = req.params;
      configManager.setDefaultProfile(id);
      res.json({ success: true, message: '已设为默认' });
    } catch (error) {
      res.status(500).json({ success: false, message: '设置失败: ' + (error as Error).message });
    }
  });

  app.post('/api/duan/config/channels', (req, res) => {
    try {
      const channels: Record<string, string> = {};
      const body = req.body;
      if (body && typeof body === 'object') {
        for (const [, config] of Object.entries(body)) {
          const cfg = config as Record<string, string>;
          if (cfg && typeof cfg === 'object') {
            for (const [k, v] of Object.entries(cfg)) {
              channels[k] = v;
            }
          }
        }
      }
      configManager.setMobileChannels(channels);
      res.json({ success: true, message: '通道配置已保存' });
    } catch (error) {
      res.status(500).json({ success: false, message: '保存失败: ' + (error as Error).message });
    }
  });

  app.post('/api/duan/config/test', (req, res) => {
    void (async () => {
    try {
      const { baseURL, model, apiKey } = req.body;

      if (!baseURL || !model || !apiKey) {
        return res.status(400).json({ success: false, message: '缺少必要字段' });
      }

      const testClient = new OpenAI({
        apiKey,
        baseURL,
        timeout: 10000,
        maxRetries: 0,
      });

      const response = await testClient.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      });

      if (response.choices?.[0]?.message) {
        res.json({ success: true, message: '验证通过' });
      } else {
        res.json({ success: false, message: '验证失败' });
      }
    } catch (error: unknown) {
      const body = req.body || {};
      const url = body.baseURL || '';
      const errInfo = error as { status?: unknown; code?: unknown };
      const status = errInfo.status || errInfo.code || '';
      const msg = ((error instanceof Error ? error.message : String(error)) || '').toLowerCase();

      let message = '验证失败';

      if (msg.includes('401') || msg.includes('authentication') || msg.includes('unauthorized')) {
        message = 'API Key 无效（认证失败）';
      } else if (msg.includes('402') || msg.includes('insufficient') || msg.includes('balance')) {
        if (url.includes('/coding/')) {
          message = 'Coding Plan 模型不可用 - 模型名错误或订阅套餐未包含此模型';
        } else {
          message = '余额不足(402)';
        }
      } else if (msg.includes('403') || status === 403) {
        if (url.includes('/coding/')) {
          message = 'Coding Plan 权限检查失败 - 请确认已开通订阅';
        } else {
          message = '权限不足(403)';
        }
      } else if (msg.includes('404') && url.includes('/coding/')) {
        message = 'Coding Plan 不支持该模型 - 请选择 ark-code-latest、doubao-seed-2.0-code 等';
      } else if (msg.includes('coding plan')) {
        message = 'Coding Plan 模型名错误';
      } else if (msg.includes('econnrefused') || msg.includes('connect')) {
        message = '连接失败（网络问题）';
      } else {
        message = ((error instanceof Error ? error.message : String(error)) || '未知错误').substring(0, 100);
      }

      res.json({ success: false, message });
    }
    })();
  });

  // L6 修复：config reset 端点增加确认字段和本地限制
  app.post('/api/duan/config/reset', (req, res) => {
    try {
      // 安全：要求请求体携带 confirm: true 字段，防止误触发
      const { confirm } = req.body || {};
      if (confirm !== true) {
        res.status(400).json({
          success: false,
          message: '请求数据缺少 confirm: true 字段，重置操作需明确确认',
        });
        return;
      }

      // 安全：仅允许本地访问（防止远程删除配置）
      const clientIp = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const isLocalhost = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(clientIp);
      if (!isLocalhost) {
        res.status(403).json({
          success: false,
          message: '安全限制：重置配置仅允许本地访问',
        });
        return;
      }

      const duanDir = ConfigManager.getDuanDir();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const configPath = require('path').join(duanDir, 'config.json');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs');

      // 安全：删除前先备份（防止误删后无法恢复）
      if (fs.existsSync(configPath)) {
        const backupPath = configPath + '.bak.' + Date.now();
        try {
          fs.copyFileSync(configPath, backupPath);
          console.info(`[Config] 配置已备份到 ${backupPath}`);
        } catch (backupErr) {
          // P1 修复：备份失败时不删除原文件，避免配置永久丢失
          console.error('[Config] 备份失败，拒绝删除原配置:', (backupErr as Error).message);
          return res.status(500).json({ success: false, message: '备份失败，为安全起见未删除原配置: ' + (backupErr as Error).message });
        }
        fs.unlinkSync(configPath);
      }

      res.json({ success: true, message: '已重置配置（原配置已备份）' });
    } catch (error) {
      res.status(500).json({ success: false, message: '重置失败: ' + (error as Error).message });
    }
  });
}
