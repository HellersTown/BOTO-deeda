# Naming

> **Decision (2026-09-30):** the owner named the product **Skeuos**. The research below, which recommended PaddleUp, is kept as it was written.

Domain availability below was checked live against the registrar on
2026-09-26. Availability moves; re-check before buying.

---

## The constraint nobody thinks about until it bites: the TLD

This product's core function is **telling you something appeared**. That means
email and push deliverability is not a side concern, it is the product working or
not working.

`.bid` is a newer gTLD with a heavy spam history. Several corporate mail filters
and blocklist maintainers treat `.bid` sender domains as suspect by default.
For a business whose entire value is *"we email you the moment a lot appears,"*
shipping on a `.bid` domain means fighting the spam folder forever, on the one
feature you cannot afford to have fail.

So: **a `.com` is worth materially more here than the cleverness of the name.**
That single consideration reorders the whole shortlist and eliminates several
otherwise-strong candidates.

Availability results, verified:

| Domain | Status |
|---|---|
| `paddleup.com` | **available** |
| `lotwise.com` | **available** |
| `everylot.com` | **available** |
| `hammerhaus.com` | **available** |
| `gleanauctions.com` | **available** |
| `lotgleaner.com` | **available** |
| `siftauctions.com` | **available** |
| `thesleeperlot.com` | **available** |
| `glean.bid`, `gleaner.bid`, `sleeper.bid`, `birddog.bid`, `oddlot.bid`, `unearth.bid`, `driftless.bid` | available, but see the TLD warning above |
| `birddog.com`, `goingtwice.com`, `hammerdown.com`, `lothound.com`, `gavelhound.com`, `bidhound.com`, `sleeperlot.com`, `lotscout.com`, `underlot.com`, `lotline.com`, `gavelry.com`, `trovelot.com`, `rummage.app`, `allotment.app`, `paddleup.app` | taken |

---

## Recommended: **PaddleUp** — `paddleup.com`

The logic, in order of weight:

1. **It is a verb phrase, not a noun.** "Paddle up" is what you physically do to
   bid. The name is an instruction to act, which is what you want on a button, an
   app icon and a push notification.
2. **Instantly legible to the person you most need to onboard.** Your supply side
   is a 60-year-old auctioneer in Fond du Lac whose listings you want to index.
   "PaddleUp" needs no explanation to that person. "Glean" does.
3. **It says nothing category-limiting.** Not coins, not tools, not government
   surplus, not Wisconsin. You start in Wisconsin with federal surplus and you do
   not want the name to be a ceiling in year three.
4. **The `.com` is free**, which given the TLD argument above is worth more than
   any other tiebreaker.
5. **It survives being said out loud.** "It's on PaddleUp." No spelling, no
   hyphen, no "like the word but with a Z."

Weakness, stated honestly: it is warm rather than sharp. It does not by itself
communicate *aggregation* or *finding the thing nobody noticed*. It needs a
tagline to carry the thesis — which is normal, and cheap.

---

## The thesis pick: **Glean** — `gleanauctions.com`

If you want the name to carry the self-sufficiency idea rather than a tagline,
this is the one, and it is genuinely a better *idea* than PaddleUp.

**Gleaning** is the practice of gathering the crops left in the field after the
harvest. It is ancient, it is explicitly about taking real value that others
walked past, and it is culturally tied to thrift and self-reliance. Which is
precisely your stated thesis: *the government hawks a bunch of perfectly good
stuff it does not need, and people should stop buying new.*

It is also exactly what the image-search feature does: find the thing the
cataloguer walked past.

Weakness, and it is a real one: a meaningful share of users do not know the word.
A name you have to teach costs you something on every single acquisition. And the
bare `glean.com` is not available, so you are on `gleanauctions.com` or a `.bid`.

---

## The safe pick: **Lotwise** — `lotwise.com`

"Lot" is the auction unit; "wise" is knowing what it is worth. Clear, professional,
zero explanation needed, and the `.com` is free.

It is also the best name if you ever sell **to** auction houses — a dealer tool
called Lotwise sounds like software, whereas one called PaddleUp sounds like an
app for hobbyists. Worth weighing, because the dealer tier is where the revenue
per user is.

Weakness: it is the least memorable of the three. Nobody tells a friend about
Lotwise at a bar.

---

## Also viable

**EveryLot** — `everylot.com` available. Says the aggregation promise directly and
literally: every lot, one place. Slightly generic, and mildly over-promises.

**Hammerhaus** — `hammerhaus.com` available. The auctioneer's hammer plus a nod
to Wisconsin's German heritage. Distinctive, regional in a good way. Risks reading
as a brewery or a gym.

**Sleeper** — `sleeper.bid` only. A "sleeper" is the trade term for the
undervalued lot nobody noticed — perfect insider credibility, and the single most
accurate description of what the product finds. Ruled out of the top three by the
`.bid` deliverability problem and by collision with a well-known
fantasy-sports app of the same name.

**Driftless** — `driftless.bid` only. The Driftless Area is a real and
evocative Wisconsin region. Beautiful, but it geographically caps a product you
intend to run nationally, and it is `.bid`.

---

## Recommendation

**Take `paddleup.com`.** Then, if the self-sufficiency framing turns out to be
the thing that actually converts users, `gleanauctions.com` is cheap to hold as a
campaign or content domain alongside it.

Two things to do before committing:

1. **A real trademark search** — USPTO TESS plus a plain web search for each
   finalist in classes 35 (advertising/auctioneering) and 42 (SaaS). Domain
   availability says nothing about trademark risk, and "PaddleUp" is a plausible
   enough phrase that something adjacent may exist in payments or sports.
2. **Decide what happens to `waystock.org`.** You already own it and it is
   attached to the Vercel project. Cheapest path: keep it as a 301 redirect to the
   new domain so nothing already linked breaks.

The code is written so this decision is not load-bearing: the brand lives in one
config constant, and the directory is named neutrally. Renaming is a one-line
change plus a `git mv`, at any point.
