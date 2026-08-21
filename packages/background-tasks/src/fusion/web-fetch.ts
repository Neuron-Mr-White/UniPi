import { createHash } from 'node:crypto';
import { lookup as nodeLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

import type TurndownService from 'turndown';

export const FUSION_WEB_FETCH_TIMEOUT_MS = 90_000;
export const FUSION_WEB_FETCH_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const FUSION_WEB_FETCH_MAX_OUTPUT_BYTES = 32 * 1024;
export const FUSION_WEB_FETCH_MAX_REDIRECTS = 5;

export interface FusionWebFetchRequest {
  url: string;
  extract?: 'text' | 'markdown';
}

export interface FusionWebFetchResult {
  url: string;
  final_url: string;
  status: number;
  content_type: string;
  format: 'text' | 'markdown';
  truncated: boolean;
  content: string;
  response_bytes: number;
  content_sha256: string;
  duration_ms: number;
}

export type FusionWebFetchErrorCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'blocked_address'
  | 'dns_failure'
  | 'redirect_limit'
  | 'redirect_blocked'
  | 'response_too_large'
  | 'unsupported_content_type'
  | 'request_timeout'
  | 'network_error'
  | 'extraction_failed'
  | 'http_error';

export interface FusionDnsAddress {
  address: string;
  family: 4 | 6;
}

export type FusionDnsLookup = (hostname: string) => Promise<readonly FusionDnsAddress[]>;

export type FusionTransportRequest = (
  protocol: 'http:' | 'https:',
  options: http.RequestOptions | https.RequestOptions,
) => http.ClientRequest;

export type FusionContentExtractor = (
  body: Buffer,
  contentType: string,
  requestedFormat: 'text' | 'markdown',
) => Promise<{ content: string; format: 'text' | 'markdown' }>;

export interface FusionWebFetchOptions {
  lookup?: FusionDnsLookup;
  request?: FusionTransportRequest;
  agent?: http.Agent | https.Agent | false;
  createConnection?: http.RequestOptions['createConnection'];
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxOutputBytes?: number;
  maxRedirects?: number;
  allowBlockedAddressesForTests?: boolean;
  /** Test seam for proving extraction remains inside the full-operation deadline. */
  extractContent?: FusionContentExtractor;
}

interface NormalizedRequestUrl {
  url: URL;
  hostname: string;
}

interface VettedHost {
  selectedAddress: FusionDnsAddress;
  resolvedAddresses: readonly FusionDnsAddress[];
}

interface FetchOneSuccess {
  kind: 'success';
  status: number;
  contentType: string;
  body: Buffer;
}

interface FetchOneRedirect {
  kind: 'redirect';
  status: number;
  location: string;
}

type FetchOneResult = FetchOneSuccess | FetchOneRedirect;

interface EffectiveOptions {
  lookup: FusionDnsLookup;
  request: FusionTransportRequest;
  agent: http.Agent | https.Agent | false;
  createConnection?: http.RequestOptions['createConnection'];
  now: () => number;
  timeoutMs: number;
  maxResponseBytes: number;
  maxOutputBytes: number;
  maxRedirects: number;
  allowBlockedAddressesForTests: boolean;
  extractContent: FusionContentExtractor;
}

interface ExtractionResult {
  content: string;
  format: 'text' | 'markdown';
}

interface TableReplacement {
  token: string;
  markdown: string;
}

type TurndownServiceConstructor = typeof TurndownService;

let turndownServiceLoad: Promise<TurndownServiceConstructor> | undefined;

const USER_AGENT = 'pi-background-tasks fusion_web_fetch/1.0';
const ACCEPT_HEADER = 'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, text/plain;q=0.7';
const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.local',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

const IPV4_DENY_RANGES: readonly [number, number][] = [
  [ipv4ToNumberLiteral('0.0.0.0'), 8],
  [ipv4ToNumberLiteral('10.0.0.0'), 8],
  [ipv4ToNumberLiteral('100.64.0.0'), 10],
  [ipv4ToNumberLiteral('127.0.0.0'), 8],
  [ipv4ToNumberLiteral('169.254.0.0'), 16],
  [ipv4ToNumberLiteral('172.16.0.0'), 12],
  [ipv4ToNumberLiteral('192.0.0.0'), 24],
  [ipv4ToNumberLiteral('192.0.2.0'), 24],
  [ipv4ToNumberLiteral('192.168.0.0'), 16],
  [ipv4ToNumberLiteral('198.18.0.0'), 15],
  [ipv4ToNumberLiteral('198.51.100.0'), 24],
  [ipv4ToNumberLiteral('203.0.113.0'), 24],
  [ipv4ToNumberLiteral('224.0.0.0'), 4],
  [ipv4ToNumberLiteral('240.0.0.0'), 4],
  [ipv4ToNumberLiteral('255.255.255.255'), 32],
  [ipv4ToNumberLiteral('169.254.169.254'), 32],
] as const;

const IPV6_DENY_RANGES: readonly [bigint, number][] = [
  [ipv6ToBigIntLiteral('::'), 128],
  [ipv6ToBigIntLiteral('::1'), 128],
  [ipv6ToBigIntLiteral('64:ff9b::'), 96],
  [ipv6ToBigIntLiteral('64:ff9b:1::'), 48],
  [ipv6ToBigIntLiteral('100::'), 64],
  [ipv6ToBigIntLiteral('2001:2::'), 48],
  [ipv6ToBigIntLiteral('2001:db8::'), 32],
  [ipv6ToBigIntLiteral('2002::'), 16],
  [ipv6ToBigIntLiteral('fc00::'), 7],
  [ipv6ToBigIntLiteral('fe80::'), 10],
  [ipv6ToBigIntLiteral('ff00::'), 8],
  [ipv6ToBigIntLiteral('fd00:ec2::254'), 128],
  [ipv6ToBigIntLiteral('::ffff:0:0'), 96],
] as const;

export class FusionWebFetchError extends Error {
  public readonly code: FusionWebFetchErrorCode;
  public readonly url?: string;
  public readonly status?: number;

  public constructor(
    code: FusionWebFetchErrorCode,
    message: string,
    details: { url?: string; status?: number; cause?: Error } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'FusionWebFetchError';
    this.code = code;
    if (details.url !== undefined) this.url = details.url;
    if (details.status !== undefined) this.status = details.status;
  }
}

export async function fusionWebFetch(
  req: FusionWebFetchRequest,
  options: FusionWebFetchOptions = {},
): Promise<FusionWebFetchResult> {
  const effective = mergeOptions(options);
  const requestedFormat = req.extract ?? 'markdown';
  const start = effective.now();
  const deadlineMs = start + effective.timeoutMs;
  const requestedUrl = normalizeRequestUrl(req.url).url;
  let currentUrl = requestedUrl;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const remainingMs = deadlineMs - effective.now();
    if (remainingMs <= 0) {
      throw new FusionWebFetchError('request_timeout', 'fusion_web_fetch request timeout elapsed', {
        url: currentUrl.toString(),
      });
    }

    const result = await fetchOne(currentUrl, effective, deadlineMs, redirectCount > 0);
    if (result.kind === 'redirect') {
      if (redirectCount >= effective.maxRedirects) {
        throw new FusionWebFetchError(
          'redirect_limit',
          `fusion_web_fetch redirect limit exceeded (${String(effective.maxRedirects)})`,
          { url: currentUrl.toString(), status: result.status },
        );
      }
      currentUrl = normalizeRedirectUrl(currentUrl, result.location);
      continue;
    }

    const extracted = await extractWithinDeadline(
      result.body,
      result.contentType,
      requestedFormat,
      effective,
      deadlineMs,
      currentUrl,
    );
    const capped = capUtf8Bytes(extracted.content, effective.maxOutputBytes);
    const contentSha256 = createHash('sha256').update(result.body).digest('hex');
    assertFetchDeadline(effective, deadlineMs, currentUrl, 'content extraction');
    const durationMs = Math.max(0, effective.now() - start);
    if (durationMs > effective.timeoutMs) {
      throw fetchTimeout(currentUrl, 'content extraction');
    }
    return {
      url: requestedUrl.toString(),
      final_url: currentUrl.toString(),
      status: result.status,
      content_type: result.contentType,
      format: extracted.format,
      truncated: capped.truncated,
      content: capped.content,
      response_bytes: result.body.byteLength,
      content_sha256: contentSha256,
      duration_ms: durationMs,
    };
  }
}

