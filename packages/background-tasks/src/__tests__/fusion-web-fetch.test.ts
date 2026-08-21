import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import {
  FUSION_WEB_FETCH_MAX_REDIRECTS,
  FUSION_WEB_FETCH_MAX_RESPONSE_BYTES,
  FUSION_WEB_FETCH_MAX_OUTPUT_BYTES,
  FUSION_WEB_FETCH_TIMEOUT_MS,
  FusionWebFetchError,
  type FusionWebFetchErrorCode,
  type FusionWebFetchOptions,
  fusionWebFetch,
} from '../fusion/web-fetch.js';

type RouteHandler = (request: http.IncomingMessage, response: http.ServerResponse) => void;

async function withServer<T>(routes: Record<string, RouteHandler>, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = http.createServer((request, response) => {
    const path = request.url?.split('?')[0] ?? '/';
    const handler = routes[path];
    if (handler === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing route');
      return;
    }
    handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    return await run(`http://public.test:${String((address as AddressInfo).port)}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
  }
}

function localOptions(extra: FusionWebFetchOptions = {}): FusionWebFetchOptions {
  return {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    allowBlockedAddressesForTests: true,
    ...extra,
  };
}

async function expectError(
  promise: Promise<unknown>,
  code: FusionWebFetchErrorCode,
): Promise<FusionWebFetchError> {
  let captured: FusionWebFetchError | undefined;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FusionWebFetchError);
    assert.equal(error.code, code);
    captured = error;
    return true;
  });
  assert.ok(captured !== undefined);
  return captured;
}

void describe('fusion_web_fetch core', () => {
  void it('pins the expanded research fetch envelope', () => {
    assert.equal(FUSION_WEB_FETCH_TIMEOUT_MS, 90_000);
    assert.equal(FUSION_WEB_FETCH_MAX_RESPONSE_BYTES, 4 * 1024 * 1024);
    assert.equal(FUSION_WEB_FETCH_MAX_OUTPUT_BYTES, 32 * 1024);
    assert.equal(FUSION_WEB_FETCH_MAX_REDIRECTS, 5);
  });

  void it('rejects unsupported schemes before network access', async () => {
    let lookupCalls = 0;
    await expectError(
      fusionWebFetch({ url: 'file:///tmp/page.html' }, { lookup: async () => {
        lookupCalls += 1;
        return [{ address: '93.184.216.34', family: 4 }];
      } }),
      'unsupported_scheme',
    );
    assert.equal(lookupCalls, 0);
  });

  void it('rejects URL credentials before network access', async () => {
    let lookupCalls = 0;
    await expectError(
      fusionWebFetch({ url: 'https://user:pass@example.com/' }, { lookup: async () => {
        lookupCalls += 1;
        return [{ address: '93.184.216.34', family: 4 }];
      } }),
      'invalid_url',
    );
    assert.equal(lookupCalls, 0);
  });

  void it('rejects blocked address classes from DNS answers', async () => {
    const blocked = [
      { address: '127.0.0.1', family: 4 },
      { address: '169.254.1.2', family: 4 },
      { address: '169.254.169.254', family: 4 },
      { address: '::ffff:127.0.0.1', family: 6 },
      { address: '64:ff9b::a00:1', family: 6 },
      { address: '64:ff9b:1::a00:1', family: 6 },
      { address: 'fe80::1', family: 6 },
      { address: 'fc00::1', family: 6 },
      { address: 'ff02::1', family: 6 },
    ] as const;

    for (const address of blocked) {
      await expectError(
        fusionWebFetch({ url: 'http://public.test/' }, { lookup: async () => [address] }),
        'blocked_address',
      );
    }
  });

  void it('consults the resolver exactly once and pins the connection to that vetted address', async () => {
    // DNS-rebinding defence, expressed as the property that actually holds.
    //
    // Validating resolver answers is not sufficient on its own: a name can resolve again
    // between validation and connect, so the socket could land somewhere never vetted. That
    // is the window left open by implementations that validate and then delegate to global
    // fetch, which re-resolves internally. Here the vetted address is captured once and the
    // per-request lookup hook can return only that address, so a second resolver answer can
    // never influence where the socket terminates. The post-connect socket check is then
    // defence in depth rather than the primary control.
    //
    // A rebinding attempt is simulated by a resolver that would hand back loopback on every
    // call after the first. If the implementation re-queried at connect time, the request
    // would reach the loopback server and this assertion on the call count would fail.
    let calls = 0;
    await withServer(
      {
        '/': (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('should never be reached');
        },
      },
      async (baseUrl) => {
        const rebindingLookup = async () => {
          calls += 1;
          return calls === 1
            ? [{ address: '127.0.0.1', family: 4 as const }]
            : [{ address: '10.0.0.1', family: 4 as const }];
        };
        const result = await fusionWebFetch(
          { url: `${baseUrl}/` },
          { lookup: rebindingLookup, allowBlockedAddressesForTests: true },
        );
        assert.equal(result.status, 200);
      },
    );
    assert.equal(calls, 1, 'the resolver must be consulted once; the vetted address is then pinned');
  });

  void it('rejects a DNS result that mixes public and blocked answers', async () => {
    await expectError(
      fusionWebFetch({ url: 'http://public.test/' }, {
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
      }),
      'blocked_address',
    );
  });

  void it('follows a redirect chain', async () => {
    await withServer(
      {
        '/start': (_request, response) => {
          response.writeHead(302, { location: '/middle' });
          response.end();
        },
        '/middle': (_request, response) => {
          response.writeHead(301, { location: '/final' });
          response.end();
        },
        '/final': (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('done');
        },
      },
      async (baseUrl) => {
        const result = await fusionWebFetch({ url: `${baseUrl}/start` }, localOptions());
        assert.equal(result.final_url, `${baseUrl}/final`);
        assert.equal(result.status, 200);
        assert.equal(result.content, 'done');
      },
    );
  });

  void it('destroys redirect responses without consuming unbounded bodies', async () => {
    let redirectClosed = false;
    await withServer(
      {
        '/start': (_request, response) => {
          const interval = setInterval(() => response.write('unbounded redirect body'), 5);
          response.once('close', () => {
            redirectClosed = true;
            clearInterval(interval);
          });
          response.writeHead(302, { location: '/final', 'content-type': 'text/plain' });
          response.flushHeaders();
        },
        '/final': (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('done');
        },
      },
      async (baseUrl) => {
        const result = await fusionWebFetch({ url: `${baseUrl}/start` }, localOptions());
        assert.equal(result.content, 'done');
      },
    );
    assert.equal(redirectClosed, true);
  });

  void it('rejects a redirect to a blocked host', async () => {
    await withServer(
      {
        '/start': (_request, response) => {
          response.writeHead(302, { location: 'http://localhost/final' });
          response.end();
        },
      },
      async (baseUrl) => {
        await expectError(fusionWebFetch({ url: `${baseUrl}/start` }, localOptions()), 'redirect_blocked');
      },
    );
  });

  void it('rejects a redirect loop at the configured limit', async () => {
    await withServer(
      {
        '/loop': (_request, response) => {
          response.writeHead(302, { location: '/loop' });
          response.end();
        },
      },
      async (baseUrl) => {
        await expectError(
          fusionWebFetch({ url: `${baseUrl}/loop` }, localOptions({ maxRedirects: 2 })),
          'redirect_limit',
        );
      },
    );
    assert.equal(FUSION_WEB_FETCH_MAX_REDIRECTS, 5);
  });

  void it('rejects an oversized Content-Length before reading body bytes', async () => {
    let bodyWriteCount = 0;
    await withServer(
      {
        '/large': (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' });
          response.flushHeaders();
          setTimeout(() => {
            bodyWriteCount += 1;
            response.end('0123456789');
          }, 50);
        },
      },
      async (baseUrl) => {
        await expectError(
          fusionWebFetch({ url: `${baseUrl}/large` }, localOptions({ maxResponseBytes: 5 })),
          'response_too_large',
        );
      },
    );
    assert.equal(bodyWriteCount, 0);
  });

  void it('aborts loudly when a streamed body crosses the response cap', async () => {
    await withServer(
      {
        '/stream': (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.write('12345');
          response.end('67890');
        },
      },
      async (baseUrl) => {
        await expectError(
          fusionWebFetch({ url: `${baseUrl}/stream` }, localOptions({ maxResponseBytes: 8 })),
          'response_too_large',
        );
      },
    );
  });

  void it('rejects unsupported content types', async () => {
    await withServer(
      {
        '/json': (_request, response) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"ok":true}');
        },
      },
      async (baseUrl) => {
        await expectError(fusionWebFetch({ url: `${baseUrl}/json` }, localOptions()), 'unsupported_content_type');
      },
    );
  });

  void it('converts HTML to markdown with links, headings, tables, and code blocks', async () => {
    const html = `<!doctype html><html><body>
      <h1>Title</h1>
      <p>Visit <a href="https://example.com/docs">docs</a>.</p>
      <table><tr><th>Name</th><th>Value</th></tr><tr><td>alpha</td><td>one</td></tr></table>
      <pre><code>const x = 1;</code></pre>
    </body></html>`;
    await withServer(
      {
        '/html': (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(html);
        },
      },
      async (baseUrl) => {
        const result = await fusionWebFetch({ url: `${baseUrl}/html` }, localOptions());
        assert.equal(result.format, 'markdown');
        assert.match(result.content, /# Title/u);
        assert.match(result.content, /\[docs\]\(https:\/\/example\.com\/docs\)/u);
        assert.match(result.content, /\| Name \| Value \|/u);
        assert.match(result.content, /\| alpha \| one \|/u);
        assert.match(result.content, /```/u);
        assert.match(result.content, /const x = 1;/u);
      },
    );
  });

  void it('strips script and style content before extraction', async () => {
    await withServer(
      {
        '/html': (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<h1>Keep</h1><script>secret()</script><style>.secret{}</style><noscript>hidden</noscript>');
        },
      },
      async (baseUrl) => {
        const result = await fusionWebFetch({ url: `${baseUrl}/html` }, localOptions());
        assert.match(result.content, /Keep/u);
        assert.doesNotMatch(result.content, /secret|hidden/u);
      },
    );
  });

  void it('passes text/plain through and reports hash and byte count', async () => {
    const body = 'plain\ntext & symbols';
    await withServer(
      {
        '/plain': (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          response.end(body);
        },
      },
      async (baseUrl) => {
        const result = await fusionWebFetch({ url: `${baseUrl}/plain`, extract: 'markdown' }, localOptions());
        assert.equal(result.format, 'text');
        assert.equal(result.content, body);
        assert.equal(result.response_bytes, Buffer.byteLength(body));
        assert.equal(result.content_sha256, createHash('sha256').update(body).digest('hex'));
      },
    );
  });

  void it('caps output without splitting UTF-8 characters', async () => {
    await withServer(
      {
        '/emoji': (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('😀😀😀');
        },
      },
      async (baseUrl) => {
        const result = await fusionWebFetch({ url: `${baseUrl}/emoji` }, localOptions({ maxOutputBytes: 5 }));
        assert.equal(result.truncated, true);
        assert.equal(result.content, '😀');
        assert.equal(Buffer.byteLength(result.content), 4);
      },
    );
  });

  void it('includes content extraction inside the fetch deadline', async () => {
    await withServer(
      {
        '/slow-extraction': (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<h1>ready</h1>');
        },
      },
      async (baseUrl) => {
        const start = Date.now();
        await expectError(
          fusionWebFetch(
            { url: `${baseUrl}/slow-extraction` },
            localOptions({
              timeoutMs: 20,
              extractContent: async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
                return { content: 'late extraction', format: 'markdown' };
              },
            }),
          ),
          'request_timeout',
        );
        assert.ok(Date.now() - start < 90, 'extraction must be raced against remaining deadline');
      },
    );
  });

  void it('includes DNS resolution inside the fetch deadline', async () => {
    const start = Date.now();
    await expectError(
      fusionWebFetch(
        { url: 'https://dns-stall.test/' },
        { lookup: () => new Promise(() => undefined), timeoutMs: 20 },
      ),
      'request_timeout',
    );
    assert.ok(Date.now() - start < 500, 'stalled DNS must be bounded by the request deadline');
  });

  void it('subtracts delayed successful DNS time from the HTTP deadline', async () => {
    await withServer(
      {
        '/slow-after-dns': (_request, response) => {
          setTimeout(() => {
            response.writeHead(200, { 'content-type': 'text/plain' });
            response.end('too late');
          }, 40);
        },
      },
      async (baseUrl) => {
        await expectError(
          fusionWebFetch(
            { url: `${baseUrl}/slow-after-dns` },
            {
              lookup: async () => {
                await new Promise((resolve) => setTimeout(resolve, 30));
                return [{ address: '127.0.0.1', family: 4 }];
              },
              allowBlockedAddressesForTests: true,
              timeoutMs: 50,
            },
          ),
          'request_timeout',
        );
      },
    );
  });

  void it('fails with a typed timeout', async () => {
    await withServer(
      {
        '/slow': (_request, response) => {
          setTimeout(() => {
            response.writeHead(200, { 'content-type': 'text/plain' });
            response.end('late');
          }, 100);
        },
      },
      async (baseUrl) => {
        await expectError(
          fusionWebFetch({ url: `${baseUrl}/slow` }, localOptions({ timeoutMs: 20 })),
          'request_timeout',
        );
      },
    );
  });
});
