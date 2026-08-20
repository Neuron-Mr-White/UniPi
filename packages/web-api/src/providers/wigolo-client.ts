/**
 * @unipi/web-api — wigolo daemon client lifecycle
 *
 * wigolo (https://github.com/KnockOutEZ/wigolo) is a local-first web engine:
 * multi-engine search, tiered fetch, on-device reranking. It needs no API key
 * and nothing leaves the machine.
 *
 * `wigolo-sdk` is AGPL-3.0-only while UniPi is MIT, so it is an *optional*
 * dependency loaded through a dynamic `import()`. UniPi therefore ships no
 * AGPL code; wigolo is used only if the user has installed it. When it is
 * absent (or not initialized) the provider reports an actionable error and
 * auto-selection falls through to the next-ranked provider.
 *
 * The daemon is expensive to start, so the client is a lazily-created
 * module-level singleton, closed on session shutdown.
 */

/** Minimal structural types — avoids a type-level dependency on the AGPL SDK. */
interface WigoloSearchResponse {
  results?: unknown[];
  answer?: string;
  error?: string;
  warning?: string;
  [key: string]: unknown;
}

interface WigoloFetchResponse {
  url?: string;
  title?: string;
  markdown?: string;
  error?: string;
  [key: string]: unknown;
}

interface WigoloHealthResponse {
  status?: string;
  [key: string]: unknown;
}

interface WigoloClientLike {
  search(params: Record<string, unknown>): Promise<WigoloSearchResponse>;
  fetch(params: Record<string, unknown>): Promise<WigoloFetchResponse>;
  health(): Promise<WigoloHealthResponse>;
}

interface WigoloLocalClient {
  client: WigoloClientLike;
  owned: boolean;
  close(): Promise<void>;
}

/** Raised when wigolo is unavailable, with an actionable remedy. */
export class WigoloUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WigoloUnavailableError";
  }
}

const NOT_INSTALLED_MESSAGE =
  "wigolo is not installed.\n" +
  "→ Install it:  npm install -g wigolo && npx wigolo init\n" +
  "→ wigolo is a separate AGPL-licensed project and is not bundled with UniPi.\n" +
  "→ Disable it in /unipi:web-settings to silence this.";

const NOT_RUNNING_MESSAGE =
  "wigolo is installed but the local daemon could not be reached.\n" +
  "→ Initialize it:  npx wigolo init\n" +
  "→ Check health:   npx wigolo doctor\n" +
  "→ Disable it in /unipi:web-settings to silence this.";

/** Cached singleton — the daemon is far too expensive to start per call. */
let clientPromise: Promise<WigoloLocalClient> | null = null;

/**
 * Test seam. ESM bindings are read-only, so tests cannot monkey-patch the
 * exported `getWigoloClient`; they inject a stub daemon here instead.
 */
let clientOverride: WigoloClientLike | null = null;

/** Last known availability, for the settings TUI and info screen. */

/** Load the optional SDK. Returns null when it is not installed. */
async function loadSdk(): Promise<
  { createLocalClient: (opts?: unknown) => Promise<WigoloLocalClient> } | null
> {
  try {
    // Non-literal specifier keeps bundlers from trying to resolve the optional
    // dependency at build time.
    const specifier = "wigolo-sdk/local";
    return (await import(/* @vite-ignore */ specifier)) as {
      createLocalClient: (opts?: unknown) => Promise<WigoloLocalClient>;
    };
  } catch {
    return null;
  }
}

/**
 * Get the shared wigolo client, starting the daemon if needed.
 * @throws {WigoloUnavailableError} when wigolo is not installed or unreachable.
 */
export async function getWigoloClient(): Promise<WigoloClientLike> {
  if (clientOverride) return clientOverride;

  if (!clientPromise) {
    clientPromise = (async () => {
      const sdk = await loadSdk();
      if (!sdk) {
        throw new WigoloUnavailableError(NOT_INSTALLED_MESSAGE);
      }
      try {
        return await sdk.createLocalClient();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new WigoloUnavailableError(`${NOT_RUNNING_MESSAGE}\n→ Cause: ${detail}`);
      }
    })();

    // A failed attempt must not be cached forever — the user may run
    // `wigolo init` mid-session.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }

  try {
    const local = await clientPromise;
    return local.client;
  } catch (error) {
    throw error;
  }
}

/** Close the daemon if this process started it. Safe to call repeatedly. */
export async function closeWigoloClient(): Promise<void> {
  const pending = clientPromise;
  clientPromise = null;
  if (!pending) return;
  try {
    const local = await pending;
    await local.close();
  } catch {
    // Never let shutdown cleanup throw.
  }
}

/** Availability for the settings TUI / info screen. Never throws. */

/** Whether the SDK is importable, without starting a daemon. Never throws. */
export async function isWigoloInstalled(): Promise<boolean> {
  return (await loadSdk()) !== null;
}

/** Last recorded failure, for diagnostics. */

/** Inject a stub daemon client. Test-only. */
export function __setWigoloClientForTests(client: WigoloClientLike | null): void {
  clientOverride = client;
}

/** Reset module state. Test-only. */
export function __resetWigoloClientForTests(): void {
  clientPromise = null;
  clientOverride = null;
}
