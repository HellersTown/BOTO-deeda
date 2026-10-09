// look-at-lots: what each open lot's photos show (migration 0057).
//
// The schedule calls it every 3 minutes (public.invoke_look_at_lots, which adds
// the x-look-token header this function checks; any other caller is refused).
// Each call takes up to PER_RUN lots the database says are due
// (next_lots_to_look), fetches their photos as our crawler (lib/look.ts
// photoFetcher: robots.txt first, one host at a time, images only), and asks
// Claude, LOOK_BATCH lots per request, which kinds of items each lot holds, in
// the search vocabulary's ids. record_lot_looks keeps the answers and gives
// search the kinds.
//
// It is off until the ANTHROPIC_API_KEY secret is set for Edge Functions, and
// it never looks at more than DAILY_CAP lots in 24 hours. Every model call is
// logged in look_batches with its tokens, so the cost is visible.
//
//   POST {}               -> {configured, looked, failed, remaining, ...}
//   POST {"check": true}  -> {configured, model, remaining, cap}

import Anthropic from 'npm:@anthropic-ai/sdk@0.130.0';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { CRAWLER_TOKEN, CRAWLER_UA } from './lib/http.ts';
import {
  LOOK_BATCH,
  buildLookContent,
  buildLookSystem,
  lookSchema,
  parseLooks,
  photoFetcher,
  photosFor,
  type LookConcept,
  type LookLot,
  type LookPhoto,
} from './lib/look.ts';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const MODEL = Deno.env.get('LOOK_MODEL') || 'claude-opus-5-5';
/** Naming what a photo shows is short perceptual work: low effort keeps thinking, and its cost, small. */
const EFFORT: Effort = EFFORTS.find((e) => e === Deno.env.get('LOOK_EFFORT')) ?? 'low';
/** Lots looked at per rolling 24 hours, all calls together: the cost ceiling. */
const DAILY_CAP = Math.max(0, Number(Deno.env.get('LOOK_DAILY_CAP') || '1500'));
/** Lots per call: three requests of LOOK_BATCH, answered in parallel well inside the request limit. */
const PER_RUN = Math.max(1, Math.min(48, Number(Deno.env.get('LOOK_PER_RUN') || '24')));
/** Least time between two photo requests to one host. */
const PHOTO_SPACING_MS = 250;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
    (JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>).default;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Lots looked at in the last 24 hours, by every call. */
async function lookedSince(db: SupabaseClient, since: string): Promise<number> {
  const { data, error } = await db.from('look_batches').select('looked').gte('created_at', since);
  if (error) throw new Error(`look_batches: ${error.message}`);
  return (data ?? []).reduce((n: number, r: { looked: number }) => n + (r.looked ?? 0), 0);
}

interface BatchOutcome {
  readonly looked: number;
  readonly failed: number;
  readonly error: string | null;
}

