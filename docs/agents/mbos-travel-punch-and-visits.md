# Vehicle sessions, punch-in, arrival, check-in gate, visit cap

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE VEHICLE IS A FACT ABOUT THE SESSION, not about the stop.** It was asked
at every shop and got the same answer all day: a man on his own bike said "own
bike" eleven times and photographed the meter twenty-two times to record one
ride he never got off — twenty-two readings forming a chain anybody could break
by forgetting one, after which the day's kilometres were an argument rather than
a figure. He punches in on a vehicle and punches out on it, so the punch-in is
where it is asked, right after the selfie and before anything is written.

**`mbos_travel_modes.scope` is where a mode is offered — `day`, `leg` or
`both`.** Own bike, own car, company vehicle and customer's vehicle are `day`;
bus, train, auto and taxi are `leg`; `public_transport` is a new `day` row that
is an UMBRELLA over the four, and the only day-level answer that leaves a
question open, because the fare genuinely changes from one shop to the next.
Walking is the only `both` — it is a way to spend a day and a way to reach the
shop next door on a day spent on buses. It defaults to `leg`, which is the
load-bearing half: a handset that has not pulled goes on offering every mode
exactly where it offered it, and a server one release behind sends no scope at
all, which reads as `leg` for the same reason.

**THE SESSION IS A LEG, not two columns on the attendance row.** `origin =
'session'` runs from the punch-in to the punch-out and carries the two meter
readings the day is priced on. Making it a leg means the policy engine prices
it with everything else — one per-km rule, one `odometer → gps → manual`
precedence, one variance check — rather than a second pricing path beside the
first. It is the STRICTEST of the three origins: a day-log leg is typed from
memory so its photograph is optional, and this one is opened and closed by the
app at both ends, so `handleTravelLeg` demands both readings and both pictures.
Public transport and walking open NO session leg: there is no meter and no
journey to measure, and an empty one would put a zero-kilometre row on every
such day for the policy to reason about.

**AND THE VISITS INSIDE IT ARE MOVEMENT, NOT A SECOND CLAIM.** This is the part
that would otherwise pay twice. The visits still open legs — the arrival gate,
the navigation and the record of where he actually went all hang off one — so
an own-vehicle day has one meter pair AND eleven GPS-measured legs, and pricing
both pays per-km twice over a single ride. `claim_excluded` marks them, with
the REASON on the row, because an exclusion nobody can read off the record is
unanswerable six weeks later. The filter sits in `factsFor` and in the
handset's `pricedClaim` — the one place on each side where legs become policy
input — and NOT in the queries that list them: a journey that vanished from the
record to avoid being paid twice is a journey nobody can account for.

**The two rules that decide it are PURE, in `lib/travel-leg.ts`.**
`stopMustAskMode` and `legPricedBySession` were expressions inside `TravelGate`,
which imports the database, so neither could be exercised without a handset —
and both fail silently in the field. The first wrong asks a man his vehicle
eleven times a day; the second wrong pays per-km twice on every own-vehicle day
for everybody. NO SESSION means ASK, which is the half worth stating: it is a
handset whose punch-in predates this build, and a silent default would put
somebody's mileage on a vehicle nobody named.

**It is asked at EVERY punch-in, and that is deliberate.** He can bike in the
morning and take the bus after lunch, and a session inheriting the morning's
vehicle would quietly claim per-km on an afternoon he spent on buses. The
closing meter is asked at every punch-out for the same reason, and only where
the session carries an opening reading — opening a camera on a bus day would be
the app asking about a vehicle he told it this morning he was not on.

