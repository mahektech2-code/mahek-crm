# Roles, hats, access, security, OTP history, Ask about the team

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A ROLE IS A LEVEL. THE APP IS THE JOB.** There are three roles and there are
three in every app: **associate, manager, admin**. There used to be four —
`telecaller`, `manager`, `accounts`, `admin` — and they were two different
ideas in one list: two levels of seniority beside two job titles borrowed from
two particular apps. So a grant for any THIRD app had no honest word for
"ordinary worker", and the Access screen offered the CRM's job title instead:
it asked managers to make a field salesman a *telecaller*, and the seed agreed
— `mahesh@mahek.in`, who has never made a phone call for this company, was
stored as one. So was anybody on Reports, on the Sales Dashboard, or on HRMS.

`telecaller` was ALREADY the base level rather than a job. The old `can()`
ended with `return !MANAGER_ONLY.has(capability)` — you hold anything not
explicitly withheld — which is the definition of an associate, and is exactly
why a salesman could be given that value and still work correctly.

**A HAT IS AN APP AND A LEVEL, and `can()` takes one.** `app_access` has
stored one row per person per app since roles were split off `users.role`, so
the pair was always there to be read; only the vocabulary is new. Associate on
Accounts is the clerk, associate on the CRM is the telecaller, associate on the
Salesman App is the field salesman — one level, three jobs, decided by the
grant rather than by a word.

**ADMIN ON AN APP IS ADMIN OF THAT APP, and only Admin on the Admin Console is
the platform.** Until `0197_admin_is_per_app`, `can()` answered yes to every
capability for any hat whose level was `admin`, whatever app it was worn in, and
the account level copied the widest level onto `users.role` — so "HRMS admin",
given to somebody to hand them every HRMS power, approved orders, confirmed
payments, read every salary and could sign in as anybody. Admin of an app now
holds that app's manager list, every power of that app (HRMS, ERP) and its
off-by-default screens, and nothing anywhere else. Admin on the Admin Console is
the PLATFORM ADMINISTRATOR and holds everything; `isPlatformAdmin` reads it off
the grants, and `users.role = 'admin'` is derived for exactly that person and
nobody else, so the checks that read the account's level as "may do anything"
(impersonation, the HRMS/ERP administrator bypass, national sales scope) now mean
it. `admin-is-per-app.test.ts` pins every half.

**ONLY A PLATFORM ADMINISTRATOR CHANGES ACCESS.** `setAccess`, disabling a
sign-in, ending sessions, mailing a reset link and issuing a password all go
through `requirePlatformAdminUser` (`access.manage`, in `ADMIN_ONLY`). They were
gated on `isManager` — a manager of ANY app — and a server action is a URL, so
the Admin Console's page gate protected nothing: any manager could post
`setAccess` for themselves with `admin` on every app. Nobody removes their own
administration, and nobody removes or disables the last platform administrator.
`setUserRole`, `setUserApps`, `createUser`, `updateUserIdentity`,
`createTeamMember` and `setAppAccess` were deleted: no screen called them and
each was a second door onto grants that knew nothing about modules or levels.

**A GRANT WITH NO LEVEL IS AN ASSOCIATE'S.** It used to mean the account's own
level — the widest held anywhere — so a CRM grant made from a terminal became a
CRM manager the day its holder was made a manager of anything else. The
migration wrote every null row down to the level it was resolving to that day,
so nobody's reach moved on deploy; `npm run app:grant` now writes a level (`--level=`, default associate) and derive the
account level rather than typing it.

**The matrix is one table, in `lib/capability-matrix.ts`** — pure and
client-safe, so the Access screen can say what a level CARRIES
(`lib/capability-labels.ts`, a `Record` over every capability so a new one fails
the build until it is worded) from the same table the server enforces.
`access-control.ts` re-exports it. Each app names what its own two lower levels
carry; admin of an app reads its manager list, and the platform administrator
holds everything and is not listed. The three bundles it hands out — `BOOK_WORK`, `BOOK_MANAGEMENT`,
`LEDGER_DECISIONS` — are DERIVED from the capability sets above them rather
than retyped, because those sets carry the reasoning for why each capability
sits where it does, and a hand-typed copy would be a second answer that drifts
from the argument that produced it. Tune WHERE a bundle goes in the table; tune
WHAT is in it by moving a capability between the sets, beside the paragraph
explaining it.

