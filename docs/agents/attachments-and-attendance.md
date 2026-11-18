# Quick notes, attachments, attendance selfies and verdicts

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**How many quick notes an outcome takes is configuration, not a column.**
`interactions.singleSelectOutcomes` names the outcomes that take exactly one —
No Order today. Putting it on each `quick_notes` row would let two rows for the
same outcome disagree. A second pick replaces the first in the stored
identifier AND in the note text, so the note can never read "Stock sufficient
Price issue" and mean neither.

**Retired quick notes are deactivated, never deleted.** Historical
interactions hold their identifiers in `quick_note_ids`, and those references
must keep resolving to something a human can read. The save path deliberately
does not check `active`, so an old reference is never rejected on read.

**Attachment bytes live in Postgres by default, and in Blob only if a token
says so.** No second service, no token, and the bytes sit in the same backup
and the same point-in-time restore as the row that refers to them — which for a
few complaint photographs a week is simpler in every way that matters. Setting
`BLOB_READ_WRITE_TOKEN` switches the backend and nothing else changes, because
Postgres stops being right at volume: bytes in the database are bytes in every
backup, every restore and every replica, billed as database storage. They live
in `attachment_bytes`, never as a column on `attachments`, or every listing
would drag megabytes through the pool to display a filename.

**A file is validated on its bytes, never on its name.** `.jpg` is three
characters anyone can type. `sniffContentType` reads the signature and that is
what decides — an extension and the browser's declared MIME both come from the
same untrusted place. Permitted types are configuration, so removing one takes
effect immediately without touching code.

**An attachment is created before its parent exists.** The upload starts when
the file is chosen, not when the form saves, so a row begins life unparented
and is bound when the parent is written. That is what makes orphans possible,
which is why the nightly sweep is part of the subsystem rather than a tidy-up
somebody remembers. A form abandoned mid-call keeps its files for the
configured window first.

**A save is never blocked by an attachment.** Attachments are optional
everywhere. A failed upload leaves the complaint, call or follow-up intact and
the message says how many files made it — never all-or-nothing, and never a
lost call because a photograph did not upload.

**THE ATTENDANCE SELFIE IS THE ONE EXCEPTION, and it is not an attachment.**
Every MBOS check-in and every check-out takes a front-facing photograph inside
the app, there is no path through `src/data/attendance.ts` that writes a
session end without one, and the camera screen's only two exits are the
photograph and abandoning the action. That reverses the rule above for exactly
one file, on the reasoning the rule itself rests on: everything else here is a
photograph OF something attached to a record that stands without it, and this
one IS the record. An attendance mark on its own is a claim that somebody was
somewhere at a time; the photograph is the only part of it that is evidence.
Skippable — which is how it shipped, under a button reading "Start the day
without a photo" — the two kinds of day were indistinguishable afterwards:
some proved something, some proved nothing, and nothing on the record said
which. The GPS fix is still never required, still recorded as missing when it
is missing, and the day still starts outside the geofence with the reason
asked for afterwards. A refused camera permission is therefore a real dead
end, and the screen says so in words rather than working around itself.

**A selfie is required PER SESSION, at BOTH ends.** A day is
`[{ inAt, outAt }]` — a salesman breaks for lunch or comes out again in the
evening — so "a selfie at check-in" would have meant one photograph covering
three separate arrivals. `resumeDay` passed `selfieMediaId: null` and
check-out took no photograph at all, so a day proved that somebody arrived
once and proved nothing whatever about when they stopped, which is the half
that decides the hours. Both are now required BY THE TYPE rather than by the
screen: `checkIn` and `checkOut` take a non-nullable id, because a screen that
forgets to ask is a screen and a parameter that cannot be omitted is the rule.
Each session carries `inSelfieId` and `outSelfieId`, and the day-level
`check_in_selfie_id`/`check_out_selfie_id` are the first-in and last-out
mirrors, exactly as `check_in_at` and `check_out_at` already are.

