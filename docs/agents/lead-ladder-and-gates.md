# Lead ladder, gates, nurture, samples state

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A LEAD CLIMBS A LADDER, AND WHICH LADDER IS THE FIRST THING ASKED.** Mahek
sells three ways and they are not the same job: a direct customer is worked
towards a first order, a distributor towards an appointment, and a third-party
shop towards an order somebody else invoices. `customers.lead_sales_type` picks
between them and is chosen before anything else is typed, because it decides
which questions the rest of the form asks. `lib/engines/lead-ladder.ts` holds
the three, and no screen writes a stage list out.

**NULL is the fourth answer, and it is what let this ship.** A lead raised
before the funnel existed carries no sales type and climbs the six rungs this
product shipped with — `new · contacted · qualified · negotiation · won · lost`,
kept whole and kept first in the enum. Nothing backfills one. Guessing which of
three ladders somebody was on is a decision dressed up as a migration, and the
ladder decides which GATES apply, so a wrong guess would not merely mislabel a
record: it would block the salesman working it.

**ONE LADDER, SEVEN STAGES (Nov 2026) — a reversal of the paragraph above.**
Two leads added on one form the same day showed different stage bars (five for
"Not decided", eleven for Direct), the Calling desk drew a legacy lead on the
direct ladder while its record drew five rungs, and `contacted` was a Suspect on
some screens and a Prospect on others. So every lead now climbs one ladder:
`ladderFor(null)` is the direct ladder, and `foldStage` reads the retired words
onto it (`new`/`contacted` → Suspect, `qualified` → Qualification, `won` →
Customer, `sample_received` → Sample received & review). `0338_one_lead_ladder`
moved the stored values a person can still act on and gave a Suspect stage to
every lead (not a third-party shop) that had none — Lead Management reads
`lead_stage is not null`, so those were on no screen at all. `won` is kept as
written; history is never rewritten. Sales type now only says who bills, the
Add lead form has no "Not decided", and every handset stage move goes through
the gates. People see SEVEN stages, `DISPLAY_STAGES` in `lead-ladder.ts`:
Suspect, Prospect, Qualification, Sample / trial, Negotiation, First order,
Customer. `displayStageOf` is the one map; Sample received & review is a step of
Sample / trial and Delivery, Payment and the second order are steps of First
order (`stepsOf`). The record's bar, the board's columns and the funnel's rows
all draw the seven. The gates still ask per rung — nothing about §28 moved.

**`bandOf` is why seventeen new rungs moved no figure.** The console funnel
draws four bands and the owner's cohort conversion counts by them, both reading
`lead_stage`. Adding rungs without mapping them would have dropped every lead on
a new one out of the bands entirely — a pipeline that silently shrinks as the
team works it, which is the worst possible direction for that bug. The map is in
the ladder engine and there is a test that walks every enum value through it, so
a twenty-fourth rung added without a band fails the build rather than a report.

**§28 IS THE WHOLE POINT: no lead moves forward because somebody pressed a
button.** `lib/engines/lead-gates.ts` answers whether a rung may be entered and,
where it may not, WHICH conditions are missing — because a refusal that does not
say what it wants teaches a salesman to press the button again rather than to do
the work. Three callers, one answer: the handset draws the next rung disabled
with the missing list underneath, the server action refuses on the same function
before it writes, and the console shows a manager what a lead is stuck behind. A
second copy typed into a screen would drift inside one release, and the half that
drifts is the half somebody is reading.

**The gate engine is pure because it has to run with no signal.** The salesman
deciding whether he can request a sample is standing in a shop, and a rule that
only exists on the server is a rule he finds out about on the drive home. It
takes configuration and its inputs as arguments and performs no I/O, like every
engine here, and the handset compiles the same file.

**A tick is not an answer where a column exists.** Four of the twelve
qualification conditions — the monthly requirement, the potential, the product
and the competitor — are satisfied by the VALUE and not by the checkbox beside
it. A ticked box beside an empty field is precisely the state the gates exist to
prevent, and a checklist that can be completed without answering anything is a
checklist people learn to complete.

**The map and the toll are two files on purpose.** `lead-ladder.ts` answers
"what comes next"; `lead-gates.ts` answers "may we". Folding them together would
put the reason a lead is stuck inside the function that draws its progress, and
the console needs the second without the first.

**A LEAD BECOMES A CUSTOMER AT ITS SECOND ORDER, as §22 says — and that is a
reversal of what this paragraph used to say.** It said `kind` flipped at the
FIRST order, on the reasoning that about thirty readers of `customers.kind`
mean "has never ordered" by `lead`. The client corrected it: a shop that has
ordered once is still a lead being won, and `promotesToCustomerAt` now answers
`second_order` (`distributor_approval` for a distributor), with
`convertLeadOnSecondOrder` the one writer of the conversion. So a `kind = 'lead'`
row may carry one order, one bill and one confirmed payment, and a reader of
`kind` must not read `lead` as "never ordered" — `lead_converted_at`, the
order counts and `notConverted` are what say whether it has converted. Accounts
converted at the first order before the rule moved keep `kind = 'customer'`.

**A working lead is held back from the Call Log, and SHOWN.** A lead that stays
a lead through eleven rungs would otherwise sit on the telecaller's prospect
cadence for months, so the office rings a shop a salesman is actively working to
ask for a first order — two people chasing one customer, neither knowing about
the other. A lead carrying a sales type is suppressed from the prospect reason,
and suppression is a return value rather than a filter, so it appears in the
held-back strip with the reason said in words. A lead with no sales type is
untouched.

