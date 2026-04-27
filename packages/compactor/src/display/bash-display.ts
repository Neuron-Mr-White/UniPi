/**
 * Bash display — spinner + elapsed time
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function getSpinnerFrame(index: number): string {
  return SPINNER_FRAMES[index % SPINNER_FRAMES.length];
}

export function formatElapsedTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m${secs}s`;
}

export function renderBashCall(command: string, opts?: { collapsed?: boolean }): string {
  if (opts?.collapsed) {
    const firstLine = command.split("\n")[0]?.trim() ?? command;
    if (firstLine.length > 80) {
      return firstLine.slice(0, 77) + "...";
    }
    return firstLine;
  }
  return command;
}