**A FORGOTTEN PUNCH-OUT CAN BE READ THE NEXT MORNING, and says that it was.**
`closeStaleSessions` closes the day at its OPENING reading, so it measures
nothing and pays nothing. The meter has not moved overnight unless he rode it,
so what it reads before today's ride IS where yesterday ended — Home offers
the camera for exactly that, once, and `addLateClosingReading` writes it onto
yesterday's session leg with `manual_reason` saying nobody read the meter at
the time. The policy engine prices it as any other reading; the Travel ledger
draws "Added later" beside it, because whoever approves the day should know.
It may not exceed TODAY's opening reading, which is the one bound the phone
can prove, and "Leave it at 0 km" keeps the closure exactly as it was.

**Nothing written until every capture is in.** Selfie, then vehicle, then meter,
then the mark — the order `startDay` already followed for the photograph,
extended. Backing out of any of the three leaves no half-started session, and
the session leg is opened AFTER the punch-in and can never fail it: the
attendance mark is what somebody is paid on, and losing it over a travel leg
would be the wrong way round.

**PUNCHING IN IS THE DAY; CHECKING IN IS THE SHOP.** One word was doing both
jobs, and it is the one thing about this app everybody asks to have explained
twice — "did he check in" meant either "is he at work" or "is he in front of a
customer", and the two are asked by different people about different records.
The day is `mbos_attendance_days` and it is PUNCH in / punch out, on the
handset and on the Sales Dashboard both, because a salesman and the manager
reading his row must not use different words for one mark. The shop is
`mbos_visits` and it keeps CHECK in / check out. The COLUMNS are untouched:
`check_in_at` on an attendance day still says what it always said, and
renaming storage to chase a label is how a migration gets written for a
vocabulary decision that may change again. Only what a person reads moved.

**ARRIVING IS NOT CHECKING IN, AND THAT IS THE SECOND REVERSAL ON THIS TAP.**
"Start visit" already stopped meaning "I am in the shop" and came to mean "I am
setting off"; this moves the other end. Pressing "I am here" used to close the
travel leg, photograph the meter, start the dwell clock and open the form in
one act — so the walk from the bike, the wait at the counter and the call taken
on the way in were all counted as time with the customer. That is the same
error the ride itself used to make, one step further down, and the dwell figure
is the one number this whole flow exists to be honest about.

So the arrival ends the JOURNEY and a second tap starts the VISIT. Everything
that can be refused still happens at the arrival: the radius gate, the closing
meter photograph, the leg. Checking in asks for nothing — no fix, no camera, no
wait — because the reading that proves he is at this shop was taken at the
arrival and answered the gate there, and a second acquisition would let the two
disagree about where the shop is. It is also what lets a check-in work inside a
godown with the radio off, which is where half this book is.

**"NOT YET" IS A REAL ANSWER, AND NOTHING CHECKS HIM IN ON HIS BEHALF.** A
timer that made the assertion for him would be the app putting words in
somebody's mouth on the record his day is read from — the same objection that
keeps a delivery discrepancy from raising a complaint. What pays for the
deferral is that it costs nothing to change his mind: `data/arrival.ts` writes
the arrival to `kv` before the screen changes, a bar at the foot of EVERY
screen offers the way back with the time on it, and while one is outstanding
that bar is the only thing this app offers — `TravelGate` refuses a second
journey and names the shop he is actually standing at. A salesman outside one
shop is not about to set off for another, and letting him would leave an
arrival nothing could ever close.

**It is a record and not a flag, for the reason the leg itself is.** Android
reaps this app on the road constantly, and an "arrived" flag in memory would be
gone by the time he walked in — with the leg already closed and the meter
already photographed, so there is no way back to the arrival he just made.
`kv` rather than a table because there is exactly one at a time: he is at one
shop. An arrival from an earlier day is rubbed out rather than restored, the
same rule `restoreOffPlanReason` follows one file along.

**NOTHING NEW GOES UP THE WIRE, and nothing needs to.** The arrival instant is
already `travel_legs.ended_at`, which the visit is bound to on save, so the
office reads "arrived 10:41, checked in 10:58" off two records it already
holds. A second copy of an instant already stored is a copy that can disagree
with it — and an APK cannot be recalled, so a change that needed no new column
is a change every handset in the field keeps working through.

