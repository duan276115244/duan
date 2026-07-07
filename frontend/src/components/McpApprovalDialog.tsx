import { useState, useEffect, useCallback, useRef } from 'react';
import { Shield, ShieldAlert, Check, X, Clock } from 'lucide-react';

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

interface PendingApproval {
  approvalId: string;
  serverId: string;
  toolName: string;
  riskLevel: RiskLevel;
  argsSummary: string;
  enqueuedAt: number;
  expiresAt: number;
  waitingSeconds: number;
  expiresInSeconds: number;
}

interface PendingResponse {
  total: number;
  pending: PendingApproval[];
}

interface ApproveResponse {
  success: boolean;
  approved: boolean;
  message: string;
}

interface ApproveRequest {
  approvalId: string;
  approved: boolean;
  serverId: string;
  toolName: string;
}

const RISK_COLORS: Record<RiskLevel, string> = {
  low: '#10b981',
  medium: '#f59e0b',
  high: '#f97316',
  critical: '#ef4444',
};

const RISK_LABELS: Record<RiskLevel, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '严重风险',
};

const ARGS_TRUNCATE_LENGTH = 200;

export function McpApprovalDialog() {
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [expandedArgs, setExpandedArgs] = useState<Set<string>>(new Set());
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const pendingRef = useRef<PendingApproval[]>([]);
  pendingRef.current = pending;

  const fetchPending = useCallback(async () => {
    try {
      const response = await fetch('/api/mcp/security/pending');
      if (!response.ok) return;
      const data: PendingResponse = await response.json();
      // 自动移除已过期的审批
      const active = (data.pending || []).filter((p) => p.expiresInSeconds > 0);
      setPending(active);
    } catch (error) {
      console.warn('获取 MCP 待审批列表失败:', error);
    }
  }, []);

  // 根据当前是否有待审批决定轮询间隔
  // P1 修复：移除 pending.length 依赖，避免每次列表变化都重新 fetch + 重建定时器
  // 使用固定 5 秒间隔（原 3s/10s 动态切换的优化不值得级联重复请求的代价）
  useEffect(() => {
    fetchPending();
    const interval = setInterval(fetchPending, 5000);
    return () => clearInterval(interval);
  }, [fetchPending]);

  // 每秒触发一次重绘以更新倒计时
  useEffect(() => {
    if (pending.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [pending.length]);

  const handleApprove = useCallback(async (approval: PendingApproval, approved: boolean) => {
    const { approvalId, serverId, toolName } = approval;
    // 立即从列表移除，避免重复点击
    setProcessingIds((prev) => new Set(prev).add(approvalId));
    setPending((prev) => prev.filter((p) => p.approvalId !== approvalId));
    try {
      const body: ApproveRequest = { approvalId, approved, serverId, toolName };
      const response = await fetch('/api/mcp/security/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        console.warn('审批请求失败:', response.status);
      } else {
        const data: ApproveResponse = await response.json();
        if (!data.success) {
          console.warn('审批处理失败:', data.message);
        }
      }
    } catch (error) {
      console.warn('提交审批失败:', error);
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev);
        next.delete(approvalId);
        return next;
      });
    }
  }, []);

  const toggleArgs = useCallback((approvalId: string) => {
    setExpandedArgs((prev) => {
      const next = new Set(prev);
      if (next.has(approvalId)) next.delete(approvalId);
      else next.add(approvalId);
      return next;
    });
  }, []);

  // tick 仅用于触发倒计时重绘
  void tick;

  if (pending.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10, 14, 20, 0.95)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: 16,
      }}
    >
      <div
        style={{
          background: '#0d1117',
          border: '1px solid #30363d',
          borderRadius: 12,
          width: '100%',
          maxWidth: 640,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.6)',
          color: '#e2e8f0',
        }}
      >
        {/* 头部 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid #30363d',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldAlert style={{ width: 18, height: 18, color: '#f97316' }} />
            <span style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0' }}>
              MCP 安全审批
            </span>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 10,
                background: 'rgba(249, 115, 22, 0.12)',
                color: '#f97316',
                border: '1px solid rgba(249, 115, 22, 0.25)',
                fontWeight: 500,
              }}
            >
              {pending.length} 项待处理
            </span>
          </div>
        </div>

        {/* 审批列表 */}
        <div style={{ overflowY: 'auto', padding: '8px 12px' }}>
          {pending.map((approval) => {
            const riskColor = RISK_COLORS[approval.riskLevel] || '#94a3b8';
            const isExpanded = expandedArgs.has(approval.approvalId);
            const summary = approval.argsSummary || '';
            const needsTruncate = summary.length > ARGS_TRUNCATE_LENGTH;
            const displayedSummary =
              needsTruncate && !isExpanded
                ? summary.slice(0, ARGS_TRUNCATE_LENGTH)
                : summary;
            const isProcessing = processingIds.has(approval.approvalId);
            const expiresInSeconds = Math.max(0, approval.expiresInSeconds);

            return (
              <div
                key={approval.approvalId}
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid #30363d',
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 8,
                  opacity: isProcessing ? 0.5 : 1,
                  transition: 'opacity .15s',
                }}
              >
                {/* 工具与服务器 */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <Shield
                      style={{ width: 14, height: 14, color: riskColor, flexShrink: 0 }}
                    />
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: '#e2e8f0',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {approval.toolName}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: '#64748b',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      @ {approval.serverId}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 8,
                      fontWeight: 600,
                      color: riskColor,
                      background: `${riskColor}1a`,
                      border: `1px solid ${riskColor}40`,
                      flexShrink: 0,
                    }}
                  >
                    {RISK_LABELS[approval.riskLevel]}
                  </span>
                </div>

                {/* 参数摘要 */}
                {displayedSummary && (
                  <div
                    style={{
                      fontSize: 12,
                      color: '#94a3b8',
                      lineHeight: 1.5,
                      background: 'rgba(0, 0, 0, 0.25)',
                      border: '1px solid #21262d',
                      borderRadius: 6,
                      padding: '6px 8px',
                      marginBottom: 8,
                      fontFamily: 'monospace',
                      wordBreak: 'break-all',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {displayedSummary}
                    {needsTruncate && (
                      <button
                        onClick={() => toggleArgs(approval.approvalId)}
                        style={{
                          marginLeft: 6,
                          background: 'none',
                          border: 'none',
                          color: '#06b6d4',
                          cursor: 'pointer',
                          fontSize: 11,
                          padding: 0,
                          fontFamily: 'inherit',
                        }}
                      >
                        {isExpanded ? '收起' : '展开'}
                      </button>
                    )}
                  </div>
                )}

                {/* 倒计时与操作 */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 11,
                      color: expiresInSeconds <= 10 ? '#ef4444' : '#64748b',
                    }}
                  >
                    <Clock style={{ width: 12, height: 12 }} />
                    <span>
                      {expiresInSeconds > 0
                        ? `${expiresInSeconds}s 后过期`
                        : '已过期'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => handleApprove(approval, true)}
                      disabled={isProcessing}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '5px 12px',
                        borderRadius: 6,
                        border: 'none',
                        background: '#10b981',
                        color: '#ffffff',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: isProcessing ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      <Check style={{ width: 12, height: 12 }} />
                      批准
                    </button>
                    <button
                      onClick={() => handleApprove(approval, false)}
                      disabled={isProcessing}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '5px 12px',
                        borderRadius: 6,
                        border: 'none',
                        background: '#ef4444',
                        color: '#ffffff',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: isProcessing ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      <X style={{ width: 12, height: 12 }} />
                      拒绝
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
