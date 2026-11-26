# Location trail, uploads, permissions, handset health

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**Tracking runs between the check-in and the check-out and not one second either
side.** A track that carried on after the day was closed would be following
somebody home. The handset takes a fix every few seconds — dense enough that
the line connecting them hugs the actual road with no map-matching service
needed to snap it there — and posts batches to its own endpoint rather than
through the outbox — a position is one of a thousand, worth nothing alone, and
queueing them ahead of the visit behind them on a 2G connection buys nothing.
`mbos.location.trackWhileWorking` is checked in the route as well as on the
handset, because a hidden control is not a disabled feature.

**A POSITION IS ITS READING, and an id that is not derived from one is a
duplicate generator.** Every fix was stored under a fresh `randomUUID()`, so
`INSERT OR IGNORE` on the handset had nothing to ignore ON and neither did
`onConflictDoNothing` here. `data.locations` is a BATCH of deferred fixes and
Android hands the batch over again whenever the task did not complete — which
is every time the OS reaps the process mid-flush. Production reached 33,000
rows for 4,000 real fixes, one of them ninety-three times across ninety-two
separate uploads. The id is `at|lat|lng` now, and `mbos_positions_fix_key` is
the half that does not depend on which build is in somebody's pocket: an old
APK cannot reintroduce the damage while it waits to be updated.

**CAPTURE WITHOUT DELIVERY IS A RECORDER NOBODY EMPTIES, which from a desk in
Nagpur looks exactly like a recorder that never ran.** MBOS's own Android
foreground service fixed the half of the trail that stops when Android kills
the app — it goes on taking fixes with no JavaScript anywhere in the process —
and then the fixes sat in its own buffer, because the only thing that had ever
posted a position was `flush()`, which is JavaScript. Same silence, same burst
when somebody opens the app. So the uploader is in the SERVICE now, in Kotlin,
posting to the same `/api/mbos/positions` with the same bearer token: one
`HandlerThread`, the next attempt scheduled by the one that just finished so
there is never a second post in flight, `HttpURLConnection` for its
process-wide keep-alive pool rather than a second copy of OkHttp beside React
Native's, and `ConnectivityManager` asked before the radio is.

**AND THERE IS EXACTLY ONE OWNER OF SENDING AT ANY INSTANT.** Two queues
draining the same fixes costs nothing in correctness — a position's id is its
own reading and every insert is conflict-ignore — and it is still two phones'
worth of data to deliver one, and the failure of a queue with two owners is
never the duplicate: it is the day nobody drains because each side believed
the other was. `FixStore.uploads()` is the whole answer, computed natively
from five things the app cannot see — the office's cadence, whether the
handset holds a usable credential, whether the server has refused it, whether
the day is still open, whether the service is running — and `chooseSender` in
`engines/upload.ts` is the rule that reads it. Any of the five going false
hands the queue straight back to `flush()`, which is what makes the check-out
pick up the last few minutes of a day rather than leaving them until morning.

**THE CADENCE IT SENDS AT IS NOT THE CADENCE IT RECORDS AT.**
`mbos.location.serviceUploadEverySeconds` is six and `trackEverySeconds` is
three, and every captured fix goes up either way — so the drawn route is
identical and what the second three seconds buys is half the radio wakes over
an eight-hour day. `checkConsistency` refuses a send interval BELOW the take
interval, because a post with nothing new in it is a wake spent on an empty
batch. Zero is the escape hatch rather than a tuning value: the recorder stops
sending and the app does it, which is what this app did before the service
could send for itself, reachable from the Admin Console rather than from a
sideloaded APK.

**THE SERVICE CANNOT READ THE KEYCHAIN, so the token is MIRRORED.** The app's
tokens live in `expo-secure-store`, whose values are encrypted under a keystore
alias belonging to another package — reimplementing that format inside a
background service on a phone that cannot be recalled is a bet, not a
credential store. So `setTokens` in `sync/api.ts`, the one place this app ever
mints a token, writes the pair into the service's own preferences as well. The
cost is stated rather than hidden: app-private storage protected by the sandbox
and not by hardware key wrapping. What buys it back is that both tokens rotate,
the access token lives an hour, and the alternative is not a safer uploader but
no uploader. The service refreshes for itself on a 401 and the app's own copy
goes on working — the refresh endpoint is a stateless JWT with no denylist, so
rotating one copy does not sign the other out.