**THE SERVER HAD NO SESSIONS, so a day of three arrived as one pair.** The
handset has modelled a day as a list since its own v2 migration and
`mbos_attendance_days` kept two timestamps — so 9-to-1 plus 2-to-6 reached the
office as nine hours on the record that feeds a payslip, with the break
invisible. It is a `jsonb` column now, stored as the handset reports it and
NOT a cache: rebuilding it from the two marks is precisely the loss it exists
to prevent. It is also the only place N photographs can live, since a day with
two breaks carries six.

**A DAY THE NIGHTLY CLOSES IS CLOSED IN ITS SESSIONS TOO.**
`markMissedCheckouts` set `check_out_at` and left the last session at
`outAt: null`, so `workedSecondsOf` read the day as still running, the verdict
job skipped it as unjudged every night for ever, and a nine-hour day read
Absent with no hours on the record pay is read against. The open session is
closed at the same instant and marked `autoClosed`. And that instant is the
last thing he DID — an activity filed, a visit closed — with a raw position
used only for a day with neither: a position is evidence the phone was on, and
a forgotten punch-out left the tracker recording through the evening at home,
so the day used to close at 23:58.

**AND NOTHING CLOSES A DAY ANY MORE, which reverses the paragraph above
(October 2026).** Field salesmen who start at ten at night to travel between
cities were punched out by the nightly `markMissedCheckouts` while still on
the road, so it is gone: only a punch-out ends a day. A day nobody punched out
of stays open and carries no verdict until a regularisation closes it. The
handset's start-of-day tidy-up (`state/boot.tsx`) closes nothing on or after
the stretch still running (`runningSince`), and the positions route accepts
an open day's trail for `mbos.location.serviceMaxDayHours` from the start of
that stretch instead of stopping at midnight, the same ceiling the handset's
recorder keeps.

**A regularisation request is something somebody asked for.** The handset sends
`regularisationRequested: true` on every punch-in outside the radius, reason or
none; with a company-wide base location that filed a "request" for every
salesman starting from home. It counts only where a reason came with it —
`withinGeofence` still records the distance.

**A DAY'S VERDICT IS DERIVED, AND FOR A LONG TIME NOTHING DERIVED IT.**
`mbos_attendance_days.status` and `worked_seconds` are caches — the column
comments have said so since the table was written, and `handleAttendance`
declines to type either by name, correctly, because a handset that can type its
own verdict can type its own pay. The job it defers to was never written. So
every row ever stored read `absent` with no hours against it, including days
carrying a check-in, a check-out and two selfies: three screens drew a red pill
saying a man who worked was absent, `daysOnLeave` on the salary screen was a
count of a value nothing wrote, and the two configuration keys that would have
driven it had no consumer at all. `lib/engines/attendance.ts` is the rule and
`recomputeAttendanceVerdicts` is the wiring, hourly for the last two days and
nightly over everything.

**The HOURS are the sessions, never the two marks.** Subtracting `check_in_at`
from `check_out_at` on a 9-to-1-then-2-to-6 day answers nine hours, which is
exactly the lie the `sessions` column was added to kill. An open session
contributes nothing and is never run to `now`: a clock read when the cron fired
is a measurement of the cron. An EMPTY session list beside two real marks is
the one fallback, because it is a row an older handset wrote and reading it as
zero seconds would mark a full day absent — the same bug through the back door.

**WORK OUTRANKS BOTH LEAVE AND A HOLIDAY; a holiday outranks leave where
nothing was worked.** A man who came out and sold on a public holiday worked
that day, and a record calling it `holiday` erases the only evidence he did —
it would also be counted twice on the salary screen, whose `daysWorked` reads
the check-in and whose `daysOnLeave` reads this column. Between the two where
nobody worked, the holiday wins: `leaveWorkingDays` already excludes holidays
from a request's span, so reading it as leave taken would contradict the
balance that was actually debited.

