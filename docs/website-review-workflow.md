# The Website review workflow

Employees edit website content; a reviewer decides whether it goes live. This is
the working guide: who can do what, how to switch it on, what it does to the
people who edit today, and how to take it back out. The reasoning behind the
design is in `AGENTS.md` ("The Website CMS and its review workflow").

It lives **inside the existing Website app** (`/website`). There is no second CMS,
and nothing changes for anybody who holds *Publish to the live site*.

---

## 1. Who can do what

Four rights, in two layers. The first two are ordinary Website modules; the last
two are **explicit-only** — they are never carried by a whole-app grant, by being
an administrator, by a migration or by a script. Somebody ticks them, for a named
person, on the Access screen.

| Right | Where it comes from | What it lets a person do |
|---|---|---|
| **Edit a kind** (Products, Pages, SEO…) | the Website module of that name | edit drafts of that kind; preview; **submit for verification** |
| **Assigned to it** | an assignment (only matters once enforcement is on) | the edit right above, for exactly the items assigned |
| **Review website changes** (`website.review`) | explicit-only module | assign work, read submissions, grant or reject, revoke an approval, switch enforcement on and off |
| **Publish to the live site** (`website.publish`) | explicit-only module | unchanged: publish, unpublish, archive, restore, refresh, import — and edit directly |

What an **employee** (an editor holding neither of the last two) can and cannot do:

- They **can** edit what they are assigned (or, before enforcement, what their modules cover), save drafts, preview, and press **Submit for Verification**.
- They **cannot** publish, unpublish, archive, restore, import or refresh. Their one publish button is **Publish approved changes**, on a request a reviewer has approved, for 7 days.
- A draft never touches the live site. Saving only ever changes the working copy.

What a **reviewer** can and cannot do:

- They **can** read the field-by-field difference (and old and new pictures), **Grant Permission to Publish**, or **Reject Changes** (a reason is required), and revoke an approval before it is used.
- They **cannot** approve or reject their own submission — the service refuses it and so does the database.
- They get **no publish-on-behalf button**. The person who submitted publishes it.

---

## 2. Giving somebody the right to review

Only a **platform administrator** can change access, and the Admin Console will ask
them to confirm their password first (a server action is a URL, so the check is on
the action, not only the page).

1. Sign in as a platform administrator and open the **Admin Console** → **People & access** (`/admin/access`). If it says *"For safety, confirm your password first"*, open the Admin Console home, confirm, and come back.
2. Find the person and press **Manage access**. (To give access to somebody with no account yet, press **Enable access** at the top of the page and choose them from the employee list — they must be *Active* in HRMS. No password is typed anywhere: the account is created unusable and a single-use reset link makes it usable.)
3. On the page titled *What <name> can open*, tick the **Website** app. Its screens appear beneath it.
4. Tick **Review website changes**. It starts **unticked even when you tick the whole app** — that is deliberate. Tick *Publish to the live site* separately only if that person is also to publish directly.
5. If this person will also *edit*, leave their content screens ticked (Products, Pages…). A reviewer who holds none can still review, assign and read every picture in a submission, but cannot edit.
6. Press **Review**. The next page, *Review — <name>*, says in words what is being granted. Read it.
7. Press **Grant access**. They hold it from their next page load.

To take it away, untick it and repeat. Taking the Website app away takes its module rows (including this one) with it.

**Nobody holds `website.review` after the deploy.** Until step 4 is done for somebody, nobody can assign work, approve or reject — and nothing is lost: enforcement is off, so everybody edits as before.

> The right is also checked on every server action. An administrator hat, an app
> grant and a Publish grant do **not** carry it. That is tested.

---

## 3. Assigning work

**Website → Assignments** (visible only to reviewers).

- Choose the **employee**, then **what**: a kind (Products, Pages, SEO, Gallery…), or the **Media library**.
- Then **how much**: *every item of that kind*, or **one item** (one page, one product, the SEO entry of one page).
- An optional note is shown to them beside the assignment.

What each shape allows (once enforcement is on):

| Assigned | They can |
|---|---|
| One item | edit that item, preview it, submit it |
| A whole kind | all of the above for every item of the kind, **add new items**, and **reorder** the list |
| The media library | change or delete images they did not upload themselves |

The employee must already hold the Website **module** that the kind belongs to; an
assignment cannot open a screen. The picker says which kinds each person can be
given and why the others are unavailable. Assigning the same thing twice is one
assignment. **Take away** ends it; a request they already submitted stays for the
reviewer to decide.

They are told (bell) that work was assigned, with a link to **My work**.

---

## 4. Turning enforcement on — and what it does to people who edit today