**And the clock now survives a reap, which it never did.** `visitStart` lives
in memory; before the arrival was written down there was nothing to restore it
from, so a visit interrupted by a phone call was stamped at the save and left
open. The disk holds the instant he walked in, and the visit screen puts it
back.

**THE CHECK-IN IS REFUSED PAST THE RADIUS, AND THAT IS A REVERSAL.**
`engines/geo.ts` states the principle the field product was built on — a
reading is evidence, never a gate — and Mahek asked for the opposite on this
one act: a salesman may check in to a shop only from within
`mbos.location.visitMismatchM` of it. The old behaviour was to measure the same
distance and raise a FLAG, which meant the answer was read hours later by
somebody who could no longer tell, and a visit logged from a tea shop across
the road counted as a visit until somebody went looking.

**What pays for the reversal is that the ARRIVAL is where it sits, and that it
refuses only what a reading can prove.** Refused at the door, before a word has
been typed, the cost is a walk to the right shop and pressing the button again;
`arriveHere` writes nothing, the travel leg stays open, the dwell clock does not
start and no meter has been photographed — which is why the fix is now taken
BEFORE the camera rather than beside it. Refusing the SAVE would be the old
mistake exactly: the note, the photograph, the order and the day are already
in the phone by then.

**Without a proper reading there is no check-in, and that is a SECOND
reversal.** No fix, and a fix too wide to trust, used to go through on the
reasoning that a reading which cannot show he is there cannot show he is not.
Mahek's answer is that an unmeasured check-in is exactly the record the gate
exists to stop. Both are refused now, at the door, where it costs a step
outside and a second press — nothing typed, nothing lost. The written override
below does NOT open them: it exists because a pin is often wrong, and a missing
reading is not a wrong pin.

A shop with NO PIN still goes through, and this is the half nobody would guess
at: 487 of the 1,076 shops on a real handset have no coordinate, so refusing
there would make half the book unvisitable to close a gap the salesman did not
open. But he is ASKED first — "Are you at this shop?" — because that check-in
becomes the pin every later visit is measured against, and a pin should be a
claim somebody made on purpose. It is guarded by `gps_lat is null` in the
statement and not only in the branch above it, so two visits in flight cannot
fight over it — and a POOR fix never pins a shop, because a pin dropped four
hundred metres out would refuse every honest visit afterwards, which is this
rule's own failure arriving by the back door.

**The way past a refusal costs a sentence, and it is offered only after one.**
The pin in this book was typed by hand, dropped in an office or inherited from a
legacy CSV, so a salesman standing in the right shop is refused by the database
being wrong about as often as by anything else. He says so in writing, the visit
saves UNVERIFIED carrying his words in `check_in_override_reason`, and his
manager reads them. Drawn before he has been refused it would be a way round the
radius nobody had to be refused by, which is a different feature.

**And "the pin is wrong" is a REQUEST, never a write.** The handset can already
move a pin through `customer_update`, so an override that moved it directly
would mean one override put the pin wherever somebody was standing and the
radius never refused him there again. `mbos_visits.pin_correction` is the ask,
answered by a manager on `/sales/visits`, and it carries NO coordinates —
what is being accepted is the check-in fix already on that row, which is the
point the manager can open on the map link beside it. A second copy of two
numbers already in the record is a copy that can disagree with it. It does not
touch `verified`: accepting the pin says the book was wrong, and standing behind
the visit is `acceptVisit`, one menu item along.

**The SERVER recomputes and never refuses, and that is not the gate leaking.**
An APK cannot be recalled, so handsets in the field go on sending check-ins the
old build never turned down, and every one of those is real work. Rejecting
would put the visit in `/rejections` for ever and lose the note, the photograph
and the order behind it. `handleVisit` measures the same distance, marks the
row unverified with the distance said plainly, and where no override reason came
with it says exactly that — which is also the only signal a payload that did not
come from the app would leave.