**THE LEDGER APPS ARE WHY THIS IS PER-APP.** `order.approve`, `payment.confirm`,
`creditnote.issue` and `customer.reassign` used to hang on a role called
`accounts`, which is how they were kept away from managers — "the person
chasing a target must not sign off the orders that hit it". With `accounts`
gone as a role the Accounts APP carries them, so a CRM manager still cannot
approve an order and an Accounts manager can. That is STRICTER than the old
rule rather than looser: an accounts clerk who was also given the CRM used to
carry order approval into it.

**And inside that app the level decides.** An Accounts associate records and
reads — `payment.record` is SHARED and `customer.read` is what a statement is
made of — and every decision that moves money is the Accounts MANAGER's. That
is why the migration maps the old `accounts` role to **manager**, not
associate: mapping it "junior" because the word sounds junior would have taken
order approval away from the only person who had it, and the approvals queue
would have stopped on deploy day.

**A LEVEL WITH NO GRANT IS NOT A GRANT.** A hat with no app carries only what
every signed-in person carries. Reading the account's own role as a grant is
how somebody with a `manager` account and no apps at all would quietly hold
every manager capability in the building — which is what `can(user.role, …)`
did at twenty-two call sites, all of them now `canFor(user, …)`, the union over
real hats.

**What you may DO is the union; what you may SEE is resolved PER APP.**
Hold a capability under any hat and you hold it — `canAny`, and
`requireCapability` checks the union. None of its 117 call sites changed when
roles became levels, because it gathers the hats itself. Scope is the other
half: `src/proxy.ts` names the app on the request from its URL prefix, and
`resolveScope` reads the grant for THAT app.

**THE LEDGER DESK SEES EVERY BOOK, and that is a fact about the app rather than
the level.** The approval queue is every associate's orders and nobody's own
book. It used to key on `role === "accounts"`; keying on the LEVEL instead
would empty the queue from either end — an associate scoped to their own book,
a manager scoped to their reports, and a clerk has neither. Where the request
names an app, `hat.app === "accounts"` answers it. Where it names none — a job,
a script, a test, the MBOS handset — `hatInForce` asks the GRANTS instead and
honours only the case that used to be expressible: somebody whose apps are the
ledger desk and nothing else, which is exactly who `users.role = 'accounts'`
meant. A person who also holds the CRM is left to the header, as they already
were.

`users.role` stays derived — `admin` for the platform administrator, `manager`
for anybody who runs or administers any app, `associate` otherwise — because two
things still want "is this person a manager at all": `isManager`, on screens
deciding whether to DRAW a control, and the fallback where there is no app to
ask about. **It is not "a manager HERE."** A screen deciding what to draw inside
one app asks that app's level (`managesHere` in `lib/scope.ts`,
`levelInApp`), and a write asks a capability: a manager of HRMS is an associate
in the CRM and gets the CRM associate's view, discount ceiling and buttons. One consequence is worth naming rather than discovering: an
Accounts manager now passes `isManager`, where the old `accounts` role did not.
That is the model working — a manager of the ledger is a manager — and it
widens the handful of things gated on `isManager` alone rather than on a
capability, feedback triage among them.

**And it can only ever NARROW.** The derived level is no narrower than any hat,
so a per-app hat is by construction no wider. Resolving per app can lose reach and
cannot gain it — which is why 73 call sites of `resolveScope` did not have to be
audited one at a time. The header is stripped off the incoming request before
the proxy writes it, so a client cannot post its own `x-mahek-app: admin`. An
`/api/*` route names no app by its path, so the proxy takes the app from a
SAME-HOST Referer instead (host, not origin: behind Caddy the app sees http); without that, every shared API read fell back to
the account's widest level, and an HRMS manager searched the CRM book as a
manager. Believing the Referer is safe for the same reason the header is:
`requestHat` still demands a real grant in the app it names.

