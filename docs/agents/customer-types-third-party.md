# Third-party customers, distributors, account types, adding customers

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A THIRD-PARTY CUSTOMER is a shop we deliver to and do not bill.** A
distributor buys from us, is invoiced, and sells the goods on; the shop is
where the drums actually go. Most of what this CRM called a lead is one of
these, and a lead with no orders is a prospect — so the largest single category
of work on the calling list was ringing shops for a first order they are in no
position to give. `customers.third_party` is the mark, and it is deliberately
NOT a third value of `kind`: `kind` is exclusive and this is not, since we may
bill one of these directly and an account we invoiced last month is plainly
still a shop we deliver to. What the mark means is narrow — a marked account is
never PROSPECTED, and that is all. Its own orders, its debts and a promise
somebody made all still reach the Call Log, so a shop that starts buying
directly comes back without anybody remembering to lift the mark.

**And it names WHO BILLS IT, in the same transaction.** A mark that could not
say who the distributor is took a record off the calling list and left nobody
to ask about it. `customer_distributors` is that answer, one row per shop per
distributor, and `convertToThirdParty` writes the mark and at least one link
together — a converted shop with nobody billing it is not a state that exists.
It is a LIST rather than a column, because a shop on a territory boundary is
served by two distributors and storing one of them would make the other
unrecordable, which is wrong for exactly the accounts that most need it
recorded. `is_primary` is who serves it usually, at most one, kept true by a
partial unique index rather than by a rule in a service the next writer will
not know about.

**Only a LEAD is converted, and anything may stop being one.** A direct
customer is an account we invoice, so saying it does not bill with us is a
contradiction — the option is absent from its row menu and its record, and
`convertToThirdParty` refuses it rather than trusting the menu. The other
direction is offered on anything carrying the mark: a shop that starts buying
from us is a good day, and undoing must never be harder than doing. Reverting
KEEPS the links — who used to bill this shop is a fact about it, and deleting
them would destroy the only record of how it was served. Reverting is also the
nearest thing MahekOne has to "converting a customer back to a lead" — nothing
does that literally, because a lead's entire definition is an account that has
never ordered, and a real customer's order history would make the label false
the moment it was applied.

**"CONVERT TO CUSTOMER" ON THE HANDSET IS REFUSED, and that is a reversal.**
It promoted a lead to `kind = 'customer'` on one tap — a Suspect included, no
§28 gate — cleared `third_party` and moved the sales seat to whoever pressed it.
It also could not work: the handset created a customer under its own id and
the office promoted the LEAD's row instead, so every order taken against the
phone's copy was refused as "not on MahekOne". A lead becomes a customer at its
second order (`promotesToCustomerAt`) and an order can be taken against a lead,
so `handleCustomerCreate` refuses a `fromLeadId` in words that say so, and
`convertedCustomerId` on a lead update converts nothing.

**`customer.classify` is held by managers AND by accounts.** Manager-only from
the day it shipped, on the reasoning that marking a shop decides who gets
CALLED, which is a manager's team's work — and that reasoning did not go away,
it stopped being the whole reasoning. A converted shop is also who bills it,
which is exactly the kind of account fact accounts already maintain when they
change a customer's account manager, so the capability sits in
`ACCOUNTS_OR_MANAGER` now, added rather than moved for the same reason
`target.set` was: a manager coaching a telecaller through which shops are
worth marking still needs to act on it directly. It reaches the Accounts
customer list for free — `canClassify` was already threaded through the
shared `CustomersScreen` component both apps render, so widening the
capability is the whole change.

**A distributor is an unmarked DIRECT CUSTOMER.** Somebody has to be holding
the invoice at the end of the chain, and a shop we deliver to is not holding
one; a lead has never ordered and cannot bill anybody. The picker offers only
`kind = 'customer' and not third_party`, and the action checks the same thing,
because a picker is not a permission. The last distributor cannot be removed
from a marked account — the refusal names the way out, which is another
distributor or no longer being a third-party customer.

