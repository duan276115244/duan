/**
 * SubAgentDAG — SubAgent 团队 DAG 可视化组件
 *
 * 纯 SVG + React，无第三方依赖。
 * 节点：圆形/矩形，显示角色名 + 状态颜色
 * 边：箭头线，planner → implementer → reviewer → tester
 * 布局：固定坐标网格
 */
import type { SubAgentStatus } from '../hooks/useSubAgentStream';

export interface DAGNode {
  id: string;
  role: string;
  name: string;
  status?: SubAgentStatus;
  x: number;
  y: number;
}

export interface DAGEdge {
  from: string;
  to: string;
}

interface SubAgentDAGProps {
  nodes: DAGNode[];
  edges: DAGEdge[];
  width?: number;
  height?: number;
}

const STATUS_COLORS: Record<string, string> = {
  idle: '#64748b',
  running: '#06b6d4',
  waiting_human: '#f59e0b',
  completed: '#10b981',
  error: '#ef4444',
};

const ROLE_LABELS: Record<string, string> = {
  planner: '规划师',
  implementer: '开发者',
  reviewer: '审查员',
  researcher: '研究员',
  debugger: '调试员',
  architect: '架构师',
  tester: '测试员',
  writer: '撰写员',
};

export function SubAgentDAG({ nodes, edges, width = 480, height = 280 }: SubAgentDAGProps) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  return (
    <svg width={width} height={height} style={{ display: 'block', margin: '0 auto' }}>
      {/* 定义箭头标记 */}
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#475569" />
        </marker>
        <filter id="nodeGlow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 绘制边 */}
      {edges.map((edge, i) => {
        const from = nodeMap.get(edge.from);
        const to = nodeMap.get(edge.to);
        if (!from || !to) return null;
        // 从 from 节点底部到 to 节点顶部
        const x1 = from.x;
        const y1 = from.y + 22;
        const x2 = to.x;
        const y2 = to.y - 22;
        // 贝塞尔曲线控制点
        const midY = (y1 + y2) / 2;
        return (
          <path
            key={`edge-${i}`}
            d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
            fill="none"
            stroke="#475569"
            strokeWidth="1.5"
            strokeDasharray="4 2"
            markerEnd="url(#arrowhead)"
            opacity="0.6"
          />
        );
      })}

      {/* 绘制节点 */}
      {nodes.map(node => {
        const color = STATUS_COLORS[node.status || 'idle'] || STATUS_COLORS.idle;
        const label = ROLE_LABELS[node.role] || node.role;
        const isRunning = node.status === 'running';
        return (
          <g key={node.id} filter={isRunning ? 'url(#nodeGlow)' : undefined}>
            {/* 节点背景圆角矩形 */}
            <rect
              x={node.x - 50}
              y={node.y - 22}
              width="100"
              height="44"
              rx="10"
              fill="rgba(15, 22, 38, 0.8)"
              stroke={color}
              strokeWidth={isRunning ? 2 : 1}
              opacity="0.9"
            />
            {/* 状态指示点 */}
            <circle cx={node.x - 38} cy={node.y - 8} r="4" fill={color}>
              {isRunning && (
                <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite" />
              )}
            </circle>
            {/* 角色标签 */}
            <text
              x={node.x - 28}
              y={node.y - 5}
              fill="#e2e8f0"
              fontSize="11"
              fontWeight="500"
              fontFamily="inherit"
            >
              {label}
            </text>
            {/* Agent 名称 */}
            <text
              x={node.x}
              y={node.y + 10}
              fill="#94a3b8"
              fontSize="9"
              fontFamily="inherit"
              textAnchor="middle"
            >
              {node.name.length > 8 ? node.name.substring(0, 7) + '…' : node.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * 根据 team 模板 members 生成 DAG 节点和边
 */
export function buildDAGFromMembers(
  members: Array<{ role: string; name: string }>,
  agentStatuses?: Map<string, SubAgentStatus>,
): { nodes: DAGNode[]; edges: DAGEdge[] } {
  // 按角色分层
  const layers: Record<string, DAGNode[]> = {};
  const yMap: Record<string, number> = {
    planner: 40,
    researcher: 40,
    architect: 40,
    implementer: 120,
    debugger: 120,
    reviewer: 200,
    tester: 200,
    writer: 200,
  };

  const xOffsets: Record<string, number> = {};
  members.forEach((m, i) => {
    const y = yMap[m.role] || 120;
    if (!layers[m.role]) layers[m.role] = [];
    const id = `${m.role}_${i}`;
    const status = agentStatuses?.get(id);
    const node: DAGNode = {
      id,
      role: m.role,
      name: m.name,
      status,
      x: 0,
      y,
    };
    // 计算横向位置
    if (!xOffsets[m.role]) xOffsets[m.role] = 0;
    layers[m.role].push(node);
  });

  // 分配横向坐标
  const nodes: DAGNode[] = [];
  for (const role of Object.keys(layers)) {
    const layer = layers[role];
    const totalWidth = layer.length * 120;
    const startX = 240 - totalWidth / 2 + 60;
    layer.forEach((node, i) => {
      node.x = startX + i * 120;
      nodes.push(node);
    });
  }

  // 生成边（按角色依赖关系）
  const edges: DAGEdge[] = [];
  const roleOrder = ['planner', 'implementer', 'reviewer', 'tester'];
  for (let i = 0; i < roleOrder.length - 1; i++) {
    const fromRole = roleOrder[i];
    const toRole = roleOrder[i + 1];
    const fromNodes = layers[fromRole] || [];
    const toNodes = layers[toRole] || [];
    // planner → implementer: 全连接
    // implementer → reviewer: 全连接
    // reviewer → tester: 全连接
    for (const fn of fromNodes) {
      for (const tn of toNodes) {
        edges.push({ from: fn.id, to: tn.id });
      }
    }
  }
  // researcher → writer 特殊处理
  if (layers['researcher'] && layers['writer']) {
    for (const fn of layers['researcher']) {
      for (const tn of layers['writer']) {
        edges.push({ from: fn.id, to: tn.id });
      }
    }
  }

  return { nodes, edges };
}
