# Ledger, outstanding, statements, cash flow, vendor payouts

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**The ledger is cut by financial year, not paged from the top.** Ten thousand
bills across three years is not a list anybody scrolls, and Mahek's own bill
numbers already carry the year — MMI/26-27/1119. The current year is the
default, the server filters to it, and the table pages within it. Paging is
over what is filtered IN, so the totals row, the aging strip and the export all
describe the whole year while only the table is cut into pages — a page that
changed the totals under it would show a different figure on every click.

**A YEAR IS EITHER WAY OF COUNTING, AND THE CURRENT FINANCIAL YEAR IS THE
DEFAULT.** `lib/year-period.ts` is the one rule: "26-27" is a financial year
(1 April – 31 March, the shape `?fy=` links already carried) and "2026" a
calendar year, so one value carries both and an old link keeps opening the
year it named. `components/ui/year-filter.tsx` is the one picker — the kind,
then the year, with the dates it covers beside it — on Accounts → Bills, CRM →
Sales bills, Accounts → Customer account and the CRM record's Ledger tab.
Outstanding is deliberately NOT year-cut (the oldest debt is usually last
year's), and holidays and leave count in calendar years by nature.

**A CUSTOMER'S STATEMENT IS ONE COMPONENT IN TWO APPS.**
`components/ledger/customer-statement.tsx` draws the period bar, the opening
balance + billed − received = closing balance sum and the statement table;
Accounts → Customer account renders it with its export, By bill view and
Reverse, and the CRM customer record's Ledger tab renders it compact and
read-only through `/api/customer-statement`. Both read
`customerStatement` (`services/customer-statement-service.ts`), so a
telecaller and the ledger desk quote one customer one balance.

**"Who owes us" is a different question to "what did we bill", and it has its
own screen.** The ledger is a list of bills; Outstanding is a list of CUSTOMERS,
one row each, with what they owe and the bills behind it opening on the same
row. Both questions are always asked together — how much, then against what —
and answering the second on another screen is what makes somebody give up half
way through a chase. It is deliberately NOT cut by financial year: the oldest
debt on an account is usually last year's, and that is the first row anybody
works. `lib/engines/outstanding.ts` is the grouping, pure like every other
engine, and `listOutstandingByCustomer` reads `listBills` rather than a query of
its own — a screen totalling outstanding from a different read than the ledger
is how two screens come to disagree about one customer.

**It is one screen rendered in two apps, not two screens.** Accounts and the
CRM read the same function through the same scope, so the two can never quote a
customer two different balances; what differs is what surrounds the table —
Accounts links into the customer account, the CRM links into the customer
record and the WhatsApp reminder, which is where a chase actually happens.

**And a bill nobody has spoken for is shown, counted and never added up.** An
`unstated` bill is not debt, so it stays out of the outstanding figure exactly
as `recomputeOutstanding` keeps it out — but it is listed, given its own
column, its own metric and a sentence saying what it is. Hiding it would make a
bill that is open on the ledger and absent here read as a screen that lost it;
adding it would put the whole imported order book on a collections list. Its
balance is drawn as "not stated" rather than as a figure, because rendering an
unknown beside real balances is the original mistake in different clothes.

**CASH FLOW IS ONE SCREEN, THREE TABS.** Accounts → Cash flow
(`accounts.cash-flow`, `?view=` overview | in | out): Overview is projected
inflows against scheduled outflows on one daily axis with the cumulative net;
Receivables is the collections forecast; Payables is the vendor payouts below.
The cumulative line is the net FROM TODAY, never a bank balance — MahekOne holds
none. Overdue items on either side are their own figure and are never folded
into today. The screen speaks finance (inflows, outflows, receivables,
payables, days to pay) and keeps explanations behind an `InfoTip`, not on the
page.

**A RECEIVABLE IS PROJECTED FROM HOW THE CUSTOMER PAYS, NOT FROM THE TERM.**
`engines/cash-flow.ts`: a customer's average days to pay is the amount-weighted
days from bill date to confirmed money over `payments.cashflowLookbackMonths`,
from real receipts only — `sheet_import`, Adjustment and Credit note are not a
customer paying. Below `payments.cashflowMinPayments` payments the company
average is used and the row says so. A reported or held receipt is expected on
its cheque date (else the day reported) and is SUBTRACTED from its bill's
projection, so the same money is never forecast twice.
`services/cash-flow-service.ts` reads it; it is not scoped, because Accounts
sees every book.

**VENDOR PAYOUTS ARE WHAT WE OWE, AND THE ERP REGISTER IS WHERE A PURCHASE IS
TYPED.** The Payables tab is the one place in
Accounts about money going OUT. A purchase payout is not entered here: the page
runs `syncPurchasePayouts` first, which turns the ERP purchase register into one
payout per supplier per PR number (`purchase_key`), worth the register's own
`purchaseFigures` summed over the rated lots — a lot with no rate is no debt
anybody can put a figure on. While unpaid, the sync rewrites its amount, bill
numbers, PO and due date; a paid one is a record and is never rewritten, and one
whose lots all vanished is cancelled ("No longer in the purchase register") and
reopens if they come back. Anything else owed — an advance against a proforma, a
transporter — is a MANUAL payout, added from a modal. `lib/engines/vendor-payouts.ts`
is the rule, pure.

**Two dates, two questions.** `due_date` is when the money is owed: the purchase
date plus the supplier's `credit_days` (else `payments.vendorDefaultCreditDays`).
`pay_on` is the payment day it is planned for: the first of
`payments.vendorPayoutDays` (Tuesday and Friday, IST) on or after the due date, or
on or after today where the due date has gone. Dragging a card on the calendar
(vendors down, dates across) moves `pay_on` and stamps `pay_on_decided_at`, the
same "a person decided" mark as `am_decided_at`, so the sync never moves it back.
Only a payment day that has not gone accepts a drop — `moveRefusal`, asked by the
calendar and again by `reschedulePayout`. An overdue payout nobody moved STAYS on
its missed day rather than rolling forward to today, because rolling it would hide
that it was missed. **The payment days are Tuesday and Friday** (Mahek's
instruction, October 2026; it shipped as Tuesday to Friday). When the setting
changes, the sync moves every unpaid payout nobody moved by hand that is planned
for a day still to come and no longer a payment day onto the next one that is
(`replannedPayOn`) — `0239` moved the stored setting where nobody had chosen it.

**An invoice is a row, because one order collects several.** A proforma before
the goods, the tax invoice after, a debit note later: `vendor_payout_invoices`,
each with a free-text kind (the usual ones offered as chips, anything typed) and
one file under attachment parent `vendor_payout_invoice`, uploaded through
`/api/accounts/payouts/upload` (a route, not an action — a scanned invoice is
past the 1 MB action body) and readable by whoever holds the screen. Planning,
holding and adding are `payment.record`; marking paid, undoing it and cancelling
are `payment.confirm`, the Accounts manager's, as confirming a receipt is.
