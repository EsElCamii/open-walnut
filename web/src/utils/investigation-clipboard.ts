/**
 * Build the clipboard payload for the Investigate button — every id a human
 * needs to chase a session down across layers (session/task/incident/bundle/host).
 * Lines are filtered so absent fields don't leave dangling labels.
 */
export function buildInvestigationClip(fields: {
  sessionId: string;
  taskId?: string;
  incidentId: string;
  bundlePath?: string;
  host?: string;
}): string {
  return [
    `session: ${fields.sessionId}`,
    fields.taskId ? `task: ${fields.taskId}` : null,
    `incident: ${fields.incidentId}`,
    fields.bundlePath ? `bundle: ${fields.bundlePath}` : null,
    `host: ${fields.host || '__local__'}`,
  ].filter(Boolean).join('\n');
}
