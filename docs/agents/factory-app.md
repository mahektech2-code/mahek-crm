# The factory floor app

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE FLOOR WORKS FROM A PHONE, AND THE ERP STAYS THE STOCK SYSTEM.** `/factory`
is the mixing, filling, packing and dispatch teams' app — scan a label, see the
picture, enter the count, send — and the Production Head's live view of the
floor. It writes no stock table. A mixing batch is `sfgBatches.forms.new`, a
fill is `fgFill.forms.new`, packing is one `packBatches.forms.new` per pallet
per batch, all called with an `ErpContext` built for the person (`erpCtxFor`),
so the lot locks, the QC gate, the can and box checks and the complete-batch
rule apply to the floor exactly as they do to the office, and the worker is the
author of every document. What the factory tables add is what the ERP never
had: who was GIVEN the work (`factory_tasks`), who DID it by role
(`factory_task_members` — owner, operator, helpers, verifier, kept apart from
whoever pressed Send), why a machine stopped (`factory_downtime`), and what the
Production Head still has to look at (`factory_reviews`). Team output is
counted once, on the task, never once per person.

**A PIN OPENS THE FLOOR AND NOTHING ELSE.** Signing in with the 4-digit PIN,
or with the SMS code that stands in for a forgotten one, makes a
`sessions.factory_only` session that is never password-confirmed.
`getCurrentUser` answers nobody for it outside `/factory` and `/api/factory/`
(`factorySessionAllows`, reading the path `proxy.ts` writes), so a Production
Head or an admin who also holds Factory meets the ordinary password sign-in on
every other app, and the Admin Console's re-check is never skipped. It used to
be the whole-site session, already confirmed: four digits opened everything.
"Send code" answers only somebody holding the Factory app, behind the sign-in
throttle.

**THE FLOOR IS BUILT ONCE PER GODOWN FOR EVERY PHONE ASKING AT ONCE.** Every
phone asks for the whole floor every 45 seconds and after any scan that moved
stock, and nearly all of it is the same for everybody at a godown. `bootstrap`
reads it through `floorFor` (`server.ts`): one build per godown at a time, and
a phone asking while one runs waits for the NEXT, which starts when the running
one ends and answers everybody who asked meanwhile. A build that started before
a question never answers it, so a phone always sees its own write; nothing is
kept once answered — a queue, not a cache. What differs per person (a
department supervisor's narrower floor and review list, names only their jobs
mention, their own number, lorries for loaders) is laid over it on COPIES:
never write to the shared build. A batch of lorry scans reads the board and the
floor once, after its last scan (`judgeLorryScan`), not after every box.

**ONE KEY, ONE POSTING.** The phone mints `MOB-<task>-<random>` when a job is
started and every attempt carries it; `factory_submissions` is the ledger. The
first attempt claims the row, later ones are answered from it, and `progress`
records each ERP document already written, so a packing count spanning two
batches RESUMES rather than repeats. The ERP has no idempotency of its own —
this is it.

**THE PHONE KEEPS WORK FOR 48 HOURS, AND OPENS WITH NO NETWORK.** A service
worker (`public/factory-sw.js`, scoped to `/factory`) keeps the page and its
hashed scripts; the floor data and the queue live in the page's own storage,
and a photo taken offline in IndexedDB. A job finished offline is queued with
when it was finished, sent by itself when the network returns (on reconnect,
on every return to the app, and every 30 seconds), and the ERP document is
dated the day the work was DONE, not the day it arrived. Past `OFFLINE_HOURS`
a job is still taken — it goes to the Production Head first, because stock
read two days late cannot be trusted to still be there.

**THE WORKER IS NEVER HANDED AN ERROR FOR SAVING OR SENDING.** Three answers:
`done`; `held` — received, safe, and with the Production Head as an `unposted`
review item, because the ERP refused it now (a drum used by somebody else while
the phone was offline) and the worker cannot go back to Tuesday to fix it; and
`retry` — not received, kept, and sent again by itself. A job the worker is
still holding that the ERP refuses offers Fix it AND Send to supervisor, so
there is always a way to finish. "Put it in the ERP" on the review posts it
under the WORKER's name; the head's decision is the line in the history.

