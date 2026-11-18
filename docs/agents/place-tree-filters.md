# Reviewed place tree on lists

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**WHERE A SHOP IS, IS THE REVIEWED TREE, and every list narrows by it.**
`customers.city` is whatever the sheet typed — 1,165 spellings of a few hundred
places — so it cannot be filtered on. `data/places/customer-places.csv` is the
team's reviewed answer for every account on the book in September 2026,
state › district › city › area, and `place-tree-import` writes it into
`places` and the four `resolved_*_id` columns, stamping `place_decided_at`
because a person checked it. `location-tree-reviewed.csv` beside it is the
Tree sheet as it came back from review; the per-account file already carries
its corrections. The customer table (CRM and Accounts) and the lead table
(list and board) narrow by the same four through `placeFilterSql`, and the
dropdowns cascade: a pick narrows the rungs below it and clears any pick there.

**A shop the review never saw is MATCHED, never added.** `resolveTypedPlaces`
reads the region (or the state named in the address) and finds the typed city
as a city or an area UNDER that state; an ambiguous name leaves the shop at its
state. It never creates a node, because a node one telecaller spelled once is
how the 1,165 strings came about. It runs nightly, and at once when a customer
is added or edited in the CRM or a lead is captured. Its rows carry
`place_source = 'sheet'` and are re-read every night, so a corrected sheet
moves them; a reviewed or hand-picked place is never touched. The sheet's own
`city` and `region` are left alone — the projections own them — and every
read that shows a town goes through `placeNameSql`, the tree's name falling
back to the typed one.
