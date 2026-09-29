/**
 * The JSONLogic subset the section 9 spec is written in, evaluated exactly.
 *
 * Three departures from json-logic-js, each deliberate:
 *
 * 1. Numbers are exact fractions (exact.ts), so the spec's arithmetic gives the
 *    answer the formula describes rather than the nearest double.
 *
 * 2. null in arithmetic or an ordering comparison THROWS. json-logic-js quietly
 *    turns it into 0 or NaN. The doc says every expression is guarded and that its
 *    reference harness "raises on any null reaching arithmetic or an ordering
 *    comparison", and this evaluator is that harness: a missing guard is a bug in
 *    the spec, and a bug should be loud.
 *
 * 3. UNKNOWN is a value, distinct from null. null is the spec's own "not
 *    captured" (buyer_premium_pct: null means use the platform default). UNKNOWN
 *    is a field the spec requires but the lot does not have, such as image_count
 *    on a source that never reported photos. It propagates the way Kleene
 *    logic says: false AND unknown is false, true AND unknown is unknown. So a
 *    missing photo count cannot make "no photos on a high-risk lot" fire, and it
 *    cannot silently rule it out either; the rule is reported as not evaluated.
 */

import {
  type Rat,
  ONE,
  ZERO,
  add,
  cmp,
  div,
  floor,
  fromInt,
  fromNumber,
  isRat,
  mul,
  neg,
  parseInstant,
  rat,
  sub,
} from './exact.ts';
import type { JsonLogic } from './types.ts';

export const UNKNOWN: unique symbol = Symbol('UNKNOWN');
export type Unknown = typeof UNKNOWN;

export type Value = Rat | string | boolean | null | Unknown | readonly Value[];

export type JsonLogicErrorCode =
  | 'null_operand'
  | 'type_mismatch'
  | 'unknown_operator'
  | 'unknown_variable'
  | 'division_by_zero'
  | 'bad_arity'
  | 'bad_value';

export class JsonLogicError extends Error {
  readonly code: JsonLogicErrorCode;
  constructor(code: JsonLogicErrorCode, message: string) {
    super(message);
    this.name = 'JsonLogicError';
    this.code = code;
  }
}

export interface EvalEnv {
  /** What `var` reads: inputs, derived values so far, and `constants`. */
  readonly data: Readonly<Record<string, unknown>>;
  /** context.now, for minutes_until. */
  readonly now?: Date;
  readonly platformAttr?: (attr: string) => unknown;
  readonly categoryAttr?: (attr: string) => unknown;
  readonly incrementLadder?: (amountCents: Rat, ladderName: string) => Rat;
}

type Op = (args: readonly JsonLogic[], env: EvalEnv) => Value;

const MISSING = Symbol('missing');

function describe(v: Value): string {
  if (v === UNKNOWN) return 'UNKNOWN';
  if (v === null) return 'null';
  if (isRat(v)) return 'a number';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'string' ? `the string "${v}"` : `the boolean ${String(v)}`;
}

/** Converts a raw data value (JS number, string, Rat, ...) into an evaluator Value. */
export function toValue(raw: unknown, where = 'value'): Value {
  if (raw === UNKNOWN || raw === null || typeof raw === 'string' || typeof raw === 'boolean') {
    return raw as Value;
  }
  if (typeof raw === 'number') {
    const r = fromNumber(raw);
    if (r === null) throw new JsonLogicError('bad_value', `${where} is not a finite number`);
    return r;
  }
  if (typeof raw === 'bigint') return fromInt(raw);
  if (isRat(raw)) return raw;
  if (Array.isArray(raw)) return raw.map((x) => toValue(x, where));
  throw new JsonLogicError('bad_value', `${where} is not a value the spec can use`);
}

function lookup(data: Readonly<Record<string, unknown>>, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur) || isRat(cur)) return MISSING;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return MISSING;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** What `var` would read at `path`, or undefined when there is nothing there. */
export function lookupPath(data: Readonly<Record<string, unknown>>, path: string): unknown {
  const v = lookup(data, path);
  return v === MISSING ? undefined : v;
}