function mergeOptions(options: FusionWebFetchOptions): EffectiveOptions {
  return {
    lookup: options.lookup ?? defaultLookup,
    request: options.request ?? defaultTransportRequest,
    agent: options.agent ?? false,
    createConnection: options.createConnection,
    now: options.now ?? (() => performance.now()),
    timeoutMs: options.timeoutMs ?? FUSION_WEB_FETCH_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? FUSION_WEB_FETCH_MAX_RESPONSE_BYTES,
    maxOutputBytes: options.maxOutputBytes ?? FUSION_WEB_FETCH_MAX_OUTPUT_BYTES,
    maxRedirects: options.maxRedirects ?? FUSION_WEB_FETCH_MAX_REDIRECTS,
    allowBlockedAddressesForTests: options.allowBlockedAddressesForTests ?? false,
    extractContent: options.extractContent ?? extractContent,
  };
}

function fetchTimeout(url: URL, phase: string): FusionWebFetchError {
  return new FusionWebFetchError(
    'request_timeout',
    `fusion_web_fetch request timeout elapsed during ${phase}`,
    { url: url.toString() },
  );
}

function assertFetchDeadline(
  options: EffectiveOptions,
  deadlineMs: number,
  url: URL,
  phase: string,
): number {
  const remainingMs = deadlineMs - options.now();
  if (remainingMs <= 0) throw fetchTimeout(url, phase);
  return remainingMs;
}