**A DAY WITH AN OPEN SESSION GETS NO VERDICT AT ALL, and the screen says so.**
Today's day while it is being worked, and the past day `markMissedCheckouts`
could not close for want of any evidence of when he stopped. That job already
refuses to invent a closing time, and inventing a verdict out of the hours it
declined to guess would walk straight round it — so nothing is written and the
row keeps the column's `absent` DEFAULT, which is not a judgement anybody made.
`worked_seconds` null beside a check-in is what tells the two apart, and
`lib/attendance-labels.ts` — pure and client-safe, like `customer-health.ts` —
draws it as "not measured" rather than as a red "absent".

**And the rebuild skips a row it would rewrite identically.** This pass sees
every attendance day there has ever been, on a schedule, for ever, and a
verdict that settled in March does not move in September. Both columns are
compared with `is distinct from` — `worked_seconds` is nullable, and `null <>
null` is null — so a converged table is rewritten nowhere. The gate is the
OUTPUT and never a hash of the attendance row: leave approved this morning for
last week, a holiday added afterwards and a changed threshold all reach
backwards into days already judged, which is also why the nightly pass takes no
window.

**A check-in is never refused because a photograph is still uploading.** Media
is a separate queue that syncs AFTER its parent — that is the whole point of
it — so an attendance row routinely names a file whose bytes are still on the
phone, and the two selfie columns are foreign keys onto `attachments`. A key
does not care about the reason: it would reject the check-in over a file in
transit. So the id is written to those columns only once the attachment row
exists, the handset re-sends as its media queue drains, and the `sessions`
list holds every id from the first pass regardless — the mark is never lost to
the ordering of an upload.

**EVERY FIELD PHOTOGRAPH WAS BEING DELETED BY THE NIGHTLY JOB.** The worst bug
in the subsystem and the quietest: `storeMbosMedia` never wrote `parent_type`
or `parent_id`. The handset has sent both on every upload since it was
written; the route read an `entityId` nothing sends, and the action dropped
even that. So every selfie, cheque, bill and shop front landed in
`attachments` with a null parent — and `sweepOrphans`, which runs nightly,
selects exactly that (`parent_id is null` past
`attachments.orphanCleanupHours`, 24 by default), removes the bytes from
storage and marks the row removed. A photograph taken on Monday was gone on
Tuesday. Until then it was readable by its uploader alone, because `canRead`
falls back to "unbound and still the uploader's own" — so no manager had ever
been able to open one either. The enum values (`mbos_visit`,
`mbos_attendance`, …) had been declared a migration early with a comment
saying they were used by nothing "yet"; nothing ever went back for them.
`MBOS_PARENTS` is the mapping, an unrecognised name parents nothing rather
than guessing, and the sweep still removes what genuinely belongs to nothing.

**An attendance selfie has no customer behind it, and answered 404 to
everybody.** The second half of the same story. `customerBehind` falls through
to `calls` for any parent type it does not name, so an attendance id was
looked up among calls, found nothing, and every read was refused — to the
salesman in the photograph and to the manager it exists for. Who may open one
is asked in `canReadAttendanceSelfie`: the person in it, and whoever can see
his attendance, which is `managerScope` — the Sales Dashboard's own narrowing
rather than a second opinion about it. Not "anybody holding the field app": a
salesman must not be able to fetch a colleague's photograph by id, and these
ids travel in payloads.

**AND THAT LAST SENTENCE WAS A PROMISE THE CODE DID NOT KEEP.**
`managerScope` narrows a REGIONAL manager and is vacuous for everybody else: it
answers `salesmanIds: null`, meaning everybody, for anyone with no `region` row
in `mbos_user_territories` — three separate returns in it do so — and a plain
field salesman has none. Which is nearly all of them. So the ordinary
colleague, holding only the field app, got the national answer and could open
anybody's check-in photograph by id. It failed OPEN, the dangerous direction,
and lasted because nothing looked broken: everything worked. The test that
should have caught it gave its colleague a territory row on purpose, "so he is
scoped rather than national", and stepped around the only case that leaked.

