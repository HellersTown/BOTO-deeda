import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayClaimAnother, runWeight, LIGHT_LOTS } from '../src/claimBudget.ts';

// Runs as the worker recorded them on 2026-10-08/09 (lots read, open lots held).
const hansen = { lots: 2240, known_lots: 6421 };
const hansenReadNothing = { lots: 0, known_lots: 6421 };
const hueckman = { lots: 1167, known_lots: 1167 };
const bennett = { lots: 2095, known_lots: 2095 };
const premier = { lots: 255, known_lots: 255 };
const peoples = { lots: 10, known_lots: 10 };
const auctionguide = { lots: 240 };

test('the first claim is always allowed', () => {
  assert.equal(mayClaimAnother([]), true);
});

test('nothing follows a large house: the four CPUTime kills were Hansen claimed second', () => {
  // 23:58 and 01:13 UTC: Hueckman then Hansen (2,012 ms), Bennett then Hansen (2,008 ms).
  assert.equal(mayClaimAnother([hueckman]), false);
  assert.equal(mayClaimAnother([bennett]), false);
  assert.equal(mayClaimAnother([hansen]), false);
});

test('a run that read nothing still weighs what its source holds', () => {
  // Hansen used 1,052 ms of CPU on a run that read no lots.
  assert.equal(runWeight(hansenReadNothing), 6421);
  assert.equal(mayClaimAnother([hansenReadNothing]), false);
});

test('small sources chain until they add up', () => {
  assert.equal(mayClaimAnother([premier]), true);
  assert.equal(mayClaimAnother([premier, peoples]), true);
  assert.equal(mayClaimAnother([premier, peoples, auctionguide]), false);
});

test('a failed run ends the invocation, since its cost is unknown', () => {
  assert.equal(runWeight({ error: 'network error fetching example.com' }), Infinity);
  assert.equal(mayClaimAnother([peoples, { error: 'crawl_run_start: timeout' }]), false);
});

test('the limit is exclusive and adjustable', () => {
  assert.equal(mayClaimAnother([{ lots: LIGHT_LOTS - 1 }]), true);
  assert.equal(mayClaimAnother([{ lots: LIGHT_LOTS }]), false);
  assert.equal(mayClaimAnother([bennett], 5000), true);
});