**The audit records WHICH HAT allowed it, and that now takes TWO columns.**
With one role per person, "was he allowed to do this" was answerable from the
person; with several it is not. `requireCapability` returns the granting hat and
every audited action writes `audit_log.actor_role` and `actor_app`. The second
became necessary the day roles stopped being job titles: `accounts` said the
clerk did it and `manager` said seniority carried it, and `associate` says
neither — the app is what tells the person at the ledger desk from the person
on the phones. It asks for the NARROWEST hat that carries the capability, not
the most powerful, and prefers one naming an app over the account's own: admin
holds everything, so asking admin first would stamp "admin" on every action
anybody senior took. Null means not recorded, never "no role".

**A refusal names what would have allowed it, and only when it can.** The app
is named where exactly ONE carries the capability — `order.approve` is the
Accounts desk's and nowhere else — and left out where several do, because
`team.report` belongs to the manager level of five apps and naming whichever
sorted first would send somebody to ask for the wrong grant. `requirementFor`
searches the matrix rather than declaring an answer beside it, so the sentence
cannot name a grant that does not exist.

**Two hats that should not meet are named, never refused.** The matrix keeps
`order.approve` away from managers on purpose — the person chasing a target
must not sign off the orders that hit it — and a union of hats can put both on
one person. At nine people that is sometimes the only way the work gets done,
and a system that refuses it is defeated in a minute by granting admin instead,
which grants far more and records no reason. So the combination is allowed, the
review page says in words what it lets them do, and every action taken under it
carries the hat that authorised it. The rules are in `lib/role-conflicts.ts`,
pure and client-safe because the review page is a client component and a second
copy typed into the screen would drift — and the half that drifts is always the
half somebody reads. **A conflict is between two HATS**, not two roles: it used
to read "telecaller and accounts", which was a sentence only because two of the
four role values were secretly app names. "Associate and associate" says
nothing, so the pair names the apps, and the level sits beside it where the
level is what makes the pair bite. An Accounts associate approves nothing, but
edits price lists, so it clashes with whoever quotes prices on a call. A
PLATFORM administrator matches every pair by construction, so they are told
none; admin of one app is checked like any other hat, and a rule naming the
manager level is true of that app's administrator too.

**Access is granted to a person, and the people are in HRMS.** The console's
People section is one screen, Access, and its dialog reads the employee master
rather than the accounts table. Somebody with no MahekOne account gets one
created in the same breath — no password is typed into the dialog, because that is a password
somebody reads out over a phone; the account is created unusable and a
single-use reset link is what makes it usable. **The employee must be ACTIVE in
HRMS**, checked in the action and not only in the picker. A leaver is listed
with the reason rather than hidden, because a person missing from a search box
reads as a broken search box.

**One dialog per person, and it holds every app at once.** Granting an app,
narrowing one, widening one and taking one away are the same act — somebody
deciding what this person's MahekOne looks like — so they are one page and one
write. Doing them an app at a time meant opening the same dialog four times to
set up one telecaller, with no screen ever showing the whole answer. The middle
page IS the whole answer: every app with a checkbox, every module of a ticked
app beneath it. The page after it is the review, which names in words what is
granted, narrowed, widened and taken away before anything is written — revoking
happens by unticking a box, which is a small gesture for a large consequence.

**An app is granted if and only if at least one of its modules is ticked.**
That removes the one invalid state the screen could otherwise express — an app
held with nothing inside it, whose every route redirects somewhere else —
rather than drawing it and refusing it at the save. `setAccess` takes the whole
desired picture and works out the difference itself, so what was reviewed is
what is written.

**Disabling a sign-in is not revoking access, and the screen says which it is.**
Whether somebody can sign in and what they would find if they did are two
questions, and the Access screen answers both in the same row — Enabled or
Disabled beside the person, the apps beside that. A disabled account KEEPS its
apps: somebody away for a month comes back to the book they left, and a
leaver's grants are still the record of what they could reach. Conflating the
two would silently destroy that record on a click meant to stop a login.
`getCurrentUser` already refused an inactive account, so this was enforced
before it was reachable; what disabling adds is deleting the sessions, because
a row good for thirty days is a thing somebody has to reason about later and
disabling should leave nothing to reason about. Manage access is refused on a
disabled account rather than half-working, and says why.

**There is ONE place an app is granted.** The user record's Access tab used to
carry its own checkboxes, which made two ways to do it — and only one of them
knew about modules, so revoking and re-granting from there quietly widened a
narrowed grant back to the whole app. That tab is read-only now.

