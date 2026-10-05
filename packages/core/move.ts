export interface MoveLogEntry {
  area: string;
  action: string;
  from: string;
  to: string;
  result: string;
  originalHeader?: string;
}

export interface MoveContext {
  oldRoot: string;
  newRoot: string;
  dryRun: boolean;
  log: (entry: MoveLogEntry) => void;
  backup: (file: string) => void;
}

export interface MoveItem {
  area: string;
  description: string;
  apply: () => Promise<void> | void;
}

export interface MoveHandler {
  id: string;
  label: string;
  scan(ctx: MoveContext): Promise<MoveItem[]> | MoveItem[];
  discoverOrphans?(): Promise<string[]>;
}

const handlers = new Map<string, MoveHandler>();

export function registerMoveHandler(handler: MoveHandler): void {
  handlers.set(handler.id, handler);
}

export function getMoveHandlers(): MoveHandler[] {
  return [...handlers.values()];
}
