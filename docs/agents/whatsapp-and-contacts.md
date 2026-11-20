# WhatsApp sending, Wati, customer contacts

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A WhatsApp message is only sent when a human confirms it.** Until then it
sits as `copied`, and only a *confirmed* send sets
`lastConfirmedWhatsappDate` or suppresses the customer from the queue. A
copied-but-unconfirmed message is a customer who may or may not have been
contacted, and it is shown as exactly that rather than assumed either way.
There is a test for each half of this; do not collapse them.

**A customer reached two ways is two pieces of work.** `both` is a standing
instruction on a *customer*, never on a message: a message goes to exactly one
place, so a both-ways customer produces two rows and `prepareLegs` splits them,
personal leg first. The group can be pasted and confirmed while the personal
message is still sitting copied, and neither leg may borrow the other's
confirmation. One confirmed leg *does* set `lastConfirmedWhatsappDate` —
waiting for the second would chase somebody who has already heard from us.
`dest_kind` is shared with `wa_messages`, so read that column as
personal-or-group only; nothing writes `both` to it.

**WHATSAPP GOES THROUGH WATI ONLY WHILE THE FOUNDER HAS IT SWITCHED ON.** The
switch is `whatsapp_service_events` — one row per decision, the newest wins, no
row means OFF — on HQ's WhatsApp screen and nowhere else. It
is deliberately not an `app_settings` key: settings are edited by anybody with
`config.write`, and this is the one messaging decision Mahek gave to the
founder alone. `whatsapp.activate` sits in HQ's row of the matrix,
and because an administrator holds every capability by construction,
`requireFounderDesk` also demands that the hat which granted it is
HQ's. The old `whatsapp.mode` setting is retired and read by nothing.

**It replaced a stub that marked messages sent without sending them.**
`sendAutomatic` used to set `sent` and stamp `lastConfirmedWhatsappDate` with a
comment saying the provider call would go there, so flipping the setting to
automatic would have taken customers off the Call Log on the strength of
messages that never left. It now calls Wati or refuses, and refuses — sending
nothing — unless every one of these holds: switch on, key present
(`wati.apiToken` / `WATI_API_TOKEN`), personal leg, unedited, template linked to
an APPROVED Wati template, customer not do-not-contact, a real Indian mobile not
shared by three or more shops, `whatsapp.contactsPerWeekLimit` not reached, and
every template variable filled. `lib/whatsapp-delivery.ts` is the rule, pure, so
the screen that draws "Send" and the service that sends cannot disagree.

**The manual route never goes away.** Groups cannot be reached through the API,
an edited message is no longer the approved wording, and an unlinked template
has nothing to send as — every one of those falls back to copy, paste and
confirm with the reason on the screen. The customer is stamped only when Wati
accepts the message, and a failure reported later by webhook takes the stamp
back (`recomputeLastWhatsapp`).

**Our `wa_messages.id` travels to Wati as `local_message_id`**, and every
delivery webhook is matched on it. `/api/whatsapp/wati/[token]` receives them;
the token is an HMAC of the API key, because Wati's webhook settings take a URL
and nothing else — rotating the key rotates the address. Receiving does not
depend on the switch: a read tick or a customer's reply is a fact about the
world. Status only moves forward (a late "delivered" never demotes "read"), and
a reply from a number the book does not know is stored with a null customer
rather than dropped, and listed on the founder's screen.

**A PHOTOGRAPH A CUSTOMER SENDS IS SHOWN WHERE THEY SENT IT.** A payment slip
or a PDF statement arrived on the webhook with Wati's path to the file in
`data`, and the path was dropped — the chat showed "[image]", and the thing the
message was about could only be seen in Wati. `wa_replies.media_type` and
`media_path` keep it now. The bytes stay with Wati: `/api/whatsapp/media/<id>`
fetches them through `fetchWatiMedia`, behind `getReplyMedia`, which asks the
same `resolveThread` gate as the conversation — so a file is exactly as
visible as the chat it arrived in. Only a photograph, a PDF, audio and video
are served inline; anything else a customer sends is handed over as a
download, because "a document" can be an HTML page and must never run on this
origin. The path is kept only in Wati's own shape (`data/<kind>/<file>`) and
checked again before it is fetched. Reading a file and a contact's history are
v1-only, which names the tenant — `WATI_TENANT_ID`, defaulting to Mahek's.
Files that arrived before the path was kept are found again in Wati's history
by `backfillReplyMedia`, matched on number, kind and time (the history carries
Wati's ids, not WhatsApp's); the hourly pass repeats it over two days.

**A CUSTOMER IS SEVERAL PEOPLE, AND EACH KIND OF MESSAGE HAS ITS NUMBER.**
The owner decides, somebody else orders, the accountant answers for the money
and the godown man for the delivery — and the record held one `phone`, one
`alt_phone` and one `whatsapp_phone`, so a payment reminder went to whichever
number was typed first. `customer_contacts` is one row per person: a name, what
they look after (a code from `CONTACT_ROLES` in `lib/customer-contacts.ts`,
never a label), the number, an email and a note. Three DESIGNATIONS, each held
by one contact at most, enforced by partial unique indexes: **primary** (who we
ring), **WhatsApp** (where every message goes by default) and **payment
reminders** (where a reminder about money goes). Primary can only be MOVED,
never cleared; WhatsApp and payment reminders need a mobile; the last number
cannot be removed.

