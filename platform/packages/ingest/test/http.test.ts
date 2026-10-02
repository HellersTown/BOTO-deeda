import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CRAWLER_UA, CRAWLER_TOKEN, politeFetch } from '../src/http.ts';

test('the crawler identity carries no personal contact details', () => {
  // Regression guard: an earlier probe sent the owner's personal email address
  // to third-party sites inside its User-Agent.
  assert.doesNotMatch(CRAWLER_UA, /@/);
  assert.doesNotMatch(CRAWLER_UA, /mailto:/i);
  assert.match(CRAWLER_UA, /^WaystockBot\/\d+\.\d+ \(\+https:\/\/[^)]+\)$/);
  // RFC 9309: product tokens are letters, underscores and hyphens only.
  assert.match(CRAWLER_TOKEN, /^[A-Za-z_-]+$/);
});

function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('politeFetch sends our identity and callers cannot override it', async () => {
  const { server, base } = await serve((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end(String(req.headers['user-agent']));
  });
  try {
    const r = await politeFetch(`${base}/`, { headers: { 'User-Agent': 'Mozilla/5.0 (disguise)' } });
    assert.equal(r.status, 200);
    assert.equal(r.body, CRAWLER_UA);
    assert.equal(r.headers['content-type'], 'text/plain');
    assert.equal(r.error, null);
  } finally {
    server.close();
  }
});

test('politeFetch stops reading at the byte cap', async () => {
  const { server, base } = await serve((_req, res) => {
    res.end('x'.repeat(50_000));
  });
  try {
    const r = await politeFetch(`${base}/big`, { maxBytes: 10_000 });
    assert.equal(r.truncated, true);
    assert.equal(r.bytes, 10_000);
    assert.equal(r.body.length, 10_000);
  } finally {
    server.close();
  }
});

test('politeFetch never throws: timeouts and dead hosts come back as status 0', async () => {
  const { server, base } = await serve(() => {
    /* never respond */
  });
  try {
    const slow = await politeFetch(`${base}/hang`, { timeoutMs: 200 });
    assert.equal(slow.status, 0);
    assert.match(slow.error ?? '', /timeout|abort/i);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  const dead = await politeFetch('http://127.0.0.1:1/', { timeoutMs: 2000 });
  assert.equal(dead.status, 0);
  assert.ok(dead.error);
});
