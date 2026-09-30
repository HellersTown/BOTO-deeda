import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The two engines are sibling zero-dependency packages, imported from source.
 * They use `.ts` import specifiers, which Vite resolves natively; the matching
 * TypeScript `paths` live in tsconfig.app.json.
 */
const engineAliases = {
  '@platform/strategy': here('../packages/strategy/src/index.ts'),
  '@platform/query': here('../packages/query/src/index.ts'),
};

/**
 * Emits /sw.js from the hand-written worker in sw/service-worker.js, with the
 * build's file list and a build id injected. The worker precaches exactly the
 * files this build produced (the app shell), so an installed app can launch
 * offline, and a new deploy gets a new cache name. API responses are never
 * cached: see the worker itself.
 */
function serviceWorker(): Plugin {
  return {
    name: 'skeuos-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle)
        .filter((file) => !file.endsWith('.map'))
        .map((file) => `/${file}`);
      const icons = readdirSync(here('./public/icons')).map((file) => `/icons/${file}`);
      const shell = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', ...icons, ...built];
      const precache = [...new Set(shell)].sort();
      const buildId = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      const source = readFileSync(here('./sw/service-worker.js'), 'utf8')
        .replace("'__SKEUOS_BUILD__'", JSON.stringify(buildId))
        .replace("'__SKEUOS_PRECACHE__'", JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  resolve: { alias: engineAliases },
  server: {
    // The engine packages live outside this directory.
    fs: { allow: [here('.'), here('../packages')] },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Stable vendor and engine chunks cache across deploys. All are static
        // imports, so no lazily loaded chunk can go missing after a deploy.
        manualChunks(id: string): string | undefined {
          if (id.includes('/packages/strategy/')) return 'engine-strategy';
          if (id.includes('/packages/query/')) return 'engine-query';
          if (id.includes('/node_modules/@supabase/')) return 'supabase';
          if (/\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    // .test.tsx files render components to static markup (react-dom/server), so node is enough.
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
