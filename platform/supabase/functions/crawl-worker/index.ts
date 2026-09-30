// crawl-worker: official APIs (GSA Auctions).
//
// The engine is lib/edge/worker.ts, shared by every crawl-* function; this file
// only names the adapters this worker carries, keyed by sources.platform.
// Workers are split by platform family so each deploys on its own and runs in
// parallel with the others on its own time budget.

import { serveWorker } from './lib/edge/worker.ts';
import { gsaAdapter } from './lib/adapters/gsa.ts';

serveWorker('crawl-worker', {
  gsa: gsaAdapter,
});
