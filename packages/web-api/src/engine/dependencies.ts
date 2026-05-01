/**
 * @unipi/web-api — Runtime Dependencies
 *
 * Lazy-loaded dependencies for the smart-fetch engine.
 * Uses dynamic imports to handle optional native binding failures gracefully.
 */

let wreqModule: any = null;
let defuddleModule: any = null;
let lodashModule: any = null;
let mimeTypesModule: any = null;

/**
 * Get the wreq-js module.
 * Throws a helpful error if the module is not available.
 *
 * @returns wreq-js module
 */
export async function getWreq(): Promise<any> {
  if (wreqModule) {
    return wreqModule;
  }

  try {
    // Use dynamic import for ESM compatibility
    wreqModule = await import("wreq-js");
    return wreqModule;
  } catch (error) {
    throw new Error(
      `wreq-js is not available. ` +
      `This is required for browser-grade TLS fingerprinting. ` +
      `Run: npm install wreq-js\n` +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get the defuddle module.
 * Throws a helpful error if the module is not available.
 *
 * @returns defuddle module
 */
export async function getDefuddle(): Promise<any> {
  if (defuddleModule) {
    return defuddleModule;
  }

  try {
    defuddleModule = await import("defuddle");
    return defuddleModule;
  } catch (error) {
    throw new Error(
      `defuddle is not available. ` +
      `This is required for intelligent content extraction. ` +
      `Run: npm install defuddle\n` +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get the lodash module.
 *
 * @returns lodash module
 */
export async function getLodash(): Promise<any> {
  if (lodashModule) {
    return lodashModule;
  }

  try {
    lodashModule = await import("lodash");
    return lodashModule;
  } catch (error) {
    throw new Error(
      `lodash is not available. ` +
      `Run: npm install lodash\n` +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get the mime-types module.
 *
 * @returns mime-types module
 */
export async function getMimeTypes(): Promise<any> {
  if (mimeTypesModule) {
    return mimeTypesModule;
  }

  try {
    mimeTypesModule = await import("mime-types");
    return mimeTypesModule;
  } catch (error) {
    throw new Error(
      `mime-types is not available. ` +
      `Run: npm install mime-types\n` +
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Check if all required dependencies are available.
 *
 * @returns true if all deps are available
 */
export async function checkDependencies(): Promise<{
  available: boolean;
  missing: string[];
}> {
  const missing: string[] = [];

  try {
    await getWreq();
  } catch {
    missing.push("wreq-js");
  }

  try {
    await getDefuddle();
  } catch {
    missing.push("defuddle");
  }

  try {
    await getLodash();
  } catch {
    missing.push("lodash");
  }

  try {
    await getMimeTypes();
  } catch {
    missing.push("mime-types");
  }

  return {
    available: missing.length === 0,
    missing,
  };
}
