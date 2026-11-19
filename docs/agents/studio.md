# The Studio

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE STUDIO WAS A SEPARATE APP, AND IS ONE OF THESE NOW.** It began as
`mahek-promotional-studio`: its own repository, its own sign-in, SQLite files,
and a read-only HTTP feed out of this repo to learn who the leads and
customers were. Deploying it meant a second Node process on a droplet with one
CPU and a gigabyte already half a gigabyte into swap, plus a second copy of
MahekOne to serve the feed, plus a tunnel. Inside MahekOne all three go away:
the book is read through `scopedToUsers` like every other list, the grant is
`app_access`, and the only new process is none. `lib/studio/domain`,
`lib/studio/renderer` and `lib/studio/templates` are that repository's code,
carried over with their tests; what was rewritten is where things are stored
and who may see them.

**A POSTER IS STORED AS ITS RECIPE, never as its pixels.** `studio_posters`
holds the design id AND VERSION, the language, the wording, the poster-only
edits, the sender's name and a snapshot of the recipient as they stood. A
design version is immutable once published — a refresh is a new version and
the old one is kept as an archived folder — so the row redraws the same
picture next year, a CRM edit cannot repaint an old poster, and the database
does not grow by a megabyte every time somebody wishes a shop a happy Diwali.
The image routes draw on request and keep a small in-process cache.

**THE RENDERER DRAWS ONE POSTER AT A TIME.** `render-service.ts` sets sharp to
one thread and a small cache and runs every render through a limiter of one,
because the box is shared with the CRM, the ERP and Postgres. A bulk run
therefore stores recipes and draws nothing; the ZIP and the poster pages draw
when somebody asks, queued. Fifty posters in a ZIP take a minute; fifty
renders in parallel would push the CRM into swap.

**WHO A POSTER CAN BE MADE FOR is scope, and three lists.** Leads, customers
and LOST leads — a lost lead is greeted with the lead designs, because it has
never bought anything, and is listed apart because winning somebody back is a
different conversation from welcoming them. Do Not Contact still lets a
poster be made and downloaded and says in red not to send it; the WhatsApp
button is withheld for it and for `whatsapp_dnd`. Nothing is ever sent by
MahekOne: WhatsApp opens a chat with the message written, the phone's share
sheet takes the picture, and every way out is recorded in
`studio_poster_shares`.

**APPROVING A DESIGN IS A MODULE, OFF BY DEFAULT.** Anybody holding Designs
may upload artwork and place fields on it; the draft is theirs alone.
Publishing it to everybody is `studio.approve`, which the Access screen
starts unticked and `npm run app:grant` leaves out too — both write the
default modules as rows. Somebody has to tick it; a Studio administrator
holds it regardless, as every `offByDefault` module is held. Approval draws the design twice (sample
text, where anything not fitting is an ERROR; deliberately long names, where
shortening is a WARNING), stores the preview, and writes the manifest once.
An approved upload is never edited; a change is a new upload.

**An uploaded design lives in file storage and the database, and is read from
a folder.** The renderer and loader read files, so `registry-service.ts`
writes each approved upload out as the same folder format the shipped
designs use, under the OS temp directory, and rebuilds the registry when the
set of approved ids and versions changes. The folder is a cache; a wiped
`/tmp` or a second process rebuilds it from the row.

**SHARP IS IN THE IMAGE AGAIN, AND `studio/` IS COPIED BESIDE `server.js`.**
The Dockerfile used to delete sharp as weight for a switched-off image
optimiser; the renderer is sharp, so it stays, with fontconfig for Pango. The
designs and fonts are read by path, which no file trace sees, so they are
copied by hand — and the image build draws one line of Latin, Devanagari and
Gujarati and FAILS if any of them comes back empty, because the first person
to find out otherwise would be making a Hindi poster.

**The festival calendar is data, and it says what it does not know.**
`studio/templates/festival-calendar.json` lists dates per year with their
source; an entry with no source is drawn "Unverified date", and nothing is
extrapolated past its coverage. Birthdays and anniversaries are one shared
list, edited by version so two people cannot silently overwrite each other.
There is no birthday design yet, so those remind and do not make a poster.

**THE TEMPLATE LIBRARY PUBLISHES AT ONCE, AND NOTHING IS PUBLISHED THAT THE
REGISTRY WOULD REJECT.** `/studio/designs` is the shared library: every
published design, shipped or uploaded, searchable by name, occasion, language
and uploader. Whoever holds `studio.designs` uploads a JPG, JPEG, PNG or WebP
(no PDF; PSD is exported to JPG or PNG first) and publishes their own draft
(`publishDesign`) when `studio.publishImmediately` is on (the default);
off, only a holder of `studio.approve` publishes (`approveDesign`). Both
go through ONE function, `publishRow`, which runs the placement checks, draws
EVERY declared language with sample text and with long names, and then writes
the candidate as the folder it would be and runs the registry's own loader on
it (`validateCandidate`). A design the loader would exclude — a missing
language, wording that fails the copy or customer rules, a wrong-size
background — is refused with the reason and stays a draft. English is
mandatory; Hindi and Gujarati are optional per design, each with wording typed
for it (nothing is translated), drawn in its own script's font.

