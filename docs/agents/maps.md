# Live map, territory map, snapping, offline maps

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**The Live map has streets under it, and it started with none.** The
original reasoning was that tiles meant sending Mahek's salesmen's coordinates
to whoever supplies them, on every render, plus a key and a bill, to answer a
question nobody was asking — so it shipped as pins on a bare equirectangular
projection of the team's own bounding box instead. OpenFreeMap answered two of
those three objections outright — no key, no account, no bill, no usage
limit — and was the first supplier. It is Ola Maps now: once the map needed a
key anyway, for Snap-to-Road, running two tile suppliers for one screen was
two things to keep coverage and reliability current on. The pins themselves
are drawn from MahekOne's own data and never leave it; a tile server is only
ever asked for squares of map, never a coordinate. Two views, because they
answer two questions: where they are NOW is the morning one, and everywhere
they went TODAY is the evening one.

**And that key is the one exception to how every credential here is read.**
`readSecret` — see AGENTS.md's own note on it, in `lib/secrets.ts` — is read
once, server-side, by the request about to spend it, and never otherwise
leaves the server; a map tile key cannot follow that rule, because the
BROWSER is what repeatedly asks Ola Maps for tiles as somebody pans and
zooms. `page.tsx` reads it once and hands it down as a plain prop, and
nothing downstream asks for it again. This is true of every tile
provider — Mapbox, Google, Ola — and the mitigation is the standard one:
restrict the key to this deployment's own domain in Ola Maps' own console,
so a copy seen in a browser's network tab is not spendable anywhere else.

**Without a key there is no map, and the screen says so rather than drawing
one broken.** Every tile request would fail the moment there is nothing to
attach to it, so `street-map.tsx` does not attempt to build one: no key gets
its own state, pointing at Admin Console → Integrations, on both views —
the team list beside it is unaffected either way.

**The renderer is MapLibre and the supplier is a URL.** `STYLE` in
`street-map.tsx` is the one line that names the tile supplier; if Ola Maps'
coverage of a beat turns out to be thin, or terms change, swapping the
supplier is an edit to that constant and its `transformRequest` rather than a
rewrite. That `transformRequest` — appending the key to every request except
an image tile — is not a workaround invented here: it is read out of Ola
Maps' own published web SDK source, which does exactly this internally. The
map's own Mercator projection and `fitBounds` replaced the hand-rolled
equirectangular one — the FIT-not-FILL rule survives every change of
supplier: one pin gets `MAX_FIT_ZOOM` instead of a rooftop, and every point on
the screen, trail and activity marks included, is folded into the same bounds
so a six-kilometre walk and a five-hundred-metre one are never drawn at the
same scale by accident.

**A pin is only drawn where there is a fix.** The design mock spaces salesmen
out arithmetically, which is fine in a picture of a screen and a lie on a real
one. Somebody with no position today is in the team list saying exactly that and
nowhere on the map — inventing a spot for them is the one thing a map of
where people are must not do. The list reads the newest of the trail, the
check-in and each visit, so somebody whose tracking is off still appears.

**A VISIT IS NUMBERED AND NAMES ITS SHOP; every other act is still a dot.**
Every mark on the day was one identical circle labelled with its kind, so
"Visit" answered the question nobody was asking — a manager reading a day
already knows his salesman made visits, and what he cannot see is WHICH shops
and in what ORDER. The numbering is per SALESMAN, because it is the order of
his own day: two men on one screen both have a Visit 1, and the card names the
shop. `lib/engines/visit-marks.ts` is the rule, pure like every engine here,
because the map that draws it is a client component that cannot import
anything declared beside `server-only` — and because a rule deciding the
number on four hundred pins a day should be exercisable without a map key.

**It counts the PINS, and the card carries the clock for that reason.** A visit
made where the handset could get no fix is on no map at all — there is nowhere
to put it, and inventing a spot is the one thing a map of where things happened
must not do — so the numbers are over what is drawn and the legend says
"Visits pinned". The check-in time on the card is what reconciles a pin against
`/sales/visits`, which lists every visit whether or not it has a position.

**The shop travels WITH the activity row, on both of its reads.** The visit
behind a mark is a left join onto `mbos_visits` and `customers` in
`ACTIVITY_COLUMNS` — one column list, because `activityPointsForDay` renders
the first paint and `liveDeltaFor` pushes everything after it, and a column
added to one and not the other is a mark that has a shop on it until the page
has been open a minute. It rides the live feed for free: `mergeActivity` keys
on `(entityType, entityId)`, so a visit that lands at three o'clock is numbered
and drawn without the page being asked for the day again.

