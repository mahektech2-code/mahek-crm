# The Locker

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE LOCKER HOLDS OBLIGATIONS AND ACCESS, and it holds the keys to MahekOne itself.**
Every licence, policy, contract, subscription and company record with an end
date and a named owner, and the vault of company passwords and keys. Built to
the "Mahek Locker" page of the MahekOne design and to the Locker PRD and
functional spec. Rules in `lib/locker/engine.ts` (pure); the register read in
`lib/locker/service.ts`; writes in `lib/actions/locker-assets.ts` and
`lib/actions/locker-vault.ts` / `locker-admin.ts`.

**STATUS IS DERIVED, AND `stage` HOLDS ONLY WHAT A PERSON SAYS.** Expiring,
renewal due, in grace and expired are read off the end date and the type's
lead and grace every time; `locker_assets.stage` carries only the states a
person sets — a renewal under way, applied, awaiting the document, replaced,
cancelled, lost, suspended, disputed. So no row can claim a licence is live
after its end date. `renewal_filed` and `in_grace` are deliberately NOT red: a
factory licence whose renewal was filed on time is defensible and one that
simply lapsed is not, and a screen that draws both red teaches people to
ignore red.

**FOR A CONTRACT, THE DAY THAT MATTERS IS THE NOTICE DEADLINE.** `actionDays`
is the end date minus the notice period for a `term_contract`; every count,
sort, ladder rung and reminder runs off it. Miss the notice day and the
contract renews whether anybody wanted it to or not.

**A CATEGORY IS A SCOPE AS WELL AS A SCREEN.** Each sidebar entry is a module
(`locker.*` in `lib/modules.ts`), which is the design's "tabs a person holds".
Somebody holding only Vehicles sees vehicle assets on the dashboard, in search
and on the calendar, and nothing else; All assets with no category ticked
means every category. `lockerAccess().catOk` is that rule, and every read and
write asks it. The vault and admin modules are `offByDefault`: a whole-Locker
grant must not hand out the company's passwords.

**THE VAULT IS ENVELOPE ENCRYPTION, NOT A HASH.** A hash cannot give a
password back, and a vault exists to give it back. Every stored value gets its
own 256-bit data key (AES-256-GCM); the data key is wrapped by the
key-encryption key named by `kek_version`, so rotating the KEK re-wraps keys
without touching a ciphertext (`rewrap`). There is no KMS on the droplet, so
the KEK comes from the ENVIRONMENT — `LOCKER_KEK` (+ `LOCKER_KEK_VERSION`)
where set, else the app signing secret — and never from the database: a dump
yields nothing. A hardware KMS and the spec's 3-of-5 escrow are open items,
said on the Security screen rather than pretended. No key, no vault: the
screens say so and nothing is stored. Rotating the app signing secret without
setting `LOCKER_KEK` first makes every stored secret unreadable.

**A REVEAL IS ONE VALUE, AUDITED BEFORE IT LEAVES.** The audit row is written in
the same transaction as the reveal and before the plaintext is returned; if it
cannot be written nothing is revealed (spec E7). The tier decides the rest
(`lib/locker/settings.ts`, from the spec's §2 table): step-up with your own
MahekOne password, a reason, how long the value stays on screen, whether copy
is offered and when the clipboard is wiped, the watermark, who is told.
**Two rules are not settings and no admin can turn them off:** a restricted
value needs a second person to approve (and the requester must be named on
the login or own it), and emergency access can never be invoked and approved
by the same person. Re-revealing is the whole flow again; there is no "keep
visible".

**A CHANGE RETIRES, IT NEVER OVERWRITES.** A new value inserts a row and sets
`retired_at` on the old one, so a rotation that breaks something can be
undone by revealing the previous value (with a reason). Reuse is found by a
keyed HMAC fingerprint, never by comparing plaintext.

**THE LOCKER'S AUDIT IS ITS OWN TABLE, append-only and hash-chained.**
`locker_audit` refuses UPDATE and DELETE with a trigger, and every row's hash
covers the previous row's, so `verifyAuditChain` (the Audit screen's "Check
for changes") says where history was altered or removed. Writes take a
transaction advisory lock so two writers cannot fork the chain. Never a secret
value — that a field changed, not what to.

**A DOCUMENT IS HASHED ON UPLOAD AND CHECKED ON EVERY OPEN.** A mismatch is
refused and recorded as `locker.asset.tamper_detected`, a security event.

**A RENEWAL ENDS IN A NEW VERSION, NOT AN EDIT.** Completing a renewal creates
a new asset (`replaces_id` → the old) and marks the old one `superseded`, so
an audit years later can show the licence was continuously valid.

**REMINDERS ARE ONE DIGEST PER PERSON PER DAY.** The nightly pass
(`lib/locker/reminders.ts`, also `npm run jobs -- locker-reminders`) fires the
criticality ladder against the action day, moves a Sunday rung to the
Saturday before, escalates owner → backup → approver → Approvals holders, and
never sends a rung twice (`locker_reminders_sent`). A card expiring inside
`cardWarnDays` alerts on every auto-renewing subscription it pays — the charge
fails, the service lapses, and nobody connected the two.

**OWNER IS REQUIRED AT CREATION, AND "UNOWNED" STILL EXISTS.** The form and
the action refuse an asset without a primary owner (and without a backup at
High and above). The column stays nullable because a leaver's assets are
unowned until somebody takes them, and the dashboard counts that as the
defect it is rather than hiding it.

**SERVER PAGES TAKE STYLE VALUES FROM `lib/locker/style.ts`.** `_ui/kit.tsx` is
a client module; a value exported from it — `C`, `btnStyle()`, `when()` — is
only a reference on the server, so `C.ink` is undefined and `btnStyle()`
throws. Components cross the boundary fine; values do not.

**RETIRING A LOGIN OR A SIGN-IN ACCOUNT KEEPS EVERYTHING.** `active = false` is
the whole of it, and every list, count, reuse check and the reveal path already
read `active`. Retire goes through the impact report (`locker-credential-retire`,
`locker-identity-retire`), drawn inside the Locker's own `useModal()` by
`_ui/impact-modal.ts` (the report's groups as notes, then the name to type); the
act re-checks the fingerprint. A login's waiting or approved reveal requests
expire; open emergency access over it blocks it. An account that is a login's
`sole` way in is refused until that login has another. Values, previous values
and connections stay; Restore (the login's page; Retired sign-in accounts on
the accounts screen) puts it back. Both write `locker.*.retired/restored` on the
hash chain as security events.
