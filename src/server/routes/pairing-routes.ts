// ============================================================
// Pairing Routes — 配对码管理 REST API
//
// 参考 OpenClaw 的配对码授权机制：
//   POST   /api/pairing/generate       生成配对码
//   GET    /api/pairing/codes          列出待使用配对码
//   GET    /api/pairing/users          列出已配对用户
//   GET    /api/pairing/users/:channel 按通道列出已配对用户
//   DELETE /api/pairing/users/:channel/:userId  解除配对
//   POST   /api/pairing/whitelist      手动添加白名单
//   DELETE /api/pairing/channel/:channel  清除某通道所有配对
//   GET    /api/pairing/status         配对系统状态概览
// ============================================================

import express from 'express';
import { PairingManager } from '../../core/pairing-manager.js';

export function registerPairingRoutes(app: express.Application): void {
  const router = express.Router();

  // 生成配对码
  router.post('/generate', (req, res) => {
    try {
      const { note } = req.body || {};
      const code = PairingManager.getInstance().generateCode(note);
      res.json({
        success: true,
        code,
        expiresIn: '5m',
        message: '配对码已生成，5分钟内有效。用户在聊天中输入此码即可完成配对',
      });
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  });

  // 列出待使用配对码
  router.get('/codes', (_req, res) => {
    try {
      const codes = PairingManager.getInstance().listPendingCodes();
      res.json({ success: true, codes });
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  });

  // 列出所有已配对用户（可按通道过滤）
  router.get('/users/:channel?', (req, res) => {
    try {
      const { channel } = req.params;
      const users = PairingManager.getInstance().listPairedUsers(channel);
      res.json({ success: true, count: users.length, users });
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  });

  // 解除用户配对
  router.delete('/users/:channel/:userId', (req, res) => {
    try {
      const { channel, userId } = req.params;
      const removed = PairingManager.getInstance().unpair(channel, userId);
      res.json({ success: removed, message: removed ? '已解除配对' : '用户未配对' });
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  });

  // 手动添加白名单（无需配对码）
  router.post('/whitelist', (req, res) => {
    try {
      const { channelType, userId, displayName } = req.body || {};
      if (!channelType || !userId) {
        return res.status(400).json({ success: false, error: 'channelType 和 userId 为必填' });
      }
      PairingManager.getInstance().addWhitelist(channelType, userId, displayName);
      res.json({ success: true, message: '已添加到白名单' });
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  });

  // 清除某通道的所有配对用户
  router.delete('/channel/:channel', (req, res) => {
    try {
      const { channel } = req.params;
      const removed = PairingManager.getInstance().clearChannel(channel);
      res.json({ success: true, removed, message: `已清除通道 ${channel} 的 ${removed} 个配对用户` });
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  });

  // 配对系统状态概览
  router.get('/status', (_req, res) => {
    try {
      const pm = PairingManager.getInstance();
      const users = pm.listPairedUsers();
      const codes = pm.listPendingCodes();
      // 按通道统计
      const byChannel: Record<string, number> = {};
      for (const u of users) {
        byChannel[u.channelType] = (byChannel[u.channelType] || 0) + 1;
      }
      res.json({
        success: true,
        totalPairedUsers: users.length,
        pendingCodes: codes.length,
        byChannel,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  });

  app.use('/api/pairing', router);
}