**Signing in writes a sign-in log, and that is NOT attendance.** One row per
person per day in `attendance` — a table whose name is a misnomer kept until
the real thing takes it. A sign-in says somebody opened MahekOne, from home,
on a phone, at 2am; `signedOutAt` fills in only for the few who press Sign out
rather than closing the tab, so hours cannot be derived from a pair of these.
Two screens used to say "attendance recorded for today" and "signing in opens
your attendance", and both have been corrected — no screen may present this as
a record of who was at work. **Attendance is a check-in system with its own
screens, and it is not built yet.** A second sign-in the same day reopens the
same row, so a lunch break does not read as two sessions.

**A forgotten password is the person's own problem to solve.** `/login/forgot`
mails a link to the work email on the account; `/login/reset` spends it. Only
the SHA-256 of the token is stored, it works once, it expires in 30 minutes,
asking for a new one kills the old one, and using it deletes every session that
account had. The reply is the same whether or not the address has an account —
this form is not a staff directory. Without `RESEND_API_KEY` and `MAIL_FROM`
the mail is written to the server log rather than sent, and the screen says so
rather than claiming it went.

**A WRONG PASSWORD IS COUNTED, and enough of them shut the door for a while.**
Nothing limited guesses: the form could be posted as fast as a script could
post it, and a platform administrator's password was the whole of what stood
between the internet and every power in the console. `sign_in_failures` holds
one row per wrong password, counted per ACCOUNT (`auth.password.maxFailures`)
and per ADDRESS (`auth.password.maxFailuresPerAddress`, set well above it
because an office shares one) over `auth.password.failureWindowMinutes`. The
web sign-in, the handset sign-in and "change password" share ONE count, keyed
on the account — a second door with its own fresh allowance is not a limit. It
is asked BEFORE the password is checked, so a paused account answers the same
whether or not the guess was right; otherwise the pause is an oracle. The way
round it — a WhatsApp code, or a reset — is named only where it exists.

**THE CONSOLE ASKS FOR THE PASSWORD AGAIN.** A session lasts thirty days and the
console can sign in as anybody, so a laptop left open used to be a platform
administrator. `sessions.confirmed_at` is when the session last proved its
password: signing in sets it, an impersonation link does NOT (it proves nothing
about the person it signs in as), and the console's layout sends anything older
than `auth.console.confirmMinutes` to `/login/confirm`. Each console page moves
a fresh one forward, so the clock measures time AWAY. It is enforced again in
`requirePlatformAdminUser`, in the secrets actions and in a platform
administrator's settings writes, because an action is a URL with no layout in
front of it. The rest of MahekOne never asks.

**Impersonation does NOT tell the person, and that is a reversal (Nov 2026).**
It used to put a warn notification on the account holder's bell. Mahek's
decision: what an administrator does in somebody's account is the
administrator's doing, so nothing reaches the account holder. The record is
the `impersonate.enter` audit row under the administrator's id.

**There is no HTTP door that grants access any more.** `/api/admin/provision`
granted anything to anybody behind `CRON_SECRET` — the secret the Apps Script
on two workbooks holds so the syncs can run, so editing a sheet was enough to
read it and make yourself a platform administrator. It is deleted. The Access
screen and `npm run app:grant` are the ways in.

**Security headers come from `next.config.ts`, not the Caddyfile**, because a
deploy never copies the Caddyfile: HSTS for a year, and `frame-ancestors 'self'`
(with `X-Frame-Options: SAMEORIGIN`) so no other site can frame the console and
steer an administrator's click.

**A WHATSAPP CODE IS THE OTHER WAY IN, offered only where it can work.**
`lib/services/otp-service.ts` sends a one-time code to the WORK NUMBER ON THE
ACCOUNT — never to a number typed at the screen — for signing in (web and the
MBOS handset), changing a password, and resetting a forgotten one. It is
switched on by naming an APPROVED Wati authentication template in
`auth.otp.whatsappTemplateName`; blank or unapproved, every screen shows the
password alone and says nothing about codes (a control that fails when pressed
is worse than one never offered). It does not depend on the founder's WhatsApp
switch — that one is about messages to customers.

