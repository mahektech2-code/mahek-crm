# Document library, courses, sheet lot costing

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**Publishing to the field is a decision, and withdrawing is the same decision
reversed.** The document library and the training centre had tables, handset
screens that read them, and no door between the two — both were empty because
they could not be filled. Neither `publishDocument` nor `publishCourse` deletes:
a policy a salesman quoted to a customer in March is a fact about March, and
somebody half-way through a course does not become unfinished because the
material was taken down. `active = false` takes it off the handsets and the
tombstone is what tells them it went.

**A document must have a file; a course need not.** A briefing delivered in a
meeting is still a course to record and tick off. A document with nothing behind
it is a row the handset lists and cannot open, and the failure — a tap that does
nothing — says nothing about why, so it is refused at the form instead.

**NO FILE OVER A MEGABYTE WAS EVER PUBLISHED, because the upload was a server
action.** Next refuses a server action's body past 1 MB before a line of ours
runs, and a price list PDF is routinely three. The action rejected rather than
returning a Result, the screen awaited it in a `try`/`finally` with no `catch`,
and the spinner simply stopped — "documents will not publish" was reported for
exactly that. Library and training files go to `/api/sales/publish-file`, a
route handler, as the HRMS and ERP uploads already did; `attachments.maxSizeMb`
is the only ceiling left, and it answers in words. Do not move an upload back
into a server action.

**A document can be TAGGED to named people, and empty is everybody.**
`mbos_documents.visible_to_user_ids` holds user ids — what a handset signs in
as — and narrows `visible_to_roles`, never widens it. It is not
`audience_employee_ids`, which is HRMS employee ids carried over from EMP 2.0.
Four places ask it and must keep asking it together: `visibleDocuments` (the
bootstrap and the delta), the handset's `/api/mbos/documents/[id]`, and
`canReadDocument` behind `/api/attachments/[id]`. The people offered are
whoever holds the `field` app, NOT narrowed by `managerScope`: the library is
the company's, and a regional manager editing a document tagged to somebody
outside his region must not silently drop him because the picker could not
show him.

**Untagging writes a tombstone per person, and re-tagging lifts it.** A pull
says what exists, so untagging alone would leave the copy on his phone for
ever. And because the handset applies a pull's upserts BEFORE its tombstones,
somebody untagged and tagged back between two of his syncs would get the row
and delete it in the same pull — so `applyTagChange` deletes his standing
tombstone, and `setDocumentPublished` lifts the withdrawal's tombstone on
republish for the same reason. Whoever holds `sales.documents` may open any
document's file, withdrawn or tagged to others: the Documents screen links
every row to its file, and the rules above are about who it was published TO.

**A course's file is its own attachment parent.** It could have borrowed
`mbos_document`, and that would be wrong exactly where it matters: `canRead`
decides who may open a file FROM the parent kind, so a course deck filed as a
document would be read under the document rules — role lists and a customer's
scope, neither of which a course has.

**Editing a course corrects it; it never re-scores anybody.** `editCourse`
changes the title, kind, length, compulsory flag and deadline (and keeps a pass
mark the form does not ask about) under the same rules `publishCourse` holds —
a deadline only on a compulsory course. Bumping `updated_at` is what carries it
to the phones (`coursesFor` reads `c.updated_at > since`). Progress rows are
not touched: somebody who passed under the old mark has passed. The file is
not editable — new material is a new course.

**Editing a Sales Dashboard assignment (`editTaskCampaign`) reaches only the
work still open.** Title, description, priority and due date change on the
`mbos_task_campaigns` row and on every task of it still `open`/`in_progress`
in the editing manager's team (`onlyMine`, as withdrawing narrows); an
ANSWERED task keeps the wording it was answered under, and a withdrawn one
stays withdrawn. When the due date moves, each salesman with an open task gets
ONE bell. The modal says all of this before saving. The audience and the
questions are deliberately not editable: changing who it goes to is minting
and withdrawing tasks, which `assignTaskCampaign` and `closeTaskCampaign`
already do with their own previews, and answers already given were given to
the questions as they stood. A withdrawn assignment is not edited.

**A LINE THAT LEFT BEFORE LOTS WERE ALLOCATED IS COSTED BY THE SHEET THAT
SHIPPED IT.** The ERP's margin is the allocated lots' cost, and nobody
allocated a lot to anything before 26 Oct 2026 — so every line before then,
some twenty-one thousand of them, read as "margin unknown" on the Margins desk
and the ERP's own Margin column. The old order sheet costed every one of those
lines itself, in "Lotcode Costing", and its "Margine" is the amount less exactly
that figure. `erp_order_details.sheet_costing_paise` carries it, matched on
order number, product and cans by `engines/sheet-costing.ts`, and only where
that names ONE cost — two rows that disagree are left unknown rather than
guessed. **An allocated lot always wins**, even one with no rate yet, and every
screen says which source a cost came from. Filled by `npm run jobs --
sheet-lot-costing` (`--dry-run` first), read from the staging copy of the tab;
Google is never asked.
