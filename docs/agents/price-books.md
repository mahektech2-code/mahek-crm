# Price books

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A BOOK IS A LINEAGE, AND A CHANGE IS A DRAFT VERSION OF IT.** The Price
Desk used to change a live price by making a new version, retiring the old one
and copying who it covered across. A book is now one audience's prices read as
one thing: `price_lists.book_id` is the lineage's first version, kept by the
`price_lists_book_id` trigger on every insert and every change of
`supersedes_id`, so no write path has to remember it. A CHANGE
(`price_changes`) is a draft version of the book's newest published revision,
wrapped in Edit → Check → Approve → Live. Approving publishes that draft
through `publishDraftIn` (`services/price-write.ts`, the same code the list
screens' Publish runs) inside the approval's own transaction, dated to the
go-live day: the revision before it is dated out to the day before and goes
on pricing until then. Nothing new prices a shop — the resolver is untouched.

**THE OLD SCREENS STAY, AND THEY CANNOT GO ROUND A CHANGE.** Lists, Documents,
Requests, Coverage and Variance work as they did. A draft that is a change's
draft is refused by `publishPriceList` and by the draft delete
(`removeDraftList`), because the change carries who made it, what was checked
and who approved it. One open change per book is a partial unique index.

**A CHECK IS TIED TO THE RATES IT READ.** `ratesHash` of the draft is stored
with the check; any edit clears it, and `submitRefusal`/`approvalRefusal`
compare it again, so what was checked is what is approved. Blocking flags (a
₹0 price, a past go-live date) must be fixed; every other flag must be fixed
or acknowledged with a note the approver reads. The rules are pure, in
`engines/price-change.ts`, and the step bar draws the same answers.

**MAKER-CHECKER IS A SETTING, AND TWO APPROVERS ARE NOT.**
`pricing.changes.makerChecker` stops a change's maker approving it — in the
action, not the database, because a desk of one may switch it off. A change
above `pricing.changes.secondApproverAbovePaise` a month (at the book's shops'
own volume) or cutting any price by more than
`pricing.changes.secondApproverDropPercent` needs two approvers, and the
database refuses the same person in both seats. Taking a change over makes
you its maker, said in its log.

**WHO A BOOK COVERS IS THE BOOK'S.** A scope is edited on the revision in
force (with the ordinary scope actions and their impact report), and
`propagateBookCoverage` carries the set onto the scheduled revision and the
open change's draft, so next week's revision does not quietly revert today's
scope.

**AI ADVISES; CODE COMPUTES; A PERSON DECIDES.** `price-ai/providers.ts` asks
OpenAI and Anthropic (`anthropic.apiKey`, a plain POST with a forced tool
answer — no SDK) and records every run in `price_ai_runs`. Describe the
change: a model (or `parseSimpleInstruction`, with no model, for plain
sentences) produces an `InstructionRule`; `applyInstruction` computes every
price, and `applyInstructionRule` recomputes them on the server from the draft
as it then stands. Review: both models get the same evidence and never see
each other's answer; findings are flags keyed on provider, topic and product
(not wording, so a note survives a re-check), shown side by side and never
averaged. A model that cannot answer is `{ ok: false, reason }`, said on the
screen.

**TODAY, WATCH AND IMPORT READ THE SAME LINES.** `varianceRowsForRange` is the
one reader of order lines against the price in force on their own date;
`varianceReport(month)` and `varianceForRange` (Today's week) keep their
2,000-line cap and Watch reads up to 20,000. The morning check
(`price-books-morning`, nightly) writes `price_book_findings`, idempotently,
never re-raising one dismissed that day. A PDF that matches a book
(`engines/price-book-match.ts`) can become a CHANGE on it instead of a new list
(`documentToChange`); cancelling that change hands the document back. A cell
two models and the text layer disagree on holds "Approve all ready".

**A SHOP IS ON ONE PRICE LIST, AND A LIST CAN LEAVE SHOPS OUT.**
`price_list_scopes.excluded` (`0303`) is a leave-out row — a shop, a
salesman, a beat, an area, a city or a district (a check constraint) — and
`leftOutLists` drops its list for the shops it names before narrowest-wins
runs; it never puts anybody on a list. `engines/price-one-list.ts` is the
rule: books are counted by `book_id`, Standard ("everybody" rows) and agreed
prices do not count, ended rules and lists do not count, scheduled ones do,
and `freightAgrees` keeps a Paid and a To Pay list apart except for a shop with
no freight term. `pricing.oneListPerShop` (on) refuses only an edit that ADDS
a second list (`introducedClashes`, before against after, inside
`publishDraftIn`, `addScope`, `updateScope` and `removeScope`), so shops
doubled before the rule keep pricing and are listed on Coverage, where
`settleAllToTodaysList` leaves each on the list that prices it today. An
answer is "keep" (a leave-out row on this list) or "move"
(`leaveShopOutOfBook` on the other book's every live, scheduled and draft
version); a draft holds its moves in `price_lists.pending_moves` until it is
published. `assignCustomerList` takes the shop off every other book.
