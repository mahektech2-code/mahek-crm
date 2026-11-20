# Call Log ordering and the next-step sentence

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**The Call Log chases orders, not contact.** A customer with a measured buying
cycle gets a stock-check call at a percentage of their own cycle — 70% of 30
days is day 21 — and is chased from their due date onwards. Underneath it sits
a quiet window: no order is chased inside 15 days of the last one, because
somebody who ordered days ago is serving themselves. Customers who have never
ordered are prospects, worked on their own short cadence.

**The quiet window NEVER outlasts the customer's own due date.** It is a flat
fifteen days and cycles are not, so on anybody who reorders faster than that it
used to run past the day their order was actually due — a seven-day buyer was
held until day 15, a whole cycle missed, and the call that finally came was
eight days late. The people ordering most often were the ones chased last,
which is backwards, and the orders it lost were real. It is capped at the cycle
now, so every customer follows one rule: quiet until their order is due, chased
from the day it is. Only a MEASURED cycle caps it — a guess is not a due date,
and shrinking a real window on the strength of a number nobody measured would
chase people on the strength of a default.

**What a short cycle costs is the stock check, and nothing else.** At or below
`queue.routineMinCycleDays` (15) there is no call before the order is due. That
call asks what is left on the shelf and somebody buying every week already
knows; their order is still chased on their own due date exactly like a
thirty-day customer's.

**The weekly check-in goes to one group: customers whose cycle cannot be
measured yet.** There is no cycle to time a call from, so a steady cadence is
all there is. Everybody else is called from their own cycle.

Customers reordering FASTER than the quiet window used to get it too, on the
reasoning that going silent on your best customers loses them. They no longer
do: a customer buying every seven days is in contact constantly through the
orders themselves, and a weekly call on top is noise on both sides of the
phone. Their own cycle is what calls them, and it calls them sooner than any
weekly cadence would. A customer with a measured cycle of 15 days or more never
had the check-in either: their cycle already says when to call, and a weekly
one on top would ring a 60-day buyer eight times before their order was due.

**The quiet window silences order chasing, not the customer.** The order
reasons are stripped rather than the whole customer suppressed, so a telecaller
with a reminder against them still sees the call they are actually making
rather than one about an order. A customer left with nothing at all is shown
in the held-back strip with the reason, never dropped silently.

**A reminder outranks the quiet window, the no-order cooldown, the inactive
watch and the WhatsApp cooldown.** A callback the customer asked for is not
chasing, and not making it is worse than any wasted call. The WhatsApp cooldown
was the one that did not bend, so a marketing message sent on Tuesday silently
cancelled a call promised for Wednesday — a broken promise caused by something
we chose to do, which is the worst kind. It does not outrank do-not-contact, it
does not outrank having already called them today, and it does not outrank the
external order system: the first is a standing instruction and the other two
mean the contact has already happened.

**Asking for an order and being told no buys quiet.** Without the cooldown, a
customer past their call day returns to the top of the list every single day
until they order, which punishes the telecaller for working it.

**Saving a call says what happens next, and it is not a second copy of the
rules.** `lib/engines/next-step.ts` asks `buildQueue` the question it already
answers — is this customer on the list — once for today and once for each day
after, and reports the first day the answer is yes. Re-deriving the cycle, the
quiet window, the cooldowns and the no-answer ladder would produce a copy that
drifts within a release, and the sentence a telecaller reads out on a phone
call would be the copy that was wrong. Pure, like every other engine, and
`nextStepForCustomer` is the one place it is wired to data.

**A prediction and a promise are drawn differently, and the BADGE is what
draws them.** `booked` is a callback the customer asked for; `scheduled` is a
date the rules produce, and it does move the moment they order, pay or ask for
a callback. That used to be said in a sentence under the date — and the
sentence took the confirmation back in the same breath, which is the one thing
this screen cannot afford: a telecaller cannot act on a date the screen is
already apologising for, and the caveat was true of every scheduled date ever
shown, so it carried no information at the moment it was read. The badge says
which kind it is without arguing with the line above it. `decide` and `none`
carry NO date at all — a customer nobody can reach and one marked
do-not-contact will not be brought back by anything, and putting a date on
either would be an invention the telecaller has no way to check.

**The headline is one fixed form of words, and it names the screen.** "Comes
back to your Call Log on Mon 1 Sep — 13 days away", the same shape for every
reason, with what to do and why on the line beneath: "Ask for the order — they
are due to reorder." It said "Back on your list" before, which was true and
answered a question nobody asked — a telecaller does not hold a mental model
of "the list", they open the Call Log. A confirmation read sixty times a day
works by being recognised rather than read, so the part that VARIES is the
reason underneath, which is the only half worth reading twice.