**THE IN-CHARGE RAISES PURCHASE REQUIREMENTS FROM THE PHONE.** More →
Purchase requirement is offered to whoever holds a department's `owner` crew
seat, a manager over that department, and the Production Head. It covers the
three departments that buy anything (`FactoryCtx.reqDepts`): Mixing &
Blending, Refilling and Packing. It is the ERP's own requirement, raised
through `raiseRequirementWith`, so the department's categories, the material
duties and the purchase rule all still apply. Each item asks only how much to
buy — it used to be COUNTED first, and that went with the blind count (Nov
2026). An APK from before still sends a count: it is written as a stock check
of that shelf by `writeCounted` (matches or not, a mismatch to stock control
through `notifyStockFlag`) and holds nothing. The phone is never sent a stock
figure. The phone's key in `factory_requirement_sends` answers a resend from
the first save. An item can be cancelled from the phone until it is on a PO.
The screens are in the APK, so they reach the floor with a Factory release.

**A FIELD STAYS IN VIEW WHEN THE KEYBOARD OPENS.** On the native app, every
scrolling box offers `reveal` (`ScrollBox` in `web.tsx`), and an `Input` that
gains focus scrolls itself into view, again once `keyboardDidShow` fires.
Don't build a scrolling form that bypasses `Div`'s `overflowY: auto`, or its
fields lose this.

**A MIXING WORKER STARTS HIS OWN BATCH.** Work used to reach the floor only
through a supervisor's Give a task, so a mixing worker with a recipe in the
ERP and nobody to type it in had an empty Home and no way to start. "Start a
mixing batch" on his Home (`startsOwnBatch` in `rules.ts`: a non-supervisor
with mixing among his departments) picks a base that HAS a recipe and how
many batches (up to `MIX_BATCH_MAX`, 10 — the same ceiling Give a task and
the batch sheet use); `startMixingBatch` in `head.ts` checks the recipe again (an
active formulation with a line above 0 L), makes the same `factory_tasks` row
Give a task makes — the standing mixing crew, with HIM in charge — and the job
opens straight into its batch sheet. It posts through the ERP's SFG form like
any other job. A packing worker starts his own packing from a scanned pallet, below. The op is
`startBatch`, and the native APK needs a release to show the button.

**A FILLING WORKER STARTS A FILLING FROM THE TANK HE SCANS.** Scanning (or
typing) an SFG lot on Home used to show the card and close it with a toast.
The card now carries QC and the day it was made, and "Fill from this lot"
opens New filling: the products made from that base (`fillFromLot` in
`rules.ts`, which also words the five refusals the card shows) and how many
cans. `startFillFromLot` in `head.ts` checks it all again against the ledger
(filling is his work, the lot is here, has stock, is QC approved, and the
product is of that base), makes the same `factory_tasks` row Give a task
makes with him in charge and the lot as its `sfg_lot`, and the job opens
with that tank already scanned (`Draft.fromLot`, phone-only). It posts
through the ERP's FG fill form like any other filling. Saved offers "Fill
more from" the same lot. A mixing or packing worker sees the card with OK
only. The op is `startFill`.

**A PACKING WORKER STARTS A PACKING FROM THE PALLET HE SCANS.** Scanning (or
typing) an FG lot on Home shows when the cans were filled and how the product
is boxed, and "Pack from this lot" opens New packing batch — the ERP's own
questions: the FG product is the lot's, then which boxed SKU (`packFromLot` in
`rules.ts`, which also words the refusals: not his work, another godown,
nothing left, sold loose, fewer cans than one box), then how many boxes.
`packNeeds` says what that takes: the cans, the open batch of that box filled
first, and the empty boxes — a NEW batch takes all of its boxes on its first
line, exactly as the ERP's packing form does, so `packBatchPlan` counts whole
new batches and `emptyBoxShort` greys out Start where the godown is short
(`FactoryData.emptyBoxes`, null where the ERP does not count that box type).
More boxes than the lot holds is allowed: the job scans another pallet.
`startPackFromLot` in `head.ts` checks it all again and makes the same
`factory_tasks` row Give a task makes, with him in charge; the job opens with
the pallet already scanned (`Draft.fromLot`, phone-only) and posts through the
ERP's packing form like any other packing. Saved offers "Pack more from" the
same lot. The op is `startPack`.

**A MIXING WORKER MAY USE HIS OWN RECIPE, AND THE HEAD IS TOLD.** The job's
first step draws the batch sheet with "Use my own recipe" under it: the editor
opens with the sheet filled in, any active raw material can be added (those in
stock at his godown first), litres per batch changed and a material taken off;
"Batch sheet" puts the ERP's recipe back. `Draft.ownRecipe` marks it and `rm`
then carries his `per`; `recipeLines` is what the first step and the review
read, `recipeProblem` is the one sentence the screen and `postMixing` both
refuse with, and `mixDeviation` holds the yield to his recipe's litres. It is
not a gate: the batch posts through the ERP's SFG form as always, and a
`manual` review item "Own recipe used" puts his recipe beside the batch sheet
for the Production Head.

