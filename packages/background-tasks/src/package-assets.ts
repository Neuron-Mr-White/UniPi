/**
 * @pi-unipi/background-tasks — locate package-owned assets from any entry.
 *
 * The delegate child guard (`extensions/delegate-child.ts`) and the recorded
 * hook-contract evidence (`src/delegate/hook-contract-evidence.json`) must be
 * found both when this package runs from source (`src/…`) and when it runs from
 * the umbrella bundle (`packages/unipi/bundled.js`, where `import.meta.url` no
 * longer points inside this package). We therefore walk upward from the calling
 * module until we find a `packages/background-tasks/` (or the package root
 * itself) that contains the asset.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ResolvePackageAssetOptions {
  moduleUrl?: string | undefined;
  pathExists?: ((path: string) => boolean) | undefined;
}

const PACKAGE_DIR_NAME = 'background-tasks';

/**
 * Resolve `relativePath` (relative to this package's root, e.g.
 * `extensions/delegate-child.ts`) or return undefined when no candidate exists.
 */
export function resolvePackageAsset(
  relativePath: string,
  options: ResolvePackageAssetOptions = {},
): string | undefined {
  const pathExists = options.pathExists ?? existsSync;
  const modulePath = fileURLToPath(options.moduleUrl ?? import.meta.url);
  let dir = dirname(modulePath);
  for (let depth = 0; depth < 8; depth++) {
    const candidates = [
      resolve(dir, relativePath),
      resolve(dir, PACKAGE_DIR_NAME, relativePath),
      resolve(dir, 'packages', PACKAGE_DIR_NAME, relativePath),
      resolve(dir, 'node_modules', '@pi-unipi', PACKAGE_DIR_NAME, relativePath),
    ];
    for (const candidate of candidates) if (pathExists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function packageAssetSearchHint(relativePath: string): string {
  return join('packages', PACKAGE_DIR_NAME, relativePath);
}
