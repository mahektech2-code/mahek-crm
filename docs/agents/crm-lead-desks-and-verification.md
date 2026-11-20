# CRM lead desks, calling desk, qualification and verification

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE CRM'S LEAD MANAGEMENT IS A SIDEBAR GROUP OF DESKS (Nov 2026), and that
replaced a frame of four areas.** The old frame drew a second header (its own
title, a second search box, "+ New lead"), four area tabs, a strip of desk pills
or cards, and a row of sub-tabs — up to six layers before the first lead. Now
"Leads" is an ordinary sidebar group like Customer records, one row per desk:
My day, All leads, Calling desk, Sales Manager desk, Verify & qualify, Samples &
trials, Negotiation, Handovers, Lead reports. `lib/lead-hub.ts` (`HUB_DESKS`) is
the map, pure: every link names the module that guards its route, and
`lead-hub.test.ts` fails on a link to no module or a lead module with no link.
Desks with `nav: false` have no row — New lead (a button), Follow-ups (filters
of All leads now: `?view=today|overdue|unworked|parked`), Distributors (closed
to new leads) and Lead control (administrators') — and their tabs are still
drawn when somebody is on one; somebody holding only such desks gets them as
rows (`hubNav`). The frame (`components/leads/hub`) draws the desk's title, the
screen's buttons beside it (`HubActions` portals them), "+ New lead" on My day
and All leads, and ONE row of underlined tabs; a record draws nothing from the
frame. The sidebar lights the row whose matched address is longest
(`activeHrefFor`), so Lead reports lights on `samples/feedback`. It decides no
access — every module folder keeps its own guard. Inside it `useInLeadHub()`
still drops a banner's long body and `Empty`'s paragraph, and `LeadTabs` draw
nothing. The Sales Dashboard mounts the same screens outside the frame.

**The lead record has five tabs**: Overview, Qualification (with the
verification), Samples, Orders & money, Activity (messages, follow-ups, stage
history, timeline). Old `?tab=` addresses open under their group (`TAB_GROUP`).
A Suspect moves by one button, Convert; a Prospect's card says it waits for the
Sales Manager's verification instead of offering a move.

**A LEAD'S RECORD IS ONE PAGE OF CARDS, AND ITS ACTIONS ARE ONE MENU.** The
header names the lead, its sales type, its rung and how long it has stood
there, and its priority; beside it are Call (only for somebody who works the
Calling desk — it opens the desk's own `LogCallDialog`, also from `?call=1`,
which is what My day's Call buttons link to), Message, the rung's act
(`PrimaryGateAction`, a link to the screen where that act is done) and a ⋯
menu holding Reassign, Change sales type, Put on hold, Hand over, Mark lost and
Delete. Each menu item is the component the old header drew as a button, with
its own capability check and dialog; the menu is hidden rather than unmounted
when closed, because unmounting would take the dialog an item just opened with
it. The ladder is a row of bars; Overview is the next step (`setLeadNextAction`
behind Change), the gate card ("To reach X", `checklistFor` ticked where the
verdict does not name it missing, `AdvanceStage` under it), the opportunity and
the calls; the rail is People, Who's up (`roleAction` for every vantage) and
Details. `components/leads/record/record-chrome.tsx` holds the pieces.

**THE CALLING DESK IS A MODULE, AND IT IS GRANTED — NOT INHERITED.** It was a
tab of All Leads, and a tab cannot be withheld: every CRM user could open the
telecaller's desk, which is the one thing that must not be true of it.
`crm.lead-calling-desk` is a module of its own, guarded on the route and again
inside every write the desk makes (`lead.work` is held by every associate, so
on its own it would let anybody post to those actions by URL). Who works the
desk is decided per person on the Access screen and by nothing in code — no
name, email or id appears anywhere in it; an administrator holds it the way an
administrator holds the whole CRM.

**A NEW MODULE REACHES EVERYBODY WHO HOLDS THE WHOLE APP, and that is the
existing rule this had to work around rather than change.** "No module rows
means every module" is what makes a fifteenth screen reach the whole-app
holders, and here it would have handed the desk to every CRM account on deploy.
`offByDefault` on an `AppModule` changes only what the Access screen STARTS
from — ticking the CRM leaves it unticked — and `0170` writes explicit rows for
each existing whole-CRM account, minus the desk, so nobody loses a screen and
nobody gains this one. A CRM administrator is left whole on purpose: they are
who decides, and narrowing them would take it from the person who hands it out.
The migration's module list is a SNAPSHOT: a module added later must reach the
whole-app holders and must not be granted retroactively by a migration that
re-reads the registry. `lead-workspace.test.ts` names the desk as the one
CRM-only exception to "every lead module is a shared section", and pins it.

**A WEBSITE ENQUIRY BECOMES A LEAD BY HAND, THROUGH THE ONE WRITER.** Receiving
an enquiry never raises a lead: a person reads it and presses Create lead, on
the four forms that may (QUOTE, PRODUCT_ENQUIRY, QUICK_ENQUIRY, DISTRIBUTOR —
never CAREER, and website is the only source). It posts to `captureLead` with
`fromEnquiry`, which changes three things and nothing else: the source is the
enquiry's own (a client cannot claim another channel), the enquiry must be
convertible and unlinked, and it is pointed at the new lead in the SAME
transaction. The WHERE CLAUSE is the guard (`customer_id is null`), the rule
`linkCustomer` already follows, so two people pressing it at once make one lead
and the loser is undone with its lead. The sales type is asked in the dialog and
never guessed, which is what makes the new lead a literal Suspect: with none the
foot of the legacy ladder is `new`, the same first band, but not the word.

**AN ENQUIRY IS CORRECTED OVER ITS SUBMISSION, NEVER IN IT, AND SPAM IS A STAGE,
NOT A DELETE (0361).** `raw_submission` stays exactly as the visitor sent it; a
person's corrections to name, phone, email, company and requirement go in
`enquiries.corrections` and are read over it by `effectiveSubmission` — every
reader (the list, the record, the lead prefill, HQ's SQL through
`raw_submission || corrections`) must read the corrected one, and
`search_text` is rebuilt from it. The activity carries each field's before and
after. An enquiry typed in by hand (`createManualEnquiry`) is `source` anything
but `website` — that source is the ingest door's alone and the only one
`leadConvertibility` lets become a lead, so a manual enquiry cannot be turned
into one yet. An Enquiries MANAGER can also DELETE one outright
(`deleteEnquiry`, the `enquiry-delete` impact dialog) — refused while a customer,
lead or order is linked. The website retransmits until acknowledged and
`createEnquiryFromWebsite` used to recognise a retransmission only by the row
still existing, so deleting keeps the (source, external ref) in
`enquiry_deletions` and a resend is acknowledged as a duplicate and dropped;
its follow-up reminders are deleted with it and the audit row keeps the
submission. `spam`
leaves All, every count and the Unassigned banner, shows only under its own
tab, is refused by `changeStage` (it goes through `markEnquirySpam` and the
`enquiry-spam` impact dialog) and is blocked once a customer is linked; any
other stage brings it back ("Not spam"). Notes are edited and deleted only by
their author — an edit keeps the previous words in `meta.edits`, a delete leaves
a `note_deleted` line with the text only in the audit row. A follow-up is moved
through the CRM's own `rescheduleReminder` (`skipCustomerScope`, as creating one
is) and cancelled through `dismissReminder`, so cancelling needs
`reminder.close` — which an Enquiries MANAGER carries (owner's decision, Nov
2026), as a CRM manager does; an Enquiries associate cannot.

**AN UNOWNED LEAD IS ON NO TELECALLER'S DESK, so it is said out loud.** An
associate's scope is their own book and `owner_id` is the assignment, so a lead
nobody owns is invisible to every telecaller. It is not automatic to give it an
owner — somebody decides — so the person who created it is told it is unowned,
whoever can assign is notified, the administrator sees it flagged with an
Unassigned filter, and the enquiry itself says whether anybody has the lead it
made. `reassignLead` could not do the assigning: it only accepts an owner who
holds the Salesman App, which puts the lead on a handset, and a telecaller has
none. `assignDeskLead` writes the same column and only to somebody who holds the
desk, because a lead given to somebody who cannot open it would vanish into a
desk nobody can see.

**QUALIFICATION IS THE TELECALLER'S, AND THERE IS NO SALESMAN IN THE FUNNEL.**
Suspect → Telecaller Calling Desk → Prospect → Sales Manager verification →
Qualification by the Telecaller → Sales Manager review → Sample / Trial. The
Telecaller who works a lead promotes it, completes its Qualification and asks for
its sample; the Sales Manager verifies the Prospect and reviews the Qualification;
nobody holding the field app appears anywhere in it (`roleAction` gives the
`salesman` vantage nothing to do at Prospect or Qualification). The whole hand-off
between the two is `services/lead-qualification-flow-service.ts` and it is
written once: `openQualificationAfterVerification` (a successful verification
opens Qualification, from the console's verification call, the Sales Manager
pipeline and the handset alike), `settleQualificationState` (who owes what after a
Qualification write), `handBackAfterReview` and `recordReviewVoid`. It does not
authorise anything — every caller asks its own question first (`lead.verify` to
verify, `lead.work` to write) — and it re-reads `lead_verified_at` from the
database rather than trusting a caller's claim.

**THE STATE IS CARRIED BY THE NEXT ACTION, not by a new column.** The Sales
Manager's "Sales Manager verification call", the Telecaller's "Complete the
qualification", the manager's "Review qualification" and the Telecaller's "Request
the sample" are the §24 next action changing owner (`QUAL_NEXT`), and a bell says
so. `mbos_tasks` is deliberately not used: a Telecaller has no handset and no
screen that reads it. Completion is DERIVED (`qualificationComplete`, the sample
gate with the review conditions left out), so there is no "submit" button to
forget and no flag that can drift from the gate.

**THE MANAGER'S REVIEW IS MANDATORY AND ONLY `verified` PASSES IT.** No review,
`incomplete` and `clarification` all block Sample / Trial; the old rule (an
unreviewed checklist passed, so the book would not stop on the day it shipped) was
a transition rule and is gone. Nothing was backfilled — the gate evaluates what is
stored — and `npm run report:qualification` is the READ-ONLY report of what that
means for the book (it writes nothing).

**A `verified` REVIEW STOPS BEING TRUE WHEN ITS ANSWERS CHANGE.**
`lib/lead-review-void.ts` (`reviewVoidPatch`, pure) returns the four review
columns to null in the SAME UPDATE as a material edit made by anybody who is not
the reviewer; the verdict that stood is kept in the audit log and the timeline
(`recordReviewVoid`). Material is exactly what the gate reads — GSTIN and its
validation, application, credit days, buyer, decision maker, the four checklist
ticks, the four Prospect figures, the sales type and the distributor link. A
no-op save, the next action, notes and contact details are not. A manager's own
ordinary edit does not void his review; a change of SALES TYPE does, whoever makes
it. `lead-review-void.test.ts` scans the source and fails for a file that updates
`customers` and sets one of these columns without going through the rule, so a new
writer cannot silently bypass it.

**QUALIFICATION CANNOT BE WRITTEN BEFORE THE PROSPECT IS VERIFIED.**
`lib/lead-qualification-access.ts` is the one sentence the server refuses with and
the screen draws disabled from. The Calling Desk's own pre-Prospect answers
(which include GSTIN, buyer, credit days and application) are its own writes and
are untouched.

**THE REVIEW DRAWS EACH QUESTION ONCE.** The Suspect list (11), the Prospect
conditions (8) and the Qualification conditions (8) ask several of the same
things, and most of those are one stored answer — the same lead column. The
review (`buildReviewRows`) draws that answer on the Suspect row, which takes over
the repeated question's "required" and its gate verdict: five Prospect questions
(type, litres, competitor, product, GST) and the two Qualification questions
whose only answer is already a Suspect row (GST, application) are not drawn
again, and the decision maker, buyer and credit days boxes inside Qualification's
people and price questions are dropped, leaving only what nothing above asked.
That is 20 unique rows (14 before Qualification opens), not 27. IT CHANGES WHAT
IS SHOWN AND NOTHING THAT IS ASKED: `PROSPECT_CONDITIONS` and
`QUALIFICATION_CONDITIONS` are untouched because `lead-gates.ts` is mirrored to
the handset byte for byte, and no stored answer moves — each was always one
column, so there is nothing to map.

**THE VERIFICATION CALL COMES AFTER THE QUALIFICATION REVIEW IS SAVED, AND IS
NEVER REQUIRED.** In Qualification the designated approver reads the one review,
corrects what needs it and presses Save changes (which may be pressed with
nothing changed — "read, nothing to correct"). That writes a
`lead.qualificationReview.saved` audit row, a mark and nothing more: it approves
nothing, moves nothing and is read by no gate. Only then is a call offered, as
"Make the call" or "Skip". `callRefusalFor` (`services/qualification-call-gate.ts`)
is the one question — "may a call be recorded now?" — and `recordLeadValidationCall`
asks it, so the button, the direct `/verify` address and a posted request cannot
disagree. The mark counts for the stay in Qualification it was made in. It applies
only where there is a review to save: a Prospect is still verified by the Prospect
review or by the call, a lead past Qualification is not held, and a distributor's
checklist (not edited from the review) is left alone. The handset records its
verifications through its own handler and is untouched.

**THE SALES MANAGER'S VERIFICATION OF A PROSPECT IS STEP 1, AND IT ONLY CHECKS.**
Before Qualification opens, the designated verifier's review is exactly the fourteen
items — the eleven Suspect answers and the three Prospect-only ones — and every one
of them is READ-ONLY. She does not edit or correct anything (`saveQualificationReviewEdits`
refuses at Prospect, and the boxes say why). The order is: she makes the verification
call FIRST (a call recorded with `forReview`, which records what the customer said
and decides nothing — no verification, no promotion, no Qualification opened); she
checks the recorded answers against it; then she CONFIRMS, which opens the existing
Qualification step, or REJECTS with a reason, which sends it back to the owner to
correct and resubmit. `reviewCallStatus` is the one question "has a call been made
for THIS round": Confirm is refused until one has, and refused while the latest call
found an answer wrong (`lead_verification_corrections`, verdict `corrected`). A
rejection starts a new round, so a corrected lead needs a new call. The other doors
(the verification queue, the Sales Manager desk's Verify) do not send `forReview` and
verify by a call exactly as before.

Step 2 is the Qualification page that already exists (the Telecaller answers its
questions there, the Sales Manager reviews them, and only then may a lead move to
Sample / Trial). Step 1 does NOT move a lead to Sample / Trial, and nothing here
changes that page or the gate rules mirrored onto the handset.

**GST IS THE TELECALLER'S END TO END.** They enter it and they validate it; the
self-check that refused the lead's owner is gone, and what keeps that honest is
that a validation belongs to the number it was made against — changing the GSTIN
clears `gst_verified`, its date and its person, wherever the number is written
(`gstinChangeClear`). `mbos.ts` must never name `gstVerified:` (a handset cannot
assert a verdict); it clears through the helper's return value.

**QUALIFICATION IS THE SALESMAN'S EIGHT QUESTIONS, AND THAT IS A REVERSAL OF THE
TWO PARAGRAPHS ABOVE ON WHO COLLECTS AND WHO VALIDATES GST.** The Salesman who
owns the lead collects the answers; the Sales Manager it is under
(`customers.sales_manager_id`) validates the GST number and reviews them. The
Telecaller is not part of this stage. The engine, the actions and the handset
are role-agnostic about who the owner is — `owner_id` completes it — so a lead a
Telecaller owns still works; what changed is who the product assumes and who
may validate and approve.

The eight, as `QUALIFICATION_CONDITIONS` states them: the GST number, the
application (what they will use it on — there is NO success criterion), the
trial plan (product, pack, quantity, who tests it, for how long), who decides /
orders / pays, price and credit (the range, the credit days, how they took
it), delivery (where, the lead time, whether it suits them), still willing to
test (only a *yes* passes, and it is asked after the commercial facts), and the
agreed next step with a date. Monthly litres, competitor, required product and
contact person are Prospect answers and are NOT re-asked; the freshness check
(`figures_fresh`) still confirms them. Four answers live on the lead's own
columns (GSTIN, application, credit days, decision maker); the rest are keys in
the existing `lead_qualification` jsonb, named in `QUALIFICATION_ANSWER_KEYS`
and checked by `qualificationAnswerFault` on the web action and the handset's
sync handler alike. No migration: an old tick stored against a retired id stays
where it is and is simply never read. A "tick" satisfies nothing any more —
every condition reads a stored answer.

**GST IS COLLECTED BY THE SALESMAN AND VALIDATED BY THE RESPONSIBLE SALES
MANAGER, as part of her review.** `validateGstin` asks `gstValidatorRefusal`
for a lead on the funnel: the seat holder, an administrator, or — where nobody
holds the seat — a `lead.verify` holder; never the lead's owner. An account that
was never a lead keeps the old rule (`lead.gstValidate` or the back-office
seat); `lead.gstValidate` and `back_office_am_id` are not removed, and every
validation already on record is untouched. A refusal needs a reason and goes
straight back to the Salesman as "Correct the GST number" with the reason in
the bell. A validation belongs to the number it was made on: changing the
GSTIN clears it, and — now even for a reviewer's own edit — takes a standing
approval away.

**THE LEAD IS READY FOR REVIEW BEFORE GST IS VALIDATED, OR IT WOULD NEVER BE
ASKED FOR.** `qualificationReadyForReview` is every answer in with the GST
number entered and not refused; `qualificationComplete` stays strict (it adds the
validation) and is what a `verified` verdict and the Sample/Trial gate require.
`reviewLeadQualification` now refuses `verified` unless the strict test holds
and names what is missing — before, a verdict could be recorded over a checklist
with holes in it and the gate would refuse the sample afterwards.

**THE COLLECTOR CANNOT BE THE APPROVER.** `lead-verifier.ts`: a Sales Manager
does not fill in her own lead's Qualification (`qualificationCollectorRefusal`,
on the web actions and the handset handler); the owner cannot approve it or
validate its GST; and a Sales Manager seated on a different lead is not its
reviewer merely because her level carries `lead.verify`
(`requireQualificationApprover`). A lead a Sales Manager raised herself therefore
needs a Salesman named as its owner: after her verification the next action is
"Assign a Salesman to complete the qualification", owed by her. The review goes
to `sales_manager_id` first (the lead-manager seat is the fall-through for a
lead raised before every lead carried one).

**THE SALESMAN'S FORM IS ON THE HANDSET** (`qualification-form.tsx`), which is
where he works — he has no web screen. It is a separate APK release; until it
ships, a handset on the old screen draws the new conditions as bare ticks the
server will not accept as answers. The engine copies are byte-identical as
always (`mbos-wire.test.ts`).

**THE ORG CHART DECIDES WHO VERIFIES, AND THE NAMED-PERSON SETTINGS ARE ONLY THE
FALLBACK.** Whoever MAKES a request (presses Request, or Convert to Prospect) is
the starting point, and the nearest eligible person above them on the Org Chart
verifies it — never whoever owns the lead. `orgChartVerifierFor` in
`services/org-verifier-resolver.ts` is the one resolver; the routing of the
request (`preparePromotion`), the act of verifying (`orgDesignatedGate`, which
the console, the Sales Manager pipeline and the handset all pass through) and the
Qualification review all ask it, so a screen cannot offer a call the permission
check then refuses. **The review has ONE reviewer**, `designatedQualificationApprover`
(`services/qualification-approver.ts`): the Org Chart above whoever collected the
answers, then the self-raised setting, the Sales Manager seat and the lead-manager
seat. The hand-off (`settleQualificationState`, first submit and resubmit), the
action (`requireQualificationApprover`, which lets that person in without
`lead.verify`), the verdict, GST validation and the screens all read it. They used
to read the chart in one place and the seats in another, and where the two named
different people each was refused and the lead could not be reviewed at all.
The walk is `engines/org-verifier-chain` and is unchanged: it skips a leaver,
someone with no account, an inactive one, one who cannot verify, and never names
the requester.

**EVERY DOOR THAT MAKES A PROSPECT HANDS IT TO ITS VERIFIER.** Who verifies is
`resolveProspectVerifier` (`services/prospect-verifier-route.ts`), the chain that
used to live inside `preparePromotion`. The Calling desk asks it before converting,
and `applyLeadStageMove` asks it for any other move into Prospect (the record's
stage button, the board, a bulk move, the handset): the next action becomes the
verification call owed to that person, and they are told. Skipped where the move
is already routed or the lead already verified. Where nobody can be named the move
is NOT refused (a handset move would become a rejection); the lead's history says
why nobody was told.

**The requester is never the verifier or the reviewer**, whatever else they hold.
Where the chart names someone else, only that person (or the one the request was
addressed to, or an administrator) may verify. When the chart CANNOT answer — the
requester is not linked to an employee in HRMS, or nobody above them can verify —
the older rules answer as a fallback (`leads.telecallerVerifierEmail`,
`leads.selfRaisedVerifierEmail`, the seats), still minus the requester; if the
fallback would be the requester the conversion is REFUSED in words saying what to
fix (link them in HRMS, or name another verifier in Settings). A fallback is
VISIBLE: a `verifier_fallback` timeline entry and a note on the lead's next
action say why the chart could not answer, so who still needs linking in HRMS can
be read off the book. `leads.fieldVerifierByOrgChart` is RETIRED (the chart is
always tried first) and `orgModeOn()` answers false so the older seat passes
behave as they did while it was off.

**A LEAD THE SALES MANAGER RAISED HERSELF IS APPROVED BY SOMEBODY ELSE, AND SHE
COLLECTS ITS ANSWERS — a refinement of the paragraph above, which made a
Salesman the only collector.** A lead is SELF-RAISED where she holds the seat
(`sales_manager_id`) and she owns it or nobody does (`isSelfRaised`; there is no
creator column, and the seats are exactly the state in which she would
otherwise approve her own work). Where `leads.selfRaisedVerifierEmail` names an
active account, that person verifies the Prospect, validates the GST number and
reviews the Qualification, and the seat holder does none of the three — whatever
else she holds. She fills the eight questions herself, so no Salesman has to be
found for a lead nobody else touches.

The designated person is a SETTING by work email and not a name in code, and it
is OFF by default: blank, a typo, a deactivated account, or the Sales Manager
herself all designate nobody, and every lead behaves as it did before.

They can only act on a lead they can see, so they are seated on it as its
coordinating seat (`lead_manager_id`) — at capture (`captureLead`), and for
leads that already exist by `ensureSelfRaisedVerifierSeats`, nightly and by hand
(`npm run jobs -- self-raised-verifier-seats`). It is a fill, not a decision: it
leaves a seat somebody chose (`lead_manager_decided_at`), a Salesman's lead, and
any lead past Qualification alone. `approvalRoute` in `lead-verifier.ts` is the
one place the rule is decided: the designated person always may; the seat
holder may not on a self-raised lead; everybody else is judged by the capability
and the seat exactly as before.

**A LEAD A TELECALLER WORKS IS VERIFIED BY ITS OWN DESIGNATED PERSON, and it is a
different setting from the one above on purpose.** Where
`leads.telecallerVerifierEmail` names an active account who holds `lead.verify`,
converting such a lead to Prospect sends the verification to them with nothing
for the Telecaller to choose — no picker, no Assign Lead Manager step
(`telecallerRouteFor`, asked in `preparePromotion` right after the self-raised
approver). It is STRICT: it wins over an org-chart-derived Sales Manager seat and
needs no regional coverage.

**WHAT MAKES A LEAD A TELECALLER'S IS ITS OWNER AND WHAT A PERSON DECIDED, never
`sales_manager_id` being empty.** `recomputeSalesManagers` fills that seat nightly
for any lead whose owner is on the org chart, so a filled seat says nothing about
whether a Sales Manager is involved; `sales_manager_decided_at` does, because
only a Sales Manager raising a lead and `assignSalesManager` write it
(`isTelecallerHandled`). A lead is a Telecaller's when its owner is nobody or a
Calling-desk worker — holds the CRM and the desk, no `field` grant, no
`lead.verify`, no explicit `crm.sales-manager` row (`ownerWorksTheDesk`; the desk
alone proves nothing, an administrator and a whole-CRM grant with no rows both
"hold" it) — and neither `sales_manager_decided_at` nor `lead_manager_decided_at`
is set. That keeps the other two workflows out by their own marks: a Sales
Manager's lead (self-raised, or one she set the seat on) and a salesman's lead
(a `field` owner) are never read as a Telecaller's, and keep the routing they had.

Blank, the rule is OFF and everything is as before. Set but unusable — no active
account, somebody who cannot verify, or the person converting — it REFUSES in
words and the lead stays a Suspect, because quietly routing it elsewhere would
defeat the one thing the setting says. No person is named in code.

**A SAMPLE IS ASKED FOR ONLY WHEN THE LEAD MAY ENTER SAMPLE / TRIAL.**
`sampleEligibility` asks the ordinary gate (no override) inside `requestSample` and
the handset's sample handover, before any row is written, for funnel-ladder leads
below the Sample / Trial rung. That reverses "Answer 05" (a sample on a Suspect is
marked, not refused) for those leads only; legacy leads and distributors are
unchanged, and the manager's approval (`sample.approve`) is still required.

**A THIRD-PARTY SALE NEEDS A DISTRIBUTOR WHETHER OR NOT THE MARK IS SET.** The gate
reads `lead_sales_type = 'third_party'` as well as `customers.third_party`.
The Telecaller names one through `nameLeadDistributor` — add-only, at Qualification,
on a third-party lead, `lead.work` — and NOT through `customer.classify`, which
also converts and reverts the mark and edits or removes arrangements.
`checkDistributors` (in `distributor-service.ts`) is the one definition of who may
be named.

**THE PERSON WHO CAPTURES A LEAD OWNS IT, where they work leads.** A Telecaller who
holds the Calling desk owns what they capture; a manager or a person without the
desk leaves it unassigned (and the desk assigners are told), an explicit `null` is
respected, and the bulk importer keeps its explicit owner. Who RAISED a lead is
never stored on `customers`: it is the actor on the append-only `lead_created`
timeline event, so no reassignment can edit it. There is one reassign,
`assignDeskLead` (and `bulkAssignDeskLeads`), for the record, the list and the
desk: it moves `owner_id`, and a next action that was the OLD owner's follows the
lead while one owed by the Sales Manager stays with the Sales Manager.

**A PROSPECT NOBODY CAN VERIFY IS NOT CREATED.** Verification is owed by a holder
of `lead.verify` (candidates are filtered to it — `users.role = 'manager'` alone
includes an Accounts-only manager), and never falls back to the Telecaller being
verified; with no manager available the conversion is refused and the lead stays a
Suspect.

**THE MANAGERS ABOVE A LEAVER WORK THEIR LEADS, WITHOUT A TRANSFER.** When a
lead's owner has left, the active managers above them on the Org Chart may work
the lead (Bharat's manager Seema, and Pritesh above her). `customers.owner_id`
stays the leaver's until somebody with `lead.assign` moves it. It is a SCOPE arm,
not a permission: the last line of `assertCustomerInScope`, for a lead only,
asking `holdsAuthorityOverOwner` (`services/lead-manager-authority.ts`, over the
pure `engines/manager-authority.ts`). Every capability a caller already demands
is still demanded: reassignment stays `lead.verify` plus the Calling desk, and
Qualification is still collected by the owner and reviewed by the manager, so a
manager acting for a leaver still cannot collect it.

The owner has LEFT when `users.active` is false or `employees.status` is
`inactive`. Never `status_raw` (HRMS deactivation leaves what the sheet said) and
never `sheet_status` (whether the row is still on the tab). The walk starts from
the owner's STORED `users.employee_id` and follows `employee_reporting`. A manager
who has left, has no account or an inactive one is skipped and their own manager
is next; a loop names nobody. Two accounts on one employee cannot exist
(`users_employee_key`), and the engine stops the walk there if one ever did. The
manager must also hold the CRM Leads module; the Calling desk is not needed.

It changes no list, Calling desk, handset book, target or personal assignment
list: a leaver's lead does not land in a manager's queue. The actual person is
always the audit actor. Where authority was the only claim, "acting on behalf of
<owner>" is on the lead's record (`ActingOnBehalfBar`), in Reverse Lost and Mark
as Dead (`actingForLead`), and in `afterState.actingFor` and the timeline of both.
A reopen's next action goes to the door's named owner, or to the person reversing
where that owner has left. A Dead request is routed from the REQUESTER up the
chart, so Seema's goes to Pritesh. Phase 2, not built: lead lists for a non-admin
ancestor who holds no seat.

**ONE LEAD EDIT, A MODAL, WHEREVER THE LEAD IS OPEN.** `components/leads/record/lead-edit-dialog.tsx`
is mounted on the unified record (CRM and Sales Dashboard, under More actions),
the pipeline record and the Sales Manager desk. Anybody holding `lead.work` with
the lead in scope may correct its name, city, contact, phone and product; the
owner and sales-manager boxes appear, and are accepted by `editLeadBasics`, only
inside the CRM Sales Manager workspace with its module (`maySetSeats`) —
everywhere else moving a lead stays Reassign's. `loadLeadEditForm` reads the
form under the same rule the save asks. The old `/crm/leads/sales-manager/[id]/edit`
page is only a redirect back to the record. Before this the edit was that page
alone, so a lead's own salesman or telecaller could not fix a misspelt shop
name, and the pipeline's Edit button linked back to the record it was on.