**The table is the truth and the columns are its MIRRORS.** Forty readers use
`customers.phone`, `contact_person`, `whatsapp_phone` and `alt_phone`, plus
the new `payment_whatsapp_phone`, and none of them had to change:
`syncContactMirrors` writes them from the list inside every contact write's own
transaction, and `mirrorsFrom` is the one statement of what they should be. A
writer that still sets the columns directly — the party sheet filling a blank,
the handset's customer edit, an old `updateCustomer` caller sending `phone` —
is folded back in by `reconcileContacts`, which ADDS the number it finds and
takes the column as that number's designation, because the column is the newer
statement. A column somebody emptied takes the designation away. Reconciling an
agreeing pair writes nothing, and the screens reconcile on read.

**`whatsappNumberFor` decides where a personal message goes, on every path.**
A payment template — category `payment_reminder`, or a Wati spec of kind
`payment` (`purposeOf`) — goes to the payment-reminder number, then the WhatsApp
number, then the phone; everything else skips the first. Unset is the honest
default and the panel says so in words ("the WhatsApp number, by default")
rather than a migration marking a choice nobody made: `0220` carried the book in
with the phone as primary and a separate WhatsApp number as its own contact, and
flagged nothing else. A reply from ANY number on the list is filed against the
customer (`customerIdForNumber`). The sheet stops filling `whatsapp_phone` once a
PERSON has written that customer's contacts, because "no separate WhatsApp
number" is then a decision, not a blank.

**A CONTACT CARRIES A BIRTHDAY, AS A DAY AND A MONTH.** Never a year — nobody
at a counter is asked their age, and a year typed to satisfy a date picker is
a fact nobody stated. `customer_contacts.birth_day` and `birth_month` are both
or neither, held by a check constraint that names `is not null` because a CHECK
passes on null. The rules are pure, in `lib/customer-contacts.ts`: a 29
February birthday falls on the 28th in other years, and `upcomingBirthdays` is
the one statement of "soon" — `customers.birthdayHeadsUpDays` (7) — read by the
contact cards, the record header, the call drawer, the customer list (CRM and
Accounts) and its export, so no two of them disagree about whose birthday is
near. The date is the server's business date, passed down, because a client
component may not read the clock in render.

**The full edit form is tabs, and it edits everything that is not derived.**
Details, Contacts, Address & area, Commercial, Account managers — the same form
in the CRM and Accounts, since both render `CustomersScreen`. The row carries a
dozen columns, so the form asks `loadCustomerEditor` for its one customer when it
opens, and sends only the fields that MOVED (`detailChanges`). The contacts tab
saves each change as it is made, apart from the form's Save. Absent on purpose:
the seats (Reassign, audited), the status (deactivation has its own flow) and
every cache — outstanding, the cycle, last order, health — which a typed value
would lose on the next recompute. **The credit limit and stopping supply are the
ledger desk's** (`payment.confirm`), checked in `updateCustomer` only where the
value actually moves, and a stop needs a reason the salesman reads at the
counter.

**A payment reminder that went is a follow-up attempt.** The collections plan
dates the next stage-1 nudge from the newest WhatsApp row in
`follow_up_attempts`, and no path that sent a reminder — manual or otherwise —
ever wrote one, so stage-1 customers came back due every day.
`recordReminderAttempt` writes it once a reminder is actually sent, keyed on
the message.

**EIGHT TEMPLATES, EACH A RULE SET, AND EVERY OLDER ONE ARCHIVED.**
`lib/wati-templates.ts` holds one spec per approved Wati template (a `_vN`
suffix is the same message): the Wati variable names it fills, and the checks
that make its sentences TRUE. `wa_templates.wati_spec` ties a CRM template to
one, and a spec'd template is rendered by those rules on every route — the
preview, the manual copy and the API send — so no route can send what another
would refuse. `0165` inserted the eight and archived every free-text template
(archived, not deleted: `wa_messages` keeps a key to the template it came from).

**A variable is a true value or the message is refused.** Never defaulted,
blanked, "N/A", or rounded into a different figure. The bill list and its total
are built from the SAME rows (stated, unpaid, not disputed; overdue by
`effectiveDueDate`), one line, oldest first, five listed and "+ N more" with
the total over all of them; amounts share one precision per message so they
add up on the customer's screen. A cycle is quoted only when MEASURED
(`cycle_is_default` false). "Is due around" is refused after the expected date
and "was expected" before it. A reported or held payment refuses every payment
template, a pending order or an open Taken Order line refuses every order one,
and leads and third-party shops never get order templates.

**Facts are read at the moment of sending**, not when the message was
prepared — a payment confirmed between the two changes the bill list.

**A pasted copy has no buttons.** The approved wording says "tap an option
below"; `manualText` turns each such sentence into an ask to reply, and refuses
a body that still mentions tapping, so a new phrasing in Wati fails loudly
rather than pointing a customer at buttons that are not there.

**Which template goes on which day is NOT here.** That is Mahek's timeline and
belongs to the scheduler; these rules answer only "is this message true".