**EVERY SCAN CAN BE TYPED.** The scan screen — one screen for every purpose,
badge, task sheet, drum, base, cans, pallet, loading, empty drum and LR — has
"Type the code" under the camera. What is typed goes through `doScan` exactly
as a scan does, so it meets the same check and is not flagged to the
supervisor the way "pick from photos" is: it names one label, it does not
choose from a list. `typedCode` in `rules.ts` matches it against every code the
phone holds ignoring spaces and case, and answers in the label's own spelling;
the camera pauses while somebody types.

**AN OLD PAGE STILL SENDS.** A station phone keeps its page for days. So the
phone never calls a server action — their ids change on every deploy — but
`/api/factory/rpc` by op NAME, and an op is added and never renamed or
removed. The payload carries `v`, and `normalizeDraft` reads every shape there
has been: numbers as text, a bare "HH:MM", fields an old page never had. A page
that sees a newer build in an answer reloads itself, but only once nothing is
in hand and nothing is waiting to send.

**A MIXING MATERIAL MAY COME FROM SEVERAL DRUMS, AND NEXT WAITS FOR THE
SHEET.** A drum that holds less than the sheet asks is poured empty and "Add
another drum" opens a row for a second lot of the same material (`extra` on its
`RmLine`; only those rows come off again); emptying a drum with the sheet still
short opens that row by itself. `rmTotals`, `rmPlan`, `addRmDrum` and
`removeRmDrum` in `lib/factory/rules.ts` are the rule, shared by both apps, and
`stepCheck` holds the materials step until each material's drums add up to
exactly `per × batches`. Each drum is its own ERP line on the one SFG batch,
which the ERP already reads per lot and sums per material for the recipe check.
There is no "How much was made" step any more: the batch made what was poured
(`mixMade`), and the machine-stopped question moved onto the materials page. A
draft from an older page that carries `out` is still read with it. The Saved
screen has no Print QR label button.

**SIGNING IN IS A NUMBER AND FOUR DIGITS.** The mobile number, then a PIN
(hashed like a password, throttled like one). A forgotten PIN is the SMS code
the web sign-in already sends, then a new PIN. A badge QR only says WHO — the
PIN is still asked.

**STAFF ARE PLACED IN ADMIN CONSOLE → ACCESS, BESIDE THE FACTORY GRANT.**
Ticking Factory draws a Department row: the department, their seat in its
standing crew (in charge, operator, helpers, who checks), their badge, and
whether HR has confirmed the name and role. With the grant's level it is a
DEPARTMENT-LEVEL permission (`lib/factory/departments.ts`, read by the dialog
and enforced by the server): an associate works their department's jobs only;
a manager of a department supervises THAT department — its Today, its review
items, its teams, Give a task for it — and nothing else; a manager of the whole
floor is the Production Head. Picking the whole floor raises the level to
manager, the way an ERP designation sets the ERP's. Taking Factory away takes
the place with it. The seat writes `factory_team_defaults` — one person in
charge and one operator per department, any number of helpers — which is what
every new job starts with. `npm run factory:staff` does the same from a
terminal, for a pilot — in one transaction that also rebuilds `users.role`
(`rederiveAccountLevel`: a Production Head is a manager) and writes an
`access.factory-staff` audit row with no actor, as `app:grant` does. Whoever a
seat is taken from — by the script or by the Access dialog — gets an
`access.factory-seat-displaced` row on their own trail naming who took it.

**A PERSON MAY WORK SEVERAL DEPARTMENTS, and the phone switches between
them.** The Department row is a set of checkboxes, not a dropdown: a loader
who helps on the packing line is in Dispatch AND Packing, with a crew seat
answered per ticked department. `factory_staff.areas` is the whole list
(`0261`); `area` stays its first, so every reader that knows one department
reads the one it always read. The whole floor is a list of one (ticking it
clears the rest — it already covers them), and `cleanDepts` keeps the stored
order fixed. An associate does the jobs of any of their departments
(`worksOn`); a manager supervises exactly the ticked ones (`FactoryCtx.scopes`,
null for the whole floor or quality). `scope` is still sent, as the one
department when there is exactly one, because an APK in the field reads it.
On the phone, `myDepts`/`activeDept`/`inDept` in `lib/factory/rules.ts` (pure,
shared by both apps) decide what shows: somebody with more than one department
gets a pill under their name that opens "Which work are you doing now?", and
chips across My work — All my work, then each department with its open jobs.
The pick is a VIEW, remembered per person on the phone, and never a
permission: scanning a task of another of their departments still opens it,
and the server never reads the pick.

