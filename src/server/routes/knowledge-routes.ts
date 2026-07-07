import type express from 'express';
import { errMsg, type ServerContext } from '../services/app-context.js';

export function registerKnowledgeRoutes(app: express.Application, ctx: ServerContext): void {
  const { knowledgeGraph } = ctx;

// GET /api/knowledge/stats - 获取知识图谱统计
app.get('/api/knowledge/stats', (_req: express.Request, res: express.Response) => {
  try {
    const stats = knowledgeGraph.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/knowledge/query - 查询知识图谱
app.get('/api/knowledge/query', (req: express.Request, res: express.Response) => {
  try {
    const keyword = req.query.q as string;
    if (!keyword) return res.status(400).json({ error: '请提供查询关键词(q参数)' });
    const result = knowledgeGraph.query(keyword);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// POST /api/knowledge/extract - 从文本提取知识
app.post('/api/knowledge/extract', (req: express.Request, res: express.Response) => {
  try {
    const { text, source } = req.body;
    if (!text) return res.status(400).json({ error: '请提供文本内容' });
    const result = knowledgeGraph.extractAndAddKnowledge(text, source || 'user_input');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});

// GET /api/knowledge/entity/:name - 查找实体
app.get('/api/knowledge/entity/:name', (req: express.Request, res: express.Response) => {
  try {
    const entity = knowledgeGraph.findEntityByName(req.params.name);
    if (!entity) return res.status(404).json({ error: '实体不存在' });
    const relations = knowledgeGraph.getEntityRelations(entity.id);
    res.json({ entity, relations });
  } catch (error) {
    res.status(500).json({ error: errMsg(error) });
  }
});
}
