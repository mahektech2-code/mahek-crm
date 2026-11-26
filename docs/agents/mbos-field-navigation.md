# Journey pick lists, nearby, navigation

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE AGREED CITY IS A HARD FILTER on the pick list, and that overruled us.**
It used to rise to the top without filtering, on the reasoning that a man going
to Nagpur often has one call to make on the way. Mahek's answer is that a day is
a city; the call on the road is added from the customers list or made unplanned
with a deviation reason, which is what that field exists for. The sort is
NEAREST rather than longest-unseen for the same kind of reason — a man filling a
Tuesday morning in one town is choosing a walking order.

**WHAT "NEAREST" IS MEASURED FROM is the part that had to be got right.**
`pickOrigin`: for TODAY it is where he is standing; for any other day it is the
CENTROID of our shops in that city. He picks tomorrow's doors at home, so his
fix is his sofa — and sorting Wardha by distance from a sofa in Nagpur puts the
list very nearly upside down. The centroid needs no geocoding service, no
connection and no city-centre table, and is the better answer anyway: the middle
of our business in that town rather than the middle of the town. With neither a
fix nor a pinned shop it returns null and the caller keeps the old ordering — a
list sorted around an invented origin looks right and is wrong.

**A shop with no pin sorts LAST rather than being dropped**, the same rule the
route engine follows and for the same reason: a shop missing from the day's list
is a shop nobody visits and nobody ever finds out why.

**"WHAT IS NEAR ME" IS ORDERED BY WHAT IS WORTH DOING, not by distance.**
The mapping brief says so in as many words, and `engines/nearby.ts` is the one
place that rule lives: distance is a COST subtracted from what a stop is worth,
never the sort key. A shop with NO reason is dropped rather than listed —
"nearby" is a list of what to do, and the whole book is a different screen
answering a different question. Proximity decides exactly one thing: which of
two shops with the same reason to go to first.

It is deliberately NOT a second copy of the Call Log's ranking. That engine
weighs a promise against a debt against a stock check to order four hundred
names for a telecaller working down a list; this answers "of the eleven shops
within three kilometres, which one now". Re-deriving the first here would be a
scoring system drifting from a scoring system, invisible until two screens
disagree about one shop. **Next Best Visit is the HEAD of that list**, not a
second sum, so the button and the list can never recommend different shops.

**And it needs no map.** Every coordinate, cycle, debt and open task is already
on the handset, so this works with one bar in a market lane — which is the only
moment anybody asks. The map itself stays blocked on a native dependency and a
new APK; the ANSWER was never blocked on either.

**Navigate is a deep link, and that is the whole feature.** No dependency, no
key, no bill, no tile ever fetched. `engines/route.ts` orders a day by
straight-line distance and says in its own header that it is not a routing
service — real turn-by-turn needs a road network, a directions API and a
connection, and the phone that most needs directions has one bar. An app that
has already downloaded the roads beats all of that, free.

**AND IT WAS DRAWN EVERYWHERE EXCEPT ON THE ROAD.** The button existed on the
journey screen from the day it shipped — in the arm of the ternary that renders
BEFORE he sets off. Pressing "Start visit" swapped that card for the open-leg
one and took navigation away with it, and the On-your-way screen, which is the
screen a salesman is looking at while he is actually travelling, never had one
at all. So the deep link was offered at every moment except the only one it is
for. `components/ui/navigate.tsx` is the one control now, in two shapes for two
layouts and one behaviour: a second inline `openMaps` call site is how the
failure message on one of them stops matching the other.

**WHAT THAT SCREEN LACKED WAS A DISTANCE, and it is WORDS rather than tiles.**
"Is this shop round the corner, or has the book got it in the wrong town" is the
question a man on a bike is asking, and an in-app map answers it worse than a
sentence does: it can draw a straight line between two dots and cannot say which
road, and it costs tiles and battery on a moving handset to say less than the
maps app he already has. `navigationLine` prints `distanceLabel` — the same
words the check-in refusal quotes back at him at the door, so the two cannot
phrase one distance two ways. **A stale reading carries its age** rather than
passing as live: while he is moving the gap grows, and "4.1 km away" from a fix
taken before he set off is a lie by the time he reads it. **A shop with no pin
says so**, because `openMaps` then searches the name and the town — which is a
good answer and a DIFFERENT one, landing him near a name rather than on a
doorway, and roughly half this book has no coordinate.

