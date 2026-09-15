/**
 * @pi-unipi/background-tasks — small hashing / canonical-JSON helpers shared by
 * the delegate artifact store and registry metadata writes.
 */
import { createHash } from 'node:crypto';
import { isJsonObject } from './types.js';
import { replaceFileDurable } from './durable-fs.js';

export function sha256Buffer(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await replaceFileDurable(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function closeAndFsyncOutputStream(
  stream: NodeJS.WritableStream | undefined,
): Promise<void> {
  if (!stream) return;
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.off('error', fail);
      stream.off('close', finish);
      stream.off('finish', finish);
      resolvePromise();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.off('close', finish);
      reject(error);
    };
    stream.once('close', finish);
    stream.once('finish', finish);
    stream.once('error', fail);
    stream.end();
  });
}
