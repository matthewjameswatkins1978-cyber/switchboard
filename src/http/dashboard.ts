import type { BoardSummary } from '../core/types.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderDashboardHtml(board: BoardSummary, metricsSnapshot: any): string {
  const endpointRows = board.endpoints
    .map((ep) => {
      const stateBadge =
        ep.state === 'available'
          ? '<span class="badge badge-green">available</span>'
          : ep.state === 'busy'
          ? '<span class="badge badge-yellow">busy</span>'
          : ep.state === 'waiting'
          ? '<span class="badge badge-blue">waiting</span>'
          : ep.state === 'stale'
          ? '<span class="badge badge-orange">stale</span>'
          : '<span class="badge badge-gray">offline</span>';

      const lastSeenSec = Math.max(0, Math.floor((board.serverTime - ep.lastHeartbeatAt) / 1000));
      return `
        <tr>
          <td><strong>${escapeHtml(ep.endpointId)}</strong></td>
          <td>${stateBadge}</td>
          <td>${escapeHtml(ep.description ?? '—')}</td>
          <td>rev ${ep.revision}</td>
          <td>${lastSeenSec}s ago</td>
        </tr>
      `;
    })
    .join('');

  const messageRows = board.recentMessages
    .slice(0, 10)
    .map((m) => {
      const priorityClass =
        m.priority === 'urgent' ? 'badge-red' : m.priority === 'low' ? 'badge-gray' : 'badge-blue';
      const statusClass =
        m.deliveryStatus === 'ACKNOWLEDGED'
          ? 'badge-green'
          : m.deliveryStatus === 'RECEIVED'
          ? 'badge-yellow'
          : 'badge-orange';

      return `
        <tr>
          <td><code>${escapeHtml(m.id)}</code></td>
          <td>${escapeHtml(m.senderId)} &rarr; ${escapeHtml(m.recipientId)}</td>
          <td><span class="badge ${priorityClass}">${m.priority}</span></td>
          <td><strong>${escapeHtml(m.subject)}</strong></td>
          <td><span class="badge ${statusClass}">${m.deliveryStatus}</span></td>
          <td>${new Date(m.serverCreatedAt).toISOString().slice(11, 19)}</td>
        </tr>
      `;
    })
    .join('');

  const errorRows =
    board.recentErrors.length > 0
      ? board.recentErrors
          .map(
            (e) => `
        <tr>
          <td>${new Date(e.createdAt).toISOString()}</td>
          <td>${escapeHtml(e.action)}</td>
          <td><code>${escapeHtml(e.details)}</code></td>
        </tr>
      `
          )
          .join('')
      : '<tr><td colspan="3" class="muted">No recent operational errors recorded.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Switchboard — Work Board</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --green: #22c55e;
      --yellow: #eab308;
      --orange: #f97316;
      --red: #ef4444;
      --blue: #3b82f6;
    }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .title {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .project-pill {
      background: var(--card-bg);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      color: var(--accent);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .card h3 {
      margin: 0 0 8px 0;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }
    .card .val {
      font-size: 28px;
      font-weight: 700;
      color: var(--text);
    }
    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin: 24px 0 12px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      font-size: 14px;
      margin-bottom: 24px;
    }
    th, td {
      padding: 10px 14px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    th {
      background: #182234;
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    tr:last-child td {
      border-bottom: none;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-green { background: rgba(34, 197, 94, 0.15); color: var(--green); }
    .badge-yellow { background: rgba(234, 179, 8, 0.15); color: var(--yellow); }
    .badge-orange { background: rgba(249, 115, 22, 0.15); color: var(--orange); }
    .badge-red { background: rgba(239, 68, 68, 0.15); color: var(--red); }
    .badge-blue { background: rgba(59, 130, 246, 0.15); color: var(--blue); }
    .badge-gray { background: rgba(148, 163, 184, 0.15); color: var(--text-muted); }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      background: rgba(0,0,0,0.25);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .muted { color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">Switchboard &bull; Work Board</div>
    <div class="project-pill">Project: <strong>${escapeHtml(board.projectId)}</strong></div>
  </div>

  <div class="grid">
    <div class="card">
      <h3>Active Endpoints</h3>
      <div class="val">${board.endpoints.length}</div>
    </div>
    <div class="card">
      <h3>Unacknowledged Queue</h3>
      <div class="val" style="color: ${board.unackedCount > 0 ? 'var(--orange)' : 'var(--green)'};">
        ${board.unackedCount}
      </div>
    </div>
    <div class="card">
      <h3>Accepted Messages</h3>
      <div class="val">${metricsSnapshot.acceptedMessages ?? 0}</div>
    </div>
    <div class="card">
      <h3>Avg Latency</h3>
      <div class="val">${metricsSnapshot.avgLatencyMs ?? 0}<span style="font-size: 14px; font-weight: normal; color: var(--text-muted);"> ms</span></div>
    </div>
  </div>

  <div class="section-title">Endpoint Presence &amp; Status</div>
  <table>
    <thead>
      <tr>
        <th>Endpoint</th>
        <th>State</th>
        <th>Description</th>
        <th>Revision</th>
        <th>Last Heartbeat</th>
      </tr>
    </thead>
    <tbody>
      ${endpointRows || '<tr><td colspan="5" class="muted">No endpoints registered in this project.</td></tr>'}
    </tbody>
  </table>

  <div class="section-title">Recent Delivery Stream</div>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Flow</th>
        <th>Priority</th>
        <th>Subject</th>
        <th>Status</th>
        <th>Time</th>
      </tr>
    </thead>
    <tbody>
      ${messageRows || '<tr><td colspan="6" class="muted">No messages sent yet.</td></tr>'}
    </tbody>
  </table>

  <div class="section-title">Recent Operational Events</div>
  <table>
    <thead>
      <tr>
        <th>Time</th>
        <th>Action</th>
        <th>Details</th>
      </tr>
    </thead>
    <tbody>
      ${errorRows}
    </tbody>
  </table>
</body>
</html>`;
}