async function extractWithinDeadline(
  body: Buffer,
  contentType: string,
  requestedFormat: 'text' | 'markdown',
  options: EffectiveOptions,
  deadlineMs: number,
  url: URL,
): Promise<ExtractionResult> {
  const remainingMs = assertFetchDeadline(options, deadlineMs, url, 'content extraction');
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(fetchTimeout(url, 'content extraction')), remainingMs);
    });
    const extraction = Promise.resolve().then(() =>
      options.extractContent(body, contentType, requestedFormat),
    );
    const result = await Promise.race([extraction, timeout]);
    assertFetchDeadline(options, deadlineMs, url, 'content extraction');
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeRequestUrl(rawUrl: string): NormalizedRequestUrl {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (error) {
    throw new FusionWebFetchError(
      'invalid_url',
      'fusion_web_fetch requires a valid absolute URL',
      error instanceof Error ? { cause: error } : {},
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FusionWebFetchError(
      'unsupported_scheme',
      'fusion_web_fetch supports only absolute http: and https: URLs',
      { url: rawUrl },
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new FusionWebFetchError('invalid_url', 'fusion_web_fetch URL credentials are blocked', {
      url: rawUrl,
    });
  }
  if (parsed.hostname.length === 0) {
    throw new FusionWebFetchError('invalid_url', 'fusion_web_fetch URL host is required', {
      url: rawUrl,
    });
  }

  parsed.hash = '';
  return { url: parsed, hostname: normalizeHostname(parsed.hostname) };
}

function normalizeRedirectUrl(baseUrl: URL, location: string): URL {
  let next: URL;
  try {
    next = new URL(location, baseUrl);
  } catch (error) {
    throw new FusionWebFetchError(
      'redirect_blocked',
      'fusion_web_fetch redirect target is not a valid URL',
      error instanceof Error ? { url: baseUrl.toString(), cause: error } : { url: baseUrl.toString() },
    );
  }

  try {
    return normalizeRequestUrl(next.toString()).url;
  } catch (error) {
    if (error instanceof FusionWebFetchError) {
      throw new FusionWebFetchError('redirect_blocked', `fusion_web_fetch redirect blocked: ${error.message}`, {
        url: next.toString(),
        cause: error,
      });
    }
    throw error;
  }
}

async function fetchOne(
  url: URL,
  options: EffectiveOptions,
  deadlineMs: number,
  redirectHop: boolean,
): Promise<FetchOneResult> {
  const normalized = normalizeRequestUrl(url.toString());
  const vetted = await vetHost(
    normalized.hostname,
    options,
    redirectHop,
    normalized.url.toString(),
    deadlineMs,
  );
  const remainingMs = deadlineMs - options.now();
  if (remainingMs <= 0) {
    throw new FusionWebFetchError('request_timeout', 'fusion_web_fetch request timeout elapsed', {
      url: normalized.url.toString(),
    });
  }
  return await executeRequest(normalized.url, vetted.selectedAddress, options, remainingMs);
}

async function vetHost(
  hostname: string,
  options: EffectiveOptions,
  redirectHop: boolean,
  url: string,
  deadlineMs: number,
): Promise<VettedHost> {
  if (METADATA_HOSTNAMES.has(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throwAddressError(redirectHop, `fusion_web_fetch blocked host: ${hostname}`, url);
  }

  const literalFamily = isIP(hostname);
  const literalAddress: FusionDnsAddress = { address: hostname, family: literalFamily === 4 ? 4 : 6 };
  const resolvedAddresses =
    literalFamily === 0
      ? await resolveWithLookup(hostname, options.lookup, url, deadlineMs - options.now())
      : [literalAddress];

  if (resolvedAddresses.length === 0) {
    throw new FusionWebFetchError('dns_failure', `DNS lookup returned no addresses for ${hostname}`, { url });
  }

  for (const address of resolvedAddresses) {
    const classification = classifyAddress(address.address);
    if (!classification.public && !options.allowBlockedAddressesForTests) {
      throwAddressError(
        redirectHop,
        `fusion_web_fetch blocked non-public address for ${hostname}: ${address.address}`,
        url,
      );
    }
  }

  const selectedAddress = resolvedAddresses[0];
  if (selectedAddress === undefined) {
    throw new FusionWebFetchError('dns_failure', `DNS lookup returned no addresses for ${hostname}`, { url });
  }
  return { selectedAddress, resolvedAddresses };
}

function throwAddressError(redirectHop: boolean, message: string, url: string): never {
  throw new FusionWebFetchError(redirectHop ? 'redirect_blocked' : 'blocked_address', message, { url });
}

async function resolveWithLookup(
  hostname: string,
  lookup: FusionDnsLookup,
  url: string,
  remainingMs: number,
): Promise<readonly FusionDnsAddress[]> {
  if (remainingMs <= 0) {
    throw new FusionWebFetchError('request_timeout', 'fusion_web_fetch request timeout elapsed', { url });
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new FusionWebFetchError(
                'request_timeout',
                'fusion_web_fetch request timeout elapsed during DNS lookup',
                { url },
              ),
            ),
          Math.max(1, remainingMs),
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof FusionWebFetchError) throw error;
    throw new FusionWebFetchError(
      'dns_failure',
      `DNS lookup failed for ${hostname}: ${error instanceof Error ? error.message : 'unknown error'}`,
      error instanceof Error ? { url, cause: error } : { url },
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function executeRequest(
  url: URL,
  selectedAddress: FusionDnsAddress,
  options: EffectiveOptions,
  remainingMs: number,
): Promise<FetchOneResult> {
  return new Promise<FetchOneResult>((resolve, reject) => {
    let settled = false;
    let requestSocket: { destroy: () => void } | undefined;
    let timer: NodeJS.Timeout | undefined;

    const settleResolve = (result: FetchOneResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    const settleReject = (error: FusionWebFetchError): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    };

    const request = options.request(url.protocol as 'http:' | 'https:', buildRequestOptions(url, selectedAddress, options));
    timer = setTimeout(() => {
      settleReject(new FusionWebFetchError('request_timeout', 'fusion_web_fetch request timeout elapsed', {
        url: url.toString(),
      }));
      request.destroy();
      requestSocket?.destroy();
    }, Math.max(1, remainingMs));
    request.once('socket', (socket) => {
      requestSocket = socket;
    });
    request.once('response', (response) => {
      const remoteAddress = response.socket.remoteAddress;
      if (!addressMatches(selectedAddress.address, remoteAddress)) {
        response.destroy();
        settleReject(
          new FusionWebFetchError(
            'blocked_address',
            `fusion_web_fetch socket remote address mismatch: expected ${selectedAddress.address}, got ${remoteAddress ?? 'missing'}`,
            errorDetails(url.toString(), response.statusCode),
          ),
        );
        return;
      }
      const remoteClass = classifyAddress(remoteAddress ?? '');
      if (!remoteClass.public && !options.allowBlockedAddressesForTests) {
        response.destroy();
        settleReject(
          new FusionWebFetchError(
            'blocked_address',
            'fusion_web_fetch socket remote address is blocked',
            errorDetails(url.toString(), response.statusCode),
          ),
        );
        return;
      }

      const status = response.statusCode ?? 0;
      const location = firstHeader(response, 'location');
      if (isRedirectStatus(status)) {
        // Redirect payloads are never consumed. Destroy the response/socket before
        // advancing so an endless or oversized redirect body cannot outlive this hop.
        response.destroy();
        if (location === undefined || location.trim().length === 0) {
          settleReject(
            new FusionWebFetchError('http_error', `fusion_web_fetch redirect status ${String(status)} lacks Location`, {
              url: url.toString(),
              status,
            }),
          );
          return;
        }
        settleResolve({ kind: 'redirect', status, location });
        return;
      }

      if (status < 200 || status > 299) {
        response.destroy();
        settleReject(
          new FusionWebFetchError('http_error', `fusion_web_fetch HTTP status ${String(status)}`, {
            url: url.toString(),
            status,
          }),
        );
        return;
      }

      const contentType = firstHeader(response, 'content-type') ?? '';
      const contentTypeError = unsupportedContentTypeError(contentType, url.toString(), status);
      if (contentTypeError !== undefined) {
        response.destroy();
        settleReject(contentTypeError);
        return;
      }
      let contentLength: number | undefined;
      try {
        contentLength = readContentLength(firstHeader(response, 'content-length'), url.toString(), status);
      } catch (error) {
        response.destroy();
        settleReject(
          error instanceof FusionWebFetchError
            ? error
            : new FusionWebFetchError('network_error', 'fusion_web_fetch invalid Content-Length check failed'),
        );
        return;
      }
      if (contentLength !== undefined && contentLength > options.maxResponseBytes) {
        response.destroy();
        settleReject(
          new FusionWebFetchError('response_too_large', 'fusion_web_fetch Content-Length exceeds response cap', {
            url: url.toString(),
            status,
          }),
        );
        return;
      }

      let bytesRead = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        const nextBytesRead = bytesRead + chunk.byteLength;
        if (nextBytesRead > options.maxResponseBytes) {
          response.destroy();
          settleReject(
            new FusionWebFetchError('response_too_large', 'fusion_web_fetch streamed body exceeds response cap', {
              url: url.toString(),
              status,
            }),
          );
          return;
        }
        bytesRead = nextBytesRead;
        chunks.push(chunk);
      });
      response.once('end', () => {
        settleResolve({ kind: 'success', status, contentType, body: Buffer.concat(chunks, bytesRead) });
      });
      response.once('error', (error) => {
        settleReject(mapNetworkError(error, url.toString(), status));
      });
    });
    request.once('error', (error) => {
      settleReject(mapNetworkError(error, url.toString()));
    });
    request.end();
  });
}

function buildRequestOptions(
  url: URL,
  selectedAddress: FusionDnsAddress,
  options: EffectiveOptions,
): http.RequestOptions | https.RequestOptions {
  const requestOptions: https.RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    family: selectedAddress.family,
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    agent: options.agent,
    headers: {
      Accept: ACCEPT_HEADER,
      'Accept-Encoding': 'identity',
      Host: url.host,
      'User-Agent': USER_AGENT,
    },
    lookup: forceSelectedLookup(selectedAddress),
  };
  if (url.protocol === 'https:') requestOptions.servername = normalizeHostname(url.hostname);
  if (options.createConnection !== undefined) requestOptions.createConnection = options.createConnection;
  return requestOptions;
}

function forceSelectedLookup(selectedAddress: FusionDnsAddress): NonNullable<http.RequestOptions['lookup']> {
  // Every DNS answer is vetted before this point. The request then receives a lookup hook
  // that can return only the vetted address, and the response socket is checked against it.
  // That pins the connection to the reviewed IP and closes the DNS rebinding gap from
  // validate-then-call-global-fetch implementations.
  return (_hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === 'object' && lookupOptions.all === true) {
      const allCallback = callback as (error: NodeJS.ErrnoException | null, addresses: FusionDnsAddress[]) => void;
      allCallback(null, [selectedAddress]);
      return;
    }
    callback(null, selectedAddress.address, selectedAddress.family);
  };
}