**A BATCH THE OFFICE COULD ONLY PARTLY FILE IS NO LONGER DELETED WHOLE.**
`flush()` had two answers — delivered, and it dropped the lot, or
`no-session-yet`, and it kept them — so a mixed batch came back looking
delivered and the handset destroyed rows the office had never stored. Every
layer reported 200 all the way down, which is the worst shape a data-loss bug
takes. Answering `no-session-yet` for a mixed batch is the obvious fix and is
worse: the drain is oldest-first, so ONE permanently unfileable fix in the
oldest five hundred holds up everything behind it until `queueRetentionDays`
ages it out, and the phones with an unfileable tail are exactly the phones in
the incident. So the server gains a third word, `partial`, naming the ids IT IS
FINISHED WITH; the handset deletes those, keeps the rest, and CARRIES ON to the
next batch. The shape is ids-that-landed rather than ids-to-keep, and the
asymmetry is the whole safety argument: an id the server forgets to name costs
one round trip, where under the opposite shape it would cost the fix. AN
UNKNOWN WORD STILL MEANS DELIVERED, deliberately, because an APK cannot be
recalled and a phone that wedged its queue on a word it had never heard of
could only be unwedged by sideloading. `engines/flush-answer.ts` is the rule,
pure, because `sync/trail.ts` imports expo-location at module scope and two
production data-loss bugs have now been in that loop. The NATIVE uploader feeds
the same queue and answers to the same protocol, so this is an upload-path fix
and not a capture-path one — it is orthogonal to which recorder took the fix.

**THE WATCHDOG'S VERDICT EXPIRES, AND IT IS A VERDICT ABOUT THE BORROWED
TRACKER ONLY.** `backgroundProvedSilent` was a module-level boolean set by the
watchdog and cleared by nothing, so the FIRST demotion of a process was its last
word: every later `start()` — the afternoon check-in, every resume — fell
through to the floor, and the floor is a `setInterval` that only advances while
the app is on screen. A handset demoted at nine and put in a pocket recorded
nothing for the rest of the day, and `flush()` never ran on that path either.
`engines/trail-retry.ts` bounds the cost instead of making it permanent: a new
calendar day, a fresh check-in and `mbos.location.trackerRetryAfterMinutes`
each re-open the question, so the price of a wrong retry is one silent window
per interval rather than one per resume. It is asked ONLY where
`startLocationUpdatesAsync` is about to be called. Where MBOS's own service
took capture the question is never put, the JS watchdog is stopped and the
stall mark is dropped — one mechanism holding capture up, never two.

**AND NEITHER END MAY ASSERT A PERMISSION NOBODY CHECKED.** `fallBackToFloor`
reported `backgroundGranted: false` on the reasoning that the column means "is
a real background trail running". It does not — the schema says whether the OS
granted the background permission — and the app had not re-checked one.
Production carries the contradiction it produces: `location_permission =
'always'` beside `background_location_granted = false` on two handsets, which
sends somebody to check a setting that was already correct while the real cause,
a battery manager killing an accepted service, is the one thing nobody looks at.
The honest field for "background is not working" is `trackerStalledAt`. The
service path had the same overload in the other direction, asserting `true`
where nothing had asked, and both now RESTATE the last answer this process gave
rather than inventing one. `startBackground` returns a REASON instead of
`false` for four different situations — no background location in the build, a
refused foreground permission, a refused background one, and the OS throwing on
registration — because those are four different things to do about it, and
`engines/tracker-notice.ts` is the one place any of them becomes a sentence.

