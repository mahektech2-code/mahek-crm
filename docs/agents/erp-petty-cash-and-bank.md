# Petty Cash and bank statement management

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**ITS SCREENS ARE ITS OWN, DRAWN AS THE MOCKUPS (docs/erp/money-flow).**
`app/erp/expenses/page.tsx` routes each tab: the lists, the four statements,
an advance's page (`?adv=`) and the bank statement are `screens.tsx`; the
dialogs (`?dlg=expense|petty|receipt|transfer|advance|bills`, which "+ New"
links to) are `money-dialogs.tsx` on `money-ui.tsx`'s pieces (account letter,
Paid-from cards saying balance before → after, three-bar steps); a row opens
its record in a drawer (`?open=`, `money-client.tsx`). Reports, Audit trail,
Accounts and Old records stay the generic `ListScreen` (`bare`). The reads
are `lib/erp/money-views.ts`, the writes `lib/actions/erp-money.ts` — both
over `lib/erp/money.ts`, so a rule is still checked once. A receipt's "apply
to open invoices" is SHOWN against the CRM's bills and stored as text on the
receipt; it writes nothing to the CRM ledger.

**ONE MODULE, FOUR SUB-MODULES, TABS UNDER EACH — and it replaced the old
"Petty Cash/Bank" (Oct 2026).** The ERP's `expenses` screen (so `erp.expenses`
is the grant it always was) is Overview, Expenses, Receipts and Cash & Bank
across the top, drawn from `ErpView.section` in the registry: `screenTabs`
returns `sections`, `SectionTabs` draws them, and a section is a way of
drawing tabs, never a module. The old per-employee funds
given and expenses (`erp_credits`, `erp_expenses`) are written by nothing and
read by the Old records tab.

**FOUR TABS, A SWITCH INSIDE, AND "MORE" (Nov 2026).** The team found the
two levels of tabs (four sections × up to six tabs) and the busy forms
frightening. The page now draws Home · Paid · Received · Moved (+ To approve
for the accountant), and inside a tab a small switch (`SegSwitch`): Paid is
Expenses · Petty cash · Advances, Received is All · Not in bank yet.
Statements, Accounts, Reports, Audit trail, All expenses, Cancelled and Old
records are under `MoreTabs`. The registry's views and their `section`s are
unchanged, so no grant moved: `GROUPS`/`MORE` in `app/erp/expenses/page.tsx`
only decide drawing. A list's header button adds what that list holds
(`ADD`); Home shows the five kinds as buttons, then only what is waiting.
Keep it this quiet: no sentences under buttons or in form footers, no
placeholders that say "Optional", a note behind "+ Note". The forms are one
page each, amount first: no Review step, one date, and a bank's mode and UTR
only when a bank is chosen. Move money is From and To over every account; its
mode follows the two kinds exactly as the old four "types" did (bank→bank
NEFT, bank→cash Cheque, otherwise Cash).

**BALANCES ARE THE ACCOUNTANT'S, NEVER THE TEAM'S.** `seesBalances` in
`lib/erp/money.ts` (the `approveMoney` power or an ERP administrator) decides
every place an account's balance could show: Home's account cards, the
"In bank?" column and the vendor/account filters on the lists, the Statements, Accounts, Reports and Audit trail pages
(`BALANCE_VIEWS` — not even reachable by URL without it), the Paid-from cards
(which then say "bank account", "petty cash box", "office cash"), the
Receive/Move money footers, the drawer's "balance after", the ERP dashboard's
Petty Cash tiles, and a save's message (`runSave` cuts it at the first " · ").
Without it the page sends the accounts with balance 0, so nothing reaches the
browser either.