**The card is a card because a visit is four facts, and it opens the same
drawer a shop pin opens.** Every other popup on this map is one sentence, which
is the right answer for a stop or a leg; this one carries which call of the day,
the shop, what kind of account and what came of it, and then the way into
`CustomerQuickView` — the same two reads the CRM's own record page makes, so a
figure read off a visit and one read off the shop under it are one answer. The
dwell ring and the activity dot underneath it stand down when a click lands on
a visit (`overVisit`): MapLibre fires every layer handler under the cursor, and
two popups each covering half of the other is a control nobody can aim.

**TODAY IS A TABLE, AND A NAME OPENS THAT MAN'S DAY IN A NEW TAB.** The team
on `/sales` was a card per salesman, which is a wall at a hundred. It is one
table now — search, status tabs with counts, sort on any column — in a box that
scrolls DOWN and never across at 1280. A row opens `/sales/live/[id]` in a new
tab, because Today is the screen a manager keeps open. That page is one man's
day with NO switcher: his live map on the left and, on the right, a timeline of
every punch, leg, unexplained stop, visit (customer or lead, outcome, notes,
photos), order, payment and other act, filterable by kind.
`engines/salesman-day.ts` builds it, pure, from the same dwell and trip engines
the map draws with, so the kilometres and stops on the page and on the line
agree; `salesman-day-service.ts` is the server read, scoped through
`lastKnownPositions`, and `salesman-day.test.ts` executes every query in it.
`/sales/live?salesman=` redirects there, which is how the Live map's own
"follow one man" mode retired.

**FULL SCREEN IS A LAYOUT, NOT THE BROWSER'S.** The browser's own fullscreen
takes the tab bar with it, which is more than anybody asked for, and it owns the
Escape key — so the shop record a pin opens could not be closed with Escape
without also throwing the map out of fullscreen. `live-panel.tsx` goes fixed to
the viewport instead and KEEPS THE TEAM LIST beside the map, because the screen
is still about which salesman and a map you cannot pick a name on is a picture.
Escape gives the window back, unless a drawer is open, in which case it belongs
to the drawer.

**The trail can be snapped onto the road it was walked on, and Snap-to-Road
specifically never has to run for the map to work.** At the fifteen-second
sampling density this app uses, a raw GPS line already hugs the road on its
own, so snapping is a refinement on top of a map that already has its
streets — not the thing that draws them. `lib/services/road-snap-service.ts`
calls Ola Maps' Snap-to-Road, batched at its own hundred-point ceiling, and
returns null on anything that goes wrong — a network failure, a bad
answer — which `street-map.tsx` treats identically to "nothing to improve":
the raw line stays exactly as drawn. The SAME key gates both jobs, though:
with none set, there are no streets to lay a trail onto in the first place
(see above). It is set from the Admin Console, under a section of its own
(Integrations), for the same reason dictation's keys are: a deploy nobody
has shell access to needs a screen, not an environment variable, to turn a
credential on.

**It is asked for ONE trail, when a manager actually looks at it — never for
the whole team on every poll.** `tracksForDay` answers the "today" view for
every salesman at once, on a thirty-second refresh; snapping all of that on
every tick would turn one open tab into dozens of calls to an outside service
a minute, almost all of them for lines nobody is looking at. `/api/sales/
live/snap-trail` is asked by the client only for whoever is selected in the
team list, and only once per person per day — `street-map.tsx` remembers who
has already been answered and does not ask again for a name already snapped.
The raw fixes in `mbos_positions` are never touched by any of this: the
snapped line is a second, disposable geometry for the map's `LineString`
only, re-derivable at any time, exactly like every other engine reading in
this codebase.

**AND ONLY WHAT IS NEW IS EVER BOUGHT, because Snap-to-Road is METERED.**
A hundred thousand requests a month, and one salesman's full day at twenty-metre
anchors is around thirty of them — so a team of seven, asked for in full every
time anybody looks, spends a month's quota in a fortnight and then draws no road
at all. The waste is structural rather than accidental: a day grows at ONE END,
and the first eight hours of a trail have not changed since the last look.
`lib/engines/snap-plan.ts` decides per run of fixes whether anything is owed —
reuse, extend by the tail, hold, or buy whole — and the tail of a two-minute gap
is ONE request whatever the day has behind it. It is an engine because the thing
worth pinning is a COUNT, and a count is invisible to a type check, a lint and
every assertion about the line that gets drawn; `snap-plan.test.ts` grows a
thirty-kilometre day two minutes at a time and asserts the total.

