# Account seats, reassignment, handover

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**SUPERSEDED (2026-11-18): A SALESPERSON IS AN ACCOUNT.** The owner's rule:
every employee has exactly one account (`ensureEmployeeAccounts`, #1141) and
every decision keys on the user id — a name is a label. The sheets are retired
(#1140), so nothing restates `sales_person_name` any more; the seat
(`sales_am_id`) decides, screens show the seat's ACCOUNT name first and the
typed text only where no account holds the seat (region labels like "South
Zone"), and an employee picked for a seat is held by their own account (#1144).
The paragraphs below describe the sheet era and are kept for the reasoning.

**A salesperson is a name, not an account.** The Sales Party tab's `Sales
Person` is who sells to a customer, and most of those people have never signed
in — several are not people at all ("Western Line Sale", "Company Own",
"JAIPUR"). `salesAmId` can only hold a `users` row, so the projection linked
the handful that matched and dropped the rest, and every screen fell through
to the owner: all 557 customers showed a telecaller as their salesperson.
`customers.salesPersonName` holds the name itself, the screens read it first
and the linked account only where the sheet is silent, and
`recomputeSalesPeople()` rebuilds it from what is already stored — the command
to run when the reading changed rather than the row.

**A CUSTOMER'S DETAILS ARE EDITED IN ACCOUNTS AND READ EVERYWHERE ELSE.** The
same party is drawn in the CRM, Accounts, the ERP's Masters and HRMS's Sales
desk, and each grew its own Edit — four teams changing one phone number, GSTIN
or credit term, last save winning. `lib/customer-edit-gate.ts` is the rule: the
request must be IN the Accounts app (`x-mahek-app`) and the person must HOLD it,
so somebody with both Accounts and the CRM edits from Accounts and their CRM
screen is view-only like everybody else's. `updateCustomer` and the four contact
writes ask it; the ERP's and HRMS's edit forms refuse outright and draw no
button. Creating a customer or lead, reassigning, the workflows that write a
column as a side effect, and the MBOS handset's field corrections are outside
it on purpose.

**Changing an account manager is accounts' and admin's, and not a manager's.**
Whose book an account is in decides who is credited for its orders and whose
targets it counts toward, so a manager reassigning accounts is a manager moving
numbers between their own people, including themselves — the same conflict
`order.approve` exists to avoid, one level up. `customer.reassign` sits in
`ACCOUNTS_ONLY` and is checked in the action, not by hiding the button.

**An account has a THIRD seat above the sales one, and it drives nothing.**
The sales manager is who the salesperson answers to — the person a regional
review starts from, and the person whose departure moves a hundred accounts at
once. `ASSIGNED_TO_SQL` does not read it, no queue is dated from it, no target
counts against it, no collections list narrows by it and no scope resolves
through it. That is the whole reason it can be a MANAGER's while the two
beside it stay accounts' and admin's: `customer.reassign` is the narrowest
capability in the app because moving the sales seat moves numbers between a
manager's own people, and moving this one moves none. It is its own capability
(`customer.assignSalesManager`), its own action and its own dialog — folding it
into `updateAccountManagers` would have put one function behind one capability
doing two jobs with two answers about who may do them, and the generous answer
always wins in the end.

**The Accounts MANAGER holds it too, by name.** The desk already holds
`customer.reassign`, the stronger of the two; without this one the field was
locked on Add customer, the lead bypass and the edit form, and a lead that
arrived with the seat filled could not be converted. In the bypass, somebody
without it keeps the lead's seat exactly as it is.

**And it takes no `amDecidedAt`.** That mark exists to hold the sheet off the
two seats it keeps restating; the customer master carries no sales manager at
all, so there is nothing to hold off, and stamping it here would silently
freeze the OTHER two seats against a sync as a side effect of naming a line
manager. `sales_manager_person_name` is the seat itself where the person
holding it has no login, like `back_office_name` and unlike `sales_person_name`
— nothing rebuilds it, because nothing outside MahekOne states it.

**A whole book moves by FILTER, not by ticking twenty-five rows at a time.**
The question this seat exists to answer is asked hardest on the day somebody
leaves, and the answer is "everything Rahul had" — a hundred and forty-seven
accounts spread over six pages. So the transfer sends the filters and the
server runs `customerFilterClause`, the SAME clause the list ran to draw the
screen the person is looking at. Re-deriving "which customers" on the way in
would be a second reading of it, and a bulk action that moves a set nobody
reviewed is the worst thing on the screen. The count that was on the screen is
sent with it and refused if it no longer matches: between reviewing a number
and spending it, an import can land, and a transfer that would touch a
different set has to stop rather than quietly grow.

**And the review changes shape with the scope.** A tick-list is read line by
line and the from-column is what catches a selection that caught too much. A
hundred and forty-seven checkboxes is a review in name only — it looks like
diligence and is scrolled past — so a filtered transfer is reviewed as the
count, the destination, and the filters said back in words. No filters at all
is the whole book, and the screen says exactly that in red: it is a legitimate
thing to do and a terrifying thing to do by accident.

**The three seats are drawn at ONE font size.** The second line of that column
was `text-xs` under a `text-sm` first line, which made the back office manager
read as a footnote to the salesperson rather than as the other half of the same
answer. They are peers — one sells to the account, one raises its paperwork,
one says who the first answers to — and a hierarchy of type sizes down a column
claims a hierarchy of importance that does not exist. What separates the lines
is colour on the LABEL: muted label, plain name, so the eye picks out the three
names without reading a word of the labels.

**An account has TWO managers and they move independently.** Sales is whose
book it is; back office is dispatch, billing and paperwork. Either or both can
be changed in one action, and each writes its own history row, because a
salesperson resigning says nothing about who raises the invoices. In the
dialog, a manager left untouched is OMITTED from the request rather than sent
as its current value — sending it would stamp a decision mark on an account
nobody decided anything about.

**AND THE BACK OFFICE SEAT IS "LOGISTICS", which is why no such role exists.**
The MBOS brief assigns six items to a Logistics actor and MahekOne's role list
is telecaller, manager, accounts, admin — so those items sat unbuilt, blocked
on a seat that appeared to be missing. It was not missing: dispatch is the
first word in the sentence above, and the people who put things on lorries and
chase them are the back office team. Reading the brief's job title as a role to
be created is what kept it blocked. A fifth `users.role` would have been a new
way to see the whole company's book — scope reads the derived widest role — to
model something that has existed since the second manager column shipped.

**Where nobody holds it, the task still lands, and it SAYS why.** An account
with no back office person still has to produce a chase: a sample that never
arrives is the quietest way a lead dies, because the salesman assumes it is
being tried and the shop assumes we forgot. So it falls through to the Lead
Manager and the description says it came there because no back office person is
named. That distinction is the whole of it — quietly moving a job the brief
puts elsewhere looks like completion, and naming why it moved does not. It also
turns the gap into something somebody can fix, which a silent fallback never
does. `back_office_am_id` and never `back_office_name`: a task needs somebody
who can sign in and close it, and the name column is for a person who may have
no login at all.

**A chase is CLOSED by the answer, not deleted by it.** Confirmed receipt marks
the task done and keeps its `sourceId`, because "we asked where this parcel was
and then it arrived" is the only way anybody finds out a courier is the
problem. Deleting it leaves a lead that converted late and nothing saying why.
It is closed before the review task is raised, so the two never sit on one list
saying opposite things about one sample.

**A reassignment is a decision, so the sheet keeps its hands off it.**
`customers.amDecidedAt` is the third mark of its kind, after
`orders.approvedAt` and `bills.paymentDecidedAt`, and it guards TWO things
rather than one. `--reassign` no longer overwrites the ids on a decided
account — but the half that would have been missed is
`recomputeSalesPeople()`, which rewrites `salesPersonName` from the sheet
wherever it runs. (Nothing schedules it any more: its one caller is
`recomputeEverything`, which only the seed calls. The guard stays for when
something does.) Holding the id while letting the NAME revert is the worst outcome
available: the account moves for scope, the queue and collections, and every
screen goes on showing the old person, because the lists read the sheet's name
first. Nobody reports that as a bug — they report that reassignment does not
work. So the mirrors move with the ids, and a decided account is skipped by
both paths.

**A reassignment must survive the next sync, and there were three ways it did
not.** `recomputeSalesPeople` honoured `amDecidedAt` and the party PROJECTION
did not — so a reassignment wrote its history, notified both people, and was
undone half an hour later by the scheduled pass. In production somebody made
the same change four times in four minutes before giving up, and the account
they were trying to move sat in the wrong person's Call Log for a day. The
projection now skips all four manager columns on a decided account and records
the disagreement in `sync_conflicts`, which is what the order projection
already did for `orders.status`.

**AND THE SAME RULE NOW COVERS THE STATUS AND EVERYTHING ELSE, which is a
REVERSAL.** This paragraph used to end by saying that everything which is not a
manager — the phone number, the credit term, the area — still comes from the
sheet, because the sheet is simply right about those. It is right about an
account nobody has touched, which is almost all of them, and wrong the moment
somebody has: a telecaller who corrects a town after actually speaking to the
customer is better informed than a spreadsheet, and having it put back within
the half hour with nothing saying so is the reassignment bug wearing different
clothes. So the projection FILLS A BLANK and never corrects a person —
`city`, `region`, `price_tag`, `lead_source` and the credit term joined the
phone number and the GSTIN, which had always worked this way.

**A CREDIT TERM NEEDS TWO COLUMNS TO SAY "NOBODY HAS STATED THIS".**
`credit_term_days` is NOT NULL DEFAULT 30, so on that column a deliberate 30
and an untouched row are the same value and no blank test can tell them apart.
`credit_days` is the nullable mirror and is what the projection reads. That is
why `updateCustomer` writes BOTH: writing only the first left a term somebody
had agreed on the phone still reading as empty, so the guard looked right and
did nothing.

**AND THE STATUS IS A DECISION, so it gets a mark rather than a blank test.**
`status_decided_at` is the third of its kind after `orders.approved_at` and
`customers.am_decided_at`. The projection already declined to REACTIVATE what a
person had closed in the CRM, by reading `deactivation_reason` — and nothing
whatever guarded the other direction, because the `Deactive` branch writes
unconditionally. `deactivation_reason` could never have covered both: a
reactivation CLEARS it by design, so the decision destroys its own evidence.
In production an admin reactivated one shop twice, both marked "Mistake", and
the sync re-closed it sixteen minutes after the second. A closed account is
invisible to the Call Log — `queueInputs` filters the status BEFORE the scope
filter is reached, so no seat and no score can put it back on a list — and that
shop went on taking dispatched orders while nobody was allowed to ring it.
Null means NOT DECIDED, which is every row that predates the column, so adding
it moved no figure.

**`updateCustomer` is not a door to it either.** It wrote `owner_id` for
anybody who could edit a customer and `back_office_am_id` for any manager, both
without the `customer.reassign` capability that is deliberately accounts' and
admin's, without a reason, without history, without notifying anybody, and —
worst — without `amDecidedAt`, so the sheet restated the old answer on the next
pass. The screen had already stopped sending those fields; the action refuses
them now, because a server action is a URL and the unaudited door always wins
in the end.

**And an emptied seat means nobody, not the importer.** The fallback from
`sales_am_id` to `owner_id` is for a field NOBODY HAS SET — it stops a record
mid-migration being orphaned out of every list. It is not for one somebody has
deliberately emptied: `owner_id` is whoever ran the import, one person on more
than a thousand rows, so "this account's salesperson has left" handed the
account to them, on a customer they had never sold to, with the departed
salesperson's name still on the screen because that is a different column.
After `am_decided_at` the sales seat is read exactly as it stands.

**AN ACCOUNT HAS A FIFTH SEAT, and it is the answer to §Q.** The brief asks
for the account to become a customer on the second order and for the
relationship to pass to a customer manager in the same breath. That is a
sentence about what the account IS and a sentence about who RUNS it, joined by
an "and" that hides the fact they are independent. `kind` answers the first and
flips on the SECOND order — `lead-conversion-service.ts` has the whole argument,
and it is settled. `relationship_owner_id` answers the second, and nothing
derives one from the other.

**It moves SIGHT, and deliberately not a rupee.** It is read by `scopedToUsers`
and by `assertCustomerInScope`, because a seat that did not carry sight would
announce to somebody that an account is theirs and then refuse them the screen —
a failure this file already carries three paragraphs about, having shipped
twice. It is NOT read by `ASSIGNED_TO_SQL`, and that is the load-bearing half:
that expression decides who is credited for an account's orders and whose
target it counts toward, so reading this there would move revenue between
people as a side effect of naming a relationship manager. Moving money is
`customer.reassign`, accounts' and admin's for exactly that reason.
`customer.handOver` is a manager's, and it can be *because* it moves none —
the same test the sales manager seat passes, one seat along. There is an
integration test asserting a handover leaves `sales_am_id`, `owner_id`, `kind`
and `am_decided_at` untouched, because that is the thing nobody would notice.

**Whether a handover is OUTSTANDING is derived, never stored.** Converted, and
`handed_over_at` still null. A flag would be a cache with nothing rebuilding it,
and the only facts it could be rebuilt from are the two columns it would be
caching. It is the same shape as the third-party filter listing shops with no
distributor: a list that should be empty and is not, because a row nobody can
account for is worse than one that says why it is there.

**And the seat's LABEL comes from a map, not a chain.** `seat-labels.ts`, pure
and client-safe like `complaint-labels` beside it. The record page rendered the
three seats with a ternary whose last arm was "Back office", so adding a fourth
relabelled it rather than failing — a handover reading on a customer's history
as a back office change, silently, on the screen somebody opens to find out
what happened to an account. `handover.test.ts` reads `amRoleEnum.enumValues`
and asserts every one has a label, so a fifth seat fails at the schema rather
than on the page.

**A lead moves by `owner_id` and a customer by `sales_am_id`.** That is what
`ASSIGNED_TO_SQL` reads, so writing only `sales_am_id` leaves every lead
exactly where it was while the screen reports it moved.

**Why it moved is a column, not a sentence in a log.** `customer_am_changes`
stores a reason code from `people.amChangeReasons` beside the from and the to,
and the reason list is configuration because a manager should be able to add
one without a deploy. The question people actually ask is "what moved when
Suresh left, and why" — `audit_log` can only answer that by grep. Names are
stored ON the row as well as the ids, so a history stays readable after the
person leaves and their account goes.

**Both sides are told, and the new manager especially.** Work has moved onto
their queue without them asking; the first they would otherwise know is a list
that grew overnight. The person who lost the accounts is told for the same
reason in reverse — a book that shrinks silently reads as a bug in the queue.
One notification per person per action, never one per account, and a
reassignment that changes nothing notifies nobody.

**Accounts have their own customer list, and it is not decoration.** An
accounts user holds `apps: ["accounts"]` and `src/app/crm/layout.tsx` redirects
them out of the CRM, so offering this action only on the CRM's list would have
shipped a permission that nobody holding it could reach. `/accounts/customers`
runs `listCustomersPage()` — the SAME query the CRM list runs, because two
reads of "who are our customers" is how two screens disagree about one. The
presentation is its own: the CRM list offers reminders and WhatsApp and links
every row into `/crm/customers/[id]`, all of which are doors this app's users
are redirected away from.

**One person picker, not two.** A dropdown beats a search box while the list is
short and loses the moment it is not, but building both means two components
and two sets of bugs, and the day the eleventh salesperson is hired somebody
has to notice and swap them. It is always the same searchable list;
`people.pickerSearchThreshold` decides only whether the search field takes
focus.

**What it does NOT do is decide whose book a customer is in.** That stays
`salesAmId`, because scope has to resolve to somebody who can sign in and see
the work. The two answer different questions and a name with no account cannot
be given a queue.

**Whose book is one definition, and it is `ASSIGNED_TO_SQL`.** A lead answers
to its owner; a customer answers to its sales account manager, falling back to
the owner. Every scoped list reads it — the queue, collections, bills,
complaints, targets, the inactive watch, WhatsApp replies and global search.
Reading `owner_id` alone silently drops every customer whose sales AM has been
set, including off the collections list while they still owe money.

**WORK DONE BEFORE A SHOP MOVED IS STILL ACCEPTED, and the new holder is
told.** `scopedCustomer` asks whose book a shop is in NOW, and a handset sends
the day's work hours after it was done — so a shop reassigned at 2 pm, visited
at 11 am and synced at 6 pm put the visit, the order and the receipt for cash
already in his pocket into Not accepted for ever. The visit, order and payment
handlers now pass the work's own instant (`checkInAt`, `orderedAt`, the
receipt's `clientCreatedAt`) through `scopedForWork`, and a shop out of his
book is accepted where `formerHolding` finds a recorded move AWAY from him — a
`customer_am_changes` row with him as `from_user_id`, or an `mbos_deletions`
tombstone written to his handset for it — and the work predates that move by
no more than `mbos.sync.reassignedWorkGraceHours` (24; the grace covers a phone
that had not pulled the news and a handset clock running a little wrong). The
rule is pure, `workPredatesMove` in `engines/field-day-rules.ts`. A shop that
was NEVER his has no such record and is refused exactly as before — this is
the sync endpoint's security boundary, so nothing softer than those two
records (a name on a sheet, a timeline line) opens it. Accepted work is
written to `audit_log` as `mbos.work_after_reassignment` and the new holder
(the change's `to_user_id`, else the shop's seats) and his managers are told —
once, AFTER the handler accepts (`dispatchAndRecord`), so a visit refused for
another reason announces nothing and a resend rings no second bell.