**ONE MOVEMENT OF MONEY IS ONE ROW, POSTED ONCE.** `erp_money_txns`, numbered
from the `moneyTxn` series (`TXN-26-00423`), takes its amount off
`from_account_id` and puts it on `to_account_id`; every balance is the
account's opening plus those legs, read and never stored (`engines/money.ts`,
pure; `lib/erp/money.ts`, the writes; `screens/money.ts`, the tabs). Check
constraints hold the shape of each kind. **An expense is entered when it is
PAID** — there is no unpaid or pending state, by Mahek's instruction: the
form names the account it left. A transfer (bank ↔ cash, bank ↔ bank) is never
income or expense. A cancelled row counts nowhere and nothing is deleted;
cancelling is refused while a bank line is matched to it or cash from it was
paid onward.

**CASH IS TRACED.** Petty cash paid from a customer's cash or from a
withdrawal is Cash in Hand with `source_txn_id` naming the receipt or the
transfer, locked and refused beyond what is left of it; a deposit may name the
receipt too, so a cash receipt says where its cash went.

**AN ADVANCE IS NOT AN EXPENSE.** `erp_advances`: giving one is a row of kind
`advance` out of an account; the employee's bills are expenses with
`advance_id` and no account (they move nothing a second time); settling,
once every bill is decided, is one `advance_return` into an account or one
`advance_topup` out of it (`advancePosition`). One open advance per employee.

**REVIEW NEVER BLOCKS THE PAYMENT.** Petty cash and advance bills always go
to the accountant; an office expense above `erp.money.approvalAbovePaise`.
The `approveMoney` power reviews, settles, cancels anything, sets up accounts
and works the bank statement; nobody approves what they entered, unless an
ERP administrator.

**A BANK LINE IS MATCHED, NEVER RE-ENTERED.** `erp_bank_lines` (deduplicated
on `line_key`) are imported — from the bank's PDF on Accounts → Bank statement
management (below), or the old CSV path (`parseBankStatement`), which no screen
offers now — and explained by `erp_bank_matches`; a line naming a transaction's reference is
matched as it lands, a split must add up exactly (`splitRefusal`), and
"Create transaction from this line" is refused while anything already on the
books may be that line. **A scrap buyer's receipt writes its money row in its
own transaction** (`recordScrapMoney`), so the balances include it, and
voiding it cancels the row.

**PETTY CASH STATEMENTS ARE OURS; THE BANK'S STATEMENT IS ACCOUNTS'.** Cash &
Bank's account tabs are one tab, **Petty Cash statements** — what MahekOne
recorded going in and out of each account — and on a bank account each row
says **✓ Bank** once a bank line is matched to it. Its "Bank statement" tab is
gone from the registry (the `bankLines` module stays, unreached); the bank's own
record lives in Accounts.

## The accounts deadline

**ANYTHING WAITING ON THE LEDGER DESK PAST `accountsSla.hours` WORKING HOURS IS
REPORTED, AND STAYS THE DESK'S.** Orders to approve, payments to confirm
(holds only with `accountsSla.includeHeldPayments`), credit notes and order
changes. `lib/engines/accounts-sla.ts` is the clock, pure: `working_days`
counts every hour of a working day (Saturday 4 pm is due Monday 4 pm),
`office_hours` only the shift; days off and company holidays count nothing.
`sweepAccountsSla` (hourly as `accounts-sla`, and at most once a minute from
the Accounts layout) writes one `accounts_sla_breaches` row per item (0342),
resolves it the moment the record leaves its queue, and tells — each claimed
by a conditional update so nobody is told twice — every platform and HQ
administrator plus the desk at the deadline, then the admins again every
`accountsSla.escalateEveryHours` with the desk's latest reason. Nothing is
reassigned: admins are informed, accounts decide.

**THE DESK OWES A REASON.** `app/accounts/deadline-gate.tsx` opens on every
Accounts screen a dialog that closes only on a reason (10+ characters) per
item and a reminder (1 hour, tomorrow, 2 days, or a time within 7 days);
it asks again when the reminder comes round. It does not open on the four
work screens — a bar offers it there — so "Open and decide" is never blocked.
A reason is shared by the desk; `accounts_sla_remarks` is append-only and
`remarkProblem` is checked in the dialog and in `explainAccountsDelays`.
Command Centre → Accounts deadlines (`founder.accounts-deadlines`) is the
founder's view, also on Needs you; Mark seen and Nudge accounts never move it.

