import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const platform = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The sources.platform keys a crawl-* function serves: the object it hands serveWorker(). */
function served(fn: string): string[] {
  const src = readFileSync(join(platform, 'supabase/functions', fn, 'index.ts'), 'utf8');
  const body = /serveWorker\('[^']+',\s*\{([\s\S]*?)\}\);/.exec(src)?.[1] ?? '';
  return [...body.matchAll(/^\s*(?:'([^']+)'|([A-Za-z0-9_]+))\s*:/gm)].map((m) => (m[1] ?? m[2])!).sort();
}

test('each crawler cron gate (0068) names exactly the platforms its worker serves', () => {
  // A platform a worker serves but its gate omits would never wake the worker for that platform's sources.
  const dir = join(platform, 'supabase/migrations');
  const sql = readdirSync(dir).sort().map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  for (const fn of ['crawl-worker', 'crawl-public', 'crawl-private']) {
    const calls = [...sql.matchAll(new RegExp(`invoke_crawler_if_due\\('${fn}',\\s*array\\[([^\\]]*)\\]`, 'g'))];
    assert.ok(calls.length > 0, `no cron gate for ${fn}`);
    const gated = [...calls[calls.length - 1]![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
    assert.ok(served(fn).length > 0, `${fn}: no adapters found in index.ts`);
    assert.deepEqual(gated, served(fn), `${fn}: the cron gate and the worker's adapters differ`);
  }
});