function defaultTransportRequest(
  protocol: 'http:' | 'https:',
  options: http.RequestOptions | https.RequestOptions,
): http.ClientRequest {
  return protocol === 'https:' ? https.request(options) : http.request(options);
}

async function defaultLookup(hostname: string): Promise<readonly FusionDnsAddress[]> {
  const records = await nodeLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: normalizeFamily(record.family) }));
}

function normalizeFamily(family: number): 4 | 6 {
  if (family === 4 || family === 6) return family;
  throw new Error(`Unsupported DNS address family: ${String(family)}`);
}

function firstHeader(response: http.IncomingMessage, name: string): string | undefined {
  const value = response.headers[name];
  if (Array.isArray(value)) return value.join(', ');
  return value;
}

function isRedirectStatus(status: number): boolean {
  return status === 300 || status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function mapNetworkError(error: Error, url: string, status?: number): FusionWebFetchError {
  if (error instanceof FusionWebFetchError) return error;
  return new FusionWebFetchError(
    'network_error',
    `fusion_web_fetch network error: ${error.message}`,
    errorDetails(url, status, error),
  );
}

function errorDetails(
  url: string,
  status?: number,
  cause?: Error,
): { url: string; status?: number; cause?: Error } {
  const details: { url: string; status?: number; cause?: Error } = { url };
  if (status !== undefined) details.status = status;
  if (cause !== undefined) details.cause = cause;
  return details;
}

function unsupportedContentTypeError(
  contentType: string,
  url: string,
  status: number,
): FusionWebFetchError | undefined {
  const mediaType = mediaTypeFromContentType(contentType);
  if (
    mediaType === 'text/html' ||
    mediaType === 'application/xhtml+xml' ||
    mediaType === 'text/plain' ||
    mediaType === 'text/markdown'
  ) {
    return undefined;
  }
  return new FusionWebFetchError(
    'unsupported_content_type',
    `fusion_web_fetch unsupported content type: ${contentType.length === 0 ? 'missing' : contentType}`,
    { url, status },
  );
}

function readContentLength(value: string | undefined, url: string, status: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new FusionWebFetchError('network_error', 'fusion_web_fetch invalid Content-Length header', { url, status });
  }
  return Number(trimmed);
}