**So the `sales` GRANT is asked first, and the narrowing sits behind it.**
"Whoever can see his attendance" means whoever can open `/sales/attendance`,
and that layout redirects anybody without the grant whatever their role —
`listUserApps` reads `app_access` and nothing else, so there is no implicit
access for an admin. A manager who was never given the Sales Dashboard has no
screen on which to see anybody's attendance, and a photograph is not a back
door to one. Every OTHER caller of `managerScope` is a list inside `/sales/*`
and is already behind that layout; the two in `attachment-service.ts` are
reached from `/api/attachments/[id]`, which has no gate but a signed-in
session, which is why the check belongs in them.
`canReadTravelLegPhoto` is the same rule for the same reason.

**AND IT IS THE ONE FILE HERE WITH A CLOCK ON IT.** Everything else in this
subsystem is a photograph OF something — a damaged can, a cheque, a shop
front — attached to a record that stands without it, and it is kept as long as
the record is. A check-in selfie is not that. It is evidence that the person
who marked the day is the person who worked it, and that question is asked
within a day or two of the day or it is never asked at all. Held beyond that it
stops being verification and becomes a standing collection of photographs of
employees: worse to hold, worse to leak, and nothing anybody asked for.
`mbos.attendance.selfieRetentionHours` is the window — 72 hours — and
`sweepAttendanceSelfies` is what enforces it.

**HOURLY, not nightly, because the number is on a screen.** Swept once a night,
"72 hours" would mean up to ninety-six for everybody who checked in during the
morning, and the gap between what a setting says and what it does is the kind
of thing nobody notices until it is the subject of an argument about somebody's
pay. It rides `mbosHourly` beside the escalations.

**Measured from when it ARRIVED, never from when it was taken.** A salesman in
a district with no signal photographs himself on Monday and syncs on Wednesday;
anchored to the check-in, that file would be swept within hours of landing and
the manager would never once have been able to open it. The window is a promise
about how long somebody has to LOOK, so it runs from the first moment there was
anything to look at. The consequence is that the screen and the window can
honestly differ — a photograph on an old day may still be there — so the screen
shows what EXISTS rather than computing a window of its own. One number, one
enforcer.

**What goes is the image and nothing else.** The attachment row stays, the day
keeps its `check_in_selfie_id`, and every `sessions` entry keeps the ids it was
written with. "A photograph was taken at 09:04 and has since been deleted" and
"no photograph was taken" are different facts about somebody's attendance, and
the second is the one that reads as a person cutting a corner. A sweep that
nulled the columns would rewrite the first into the second, months later,
silently, on the record a payslip is read against. There is a test for it.

**The manager sees them on the Attendance screen, ONE PER MARK.** A day is a
list of arrivals and departures — a salesman breaks for lunch and comes out
again in the evening — so both ends of every session carry a photograph and all
of them are drawn. Showing the day's first selfie alone would verify that he
arrived in the morning and assert nothing whatever about the two marks that
decide the hours. Three things are drawn differently and they are three
different facts: a photograph you can open, one that was taken and has since
been deleted, and a mark with no photograph against it at all. `canRead` is
still what gates every image, so a manager sees his own team's and nobody
else's.

**A swept file answers 410, not 502.** `/api/attachments/[id]` used to reach
storage for a `removed` row, find nothing and report a read failure — which
reads as a broken backend and sends somebody looking for a fault that is not
there. The row is deliberately kept, so "it existed and is gone" is a thing the
endpoint can actually say.

**Removing an attachment is a status, not a delete.** It detaches from the
parent and moves to `removed`; the bytes go only when retention says so. A
payment proof outlives whoever tidied it off a screen.

**Attachments are read through `/api/attachments/[id]`, never a stored URL.**
Access follows the parent record's scope, so anyone who can see the complaint
can see its photographs and nobody else can. A file the caller may not see and
a file that does not exist answer identically, or the endpoint becomes a way to
enumerate customers.
