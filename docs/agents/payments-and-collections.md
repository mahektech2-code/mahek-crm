# Payments, receipts, allocation, collections

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**Money the customer says has arrived is not money the business has seen.** A
payment reported by a telecaller sits at `reported` until accounts find it in
the bank, and `bills.paidAmount` — and therefore outstanding, aging, the
slow-payer flag and the collections worklist — counts CONFIRMED receipts only.
Before this, a telecaller's word reduced outstanding on the spot, so a transfer
that never landed erased real debt from every screen with nobody's name against
the decision. `recomputeBillPaid` rebuilds the figure from confirmed lines
rather than incrementing it, which is what makes confirming, rejecting and
re-confirming all land on the same answer.

**What a reported payment DOES do is stop the chasing.** The customer is held
back from collections with the reason said plainly, never silently dropped, and
the quiet expires after `payments.reportedQuietDays` — an unexpiring one would
let a customer take themselves off the list by saying they had paid, and the
account would simply stop appearing. Reported money outranks a promise, because
it is the better news; do-not-contact still outranks it.

**Reversing is not rejecting, and the difference is what the statement says.**
Rejecting means accounts looked for the money and never found it: it never
counted, and the customer's statement reads "never arrived". Reversing means it
counted and then failed — a cheque that cleared and bounced, the same transfer
entered twice, a receipt applied to the wrong customer. Telling a customer who
genuinely paid that their money was never seen is wrong on the one document
they might dispute a balance against, so `reversed` is its own status.
`reverseReceipt` takes the same capability as confirming, because taking money
off an account is the same kind of decision as putting it on; it refuses a
`reported` receipt outright, since nothing has counted yet and rejection is the
honest answer. Nothing else had to be taught about it — every money path keys
on `confirmed`, so a receipt that stops being confirmed stops counting
everywhere at once. It is offered on the customer account statement, on the
line itself, because reversing a payment begins with finding it and that is the
screen somebody is already on.

**Rejecting is not deleting.** The receipt keeps its row and its reason, gives
the balance back to the bills it named, and returns the customer to the worklist
with their stage floor intact. It lands on the timeline because somebody has to
ring back and say something. A rejected receipt stays on the customer's
statement too — a transfer that never arrived is a fact about the account, and
dropping it leaves the next person wondering why the balance never moved.

**Holding is a pause, and it is a fourth status rather than a shade of
`reported`.** `reported` means nobody has looked at the claim yet, and the quiet
it buys the customer EXPIRES — otherwise anybody could take themselves off the
collections list for good by saying they had paid. `held` is a named person in
accounts saying "I am looking for this in the bank statement, leave them alone
until I have", and its quiet does NOT expire: chasing somebody while we are
part-way through establishing that they paid is worse than any call not made.
What replaces the expiry is visibility — the hold ages in plain sight on
accounts' own list, `payments.holdStaleDays` flags it there, and only a person
ends it. It touches no money, because every money path keys on `confirmed`, so
nothing else had to be taught about it.

**A hold silences BOTH channels, and the customer is told why through the
telecaller.** No calls and no reminder messages, which falls out of
`blockingReason` gating both. The reason is required by the action, not just by
the form: a telecaller whose customer has gone quiet has to be able to answer
when that customer rings and asks why nobody has been in touch. Rejecting a
hold puts them straight back on the worklist; confirming takes them off it for
the right reason.

**A held payment is not a neglected one, and no screen counts them together.**
"Waiting more than 24 hours" on a reported payment means the customer's quiet
is about to lapse and they will be chased for money nobody has looked for; on a
hold none of that sentence is true. They get separate banners, separate
ageing — `payments.holdStaleDays` — and the statement gives a hold its own pill
rather than "with accounts", because somebody has looked at this one. The
running balance counts confirmed money only, so a hold moves nothing.

**Re-pointing is offered even where NOTHING is open.** That is not a dead end,
it is the most stuck case: the bill the money was reported against has been
settled by something else, so confirming as it stands is refused and there is
no other bill to name. Re-allocating with no open bills puts the whole amount
on account, which is the honest answer — the money arrived and there is nothing
left for it to pay. Hiding the control exactly there would make the only way
out invisible.

**Confirming can re-point the money, and that is also the way out of a dead
end.** `confirmReceipt` takes an optional allocation and runs the SAME pure
`allocate` the record form runs, so the preview in the review drawer is the
arithmetic that gets written. Before this, a bill named at report time that had
since been settled refused the confirmation outright and left
reject-and-re-record as the only path — which throws away the claim, its date
and its reference to fix something that was only ever about which bill.

