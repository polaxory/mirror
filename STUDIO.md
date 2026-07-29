# Polaxory Studio Code

Ten bullets, after Tom Sachs. His are a studio's rules of conduct — how to work,
not what to make. These are ours, translated. Each one names a rule, then names
where in this repository the rule is actually enforced. A principle with no
enforcement point is decoration, and decoration is the one thing this studio does
not ship.

Read this before touching the code. Read it again before adding a feature.

---

## 1. Work to code

Do it the studio way, not your way. Consistency beats individual preference,
every time, including when your way is better in isolation.

**Enforced at:** `mirror/api/_lib/engine.js` opens with five design rules and the
pipeline in one line. Every stage of that pipeline is a pure exported function in
the declared order. New behavior joins the pipeline; it does not sneak in
sideways. Parameters live in exactly one file — `reference.js` — and nowhere else.
If you find a tuned constant outside that file, it is a bug regardless of what it
computes.

## 2. Sacred space

Zones have jobs. Keep them clean, and never let one do another's work.

**Enforced at:** three zones, no crossings.
- `api/_lib/` — the analytical core. Everything here is pure — no network, no
  clock, no environment; same input, same output, forever — **except for files
  explicitly named as I/O adapters, which fetch and return data and never reach
  back into the core.** Today those adapters are `store.js` (cohort persistence),
  `prices.js` (open-position marks) and `chain.js` (Helius reads). Every other file
  is pure, which is why the engine can consume a measured cohort of thousands of
  wallets, live market prices, and dozens of holder histories without ever learning
  that a database or an HTTP client exists.
  *(This bullet has been corrected twice: it named `store.js` as "the single
  sanctioned exception", then "exactly two files". Both became false. It is now
  phrased as a **rule about kinds** rather than a count, so it stays true when the
  next adapter arrives — a rule that needs rewriting every time the repo grows was
  the wrong rule.)*
- `tests/` — the proving ground. Generates truth, checks the core against it.
- `src/` — the surface. Renders what the engine returned. It never computes a
  metric, never derives a verdict, never rounds a number into a different claim.

The core can be lifted out and dropped into a worker, a cron, or a B2B endpoint
without touching a line, because it never knew where it was running. When the
cohort layer arrived, this bullet is why it cost one parameter instead of a
rewrite: ladders are *injected*, never imported.

## 3. Be on time

Being early is on time. Being on time is late. But also its inverse, which is the
harder discipline: **do not speak before the evidence arrives.**

**Enforced at:** confidence tiers in `reference.js`, gating in `buildFindings`
and `buildScore`. Under 8 closed trades, nothing is scored. Under 20, no claim
about edge. A finding appears only when its 95% interval clears the neutral
value. A thin history produces silence, and silence is a finished state, not a
missing feature.

## 4. Thoroughness counts

Especially in the parts nobody sees. The back of the cabinet gets sanded.

**Enforced at:** the deterministic RNG (`mulberry32` seeded from the wallet
address) so bootstrap intervals reproduce and a screenshot stays true. The toll
figure carrying an explicit *lower bound* caveat because pool-to-interface fees
never enter the wallet. Every stated prior citing its source. `tests/validate.mjs`
proving the 95% intervals actually cover the truth 96.8% of the time across 400
synthetic wallets, because an interval nobody measured is a decoration.

## 5. I understand

In Sachs' studio you don't nod — you say the words, out loud, so the sender knows
the message landed. Acknowledgment is a required return value.

**Enforced at:** `tests/validate.mjs` is the engine saying "I understand." It is
handed wallets whose behavior is known by construction and must state that
behavior back within tolerance. 123 assertions. The engine does not get to claim
it measures disposition; it has to recover a planted disposition ratio of 48 to
within 5%. Same rule for the operator: `tests/sweep.mjs` exists so a human can
read the whole spectrum in one screen and confirm the machine still makes sense.

## 6. Sent does not mean received

A number displayed is not a number understood. Delivery is the sender's problem.

**Enforced at:** every metric ships on three channels — the value, its interval
or sample size, and a plain-language verdict with an icon. `Panels.jsx` renders
all three or none. The percentile bar exists so a figure that means nothing in
isolation ("disposition 8.7x") lands as a position among peers. The diagnosis
matrix exists because "expectancy −0.13" is received by nobody, and "clean
process, wrong picks — that is a selection problem, not a discipline problem" is
received by everybody.

## 7. Keep a list

Write it down. The list is external memory, and memory that lives in one head is
a single point of failure.