**A QUEUE DRAINED OLDEST-FIRST, ONE BATCH PER TICK, CANNOT CATCH UP.** `flush()`
sent exactly one batch of five hundred, and the sync tick that calls it is a
`setInterval` that only advances while the app is open — a drain with a fixed
rate in front of a queue with none. At a fix every three seconds that is twenty
rows a minute before any redelivery, filled all day and emptied at five hundred
per minute of SCREEN TIME, oldest first. The newest fix, which is the only one
the Live map wants, sits at the back of it. A phone uploaded three thousand rows
across six successful posts in one day and moved its trail forward by three
minutes of the PREVIOUS evening, while its owner walked a full beat — and
nothing anywhere looked wrong. The posts returned 200, the connection was fine,
and the office simply saw a salesman standing where he had been the night
before. `flush()` loops until the queue is short now. The general lesson is the
one worth keeping: a drain whose rate is fixed and whose fill rate is not is a
queue that reports success all the way down.

**AND THE THREE SECONDS IN THAT PARAGRAPH WERE NOT A SETTING ANYBODY CHOSE —
THOUGH THEY TURNED OUT TO BE THE RIGHT NUMBER.** See the paragraph after next
for how enforcing the wrong one destroyed the trail this map exists to draw.
`mbos.location.trackEveryMinutes` said five and the handset asked for five, and
Android delivered at 3.0 seconds for three days. `timeInterval` NEVER REACHES
IT: expo-location declares it `Long?` and reads it out of the task's persisted
options with `map["timeInterval"] as? Long` — but options are stored as JSON,
so `org.json` hands back a boxed `Integer` and a strict `as?` yields null. The
override is skipped in silence and `Accuracy`'s own fallback of 3000 ms stands.
`distanceInterval` is declared `Int?` and survives the same round trip, which
is why the one parameter nobody meant to be load-bearing was the only one
arriving. A hundred times the fixes, a hundred times the battery, and the queue
above could never have drained whatever `flush()` did.

**So the cadence is enforced where no cast can lose it, and that is
JavaScript.** `deferredUpdatesInterval` is set beside `timeInterval` because it
IS read with a coercing `getLong` and does arrive — but it is the battery half
only, since expo bypasses it outright while the app is in the foreground
through its own `shouldReportDeferredLocations`. The authority on what actually
gets WRITTEN is `shouldKeepFix` in `engines/cadence.ts`, which is pure and
tested. It is an engine rather than three lines inside `trail.ts` for exactly
the reason the bug lasted three days: that file imports expo-location and
TaskManager at module scope, so nothing in it can be exercised without a
device, and a cadence nobody can test is a cadence nobody can be sure of. The
mark lives in `kv` and not in `positions`, because the queue is emptied as it
uploads — asking the table would answer "nothing kept recently" the moment a
flush succeeded, and the cadence would collapse back to whatever the OS felt
like delivering. A clock corrected BACKWARDS resets it rather than stalling,
or a phone an hour fast would record nothing until it caught up with a mark
from a future it no longer believes in.

**AND ENFORCING IT AT FIVE MINUTES DESTROYED THE TRAIL, which is the other
half of that fix and took two days to notice.** The bug was real and the
correction was right; the NUMBER it enforced was a default nobody had ever
chosen, in a unit that could not express the answer. A working day came back
as thirty-nine points joined by straight lines across the map — `splitTrailByGaps`
correctly drawing them dashed, because at five-minute spacing nobody did record
what happened in between — on the one screen whose entire purpose is the shape
of a day. The same book on the same phone two days earlier held 5,168 fixes at
a three-second median and drew the road.

**A KEEP FLOOR IN MINUTES COULD NOT MEET AN ASK IN SECONDS.** That is the
mechanism, and it is worth stating on its own: `trackEverySeconds` runs at 3
and the floor beside it was an integer count of MINUTES, so the finest it could
ever express was 60 — twenty times coarser than the fixes being taken, with the
whole useful range between them unreachable. `mbos.location.trailKeepEverySeconds`
replaces it, defaulting to the same 3, and `checkConsistency` refuses a keep
floor shorter than the ask because that pair cannot be honoured by anything.

**Raising it saves upload and storage and NOT battery.** The cost is paid at
the ASK — the handset wakes, fixes and spends the power whatever the floor says
— so discarding four fixes in five bought rows and nothing else. That is why
equal is the default: every fix already paid for is one that is kept.