**A reported payment does not make a bill look settled.** A bill offers its
whole unconfirmed balance; money somebody has merely reported against it is
SHOWN on the row and never subtracted from it. Subtracting was the old guard
against two people writing down one transfer, and it made a fully-claimed bill
read as zero available — so accounts holding the bank statement could not record
the very money they were looking at, while the ledger still said the customer
owed it. The duplicate is now caught where it happens: `matchesForEntry` asks a
person a question they can answer, instead of silently making a bill
unavailable and leaving them to work out why.

**And the rule holds on the screen, not only in the service.** The entry form
kept subtracting `paid + reported` from what it offered for months after
`recordReceipt` stopped — so the preview and the save disagreed about the same
bill, and the preview was the half people were working from. A bill somebody
had claimed read ₹0 available, ticking it answered "no longer open", and the
only way to record money accounts could see in the statement was to reject the
claim first. What the row shows instead is a pill: the amount claimed, said as
a hold. The same mark is on the bill line of the customer statement, because a
bill still standing at its full amount after the customer said they paid it is
exactly the row somebody needs an explanation on. The telecaller's collections
path had the same subtraction, where it pushed the next payment past a claimed
bill onto the following one or onto account — money filed against the wrong
bill to work around a balance that was never real.

**One payment written down twice is the ordinary failure, and it is caught at
the point of entry.** A telecaller records what a customer said days before the
transfer reaches a statement. `lib/engines/receipt-match.ts` is pure and offers
candidates strongest-first: a normalised reference beats an equal amount —
because a UTR names one transfer and where the amounts then disagree that is
exactly what somebody needs to see — and a near amount is a question rather than
an answer. Two receipts with no reference match on nothing, or every
unreferenced receipt would match every other. Only `reported` and `held` are
ever candidates: offering confirmed money invites confirming one payment twice.

**Recognising it CONFIRMS the existing receipt rather than writing a second.**
That is the whole point — one payment, one row, the customer credited once —
and accounts' reference and date are written onto it on the way past. The
amount is not: a different amount is a different payment. The typed
confirmation is checked in `confirmAsMatch` as well as in the dialog, because
merging two records of money is not a thing to do on a stray click and a check
that lives only in an interface is not a check. A genuine second payment of the
same amount is still recordable — made deliberate, never refused, or people
learn to work around the screen.

**The match is a SUGGESTION, and it never stands in the way.** It used to: a
near-certain candidate blocked the save until somebody ticked "this is a
different payment". But the screen is guessing from an amount and a date, and
two customers paying ₹50,000 in the same week is an ordinary Tuesday — a gate
in front of the ordinary case is a gate people learn to click through. It
appears as the amount is typed, it is answered with "Yes, this is the one" or
"No — this is a different payment", and either answer takes it off the screen.
Editing the entry asks again, because a changed entry is a changed question.
Nothing is weakened by this: yes still opens the merge dialog, still needs the
amount typed back, and `confirmAsMatch` still checks it on the server.

**A cheque has two dates and they answer different questions.** `received_at`
is when we got it; `instrument_date` is what is written on it, and a cheque
handed over on the 3rd dated the 20th cannot be banked until the 20th however
firmly it is in our hands. Which modes carry one is `payments.datedModes`,
because the mode list is itself configuration and hardcoding "Cheque" would put
the two out of step the day somebody adds a demand draft. Past and future are
both ordinary and neither is bounded.

**The date is asked of everybody, unlike the reference.** The reasoning that
spares a telecaller a UTR does not carry across: a customer who says they have
paid by cheque is holding the cheque, and "what date is on it" is a question
that can be asked on the same call. Without it accounts cannot tell a cheque due
to be banked this morning from one dated next month.

**A post-dated cheque buys quiet until it can be banked.** The reported window
is a few days and a cheque can be dated a month out, so measured from when it
was written down the quiet lapses long before the money is even reachable — and
the customer is chased for a cheque sitting in our own drawer, which is the most
annoying call it is possible to make and one where they are entirely right. Once
the date passes, the ordinary window runs from THERE rather than from the day
somebody wrote it down. Accounts see the mirror of it: a cheque dated today or
earlier is flagged as something to go and find, and a post-dated one is
deliberately calm, because marking what is not yet asking for anything is how
people learn to ignore the marking.

