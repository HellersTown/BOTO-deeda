import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLookContent,
  buildLookSystem,
  lookSchema,
  parseLooks,
  photoFetcher,
  photosFor,
  sniffImageType,
  toBase64,
  type LookConcept,
  type LookLot,
  type LookPhoto,
} from '../src/look.ts';

const CONCEPTS: LookConcept[] = [
  { id: 'furniture', label: 'Furniture', parent: null },
  { id: 'storage-furniture', label: 'Dressers, cabinets & shelves', parent: 'furniture' },
  { id: 'bookcases', label: 'Bookcases', parent: 'storage-furniture' },
  { id: 'chairs', label: 'Chairs', parent: 'furniture' },
  { id: 'hand-tools', label: 'Hand tools', parent: null },
];
const IDS = CONCEPTS.map((c) => c.id);

const lot = (id: string, title: string, titleKinds: string[] = [], imageUrls = [`https://cdn.example/${id}/0.jpg`, `https://cdn.example/${id}/1.jpg`]): LookLot => ({
  id,
  title,
  description: null,
  imageUrls,
  titleKinds,
});
const photo = (url: string): LookPhoto => ({ url, mediaType: 'image/jpeg', base64: '/9j/' });

test('one photo when the title names a kind, two when the photos must say it all', () => {
  assert.deepEqual(photosFor(lot('a', 'Oak bookcase', ['bookcases'])), ['https://cdn.example/a/0.jpg']);
  assert.deepEqual(photosFor(lot('b', 'Lot 19')), ['https://cdn.example/b/0.jpg', 'https://cdn.example/b/1.jpg']);
  assert.deepEqual(photosFor(lot('c', 'Lot 20', [], ['data:image/png;base64,xx', 'https://cdn.example/c/1.jpg'])), [
    'https://cdn.example/c/1.jpg',
  ]);
});

test('the instructions list every kind under its parent, the same way every time', () => {
  const system = buildLookSystem(CONCEPTS);
  assert.match(system, /\nfurniture: Furniture\n  chairs: Chairs\n  storage-furniture: Dressers, cabinets & shelves\n    bookcases: Bookcases\nhand-tools: Hand tools$/);
  assert.equal(buildLookSystem([...CONCEPTS].reverse()), system, 'order of the input does not change the cached prompt');
  // A concept whose parent is missing still appears, as a root.
  assert.match(buildLookSystem([{ id: 'lathes', label: 'Lathes', parent: 'machine-tools' }]), /\nlathes: Lathes$/);
});

test('the answer schema limits kinds to the vocabulary and requires every field', () => {
  const schema = lookSchema(IDS) as any;
  assert.deepEqual(schema.$defs.kind.enum, IDS);
  const item = schema.properties.lots.items;
  assert.deepEqual(item.properties.kinds.items, { $ref: '#/$defs/kind' });
  assert.deepEqual(item.properties.main.anyOf, [{ $ref: '#/$defs/kind' }, { type: 'null' }]);
  assert.deepEqual(item.properties.confidence.enum, ['high', 'medium', 'low']);
  assert.deepEqual(item.required, ['lot', 'kinds', 'main', 'caption', 'brand', 'model', 'agrees', 'confidence']);
  assert.equal(item.additionalProperties, false);
});

test('the message numbers each lot, carries its photos, and leaves out a lot without any', () => {
  const lots = [lot('a', 'Lot 19'), lot('b', 'Oak bookcase', ['bookcases']), lot('c', 'Chairs', ['chairs'])];
  const photos = new Map([
    ['a', [photo('https://cdn.example/a/0.jpg'), photo('https://cdn.example/a/1.jpg')]],
    ['c', [photo('https://cdn.example/c/0.jpg')]],
  ]);
  const blocks = buildLookContent(lots, photos);
  assert.deepEqual(
    blocks.map((b) => (b.type === 'text' ? b.text.split('\n')[0] : 'image')),
    ['Lot 1', 'image', 'image', 'Lot 3', 'image', 'Answer for every lot above, by its number.'],
  );
  assert.match((blocks[0] as { text: string }).text, /Title: Lot 19\nDescription: \(none\)\nIts 2 photos:/);
  assert.deepEqual(buildLookContent(lots, new Map()), []);
});

test('a description is cut at a word, so the message stays small', () => {
  const long = { ...lot('a', 'Lot'), description: `${'word '.repeat(200)}end` };
  const [first] = buildLookContent([long], new Map([['a', [photo('x')]]]));
  const text = (first as { text: string }).text;
  assert.ok(text.length < 500);
  assert.match(text, /word…\nIts photo:/);
});

