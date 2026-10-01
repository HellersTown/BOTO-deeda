// appraise-lots: what open lots resell for, for Finds (migration 0044).
//
// The app sends up to 20 lot ids. This function checks who is asking and their
// allowance for the last 24 hours, then skips any lot that cannot or need not
// be appraised: closed, a whole sale, a held source, land, or one already
// appraised under the same title within FRESH_DAYS. It asks Claude about the
// rest in batches of 10, with the answer's shape enforced by a JSON schema,
// and stores one lot_appraisals row per lot. Every model call is logged in
// appraisal_batches with its tokens, so the cost is visible.
//
// It is off until the ANTHROPIC_API_KEY secret is set for Edge Functions. The
// key lives only here, on the server, never in the app's build.
//
//   POST {"check": true}         -> {configured, model, remaining, cap}
//   POST {"lot_ids": [...]}      -> {configured, appraised, failed, skipped, remaining}

import Anthropic from 'npm:@anthropic-ai/sdk@0.130.0';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  APPRAISAL_SCHEMA,
  APPRAISAL_SYSTEM,
  BATCH_SIZE,
  buildBatchPrompt,
  ineligibility,
  isFresh,
  parseAppraisals,
  type AppraisalLot,
} from './lib/appraisal.ts';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const MODEL = Deno.env.get('APPRAISAL_MODEL') || 'claude-opus-5-5';
/** Valuing listings is short structured work; low effort keeps thinking, and its cost, small. */
const EFFORT: Effort = EFFORTS.find((e) => e === Deno.env.get('APPRAISAL_EFFORT')) ?? 'low';
/** Lots one request may ask about: two batches, answered in parallel well inside the request limit. */
const MAX_LOTS = 20;
/** All users together, per rolling 24 hours: the cost ceiling. */
const DAILY_TOTAL = Number(Deno.env.get('APPRAISAL_DAILY_CAP') || '600');
/** Per user, per rolling 24 hours, by tier. */
const PER_USER: Record<string, number> = { free: 25, pro: 200, dealer: 500 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
    (JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>).default;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Lots appraised in the last 24 hours, by one user or by everyone. */
async function appraisedSince(db: SupabaseClient, since: string, userId: string | null): Promise<number> {
  let q = db.from('appraisal_batches').select('appraised').gte('created_at', since);
  if (userId !== null) q = q.eq('requested_by', userId);
  const { data, error } = await q;
  if (error) throw new Error(`appraisal_batches: ${error.message}`);
  return (data ?? []).reduce((n: number, r: { appraised: number }) => n + (r.appraised ?? 0), 0);
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function toAppraisalLot(r: Row): AppraisalLot {
  return {
    id: r.id,
    title: r.title ?? '',
    description: r.description ?? null,
    brand: r.brand ?? null,
    model: r.model ?? null,
    condition: r.condition ?? null,
    quantity: typeof r.quantity === 'number' ? r.quantity : null,
    currentBidCents: typeof r.current_bid_cents === 'number' ? r.current_bid_cents : null,
    seller: r.auction?.seller_name ?? r.source?.name ?? null,
    pickupCity: r.pickup_city ?? null,
    pickupState: r.pickup_state ?? null,
    ships: typeof r.ships === 'boolean' ? r.ships : null,
    closed: r.closed === true,
    saleLevel: r.sale_level === true,
    sourcePlatform: r.source?.platform ?? null,
    sourceActive: r.source?.active === true,
    sourceAllowed: r.source?.ingest_allowed === true,
  };
}

interface BatchOutcome {
  readonly appraised: number;
  readonly failed: number;
  readonly error: string | null;
}

async function appraiseBatch(client: Anthropic, db: SupabaseClient, lots: AppraisalLot[], userId: string): Promise<BatchOutcome> {
  const { data: batch, error: batchErr } = await db
    .from('appraisal_batches')
    .insert({ requested_by: userId, model: MODEL, lots: lots.length })
    .select('id')
    .single();
  if (batchErr || !batch) return { appraised: 0, failed: lots.length, error: `could not log the batch: ${batchErr?.message}` };

  const finish = async (fields: Row): Promise<void> => {
    await db.from('appraisal_batches').update(fields).eq('id', batch.id);
  };

  try {
    // fallbacks "default": if a safety classifier declines, the API re-runs the
    // request on its recommended fallback model instead of returning a refusal.
    // The system prompt is the same for every batch, so it is cached.
    const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: APPRAISAL_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildBatchPrompt(lots) }],
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: APPRAISAL_SCHEMA } },
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
      return { appraised: 0, failed: lots.length, error: why };
    }
    const answer = response.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const { rows, problems } = parseAppraisals(answer, lots, response.model ?? MODEL);
    if (rows.length > 0) {
      const now = new Date().toISOString();
      const { error: upErr } = await db
        .from('lot_appraisals')
        .upsert(rows.map((r) => ({ ...r, requested_by: userId, batch_id: batch.id, created_at: now })), { onConflict: 'lot_id' });
      if (upErr) {
        await finish({ ...usage, error: `could not store appraisals: ${upErr.message}` });
        return { appraised: 0, failed: lots.length, error: 'could not store appraisals' };
      }
    }
    await finish({ ...usage, appraised: rows.length, error: problems.length > 0 ? problems.join('; ').slice(0, 1000) : null });
    return { appraised: rows.length, failed: lots.length - rows.length, error: null };
  } catch (e) {
    const why =
      e instanceof Anthropic.AuthenticationError
        ? 'the Anthropic API key was refused'
        : e instanceof Anthropic.RateLimitError
          ? 'rate limited by the Anthropic API; try again in a minute'
          : e instanceof Anthropic.APIError
            ? `Anthropic API error ${e.status ?? ''}`.trim()
            : e instanceof Error
              ? e.message
              : String(e);
    await finish({ error: why });
    return { appraised: 0, failed: lots.length, error: why };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only.' }, 405);

  const db = serviceClient();
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth, error: authErr } = await db.auth.getUser(token);
  if (authErr || !auth?.user) return reply({ error: 'Sign in to appraise lots.' }, 401);
  const userId = auth.user.id;

  let body: { check?: unknown; lot_ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply({ error: 'Send JSON: {"lot_ids": [...]}.' }, 400);
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
  try {
    const { data: profile } = await db.from('profiles').select('tier').eq('id', userId).maybeSingle();
    const cap = PER_USER[profile?.tier ?? 'free'] ?? PER_USER.free;
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const [mine, everyone] = await Promise.all([appraisedSince(db, since, userId), appraisedSince(db, since, null)]);
    const remaining = Math.max(0, Math.min(cap - mine, DAILY_TOTAL - everyone));

    if (body.check === true || apiKey === '') {
      return reply({ configured: apiKey !== '', model: MODEL, remaining, cap });
    }

    const ids = Array.isArray(body.lot_ids)
      ? [...new Set(body.lot_ids.filter((x): x is string => typeof x === 'string' && UUID.test(x)))]
      : [];
    if (ids.length === 0) return reply({ error: 'No lot ids.' }, 400);
    if (ids.length > MAX_LOTS) return reply({ error: `At most ${MAX_LOTS} lots per request.` }, 400);

    const { data: lotRows, error: lotErr } = await db
      .from('lots')
      .select(
        'id, title, description, brand, model, condition, quantity, current_bid_cents, closed, sale_level, ' +
          'pickup_city, pickup_state, ships, source:sources(name, platform, active, ingest_allowed), auction:auctions(seller_name)',
      )
      .in('id', ids);
    if (lotErr) throw new Error(`lots: ${lotErr.message}`);
    const { data: stored, error: storedErr } = await db.from('lot_appraisals').select('lot_id, lot_title, created_at').in('lot_id', ids);
    if (storedErr) throw new Error(`lot_appraisals: ${storedErr.message}`);
    const storedBy = new Map((stored ?? []).map((s: Row) => [s.lot_id as string, s]));

    const skipped: Record<string, number> = {};
    const skip = (why: string) => {
      skipped[why] = (skipped[why] ?? 0) + 1;
    };
    const now = new Date();
    const found = new Set<string>();
    const eligible: AppraisalLot[] = [];
    for (const r of (lotRows ?? []) as Row[]) {
      found.add(r.id);
      const lot = toAppraisalLot(r);
      const why = ineligibility(lot);
      if (why !== null) {
        skip(why);
        continue;
      }
      const prior = storedBy.get(lot.id);
      if (prior && isFresh(prior as { lot_title: string; created_at: string }, lot, now)) {
        skip('already_appraised');
        continue;
      }
      eligible.push(lot);
    }
    for (const id of ids) if (!found.has(id)) skip('not_found');

    const todo = eligible.slice(0, remaining);
    if (eligible.length > todo.length) skipped.over_allowance = eligible.length - todo.length;
    if (todo.length === 0) return reply({ configured: true, appraised: 0, failed: 0, skipped, remaining });

    const client = new Anthropic({ apiKey });
    const batches: AppraisalLot[][] = [];
    for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));
    const outcomes = await Promise.all(batches.map((b) => appraiseBatch(client, db, b, userId)));
    const appraised = outcomes.reduce((n, o) => n + o.appraised, 0);
    const failed = outcomes.reduce((n, o) => n + o.failed, 0);
    const errors = [...new Set(outcomes.map((o) => o.error).filter((e): e is string => e !== null))];
    return reply({
      configured: true,
      model: MODEL,
      appraised,
      failed,
      skipped,
      remaining: Math.max(0, remaining - appraised),
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (e) {
    console.log(JSON.stringify({ level: 'error', fn: 'appraise-lots', msg: e instanceof Error ? e.message : String(e) }));
    return reply({ error: 'Appraisal failed on the server. Try again shortly.' }, 500);
  }
});
