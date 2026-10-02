/**
 * The build environment is not public, but anything Vite inlines is. Vite
 * replaces `import.meta.env.VITE_X` with that one value; the env object used
 * whole becomes an object holding every VITE_ variable on the build host. On
 * Vercel that included the old app's VITE_ANTHROPIC_KEY, which shipped in this
 * app's bundle until 2026-10-01. Every read must name its variable.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** `import.meta.env` not followed by a property access. */
const WHOLE_ENV = /import\.meta\.env(?![.\w])/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('build env exposure', () => {
  it('reads every env variable by name, never the env object whole', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => WHOLE_ENV.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('catches the pattern it guards against', () => {
    expect(WHOLE_ENV.test(withoutComments('readConfig(env = import.meta.env)'))).toBe(true);
    expect(WHOLE_ENV.test(withoutComments('const u = import.meta.env.VITE_SUPABASE_URL;'))).toBe(false);
    expect(WHOLE_ENV.test(withoutComments('// the env object, import.meta.env, used whole'))).toBe(false);
  });
});