**The radio runs on a cadence there, which it does nowhere else.** The
On-your-way screen exists only while somebody is travelling and closes the
moment he says he is here, so a fix every twenty seconds costs a few minutes of
a ride rather than a day — and `getFix` remembers what it takes, so the check-in
gate at the end of the journey gets a warm fix instead of standing at a door
waiting for a cold one. It is BALANCED at range and PRECISE under a kilometre:
past that the figure answers "is it worth going" and the rounding throws the
accuracy away anyway, and inside it the figure has become "which doorway", which
a reading good to a city block cannot answer. Neither the cadence nor that range
is in the registry — nothing is priced, refused or paid on either. What IS
configuration is `mbos.location.activityFixMaxAgeSeconds`, because that decides
what a screen ASSERTS about a reading rather than how often one is taken.

**A VISIT THAT NAMES NO STOP STILL MARKS THE STOP IT WAS.** Stop rows are
minted on the server from the picks and reach the phone on the next pull, so
a man who picked offline and walked into the first shop sent a visit with no
`journeyPlanStopId` — and the office counted the stop he planned and made as a
miss. `handleVisit` now finds it by what it is: his plan on the visit's
Asia/Kolkata date (named in the SQL), this shop, still `planned`, earliest in
the walking order; marks it visited and binds the visit to it
(`journey_plan_stop_id`, `was_planned`). A stop already visited or skipped is
left alone.

**A STOP IS SKIPPED FROM THE PHONE, WITH A REASON.** `stop_skip` (op `update`,
entityId = the stop id, payload `{ id, reason }`). The stop must be on one of
HIS plans (checked through the plan, never trusted from the id). The verdict
is pure, `stopSkipVerdict`: a VISIT WINS — a visited stop is never moved to
skipped and the skip is accepted as nothing to do; a second skip changes
nothing, its reason included; no reason is refused. The write is guarded by
`status = 'planned'` so a visit landing in between wins. His manager is told.

**A DAY HE PLANNED THAT CLASHES WITH AN OFFICE PROPOSAL IS ADOPTED, not
refused.** One row per person per day stays the rule, so his `plan_day` create
loses the race — and it used to come back `duplicate`, which stranded his
picks as `plan_stops` against an id the office never held, retrying for ever.
`adoptClashingDay` accepts it with `serverId` = the office's day; a `serverId`
different from the item's id is the handset's signal to rename its local day
and repoint what is queued against it. Planning the SAME city the office
proposed (trimmed, case-insensitive) is his agreement and is recorded exactly
as one (`mbos.journey.answered`, `via: planned_on_phone`, the manager told); a
different city moves nothing — the proposal waits, and `plan_stops` against it
is refused with a sentence sending him to answer it on the Journey tab.

**The handset half of those three.** `adoptPlanDay` (data/journey.ts), called
by the sync engine on an accepted `plan_day` create whose `serverId` differs
(`adoptsServerId`), renames the local day — or folds its picks into the
office's row if a pull brought it first — and repoints every outbox row still
under the old id, payload `id` and `dependsOn` included. `pickShops` now
depends on the day's create WHERE that create is still in the outbox, so a
refused create blocks the picks with a reason instead of leaving them retrying;
and `landedDependencies` (sync/ordering.ts) never holds an item behind its OWN
id, because `plan_stops` shares its id with the day it waits on. The Next stop
card offers "Skip, with a reason" (`skipStop`, local first, queued as
`stop_skip`), and the card moves on. A day still with the office lists its
picked shops with Start visit on the Journey card, and the Journeys day sheet
reads the queued picks instead of "No shops picked yet".

**Navigate needs `<queries>` on Android 11+.** `openMaps` asks
`canOpenURL('google.navigation:…')`, and package visibility answers false for
any scheme the manifest has not declared — so Navigate always fell through to
the browser's maps page. `plugins/withNavigationQueries.js` declares
`google.navigation`, `geo` and `whatsapp` by scheme on every prebuild.
