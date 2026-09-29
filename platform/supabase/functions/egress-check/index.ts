// RETIRED 2026-09-28. This function was a one-off reachability test. Its first
// version sent a User-Agent containing the owner's personal email address to
// third-party sites, which was a privacy leak. It is replaced by this stub,
// which makes no outbound requests at all. The live probe is probe-sources,
// which identifies itself as WaystockBot with no personal details.
Deno.serve(() => Response.json({ retired: true, use: 'probe-sources' }, { status: 410 }));