**THE SEAM IS THE SAME PROBLEM `callSnap` ALREADY SOLVES, one level up.** Two
independently-snapped halves meet at nothing and what lands on the map is a
notch or a little hook past a corner — which is why batches inside one request
share their boundary point. A held head and a new tail have exactly that seam,
so the tail request is told about the head's last fix as its FIRST point and
drops its own snapped copy of it on the way in. `enhancePath` means the answer
is not one point per point, so nothing may pair it back up by index: dropping
the first point is the only positional assumption made, and it holds because
Ola answers in the order it was asked.

**The road already bought is held on the SERVER, and it is never a source of
truth.** `lib/services/snap-cache.ts` keys it on the salesman and the day, so a
second manager watching the same team costs nothing and a page reload costs
nothing — the browser's own ref only ever saved the tab it lived in. It is in
memory rather than a table deliberately: every entry is a disposable second
geometry, re-derivable from `mbos_positions` at any time, and a table would put
a write on a read-only request plus a sweep for rows nobody reads after
midnight, to buy back one thing — the first look after a deploy, which costs
exactly what EVERY look costs today. Invalidation is not a sweep either: a held
run is rebuilt against the fixes on every read, and one whose start time, first
fix or far-end fix no longer match is discarded and bought again. It cannot
drift into disagreeing with the trail; it can only fail its own check.

**And the refresh window NEVER SHORTENS THE LINE.**
`mbos.location.snapRefreshSeconds` is how recently we may have asked before a
grown run is left to draw its newest stretch as the raw fixes instead of buying
it again — configuration, because it is a cost control with a bill attached and
somebody has to be able to move it without a deploy. What it decides is whether
the last stretch is drawn on the road or as the fixes themselves, which is what
every trail looks like until its snap lands anyway. The line always reaches the
latest fix.

**A SHORT GAP FOLLOWS THE ROAD; A LONG ONE STAYS A STRAIGHT LINE.** The
straight lines still on that map were never failures of the snap — they are
the stretches with NO FIXES AT ALL, cut out by `mbos.location.trailGapMeters`,
and the route deliberately never sent one to Ola. At a fix every few seconds a
gap of a minute or two is a tunnel, a lift, a signal shadow or Android reaping
the tracker mid-ride: the man was travelling throughout and there is very
nearly one way he can have got from the fix before to the fix after, so a line
through three blocks of buildings is a worse picture of that than the road is.
Ola's Directions endpoint answers the two ends and `roadRouteBetween` caches
it in `trail_gap_routes`, keyed on the same rounded coordinate pair
`road_legs` uses — a gap's ends never change once the day is past, and the
stretch from a man's house to the first shop is one question asked every
morning of the week.

**THE CEILINGS ARE WHERE THE HONESTY LIVES.** `mbos.location.gapRouteMaxMinutes`
(8) and `mbos.location.gapRouteMaxKm` (3) both have to hold. Real days on this
book carry single gaps of 437, 456, 498 and 999 minutes, which are days the
handset was off, and nothing should be drawn across those at all: given twenty
minutes somebody can park, walk somewhere, have a conversation and come back,
and the two endpoints look exactly as they would if he had driven straight
through. The kilometre ceiling is the check the clock cannot make — a handset
quiet in Nagpur and speaking again in Wardha lost a signal across a batch
upload rather than travelling — and it is reused to refuse an ANSWER that is
not believable, a correct route round a river with no bridge for fifteen
kilometres, rather than adding a second number that could drift from the
first.

**AND A ROUTED GAP IS NEVER PROMOTED TO EVIDENCE.** It keeps the gap's own
colour, half opacity and absence of casing — the casing is what makes a line
read as a route somebody took — and is DOTTED rather than dashed, which is a
layer of its own only because `line-dasharray` is the one paint property
MapLibre will not take an expression for. The hover says it in words, because
a line that bends round corners says "somebody drove this" to everybody and
that is the stronger signal. Its length is NOT added to the day: `snap-trail`
measures a gap on the crow's flight between its two real fixes whatever it
drew, so a beat with a dozen small dropouts cannot grow a distance because the
map got prettier. `lib/engines/trail-gap-route.ts` is the pure half — may this
gap be routed, is the answer believable, how does a routed stretch join the
fixes either side — and it pins both ends to the real fixes, since Ola routes
between the nearest points on the carriageway and a doorway is not on one.