**One component asks how the money came, because it was three.** The
collections worklist, the bills ledger and the call panel each carried their
own copy of Mode and Reference, each with the mode list written out as a
literal — so `Credit note` reached the accounts app and none of them, and the
cheque date would have had to be got right three times.
`components/crm/payment-mode-fields.tsx` is the one answer, and it reads
`payments.modes`. A list of modes typed into a screen is the same mistake as a
product list typed into a screen.

**The handset reads the same list, minus the desk's two.** `payments.modes`,
`payments.datedModes` and `payments.referenceRequiredModes` ride the MBOS
config payload, and `engines/payment-modes.ts` drops `Adjustment` and
`Credit note` from what the field form offers: both are accounts' decisions
against the ledger, and one typed at a counter would put money in a
salesman's cash-in-hand that no bank will ever show. An older server that
sends no list gets the four the form always had.

**A validation message goes under the field it names.** These dialogs pinned
whatever the server said to the amount box, so "a cheque needs the date written
on it" appeared under Amount received — pointing at the one field that was
correct. The field errors carry their `field` through and are rendered against
it; a message under the wrong field is worse than no message, because it sends
somebody to fix what is not broken.

**`Adjustment` and `Credit note` are payment modes, and neither is money
arriving.** One settles a bill against something already on the account, the
other against goods returned or a claim allowed. Both close a bill exactly the
way a transfer does, and leaving them off the list is how they get recorded as
cash nobody can find in the statement afterwards. `0051` appends `Credit note`
to deployments carrying the old default, matching on `updated_by_id is null`
AND the stored value still being the previous default — a team that curated its
own list, including one that deliberately removed a mode, is left alone.

**A receipt is one arrival of money; `payments` rows are where it went.** Which
bills a transfer settles is a second question with a second answer, so a
₹50,000 payment across three bills is one receipt and three allocation lines.
Fusing the two — which is what a payment pinned to a single bill was — makes
part payment, a transfer covering several bills, and money received in advance
all impossible to record honestly. A line with a null `billId` is money on
account, and a remainder becomes one rather than being refused at the door:
refusing it is how a receipt gets recorded for the wrong amount to make the
screen accept it.

**Allocation is pure, and the screen runs the same function the server does.**
`lib/engines/allocation.ts` takes bills, an amount and one of four
instructions — oldest first, newest first, settle these, split it myself — and
returns lines. Accounts are deciding where the money goes, so a preview that
disagreed with the save would be worse than no preview. What a bill offers is
its whole unconfirmed balance: money merely reported against it is shown beside
it and never subtracted, and the duplicate is caught at the point of entry
instead.

**Only the automatic spread has a direction.** Oldest first is the default and
the ordinary answer — the oldest debt is the one aging, and clearing it is what
takes a customer off the collections list. Newest first is for the customer
paying against the invoice in front of them, where spreading from the oldest
end settles a bill from March and leaves the one they were talking about
standing. Ticking bills or typing amounts has already said which bills, so
`order` means nothing there and is ignored rather than offered.

**A reference is asked for, and no longer demanded.** Accounts match a receipt
against the bank statement by that string, so one recorded without it is money
somebody has to go looking for — worth asking, and never worth refusing a save
over. `payments.referenceRequiredModes` is EMPTY by default now. The rule it
enforced was aimed at whoever asserts the money arrived, which is exactly the
person sitting with the statement open, having already found the payment they
were entering: the entry is itself the cross-check the field was standing in
for, and the red line under the box stopped them recording money they could
see. It was never asked of a telecaller repeating what a customer said — they
rarely have the UTR, and refusing that save would lose the claim rather than
improve it. Naming a mode in the setting brings the rule back for it, and
`0052` moves deployments that never curated the list.

**Confirming is checked server-side, and a stale allocation is refused rather
than moved.** If a bill a pending receipt names has been settled by something
else since, confirming fails and says so — silently re-allocating money is not
a decision code should take on its own.

**A collections call is logged in one place, and it is one transaction.** The
follow-up panel opens over the worklist and never navigates away — a
telecaller working a list of twelve should not lose their place to look at a
bill. One outcome can produce a promise, its reminder, a payment spread over
the oldest bills first, a billing complaint and a raised stage floor; a
half-saved one leaves the account describing something that never happened.
The seven outcomes and what each requires are declared once, in
`lib/services/payment-followup-service.ts`, and the screen reads that list —
so the form and the action cannot disagree about which fields are mandatory.