export function truthy(v: Exclude<Value, Unknown>): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isRat(v)) return v.n !== 0n;
  return Boolean(v);
}

function num(v: Value, op: string): Rat | Unknown {
  if (v === UNKNOWN) return UNKNOWN;
  if (v === null) throw new JsonLogicError('null_operand', `null reached "${op}"`);
  if (isRat(v)) return v;
  throw new JsonLogicError('type_mismatch', `"${op}" needs a number, got ${describe(v)}`);
}

function arg(args: readonly JsonLogic[], i: number, op: string): JsonLogic {
  if (i >= args.length) throw new JsonLogicError('bad_arity', `"${op}" is missing argument ${i + 1}`);
  return args[i] as JsonLogic;
}

function exactly(args: readonly JsonLogic[], n: number, op: string): void {
  if (args.length !== n) {
    throw new JsonLogicError('bad_arity', `"${op}" takes ${n} argument(s), got ${args.length}`);
  }
}

/** json-logic-js uses loose ==; the spec only ever compares like with like, so anything else is a spec bug. */
function looseEquals(a: Value, b: Value, op: string): boolean | Unknown {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if (a === null || b === null) return a === b;
  if (isRat(a) && isRat(b)) return cmp(a, b) === 0;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  throw new JsonLogicError('type_mismatch', `"${op}" compares ${describe(a)} with ${describe(b)}`);
}

function ordering(test: (c: -1 | 0 | 1) => boolean, op: string): Op {
  return (args, env) => {
    exactly(args, 2, op);
    const a = num(evaluate(arg(args, 0, op), env), op);
    const b = num(evaluate(arg(args, 1, op), env), op);
    if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
    return test(cmp(a, b));
  };
}

function variadic(op: string, combine: (a: Rat, b: Rat) => Rat, identity: Rat): Op {
  return (args, env) => {
    if (args.length === 0) throw new JsonLogicError('bad_arity', `"${op}" needs at least one argument`);
    let acc = identity;
    let unknown = false;
    for (const a of args) {
      const v = num(evaluate(a, env), op);
      if (v === UNKNOWN) unknown = true;
      else acc = combine(acc, v);
    }
    return unknown ? UNKNOWN : acc;
  };
}

function extremum(op: 'min' | 'max'): Op {
  return (args, env) => {
    if (args.length === 0) throw new JsonLogicError('bad_arity', `"${op}" needs at least one argument`);
    let best: Rat | null = null;
    let unknown = false;
    for (const a of args) {
      const v = num(evaluate(a, env), op);
      if (v === UNKNOWN) {
        unknown = true;
        continue;
      }
      if (best === null || (op === 'min' ? cmp(v, best) < 0 : cmp(v, best) > 0)) best = v;
    }
    return unknown || best === null ? UNKNOWN : best;
  };
}

/**
 * Evaluates an operand after an earlier one came back UNKNOWN. The unknown one may
 * have been the guard that protects this operand from a null, so a null here
 * means "unknown", not "the spec forgot a guard".
 */
function evaluateAfterUnknown(e: JsonLogic, env: EvalEnv): Value {
  try {
    return evaluate(e, env);
  } catch (err) {
    if (err instanceof JsonLogicError && err.code === 'null_operand') return UNKNOWN;
    throw err;
  }
}

