import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKnownState } from '../src/known.ts';

test('reads the compact rows crawl_known_state answers', () => {
  const k = parseKnownState({
    lots: [
      ['26044401', '168337', 1790800000000, 1790809440000],
      ['26044402', null, 1790800000000, null],
    ],
    auctions: [
      ['168337', 1790790000000, 195],
      ['169893', null, null],
    ],
  });
  assert.deepEqual(k, {
    lots: [
      { externalId: '26044401', auctionExternalId: '168337', lastSeenAt: 1790800000000, closesAt: 1790809440000 },
      { externalId: '26044402', auctionExternalId: null, lastSeenAt: 1790800000000, closesAt: null },
    ],
    auctions: [
      { externalId: '168337', itemsReadAt: 1790790000000, itemsReadCount: 195 },
      { externalId: '169893', itemsReadAt: null, itemsReadCount: null },
    ],
  });
});

test('drops malformed rows instead of guessing, and refuses a malformed answer', () => {
  const k = parseKnownState({
    lots: [['', '1', 1, 2], ['x', '1', 'soon', 2], 'row', ['ok', '1', 5, 'later']],
    auctions: [[null, 1, 2], ['a', 'yesterday', 3.7]],
  })!;
  assert.deepEqual(k.lots, [{ externalId: 'ok', auctionExternalId: '1', lastSeenAt: 5, closesAt: null }]);
  assert.deepEqual(k.auctions, [{ externalId: 'a', itemsReadAt: null, itemsReadCount: 3 }]);
  assert.equal(parseKnownState(null), null);
  assert.equal(parseKnownState([]), null);
  assert.equal(parseKnownState({ lots: [] }), null);
});
