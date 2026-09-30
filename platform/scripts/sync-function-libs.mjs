#!/usr/bin/env node
// Copy the shared ingest code into each Edge Function's lib/ folder.
//
// Edge Functions are deployed as self-contained bundles, so each one carries its
// own copy of the code it imports. The single source of truth stays
// packages/ingest/src, where it is unit-tested; these copies are generated, and
// packages/ingest/test/function-libs.test.ts fails if any copy drifts from its
// source. Run after changing anything in packages/ingest/src:
//
//   node platform/scripts/sync-function-libs.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/ingest/src');
const fns = join(root, 'supabase/functions');

export const FUNCTION_LIBS = {
  'probe-sources': ['http.ts', 'robots.ts', 'probe.ts', 'jsonld.ts', 'money.ts', 'types.ts'],
  'crawl-worker': ['http.ts', 'types.ts', 'money.ts', 'jsonld.ts', 'robots.ts', 'probe.ts', 'gate.ts', 'adapters/gsa.ts'],
  'load-gazetteer': ['http.ts'],
  'inspect-page': ['http.ts', 'robots.ts', 'probe.ts', 'jsonld.ts', 'money.ts', 'types.ts'],
};

export const HEADER = (file) =>
  `// GENERATED from packages/ingest/src/${file} by scripts/sync-function-libs.mjs. Do not edit here.\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [fn, files] of Object.entries(FUNCTION_LIBS)) {
    for (const f of files) {
      const out = join(fns, fn, 'lib', f);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, HEADER(f) + readFileSync(join(src, f), 'utf8'));
    }
    console.log(`${fn}: ${files.length} files`);
  }
}
