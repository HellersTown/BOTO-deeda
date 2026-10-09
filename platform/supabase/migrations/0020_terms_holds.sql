-- 0020: sources whose terms of use forbid our crawler are held until the owner
-- decides or the operator gives written permission.
--
-- The terms were read on 2026-09-30 through inspect_url, as WaystockBot, and are
-- quoted in docs/08. The rule applied is the one already applied to HiBid in
-- 0019: where a site's own terms expressly forbid automated collection, the
-- crawler does not run until the owner decides; deep links stay available.
-- ingest_allowed is the single switch claim_due_sources checks, so a held source
-- is never claimed. Nothing already stored is deleted: the app is not public,
-- and removing data is the owner's call, not the crawler's.
--
-- PropertyRoom and Hansen Auction Group stay on. Neither forbids automated
-- access; both restrict redisplaying their content or media, which matters when
-- the app is published, not while it is being built.

update sources
   set ingest_allowed = false,
       terms_url      = 'https://www.publicsurplus.com/sms/all,wi/login/plainTermsAndConditions',
       ingest_note    = 'Held 2026-09-30. Buyer Agreement §1.5(v): "You will not use any robot, spider, other '
                        || 'automatic device, or manual process to monitor or copy our web pages or the content '
                        || 'contained herein without our prior express written permission." Needs written '
                        || 'permission or an owner decision.'
 where slug = 'public-surplus';

update sources
   set ingest_allowed = false,
       terms_url      = 'https://wisconsinsurplus.com/terms-2/',
       ingest_note    = 'Held 2026-09-30. User Agreement, Legal 21: "You agree that you will not use any robot, '
                        || 'spider, other automatic device, or manual process to monitor or copy the Site or the '
                        || 'content contained herein without Wisconsin Surplus'' prior, express written permission." '
                        || 'Needs written permission or an owner decision.'
 where slug = 'wisconsin-surplus';

update sources
   set ingest_allowed = false,
       terms_url      = 'https://info.municibid.com/terms',
       ingest_note    = 'Held 2026-09-30. Terms (updated 05/04/26) §c prohibit "Accessing or attempting to access '
                        || 'the Website through automated means" and "Scraping, reproducing, republishing". The MCP '
                        || 'connector is not carved out; the terms name only "a separate written agreement".'
 where slug = 'municibid';

update sources
   set terms_url   = 'https://help.propertyroom.com/support/solutions/folders/44001196790',
       ingest_note = 'Terms read 2026-09-30: no clause on automated access. Conduct of Users forbids '
                     || 'redelivering "any content using framing, hyperlinks, or other technology" without '
                     || 'written permission, so a public app should link out rather than show their photos.'
 where slug = 'propertyroom';

update sources
   set ingest_note = 'Terms read 2026-09-30 (per-auction Terms; no site-wide page): no clause on automated '
                     || 'access. "Media used on Hansen Auction Group''s bidding platform or marketing platforms '
                     || 'cannot be used by customers." BidWrangler''s platform terms could not be retrieved.'
 where slug = 'hansen-auction-group';