**And the THINNING has to move with it, or the fix is invisible.**
`tracksForDay` capped the team overview at 400 points a person, which over a
ten-hour day is one every ninety seconds — six hundred metres at riding speed,
which is the same straight line arriving one layer further out. It is 2,000
now. The SELECTED salesman is not drawn from it at all: `/api/sales/live/snap-trail`
reads `trackForDay`, uncapped and road-snapped, and `downsampleForPath` hands
Ola an anchor every 20 METRES rather than every Nth fix — so the snap cost is
set by how far somebody rode and not by how often the phone looked.

**A fix that is not kept is still REMEMBERED.** The trail wants one point every
few minutes; `whereNow()` wants the freshest reading there is, and throttling
that would age the position on every order and payment by the whole cadence.

**A fix is judged against the SESSION IT BELONGS TO, not against today.** The
sentence at the top of this section used to be enforced by asking whether the
sender is checked in RIGHT NOW, which is a different question. A batch is a
queue catching up — its fixes were taken hours or days before they arrive — so
the day to judge them against is the day they were TAKEN. Worse, any CLOSED day
refused the whole batch, and `markMissedCheckouts` closes a forgotten day at the
last position it can see: a handset that lost its trail early had its day closed
early, and every later fix was then refused BECAUSE the day was closed, on the
strength of a closing time that existed only because the fixes were missing.
The route reads the attendance rows the batch actually spans. The privacy rule
is unchanged and only now actually holds.

**A batch with no session to file it against is KEPT, not dropped.** The handset
deletes what it sends on any `ok`, so `ok: true, stored: 0` is an instruction to
forget — and answering that to a batch whose check-in is still in the outbox
destroys a morning to win a race by thirty seconds. `no-session-yet` is the one
answer that means hold on to them, and the handset drops them itself after a
week, because a queue that only ever grows is the other way to lose a day.

**EVERY PERMISSION IS ASKED IN ONE WALKTHROUGH, straight after sign-in.**
Android grants nothing at install, and the app used to ask in five places —
location on home, notifications at boot, the camera at the first selfie, the
microphone at the first dictation, battery and autostart only on the
start-of-day gate — so "which settings do I need" was answered by whichever
the app tripped over first. `/setup` is the one list, in the only order that
works: the four popups back to back, location switched on, "Allow all the
time" (after the foreground permission, or Android refuses it outright; on
Android 11+ it is a Settings page, not a popup, and the app opens that page),
the battery popup, and the manufacturer's autostart screen with that
manufacturer's words. `engines/setup-walkthrough.ts` is the rule and it opens
**once per build** where anything is outstanding — a fresh install, and an
update that left something missing — never on every open. It gates nothing:
"Do this later" is always there, and `/phone-setup` keeps the job of refusing
a day. Autostart is confirmed by the salesman because no API can read it, and
the mark lives in the handset's own store, which a reinstall wipes exactly
when the switch resets.

**AND IT IS THE ONLY LIST, on all three screens that set a phone up.** The
walkthrough, the start-of-day gate (`/phone-setup`) and Keep tracking on
(`/tracking-setup`) explained the same switches with three sets of titles,
three copies of "open the autostart screen" and two separate records of "he
says it is on". A salesman sent from the gate to Keep tracking on read a second
list about the same phone, and the question he rang back with was which one was
right. `engines/setup-steps.ts` lays each screen over `setupSteps` and
`components/setup/SetupSteps.tsx` draws the rows and runs the buttons; each
screen keeps its own route, header and purpose. The gate's RULE did not move —
`phone-readiness.ts` still decides which steps hold the day — it is laid over
the shared rows, which then say "Needed before you punch in" under the same
title every other screen gives them. One "I turned it on" now writes both the
walkthrough's mark and the gate's acknowledgement, so a phone confirmed on one
screen is not asked again on the next. `keepAliveSteps` is gone;
`autostartWhere` is the one sentence for where the switch is.