**AND DIRECTIONS IS THE ONE OLA CALLER STILL OUTSIDE THE KEY POOL, said here
rather than discovered.** Snap-to-Road, geocoding and the distance matrix all
go through `olaGet`, which fails over on an observed exhaustion;
`ola-directions-service.ts` reads `olamaps.apiKey` itself, because it is a
POST-then-GET and `olaGet` is a GET. On the shipping configuration — one key —
that is no difference at all: both spend the same credential and both answer
null when it stops working. On a pool it means a routed gap is the first thing
to go quiet and the last to come back, which is the right end of the product
to lose, and it fails the way this whole feature fails, as the straight dashed
line the map drew before.

**Map and satellite are a `setStyle` call, not two maps.** `StreetMap` swaps
the style JSON in place rather than tearing the whole map down — the camera,
the markers and the click handlers survive, because only what the STYLE
itself carries (the trail and activity layers) gets wiped by the swap.
`drawOverlays` runs off `style.load` rather than the once-only `load` event
for exactly that reason: it fires on the very first paint and on every later
switch, so one function draws the same picture every time instead of the
initial build and a later switch drifting into two slightly different ones.

**A single bad layer must not read as "the map could not be drawn."**
MapLibre's `error` event fires identically for something fatal and for one
malformed layer in an otherwise-fine style — and Ola Maps' own
`default-light-standard` ships exactly that: a `3d_model_data` layer naming
a source-layer the `vectordata` source's tiles do not actually carry.
MapLibre logs it and keeps rendering every other layer perfectly, so a
handler that flipped the whole screen to "could not be drawn" on any
`error` put every load of the Live map into that state — even though the
map was, provably, drawn. What is watched for instead is whether the
STYLE ever loads at all, on a generous timeout: that is the one signal
that does not depend on reading meaning into a vendor's error text, and a
bad layer reference among thousands of good ones does not fail it. It is
deliberately the style loading and not MapLibre's own "load" event, which
waits for every tile in view to finish downloading too — Ola Maps serving
a burst of tile, glyph and sprite requests on one page can genuinely take
longer than the timeout to finish all of them, and a merely slow
connection is not a broken map either.

**Territory's shop map is a second Ola Maps instance, and what the two share
lives in one file.** `sales/territory/shop-map.tsx` plots the book's own
shops — clustered, since it can be a few thousand points — and
field-collected prospect pins that never matched a customer, drawn hollow so
the two are never mistaken for each other. It is built separately from the
Live map's `street-map.tsx` because the two draw different things — one
tracks salesmen live, this one is a static read of the book — but both need
the same style URLs, the same key-authenticating `transformRequest` and the
same Map/Satellite switcher, so those live once in `sales/ola-maps.tsx`
rather than as two copies that would drift the day one of them changed. The
same `olamaps.apiKey` gates both: without it, neither map draws streets, and
each says so on its own screen rather than showing a blank canvas.

**A shop pin is a real account, so clicking it opens the account, not a
tooltip.** `customer-quick-view.tsx` reads
`/api/sales/customer-quick-view`, which runs the SAME two functions the
CRM's own record page and Information tab call — `getCustomer` for the
profile, `customerInformation` for the purchase cycle and recent calls — so
a figure a manager reads off a pin on the Sales Dashboard can never disagree
with the CRM's own answer for that account. Fetched on click rather than
carried on every pin, because most pins on a territory of a few thousand
shops are never clicked. Out of scope or gone both answer with nothing to
show, the same "absent to them, never a crash" rule the CRM record page
itself follows. A prospect pin keeps its plain text popup — there is no
customer record behind it yet.

**THE HANDSET'S MAP WORKS WITH NO SIGNAL, because the streets are on the
phone.** The Live map and Territory's map are read in an office; the handset's
is read in a paint market with two bars of nothing, which is exactly where a
map is worth most and exactly where a tile server cannot be reached. MapLibre
serves a tile out of a downloaded pack without being asked to, so the drawing
needed no code — what needed code is deciding WHAT is worth several hundred
megabytes of somebody's phone, saying what it will cost before he starts, and
being able to tell him afterwards whether where he is standing is inside it.
`mbos-app/src/engines/tiles.ts` is the arithmetic, pure like every other
engine; `data/offline-maps.ts` wires it to the book and the native pack store;
`app/maps.tsx` is the screen.

