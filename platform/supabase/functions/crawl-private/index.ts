// crawl-private: private auction houses. BidWrangler tenants (Hansen Auction
// Group), each one sources row whose api_base names its bidding host; and
// AuctionGuide, a directory of private sales, ingested as sale-level rows.
//
// The engine is lib/edge/worker.ts, shared by every crawl-* function; this file
// only names the adapters this worker carries, keyed by sources.platform.

import { serveWorker } from './lib/edge/worker.ts';
import { bidwranglerAdapter } from './lib/adapters/bidwrangler.ts';
import { auctionguideAdapter } from './lib/adapters/auctionguide.ts';

serveWorker('crawl-private', {
  bidwrangler: bidwranglerAdapter,
  auctionguide: auctionguideAdapter,
});
