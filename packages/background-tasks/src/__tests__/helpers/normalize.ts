export const isolatedTestEnv = {
  PI_OFFLINE: '1',
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
  CI: '1',
} as const;

const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export function normalizeVolatile(value: string): string {
  return value
    .replace(/b[0-9a-f]{8}/g, '<TASK_ID>')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<UUID>')
    .replace(/pid=?\s*\d+/gi, 'pid=<PID>')
    .replace(/\.pi\/tasks\/[^\s)]+/g, '.pi/tasks/<RUN>/<FILE>')
    .replace(/\/tmp\/[^\s)]+/g, '/tmp/<TEMP>');
}
