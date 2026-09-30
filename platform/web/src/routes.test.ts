import { matchRoutes, type RouteObject } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { APP_ROUTES } from './routes';

/** The same tree App.tsx renders: full-screen routes, then the shell's routes and its catch-all. */
const TREE: RouteObject[] = [
  ...APP_ROUTES.filter((r) => !r.shell).map((r) => ({ path: r.path })),
  { children: [...APP_ROUTES.filter((r) => r.shell).map((r) => ({ path: r.path })), { path: '*' }] },
];

function matched(path: string): string | undefined {
  return matchRoutes(TREE, path)?.at(-1)?.route.path;
}

describe('routes', () => {
  it('has the two new screens, both for signed-in users', () => {
    expect(matched('/welcome')).toBe('/welcome');
    expect(matched('/bids/pickup')).toBe('/bids/pickup');
    const access = Object.fromEntries(APP_ROUTES.map((r) => [r.path, r.access]));
    expect(access['/welcome']).toBe('account');
    expect(access['/bids/pickup']).toBe('account');
    expect(APP_ROUTES.find((r) => r.path === '/welcome')?.shell).toBe(false);
  });

  it('keeps the catalogue public', () => {
    expect(APP_ROUTES.filter((r) => r.access === 'public').map((r) => r.path)).toEqual(['/signin', '/auth/callback', '/', '/lot/:id']);
  });
});

// ------------------------------------------------------------------ the name

/** Every file the app is built from (tests excluded: they spell out what is forbidden). */
const APP_FILES = import.meta.glob(['./**/*.{ts,tsx,css}', '!./**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** What ships beside the bundle, and the docs that describe the app. */
const SHIPPED_FILES = import.meta.glob(['../index.html', '../public/manifest.webmanifest', '../public/**/*.svg', '../README.md', '../scripts/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Copy that would explain the name, or point at a page that did. */
const FORBIDDEN: readonly [string, RegExp][] = [
  ['the old link', /what does skeuos mean/i],
  ['the old profile button', /about the name/i],
  ['the Greek word', /σκεῦος/],
  ['vessels', /\bvessels?\b/i],
  ['jars', /\bjars?\b/i],
  ['clay', /\bclay\b/i],
  ['its source', /new testament|greek word|2 timothy/i],
  ['an /about route or link', /["'`(]\/about\b/],
  ['the About page', /AboutPage/],
  ['the old badge', /treasure in plain sight/i],
];

describe('the app never explains its name', () => {
  it('has no /about route: it falls through to "not found"', () => {
    expect(APP_ROUTES.some((r) => /about/i.test(r.path))).toBe(false);
    expect(matched('/about')).toBe('*');
  });

  it('has no About page', () => {
    const pages = Object.keys(import.meta.glob('./pages/*.tsx'));
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.some((p) => /about/i.test(p))).toBe(false);
  });

  it('carries no copy about vessels, jars, clay or what "Skeuos" means', () => {
    const files = { ...APP_FILES, ...SHIPPED_FILES };
    expect(Object.keys(APP_FILES).length).toBeGreaterThan(40);
    expect(Object.keys(SHIPPED_FILES)).toEqual(expect.arrayContaining(['../index.html', '../README.md', '../public/manifest.webmanifest']));
    const hits: string[] = [];
    for (const [file, text] of Object.entries(files)) {
      for (const [what, pattern] of FORBIDDEN) if (pattern.test(text)) hits.push(`${file}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  it('still says the name where it belongs: the wordmark and plain sentences', () => {
    expect(APP_FILES['./components/Logo.tsx']).toContain('<span>Skeuos</span>');
    expect(APP_FILES['./pages/SignInPage.tsx']).toContain('Skeuos never bids for you.');
  });
});
