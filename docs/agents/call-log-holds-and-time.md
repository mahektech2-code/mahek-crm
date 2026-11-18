# Queue suppression, Taken Order holds, time rules in JS

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**Suppression is a return value, not a filter.** `buildQueue()` returns held-
back customers alongside the queue, and the screen shows them. A telecaller
must always be able to find out why somebody they expected is missing.

**An import of order history never sets `activeInOrderSystem`.** That flag
means live activity in the external order system, and the queue holds such a
customer back — `queue.excludeActiveInOrderSystem` is on by default. The
projection set it on every row it touched, which muted the whole book the first
time production filled itself: a full database and an empty Call Log, with the
cause living in a column no screen shows. `0021` clears what it wrote.

**What DOES set it is the Taken Order tab, and only through a full reconcile**
— until `erp.orders.live`, after which the ERP's open lines do, through the
same function, rebuilt hourly. That tab is where an order lands first — typed as the customer gives it, hours
or days before it is dispatched, billed, or written to the Order Details tab.
While any line of an order is still open the customer has already ordered, and
the Call Log must stop asking them to; `recomputeOrderSystemHolds()` is the one
thing that writes the flag and it rewrites every customer on every pass. A pass
that only ever SET it is how the book goes quiet for good: nothing would lift a
hold, and an order that shipped in August would still be muting its customer in
March.

**Two cells decide it, and the rule is asymmetric.** `Status` (column L) at
`Ready` AND `Entry status` (column R) at `Done` releases the customer; either
one falling short holds them — a Ready order the office has not finished with
is still open, and four of them are. Everything else holds too, because the
vocabulary is not closed: an unrecognised value must never read as dispatched,
and the cost of holding wrongly is one early call, shown in the held-back strip
with its reason.

**`Cancel` is the exception, and it has to be.** It releases on its own,
whatever the entry status says. Every other status eventually becomes `Ready`;
a cancelled row never changes again, so holding it is a mute with no event left
that could lift it — and the customer behind a cancelled order has not ordered
anything, which makes them exactly who should be rung. Reading it as "unknown,
therefore held" muted 294 rows' worth of customers permanently, which is how
the carve-out was found.

**A hash-driven sync needs a reparse, or a changed rule never lands.** Nothing
was rewritten when `Cancel` changed meaning: not one of those 294 rows differed
by a character, every hash matched, and the customers stayed muted on the
strength of a decision already reversed in the code. `npm run jobs --
taken-order-reparse` re-reads what is stored, touches Google not at all, and is
the command to run whenever the READING of a row changes rather than the row.

**An order is contact, and the check-in dates from the LATER of the two.**
Somebody spoke to the customer to take that order, so an order that arrived
through the sheet counts as much as a logged call. Preferring the call and
falling back to the order only where there was none — which is what `??` did —
rang a customer who ordered on Tuesday to ask how they were getting on, on the
strength of a call three weeks old. Below both sits the record's creation date:
reading that first dates a customer of four years from the afternoon their row
was written, so an imported book sits off the queue for a week. Prospects still
fall back to it, having no order to be dated from.

**A date derived from a timestamp names its zone in JavaScript too.**
`createdAt.toISOString().slice(0, 10)` is a bare `::date` in different clothes —
it answers in UTC, so a row written at 2am IST is dated to the previous day.
`calendarDate()` is the way. This one hides better than the SQL spelling, which
at least behaves differently on a database running in GMT: `toISOString()` is
wrong on every machine equally, so it never looks like a timezone bug. It had
reached ten places, and the one that mattered was `writeCycle` — those dates
become the INTERVALS the buying cycle is the median of, so a 2am order
shortened one gap and lengthened its neighbour, and the cycle is what decides
when the entire book is called. A second grep test now guards `src/` for it,
beside the one that guards `lib/` for the SQL spelling. A full ISO timestamp is
left alone: an instant carries its own zone, and only truncating it to a day
loses one.

**And a stored instant is not a wall clock until a zone is named.** The third
spelling of the same rule, and the one that reached a screen. `getHours()` and
`getDate()` answer in the zone of whichever machine is asking — a `page.tsx`
formats on the server, the server is Vercel and Vercel is UTC — so every
timestamp rendered server-side came out five and a half hours early. An order
taken at 9am read "3:30 am", which looks like a machine writing rows in the
night rather than a person on a call, and it was reported as exactly that
suspicion. Like both of its siblings it is correct on a laptop set to IST, so
it was right in development and wrong only in production. `stamp`, `stampDate`
and `clock` name `APP_TIMEZONE`, and a third grep test in §11 keeps every
local-zone getter out of `src/`. `getUTC*` is exempt: it names a zone, and
`longDate` uses it deliberately on a date-only value.

**A time nobody chose is not shown as a time.** A CRM order is stamped 09:00 on
the date it is FOR — the telecaller may state a past date, because an order
often arrives before anybody logs it — so the clock part is filler the capture
path writes and says nothing about the call. Printed beside a real name it read
as "Poonam took this at nine in the morning", which nobody could have known.
Order approvals shows the date alone; how long it has been waiting is its own
column, measured from the real `created_at`.
