/**
 * The crawler's identity and its one HTTP primitive.
 *
 * IDENTITY. Every request says who we are and where to read about us, and
 * nothing else. It carries no personal contact details: an earlier probe
 * function sent a User-Agent containing the owner's personal email address to
 * four third-party sites. That was a privacy leak and is fixed here, and a test
 * guards the constant so it cannot quietly return.
 *
 * HONESTY. We never send a browser User-Agent, never impersonate a browser TLS
 * fingerprint, and never retry a refusal with a disguise. A site that refuses
 * this identity has answered, and the answer is recorded, not worked around
 * (docs/08-platform-access.md §1).
 */

/** The robots.txt product token. Letters only, as RFC 9309 requires of tokens. */
export const CRAWLER_TOKEN = 'WaystockBot';

/**
 * Full User-Agent. The URL is the project's own domain; the page there must
 * describe the crawler and how to opt out.
 */
export const CRAWLER_UA = `${CRAWLER_TOKEN}/0.1 (+https://waystock.org/bot)`;

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number; // 0 = network error or timeout
  headers: Record<string, string>;
  body: string;
  bytes: number;
  truncated: boolean;
  latencyMs: number;
  error: string | null;
}

export interface PoliteFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Stop reading after this many bytes. Probes only need the head of a page. */
  maxBytes?: number;
}

/**
 * Fetch with our identity, a timeout, and a byte cap. Never throws: a network
 * failure comes back as status 0 with the error text, so a probe of 46 sites
 * cannot be aborted by one dead host.
 */
export async function politeFetch(url: string, opts: PoliteFetchOptions = {}): Promise<FetchResult> {
  const started = Date.now();
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const headers: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    ...(opts.headers ?? {}),
    // Last, so no caller can override the identity.
    'User-Agent': CRAWLER_UA,
  };

  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });

    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k.toLowerCase()] = v;
    });

    let bytes = 0;
    let truncated = false;
    const chunks: Uint8Array[] = [];
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          // Cap exactly, not per network chunk: one chunk can be megabytes.
          const room = maxBytes - bytes;
          if (value.byteLength > room) {
            chunks.push(value.subarray(0, room));
            bytes += room;
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
          bytes += value.byteLength;
        }
      }
    }
    const buf = new Uint8Array(bytes);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }

    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      headers: outHeaders,
      body: new TextDecoder('utf-8', { fatal: false }).decode(buf),
      bytes,
      truncated,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (e) {
    return {
      url,
      finalUrl: url,
      status: 0,
      headers: {},
      body: '',
      bytes: 0,
      truncated: false,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}
