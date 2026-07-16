/**
 * WorkflowBuilderPage — 工作流构建器
 *
 * v1: YAML 编辑器 + 只读 SVG DAG 预览 + 执行监控
 *
 * 布局：
 *   左侧：工作流列表 + 新建/删除
 *   中间上：YAML 编辑器 + 实时校验（debounce 500ms）
 *   中间下：SVG DAG 预览（按 depends_on 拓扑分层）
 *   右侧：执行面板（inputs + 执行按钮 + SSE 实时进度）
 *   底部：执行历史列表
 *
 * 双模式：Electron IPC (window.electronAPI.workflow.*) + Web fetch 回退
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft, Workflow as WorkflowIcon, Plus, Trash2, Save, Play, Loader2,
  CheckCircle2, AlertCircle, Clock, RefreshCw, Zap, FileCode,
} from 'lucide-react';

// ============ 类型 ============
interface WorkflowStep {
  id: string;
  tool: string;
  args?: Record<string, unknown>;
  depends_on?: string[];
  on_failure?: string;
}

interface WorkflowListItem {
  id: string;
  name: string;
  description?: string;
  trigger?: string;
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
}

interface ExecutionHistoryItem {
  executionId: string;
  workflowName: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  summary?: string;
  stepCount: number;
  successCount: number;
  failedCount: number;
}

interface DAGNode {
  id: string;
  x: number;
  y: number;
  tool: string;
}

interface DAGEdge {
  from: string;
  to: string;
}

interface ValidateResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============ 示例 YAML ============
const EXAMPLE_YAML = `workflow:
  name: code-review-pipeline
  description: 代码审查流水线
  trigger: pull_request
  steps:
    - id: lint
      tool: shell_execute
      args: { command: "npm run lint" }
      on_failure: abort
    - id: test
      tool: shell_execute
      args: { command: "npm test" }
      depends_on: [lint]
      on_failure: notify
    - id: review
      tool: code_review
      args: { files: "{{ steps.lint.output.changed_files }}" }
      depends_on: [test]
  outputs:
    status: "{{ steps.review.output.status }}"
`;

// ============ DAG 布局算法 ============
function layoutDAG(steps: WorkflowStep[]): { nodes: DAGNode[]; edges: DAGEdge[] } {
  if (!steps || steps.length === 0) return { nodes: [], edges: [] };

  const stepMap = new Map(steps.map(s => [s.id, s]));
  const layerMap: Record<string, number> = {};

  function getLayer(id: string, visited: Set<string>): number {
    if (id in layerMap) return layerMap[id];
    if (visited.has(id)) return 0; // 循环依赖防护
    visited.add(id);
    const step = stepMap.get(id);
    if (!step || !step.depends_on || step.depends_on.length === 0) {
      layerMap[id] = 0;
      return 0;
    }
    const maxDepLayer = Math.max(...step.depends_on.map(d => getLayer(d, new Set(visited))));
    layerMap[id] = maxDepLayer + 1;
    return layerMap[id];
  }

  for (const step of steps) getLayer(step.id, new Set());

  // 按层分组
  const layers: Record<number, string[]> = {};
  for (const [id, layer] of Object.entries(layerMap)) {
    if (!layers[layer]) layers[layer] = [];
    layers[layer].push(id);
  }

  // 生成节点坐标
  const nodes: DAGNode[] = [];
  for (const [layerStr, ids] of Object.entries(layers)) {
    const layer = Number(layerStr);
    const x = 90 + layer * 170;
    ids.forEach((id, i) => {
      const step = stepMap.get(id);
      nodes.push({ id, x, y: 40 + i * 70, tool: step?.tool || '' });
    });
  }

  // 生成边
  const edges: DAGEdge[] = [];
  for (const step of steps) {
    if (step.depends_on) {
      for (const dep of step.depends_on) {
        if (stepMap.has(dep)) edges.push({ from: dep, to: step.id });
      }
    }
  }

  return { nodes, edges };
}

// 从 YAML 文本提取 steps（轻量正则，不依赖完整 YAML 解析）
function extractStepsFromYaml(yaml: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  const lines = yaml.split('\n');
  let currentStep: Partial<WorkflowStep> | null = null;
  let inSteps = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // 检测进入 steps 区域
    if (/^steps\s*:/.test(trimmed)) {
      inSteps = true;
      continue;
    }
    // 检测离开 steps 区域（新的顶层键）
    if (inSteps && /^[a-zA-Z_]\w*\s*:/.test(trimmed) && !line.startsWith(' ') && !line.startsWith('-')) {
      inSteps = false;
    }
    if (!inSteps) continue;

    // 新步骤（- id: xxx）
    const stepMatch = trimmed.match(/^-\s*id\s*:\s*(.+)/);
    if (stepMatch) {
      if (currentStep?.id) steps.push(currentStep as WorkflowStep);
      currentStep = { id: stepMatch[1].trim() };
      continue;
    }

    if (currentStep) {
      const toolMatch = trimmed.match(/^tool\s*:\s*(.+)/);
      if (toolMatch) { currentStep.tool = toolMatch[1].trim(); continue; }

      const depMatch = trimmed.match(/^depends_on\s*:\s*\[([^\]]*)\]/);
      if (depMatch) {
        currentStep.depends_on = depMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
        continue;
      }
    }
  }
  if (currentStep?.id && currentStep.tool) steps.push(currentStep as WorkflowStep);
  return steps;
}

// ============ 主组件 ============
export function WorkflowBuilderPage({ onBack }: { onBack?: () => void }) {
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

  // 状态
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [yaml, setYaml] = useState<string>(EXAMPLE_YAML);
  const [wfName, setWfName] = useState<string>('code-review-pipeline');
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [inputsText, setInputsText] = useState<string>('{}');
  const [history, setHistory] = useState<ExecutionHistoryItem[]>([]);
  const [streamEvent, setStreamEvent] = useState<{ type: string; data: Record<string, unknown> } | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  // debounce 校验定时器
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ============ API 封装（双模式）============
  const apiList = useCallback(async (): Promise<WorkflowListItem[]> => {
    if (isElectron) {
      const r = await window.electronAPI?.workflow?.list();
      return r?.workflows || [];
    }
    try {
      const res = await fetch('/api/workflow/list');
      if (!res.ok) return [];
      const data = await res.json();
      return data?.workflows || [];
    } catch { return []; }
  }, [isElectron]);

  const apiSave = useCallback(async (definition: unknown): Promise<{ success: boolean; id?: string; error?: string; errors?: string[]; warnings?: string[] }> => {
    if (isElectron) {
      return await window.electronAPI?.workflow?.save(definition) ?? { success: false, error: 'IPC 不可用' };
    }
    try {
      const res = await fetch('/api/workflow/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(definition) });
      return await res.json();
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [isElectron]);

  const apiDelete = useCallback(async (id: string): Promise<{ success: boolean; error?: string }> => {
    if (isElectron) {
      return await window.electronAPI?.workflow?.delete(id) ?? { success: false, error: 'IPC 不可用' };
    }
    try {
      const res = await fetch(`/api/workflow/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return await res.json();
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [isElectron]);

  const apiValidate = useCallback(async (yamlStr: string): Promise<ValidateResult | null> => {
    if (isElectron) {
      const r = await window.electronAPI?.workflow?.validate({ yaml: yamlStr });
      if (r?.success) return { valid: r.valid ?? false, errors: r.errors || [], warnings: r.warnings || [] };
      return null;
    }
    try {
      const res = await fetch('/api/workflow/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml: yamlStr }) });
      const data = await res.json();
      if (data?.success) return { valid: data.valid, errors: data.errors || [], warnings: data.warnings || [] };
      return null;
    } catch { return null; }
  }, [isElectron]);

  const apiExecute = useCallback(async (payload: { yaml?: string; id?: string; inputs?: Record<string, unknown> }): Promise<{ success: boolean; executionId?: string; error?: string; message?: string }> => {
    if (isElectron) {
      return await window.electronAPI?.workflow?.execute(payload) ?? { success: false, error: 'IPC 不可用' };
    }
    try {
      const res = await fetch('/api/workflow/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return await res.json();
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [isElectron]);

  const apiHistory = useCallback(async (): Promise<ExecutionHistoryItem[]> => {
    if (isElectron) {
      const r = await window.electronAPI?.workflow?.history();
      return r?.history || [];
    }
    try {
      const res = await fetch('/api/workflow/history');
      if (!res.ok) return [];
      const data = await res.json();
      return data?.history || [];
    } catch { return []; }
  }, [isElectron]);

  // ============ 加载工作流列表 ============
  const refreshList = useCallback(async () => {
    setLoadingList(true);
    const list = await apiList();
    setWorkflows(list);
    setLoadingList(false);
  }, [apiList]);

  useEffect(() => {
    refreshList();
    apiHistory().then(setHistory);
  }, [refreshList, apiHistory]);

  // ============ SSE 流订阅 ============
  useEffect(() => {
    if (!isElectron) return;
    const api = window.electronAPI;
    let unsub: (() => void) | undefined;
    if (api?.workflow?.onStream) {
      unsub = api.workflow.onStream((event: { type: string; data?: unknown }) => {
        setStreamEvent({ type: event.type, data: event as Record<string, unknown> });
        // 收到 completed/failed 时刷新历史
        if (event.type === 'workflow.completed' || event.type === 'workflow.failed') {
          apiHistory().then(setHistory);
        }
      });
    }
    if (api?.workflow?.connectStream) {
      api.workflow.connectStream().catch(() => {});
    }
    return () => {
      unsub?.();
      if (api?.workflow?.disconnectStream) {
        api.workflow.disconnectStream().catch(() => {});
      }
    };
  }, [isElectron, apiHistory]);

  // ============ 实时校验（debounce 500ms）============
  useEffect(() => {
    if (validateTimer.current) clearTimeout(validateTimer.current);
    if (!yaml.trim()) { setValidation(null); return; }
    setValidating(true);
    validateTimer.current = setTimeout(async () => {
      const result = await apiValidate(yaml);
      setValidation(result);
      setValidating(false);
    }, 500);
    return () => { if (validateTimer.current) clearTimeout(validateTimer.current); };
  }, [yaml, apiValidate]);

  // ============ DAG 预览 ============
  const dagSteps = extractStepsFromYaml(yaml);
  const { nodes: dagNodes, edges: dagEdges } = layoutDAG(dagSteps);
  const dagWidth = Math.max(400, (Math.max(...dagNodes.map(n => n.x), 0) + 160));
  const dagHeight = Math.max(120, (Math.max(...dagNodes.map(n => n.y), 0) + 60));

  // ============ 操作处理 ============
  const handleSelectWorkflow = (wf: WorkflowListItem) => {
    setSelectedId(wf.id);
    setWfName(wf.name);
    // 将已保存的工作流转为 YAML 文本
    const stepsYaml = (wf.steps || []).map((s: WorkflowStep) => {
      let line = `    - id: ${s.id}\n      tool: ${s.tool}`;
      if (s.args) line += `\n      args: ${JSON.stringify(s.args)}`;
      if (s.depends_on && s.depends_on.length) line += `\n      depends_on: [${s.depends_on.join(', ')}]`;
      if (s.on_failure) line += `\n      on_failure: ${s.on_failure}`;
      return line;
    }).join('\n');
    const yamlText = `workflow:\n  name: ${wf.name}\n${wf.description ? `  description: ${wf.description}\n` : ''}${wf.trigger ? `  trigger: ${wf.trigger}\n` : ''}  steps:\n${stepsYaml}\n`;
    setYaml(yamlText);
  };

  const handleNew = () => {
    setSelectedId(null);
    setYaml(EXAMPLE_YAML);
    setWfName('code-review-pipeline');
    setExecutionResult(null);
  };

  const handleSave = async () => {
    setSaving(true);
    // 从 YAML 提取 steps 构造 definition
    const steps = extractStepsFromYaml(yaml);
    const definition = {
      id: selectedId || undefined,
      name: wfName.trim() || 'unnamed',
      steps,
    };
    const result = await apiSave(definition);
    if (result.success) {
      setExecutionResult({ type: 'success', text: `工作流已保存（ID: ${result.id}）` });
      await refreshList();
      if (result.id) setSelectedId(result.id);
    } else {
      setExecutionResult({ type: 'error', text: result.error || (result.errors || []).join('; ') || '保存失败' });
    }
    setSaving(false);
    setTimeout(() => setExecutionResult(null), 5000);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此工作流？')) return;
    const result = await apiDelete(id);
    if (result.success) {
      if (selectedId === id) handleNew();
      await refreshList();
    }
  };

  const handleExecute = async () => {
    setExecuting(true);
    setExecutionResult(null);
    let inputs: Record<string, unknown> = {};
    try {
      inputs = JSON.parse(inputsText);
    } catch {
      setExecutionResult({ type: 'error', text: 'inputs JSON 格式错误' });
      setExecuting(false);
      return;
    }

    const payload: { yaml?: string; id?: string; inputs?: Record<string, unknown> } = { yaml, inputs };
    if (selectedId) { payload.id = selectedId; delete payload.yaml; }

    const result = await apiExecute(payload);
    if (result.success) {
      setExecutionResult({ type: 'info', text: `工作流已启动（executionId: ${result.executionId}），进度通过 SSE 推送` });
    } else {
      setExecutionResult({ type: 'error', text: result.error || '执行失败' });
    }
    setExecuting(false);
    setTimeout(() => setExecutionResult(null), 8000);
  };

  const handleRefreshHistory = async () => {
    const h = await apiHistory();
    setHistory(h);
  };

  // ============ 渲染 ============
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#0a0e1a', color: '#e2e8f0' }}>
      {/* 顶部栏 */}
      <header style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,.06)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, background: 'rgba(6,9,18,.6)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
        {onBack && (
          <button onClick={onBack} title="返回" style={{ padding: 6, borderRadius: 8, background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center', transition: 'all .15s' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#e2e8f0'; e.currentTarget.style.background = 'rgba(255,255,255,.04)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.background = 'transparent'; }}>
            <ArrowLeft style={{ width: 18, height: 18 }} />
          </button>
        )}
        <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg, #06b6d4, #8b5cf6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 12px rgba(6,182,212,.25)' }}>
          <WorkflowIcon style={{ width: 16, height: 16 }} />
        </div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>工作流构建器</h1>
          <p style={{ fontSize: 11, color: '#64748b', margin: '2px 0 0' }}>YAML 编排 · DAG 预览 · 实时执行监控</p>
        </div>
      </header>

      {/* 主体：三栏布局 */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* 左侧：工作流列表 */}
        <aside style={{ width: 240, flexShrink: 0, borderRight: '1px solid rgba(255,255,255,.06)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: '#94a3b8' }}>工作流列表</span>
            <button onClick={handleNew} title="新建工作流" style={{ padding: '4px 8px', borderRadius: 6, background: 'rgba(6,182,212,.1)', border: '1px solid rgba(6,182,212,.2)', color: '#06b6d4', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}>
              <Plus style={{ width: 12, height: 12 }} /> 新建
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
            {loadingList ? (
              <div style={{ textAlign: 'center', padding: 20, color: '#475569', fontSize: 12 }}>
                <Loader2 style={{ width: 16, height: 16, margin: '0 auto 8px', animation: 'spin 1s linear infinite' }} /> 加载中...
              </div>
            ) : workflows.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: '#475569', fontSize: 12 }}>
                暂无已保存的工作流
              </div>
            ) : (
              workflows.map(wf => (
                <div key={wf.id} onClick={() => handleSelectWorkflow(wf)}
                  style={{ padding: '8px 10px', marginBottom: 4, borderRadius: 8, cursor: 'pointer',
                    background: selectedId === wf.id ? 'rgba(6,182,212,.1)' : 'transparent',
                    border: selectedId === wf.id ? '1px solid rgba(6,182,212,.2)' : '1px solid transparent',
                    transition: 'all .12s', display: 'flex', alignItems: 'center', gap: 8,
                  }}
                  onMouseEnter={(e) => { if (selectedId !== wf.id) e.currentTarget.style.background = 'rgba(255,255,255,.03)'; }}
                  onMouseLeave={(e) => { if (selectedId !== wf.id) e.currentTarget.style.background = 'transparent'; }}>
                  <FileCode style={{ width: 14, height: 14, color: selectedId === wf.id ? '#06b6d4' : '#475569', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: selectedId === wf.id ? 500 : 400, color: selectedId === wf.id ? '#06b6d4' : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wf.name}</div>
                    <div style={{ fontSize: 10, color: '#475569' }}>{wf.steps?.length || 0} 步骤</div>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); handleDelete(wf.id); }} title="删除"
                    style={{ padding: 2, borderRadius: 4, background: 'transparent', border: 'none', color: '#475569', cursor: 'pointer', display: 'flex' }}>
                    <Trash2 style={{ width: 12, height: 12 }} />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* 中间：YAML 编辑器 + DAG 预览 */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {/* 编辑器工具栏 */}
          <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.06)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <input value={wfName} onChange={(e) => setWfName(e.target.value)} placeholder="工作流名称"
              style={{ flex: 1, padding: '5px 10px', borderRadius: 6, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', color: '#e2e8f0', fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
            <button onClick={handleSave} disabled={saving}
              style={{ padding: '5px 12px', borderRadius: 6, background: 'rgba(16,185,129,.1)', border: '1px solid rgba(16,185,129,.2)', color: '#10b981', fontSize: 12, cursor: saving ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit', opacity: saving ? 0.6 : 1 }}>
              {saving ? <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} /> : <Save style={{ width: 12, height: 12 }} />} 保存
            </button>
          </div>

          {/* YAML 编辑器 */}
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <textarea value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false}
              style={{ flex: 1, width: '100%', padding: '12px 16px', background: 'transparent', border: 'none', color: '#e2e8f0', fontSize: 13, fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace", lineHeight: 1.6, resize: 'none', outline: 'none', tabSize: 2 }} />
          </div>

          {/* 校验状态条 */}
          <div style={{ padding: '6px 12px', borderTop: '1px solid rgba(255,255,255,.06)', flexShrink: 0, fontSize: 11, display: 'flex', alignItems: 'center', gap: 8 }}>
            {validating ? (
              <><Loader2 style={{ width: 12, height: 12, color: '#06b6d4', animation: 'spin 1s linear infinite' }} /> <span style={{ color: '#64748b' }}>校验中...</span></>
            ) : validation ? (
              validation.valid ? (
                <><CheckCircle2 style={{ width: 12, height: 12, color: '#10b981' }} /> <span style={{ color: '#10b981' }}>校验通过</span>
                  {validation.warnings.length > 0 && <span style={{ color: '#f59e0b' }}> · {validation.warnings.length} 警告</span>}</>
              ) : (
                <><AlertCircle style={{ width: 12, height: 12, color: '#ef4444' }} /> <span style={{ color: '#ef4444' }}>{validation.errors[0] || '校验失败'}</span>
                  {validation.errors.length > 1 && <span style={{ color: '#64748b' }}> · 共 {validation.errors.length} 个错误</span>}</>
              )
            ) : (
              <span style={{ color: '#475569' }}>输入 YAML 后自动校验</span>
            )}
          </div>

          {/* DAG 预览 */}
          <div style={{ height: 220, flexShrink: 0, borderTop: '1px solid rgba(255,255,255,.06)', padding: '8px 12px', overflow: 'auto', background: 'rgba(0,0,0,.15)' }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: '#64748b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
              <WorkflowIcon style={{ width: 12, height: 12 }} /> DAG 预览
            </div>
            {dagNodes.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#475569', fontSize: 11, padding: 20 }}>无有效步骤</div>
            ) : (
              <svg width={dagWidth} height={dagHeight} style={{ display: 'block' }}>
                <defs>
                  <marker id="wf-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                    <polygon points="0 0, 8 3, 0 6" fill="#475569" />
                  </marker>
                </defs>
                {/* 边 */}
                {dagEdges.map((edge, i) => {
                  const from = dagNodes.find(n => n.id === edge.from);
                  const to = dagNodes.find(n => n.id === edge.to);
                  if (!from || !to) return null;
                  const x1 = from.x + 60, y1 = from.y + 18;
                  const x2 = to.x, y2 = to.y + 18;
                  const midX = (x1 + x2) / 2;
                  return <path key={`e-${i}`} d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`} fill="none" stroke="#475569" strokeWidth="1.5" strokeDasharray="4 2" markerEnd="url(#wf-arrow)" opacity="0.6" />;
                })}
                {/* 节点 */}
                {dagNodes.map(node => (
                  <g key={node.id}>
                    <rect x={node.x} y={node.y - 18} width="120" height="36" rx="8" fill="rgba(15,22,38,.8)" stroke="#06b6d4" strokeWidth="1" opacity="0.9" />
                    <text x={node.x + 8} y={node.y - 4} fill="#e2e8f0" fontSize="11" fontWeight="500" fontFamily="inherit">{node.id}</text>
                    <text x={node.x + 8} y={node.y + 10} fill="#64748b" fontSize="9" fontFamily="inherit">{node.tool.length > 14 ? node.tool.substring(0, 13) + '…' : node.tool}</text>
                  </g>
                ))}
              </svg>
            )}
          </div>
        </main>

        {/* 右侧：执行面板 */}
        <aside style={{ width: 300, flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,.06)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: '#94a3b8' }}>执行面板</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
            {/* inputs 输入 */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: '#64748b', display: 'block', marginBottom: 4 }}>输入参数 (JSON)</label>
              <textarea value={inputsText} onChange={(e) => setInputsText(e.target.value)} spellCheck={false}
                style={{ width: '100%', height: 60, padding: '8px', borderRadius: 6, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.08)', color: '#e2e8f0', fontSize: 11, fontFamily: "'Consolas', monospace", resize: 'none', outline: 'none', boxSizing: 'border-box' }} />
            </div>

            {/* 执行按钮 */}
            <button onClick={handleExecute} disabled={executing || (validation ? !validation.valid : false)}
              style={{ width: '100%', padding: '8px', borderRadius: 8, background: executing ? 'rgba(6,182,212,.05)' : 'linear-gradient(135deg, rgba(6,182,212,.15), rgba(139,92,246,.1))', border: '1px solid rgba(6,182,212,.2)', color: executing ? '#64748b' : '#06b6d4', fontSize: 13, fontWeight: 500, cursor: executing ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit', transition: 'all .15s' }}>
              {executing ? <Loader2 style={{ width: 14, height: 14, animation: 'spin 1s linear infinite' }} /> : <Play style={{ width: 14, height: 14 }} />}
              {executing ? '执行中...' : '执行工作流'}
            </button>

            {/* 执行结果 */}
            {executionResult && (
              <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, fontSize: 11,
                background: executionResult.type === 'success' ? 'rgba(16,185,129,.08)' : executionResult.type === 'error' ? 'rgba(239,68,68,.08)' : 'rgba(6,182,212,.08)',
                border: `1px solid ${executionResult.type === 'success' ? 'rgba(16,185,129,.15)' : executionResult.type === 'error' ? 'rgba(239,68,68,.15)' : 'rgba(6,182,212,.15)'}`,
                color: executionResult.type === 'success' ? '#10b981' : executionResult.type === 'error' ? '#ef4444' : '#06b6d4',
              }}>
                {executionResult.text}
              </div>
            )}

            {/* SSE 实时事件 */}
            {streamEvent && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 500, color: '#64748b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Zap style={{ width: 11, height: 11, color: '#06b6d4' }} /> 实时事件
                </div>
                <div style={{ padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.06)', fontSize: 10, fontFamily: 'monospace', color: '#94a3b8', lineHeight: 1.6 }}>
                  <div style={{ color: streamEvent.type === 'workflow.completed' ? '#10b981' : streamEvent.type === 'workflow.failed' ? '#ef4444' : '#06b6d4' }}>
                    {streamEvent.type}
                  </div>
                  {!!streamEvent.data?.workflowName && <div>工作流: {String(streamEvent.data.workflowName)}</div>}
                  {!!streamEvent.data?.executionId && <div style={{ color: '#475569' }}>ID: {String(streamEvent.data.executionId)}</div>}
                  {!!streamEvent.data?.summary && <div style={{ color: '#94a3b8', marginTop: 4 }}>{String(streamEvent.data.summary)}</div>}
                </div>
              </div>
            )}
          </div>

          {/* 执行历史 */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,.06)', padding: '8px 12px', maxHeight: 200, overflowY: 'auto', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: '#64748b' }}>执行历史</span>
              <button onClick={handleRefreshHistory} title="刷新" style={{ padding: 2, borderRadius: 4, background: 'transparent', border: 'none', color: '#475569', cursor: 'pointer', display: 'flex' }}>
                <RefreshCw style={{ width: 11, height: 11 }} />
              </button>
            </div>
            {history.length === 0 ? (
              <div style={{ fontSize: 11, color: '#475569', textAlign: 'center', padding: 8 }}>暂无执行记录</div>
            ) : (
              history.slice(0, 20).map(h => (
                <div key={h.executionId} style={{ padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,.03)', fontSize: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {h.status === 'completed' ? <CheckCircle2 style={{ width: 10, height: 10, color: '#10b981' }} /> : h.status === 'failed' ? <AlertCircle style={{ width: 10, height: 10, color: '#ef4444' }} /> : <Clock style={{ width: 10, height: 10, color: '#f59e0b' }} />}
                    <span style={{ color: '#94a3b8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.workflowName}</span>
                    {h.durationMs != null && <span style={{ color: '#475569' }}>{(h.durationMs / 1000).toFixed(1)}s</span>}
                  </div>
                  {h.summary && <div style={{ color: '#475569', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.summary}</div>}
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
