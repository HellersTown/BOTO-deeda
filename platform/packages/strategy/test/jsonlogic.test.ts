import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonLogicError, UNKNOWN, collectVars, evaluate, type EvalEnv } from '../src/jsonlogic.ts';
import { cmp, fromNumber, rat, type Rat } from '../src/exact.ts';
import type { JsonLogic } from '../src/types.ts';

const env = (data: Record<string, unknown>, extra: Partial<EvalEnv> = {}): EvalEnv => ({ data, ...extra });
const num = (v: unknown): number => {
  const r = v as Rat;
  return Number(r.n) / Number(r.d);
};
const isExactly = (v: unknown, x: number): boolean => cmp(v as Rat, fromNumber(x)!) === 0;

test('arithmetic is exact: 0.1 + 0.2 == 0.3 holds', () => {
  assert.equal(evaluate({ '==': [{ '+': [0.1, 0.2] }, 0.3] }, env({})), true);
  assert.ok(isExactly(evaluate({ '*': [30000, { '-': [1, 0.14] }] }, env({})), 25800));
  // The spec's eBay tool lot: 12300 / 1.055 is 2460000/211 exactly, not a rounded double.
  assert.deepEqual(evaluate({ '/': [12300, 1.055] }, env({})), rat(2460000n, 211n));
  assert.ok(isExactly(evaluate({ min: [3, 1, 2] }, env({})), 1));
  assert.ok(isExactly(evaluate({ max: [3, 1, 2] }, env({})), 3));
  assert.ok(isExactly(evaluate({ '-': [5] }, env({})), -5));
});

test('var reads inputs, derived values and dotted constants', () => {
  const data = { a: 2, constants: { k: 0.5 } };
  assert.ok(isExactly(evaluate({ '*': [{ var: 'a' }, { var: 'constants.k' }] }, env(data)), 1));
  assert.throws(() => evaluate({ var: 'missing' }, env(data)), (e: unknown) => (e as JsonLogicError).code === 'unknown_variable');
  assert.equal(evaluate({ var: ['missing', 'dflt'] }, env(data)), 'dflt');
});

test('null reaching arithmetic or an ordering comparison throws, as the doc harness does', () => {
  const nullData = env({ x: null });
  const unguarded: JsonLogic[] = [{ '+': [{ var: 'x' }, 1] }, { '<': [{ var: 'x' }, 1] }, { '*': [2, { var: 'x' }] }, { max: [0, { var: 'x' }] }];
  for (const expr of unguarded) {
    assert.throws(() => evaluate(expr, nullData), (e: unknown) => (e as JsonLogicError).code === 'null_operand');
  }
  // Guards are how the spec avoids it: != null first, and `and` short-circuits.
  assert.equal(evaluate({ and: [{ '!=': [{ var: 'x' }, null] }, { '>': [{ var: 'x' }, 0] }] }, nullData), false);
  assert.equal(evaluate({ '==': [{ var: 'x' }, null] }, nullData), true);
  assert.equal(evaluate({ '==': [{ var: 'x' }, 0] }, nullData), false);
  assert.equal(evaluate({ floor: [{ var: 'x' }] }, nullData), null);
});

test('comparing unlike types is a spec bug and throws', () => {
  assert.throws(() => evaluate({ '==': [1, 'one'] }, env({})), (e: unknown) => (e as JsonLogicError).code === 'type_mismatch');
  assert.throws(() => evaluate({ '/': [1, 0] }, env({})), (e: unknown) => (e as JsonLogicError).code === 'division_by_zero');
  assert.throws(() => evaluate({ nope: [1] } as JsonLogic, env({})), (e: unknown) => (e as JsonLogicError).code === 'unknown_operator');
});

test('UNKNOWN follows Kleene logic: false AND unknown is false, true AND unknown is unknown', () => {
  const d = env({ u: UNKNOWN, t: true, f: false, x: null });
  assert.equal(evaluate({ and: [{ var: 'f' }, { var: 'u' }] }, d), false);
  assert.equal(evaluate({ and: [{ var: 'u' }, { var: 'f' }] }, d), false);
  assert.equal(evaluate({ and: [{ var: 't' }, { var: 'u' }] }, d), UNKNOWN);
  assert.equal(evaluate({ or: [{ var: 'u' }, { var: 't' }] }, d), true);
  assert.equal(evaluate({ or: [{ var: 'f' }, { var: 'u' }] }, d), UNKNOWN);
  assert.equal(evaluate({ '!': [{ var: 'u' }] }, d), UNKNOWN);
  assert.equal(evaluate({ '==': [{ var: 'u' }, 0] }, d), UNKNOWN);
  assert.equal(evaluate({ '<': [{ var: 'u' }, 3] }, d), UNKNOWN);
  assert.equal(evaluate({ if: [{ var: 'u' }, 1, 2] }, d), UNKNOWN);
  // After an unknown guard, a null the guard would have stopped is unknown, not an error.
  assert.equal(evaluate({ and: [{ var: 'u' }, { '>': [{ var: 'x' }, 0] }] }, d), UNKNOWN);
});

test('if, in and ! behave as json-logic-js', () => {
  assert.equal(evaluate({ if: [false, 'a', true, 'b', 'c'] }, env({})), 'b');
  assert.equal(evaluate({ if: [false, 'a', 'c'] }, env({})), 'c');
  assert.equal(evaluate({ if: [false, 'a'] }, env({})), null);
  assert.equal(evaluate({ in: ['soft', ['soft', 'inactivity']] }, env({})), true);
  assert.equal(evaluate({ in: ['hard', ['soft', 'inactivity']] }, env({})), false);
  assert.equal(evaluate({ in: ['ll', 'hello'] }, env({})), true);
  assert.equal(evaluate({ '!': [0] }, env({})), true);
  assert.equal(evaluate({ '!': [[]] }, env({})), true);
});

test('the five custom operations do what expression_language.custom_ops says', () => {
  const now = new Date('2026-09-27T18:00:00Z');
  const e = env(
    { t: '2026-09-27T18:10:30Z', a: 7.9 },
    {
      now,
      platformAttr: (a) => ({ close_type: 'soft' })[a],
      categoryAttr: (a) => ({ herd_bid_count: 15 })[a],
      incrementLadder: (amount) => (cmp(amount, rat(100n)) >= 0 ? rat(25n) : rat(5n)),
    },
  );
  assert.ok(isExactly(evaluate({ floor: [{ var: 'a' }] }, e), 7));
  assert.equal(num(evaluate({ minutes_until: [{ var: 't' }] }, e)), 10.5);
  assert.equal(evaluate({ minutes_until: [null] }, e), null);
  assert.equal(evaluate({ platform_attr: ['close_type'] }, e), 'soft');
  assert.ok(isExactly(evaluate({ category_attr: ['herd_bid_count'] }, e), 15));
  assert.ok(isExactly(evaluate({ increment_ladder: [150, 'x'] }, e), 25));
  assert.throws(() => evaluate({ minutes_until: ['2026-09-27T18:00:00'] }, e), JsonLogicError);
});

test('collectVars lists variables and table lookups, for dependency walks', () => {
  const vars = collectVars({ and: [{ var: 'is_open' }, { '>': [{ platform_attr: ['bp_default_pct'] }, { var: 'constants.x' }] }, { minutes_until: [{ var: 'closes_at' }] }] });
  assert.deepEqual([...vars].sort(), ['closes_at', 'constants.x', 'is_open', 'now', 'platform.bp_default_pct']);
});