**A DISTRICT IS NOT THE UNIT.** An administrative boundary was drawn for
revenue collection: most of one is fields with no shop in it, and a beat that
straddles two needs both. The areas offered are CLUSTERED FROM THE SALESMAN'S
OWN BOOK — single-link on a grid, so two shops on a street are always one area
and two towns an hour apart never are — and named with the office's own word
for where they are, the area falling back to the city. A repeated name is
separated by its town rather than by a number, because two rows both reading
"Sadar" are two rows nobody can tell apart and the one with the wrong 300 MB
in it is the one they will pick.

**THE KEY IS NOT IN THE STYLE URL, and that is what makes any of it work.**
MapLibre files every downloaded resource under the URL it asked for. With
`?api_key=` on that URL the pack is stored under the key — so rotating it in
the Admin Console makes several hundred megabytes on a phone unreachable, with
nothing on any screen able to say why the map went blank. `TransformRequestManager`
signs requests at the HTTP layer, which runs AFTER the offline database has
been consulted, so a pack is stored key-less and found key-less and a rotated
key costs one request and no tiles. It fixes a second thing in the same
motion: a key on the style URL authenticates the style file ALONE, and the
tile sources, glyphs and sprite sheet it names carry none — which is why Ola's
own SDK signs every request rather than the first. The web has done this since
Territory's map shipped; the handset never got the equivalent.

**The size is on the row before the button is pressed.** These are the largest
downloads this product asks anybody for, and a progress bar that appears after
the decision is not a decision. It is an ESTIMATE — a vector tile over a paint
market is several times one over farmland — and every screen calls it one; the
question it is right about is "tens of megabytes or hundreds", which is the
one the answer turns on. `mbos.maps.maxZoom` is the setting that decides it,
because each step closer is four times the tiles.

**Two ceilings in two units, and only one of them can explain itself.** Ours
refuses an area up front with its size on the screen; MapLibre's own tile count
ABORTS a download part-way with an error about tiles. `checkConsistency`
refuses a tile ceiling below what the megabyte ceiling allows, or a salesman
starts a download this app has already told him is fine and watches it stop.
Its shipped default is 6,000 tiles — a few square kilometres, inherited from
Mapbox's terms — so it has to be raised before the first pack is created.

**A saved area is matched to a pack by GEOMETRY, never by a stored id.** An id
written into the metadata at download time is wrong the first time somebody
adds a shop and the cluster moves: the pack is orphaned, the area offers to
download itself again, and the phone ends up holding two copies of the same
300 MB with nothing able to say so. Coverage is counted in SHOPS — "9 of these
62 are outside the map you saved" is something a salesman can act on, and "83%
of the bounding box" is not — and PARTIAL is a real answer that is never
rounded to either end. Rounding up draws a map with a blank corner and no
explanation; rounding down hides a map that would have worked for most of what
he needs.

**Saving again replaces, and the old pack goes AFTER the new one lands.** The
grown area is a superset, so nothing is lost by dropping the old one, and
MapLibre shares resources between packs and frees a tile only when no pack
still wants it — so an overlapping download costs the new tiles and not the
old ones again. Deleting first is the version that loses a salesman his
working map for the twenty minutes the new download takes, on the day he is
standing in the market it covers.

**Nothing here deletes anything on its own.** Not a pack for an area that has
left his book, not one that has gone stale, not one that failed half-way. Each
is listed with what it is and a way to remove it: the storage is his, and
taking back three hundred megabytes unasked is the kind of helpfulness nobody
thanks you for. "Old" is a nudge and never an expiry — refreshing re-checks
each tile against the server and fetches only what changed, which is why it is
worth offering at all.

**And the map screen says which of four things is true, rather than drawing a
grey rectangle.** No key, no pinned shops, covered, or offline with nothing
saved for here — and only the last is new. Where an area is covered the map
draws exactly as it does in the office and the signal is irrelevant; where it
is partly covered it draws and says how many shops fall outside; where there
is no signal and nothing saved it does NOT draw, because the pins would sit on
a blank ground and the thing that is being hidden is that fifteen minutes on
Wi-Fi would have prevented it. That last state carries the link to the screen
that fixes it.