async function extractContent(
  body: Buffer,
  contentType: string,
  requestedFormat: 'text' | 'markdown',
): Promise<ExtractionResult> {
  try {
    const mediaType = mediaTypeFromContentType(contentType);
    const decoded = decodeBody(body, contentType);
    if (mediaType === 'text/plain') return { content: decoded, format: 'text' };
    if (mediaType === 'text/markdown') return { content: decoded, format: 'markdown' };
    if (requestedFormat === 'text') return { content: htmlToText(decoded), format: 'text' };
    return { content: await htmlToMarkdown(decoded), format: 'markdown' };
  } catch (error) {
    if (error instanceof FusionWebFetchError) throw error;
    throw new FusionWebFetchError(
      'extraction_failed',
      `fusion_web_fetch extraction failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      error instanceof Error ? { cause: error } : {},
    );
  }
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = charsetFromContentType(contentType) ?? 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: true, ignoreBOM: false }).decode(body);
  } catch (error) {
    throw new FusionWebFetchError(
      'extraction_failed',
      `fusion_web_fetch response body could not be decoded as ${charset}`,
      error instanceof Error ? { cause: error } : {},
    );
  }
}

function mediaTypeFromContentType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function charsetFromContentType(contentType: string): string | undefined {
  for (const parameter of contentType.split(';').slice(1)) {
    const separator = parameter.indexOf('=');
    if (separator < 0) continue;
    const key = parameter.slice(0, separator).trim().toLowerCase();
    if (key !== 'charset') continue;
    const value = stripAsciiQuotes(parameter.slice(separator + 1).trim());
    if (value.length === 0) throw new FusionWebFetchError('extraction_failed', 'fusion_web_fetch charset is empty');
    return value;
  }
  return undefined;
}

function stripAsciiQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

async function htmlToMarkdown(html: string): Promise<string> {
  const TurndownServiceClass = await loadTurndownService();
  const stripped = stripUnsafeHtmlBlocks(html);
  const tables = replaceTablesWithTokens(stripped);
  const turndown = new TurndownServiceClass({ bulletListMarker: '-', codeBlockStyle: 'fenced', headingStyle: 'atx' });
  let markdown = turndown.turndown(tables.html).trim();
  for (const table of tables.replacements) {
    markdown = markdown.replace(table.token, table.markdown);
  }
  return markdown.trim();
}

async function loadTurndownService(): Promise<TurndownServiceConstructor> {
  if (turndownServiceLoad === undefined) {
    turndownServiceLoad = import('turndown').then((module) => module.default);
  }
  try {
    return await turndownServiceLoad;
  } catch (error) {
    turndownServiceLoad = undefined;
    throw normalizeTurndownLoadError(error);
  }
}

function normalizeTurndownLoadError(error: unknown): Error {
  if (isMissingTurndownDependency(error)) {
    const details = error instanceof Error ? { cause: error } : {};
    return new FusionWebFetchError(
      'extraction_failed',
      'fusion_web_fetch markdown extraction dependency "turndown" is missing from pi-background-tasks; repair the package install with `pi update --extensions` or `npm install --omit=dev --prefix <pi-background-tasks>`.',
      details,
    );
  }
  if (error instanceof Error) return error;
  return new Error(`fusion_web_fetch markdown extraction dependency failed to load: ${String(error)}`);
}

function isMissingTurndownDependency(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') return false;
  return errorMessage(error).includes('turndown');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function htmlToText(html: string): string {
  const withoutBlocks = stripUnsafeHtmlBlocks(html);
  const withBreaks = withoutBlocks
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|pre)>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  return decodeHtmlEntities(withBreaks)
    .split(/\r?\n/u)
    .map((line) => line.replace(/[\t\f\v ]+/gu, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function stripUnsafeHtmlBlocks(html: string): string {
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/giu, '');
}

function replaceTablesWithTokens(html: string): { html: string; replacements: readonly TableReplacement[] } {
  const replacements: TableReplacement[] = [];
  const replaced = html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/giu, (tableHtml) => {
    const markdown = tableToMarkdown(tableHtml);
    if (markdown.length === 0) return '';
    const token = `FUSIONWEBFETCHTABLE${String(replacements.length)}TOKEN`;
    replacements.push({ token, markdown });
    return `<p>${token}</p>`;
  });
  return { html: replaced, replacements };
}

function tableToMarkdown(tableHtml: string): string {
  const rows: string[][] = [];
  for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const rowHtml = rowMatch[1] ?? '';
    const cells = [...rowHtml.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/giu)].map((cellMatch) =>
      inlineHtmlToText(cellMatch[1] ?? ''),
    );
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => [...row, ...Array.from({ length: columnCount - row.length }, () => '')]);
  const header = normalizedRows[0] ?? [];
  const separator = Array.from({ length: columnCount }, () => '---');
  const bodyRows = normalizedRows.slice(1);
  return [header, separator, ...bodyRows].map(markdownTableRow).join('\n');
}

function markdownTableRow(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replace(/\|/gu, '\\|')).join(' | ')} |`;
}

function inlineHtmlToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/gu, ' ')).replace(/[\t\n\f\r ]+/gu, ' ').trim();
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    if (lower.startsWith('#x')) return codePointToString(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return codePointToString(Number.parseInt(lower.slice(1), 10));
    return `&${entity};`;
  });
}

