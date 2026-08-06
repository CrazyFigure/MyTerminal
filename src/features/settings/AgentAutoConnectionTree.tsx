/* 设置功能域内部模块；只暴露稳定的数据规则或独立视图。 */
import { Folder, FolderOpen } from 'lucide-react';
import type { ConnectionProfile } from '../../types';
import type { ConnectionGroupNode } from '../../app/connectionGroups';

export function AgentAutoConnectionTree({
  nodes,
  ungroupedConnections,
  allowedConnectionIds,
  onToggleConnection,
  ungroupedLabel,
}: {
  nodes: ConnectionGroupNode[];
  ungroupedConnections: ConnectionProfile[];
  allowedConnectionIds: string[];
  onToggleConnection: (connectionId: string, checked: boolean) => void;
  ungroupedLabel: string;
}) {
  const renderConnection = (connection: ConnectionProfile) => (
    <div key={connection.id} className="agent-tree-connection">
      <input
        aria-label={connection.name}
        checked={allowedConnectionIds.includes(connection.id)}
        type="checkbox"
        onChange={(event) => onToggleConnection(connection.id, event.target.checked)}
      />
      <span>{connection.name}</span>
      <strong>{connection.username}@{connection.host}:{connection.port}</strong>
    </div>
  );

  const renderGroup = (node: ConnectionGroupNode) => (
    <div key={node.path} className="agent-tree-group">
      <div className="agent-tree-group-title">
        <Folder size={14} />
        <span>{node.name}</span>
      </div>
      <div className="agent-tree-group-body">
        {node.connections.map(renderConnection)}
        {node.children.map(renderGroup)}
      </div>
    </div>
  );

  return (
    <div className="agent-connection-tree">
      {nodes.map(renderGroup)}
      {ungroupedConnections.length ? (
        <div className="agent-tree-group">
          <div className="agent-tree-group-title">
            <FolderOpen size={14} />
            <span>{ungroupedLabel}</span>
          </div>
          <div className="agent-tree-group-body">{ungroupedConnections.map(renderConnection)}</div>
        </div>
      ) : null}
    </div>
  );
}
