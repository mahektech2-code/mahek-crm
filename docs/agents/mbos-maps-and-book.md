# Handset map, Ola key pool, the handset book

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE HANDSET MAP IS OLA MAPS, the same supplier the console uses.** Two map
suppliers is two bills, two outages and two answers to "why does this shop sit
in the wrong lane". `sales/ola-maps.tsx` records the style quirks the web hit;
the handset uses the same style URL and the same key, which now travels in the
sync payload.

**That key is the SECOND named exception in `lib/secrets.ts`, and the caveat is
not the same as the first.** A tile key has to reach whoever asks for tiles — a
key that never left the server could not load a street — and the browser's
mitigation is to restrict it to a domain. A phone has no domain, and Ola's
console offers no package-name or signing-certificate restriction of the kind
Google Maps has. So a key in an APK is extractable, and the honest mitigations
are a SEPARATE Ola key for the handset, revocable without taking the console's
maps down, and a spend cap on it. It is sent only to a device already
authenticated as a bound handset, which is the most the server side can do.

**THE OLA KEY IS A POOL OF FIVE, SPENT ONE AT A TIME.** `olamaps.apiKey`
through `olamaps.apiKey5` are five accounts' keys and MahekOne spends the first
until Ola refuses it for quota, then the second. NOT round-robin: spreading
constant load across several accounts of one organisation is the pattern a
provider acts on, and it would put every account near its ceiling at once
instead of leaving four at zero, where an exhaustion is attributable to exactly
one of them. **Exhaustion is OBSERVED, never counted** — `classifyOlaAnswer` in
`engines/ola-key-pool.ts` retires a key on a 429 or a 403 that SAYS it is about
a limit, and on nothing else: a 400 is Snap-to-Road's batch ceiling, a 401 is a
key somebody mistyped, a timeout is weather, and a local request counter that
drifted either way would abandon a good account or keep calling with a dead
one. **A retired key comes back** on `maps.olaKeyCooldownHours` and, whatever
that says, from the first of the next month, because a quota is monthly — it is
read as an earlier month's refusal rather than cleared by a job, so nothing has
to fire on the right night. `ola_key_health` is where that is remembered, keyed
on the credential's NAME and not on `app_secrets`, because a key may come from
the environment and have no row there; it is not `app_settings`, because
nobody decided this and there is nothing to audit. **A BROWSER CANNOT FAIL OVER
MID-SESSION** and nothing pretends it can: the page is handed whichever key is
live at RENDER, a reload picks up the change, and where every key is spent it
is handed none and the map says THAT rather than "add a key" — two silences,
two sentences. **ONE KEY COSTS WHAT IT ALWAYS DID**: `olaGet` short-circuits on
a pool of one — no health read, no retry, no notification — because production
holds one key and insurance that taxed the uninsured case would be a price paid
daily against a risk nobody has run.

**A PIN IS ONLY DRAWN WHERE THERE IS A FIX, and what could not be drawn is said
in words.** Half this book has never been pinned. Spacing those shops out to
fill the screen is the one thing a map of where things are must not do, and a
map that silently omits a third of the book is one somebody plans a day from and
is wrong. NO MAP is an answer too: with no key configured the screen says so
rather than drawing a grey rectangle, which is the rule the microphone already
follows.

**The tap means a different thing on each SCREEN, not in the component.** On the
customers list it opens the record; on the journey picker it picks a stop. The
map takes a handler, so neither screen has to know the other exists — and MapLibre
React Native's `LngLatBounds` is `[west, south, east, north]`, which is GeoJSON's
order and NOT the `ne`/`sw` pair the web's MapLibre GL takes. Two libraries, two
orders, and getting it wrong opens the map on the wrong hemisphere rather than
failing.

**A LEAD IS A ROW IN BOTH HANDSET TABLES, so the book's view asks an EXISTS.**
The office collapsed leads and customers into one `customers` row long ago, and
the wire still sends leads down their own channel into `leads` keyed on the same
id — so "is this a lead" on the handset is a correlated subquery against that
table, never a column read. `archived = 0` is part of it: an archived lead is
one filed out of the way, and letting it remove a shop from the Customers view
too would leave that shop on no screen at all.

**AND THE CARD SAYS WHICH IT IS AND WHICH RUNG, because "Lead" alone answers a
question nobody asked.** A salesman reading this list is choosing between a
Suspect he has visited twice, a Prospect that owes him a qualification and a
shop already in Negotiation, and those are three different mornings. The rung
lives in `leads`, so `LEAD_FACTS` selects it — the same `EXISTS` the chips
filter on, plus the two stage columns, as correlated subqueries rather than a
`LEFT JOIN`, because both tables carry `id`, `name` and `city` and a join makes
every bare column in the builder ambiguous. `accountLine` composes the words
from `stageOf`, the SAME resolver `/lead` draws its ladder from, so the list and
the record cannot disagree about one shop.

**A LEAD'S CARD OPENS `/lead`, and everything else opens `/customer`.** Both
went to `/customer`, which for a lead is a page of empty ledgers and — far
worse — the only screen in the app with no route to the funnel on it. The
ladder, the §28 gates and both forms are on `/lead`, and `/leads` was the single
door to them, so a salesman who found a shop through the tab he already had open
could neither see its rung nor move it. The record carries a link back the other
way, for arrivals from search, a journey stop or a visit.

**These three rules are PURE and live in `lib/account-label.ts`,** the handset's
counterpart to MahekOne's own `lib/account-types.ts` and pure for the same
reason. They were in `data/customers.ts`, which imports the database — so
nothing that decided the words on four hundred rows a day could be tested
without a handset, which is exactly how the `customerStage` bug below survived.

The Everything / Customers / Leads chips are a VIEW and not a scope. All three
show only his own book, already narrowed to the territory he works, and nothing
there reaches another salesman's. They sit beside the origin chips rather than
inside the filter sheet because they change what the list IS, and a list whose
subject is hidden behind a menu is one people misread.