function codePointToString(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return '';
  return String.fromCodePoint(value);
}

function capUtf8Bytes(content: string, maxBytes: number): { content: string; truncated: boolean } {
  let usedBytes = 0;
  let output = '';
  for (const character of content) {
    const nextBytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + nextBytes > maxBytes) return { content: output, truncated: true };
    usedBytes += nextBytes;
    output += character;
  }
  return { content, truncated: false };
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = withoutBrackets.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

function classifyAddress(address: string): { public: boolean } {
  const ipv4 = parseIpv4Address(address);
  if (ipv4 !== undefined) return { public: !IPV4_DENY_RANGES.some(([base, prefix]) => ipv4InRange(ipv4, base, prefix)) };
  const ipv6 = parseIpv6Address(address);
  if (ipv6 !== undefined) return { public: !IPV6_DENY_RANGES.some(([base, prefix]) => ipv6InRange(ipv6, base, prefix)) };
  return { public: false };
}

function addressMatches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined || actual.length === 0) return false;
  const expectedComparable = comparableAddress(expected);
  const actualComparable = comparableAddress(actual);
  return (
    expectedComparable !== undefined &&
    actualComparable !== undefined &&
    expectedComparable.family === actualComparable.family &&
    expectedComparable.value === actualComparable.value
  );
}

