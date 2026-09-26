# Scraping, terms of service, and bidding

Not legal advice. This is an engineering risk assessment, written so the
architecture reflects the risk instead of discovering it later. Get a lawyer
before launch, specifically on §4 and §5.

---

## 1. Scraping public data is not, by itself, unlawful

The relevant US line of cases is *hiQ Labs v. LinkedIn*. The Ninth Circuit held
that scraping data that is **publicly accessible without authentication** does not
violate the Computer Fraud and Abuse Act, because there is no "access without
authorization" where no authorization gate exists.

What that does **not** get you:

- **Breach of contract is separate from the CFAA.** A site's terms of service can
  still prohibit automated access. Violating them is a contract claim, not a
  computer-crime one — but it is still a claim, and it is how sites actually come
  after aggregators.
- **Terms bind harder once you click through.** Scraping a page anyone can load is
  a weaker case against you than scraping after creating an account and accepting
  terms. This is a concrete architectural consequence: **never log in to scrape.**
  `sources.auth_required = true` should mean "deep link only", not "store
  credentials".
- **Copyright still applies to the content.** Facts are not copyrightable —
  a price, a close time, a lot number, a location. A 200-word lot description
  written by an auctioneer plausibly is. And their photographs definitely are.
- **Trespass to chattels / server burden.** Volume matters. A crawler that
  degrades a small auction house's site creates a real claim where a polite one
  creates none. This is the strongest practical argument for the adaptive
  scheduler in `schedule.ts`: politeness is also the legal defence.

---

## 2. What this implies, concretely

Each of these is implemented rather than aspirational.

| Practice | Where it lives |
|---|---|
| Check `robots.txt` before first crawl, and re-check periodically | `sources.robots_url`, `robots_checked_at`, `robots_allows` |
| **Refuse to crawl when `robots_allows` is null** — unknown is not permission | crawler precondition |
| Honour per-source rate limits | `sources.rate_limit_rpm` |
| Back off hard on failure | `backoffMinutes()` in `schedule.ts` |
| Identify the crawler honestly in User-Agent, with a contact URL | fetcher |
| Never authenticate in order to scrape | `sources.auth_required` routes to `deeplink_only` |
| Store facts; **link** to descriptions and photos rather than republishing them wholesale | see §3 |
| Keep an explicit per-source legal determination, reviewable by a human | `sources.ingest_allowed`, `ingest_note` |
| Honour opt-out requests within days | `sources.active = false` |

The `ingest_allowed` column deserves emphasis: it is a **human's** decision,
stored as data, separate from the technical question of whether a crawl would
work. An engineer adding a source cannot accidentally flip it.

---

## 3. Images: the one that will bite

Auction photographs are the auctioneer's copyrighted work. Our product needs them
for two different things, and the two have very different risk profiles:

**Displaying them** — hotlink, do not rehost. Show the image from the source's own
CDN with attribution and a link. This is how every aggregator and search engine
operates, it keeps the source's analytics intact, and it costs us no storage. If a
source blocks hotlinking, that is their answer and we respect it: show a
placeholder and the link.

**Embedding them** — this is the subtle one, and it is *more* defensible than
displaying, not less. Computing a CLIP vector is transformative analysis: the
768 floats are not a copy of the picture and cannot be used to reconstruct it. This
is closely analogous to the search-index copying upheld in *Authors Guild v.
Google*. We store the vector and the URL; we do not need to keep the file.

So the rule: **embed transiently, store the vector, never warehouse the pixels.**
`lot_images` has a `storage_path` column that should stay null in normal operation.
That is deliberate — it exists for the narrow case of a user's own uploaded
reference photo, not for source imagery.

---

## 4. Bidding on the user's behalf

This determines what the paid tier may honestly promise, so it needs to be stated
without optimism.

**eBay — possible, gated on paperwork.** The Offer API exposes `placeProxyBid`,
and using it is explicitly sanctioned. But it is a **Limited Release** API:
production access requires eBay's approval and a signed contract. So this is a
business-development task. Worth starting early, because the lead time is the
constraint, not the code. Note also that the existing production keyset is
currently **disabled** and needs enabling regardless.

