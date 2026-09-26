/**
 * Exactly-once completion delivery for handoffs nobody is waiting on.
 *
 * `attach`/`detach` bracket every waiting period. The completion is sent only
 * if the report lands (or has already landed) while no waiter is attached, and
 * only once per handoff id.
 */
export function createCompletionDelivery<TReport>(
  send: (report: TReport) => void,
): {
  attach(id: string): void;
  detach(id: string, done: Promise<TReport>): void;
  consume(id: string): void;
} {
  const waiting = new Set<string>();
  const armed = new Set<string>();
  const delivered = new Set<string>();

  return {
    attach(id) {
      waiting.add(id);
    },
    detach(id, done) {
      waiting.delete(id);
      // One continuation per handoff, however many times a waiter gives up.
      if (armed.has(id)) return;
      armed.add(id);
      void done
        .then((report) => {
          if (waiting.has(id) || delivered.has(id)) return;
          delivered.add(id);
          send(report);
        })
        .catch(() => undefined);
    },
    consume(id) {
      waiting.delete(id);
      delivered.add(id);
    },
  };
}