function comparableAddress(address: string): { family: 4 | 6; value: bigint } | undefined {
  const ipv4 = parseIpv4Address(address);
  if (ipv4 !== undefined) return { family: 4, value: BigInt(ipv4) };
  const ipv6 = parseIpv6Address(address);
  if (ipv6 === undefined) return undefined;
  const mapped = ipv4FromMappedIpv6(ipv6);
  if (mapped !== undefined) return { family: 4, value: BigInt(mapped) };
  return { family: 6, value: ipv6 };
}

function parseIpv4Address(address: string): number | undefined {
  const pieces = address.split('.');
  if (pieces.length !== 4) return undefined;
  let value = 0;
  for (const piece of pieces) {
    if (!/^\d{1,3}$/u.test(piece)) return undefined;
    const octet = Number(piece);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function ipv4ToNumberLiteral(address: string): number {
  const parsed = parseIpv4Address(address);
  if (parsed === undefined) throw new Error(`Invalid IPv4 literal in source: ${address}`);
  return parsed;
}

function parseIpv6Address(address: string): bigint | undefined {
  if (address.includes('%')) return undefined;
  const rawSides = address.toLowerCase().split('::');
  if (rawSides.length > 2) return undefined;
  const left = parseIpv6Side(rawSides[0] ?? '');
  const right = parseIpv6Side(rawSides[1] ?? '');
  if (left === undefined || right === undefined) return undefined;
  const compressed = rawSides.length === 2;
  const missing = 8 - left.length - right.length;
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return undefined;
  const hextets = compressed ? [...left, ...Array.from({ length: missing }, () => 0), ...right] : left;
  if (hextets.length !== 8) return undefined;
  return hextets.reduce((value, hextet) => (value << 16n) + BigInt(hextet), 0n);
}

function parseIpv6Side(side: string): number[] | undefined {
  if (side.length === 0) return [];
  const parts = side.split(':');
  const hextets: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.includes('.')) {
      if (index !== parts.length - 1) return undefined;
      const ipv4 = parseIpv4Address(part);
      if (ipv4 === undefined) return undefined;
      hextets.push(Math.floor(ipv4 / 0x10000), ipv4 % 0x10000);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined;
    hextets.push(Number.parseInt(part, 16));
  }
  return hextets;
}

function ipv6ToBigIntLiteral(address: string): bigint {
  const parsed = parseIpv6Address(address);
  if (parsed === undefined) throw new Error(`Invalid IPv6 literal in source: ${address}`);
  return parsed;
}

function ipv4FromMappedIpv6(address: bigint): number | undefined {
  const mappedPrefix = ipv6ToBigIntLiteral('::ffff:0:0');
  if (!ipv6InRange(address, mappedPrefix, 96)) return undefined;
  return Number(address & 0xffffffffn);
}

function ipv4InRange(address: number, base: number, prefix: number): boolean {
  const divisor = 2 ** (32 - prefix);
  return Math.floor(address / divisor) === Math.floor(base / divisor);
}

function ipv6InRange(address: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return address >> shift === base >> shift;
}