**THE NEW LEAD FORM ASKS AT THE DOOR AND KEEPS THE SHOP BEHIND ONE TAP.** It
was seventeen fields in one sheet. The first screen is now what the save
requires and what can be said with the owner waiting — the kind of sale, who,
the shop, the mobile, the area, how he found them and what they want — and
"What you found in the shop" holds the rest. Nothing filled is hidden without a
word: closed, it reads "3 more answered — show"; a voice or card fill landing
there opens it; a GST refusal opens it. `engines/lead-form.ts` is the rule.
Only the layout changed — every field is still on the form and still sent.

**"NO FIX TODAY" WAS FOUR DIFFERENT PROBLEMS WEARING ONE SENTENCE.** The
background permission set to "while using the app", location switched off on
the phone itself, no signal since breakfast, and a flat battery — four causes,
three of which somebody can act on, and the team list drew them identically. A
manager reading that line had no way to tell which, so he rang the salesman and
asked him to describe his own settings screen. `lib/handset-health.ts` is the
one place any of it becomes words, pure and client-safe like `customer-health`
beside it, because the panel is a client component and a second copy typed into
a screen drifts inside a release.

**A BOOLEAN COULD NOT SAY WHICH.** `background_location_granted` answers true or
false, and its `false` covers both "while using the app" — a settings trip — and
"refused outright", which is a different conversation entirely.
`location_permission` carries the OS's own four answers, and the boolean is KEPT
and still written beside it: an APK cannot be recalled, so handsets in the field
go on sending only the boolean and the screen has to go on reading it. Its
`false` renders as `restricted`, which says the trail has gaps without inventing
a reason for them. The migration backfills `true` to `always` and deliberately
leaves `false` alone — guessing there would put a fact on the screen that
nobody established.

**NULL IS NOT AN ANSWER, and three things depend on it.** A handset that has
never reported reads null, which is not a refusal, not `undetermined` — that is
the OS saying nobody has been asked — and not a fault to draw. `readDeviceState`
OMITS a field rather than nulling it, so an old build's report cannot wipe the
richer answers a newer one gave for the same phone; a partial report is a
partial update. It is the same trade the wire already makes in the other
direction, where an unknown column is dropped rather than the row refused.

**THERE IS NO LIVE BATTERY READING AND THE SCREEN MAY NEVER IMPLY ONE.** A
phone speaks when it syncs, so every figure is "at last contact" — minutes old
inside a working day, hours outside one. `device_state_at` rides with it and a
check constraint refuses the readings without it, because a bare "8%" reads as
now and would have somebody ringing a salesman whose phone charged overnight.
The row prints "Battery 8% — read 12 min ago", which is the discipline
`mbos_activity_locations` already keeps for a fix's age and the On-your-way
screen keeps for a distance.

**IT RIDES CHANNELS ALREADY OPEN, and only inside a working day.** The battery
goes up with the position batch, which is already authenticated, already names
the device and already runs every few minutes — a poller of its own would spend
the battery in order to report it. It is written after the session check in
`positions/route.ts` and nowhere else, so a handset that carried on reporting
after check-out would be a beacon on somebody's evening, which is precisely what
the trail itself is forbidden from being. It is a SIBLING of the positions array
and never a field inside a fix: a position's id is `at|lat|lng`, and folding a
changing value into a key is how a redelivered batch stops deduplicating.

**NOTHING CLAIMS SOMEBODY'S INTERNET IS OFF, because nothing could.** A phone
with no connection cannot report having no connection, so any column saying so
could only ever be written by a handset that was online at the time. SILENCE
carries it, and silence is `last_seen_at` — which is also why that column now
moves on every position batch rather than only at sign-in. It was written at
login and nowhere else, so four screens calling it "last synced" were showing
the last time somebody typed their password, and a handset syncing perfectly all
week read as untouched since Monday.

**AND THAT COLUMN MOVING IS NOT THE ROUTE ARRIVING, which is the confusion it
caused the moment it started working.** `last_seen_at` is when the phone last
SPOKE; the time on the team row is the time written on the newest FIX, and the
service says so deliberately — "the time on the answer is the time of the fix
and never now". A handset flushing a backlog satisfies both at once: it posts
every few minutes, so the office reads a phone in constant contact, and every
reading in those batches was taken hours ago, so the map draws him where he
was at four. Both numbers are right and they are about different things, and
the screen printed only one of them. It was reported as the map being broken.

