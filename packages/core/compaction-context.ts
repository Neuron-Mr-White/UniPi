/**
 * Active-work providers for compaction.
 *
 * Modules that drive autonomous work (long-horizon goals/ralph, kanboard
 * tasks) register a provider returning a short, authoritative description of
 * what is in flight. The compactor puts these at the top of every summary so
 * a loop keeps its task, rules and progress across compaction instead of the
 * summarizer guessing them from transcript text.
 */

export interface CompactionContextBlock {
  readonly id: string;
  readonly text: string;
}

/** Returns the active-work text, or null/empty when nothing is in flight. */
export type CompactionContextProvider = () => string | null | undefined;

const providers = new Map<string, CompactionContextProvider>();

/** Register (or replace) a provider; returns an unregister function. */
export function registerCompactionContext(id: string, provider: CompactionContextProvider): () => void {
  providers.set(id, provider);
  return () => {
    if (providers.get(id) === provider) providers.delete(id);
  };
}

/** Collect every non-empty provider block; a throwing provider is skipped. */
export function collectCompactionContext(): CompactionContextBlock[] {
  const blocks: CompactionContextBlock[] = [];
  for (const [id, provider] of providers) {
    try {
      const text = provider()?.trim();
      if (text) blocks.push({ id, text });
    } catch {
      // A broken provider must never block compaction.
    }
  }
  return blocks;
}
