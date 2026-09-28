import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-ignore -- plain .mjs module
import { FUNCTION_LIBS, HEADER } from '../../../scripts/sync-function-libs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const platform = join(here, '..', '..', '..');

test('every Edge Function lib copy is identical to its tested source', () => {
  // A deployed function runs the lib/ copy, not packages/ingest/src. If the two
  // drift, the tests here would pass while production ran something else, which
  // is the same false confidence that let the GSA adapter return zero lots.
  for (const [fn, files] of Object.entries(FUNCTION_LIBS as Record<string, string[]>)) {
    for (const f of files) {
      const copy = join(platform, 'supabase/functions', fn, 'lib', f);
      assert.ok(existsSync(copy), `${fn}/lib/${f} missing: run node platform/scripts/sync-function-libs.mjs`);
      const expected = HEADER(f) + readFileSync(join(platform, 'packages/ingest/src', f), 'utf8');
      assert.equal(readFileSync(copy, 'utf8'), expected, `${fn}/lib/${f} has drifted from its source`);
    }
  }
});
