import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { canonicalJson } from '../attested-pi-run.js';
import { isJsonObject, parseJsonText } from '../types.js';
import {
  FUSION_SOURCE_POLICY_SCHEMA_VERSION,
  FusionError,
  type FusionDeclaredSourceV1,
  type FusionSourcePolicyV1,
} from './types.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const O_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === 'metadata' ||
    lower === 'metadata.local' ||
    lower === 'metadata.google.internal' ||
    lower === 'metadata.goog' ||
    lower === 'instance-data' ||
    lower === 'instance-data.ec2.internal'
  );
}

function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return true;
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return host === '255.255.255.255' || host === '168.63.129.16';
}

function isBlockedIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('::ffff:') ||
    lower.startsWith('64:ff9b::') ||
    lower.startsWith('64:ff9b:1:') ||
    lower.startsWith('100:') ||
    lower.startsWith('2001:2:') ||
    lower.startsWith('2001:db8:') ||
    lower.startsWith('2002:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('ff')
  );
}

export function canonicalizeFusionPublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new FusionError(
      `fusion research declared source URL is malformed: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new FusionError('fusion research source URL must not contain credentials', {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FusionError('fusion research source URL must use http or https', {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  const normalizedHost = stripIpv6Brackets(url.hostname.toLowerCase().replace(/\.+$/u, ''));
  url.hostname = normalizedHost;
  if (isBlockedHostname(normalizedHost)) {
    throw new FusionError('fusion research source URL must be public, not localhost/metadata', {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  const ipKind = isIP(normalizedHost);
  if ((ipKind === 4 && isBlockedIpv4(normalizedHost)) || (ipKind === 6 && isBlockedIpv6(normalizedHost))) {
    throw new FusionError('fusion research source URL must be public, not private/reserved', {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  return url.toString();
}

export interface DeclaredFusionSourceInput {
  url: string;
  purpose: string;
}

export function normalizeFusionDeclaredSources(
  sources: readonly DeclaredFusionSourceInput[] = [],
): readonly FusionDeclaredSourceV1[] {
  const seen = new Map<string, number>();
  return sources.map((source, index) => {
    if (typeof source.url !== 'string' || source.url.trim().length === 0) {
      throw new FusionError(`fusion research source ${String(index)} requires non-blank URL`, {
        code: 'orchestration_failed',
        childCreated: false,
      });
    }
    if (typeof source.purpose !== 'string' || source.purpose.trim().length === 0) {
      throw new FusionError(`fusion research source ${String(index)} requires non-blank purpose`, {
        code: 'orchestration_failed',
        childCreated: false,
      });
    }
    const canonicalUrl = canonicalizeFusionPublicUrl(source.url.trim());
    const previous = seen.get(canonicalUrl);
    if (previous !== undefined) {
      throw new FusionError(
        `fusion research source ${String(index)} duplicates canonical URL from source ${String(previous)}: ${canonicalUrl}`,
        { code: 'orchestration_failed', childCreated: false },
      );
    }
    seen.set(canonicalUrl, index);
    const purpose = source.purpose.trim();
    return {
      url: canonicalUrl,
      canonical_url: canonicalUrl,
      purpose,
      sha256: sha256Text(`${canonicalUrl}\u0000${purpose}`),
    };
  });
}

export function buildFusionSourcePolicy(
  cwd: string,
  sources: readonly FusionDeclaredSourceV1[],
): FusionSourcePolicyV1 {
  const body = {
    schema_version: FUSION_SOURCE_POLICY_SCHEMA_VERSION,
    workflow: 'research' as const,
    cwd,
    sources,
  } as const;
  return { ...body, root_sha256: sha256Text(canonicalJson(body)) };
}

export function sourcePolicyCanonicalBytes(policy: FusionSourcePolicyV1): string {
  return canonicalJson(policy);
}

function requireString(record: Record<PropertyKey, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${key} must be non-blank string`);
  return value;
}

export function parseFusionSourcePolicy(value: unknown): FusionSourcePolicyV1 {
  if (!isJsonObject(value) || Array.isArray(value)) throw new Error('fusion source policy must be object');
  const keys = Object.keys(value).sort();
  const expected = ['cwd', 'root_sha256', 'schema_version', 'sources', 'workflow'];
  if (keys.join('\0') !== expected.join('\0')) throw new Error('fusion source policy keys mismatch');
  if (value['schema_version'] !== FUSION_SOURCE_POLICY_SCHEMA_VERSION) throw new Error('fusion source policy schema_version mismatch');
  if (value['workflow'] !== 'research') throw new Error('fusion source policy workflow must be research');
  const cwd = requireString(value, 'cwd', 'fusion source policy');
  const rootSha256 = requireString(value, 'root_sha256', 'fusion source policy');
  if (!SHA256_HEX.test(rootSha256)) throw new Error('fusion source policy.root_sha256 must be sha256');
  if (!Array.isArray(value['sources'])) throw new Error('fusion source policy.sources must be array');
  const sources = value['sources'].map((item, index): FusionDeclaredSourceV1 => {
    const label = `fusion source policy.sources[${String(index)}]`;
    if (!isJsonObject(item) || Array.isArray(item)) throw new Error(`${label} must be object`);
    const itemKeys = Object.keys(item).sort();
    const itemExpected = ['canonical_url', 'purpose', 'sha256', 'url'];
    if (itemKeys.join('\0') !== itemExpected.join('\0')) throw new Error(`${label} keys mismatch`);
    const url = requireString(item, 'url', label);
    const purpose = requireString(item, 'purpose', label);
    const canonical_url = requireString(item, 'canonical_url', label);
    const sha256 = requireString(item, 'sha256', label);
    if (!SHA256_HEX.test(sha256)) throw new Error(`${label}.sha256 must be sha256`);
    if (canonicalizeFusionPublicUrl(url) !== canonical_url) throw new Error(`${label}.canonical_url mismatch`);
    if (url !== canonical_url) throw new Error(`${label}.url must equal canonical_url`);
    if (purpose.trim() !== purpose) throw new Error(`${label}.purpose must be trimmed`);
    if (sha256Text(`${canonical_url}\u0000${purpose}`) !== sha256) throw new Error(`${label}.sha256 mismatch`);
    return { url, canonical_url, purpose, sha256 };
  });
  const seen = new Set<string>();
  for (const [index, source] of sources.entries()) {
    if (seen.has(source.canonical_url)) {
      throw new Error(`fusion source policy.sources[${String(index)}].canonical_url duplicate`);
    }
    seen.add(source.canonical_url);
  }
  const body = { schema_version: FUSION_SOURCE_POLICY_SCHEMA_VERSION, workflow: 'research' as const, cwd, sources } as const;
  if (sha256Text(canonicalJson(body)) !== rootSha256) throw new Error('fusion source policy root_sha256 mismatch');
  return { ...body, root_sha256: rootSha256 };
}

async function readRegularFileNoSymlink(path: string, label: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (isJsonObject(error) && error['code'] === 'ELOOP') {
      throw new Error(`${label} at ${path} is a symlink; refusing to follow it`);
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${label} at ${path} is not a regular file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readFusionSourcePolicyFile(path: string, expectedSha256: string): Promise<FusionSourcePolicyV1> {
  if (!SHA256_HEX.test(expectedSha256)) throw new Error('fusion source policy expected hash is malformed');
  const bytes = await readRegularFileNoSymlink(path, 'fusion source policy');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) throw new Error('fusion source policy artifact hash mismatch');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('fusion source policy is not UTF-8');
  return parseFusionSourcePolicy(parseJsonText(text));
}