**And it is READ where the work is chosen, not only where the call was made.**
The dialog says it once, at the moment of saving, and then it was gone: to find
out when a customer comes back you opened their record, one at a time. The two
screens somebody actually decides from now carry it — the Call history, where
each row shows what THAT call said would happen next, and the customers list,
which shows the last thing anybody was told, between Outstanding and City.

**It is the stored answer, and it says when it was said.** These columns are
what the screen told the person who logged the call, on the day they logged it,
and a customer who has ordered since has a different next call now — so a date
already past is drawn muted rather than sitting in a column of future dates
looking like a commitment, and the day it was said is on the hover. Deriving it
live for twenty-five rows would mean running the queue engine twenty-five
times per page, and the answer would no longer be a record of anything.

**An empty cell means nobody has called them.** Which is most of a fresh book,
and it is the honest answer: nothing has been promised because nobody has
spoken to them. `decide` and `none` are the opposite case and carry no date by
design, so they print their word — a blank cell where the answer is "nobody can
reach them" reads as missing data.

**The three screens share one vocabulary**, in `lib/next-step-labels.ts`, with
a long word for the dialog and a short one for a table cell: "You owe them this
call" in a 90px column is a sentence nobody finishes.

**And it is shown by every path that logs a call, not just the calling
queue.** The collections follow-up panel on `/crm/payments` saved and advanced
straight to the next overdue account for as long as it existed — so the
telecaller who had just agreed a promise date with a customer had nowhere to
be told when that customer comes back, on the screen where the question is
asked hardest. `logPaymentFollowUp` calls the same `nextStepForCustomer` after
its recompute, stores the six columns on the `calls` row it already writes,
and `PaymentPanel` renders the same dialog. A confirmation that appears on one
of two save paths is one telecallers learn not to rely on.

**The headline is the EARLIEST day they come back, and the promise is named
beside it.** On a prospect or an overdue account the cadence often lands before
the callback somebody committed to, so answering with the promise alone would
be wrong about when the name reappears — and answering with the cadence alone
would be a confirmation screen that never mentioned the promise the telecaller
had just made. Both are true and both are said.

**A verdict about today cannot be rolled forward.** `paymentCallDue` on a queue
candidate means collections wants a call NOW; carried into the search unchanged
it fires on every future day, so every customer with a debt would be told
"chase them tomorrow" for the rest of the year. `paymentCadenceFor` asks the
collections engine for a DATE instead — `nextCallOn`, pushed out by a live
promise and by reported money exactly as the worklist pushes it — and `held`
accounts get no date at all, because somebody is arguing about that bill.
`calledToday` and a same-day skip are cleared for future days for the same
reason.

**What the telecaller was TOLD is stored on the call, and it is not a cache.**
Six columns on `calls`, written once, after every recompute the save triggers —
read a moment earlier and they would describe the world before the call that
just happened. `lib/recompute.ts` does not touch them and must not learn to: a
cache answers "when is the next call" and is rebuilt when the answer changes,
while these answer "what did we tell the person who logged this call, on the
day they logged it", and a rebuild does not correct that question, it destroys
it. It is the same kind of mark as `orders.approvedAt` and
`bills.paymentDecidedAt`. The current next step is derived on read, from live
data, and the two are MEANT to be able to differ — that difference is the
record of what changed since. A duplicate save returns the stored sentence
rather than a fresh reading, so a double-click cannot show a second answer.

**Working it out never fails the save.** The call is in the ledger before any
of this runs; the sentence is a courtesy on top of a completed write, so a
failure leaves the columns null and the screen says plainly that it could not
work it out. Calls logged before this existed have no sentence and nothing
reconstructs one — a reconstruction would be today's answer wearing an old
call's date.

**Editing a reminder is not rescheduling it.** `editReminder` changes the note
and the kind of a PENDING reminder and nothing else; `rescheduleCount` is left
alone, because "moved five times" is a signal about the account and a fixed
typo is not a sixth move. The date is Reschedule's alone. A system-generated
reminder (a promise's chase) keeps its kind — the promise's edit and cancel
find their chase by `type = 'payment_promise'`. The same people may edit as may
reschedule.

**An opportunity's value and expected day are corrected only while it is being
worked** (`editOpportunity`, the same visibility `setOpportunityStatus` asks).
A won or lost one is a record of how it ended; reopening is the way back. Either
figure may be cleared — "nobody put a number on it" is already an answer the
list says out loud. The product and quantity are the customer's words on the
call and are not edited.