async function lookBatch(
  client: Anthropic,
  db: SupabaseClient,
  system: string,
  schema: Record<string, unknown>,
  conceptIds: string[],
  lots: LookLot[],
  photos: Map<string, LookPhoto[]>,
): Promise<BatchOutcome> {
  const content = buildLookContent(lots, photos);
  const sent = lots.filter((l) => (photos.get(l.id) ?? []).length > 0);
  if (sent.length === 0) return { looked: 0, failed: 0, error: null };
  const photoCount = sent.reduce((n, l) => n + (photos.get(l.id) ?? []).length, 0);

  const { data: batch, error: batchErr } = await db
    .from('look_batches')
    .insert({ model: MODEL, lots: sent.length, photos: photoCount })
    .select('id')
    .single();
  if (batchErr || !batch) return { looked: 0, failed: sent.length, error: `could not log the batch: ${batchErr?.message}` };
  const finish = async (fields: Row) => {
    await db.from('look_batches').update(fields).eq('id', batch.id);
  };

  try {
    // fallbacks "default": if a safety classifier declines, the API re-runs the
    // request on its recommended fallback model instead of returning a refusal.
    // The instructions and vocabulary are the same for every call, so cached.
    const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      // deno-lint-ignore no-explicit-any
      messages: [{ role: 'user', content: content as any }],
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema } },
    };
    const response = await client.beta.messages.create(params);
    const usage = {
      input_tokens: response.usage?.input_tokens ?? null,
      output_tokens: response.usage?.output_tokens ?? null,
      cache_read_tokens: response.usage?.cache_read_input_tokens ?? null,
      cache_write_tokens: response.usage?.cache_creation_input_tokens ?? null,
      stop_reason: response.stop_reason,
    };
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      const why = response.stop_reason === 'refusal' ? 'the model declined this batch' : 'the answer was cut off';
      await finish({ ...usage, error: why });
      return { looked: 0, failed: sent.length, error: why };
    }
    const answer = response.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const { rows, problems } = parseLooks(answer, lots, photos, conceptIds, response.model ?? MODEL);
    let stored = 0;
    if (rows.length > 0) {
      const { data: n, error: recErr } = await db.rpc('record_lot_looks', { p_batch_id: batch.id, p_rows: rows });
      if (recErr) {
        await finish({ ...usage, error: `could not store the looks: ${recErr.message}` });
        return { looked: 0, failed: sent.length, error: 'could not store the looks' };
      }
      stored = typeof n === 'number' ? n : rows.length;
    }
    await finish({ ...usage, looked: stored, error: problems.length ? problems.join('; ').slice(0, 1000) : null });
    return { looked: stored, failed: sent.length - stored, error: null };
  } catch (e) {
    const why =
      e instanceof Anthropic.AuthenticationError
        ? 'the Anthropic API key was refused'
        : e instanceof Anthropic.RateLimitError
          ? 'rate limited by the Anthropic API'
          : e instanceof Anthropic.APIError
            ? `Anthropic API error ${e.status ?? ''}`.trim()
            : e instanceof Error
              ? e.message
              : String(e);
    await finish({ error: why });
    return { looked: 0, failed: sent.length, error: why };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return reply({ error: 'POST only.' }, 405);
  const db = serviceClient();

  // Only the schedule (or a developer through it) may start a look.
  const token = req.headers.get('x-look-token') ?? '';
  const { data: allowed } = await db.rpc('check_function_token', { p_name: 'look-at-lots', p_token: token });
  if (allowed !== true) return reply({ error: 'Not allowed.' }, 403);

  let body: { check?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is a normal scheduled call.
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  try {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const remaining = Math.max(0, DAILY_CAP - (await lookedSince(db, since)));
    if (body.check === true || apiKey === '' || remaining === 0) {
      return reply({ configured: apiKey !== '', model: MODEL, remaining, cap: DAILY_CAP });
    }

    const { data: due, error: dueErr } = await db.rpc('next_lots_to_look', { p_limit: Math.min(PER_RUN, remaining) });
    if (dueErr) return reply({ error: `next_lots_to_look: ${dueErr.message}` }, 500);
    const lots: LookLot[] = ((due ?? []) as Row[]).map((r) => ({
      id: r.id,
      title: r.title ?? '',
      description: r.description ?? null,
      imageUrls: Array.isArray(r.image_urls) ? r.image_urls : [],
      titleKinds: Array.isArray(r.item_heads) ? r.item_heads : [],
    }));
    if (lots.length === 0) return reply({ configured: true, looked: 0, failed: 0, remaining, note: 'nothing due' });

    const { data: conceptRows, error: conceptErr } = await db
      .from('search_concepts')
      .select('id, label, parent')
      .eq('active', true);
    if (conceptErr || !conceptRows?.length) return reply({ error: `search_concepts: ${conceptErr?.message ?? 'empty'}` }, 500);
    const concepts = conceptRows as LookConcept[];
    const conceptIds = concepts.map((c) => c.id).sort();
    const system = buildLookSystem(concepts);
    const schema = lookSchema(conceptIds);

    // Photos, politely, all lots at once: requests to one host queue behind each other.
    const fetchPhoto = photoFetcher({
      fetch: (url, init) => fetch(url, { ...init, redirect: 'follow' }),
      userAgent: CRAWLER_UA,
      robotsToken: CRAWLER_TOKEN,
      spacingMs: PHOTO_SPACING_MS,
    });
    const photos = new Map<string, LookPhoto[]>();
    const photoProblems: string[] = [];
    // A lot none of whose photos may or can be read (robots.txt says no, or not
    // an image type the model reads) is recorded as looked at, with nothing
    // seen, so it is not tried again until its photos change. A failure that
    // may pass (a timeout, an HTTP error) leaves it due after its claim expires.
    const unreadable: Row[] = [];
    await Promise.all(
      lots.map(async (lot) => {
        const got: LookPhoto[] = [];
        let lasting = 0;
        const urls = photosFor(lot);
        for (const url of urls) {
          const r = await fetchPhoto(url);
          if (r.ok) got.push(r.photo);
          else {
            photoProblems.push(r.why);
            if (/robots\.txt|not a JPEG|not http|not a URL/.test(r.why)) lasting++;
          }
        }
        photos.set(lot.id, got);
        if (got.length === 0 && urls.length > 0 && lasting === urls.length) {
          unreadable.push({ lot_id: lot.id, kinds: [], main_kind: null, caption: '', brand: null, model_number: null,
                            title_agrees: null, confidence: 'low', image_urls: urls, model: 'no-readable-photo' });
        }
      }),
    );
    if (unreadable.length) await db.rpc('record_lot_looks', { p_batch_id: null, p_rows: unreadable });

    const client = new Anthropic({ apiKey });
    const batches: LookLot[][] = [];
    for (let i = 0; i < lots.length; i += LOOK_BATCH) batches.push(lots.slice(i, i + LOOK_BATCH));
    const outcomes = await Promise.all(
      batches.map((b) => lookBatch(client, db, system, schema, conceptIds, b, new Map(b.map((l) => [l.id, photos.get(l.id) ?? []])))),
    );
    const looked = outcomes.reduce((n, o) => n + o.looked, 0);
    const failed = outcomes.reduce((n, o) => n + o.failed, 0);
    const noPhoto = lots.filter((l) => (photos.get(l.id) ?? []).length === 0).length;
    return reply({
      configured: true,
      model: MODEL,
      looked,
      failed,
      without_photos: noPhoto,
      photo_problems: [...new Set(photoProblems)].slice(0, 5),
      errors: outcomes.map((o) => o.error).filter((e): e is string => e !== null),
      remaining: Math.max(0, remaining - looked),
    });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