**ARCHIVE, RESTORE, VERSIONS, ORIGINALS.** The uploader archives their own
design; whoever holds `studio.approve` archives or restores anybody's. WHO
archived it is on the row (`archived_by_id`): an uploader restores only what
they archived themselves, so an approver's archive stays theirs to undo. An
archived design, and every earlier version of a design, is read by the
registry as an ARCHIVED COPY of its version (`<id>-v<version>`, `versionOf`),
never listed and never offered for a new poster, so every poster already made
keeps drawing. A NEW VERSION (`reviseDesign`, or new artwork of the same
shape through the upload route's `revisesId`) is a private draft that, on
publish, moves the design to its next version IN ONE TRANSACTION: the version
being replaced is saved whole in `studio_design_versions` first. A published
version is never edited. The ORIGINAL upload is kept in file storage beside the
normalised background (`source_ref`, `source_format`); `/tmp` holds only a
rebuildable cache, and a registry built after a folder could not be written is
never remembered, so the next request tries again.

## The WhatsApp Inbox

**THE INBOX SHOWS WHAT KAPSO SAID ABOUT THE COMPANY NUMBER, AND NOTHING ELSE.**
`/studio/inbox` (module `studio.inbox`, everybody holding it sees every
conversation) is a shared inbox for the company WhatsApp number, read and
answered inside the Studio — text replies, and a poster or an uploaded picture
sent with its caption. It replaces opening a chat in WhatsApp Web for normal
chat work, but the existing "Open WhatsApp" buttons are untouched until it has
been verified on real conversations. `kapso.ts` is the one place Kapso is
called; the project key (`kapso.apiKey`) and the webhook secret
(`kapso.webhookSecret`) are Admin Console credentials read on the server for
the request that spends them, and never reach a page. The company number is the
setting `studio.whatsapp.number`.

**IS IT CONNECTED IS ANSWERED FROM KAPSO'S OWN LIST OF NUMBERS.** `connection()`
(`inbox-service.ts`) lists the project's numbers and finds the company number as
a LIVE one: a sandbox number is never shown as the company's WhatsApp, and a
missing key, a refused key, an unreachable Kapso and a number that is not there
each say so on the screen instead of drawing a chat. Nothing is seeded.

**ONE MESSAGE IS ONE ROW, AND A STATUS ONLY MOVES FORWARD.**
`studio_wa_messages` is unique on the WhatsApp message id; a webhook delivery
is remembered by Kapso's idempotency key (`studio_wa_events`), so a retry does
nothing; `/api/studio/whatsapp/webhook` verifies the HMAC-SHA256 signature of
the RAW body before reading anything, and a webhook for another number in the
project is ignored. A message the Studio is sending is reserved under the
browser's own key first, so a double press, a webhook that arrives before the
send call returns, and the refresh that reads the same message back all land on
one row. `mergeStatus` (`domain/inbox.ts`) never demotes read to delivered and
never un-delivers; a lost connection is marked failed AND says it is not known
whether the message went, and is never retried. "Refresh from Kapso" is the
catch-up under the webhook (Kapso retries for about fifty seconds), and brings
in messages written on the phone (`origin: business_app`).

**A REPLY IS REFUSED WHERE WHATSAPP OR THE CRM WOULD REFUSE IT.** A free-form
message or poster needs the customer's last message within 24 hours; a customer
marked do-not-contact or WhatsApp-DND is never messaged from here. The CRM name
is matched at read time on the last ten digits of any phone on the record, and
nothing about the match is stored; only the name and those two flags leave the
CRM.

**LOCAL PREVIEW — SAMPLE DATA IS FOR A DEVELOPER'S MACHINE AND FOR NOBODY ELSE.**
`STUDIO_INBOX_PREVIEW=1` draws invented, clearly labelled conversations and
generic sample pictures held in memory (`inbox-preview.ts`,
`inbox-preview-assets.ts`): nothing is stored, nothing is read from Kapso, and
Send only adds a line to the sample chat. It needs ALL of: not a production
build, the switch, and a database on localhost named `mahekone…`
(`previewAllowed`, `domain/inbox-preview-gate.ts`, pure and tested) — on the
droplet the database host is the container, so a stray variable there changes
nothing. `scripts/local-inbox-preview-posters.ts` makes a few real posters in a
local database for the picker's real-poster path and refuses any other.

**NOT BUILT YET, AND SAID SO ON THE SCREEN.** Starting a conversation (it
needs an approved template), a preview of a customer's inbound photo, and a
link from an API send into My posters' forwarding history. Webhook events for
messages written on the phone, and whether the Free plan includes webhooks,
are unconfirmed until real conversations flow.
