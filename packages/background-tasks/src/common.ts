/**
 * @pi-unipi/background-tasks — Shared low-level helpers
 *
 * Ported from pi-background-tasks src/core/common.ts internals that live at the
 * module boundary (ChildStdin re-export shim). The bulk of common helpers lives
 * in ./types.js.
 */

import type { Writable } from "node:stream";

/** Writable stdin side of a spawned child. */
export type ChildStdin = Writable;
