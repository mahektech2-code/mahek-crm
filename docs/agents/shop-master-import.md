# EMP 2.0 shop master import

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A SHOP MASTER IS NOT AN ORDER HISTORY, so the kind is read off evidence.**
The EMP 2.0 workbook's `Customer Details` tab is 5,292 shops and the only
place a phone number for any of them exists — the Activity tab has twelve
columns and not one is a contact detail, and the GPS pin export beside it
carries `CustomerPhone1..3` with exactly one of 6,525 filled. What it does NOT
carry is a single order, so `kind` cannot be read off it. It is decided from
evidence of a purchase in the Activity log: a Payment Collection visit (you do
not collect money from a prospect), the old app's own Stage 0/4/5 labels, or a
High/Medium/Low Value rating. None of those is a LEAD, which is what a lead
already means — an account that has never ordered. Every verdict is stored on
the staging row WITH its reasons, because "why is this one a customer" is asked
months later about one row, and re-running the rule then answers a question
about today.

**It writes neither `third_party` nor `active_in_order_system`, and that is the
whole point of both rules.** The first is a person's judgement plus a named
distributor and the schema says no import may set it; the second was cleared
once already by `0021` after an import muted the entire book. The evidence for
a third-party mark is kept in staging for whoever decides. `owner_id` is left
null too: on five thousand rows it would be whoever ran the import, and every
scoped list would read as their book — unassigned is said in words on a team
list, a false owner is not said at all.

**`Deactive` is the one status an import may write, because it is a decision.**
`customers.status` is derived by `recomputeInactivity`, and the single value
that engine never touches is `deactivated` — deactivation is a human decision.
The sheet's `Deactive` is exactly that decision, made in the old app, so it
maps straight through while everything else is left at `active` for the engine
to move.

**And it does not write `sales_person_name`, though the sheet names one.**
`recomputeSalesPeople` rewrites that column from the PARTY sheet for every
customer without `am_decided_at`, INCLUDING back to null where the party
sheet is silent — which it is for all 5,292 of these. Writing the name would
last until it next ran. (It was nightly when this was written; today only
`recomputeEverything`, called by the seed alone, runs it.) Setting `am_decided_at` to protect it would be a
lie, since no person decided anything, and would freeze both manager seats
against a future sync as a side effect. The name stays on the staging row.

**A number that is on 919 shops is a placeholder, and it is found by counting
rather than by a literal.** The export carries one syntactically perfect Indian
mobile on 952 rows; every validity check passes it. `flagSharedMobiles` marks
any number on three or more shops — two is an ordinary proprietor with two
counters — because the next export will use a different placeholder and a
number written into the code would silently stop catching it.
