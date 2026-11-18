# Top and focus customers

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**TOP CUSTOMERS ARE RANKED ACROSS THE COMPANY, then narrowed to the viewer.**
It is the second tab of Monthly targets (`?view=top`), on both the CRM and
the Accounts doors. The report is GENERATED on the 1st at 10:00 IST, for 3, 6
and 12 whole calendar months ending with the month just finished, and stored
in `top_customer_reports`. It is generated rather than read live so a sheet
reconcile editing an old order cannot move a figure somebody read out in a
review. It is a snapshot, not a cache. Three callers share one idempotent
generator: the `monthly` cron line, the hourly pass as a net under it, and the
screen itself. Every customer who bought in the window is stored, so ranking by
sales or by order count, and the `topCustomers.count` length (60), are decided
when it is read. The table shows sales and SALES BILLS each averaged per month,
so the three spans read on one scale; order counts stay in the report for
ranking by number of orders and for the strip above the table. Bills are counted from the
bills ledger beside the orders, not inferred from them: an order not yet billed
and a bill the Payment Status tab raised are both ordinary. So is who sees which row: `scopedToUsers`, the same narrowing
the Customers list uses. An admin sees all sixty. A telecaller, back office
included, sees the ones in their own book with their company rank. The other
way round, the top sixty of a telecaller's own book, would put a small account
on a list called Top customers.

**FOCUS CUSTOMERS ARE A SHARED LIST, read through the Top customers report.**
The third tab of Monthly targets (`?view=focus`) lists the customers somebody
has said need attention to grow into top customers. Any customer in the reader's
book can be added, a new account as readily as one just outside the sixty.
`focus_customers` holds one row per customer, not a list per person, so a
salesperson and a back office telecaller on one account see one entry. Who sees
an entry is the customer's scope. Taking one off is the person who added it, or
a manager. Every figure on the tab (rank, monthly sales, the gap to the cutoff)
is looked up in the same stored report the Top customers tab draws, through
`currentTopCustomerReport`, so the two tabs cannot disagree about one shop.