**Website → Assignments → Enforcement → Start enforcing.** Only a reviewer can.
It is **off by default**, on the day of the deploy and for ever until somebody
turns it on. Turning it off again is instant and loses nothing.

**Before:** anybody holding a Website module edits everything that module covers.

**After:** an editor who holds neither *Publish* nor *Review* changes **only what
was assigned to them**. Concretely, for each such person:

| Where | What changes |
|---|---|
| Lists (Products, Pages…) | show only their own items. No other name, draft or count. |
| A kind they were assigned nothing in | its sidebar entry disappears, and its address sends them to **My work** |
| Dashboard | the counts, "unpublished changes", recent activity and module cards are about their own work only |
| Add / reorder | offered only with a **whole-kind** assignment |
| Image library | still usable to *pick* an image; it no longer says which content uses an image, and the catalogue offered to an industry leaves out other people's drafts |
| Images (change / delete) | only ones they uploaded, unless assigned the media library |
| Saving, deleting, previewing, reading | refused by the server for anything not assigned — the screen hiding it is a courtesy |

**Not affected:** anybody holding *Publish to the live site* or *Review website
changes*; the live site; content that is already saved. Nothing is moved, copied
or deleted. Drafts an unassigned editor already saved stay where they are — they
simply cannot open them until somebody assigns them (reviewers and publishers
still can).

**The dialog counts the people it would lock out** — editors with a content
module, no direct-edit right and no assignment — before you confirm.

### The order that avoids locking anybody out

1. Tick *Review website changes* for the reviewers (section 2).
2. Assign work to every editor (section 3). Enforcement is still **off**, so this restricts nobody yet — it is only recorded, and each person sees it on **My work**.
3. Ask each editor to open **My work** and confirm the list is what they expect.
4. Open **Assignments** and read the dialog's count. It should be zero (or the people you mean).
5. **Start enforcing.**
6. Have one editor make a harmless change, submit it, and have a reviewer approve and publish it (section 5).

To undo: **Stop enforcing**. Everybody is back to what their modules cover.

---

## 5. Day to day

### An employee

1. **Edit** an assigned item and **Save** — a draft; the live site is untouched.
2. Press **Submit for Verification** (in the editor, the row menu, or **My work → Ready to submit**). Add a note if useful. The item is frozen exactly as it is.
3. While it is under review the item is **read-only** — the fields are switched off, not merely un-saveable — and a banner says why. To change it, **Withdraw** the request.
4. Watch the status:

| Status | Meaning | What to do |
|---|---|---|
| Waiting for review | a reviewer has not decided | nothing; or withdraw |
| Approved — ready to publish | **Verification Granted** | press **Publish approved changes** within 7 days |
| Changes rejected | the reviewer's reason is shown | fix it, then **Submit again** |
| Approval revoked | the reviewer took it back before use | submit again |
| Approval expired | 7 days passed | submit again |
| Content changed after submission | the item moved after the reviewer saw it, so the approval cannot be used (the request says which item) | submit again |
| Published | live | — |