**The arrangement and the evidence are ONE list, and every row says which it
is.** They were two panels — what somebody recorded, and under a title of its
own every shop `orders.delivery_customer_id` shows goods going to. On a real
distributor that drew four rows beside eighty-six, two counts, one question,
and nothing on the screen saying how they differed; the honest reading was that
the page showed the same list twice. A shop the sheet has seen and nobody has
recorded is not a second subject, it is the unfinished part of the first one —
so it sits in the same list marked "from the order sheet", with the button that
records it, and the list moves into its recorded half as the work is done. That
is what makes it a worklist rather than a report. `recorded` is never inferred
from the order count: a recorded arrangement with no deliveries behind it and
two hundred deliveries nobody has recorded are both real, and both worth
seeing.

**One tap records it, and what that tap DOES depends on what the shop is.** A
lead is converted with this account as its distributor; an account already
marked gains another distributor; an account we invoice ourselves has the
arrangement recorded and is NOT converted, because we bill it and calling it a
shop somebody else bills would be false. The decision is in
`recordDeliveryAddress` rather than on the screen, since it is the same rule
the convert dialog obeys.

**A one-line summary names only what somebody recorded.** "Billed by X" on the
Account card reads as a fact somebody stands behind, so a distributor the sheet
merely shows must not appear in it — the panel underneath is where a row can
say what it is.

**One question, three answers, and `lib/account-types.ts` is where they live.**
Direct customer, Lead, Third-party customer — the mark wins over the kind on a
list, because "Lead · Third party" is two facts fighting over one glance on
four hundred rows. The type filter carries two options that are not types: the
evidence list, and third parties with nobody billing them, which should be
empty and is not on a book converted before distributors were recorded. A row
nobody can account for is worse than one that says why it is there.

**BUT THE CUSTOMER TABLE SHOWS ONLY TWO OF THE THREE.** A lead is an account
that has never ordered, and everything anybody DOES to one — the three ladders,
§28's gates, the qualification call, the capture form, the nurture sequence —
is in Lead Management. Listed here as well, it was the largest single category
on the screen: 3,634 of 5,926 rows on the real book, worked from the one page
that offers none of the controls for working them, and read by two people who
could not see each other's half of it. So the Customers list is Direct customer
and Third-party customer, and `/crm/leads` is where a lead is. Nothing about a
lead's RECORD changed — its page is reachable and still draws every seat — and
`accountTypeLabel` still answers "Lead", because the Sales Dashboard's maps and
the handset's own list legitimately draw one.

**`NOT_A_LEAD_SQL` is the rule, and it is the NEGATION of the filter it
replaced rather than `kind <> 'lead'`.** The mark wins over the kind, so a shop
we deliver to and do not bill is routinely a `lead` by kind — we have never
invoiced it, because its distributor holds the bill. A bare `kind <> 'lead'`
would take those shops off the third-party list, which is the one list they
belong on.

**It lives in `customerFiltersOnly`, which is the one place every reader of
that table passes.** The list, the tiles above it, the book total, both filter
dropdowns and the two bulk actions that act on whatever the filters match.
Enforced in the list alone, "Transfer sales manager" over a filtered book would
have moved three and a half thousand leads nobody had seen on the screen they
pressed it from — which is precisely the thing `customerFilterClause` exists to
prevent, arriving through the door it was built to hold shut.

**The IDS path of those two actions is the exception, and it is a different
question.** `customerFilterClause({})` used to be the scope and nothing else,
which is why a tick-list reached for it — the ids name the records, and the
clause was only ever there so a hand-built request cannot reach past what its
author can see. It is not the scope any more. `customerScopeClause` is, and
both id paths read it: a lead's record page still draws the sales manager seat,
and refusing that write with "Those customers no longer exist." would be a
sentence that is not true about a record somebody is looking at.

**And both filter DROPDOWNS are narrowed with it.** `listCityFilterOptions` and
`listAmFilterOptions` were a pass over the whole scoped book, which was right
while the book and the table were one population. A city that exists only on
leads, or a salesperson whose accounts are all leads, would otherwise be
offered and answer zero rows — the failure both of those functions already had
a paragraph warning about, arriving from a direction neither anticipated.

