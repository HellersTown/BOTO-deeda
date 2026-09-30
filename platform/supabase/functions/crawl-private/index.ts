// crawl-private: private auction houses on their own bidding platforms.
// BidWrangler tenants (Hansen Auction Group), keyed by sources.platform; each
// tenant is one sources row whose api_base names its bidding host.
//
// The engine is lib/edge/worker.ts, shared by every crawl-* function; this file
// only names the adapters this worker carries.

import { serveWorker } from './lib/edge/worker.ts';
import { bidwranglerAdapter } from './lib/adapters/bidwrangler.ts';

serveWorker('crawl-private', {
  bidwrangler: bidwranglerAdapter,
});
