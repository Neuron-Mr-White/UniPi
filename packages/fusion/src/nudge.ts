export const BASH_NUDGE_EVERY = 4;

const TRIVIAL = /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:git\s+(?:status|log|diff|branch|show|remote|rev-parse)|ls|pwd|cat|head|tail|wc|echo|which|type|rg|grep|find|stat|file|du|df|env|printenv|date|whoami|tmux\s+capture-pane|npm\s+(?:view|whoami|ls))\b[^|;&]*$/;

export function isTrivialShell(command: string): boolean {
  return TRIVIAL.test(command.trim());
}