const OPS: Readonly<Record<string, Op>> = {
  var: (args, env) => {
    const path = evaluate(arg(args, 0, 'var'), env);
    if (typeof path !== 'string') {
      throw new JsonLogicError('type_mismatch', `"var" needs a string path, got ${describe(path)}`);
    }
    const found = lookup(env.data, path);
    if (found === MISSING) {
      if (args.length > 1) return evaluate(arg(args, 1, 'var'), env);
      throw new JsonLogicError('unknown_variable', `no value named "${path}"`);
    }
    return toValue(found, path);
  },

  if: (args, env) => {
    let i = 0;
    for (; i + 1 < args.length; i += 2) {
      const c = evaluate(arg(args, i, 'if'), env);
      if (c === UNKNOWN) return UNKNOWN;
      if (truthy(c)) return evaluate(arg(args, i + 1, 'if'), env);
    }
    return i < args.length ? evaluate(arg(args, i, 'if'), env) : null;
  },

  and: (args, env) => {
    let unknown = false;
    let last: Value = true;
    for (const a of args) {
      const v = unknown ? evaluateAfterUnknown(a, env) : evaluate(a, env);
      if (v === UNKNOWN) {
        unknown = true;
        continue;
      }
      if (!truthy(v)) return v;
      last = v;
    }
    return unknown ? UNKNOWN : last;
  },

  or: (args, env) => {
    let unknown = false;
    let last: Value = false;
    for (const a of args) {
      const v = unknown ? evaluateAfterUnknown(a, env) : evaluate(a, env);
      if (v === UNKNOWN) {
        unknown = true;
        continue;
      }
      if (truthy(v)) return v;
      last = v;
    }
    return unknown ? UNKNOWN : last;
  },

  '!': (args, env) => {
    exactly(args, 1, '!');
    const v = evaluate(arg(args, 0, '!'), env);
    return v === UNKNOWN ? UNKNOWN : !truthy(v);
  },

  '==': (args, env) => {
    exactly(args, 2, '==');
    return looseEquals(evaluate(arg(args, 0, '=='), env), evaluate(arg(args, 1, '=='), env), '==');
  },

  '!=': (args, env) => {
    exactly(args, 2, '!=');
    const eq = looseEquals(evaluate(arg(args, 0, '!='), env), evaluate(arg(args, 1, '!='), env), '!=');
    return eq === UNKNOWN ? UNKNOWN : !eq;
  },

  '<': ordering((c) => c < 0, '<'),
  '<=': ordering((c) => c <= 0, '<='),
  '>': ordering((c) => c > 0, '>'),
  '>=': ordering((c) => c >= 0, '>='),

  in: (args, env) => {
    exactly(args, 2, 'in');
    const needle = evaluate(arg(args, 0, 'in'), env);
    const hay = evaluate(arg(args, 1, 'in'), env);
    if (needle === UNKNOWN || hay === UNKNOWN) return UNKNOWN;
    if (Array.isArray(hay)) {
      let unknown = false;
      for (const item of hay as readonly Value[]) {
        const eq = looseEquals(needle, item, 'in');
        if (eq === UNKNOWN) unknown = true;
        else if (eq) return true;
      }
      return unknown ? UNKNOWN : false;
    }
    if (typeof hay === 'string' && typeof needle === 'string') return hay.includes(needle);
    if (hay === null) throw new JsonLogicError('null_operand', 'null reached "in"');
    throw new JsonLogicError('type_mismatch', `"in" cannot search ${describe(hay)}`);
  },

  '+': variadic('+', add, ZERO),
  '*': variadic('*', mul, ONE),

  '-': (args, env) => {
    if (args.length === 1) {
      const a = num(evaluate(arg(args, 0, '-'), env), '-');
      return a === UNKNOWN ? UNKNOWN : neg(a);
    }
    exactly(args, 2, '-');
    const a = num(evaluate(arg(args, 0, '-'), env), '-');
    const b = num(evaluate(arg(args, 1, '-'), env), '-');
    return a === UNKNOWN || b === UNKNOWN ? UNKNOWN : sub(a, b);
  },

  '/': (args, env) => {
    exactly(args, 2, '/');
    const a = num(evaluate(arg(args, 0, '/'), env), '/');
    const b = num(evaluate(arg(args, 1, '/'), env), '/');
    if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
    if (b.n === 0n) throw new JsonLogicError('division_by_zero', 'division by zero');
    return div(a, b);
  },

  min: extremum('min'),
  max: extremum('max'),

  // ---- the spec's five custom operations (expression_language.custom_ops)

  floor: (args, env) => {
    exactly(args, 1, 'floor');
    const v = evaluate(arg(args, 0, 'floor'), env);
    if (v === null) return null;
    const r = num(v, 'floor');
    return r === UNKNOWN ? UNKNOWN : fromInt(floor(r));
  },

  minutes_until: (args, env) => {
    exactly(args, 1, 'minutes_until');
    const v = evaluate(arg(args, 0, 'minutes_until'), env);
    if (v === null || v === UNKNOWN) return v;
    if (typeof v !== 'string') {
      throw new JsonLogicError('type_mismatch', `"minutes_until" needs a timestamp, got ${describe(v)}`);
    }
    if (!env.now) throw new JsonLogicError('bad_value', '"minutes_until" needs context.now');
    const t = parseInstant(v);
    if (t === null) throw new JsonLogicError('bad_value', `"${v}" is not an ISO-8601 instant with an offset`);
    return rat(BigInt(t - env.now.getTime()), 60000n);
  },

  platform_attr: (args, env) => {
    exactly(args, 1, 'platform_attr');
    const attr = evaluate(arg(args, 0, 'platform_attr'), env);
    if (typeof attr !== 'string') throw new JsonLogicError('type_mismatch', '"platform_attr" needs a name');
    if (!env.platformAttr) throw new JsonLogicError('bad_value', '"platform_attr" needs a platform table');
    return toValue(env.platformAttr(attr), `platform attribute "${attr}"`);
  },

  category_attr: (args, env) => {
    exactly(args, 1, 'category_attr');
    const attr = evaluate(arg(args, 0, 'category_attr'), env);
    if (typeof attr !== 'string') throw new JsonLogicError('type_mismatch', '"category_attr" needs a name');
    if (!env.categoryAttr) throw new JsonLogicError('bad_value', '"category_attr" needs a category table');
    return toValue(env.categoryAttr(attr), `category attribute "${attr}"`);
  },

  increment_ladder: (args, env) => {
    exactly(args, 2, 'increment_ladder');
    const amount = num(evaluate(arg(args, 0, 'increment_ladder'), env), 'increment_ladder');
    const name = evaluate(arg(args, 1, 'increment_ladder'), env);
    if (amount === UNKNOWN || name === UNKNOWN) return UNKNOWN;
    if (typeof name !== 'string') throw new JsonLogicError('type_mismatch', '"increment_ladder" needs a ladder name');
    if (!env.incrementLadder) throw new JsonLogicError('bad_value', '"increment_ladder" needs the ladders');
    return env.incrementLadder(amount, name);
  },
};