**ACCOUNTS ADDS A CUSTOMER DIRECTLY, and it is wired everywhere on save.**
The Accounts door of the Customers list has "Add customer"
(`components/customers/add-customer-dialog.tsx`), and `createDirectCustomer`
(`lib/actions/customer-create.ts`) writes an account we INVOICE —
`kind = 'customer'`, never a lead, which stays the CRM's capture form. It is
`customer.reassign`, because naming the seats decides whose book it is in.
`lib/new-customer.ts` is the rule, pure, read by the form and the action: the
name as on the bill (the party sheet matches on it, so the sheet adopts the row
rather than duplicating it), a mobile, the city, the STATE from a fixed list
(the handset's territory matches on it — no state, no handset) and the sales
account manager. The seats are written WITH their name mirrors and
`am_decided_at`, so neither `recomputeSalesPeople` nor the party
projection restates them; the contact goes through `reconcileContacts` and the
place through `placeShopsNow`. A number or GSTIN already on the book is
refused; the same name asks once. `customer-create.test.ts` pins it, including
that the shop is in the salesman's `customerIdsInScope`.

**ACCOUNTS CAN CONVERT A LEAD STRAIGHT TO A CUSTOMER — the bypass.** Accounts
› Customers › Convert a lead (`components/customers/bypass-convert-dialog.tsx`,
`lib/actions/lead-bypass.ts`, rules in `lib/lead-bypass.ts`, pure) finds an
open lead, asks everything an invoiced account needs — bill name, contact
person, mobile, type of business, a GSTIN whose state code matches the state
(or "not registered" with a reason), billing address, city, state, sales
account manager, credit days, price list, freight, delivery — then a coded
reason (`leads.bypassReasons`), a note and CONVERT typed back. It is
`customer.reassign` (the Accounts manager and the platform admin) and only from
the Accounts app (`customerEditRefusal`). One transaction writes the same
columns the second-order rule does (`conversionColumns`: kind `customer`, stage
`won`, `customer_since`, `lead_converted_at`) plus the details, the seats with
`am_decided_at`, `third_party` cleared (distributor links kept), a
`lead_stage_transitions` row of kind `overridden` naming every skipped rung
(`stage:<rung>`), a `customer.bypassConvert` audit row, and `recordConversion`
(audit, timeline, handset tombstone). So the account leaves every lead list and
handset Leads tab and joins Customers, the Call Log and collections at once.

**THE CUSTOMER CODE IS GENERATED, AND IT IS NOT `external_code`.**
`customers.customer_code` ("CUS-00001", `0294`) is set by a database
sequence on every insert, whatever path writes the row, and is shown read-only
on both forms. `external_code` is the order sheet's key for the party
(`SHEET:<NAME>`, matched by the projection on every pass) and is no longer on
any screen — retyping it cut the shop off from its orders. The forms pick the
place State → District → City → Area on the reviewed tree
(`components/customers/customer-place-picker.tsx`, rules in
`lib/customer-place.ts`, area optional); a district, city or area that is not
listed is added on save, and the pick is stamped `place_source = 'manual'` with
`place_decided_at`, so the nightly typed-place pass never moves it. The price
list is picked from the published lists in force (`priceListNames`), counter
types from the ERP's Counter type list, and the grade is shown, not typed.
Dealer code, rating, party segment, allocate email, tagged employee, do not
contact, beat, territory region and route are off the forms; their columns stay.

**There is no "Add lead" on the Customers screen.** It hard-coded `kind:
"lead"`, so on a table that no longer lists leads it wrote a record and
returned the reader to a list the record was not on, which reads as a save that
failed. `/crm/leads/intake` is the capture form, beside the rest of the work on
a lead.

**And a name is given a ceiling on that table.** `customers.name` holds
whatever the sheet typed, and several hundred of them are whole postal
addresses offered as a shop. A `Td` holds its line rather than wrapping — the
primitive documents why — so an automatic table layout sized the Customer
column for its worst row, and one address pushed Contact person, Phone, Type
and the three seats off the right-hand edge for every row on the page. The
ceiling is on a block INSIDE the cell, because `max-width` on a `td` is
advisory under automatic layout; the full name rides on `title`, and the badges
carry `shrink-0` so a slow-payer flag is never what the ellipsis eats.