**Only a salted hash of each code is stored** (`auth_otps`, `sha256(id:code)`),
one row per code, one use, one purpose — a sign-in code cannot change a
password. Wrong guesses, lifetime, the resend cooldown and the per-window cap are
the `auth.otp.*` settings. A code sign-in goes through `completeSignIn`, the
same tail as a password; on the handset it takes the password's place inside
`runLoginChecks`, so every later check (active, the field app, device binding)
still applies, and it leaves no offline credential behind. Where codes are on,
changing a password takes a code instead of the current password.

**EVERY OTP IS ON THE ADMIN CONSOLE, including the ones that were never
sent.** Admin Console → People → OTP history (`/admin/otp`, platform
administrators only — it names people and their personal mobiles) lists each
request: who, the HRMS employee behind them, what they typed at the screen,
where they asked from (`surface`: web, handset, settings), the number it went
to, MiniMoth or Wati and that provider's own id and answer (`provider_ref`,
`provider_response`, any field that could be the code stripped first), every
check of the code (`attempts`, `last_attempt_at`, `last_attempt_result`), the
IP and device — and a By person tab answering "how many times". The status is
DERIVED, never stored: `otpStatus` in `lib/otp-history.ts` and its SQL CASE in
`otp-history-service.ts`, pinned together by a test.

**A REFUSED REQUEST IS A ROW, AND ONLY HISTORY.** The cooldown, the window cap,
a missing HRMS mobile and a closed account used to refuse with nothing
written, so "she pressed it five times" was invisible. They are written now
with `refused_reason`, and `notRefused` keeps them out of all three questions
`sendOtp`/`verifyOtp` ask: counted towards the cooldown a refusal would extend
itself, counted towards the cap pressing the button would spend the allowance
without a code, and as the newest row it would shadow the code that WAS sent.
The digits are never on the screen and cannot be — Wati codes are a salted
hash, MiniMoth's never reach MahekOne.

**`otp_channel` was declared in schema.ts and never created by a migration**;
`0168` creates it, guarded.