**A TRAIL THAT RAN AND STOPPED HAD NO SENTENCE ANYWHERE, and it is the
commonest shape of a lost route.** `trailIsDead` answers false the moment
`trailSeenAt` is non-null — it was written for a handset that produced NOTHING
all day, and says so in its own signature — so a day that ran all morning and
stopped at four had a pin, a place, a green dot and "Last seen 16:12", with
every banner on the screen counting zero. The only line that fired was the
silence note, which measures an interval and names nothing, and which does not
fire at all on the case this exists for, because the phone is not silent.
`trailHasStopped` is the complement, on the SAME `noTrailMinutes` — how long a
working handset may produce no position is one question, and whether the count
before the silence was zero or four hundred does not change the answer. The two
are mutually exclusive by the null check, so one fact still gets one sentence
and no handset is counted in both banners. The row now prints the age beside
the clock time as well, on precisely the rows that have a note explaining it.

**WHETHER THE WORK IS LOST OR MERELY LATE IS THE PHONE'S TO ANSWER.** A
recorder reporting fixes still queued is a route that exists and is
travelling; drawn as a fault that is a manager ringing a salesman who is doing
nothing wrong. Null queued is neither — a build too old to report its buffer
has told us nothing, and it takes the softer sentence.

**AND `uploads` IS A BELIEF, WHICH IS WHAT ACTUALLY COST THE DAY.** The
recorder answers true whenever the cadence is set, a credential is held, the
server has not refused it, the day is open and the service is up — and every
one of those survives an uploader that is wedged against a captive wifi or a
socket that times out for ever. `chooseSender` agreed with the belief, so the
app left the queue alone while the phone sat in its owner's hand, online, with
the app OPEN, holding hours of his route and able to post it in one pass. It
now takes the queue back on EVIDENCE — not one batch accepted for longer than
any honest retry could account for, AND fixes actually held — both of which
the recorder already reports about itself. Both halves are load bearing: the
buffer check alone would accuse every phone on a quiet afternoon of an
absence, and the silence check alone would take the queue off a recorder that
is working. The threshold is well above the recorder's own five-minute retry
ceiling, because reading three ordinary retries as a wedge is two owners and
no draining. Taking it back when THIS side cannot send either is still right:
the rows move out of a ring buffer that drops its oldest at the cap and into a
table that drops nothing, and a fix's id is its own reading, so the worst a
double send costs is a round trip.

**EVERY HANDSET REQUEST IS A HEARTBEAT, AND IT CARRIES THE BUILD.**
`app_version` was written at sign-in and nowhere else, so a phone that took a
new APK or an over-the-air update went on showing the build it signed in with
until somebody signed out, which nobody does. The handset now sends
`x-mbos-app-version` (its `buildLabel`) on every request and syncs the moment
it launches, and `authenticate` — the one door every MBOS request passes —
records it through `recordHeartbeat`: `last_request_at` always,
`app_version_reported_at` when the header came, `app_version_changed_at` when
the label moved. One write per device per 15 seconds unless the version moved,
and it can never fail the request it rides on. Sign-in goes through the same
function, so an upgrade found at sign-in is stamped the same way. A build from
before this sends no header: its row keeps the sign-in reading and the Admin
Console's Handsets table says "as of sign-in" rather than passing it off as
live. That table reads `/api/admin/handsets` every ten seconds and is the
platform administrator's alone.

**A HEALTHY PHONE SAYS NOTHING AT ALL.** A row listing four green facts is a
specification sheet, and the one line that matters gets read as furniture — the
mistake the microphone made when it was drawn at the weight of the resize grip.
`mbos.location.handsetQuietMinutes` and `mbos.location.lowBatteryPercent` decide
when there is something to say, and they are configuration because they change
what a screen ASSERTS, which is the same reason `activityFixMaxAgeSeconds` is.
Neither is `mbos.sync.quietHours`: that one asks whether a phone has stopped
syncing at all, over days, and this asks whether a man who checked in this
morning has gone quiet since.