**Loading never waits for the office to give lots.** A Ready order opens on
the phone, and the box or lot label the loader scans is judged by the ERP's
dispatch desk (`scanOntoOrder`), which allocates it there and then, as at the
office desk. The load step owes "still to find" until every line's lots cover
it (`stepCheck`), and the phone sends any label the order was not given to the
server rather than refusing it (`lotGiven`).

**Loading is CHECKED, never dispatched.** The dispatch team scans the
allocated lots, loads exactly what the order takes, ticks the checklist and
photographs the truck; the ERP's verification, transport row and order book
stay with the office (PRD §7.4.6).

**LOADING IS BY TRANSPORTER, ITEM BY ITEM, and that is a reversal (Oct
2026).** The two paragraphs above are how an older page loads, one order at a
time. Today's page shows "Transports to load" on Home: every Ready line at the
godown that is not yet dispatch-verified, whatever its day, grouped by the
transporter typed on the line (`lorryKeyOf` ignores spacing and capitals; no
name is its own row). Tapping one opens its loading straight away. The step bar
is Load → Team → Check and send (`stepsOf`), with no order step, checklist or
truck photo. The loader never picks or sees an order. `lib/factory/lorry.ts`
picks the order each scanned box goes onto: an approved override's line first,
then a line whose allocated lot the box is from, then the soonest due. It then
calls the desk's own `scanOntoOrder` there. A lot label (stock with no box ids,
and loose cans) fills orders soonest due first until the lot runs out. A
mismatch is asked about against an item still short on the lorry
(`requestOverride` takes that line). The job (`factory_tasks`, item = the
lorry key, no `order_no`) is made by the first scan that loads something, so
opening a transport starts nothing. A box scanned on Home opens the one lorry
that needs it, and asks only when several do. Team stays locked until every
piece is on. Sending closes the older one-order jobs for the lorry's orders,
and the lorry shows "Loaded · waiting for the office" until the office
verifies. `ensureDispatchTasks` still makes one-order jobs for APKs older than
this; today's page does not list them (`isOrderLoad`).

**THE ANDROID APP IS NATIVE, AND IT IS THE WEB APP'S SCREENS.** `factory-mobile/`
is an Expo app — the APK on `/download/factory` — and it was first a Trusted
Web Activity around `/factory`. Floor staff asked for an app rather than a
website in one, so the screens moved onto the phone: `factory-mobile/src/
factory-app.tsx` is `src/app/factory/_ui/factory-app.tsx` with its elements
swapped for `web.tsx`'s and its browser parts for the phone's. `web.tsx` is
the reason that is a port and not a redesign: `Div`, `Span`, `Btn` and
`Input` take the design's own inline CSS and draw View, Text, Pressable and
TextInput, doing what the web does and native does not — text style
inherits, `display: flex` is a row, flex items shrink, a run of words is one
paragraph, `display: grid` with N columns, `overflow: auto` scrolls. A screen
changed on one side and not the other is a regression on the floor, so a
change to either file is a change to both.

**THE RULES ARE NOT COPIED.** The phone imports `lib/factory/rules`, `types`
and `i18n` from `../src` through its Metro config, so a scan is judged by the
same function on the phone and on the server, and the phone still decides
nothing the server does not decide again. `native-imports.test.ts` pins that
list and walks it for server code, because a database driver reached from
there would ship inside an APK nobody can recall.

**THE SESSION IS A HEADER.** A phone has no cookie jar, so the rpc route
returns the session id as `x-factory-session` when a call changes it, the app
keeps it in SQLite, and `proxy.ts` turns the header back into the
`mahekone_session` cookie on `/api/factory/*` — every action resolves the
person exactly as for the browser. The page at `/factory` still works and is
what a laptop opens; the queue, the 48 hours, the idempotency key and the old
-version rules above are the server's and hold for both.

**WORK IS ONE TAB, SETTINGS ANOTHER.** The name used to open one long sheet
mixing the day's tools with the phone's settings. A worker's bar is Home ·
More · Scan · Sending · Settings; the Production Head's is Today · Review ·
Scan · Teams · More, with Machines and Sending inside More. More holds the work
(Stock check, Quality check, Empty drum entry, Upload LR); Settings holds who they are, the
language, the PIN, Help and Sign out, and tapping the name opens it.

