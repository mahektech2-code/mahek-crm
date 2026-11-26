# Sign-in, app grants and modules

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**One sign-in for all of MahekOne** — there is no per-app login. `/login` takes
a work number *or* an email, because telecallers know their phone and office
staff know their email.

**Every OTP goes to the employee's PERSONAL MOBILE in HRMS** — sign-in, password
change and password reset, on the web and on the MBOS handset alike — read
through `users.employee_id` and nothing looser. It used to go to the work
number on the account. An account with no HRMS link, or a linked employee with
no personal mobile, is offered no code and told why; the password still works.
The same number signs in: `findAccount` (the one lookup every sign-in uses)
takes an email, a work number, or the HRMS personal mobile — the work number
wins where one number is both, and a personal mobile on two linked accounts
signs in nobody.

Where you land depends on what you can open:

- **one app** → straight into it, no launcher (a single option is not a choice)
- **several** → `/apps`, the launcher
- **none** → `/apps`, which says so plainly instead of showing a blank screen

`app_access` is a row per user per app. It is checked in each app's layout, not
just used to hide launcher tiles — a bookmarked `/accounts` must not open for
somebody who was never given it.

**One app on that list opens no browser tab at all.** `field` is MBOS, the
handset a field salesman signs into over its own API — granting it is granting
mobile access and nothing else. It stayed a real `APPS` entry (so `app_access`
has an id to grant and the Admin Console has something to tick) with a genuine
web route behind it, `/field`, that only ever showed "not built yet" — because
every other app on this list follows "grant it, get a launcher tile, screens
arrive later," and `field` was given the same treatment on the assumption its
turn would come. It will not: there is no web screen coming, ever, so the tile
was not a preview of anything. `mobileOnly: true` on its `AppDefinition` and
`webApps()` — one function, read by the launcher, every switcher and the
straight-into-it redirect above — leave it out of all of them, so granting it
gives a phone a way in and gives the browser nothing to show for it.

**An app is not the smallest thing that can be granted.** `app_module_access`
narrows a grant to particular screens, and a module is a destination in an
app's navigation — that is the whole rule: if it has a place in the sidebar or
the header it can be withheld, and if it does not, it is part of the screen its
link belongs to. The registry is `lib/modules.ts`, pure and client-safe, so the
review table on the access screen renders the same list `requireModule` enforces
on the route. Withholding is enforced twice: the sidebar draws only what
somebody holds, and each module folder has a layout that redirects a bookmark
past it to the first module they do hold.

**No module rows for an app means every module of it.** That is why adding this
moved nothing: every grant that already existed carried on meaning exactly what
it meant, on every screen, for everybody, and a grant narrows only once somebody
unticks something. It is also what keeps `npm run app:grant` honest — it does
not know modules exist, and an app granted
from a terminal has to open whole rather than open empty. A grant with every
module ticked stores no rows at all, so a fifteenth CRM screen reaches everybody
holding the whole app and nobody who was deliberately narrowed.

**A module can have a WRITE LEVEL, and WhatsApp is the first that does.**
`crm.whatsapp` and `accounts.whatsapp` open the screen — the Read level: the
chats and the message log. `crm.whatsapp-reply` and `accounts.whatsapp-reply`
beside them are the Write level: replying, marking handled, sending, runs,
templates and groups. A write level is an ordinary module row marked `writeOf`
in `lib/modules.ts`, so it is stored, diffed and audited by the machinery that
already existed, and "no rows means every module" makes a whole-app grant
Write — nothing anybody held moved, and `0214` gave every NARROWED grant that
held the screen its write row for the same reason. It is not a destination:
`moduleForPath` never answers with one, and the Access screen draws it as a
Read / Write select on its screen's row rather than as a box of its own.

**Read is refused in the ACTIONS.** `whatsappLevel` is the union over both
apps, like every capability. Thread actions demand Write; the reminder and
template actions refuse only somebody NARROWED to Read, because the payment
panel and the command centre send reminders for people who were never given
the chats and always could. The screen draws what the grant in THIS app says.

**Accounts opens the same WhatsApp screen**, `app/crm/whatsapp/whatsapp-page.tsx`
rendered at `/accounts/whatsapp`, read through the Accounts scope — every
customer. "Open record" goes to the ledger there, since Accounts has no record
page.

**A narrowed grant does not receive new screens, so the screen SAYS when one
shipped.** That is right for a screen somebody left out and wrong for one that
did not exist when they decided — on prod in November 2026 three telecallers
had gone a month without Opportunities with nothing anywhere saying so.
`lib/module-since-data.ts` carries the day every module and ERP power shipped
(a test fails on a key without one), and the Access screen and the Designations
page name what arrived after a grant or a designation was last saved. Saving it
again — ticked, or deliberately left out — is the decision: `setAccess` takes
`reviewedNew` and rewrites the unchanged rows so their date moves past it.

**Revoking an app takes its module rows with it.** Left behind, they would
silently narrow the app the day somebody granted it back — four screens of
fourteen, with nothing on any screen saying why.

**THE HANDSET'S OTP REQUEST ANSWERS THE SAME FOR A NUMBER IT DOES NOT KNOW.**
`POST /api/mbos/auth/otp` used to answer 404 naming the number for no account,
no field grant or an inactive one — the very enumeration the grant check was
written to close. It now answers `{ ok: true, sentTo, expiresInMinutes }` with
the typed number masked and sends nothing; the code he then types is refused at
login like any wrong code.