**ONE NUMBER, not two.** `mbos.location.visitMismatchM` is the distance a
check-in is refused at AND the distance a saved visit is flagged at, because
they are one fact: past the radius the only visits that exist are overrides, and
every override is worth a manager's eye. Its default moved 200 → 100 in
`0120_check_in_is_a_gate`, matching on `updated_by_id is null` so a team that
chose 200 is left alone. `checkConsistency` still refuses a radius at or below
`mbos.location.gpsAccuracyThresholdM` — that used to produce a flag nobody
opened and now produces a salesman refused at the door of the right shop. The
check-in is also the one fix in the app taken at `Accuracy.High`: everything
else here asks for `Balanced`, which on Android is roughly a city block, and a
reading that coarse cannot tell a doorway from the tea shop it is now deciding
against.

**A CHECK-IN RUNS UNTIL THE CHECK-OUT, wherever he goes in the app.** Leaving
the visit screen used to warn "Leave and lose it", and the only way back
started a new visit — so opening a customer's statement mid-visit cost the
note, the photographs and the clock. The draft lives in the store, the clock
is measured from `arrival.checkedInAt` on disk, and an "In <shop>" bar on
every other screen ticks and leads back without `beginVisit`. One visit at a
time: "Start visit" refuses while one is open.

**Check-out ASKS what is owed, and the answers are never waived.** GPS, dwell
and the photograph are EVIDENCE — a salesman can be unable to produce them,
and the unverified save exists for that. The outcome, its follow-on and a
written note of the visit (`mbos.visits.minimumNoteChars`, a shop found closed
exempt) are ANSWERS: only he can give them and nothing stops him. So an
unverified save waives the first kind and never the second, and pressing
Check out with anything owed opens one sheet with the controls to answer it,
rather than a toast pointing somewhere up the page. The server does not refuse
a noteless visit — old APKs still send them, and a refusal would lose the visit.

**WALKING OUT WITHOUT CHECKING OUT IS NOTICED, and the phone asks.** A
salesman at the end of a long day finishes the conversation, gets back on the
bike, and the visit is still running in his pocket. The trail already knows
where he is every few seconds, so `leftShopVerdict` (`engines/left-shop.ts`,
pure) compares the newest reading against where he CHECKED IN — the fix the
gate accepted, kept on the arrival as `checkInFix` — and failing that the
shop's pin. Past `mbos.visit.forgotCheckoutMetres` (500) the phone posts ONE
local notification, on its own MAX-importance channel with a sound, and
tapping it opens the check-out for that shop. Local rather than a server push
because the server does not know he is checked in until the visit is saved,
and because it has to work with no signal.

**The reading's own error is taken off before it counts.** Asking somebody
still at the counter whether he forgot is how a reminder becomes one people
swipe away, so a 300 m-wide fix landing 550 m out does not fire, and a fix
with no stated accuracy proves nothing. `checkConsistency` keeps the threshold
at least twice the check-in radius for the same reason.

**It is asked wherever a reading reaches JavaScript**, which is two places:
the background location task on each delivery, and every sync tick against
the phone's last known position. The second is what covers a handset whose
native service uploads its own fixes and never hands them to this side — and
on such a handset with the app closed, the reminder is only as prompt as the
background sync task, which Android may run as rarely as every fifteen minutes.

**The 100 m rule is for walking IN, never for walking out.** The visit screen
used to take a fresh fix whenever it was reopened, so after a reap — or after
tapping this reminder half a kilometre down the road — it measured where he is
now against the shop and refused a perfectly good visit its check-out. It
restores the check-in fix instead. And a visit he forgot to close is closed at
the moment the trail saw him leave (`leftShopAt`), not at the moment he
remembered: counting the ride home as time with the customer is the error the
dwell figure exists to avoid.