export function evaluate(expr: JsonLogic, env: EvalEnv): Value {
  if (expr === null || typeof expr === 'boolean' || typeof expr === 'string') return expr;
  if (typeof expr === 'number') return toValue(expr, 'literal');
  if (Array.isArray(expr)) return (expr as readonly JsonLogic[]).map((e) => evaluate(e, env));
  const obj = expr as { readonly [op: string]: JsonLogic };
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    throw new JsonLogicError('bad_value', `an operation has exactly one key, got ${JSON.stringify(keys)}`);
  }
  const op = keys[0] as string;
  const fn = OPS[op];
  if (!fn) throw new JsonLogicError('unknown_operator', `unsupported operator "${op}"`);
  const raw = obj[op] as JsonLogic;
  return fn(Array.isArray(raw) ? (raw as readonly JsonLogic[]) : [raw], env);
}

/**
 * Every variable an expression reads. Custom operations show up as pseudo
 * variables ("platform.close_type", "category.herd_bid_count", "now",
 * "increment_ladder") so that a dependency walk can see parameters as well as
 * inputs.
 */
export function collectVars(expr: JsonLogic, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(expr)) {
    for (const e of expr as readonly JsonLogic[]) collectVars(e, out);
    return out;
  }
  if (expr === null || typeof expr !== 'object') return out;
  for (const [op, raw] of Object.entries(expr as { readonly [op: string]: JsonLogic })) {
    const args: readonly JsonLogic[] = Array.isArray(raw) ? (raw as readonly JsonLogic[]) : [raw];
    if (op === 'var' && typeof args[0] === 'string') {
      out.add(args[0]);
      continue;
    }
    if ((op === 'platform_attr' || op === 'category_attr') && typeof args[0] === 'string') {
      out.add(`${op === 'platform_attr' ? 'platform' : 'category'}.${args[0]}`);
      continue;
    }
    if (op === 'minutes_until') out.add('now');
    if (op === 'increment_ladder') out.add('increment_ladder');
    collectVars(args, out);
  }
  return out;
}