## Bank statement management (Accounts)

**THE BANK'S PDF, READ BY AI, CHECKED, AND EVERY LINE EXPLAINED ONCE.** Its own
sidebar group with three modules: `accounts.bank-statements` (Bank accounts &
uploads — the cards, upload, check and import), `accounts.bank-reconcile`
(Reconcile) and `accounts.bank-uploads` (Upload history). A statement is
uploaded as often as anybody likes (`/api/accounts/bank-statements/upload`, a
route because a PDF is past an action's 1 MB) and read AFTER the answer
(`after()`): `services/bank-statement-reader.ts` sends it to OpenAI
(`bankStatements.model`) into `bank_statement_uploads.rows`.

**ENCRYPTED IS NOT LOCKED, AND A LONG STATEMENT IS READ IN PIECES.** Most banks
encrypt every statement with an OWNER password only — it opens in any viewer —
so `lib/bank-statement-pdf.ts` always opens it WITHOUT a password first and asks
for one only when pdf.js refuses (`StatementLocked`); a password typed for a PDF
that needs none is not used. A password is used once, never stored. The PDF is
then cut into pieces of `PAGES_PER_CALL` (4) pages, read four at a time and
joined in page order, because fifty pages in one call is longer than a model
answers and longer than any timeout: an unencrypted PDF goes as the file (each
piece re-saved by pdf-lib), an encrypted one as its text laid out by position
so the columns still line up (`layoutText`). Progress is `step = "reading
3/10"`, drawn as pages read. The page count has no limit; the file size is
`bankStatements.maxPdfMb` (20, at most 30 — the server takes 32 MB in one
request), checked in the browser and again on the server. The model only reads. Everything after is pure
in `engines/bank-statements.ts`: the BALANCE CHECK (opening + credits − debits
= closing, and every running balance follows; a break names its line), the
order (newest-first statements are put oldest first), ALREADY IN (a line the
account holds — same date, amount and balance — is skipped, so three downloads
a day never double a line; `pdfLineKey` keys it), SUGGESTIONS and FLAGS.

**A person checks before anything is imported**, correcting any cell, and
imports only the new lines into `erp_bank_lines` — the ONE store, which Petty
Cash ticks from. `erp_bank_matches` now points at exactly one of a Petty Cash
transaction, a `payment_receipts` row or a `vendor_payouts` row (a check
constraint), each receipt or payout at most once live (partial unique
indexes), and records `via` (suggestion or hand).

**A SUGGESTION NEVER MOVES MONEY.** `refreshSuggestions` stores the one strong
candidate per line (a reported receipt's UTR and amount, an open bill of a
customer named in the narration, a payout to the vendor named, a Petty Cash
entry, our own transfer seen on the other account, a bank charge) and the flag
(balance breaks, AI unsure, cheque returned, same UTR twice, less than
reported, customer on hold, large and unexplained). Confirming is the
existing writer: `confirmReceipt`, `recordReceipt` (settled against the bill,
or oldest first), the payout marked paid with the bank's reference, Petty
Cash's `saveExpense`/`saveTransfer`/`saveReceipt` for charges, transfers and
other money. Uploading, importing, fixing a figure and setting a line aside are
`payment.record`; matching, marking, reversing a returned cheque and confirming
a short payment move money and are `payment.confirm`. Undoing a match leaves
the record it confirmed or created, and says where to reverse it.

**THE PDF IS KEPT `bankStatements.pdfRetentionDays` (7) AND THEN DELETED** by
the hourly `bank-statement-pdfs` step (`fileStorage.remove`, `file_ref` null,
`pdf_deleted_at` set); the upload row, its lines and every match stay, and the
screens say "Deleted 21 Oct" rather than offering a link that 410s. A reading
that never finished is failed after ninety minutes. The rest of its settings
are `bankStatements.*` on the Accounts settings page.