**A SUSPECT CANNOT BE VISITED FOR EVER, and the cap ASKS rather than refuses.**
§B of the brief wants a maximum of three visits "enforced", and enforced as a
block is the one shape this app must not use: `engines/geo.ts` states the
principle the rest of the field product rests on — a reading is evidence, never
a gate — because a salesman whose visit is refused stops recording visits, and
the company loses the GPS, the competitor note and the reason in order to stop a
number reaching four. The check-in radius above is the one deliberate exception
to it and buys its way out at the arrival, where nothing has been typed yet;
this one has a visit already made and would be throwing that away. What §B
actually wants is that nobody keeps visiting a shop nobody has decided about,
and that is bought by demanding an ANSWER.

**AND THE OFFICE NO LONGER REFUSES THE VISIT EITHER.** `handleVisit` used to
reject a visit past the cap that arrived without a decision. The handset asks
only when IT can see the cap — its own count, a lead row it holds — and the
office counts every visit anybody made, so where the two disagreed the phone
never asked and the whole visit went to Not accepted, with the order and the
payment behind it. The visit lands now and the missing answer goes to the
manager. ONE CAP, too: `leads.suspectMaxVisits` is retired, every reader uses
`mbos.leads.maxSuspectVisits`, and the handset is sent that value under both
names — two settings for one number let the record page and the visit screen
disagree about the same lead.

So there are three states and none of them blocks the visit being made:
`mbos.leads.visitsBeforeDecision` starts the warning, `mbos.leads.maxSuspectVisits`
makes the Prospect-or-not answer mandatory before the visit can be CLOSED, and
past it the manager is notified instead. Keeping it a Suspect asks why. Only
`new` and `contacted` are capped — a qualified prospect visited a fourth time is
a negotiation, not a stall, and must never be asked to justify itself.

**The rule lives in two runtimes and shares its NUMBERS, not a module.**
`visitCapState` is pure and on the handset; `handleVisit` checks the same thing
server-side, because a sync endpoint accepts payloads from a device somebody
owns and a form is not a rule. They cannot import from each other — one is an
Expo package — so what is shared is the two configured thresholds, which reach
the handset on every pull with the rest of the `mbos.*` keys. The comparison is
one line at each end deliberately: a rule small enough to be obvious cannot
drift the way a re-derived one does.

**The decision is written in the VISIT's transaction.** A visit that saved and
a decision that failed a moment later would leave the lead where it was with the
salesman believing he had answered — and the next visit would demand the same
answer again. The count behind it is `count(*)` over `mbos_visits`, not a cached
column: a cache needs a recompute path, an invalidation on every visit write, and
a way to be wrong. On the handset it is the office's count plus whatever is still
in the outbox, because a salesman who made visit two with no signal must still
be asked on visit three.

**ON HOLD IS NOT LOST, and both ask for a reason.** `on_hold` is a live prospect
that is not moving — a plant shutdown, a budget quarter, a decision maker
abroad — and folding it into `lost` made every stalled lead look dead, which is
how a real prospect gets archived by the staleness sweep. It stays ON the
handset for the same reason. Lost asks for a reason because nobody will look
again; this one asks because somebody will, and "back after Diwali" is what
tells them when. `lead_hold_reason` is one column for both that question and
"why is this still a Suspect", because they are the same question.

## The edges of the day (mbos/day-shape-edge-cases)

The pure rules behind these live in `mbos-app/src/data/day-shape.ts` and
`lib/visit.ts`, tested against the real handset schema in `day-shape.test.ts`.

**AN ARRIVAL HAS THREE ANSWERS, not one.** Check in, Not yet, and NOT GOING IN.
Until the third existed a shop found shut was a visit opened, a clock run up to
the dwell floor and a record saved "not checked" — or an arrival left on the
bar he cannot dismiss with `TravelGate` refusing every other journey. Not going
in asks a reason, KEEPS the trip (`walkAway` notes the reason on the leg; it is
not `closeAbandoned`, which would reset the closing reading and pay nothing for
a ride he made), and clears the arrival. `arrivedLegFor` skips such a leg so a
later visit to the same shop does not inherit it.