You are notified (bell, and the launcher tile's badge) of each of these.

### A reviewer

1. **Review** (the sidebar badge counts what is waiting). Tabs: *Waiting for review*, *Approved — awaiting publication*, *Published*, *Rejected*, *Withdrawn, revoked, expired or stale*.
2. Open a request. Every changed field shows **before (live)** and **after (submitted)**, including a field that was *cleared*; changed pictures show side by side. The history shows who did each step.
3. **Grant Permission to Publish**, or **Reject Changes** with a reason (the button stays off until there is one).
4. Before the employee publishes, an approval can be **revoked**.

---

## 6. Rules worth knowing

- **Approval covers exactly what was reviewed.** At publish time every item's version *and* a hash of its content are compared with what was frozen. One difference voids the request, publishes nothing, and tells the employee.
- **7 days.** An approval lapses after seven days. An hourly job (`website-review-expiry`, part of the hourly cycle; by hand: `npm run jobs -- website-review-expiry`) expires lapsed ones and tells the employee; a lapsed approval is refused at publish time whether or not the job has run.
- **One open request per item**, enforced by the database. An item in a request cannot be edited, deleted, discarded or submitted again until the request is decided or withdrawn.
- **Publishing publishes the request's items and nothing else** — not other drafts of the same kind, and not anybody's pending *reordering* of the list (which is published with the list, by whoever publishes).
- **No "remove" in v1.** A submission is an *add* (new item) or an *edit*. Archiving, unpublishing and restoring stay with *Publish to the live site*.
- **Images:** an image used by live content, or by a request still open, cannot be deleted. Reviewers can open every image in a submission even with no content module.
- **Reordering** a list needs, once enforcement is on, *Publish*, *Review*, or a whole-kind assignment. Before that it needs only the module, as it always did.
- **Nobody approves their own work**, whatever they hold.

### Who is told what

| Event | Told | Link |
|---|---|---|
| Work assigned | the employee | `/website/my-work` |
| Submitted | every active `website.review` holder except the submitter | `/website/review/<id>` |
| Approved (title: *Verification Granted — You can now publish your approved changes.*) | the submitter | `/website/my-work/<id>` |
| Rejected (reason in the message) | the submitter | `/website/my-work/<id>` |
| Revoked, expired, or voided because the content changed | the submitter | `/website/my-work/<id>` |

Nobody else is told. Withdrawing and publishing tell nobody. Messages are sent after
the change has committed and are best-effort: if one cannot be written, the
workflow is unaffected.

---

## 7. Where things are recorded

- `audit_log` — every step, in the same transaction as the change: `website.assignment.assigned`, `website.assignment.revoked`, `website.review.submitted`, `.approved`, `.rejected`, `.revoked`, `.withdrawn`, `.expired`, `.stale`, `.published`, `website.review.enforcement_changed`, and `website.access.denied` for a refused attempt (who, and what they tried).
- `website_publish_log` — saves and publishes, as before; a publish through review names the request.
- Tables (migration `0274_website_review_workflow`): `website_assignment`, `website_change_request`, `website_change_item`, `website_review_setting`. A request's items keep the **frozen before and after** and the hash, so what was approved is always on record.

---

## 8. Rollout and rollback

The change is **additive**: four new tables, one new setting row (enforcement
**off**), no change to any existing table or row. Until somebody ticks
*Review website changes*, nobody can use any of it, and nobody who edits today
loses anything.

**Before "live", in order** — and how to undo each step:

| # | Step | If it goes wrong |
|---|---|---|
| 0 | Merge `main` into the branch, confirm migration `0274` is still the next number, CI green. | Nothing has happened yet. |
| 1 | **Back up the production database** (`deploy/backup.sh`, or a droplet backup). | — this *is* the safety net for step 2. |
| 2 | Merge to `main`. The deploy workflow tests, builds, **runs migration 0274** through the SSH tunnel, and restarts the app. | **Roll the code back** by naming the previous image (`IMAGE=…` in `/opt/mahekone/.env`, then `docker compose up -d app`). The old code ignores the new tables. **The migration itself is not undone** by that — see "cannot be rolled back". |
| 3 | Smoke-check: `/website` is unchanged for an editor and a publisher; *My work* appears; *Review* and *Assignments* are absent for everybody (nobody holds the right yet); `/website/review` sends a non-reviewer to `/website`. | Roll back as step 2. |
| 4 | An administrator ticks **Review website changes** for the chosen reviewers (section 2). | Untick it. No data is attached to the grant. |
| 5 | A reviewer assigns work (section 3). Enforcement is still off. | **Take away** each assignment, or leave them — they restrict nobody. |
| 6 | Editors check **My work**. | — |
| 7 | **Start enforcing** (section 4). | **Stop enforcing** — instant. Requests already open stay open for a reviewer to decide. |
| 8 | Confirm the hourly cycle now includes `website-review-expiry` (Admin Console → Jobs, after the next `:22`). | Remove the step from `runHourly` in `lib/jobs.ts`; lapsed approvals are still refused at publish time, they just are not swept. |

**What cannot be rolled back — know this before step 2:**

1. **The migration.** Rolling the *code* back leaves the four tables in place. They are harmless and unused by old code. Removing them is a manual act, **with a backup**, and only after the code is rolled back (it destroys every assignment and every request and its before/after):
   ```sql
   DROP TABLE website_change_item, website_change_request, website_assignment, website_review_setting;
   -- and only if 0274 is to be re-applied later:
   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792620444442;
   ```
2. **Anything published through approval.** It is live on mahekindia.com and visitors may have seen it. It can be *put back by hand*: the request's frozen `base_data` is the previous live copy — edit the item back and publish it. There is no one-button undo.
3. **Notifications and audit rows.** Messages already sent stay in people's bells; `audit_log` is append-only by design.
4. **An approval that has expired or been revoked** cannot be revived; the employee submits again.

---

## 9. Known limits

- A submission is an *add* or an *edit*; "remove" is not part of v1.
- Withdrawing is the only way to change an item that is under review.
- Revoking an assignment does not void a request the person already submitted.
- A publisher publishing an item that is already in a request makes the request find it "already live"; it is marked published without changing anything.
- Enforcement is one switch for the whole Website app, not per kind.
