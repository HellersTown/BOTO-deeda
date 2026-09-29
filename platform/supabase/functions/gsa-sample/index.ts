// RETIRED 2026-09-28. This function captured the live GSA API shape once (the
// capture now lives in packages/ingest/test/fixtures/gsa-live-2026-09-27.json).
// Real ingestion is crawl-worker. This stub makes no outbound requests.
Deno.serve(() => Response.json({ retired: true, use: 'crawl-worker' }, { status: 410 }));
