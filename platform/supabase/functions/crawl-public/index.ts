// crawl-public: public-sector sellers. Wisconsin Surplus Online Auction (the
// state's surplus sales), Public Surplus (schools, counties, cities, technical
// colleges), Municibid (municipalities), PropertyRoom (police property) and the
// Dane County Treasurer's tax-deed land sale.
//
// The engine is lib/edge/worker.ts, shared by every crawl-* function; this file
// only names the adapters this worker carries, keyed by sources.platform.

import { serveWorker } from './lib/edge/worker.ts';
import { publicSurplusAdapter } from './lib/adapters/public-surplus.ts';
import { wisconsinSurplusAdapter } from './lib/adapters/wisconsin-surplus.ts';
import { propertyroomAdapter } from './lib/adapters/propertyroom.ts';
import { municibidAdapter } from './lib/adapters/municibid.ts';
import { daneCountyTaxDeedAdapter } from './lib/adapters/dane-county-tax-deed.ts';

serveWorker('crawl-public', {
  'public-surplus': publicSurplusAdapter,
  'wisconsin-surplus': wisconsinSurplusAdapter,
  propertyroom: propertyroomAdapter,
  municibid: municibidAdapter,
  'dane-county-tax-deed': daneCountyTaxDeedAdapter,
});