**Enforced at:** `BUILDLOG.md` — every step, dated, **including the failures and
what they taught.** Two engine bugs are recorded there in full because the record
of a wrong turn is more useful than a clean history that never happened. Also
`result.trades` — the user gets the ledger, not just the verdict, because their
audit is the same right as ours.

## 8. Always be knolling

Arrange everything at 90 degrees, like with like, so anyone can find anything
without asking. Knolling is not tidiness. It is the elimination of search cost.

**Enforced at:** one job per file, and the name says the job — `stats.js` does
statistics, `reference.js` holds every tuned parameter, `fmt.js` formats,
`synth.js` fabricates test wallets. In the interface: one shape for a scorecard
row, one shape for a behavioral row, one fill hue for every meter (a second blue
was removed for sitting at ΔE 1.9 from the violet under protanopia — like with
like means *readably* like), tabular numerals so columns align down the page.
Ordering follows use, not logic: the verdict leads, the confidence qualifier
rides beside it, the depth waits below. That reorder happened *because* of this
bullet.

## 9. Sacrifice to Leatherface

The bandsaw will take a finger. Respect it out loud; do not pretend it is safe.

**Enforced at:** the danger register below. These are the tools in this shop that
can take a finger, and the rule for each is a refusal, not a mitigation.

| Danger | Rule |
|---|---|
| Custody of user funds | Never. No key handling, no pooled deposits, no vaults. Killed Unibot; nearly killed the category. |
| Auto-execution of our reads | Never. *In re Weiss Research* is the exact tripwire: the publisher exclusion dies the moment a newsletter drives a trade. Signals may inform; they may not fire. |
| "Expected profits" language | Never, in any public copy. It is Howey's fourth prong, verbatim. |
| Personalized advice | Never. Impersonal, regularly published, identical for everyone who asks. |
| Unmeasured priors presented as measured | Never. Provenance is reported per metric and rendered per bar: solid = measured, hatched = prior. A quantile is measured only when the cohort can carry it, and the payload stamps which basis it used. |
| A mark presented as an exit | Never. Every marked position also carries what selling it would actually return, from constant-product pool arithmetic against that position's own size. A bag worth more than its pool is flagged, and the row shows the sign flip. Spot value on an illiquid memecoin is the number a user would actually act on, which makes it the most consequential place to overclaim. |
| A live input changing a historical measurement | Never. Prices feed the open-position disclosure and nothing else — no metric, finding, diagnosis or score reads one. A behavioral read that moved when an API went down would not be a measurement, and a test asserts the whole read is byte-identical under wildly disagreeing price books. |
| Storing wallet addresses in the cohort | Never. Dedupe needs identity; the reference distribution does not need to know whose wallet it was. Salted hash prefix only. |
| Internal access to behavioral data | Logged and least-privilege from day one. Axiom lost real credibility to an employee reading user wallets. |

## 10. Persistence

Keep going. The version you are looking at is not the version.

**Enforced at:** the version ladder is explicit and public. v0 was a shell that
rendered a verdict it had not earned. v1 earned it: intervals, shrinkage,
attribution, counterfactuals, a diagnosis with two axes, and a harness that
proves the claims. v2 is in `BUILDLOG.md` under *Next*. Each version is a small
step, memorialized, then taken again.

---

## The finish: show the seams

Sachs builds a lunar module out of plywood and foamcore and leaves every screw,
every pencil line, every hand-lettered label visible — and it moves you more than
the real thing, because you can see every decision that made it.

Every other product in this market hides behind a polished black box: a score
with no formula, a "smart money" label with no method, a win rate with no sample
size. Polaxory does the opposite, and not out of modesty. **The visible seams are
the finish.**

- The formula is printed under the score it produces.
- The priors are labeled unmeasured, with the version stamped in the payload.
- The assumptions and limits ship inside the product, not in a footnote nobody links.
- The trade ledger is exposed so the arithmetic can be checked against the wallet.
- The toll is called a lower bound because that is what it is.

This is why "methods public, parameters private" is a studio position and not a
marketing line. The plywood shows. The joinery is the point. A user who can see
how the machine reached its verdict can argue with it — and a user who can argue
with it is the only kind who can learn anything from it.

---

## For the operator

You are building a strange machine. Someone will inherit it — a collaborator, a
buyer, or you in eight months with no memory of today. The code above is what
lets them walk in and find the bandsaw before it finds them: zones that declare
their jobs, one file per concern, parameters in one drawer, a log of every wrong
turn, and a harness that will tell them in ninety seconds whether they broke
something.

Follow the code and the mess stays navigable. Ignore it and you will have built
something only you can operate, which is the same as having built nothing.
