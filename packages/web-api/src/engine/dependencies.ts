/**
 * @unipi/web-api — Runtime Dependencies
 *
 * wreq-js and defuddle are hard dependencies (always installed).
 * Static imports replace the former lazy-loader theater.
 */

import * as wreq from "wreq-js";
import * as defuddle from "defuddle";

/** Get the wreq-js module. */
export function getWreq(): any {
  return wreq;
}

/** Get the defuddle module. */
export function getDefuddle(): any {
  return defuddle;
}

/** Check if all required dependencies are available. */
export function checkDependencies(): { available: boolean; missing: string[] } {
  return { available: true, missing: [] };
}