**"ASK ABOUT THE TEAM" READS THE DATABASE, THROUGH THE ASKER'S OWN ACCESS.**
It used to hand OpenAI one pre-written brief of this month's figures and
forbid anything else, so "when did Mahesh take leave this year" or "which
shops did Priya visit on Tuesday" could never be answered. Now the model writes
its own reads through one tool, `run_sql`, as many as a question needs
(`salesAsk.maxQueries`), and `/api/sales/ask` streams each read and the answer
as they happen. What makes that safe is structural, not the prompt:
`team-ask/catalog.ts` builds TEMPORARY VIEWS named after the real tables, for
one person — only the tables a Sales Dashboard screen they hold already shows
(leave needs Leave, salary needs Salary, the trail needs the Live map: the
Access screen's own answer), only the rows `managerScope()` lets them see, and
never a credential, identity number or raw sheet snapshot. The transaction sets
`search_path = pg_temp` so those views are the only relations a name can
reach, is READ ONLY, runs each query in a savepoint under
`salesAsk.queryTimeoutSeconds`, and is ROLLED BACK so the views vanish with it.
`team-ask/sql-guard.ts` refuses what spells its way round that: a
schema-qualified name, `pg_*`, anything that runs a query from a string
(`query_to_xml`, `ts_stat`), comments, more than one statement. The session
zone is `APP_TIMEZONE`, so `current_date` is India's day. It cannot act: no
write, no approval, no nudge. A table added to the catalog needs its module
named and its scope rule stated, or it is everybody's.

**AND IT IS REMEMBERED IN THREE LAYERS, so a question touches the database only
when it has to.** A person's access (scope, screens, the views, the prompt) is
kept for `salesAsk.contextCacheSeconds` — opening the drawer warms it, and an
Access or Territory change reaches the panel within that window. A query's rows
are kept for `salesAsk.resultCacheSeconds`, keyed on a hash of the exact view
definitions plus the normalised SQL, so two managers who see the same rows
share them and two who see different rows never can. A FRESH question's answer
is kept for `salesAsk.answerCacheSeconds` and replayed with no model and no
database; a follow-up never is, because its meaning is the conversation. The
connection is reserved only on the first cache MISS, so a fully remembered
question never takes one. The prompt puts the rules and schema first and the
date and name last, with a `promptCacheKey` per visibility, so OpenAI reads the
long prefix from its own cache. All of it is in memory and re-derivable — losing
it costs a slower answer, never a wrong one.

**AND IT ANSWERS ONLY WITHIN THAT ACCESS, which the views alone could not
promise.** The views decide what the model can READ; they cannot stop it
answering "what is the company's revenue?" from a telecaller's own book and
saying it as the company's figure — wrong, and believable. `team-ask/boundary.ts`
(pure, tested) is the rule, in every Ask prompt: a narrowed reader's question
about the company, another employee, another department or a customer not in
their tables is declined in one sentence, never answered from the partial rows;
every total is named for what it covers ("in your book"); and profit, margin
and cost are declined for EVERYBODY, because no view carries a cost. The views
back it: a product's cost is in no view (its price is in the CRM's, where it
is quoted, and not the Sales Dashboard's), `places.shops` — a company-wide
count — is shown only to a reader nothing narrows (`nationalOnlyCols`), and an
employee's private details (`PERSONAL_COLS`) are in no view. The ERP's prompt
says the same about its screen tools.

**ONE HEADER BOX FINDS A THING OR ASKS ABOUT IT, in the ERP, the CRM and the
Sales Dashboard.** `components/shell/smart-search.tsx` searches as it
is typed and answers with one flat list grouped by what each row is
(`SearchHit` in `lib/search-hit.ts`): customers, leads, bills, orders,
complaints, salesmen, products and the screens this person holds — built by
`lib/services/app-search-service.ts` through `/api/crm/search` and
`/api/sales/search` (the ERP's rows are `erpSearch`, through `/api/erp/search`), narrowed by `scopedToUsers` or `managerScope`, and a kind
of record is searched only where its screen is held. ↑ ↓ and Enter work it.
What reads as a question (`looksLikeQuestion`: a trailing "?", or a sentence
starting with a question word) puts "Ask AI" first, and choosing it opens the
app's Ask AI drawer with the answer already coming. `/api/search` keeps its
three sections for the two pickers that read them.

**ASK AI IS ONE DRAWER AND ONE ENGINE, and an app joins with a catalog.**
`components/shell/ask-panel.tsx` (the "Ask AI" header button) streams from the
app's endpoint; `team-ask-service.ts`'s `answerStream` is the model, the one
`run_sql` tool and the caches for every app. The CRM's catalog is
`team-ask/crm-catalog.ts`: the same temporary-view rule, with `{S}` the people
`resolveScope()` puts in the asker's book, the customers `scopedToUsers` would
list, and a table only where a CRM screen that shows it is held.
`crmAsk.enabled` / `crmAsk.model` switch and choose it; its limits and caches
are the `salesAsk.*` ones. The ERP keeps its own engine — tools that call each
screen's loader, `lib/erp/ai-ask.ts` — behind `/api/erp/ask`, which speaks the
same stream and adds the records it read as links. The next app is an
endpoint that streams those events and an `AskSetup` in `ask-setups.ts`.

**THE DOORS ROUND THE CONSOLE ARE SHUT (Nov 2026).** Three places granted apps
without a platform administrator, and each now defers to one:
- **Locker's own access screen** (`setLockerModules`) changes the screens of
  somebody who already holds the Locker, and takes it away; GIVING the app to
  somebody new needs `isPlatformAdmin`. Every change is also written to
  `audit_log` as `locker.access.changed`, so the person's Audit tab sees it.
- **Hire's provisioning** refuses a blueprint that grants `NEVER_PROVISIONED`
  (`lib/apps.ts`: admin, founder, hire) on the server, as a blocker — the
  blueprint editor hiding them was the only guard before.
- **`hire:deploy`** gives each platform admin Hire ONCE: the `installed` line
  on `hire_audit` is its memory, so Hire taken away on the console stays away
  through later deploys.
And **a template never carries platform Admin** (`grantsPlatformAdmin`, refused
on save and on apply): it is given one person at a time on their Manage page.
Bulk take-away on Powers has a review step naming the people, and designation
Sync names who it brings up before it runs.
