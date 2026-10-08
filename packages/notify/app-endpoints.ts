/**
 * @pi-unipi/notify — registered phone UnifiedPush endpoints (UNI-161 §4b).
 *
 * The app's UnifiedPush connector registers with its distributor (the ntfy
 * Android app, if installed) and gets back an endpoint URL that is itself an
 * ntfy topic. It sends that URL to the host over a new `notify_register`
 * request; the host writes it here (never logs it — same as the ntfy topic
 * itself). notify's ntfy platform then also posts to every registered
 * endpoint, so the PC-side pi can reach the phone even though the phone
 * never learns the user's own ntfy.sh topic/token.
 *
 * ~/.unipi/config/notify/app-endpoints.json: `{ endpoints: [{url, addedAt}] }`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export interface AppEndpoint {
  url: string;
  addedAt: number;
}

function path(): string {
  return join(homedir(), ".unipi", "config", "notify", "app-endpoints.json");
}

/** Every registered endpoint. Returns `[]` on a missing/corrupt file. */
export function loadAppEndpoints(): AppEndpoint[] {
  try {
    const raw = readFileSync(path(), "utf-8");
    const parsed = JSON.parse(raw) as { endpoints?: unknown };
    if (!Array.isArray(parsed.endpoints)) return [];
    return parsed.endpoints.filter((e): e is AppEndpoint => !!e && typeof (e as AppEndpoint).url === "string");
  } catch {
    return [];
  }
}

/** Adds (or refreshes) one endpoint's `addedAt`; de-duplicated by URL. */
export function registerAppEndpoint(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;
  const existing = loadAppEndpoints().filter((e) => e.url !== trimmed);
  const next = [...existing, { url: trimmed, addedAt: Date.now() }];
  saveAppEndpoints(next);
}

/** Removes one endpoint (the app unregisters on logout / distributor change). */
export function unregisterAppEndpoint(url: string): void {
  saveAppEndpoints(loadAppEndpoints().filter((e) => e.url !== url));
}

function saveAppEndpoints(endpoints: AppEndpoint[]): void {
  const file = path();
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    // ignore
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ endpoints }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
