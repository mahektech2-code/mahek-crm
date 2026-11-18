# Samples, qualification workflow, lead conversion on order

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A SAMPLE HAS THREE DATES BECAUSE THREE PARTIES ASSERT THREE THINGS.**
`dispatched_at` is us saying it went. `delivered_at` is the carrier, or our own
man, saying it arrived. `received_at` is the SHOP saying it is in their hands.
No two of those are the same fact, and §J turns entirely on the third — "sample
received Yes/No; if No the follow-up remains pending" — which a single delivery
date could never answer. It is the same discipline `payment_receipts` keeps for
money, one module over, and `received_at` is NEVER defaulted from
`delivered_at`: a default would quietly assert something nobody asked the
customer.

**The review call is dated from CONFIRMED RECEIPT.** Not from dispatch, which is
the whole reason the third date exists: a review timed from the day we posted it
rings a customer still waiting for the parcel, and that call teaches them we do
not know where our own stock is. `mbos.samples.reviewAfterDays` is the window,
and the task is raised once, on the transition, so a re-sent confirmation cannot
stack a second one on somebody's list.

**Trial STARTED and trial COMPLETED are two columns, and the gap is the point.**
A trial started and never finished is the commonest way a sample goes quiet, and
it is invisible where the only column is an outcome.

**A REJECTED SAMPLE HAS TO SAY WHY.** The same rule as a lost lead and an On
Hold, for the same reason: the next sample goes out exactly the same otherwise.
Enforced in the handler and stated on the screen before the button is pressed,
because being refused after the fact loses the sentence somebody had in mind.

**AND THE HANDSET SAYS WHY IN ITS FEEDBACK, which the handler did not read.**
The phone demands one of three boxes before it saves a "No" — what else they
said, the price, the comparison — and sends them as `feedback`, never as
`rejectionReason`. The check read only the second, so every rejection a
salesman recorded was refused as "no reason" while his screen said Saved, and
the trial stayed pending in the office. `handleSampleUpdate` now derives the
reason from those three boxes, in that order, and stores it.

**AN APPROVED SAMPLE OPENS NEGOTIATION, and that is what unlocks the order.**
§L follows §K deliberately: the sample review is what authorises a commercial
conversation, not the salesman deciding he is ready for one. `afterSampleVerdict`
moves the lead to `negotiation`, which is the stage `handleOrder` requires — so
the gate and the thing that opens it are one mechanism rather than two.

**ON EVERY LADDER, THROUGH THE GATE.** The move used to fire only for a lead
on the legacy `qualified` rung, so a funnel lead at `sample_review` was told
"Negotiation is open", handed a negotiation visit, and stayed where it was.
`openNegotiation` moves a funnel lead with `evaluateLeadStageMove` and
`applyLeadStageMove` — the same gate and the same transition row a press of the
button writes — and where the gate refuses, the notification says what is still
missing instead of promising a conversation the ladder will not allow.

**QUALIFYING A LEAD IS WHAT STARTS THE WORKFLOW.** `qualifyLead` fills the Lead
Manager seat from the ORG CHART — the same `managerNameByEmployeeName` that
`recomputeSalesManagers` reads nightly, asked about one person, so the seat a
qualification assigns and the sales manager the nightly pass writes cannot
disagree about who reports to whom. It notifies, and it raises a validation call
for the NEXT WORKING DAY, holidays included, from the same working-week
configuration the forecast reads. It is IDEMPOTENT — the seat itself is the
guard — because a sync endpoint retries and a second pass must not put a second
call on somebody's list. It does NOT set `lead_manager_decided_at`: nobody
decided this, the org chart did, and stamping it would freeze the seat against
every future org change as a side effect of a lead being qualified.

**It fires from BOTH doors.** A lead qualified from the lead screen and one
qualified by answering a visit's own decision start the same workflow. A
workflow that fires on one of two paths is a workflow salesmen learn not to
rely on.

**THE VALIDATION CALL'S ANSWERS ARE NOT WRITTEN OVER THE LEAD'S.**
`lead_requirement` is what the salesman was told standing in the shop;
`mbos_lead_validations.confirmed_requirement` is what the office was told on the
phone. The two disagreeing is the single most useful thing this call produces —
it is how anybody finds out the report and the shop did not match — and
collapsing them would overwrite the first reading with the second and destroy
exactly that. It is a TABLE and not columns for the same reason: a lead is
routinely validated twice, and the first call is usually the one that matters.

**The requirement VISIT does overwrite them, and that is not a contradiction.**
It is the same person asking the same question better informed, not a second
party's account of it.

**The script is CONFIGURATION.** `mbos.leads.validationScript` holds the
headings and lines the caller reads out, because it is content: it will be
argued about, improved after a bad call and eventually translated, and none of
that should need a deploy — or, on the handset, an APK nobody can recall.

**AN ORDER ON A LEAD CONVERTS IT, AND THAT IS A REVERSAL.** This paragraph used
to say the opposite, and the code stopped agreeing with it before this file did
— which is worse than either answer, because a reader who trusts it goes on
building against a refusal that is not there. It said: §G carries no price,
service or quality promise at the requirement stage, an order is the most
commercial commitment there is, so `handleOrder` refuses one against a lead
below `negotiation`, and refusing loses nothing because the order was never
agreed with anybody who could agree it.

Mahek's answer is the opposite and it is theirs to give: **a shop that is ready
to buy is a customer, whatever rung somebody had filed it under**, and a
salesman standing in front of one with an order in his hand must not be told to
come back later. The reasoning that produced the refusal was not wrong about
§G; it was wrong about what §G governs — a requirement VISIT makes no promises,
and a customer placing an order is not the visit.

The stage machinery is not wasted by it. §L still opens negotiation off an
approved sample, the tasks still fire, and `lead_stage` still records how the
account was won. What has gone is only the refusal.

**And the conversion is `lead-conversion-service`, the SAME function the CRM's
interaction save calls.** Two copies of "what happens when a lead orders" would
drift within a release, and the half that drifts is the one nobody is watching
— which here is the handset.