**QUALITY CHECKS SFG LOTS FROM THE PHONE, WITH THE TESTING LIST.** More →
Quality check lists the SFG lots waiting for QC (Pending, with litres left)
and those decided in the last week, and asks each ACTIVE Testing-list value
as Pass / Fail beside an optional note — the ERP's SFG batches decision on a
phone. `lib/factory/qc.ts` reads the answers with the same `readQcTests`
(approving needs every test answered and passed; rejecting records what was
run and needs a reason), writes the same `erp_sfg_qc` row and the same
`erp.sfg.qcApprove`/`qcReject` audit lines, so the fill gate cannot tell the
doors apart. `FactoryCtx.qc` decides who sees it: somebody placed in the
Mixing & Blending department, and nobody else — not Quality, not the
Production Head, not an ERP power holder (Mahek's rule, Oct 2026; the ERP's
`approveSfgQc` power still decides on ERP → SFG batches). It needs the network, like Stock check: the list is
read again at the save.

**THE SCAN PAGE HAS TWO MODES, SCAN AND TYPE.** "Type the code" swaps the
whole screen: the camera stops, the frame and torch go, and a large box takes
focus so the keyboard opens; "Scan instead" (or the phone's Back) returns to
the camera. A phone with no camera, or one not allowed, opens straight in Type
mode — once, so "Scan instead" is not bounced back (`camState`, `camAsked`).
The typed text survives a refused code, so "Try again" is a fix, not a retype.
A typed code is judged exactly as a scan (`submitTyped` → `doScan`).

**IN A COLUMN NOTHING SHRINKS (`web.tsx`).** The web never squeezes a box below
its content in a column (`min-height: auto`); native has no such floor, so the
old blanket `flexShrink: 1` crushed buttons, inputs and cards whenever a screen
or sheet ran short of height. Items shrink only inside a row, and a scrolling
box is the one thing in a column that gives way.

**LRs COME IN STACKS.** Upload LR opens on Many photos: up to `LR_BATCH_MAX`
(20) from the camera or the gallery, uploaded three at a time, and stored in
one press by `saveLrPhotos` as photo-only LRs for the LR desk to match. A photo
that fails stays in the tray to resend; a resend stores nothing twice; a file
that is not the sender's own fresh upload is refused. Reading them is
secondary: `readStoredLrs` runs after the answer (`after()`), only where
`erp.ai.photos` is on, fills only blank fields, and leaves an unsure number, or
one already on the desk, as a note for the desk instead of writing it.

**THE PHONE ASKS TO UPDATE ITSELF, AND REFRESH IS ONE BUTTON.** The round
button in the header sends what is waiting, pulls the latest from the office
and asks whether a newer APK is out, all in one press. The newer build is read
off `/downloads/factory.json`, the manifest the release workflow already writes
beside the APK, compared by versionCode (`factory-mobile/src/update.ts`, pure
and tested). It is asked on opening, on every return to the app and every half
hour. Where one exists, a popup offers Update now or Update later. Later is a
three-hour snooze (`SNOOZE_MS`, one per phone in `kv`), never a dismissal, and
a refresh pressed by hand asks at once. The popup waits while a job, a scan or
a result is open. Update now downloads the APK INSIDE the app with progress
(`updater.ts`) and hands it to Android's installer, which opens over the app;
that confirmation cannot be skipped, because only a device owner installs
silently. It needs `REQUEST_INSTALL_PACKAGES` and `expo-intent-launcher`, so it
arrives with an APK and older builds never show it. A failed download offers
the browser. The web page has the refresh button and no popup, because it picks
up a new build by itself.

**THE FLOOR READS A 12-HOUR CLOCK; THE APP KEEPS A 24-HOUR ONE.** Every time
a person reads — the header clock, a job's due time, "saved at", the history,
review notes — says "3 PM" or "9:05 AM" (`clock12`, and `clockText` for a time
inside a sentence, both in `lib/factory/time.ts`). What is stored and compared
stays "HH:MM" on the 24-hour clock (`hhmm`, `nowHM`), because "is this job
late" is a string comparison and "3 PM" < "10 AM" is not. Convert only where it
is drawn, never before it is stored.

**A SCREEN CHANGE NEEDS A RELEASE; A RULE CHANGE DOES NOT.** The screens are
in the APK now, so they reach the floor only through the Factory APK
workflow (DEPLOY.md); what the server accepts and posts still changes with
every deploy. Test the app with no device: `cd factory-mobile &&
EXPO_PUBLIC_SITE=http://localhost:3000 npx expo start --web` runs the same
code in a browser, where the scanner takes its no-camera path and offers the
floor's real labels to tap.