**A SHUT SHOP OWES NO DWELL.** `outcomeNeedsDwell`: Shop closed and Owner away
are exempt from `mbos.visits.minimumDwellSeconds`, because there is nobody
inside to have spent the time with and the gate already proved he was at the
door. Everybody spoken to still owes it.

**MIDNIGHT DOES NOT ERASE AN ARRIVAL HE IS STILL WORKING.** `arrivalIsCurrent`
keeps an arrival that is checked in (a visit is ended only by its check-out)
and one made after the start of the punch-in still running (read off
`attendance_days` inside `mbos.location.serviceMaxDayHours`). Only an arrival
he never went into, from a stretch that has ended, is rubbed out —
`runDayBoundaryWork`'s rule, one record along.

**A SYNC NEVER TAKES THE SHOP HE IS STANDING IN.** `reconcileBook` and customer
tombstones keep `shopsInFlight()` — the open arrival's shop and any shop with
an open trip, or a closed one not yet spent on a visit within a day. A noon
reassignment used to delete the row and Check out then did nothing at all. The
visit screen also saves against the arrival's own id and name where the row is
missing, and Check out never returns without a sentence. (The office accepting
that work is H7 in `account-seats-and-reassignment.md`.)

**PUNCHING OUT ASKS ABOUT THE SHOP FIRST.** With an arrival open, Punch out
sends him to check out (or say he is not going in) before the selfie camera
opens; a trip he never arrived from is closed with the punch-out, at its own
reading, named. The closing meter is asked only for a session opened inside
the stretch being ended (`openSessionLeg(userId, runningSince)`) — a bus day
opens no session, and yesterday's bike session left open was being read as
today's.

**A MISSING READING SAYS WHICH.** `getFix` carries a `cause` — `permission`,
`services_off` (asked of `hasServicesEnabledAsync` before the radio waits),
`no_signal`, `error` — and `checkInVerdict` takes it, so the refusal no longer
says "step outside" to somebody whose switch is off. The refusal card offers
`openLocationSettings` for the two a switch cures; Near me offers it too, and
Try again. The failure sentences no longer promise a save "marked for your
manager", which the gate has refused since it became a gate.

**THE FIRST CHECK-IN PINS THE SHOP ON THE PHONE TOO**, in `saveVisit`'s
transaction, guarded by `gpsLat IS NULL` exactly as the office's statement is,
from the arrival's `checkInFix` and never on an override.

**THE VISIT'S CART IS SET ASIDE, NOT CLEARED, while another shop is open**
(`moveDraft`) and comes back when he returns; the persisted draft keeps the
set-aside cart. With no visit running the old clear-on-shop-change stands.

**QUICK-ACTION START VISIT NAMES THE SHOP AND ASKS.** It used to set off for
whichever shop was opened last; with none open it sends him to Customers.

**"I DID NOT LEAVE" ANSWERS A WRONG LEFT-SHOP READING.** It clears
`leftShopAt`, keeps `leftShopDispute` (reason, the instant disputed, the
metres) on the arrival, stops the reminder for that visit, and rides on the
visit payload; the office writes `mbos.visit.left_shop_disputed` and tells his
manager. It never refuses the visit.

**Smaller edges.** Start visit shows "Starting trip to X…" while the departure
fix is taken. Retaking a shop or owner photo drops the queued one it replaces
(as the voice note did). Metered days closed with no punch-out are a LIST
(`parseUnpaidMeters`; an older single-object value still reads): only the
newest is offered the camera — the meter has moved since the others — and the
earlier days are named on the card so he can ask the office. A cold-start tap
on the check-out reminder restores the visit draft before setting the arrival,
or the draft writer saved an empty form over the one on disk.