**`SCHEMA_VERSION` COUNTS THE MIGRATIONS RATHER THAN BEING TYPED BESIDE THEM.**
It was a literal and it drifted: travel and expense added an eleventh block and
left the constant at 10, so `migrate()`'s own `current >= SCHEMA_VERSION` guard
returned before running it. A fresh install was fine — it starts at 0 and runs
everything — which is exactly why nobody saw it, and why the handsets that
skipped the block were precisely the ones already in the field. It is
`MIGRATIONS.length` now, so adding a block is the whole of adding a migration.

**`timeInterval` never reaches Android, and no error says so.** expo-location
declares it `Long?` and reads it out of the task's persisted options with
`map["timeInterval"] as? Long` — but those options are stored as JSON, so
`org.json` hands back a boxed `Integer` and a strict `as?` yields null. The
override is skipped in silence and the accuracy preset's own fallback stands:
`High` is 2000 ms, `Balanced` 3000. `distanceInterval` is declared `Int?` and
survives the same round trip, which is why the parameter nobody meant to be
load-bearing is the only one arriving. It is close enough to
`trackEverySeconds`'s floor of 3 to be harmless today, and it means that
setting is INERT on Android — raising it to a minute would change nothing.
Enforce a cadence in JS if one is ever needed; do not trust that field.

**Every activity is logged with where it was done, and it is written in ONE
place.** Four MBOS tables carried a coordinate and twenty-three did not, so an
order taken at a shop, a payment collected at a counter and a complaint raised
in a godown were all recorded with no idea where they happened.
`mbos_activity_locations` is one row per activity rather than a lat/lng pair on
each table — "where was this done" is one question with one answer shape, and
answering it in twelve places is answering it in eleven and forgetting the
twelfth. The server writes it in the sync DISPATCHER and no handler mentions it,
which is what makes a thirteenth entity type carry it by existing; the handset
attaches it in `enqueue`, the one function every write passes through, for the
same reason.

**It is a sibling of the payload, never a field inside it.** `idempotencyKey` is
a hash of the payload, so folding a position in would make the same order
enqueued twice from two spots on a street into two orders. Where somebody stood
is a fact about the act, not part of the record's content.

**A position never delays a save, and never costs one.** `whereNow()` answers
from the freshest fix already known — almost always one the day's trail took
minutes ago, which is why this needs no extra battery — and the top-up happens
after the write has returned. A missing fix, a refused permission, a nonsense
coordinate: the activity lands regardless, which is the same rule attachments
follow and for the same reason.

**Age is part of the reading, exactly as accuracy is.** Four minutes is evidence
of where somebody stood; four hours is evidence of nothing. Both are stored with
their age and `mbos.location.activityFixMaxAgeSeconds` decides what the screens
CALL stale — dropping the older one would throw away a fact to avoid having to
explain it. A stale mark is drawn hollow rather than hidden: the act is certain
and only its place is not.

**No fix is a recorded fact, not a missing row.** Coordinates null with a reason
says we asked and could not; no row at all says nothing asked. Those are
different facts about somebody's day and no screen may render them alike.

**Paperwork carries no location, and that is deliberate.** Leave requests,
agreeing a proposed day and picking shops all happen on a sofa at nine in the
evening as often as anywhere. Where an order was taken answers a real question;
where a form was filled in records where somebody lives and answers none.

**It is written only for an ACCEPTED item.** A refused order did not happen, and
a position for it is a record of somewhere a salesman stood while something
failed — noise on every screen, and one more row held about a person for no
reason.

**A HANDSET'S OWN "NO FIX" SAYS WHICH, TOO.** `getFix` returns a `cause` on
every result without a reading — `permission`, `services_off` (asked of
`hasServicesEnabledAsync` first, so a switched-off phone is not left waiting
the whole timeout), `no_signal`, `error` — and `noFixCauseOf` reads it. The
check-in gate words its refusal from it (`noFixSentence`) and offers
`openLocationSettings` for the two a switch cures. Only `no_signal` is cured
by stepping outside, and telling the other three to do so sent people into
the street to be refused again.