**§24: an active lead may not sit with nothing owed by anybody.** The action,
the day, the person and what that person is expected to come back with — four
answers, not a date. A date alone is what this had, and a date alone is how a
lead sits for six weeks with everybody assuming somebody else is holding it. It
is enforced on every upward move by the gate engine rather than by a required
field on one form, and legacy leads are exempt: demanding a next action to move
a four-year-old lead would freeze the book the rule exists to unstick.

**§4 pushes rather than holds.** Two visits to decide whether a Suspect is worth
anything, three at the outside — and past the cap nothing is refused, a decision
is DEMANDED. The lead turns into one question, Prospect or Not Prospect, and
both answers are moves the engine allows. How many visits a suspect has had is
counted from `mbos_visits` and is deliberately not a column: a counter would
drift the first time a visit arrived late from a handset.

**A REASON IS A CODE, NEVER A LABEL.** Why a Suspect became a Prospect (§5), why
the customer wants a trial (§10), why a lead was lost (§26) and why a manager
overrode a gate — four lists, all in `lib/config/registry.ts` because a manager
should be able to reword one without a deploy, and all stored as codes because a
stored label stops resolving the moment they do. It is also what makes "how many
did we lose on credit terms this quarter" a question somebody can ask rather
than a grep over free text.

**The override exists so the rule survives contact with a Tuesday.** A system
that refuses everything is defeated in a week by people recording the work after
the event, and the record then says the process was followed when it was not —
which is worse than the gate being open. So a manager may pass a shut gate, it
demands a reason, and `lead_stage_transitions.overridden_conditions` stores
exactly what was still missing. `leads.allowManagerOverride` turns it off for a
team that would rather be stuck.

**Every move is a row, and the row is the timeline.** `lead_stage_transitions`
is append-only: a transition recorded wrongly is corrected by a further
transition, never by an edit, for the same reason `calls.next_step_*` is never
rebuilt — it records what somebody decided on a day, and a rewrite destroys the
question rather than answering it. §25's timeline is that table joined to the
manager's calls, the samples, the orders and the receipts, and every lead write
also lands a `timeline_events` row so the story reaches the customer record it
becomes.

**§8 stores the ANSWERS, not the verdict.** The sales manager rings the customer
to establish that the visit happened, that Mahek was explained and that the
opportunity is real. A verdict on its own would be worth very little a month
later; the value is the twelve answers, because "whose product did he say he was
using" is exactly what somebody needs before the negotiation call. Two of the
twelve are about the salesman rather than the sale, and they are why the call
exists at all — no amount of GPS proves that Mahek was explained properly.

**§13's fifteen tasks are a table, not fifteen conditionals.**
`NURTURE_SEQUENCE` in `lib/lead-labels.ts` names the trigger, the delay, the
owner and the sentence; `lib/engines/lead-nurture.ts` turns an event into the
tasks that should exist, keyed on `mbos_tasks.sourceType`/`sourceId` so a second
pass raises nothing twice. `owner` matters: the salesman and the manager are
chased for different things about the same lead, and one list would read as one
person being nagged twice.

**§16 does not stop.** A sample review is chased on day 2, then 4, then 6 — and
the LAST interval repeats until there is an answer, because a trial nobody
reviewed is stock given away for nothing. `mbos_samples.review_chase_count` is
what lets a screen say "asked three times", which is the number that tells a
manager to pick up the phone themselves.

**A sample's STATE and its VERDICT are different questions.**
`mbos_samples.state` is the journey — requested, approved, dispatched, received,
tried, reviewed — and `trial_outcome` is what the customer thought. With one
column, a sample approved three weeks ago and never dispatched looked identical
to one under evaluation; it is stock nobody gave away and an opportunity nobody
took. `more_testing` is a real third verdict rather than a shrug: "they want to
try it again on a different substrate" is neither approval nor rejection, and
recording it as pending loses the fact that a trial happened at all.

**§16's feedback is seven answers because "good" cannot be read back.** Quality,
performance, application, drying, the comparison, price, and one open box. The
whole point of a trial is the comparison, and a note field cannot later be read
as "better drying than the incumbent, price is the problem".

**§12: a salesman may never appoint a distributor, and a manager may not do it
alone.** It routes through `mbos_approvals` — the same table and the same
two-step chain every other MBOS decision uses — with `stepIndex` 0 the sales
manager and 1 management, which is the `distributor.approve` capability and
admin's alone. What forces the second step is named rather than judged:
exclusivity always, a discount above
`leads.distributorDiscountApprovalPercent`, a credit limit above
`leads.distributorCreditLimitApprovalPaise`. The person carrying the target must
not be the person allowing the discount that hits it — the same reasoning that
keeps `order.approve` away from managers entirely.

**The distributor's own salesman is a name, not an account.** Rahul, in §23's
example, works for the distributor, has no MahekOne login and never will.
`distributor_salesmen` is that fact, and `customer_distributors` points at it, so
the chain Mahek → distributor → his salesman → the shop is recorded from the
first visit rather than reconstructed at conversion. Giving him a `users` row
would put him in every person picker in the product.

**§20 is RENDERED, never re-implemented.** Order Received → Confirmed →
Dispatched → In Transit → Delivered is a second status ladder for a row whose
status already comes from the Order Details tab and from accounts' approval. A
parallel one would be overwritten every thirty minutes by the sheet projection
or would fight it into `sync_conflicts`. The lead page shows the orders and the
receipts that exist; it writes neither.

**§21 already existed and is called rather than rebuilt.** The reorder cycle is
`engines/buying-cycle.ts`, measured from real approved orders and discounted by
`cycle_confidence`. The repeat-order call is a nurture task dated from it.
