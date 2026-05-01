/**
 * @unipi/web-api — Browser Profile Resolution
 *
 * Resolves browser TLS fingerprint profiles for wreq-js.
 */

import { DEFAULT_BROWSER, DEFAULT_OS } from "./constants.js";

/** Known browser profiles for TLS fingerprinting */
export const BROWSER_PROFILES = [
  // Chrome
  "chrome_100",
  "chrome_101",
  "chrome_104",
  "chrome_107",
  "chrome_110",
  "chrome_116",
  "chrome_119",
  "chrome_120",
  "chrome_123",
  "chrome_124",
  "chrome_131",
  "chrome_133",
  "chrome_145",
  // Firefox
  "firefox_120",
  "firefox_133",
  // Safari
  "safari_15_6_1",
  "safari_16_0",
  "safari_17_0",
  // Edge
  "edge_101",
] as const;

/** OS fingerprint options */
export const OS_PROFILES = [
  "windows",
  "macos",
  "linux",
  "android",
  "ios",
] as const;

/** Type for browser profile strings */
export type BrowserProfile = (typeof BROWSER_PROFILES)[number];

/** Type for OS profile strings */
export type OSProfile = (typeof OS_PROFILES)[number];

/**
 * Resolve a browser profile string.
 * If provided, validates against known profiles.
 * If omitted, returns the default (latest Chrome).
 *
 * @param browser - Browser profile string or undefined
 * @returns Validated browser profile
 */
export function resolveBrowserProfile(browser?: string): string {
  if (!browser) {
    return DEFAULT_BROWSER;
  }

  // Check exact match
  if ((BROWSER_PROFILES as readonly string[]).includes(browser)) {
    return browser;
  }

  // Try prefix match (e.g. "chrome" → latest Chrome)
  const prefix = browser.toLowerCase();
  const matches = BROWSER_PROFILES.filter((p) =>
    p.toLowerCase().startsWith(prefix)
  );

  if (matches.length > 0) {
    // Return the last (newest) matching profile
    return matches[matches.length - 1];
  }

  // Unknown profile — pass through (wreq-js may support newer profiles)
  return browser;
}

/**
 * Resolve an OS fingerprint string.
 * If omitted, returns the default (windows).
 *
 * @param os - OS string or undefined
 * @returns Validated OS string
 */
export function resolveOSProfile(os?: string): string {
  if (!os) {
    return DEFAULT_OS;
  }

  if ((OS_PROFILES as readonly string[]).includes(os)) {
    return os;
  }

  // Pass through unknown values
  return os;
}