**The stage is derived, but it has a floor.** A customer who refuses to commit
or cannot be reached has told you something their bill dates have not, so that
outcome raises `manualStageFloor`. `recomputeFollowUpState` takes the higher of
the derived stage and the floor: the stage still rises with the age of the
debt, and never reads below what the refusal earned. The floor leaves with the
row when nothing is overdue, because it described a debt that no longer exists.
A floor a recompute erases is not a floor, and there is a test saying so.

**The slow-payer flag has a grace period, and the grace is on the due date.**
A payment landing a day or two past its term is ordinary business — a cheque in
the post, a bank holiday, an accounts department that pays on Fridays — and
counting those flagged customers who pay perfectly reliably, just not to the
calendar. `escalation.slowPayerGraceDays` (7) is what a payment has to exceed
before it counts as late at all; `slowPayerLateCount` still decides how many
late ones earn the flag. Forgiving the count instead would let a customer who
is genuinely a fortnight late three times over pass as reliable. The flag is
read as "be careful with this one", so it has to mean it, and it is a derived
cache — changing the grace and re-running `recomputeSlowPayers` reclassifies
the whole book without touching a row.

**A late bill is messaged before it is called.** For the quiet window — 15 days
past the due date — the customer gets a reminder message every four days and no
call at all, because a bill a few days late is usually paperwork rather than
refusal. Calls open the day the window closes, and from then the customer rests
three days after each logged call. Messages do not stop when calling starts.
The window and the stage-2 threshold are two statements of the same fact, so
`checkConsistency` refuses to let them drift: if the list offered a call on a
day `isAttemptAllowed` still called stage 1, saving it would be rejected.

**The list is ordered by WHY, then by what that reason is worth.** The tier
weight decides the order of reasons and does not move: a promise beats an order
due, which beats a stock check. Within a reason it was "who owes the most
money", which is a collections answer given to a sales question — among twenty
customers all due to order, the one who owes most is not the one to ring first,
and a telecaller working top-down spent the morning in the wrong half of the
book. `callValuePaise` asks the question the reason is about: a collections call
is worth the debt, a sales call is worth the order. The order figure is the
MEDIAN of the customer's own recent approved orders, never a figure derived from
the catalogue — there are no prices in the product master and a confident wrong
number would be worse than none.

**A prediction is discounted by how sure we are of it.** `cycleConfidence` was
computed, stored, banded and displayed, and nothing acted on it. Two customers
averaging thirty days are not alike if one orders every 29, 30, 31 and the other
after 15, 45, 22, 60 — so where the reason is a PREDICTION (order due, overdue,
stock check) the order value is multiplied by it. A lakh at a coin toss is worth
less than sixty thousand like clockwork. Reminders, prospects and check-ins are
facts rather than predictions and carry their value whole. A NULL confidence
discounts nothing: every cycle computed before the column existed carries one,
and halving them would be a uniform penalty dressed up as a judgement — missing
information must never demote anybody.

**Confidence also moves the stock-check day.** The call lands at
`queue.routineCallPercent` of the cycle, swung by `queue.routineConfidenceSwing`
— a perfectly regular customer is called LATER, closer to the day they actually
order, and an erratic one earlier, because the honest answer to a guess is a
wider net. Fifty is neutral, so a swing of zero is exactly the old flat
behaviour. It moves the day and never creates a call the cycle length says
should not exist — a short cycle still gets no stock check.

**A claim nobody has decided can be CORRECTED, not only rejected.**
`correctReceipt` fixes the amount, the received date, the mode, the reference,
the cheque date and the note of a `reported` or `held` receipt, with a required
reason kept in the audit log (`payment.corrected`). Accounts (`payment.confirm`)
may on either status; the person who recorded it may only while it is still
`reported` — once Accounts hold it they are the ones looking. A `confirmed`
receipt is never corrected: it has counted, so it is reversed from the statement
and recorded again. Nothing that counts moves, because every money path keys on
`confirmed`. A new amount is filled into the SAME bills the claim named, in
order, each up to what it owes, and the rest goes on account (or is refused
where `payments.allowOnAccountRemainder` refuses it) — "settle these bills"
would refuse a smaller figure outright, which is the usual correction. Before
this, a mistyped figure had to be rejected ("never arrived") and recorded again,
which tells the customer's statement something untrue. It is the Correct button
in the Accounts review drawer, and in the CRM customer record's Ledger tab for
the person who recorded it: `/api/customer-statement` returns `mine`, their own
`reported` claims for that customer (`myReportedReceipts`, read after the
statement so scope has answered), and the tab lists them above the statement
with Correct, which opens the same `CorrectReceiptDialog`. Held claims are not
listed there — they are Accounts' by then.