**Everyone else — no public bidding API exists.** HiBid, Proxibid, GovDeals,
Wisconsin Surplus: none offer one. Three options, honestly ranked:

1. **Partner / affiliate integration.** The real answer. Auction houses want
   qualified bidders; a revenue-share that delivers them is a conversation they
   will take, and it is the only path that produces genuine one-tap bidding.
2. **Deep-link handoff with a pre-armed alert.** We hold the lot, the user's
   private ceiling and the close time; at T-minus-whatever we push a notification
   with a one-tap link straight to that lot. Breaks no terms, needs nobody's
   permission, ships now, and is honestly most of the value.
3. **Storing the user's credentials and driving their session.** Do not. It
   violates essentially every platform's terms, it gets **the user's** account
   banned rather than ours, and it transfers liability for a mis-placed bid onto
   us. A single bug becomes someone's $8,000 tractor.

**Consequence for pricing:** v1 paid tiers sell *more standing hunts,
photo-matched hunts, sub-minute alerts, and rival intel* — not bid placement.
Real bidding arrives per-platform as partnerships land. Better to know that before
a plan is priced around it.

---

## 5. Acting as "the middleman collecting a fee"

Worth flagging early, because it is the highest-regulatory-risk idea in the brief
and it is easy to walk into unknowingly.

There is a large difference between these two businesses:

- **A referral/lead-generation business.** We surface lots and send users to the
  auctioneer. Revenue from subscriptions and affiliate/referral fees. Low
  regulatory burden. This is what the architecture currently supports.
- **Acting as an auctioneer or bidding agent.** Taking a buyer's premium, bidding
  as an agent, or handling funds. **Wisconsin licenses auctioneers** (Wis. Stat.
  ch. 480; registration administered by the Department of Safety and Professional
  Services), and most states license auctioneers too. Handling buyer funds can
  additionally pull in money-transmitter obligations.

The instinct in the brief — "acting as the middleman just to collect a fee" — is
achievable, but **collect the fee from the user as a subscription, or from the
auctioneer as a referral commission.** Do not touch the bid or the purchase money.
The moment funds flow through us, the licensing and money-transmission analysis
changes completely and needs real counsel.

A concrete, cheap step: ask a Wisconsin lawyer specifically whether a
subscription-plus-referral model requires an auctioneer registration under ch. 480.
The answer is very likely no, and having it in writing is worth the hour.

---

## 6. Rival intelligence and privacy

We store the **pseudonymous alias the platform already displays publicly**
("Bidder 4821") and model its behaviour. We do not attempt to resolve an alias to a
person, and we should never accept a feature request to do so.

That line matters for two reasons. Legally, de-anonymisation of bidders is where a
defensible analytics feature turns into something that draws regulatory attention.
Practically, aggregate behavioural stats are what is actually useful — *"this
bidder strikes in the last 45 seconds"* — and identity adds nothing to it.

Worth noting: if the platform ever expands beyond the US, bidder aliases are
plausibly personal data under GDPR even while pseudonymous, which would require a
lawful basis and a retention limit. Not a v1 problem, but do not build in a way
that makes it unfixable.

---

## 7. Facebook Marketplace and Craigslist

Both: no public API, terms that clearly prohibit automated collection, and active
technical defences. Meta has litigated against scrapers repeatedly and
successfully.

**Do not ingest either.** Store a search-URL template, construct a deep link from
the user's hunt, and let them tap through. The user still gets the search; we take
on none of the exposure. `ingest_method = 'deeplink_only'` exists for exactly this,
and it is a feature rather than a limitation — a well-built deep link is genuinely
useful and carries zero risk.

---

## 8. The short version

| Do | Do not |
|---|---|
| Crawl public pages, politely, with a real User-Agent | Log in to scrape |
| Prefer official APIs and JSON-LD | Reach for a headless browser first |
| Store facts; link to prose and photos | Rehost descriptions or images |
| Embed images, keep only vectors | Warehouse source pixels |
| Deep-link to Marketplace and Craigslist | Scrape them |
| Charge subscriptions and referral fees | Handle bid or purchase funds |
| Model bidder aliases | De-anonymise bidders |
| Record a human's `ingest_allowed` call per source | Let "it worked" imply "it is allowed" |