test('the answer becomes rows, checked against what was sent and the vocabulary', () => {
  const lots = [lot('a', 'Furniture'), lot('b', 'Lot 19'), lot('c', 'Chairs', ['chairs'])];
  const photos = new Map([
    ['a', [photo('https://cdn.example/a/0.jpg')]],
    ['b', [photo('https://cdn.example/b/0.jpg'), photo('https://cdn.example/b/1.jpg')]],
  ]);
  const answer = JSON.stringify({
    lots: [
      { lot: 1, kinds: ['chairs'], main: 'bookcases', caption: '  Oak bookcase,\nfive shelves ', brand: null, model: null, agrees: false, confidence: 'high' },
      { lot: 2, kinds: ['hand-tools', 'sockets', 'hand-tools'], main: null, caption: 'Tote of hand tools', brand: 'Craftsman', model: '', agrees: null, confidence: 'certain' },
      { lot: 1, kinds: [], main: null, caption: 'second answer', brand: null, model: null, agrees: null, confidence: 'low' },
      { lot: 3, kinds: ['chairs'], main: 'chairs', caption: 'not sent', brand: null, model: null, agrees: true, confidence: 'high' },
      { lot: 9, kinds: [], main: null, caption: '', brand: null, model: null, agrees: null, confidence: 'low' },
    ],
  });
  const { rows, problems } = parseLooks(answer, lots, photos, IDS, 'claude-opus-5-5');
  assert.deepEqual(rows, [
    {
      lot_id: 'a',
      kinds: ['bookcases', 'chairs'],
      main_kind: 'bookcases',
      caption: 'Oak bookcase, five shelves',
      brand: null,
      model_number: null,
      title_agrees: false,
      confidence: 'high',
      image_urls: ['https://cdn.example/a/0.jpg'],
      model: 'claude-opus-5-5',
    },
    {
      lot_id: 'b',
      kinds: ['hand-tools'],
      main_kind: null,
      caption: 'Tote of hand tools',
      brand: 'Craftsman',
      model_number: null,
      title_agrees: null,
      confidence: 'low',
      image_urls: ['https://cdn.example/b/0.jpg', 'https://cdn.example/b/1.jpg'],
      model: 'claude-opus-5-5',
    },
  ]);
  assert.deepEqual(problems, [
    'lot 2: unknown kind(s) sockets',
    'an answer for lot 3, which was not sent',
    'an answer for lot 9, which was not sent',
  ]);
  assert.deepEqual(parseLooks('{"lots":[]}', lots, photos, IDS, 'm').problems, ['2 lot(s) sent but not answered']);
  assert.deepEqual(parseLooks('not json', lots, photos, IDS, 'm'), { rows: [], problems: ['the answer was not JSON'] });
});

test('image types are read from the bytes; AVIF and HTML are refused', () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'image/gif');
  assert.equal(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])), 'image/webp');
  // AVIF: an ISO box, "ftypavif".
  assert.equal(sniffImageType(new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])), null);
  assert.equal(sniffImageType(new TextEncoder().encode('<!DOCTYPE html>')), null);
});

test('base64 matches the standard encoding at every length', () => {
  for (let n = 0; n < 40; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 255);
    assert.equal(toBase64(b), Buffer.from(b).toString('base64'), `length ${n}`);
  }
  const big = new Uint8Array(200_000).map((_, i) => (i * 7919) & 255);
  assert.equal(toBase64(big), Buffer.from(big).toString('base64'));
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const AVIF = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);

function fakeNet(routes: Record<string, () => Response>) {
  const calls: { url: string; ua: string; accept: string }[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, ua: init.headers['User-Agent'], accept: init.headers.Accept });
    const r = routes[url];
    return r ? r() : new Response('not found', { status: 404 });
  };
  return { calls, fetch };
}

test('photos: robots.txt first, our identity, image types only', async () => {
  const { calls, fetch } = fakeNet({
    'https://cdn.example/robots.txt': () => new Response('User-agent: *\nDisallow: /private/\n', { status: 200 }),
    'https://cdn.example/a.jpg': () => new Response(JPEG, { status: 200 }),
    'https://cdn.example/b.avif': () => new Response(AVIF, { status: 200 }),
    'https://cdn.example/gone.jpg': () => new Response('', { status: 403 }),
    'https://cdn.example/huge.jpg': () => new Response(JPEG, { status: 200, headers: { 'content-length': '9000000' } }),
    'https://down.example/robots.txt': () => new Response('', { status: 503 }),
  });
  const get = photoFetcher({ fetch, userAgent: 'WaystockBot/0.1', robotsToken: 'WaystockBot', spacingMs: 0 });
  const ok = await get('https://cdn.example/a.jpg');
  assert.deepEqual(ok, { ok: true, photo: { url: 'https://cdn.example/a.jpg', mediaType: 'image/jpeg', base64: toBase64(JPEG) } });
  assert.deepEqual(await get('https://cdn.example/private/x.jpg'), { ok: false, why: 'robots.txt of cdn.example disallows it' });
  assert.deepEqual(await get('https://cdn.example/b.avif'), { ok: false, why: 'not a JPEG, PNG, GIF or WebP' });
  assert.deepEqual(await get('https://cdn.example/gone.jpg'), { ok: false, why: 'HTTP 403' });
  assert.deepEqual(await get('https://cdn.example/huge.jpg'), { ok: false, why: 'larger than the photo cap' });
  // robots.txt answering 5xx means no fetching from that host at all.
  assert.deepEqual(await get('https://down.example/a.jpg'), { ok: false, why: 'robots.txt of down.example could not be read' });
  assert.equal(calls.filter((c) => c.url === 'https://cdn.example/robots.txt').length, 1, 'robots.txt read once per host');
  assert.ok(!calls.some((c) => c.url.startsWith('https://down.example/a')));
  assert.ok(!calls.some((c) => c.url.includes('/private/')));
  assert.ok(calls.every((c) => c.ua === 'WaystockBot/0.1'));
  assert.match(calls.find((c) => c.url.endsWith('a.jpg'))!.accept, /^image\/jpeg/);
});

test('photos: no robots.txt (404) means no rules, and requests to one host are spaced', async () => {
  const { fetch } = fakeNet({
    'https://img.example/1.jpg': () => new Response(JPEG, { status: 200 }),
    'https://img.example/2.jpg': () => new Response(JPEG, { status: 200 }),
  });
  let clock = 0;
  const waits: number[] = [];
  const get = photoFetcher({
    fetch,
    userAgent: 'WaystockBot/0.1',
    robotsToken: 'WaystockBot',
    spacingMs: 250,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  const [a, b] = await Promise.all([get('https://img.example/1.jpg'), get('https://img.example/2.jpg')]);
  assert.equal(a.ok && b.ok, true);
  // robots.txt, then two photos: each request after the first waits its turn.
  assert.deepEqual(waits, [250, 250]);
});
