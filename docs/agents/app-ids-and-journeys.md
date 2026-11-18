# App ids/renames, journey plans

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A new app id cannot be granted in the migration that adds it.** Postgres
refuses to USE a value added to an enum until that transaction commits, and
drizzle-kit applies every pending migration in ONE transaction — so a grant in
the next migration file fails on any database that has not already been
through the first. `npm run app:grant` is the way in, which suits HRMS anyway:
salaries and home addresses are granted deliberately.

**Renaming an app's slug is a RENAME, never an add-and-migrate.** `orders`
became `accounts` when the app outgrew the name it was given for its first
screen. Adding the new enum value, updating `app_access` and dropping the old
one cannot be done at all — a value added to an enum may not be USED in the
transaction that adds it, and drizzle-kit runs every pending migration in one
— and doing it across two deploys revokes the app from everybody who has it in
between. `ALTER TYPE app_id RENAME VALUE` changes it in place: every existing
grant keeps pointing at the same app without being touched. The old URLs are
kept alive by a permanent redirect in `next.config.ts`, because a slug lives in
bookmarks, in emails and in screenshots long after it has changed in the code.

**A plan is agreed, not issued, and BOTH halves of that are writes.** The
office proposes a city and the salesman answers — `proposed → refused → agreed
→ planned` — and it is the salesman who picks the shops, because he is the one
who knows which doors are worth a Tuesday morning. He could agree to a day and
then had no way to fill it, so the office arranged the stops; that is still
available to them, as the exception it should be rather than the only path.
`plan_stops` carries the WHOLE list rather than a difference: sending a shorter
one is how a shop is unpicked, and a merge would make unpicking impossible.
Picking nothing leaves the day `agreed`, because an empty day claiming to be a
route is the state the model exists to prevent. A shop that has left his book
since he picked it is dropped, counted and NOTIFIED — refusing the whole day
over one stale id loses the nineteen he got right, and dropping it silently is
how somebody walks a day missing a stop they chose.

**A SALESMAN ANSWERS HIS ALLOCATION, as he answers a proposed day.** The
handset's Journeys screen (`app/journeys.tsx`) lists and calendars every day
in `PLAN_HISTORY_DAYS` (60) back and the month ahead, each open to its stops,
and above them the cities and areas allocated to him. He accepts them, or asks
for different ones: `mbos_territory_requests`, kind `accept` or `change`. A
change travels as an approval of type `territory` and is decided on the
ordinary Approvals queue — approving says yes, and the allocation itself is
still changed by a person on the Territory screen, because what he typed is a
town name and not a place the tree can be trusted to resolve unseen. An
acceptance carries the allocation's SIGNATURE (`lib/territory-signature.ts`,
mirrored byte for byte on the handset and pinned by a test), so it stops
counting the moment somebody changes his areas and the Team screen says
"accepted an earlier allocation" rather than vouching for cities he never saw.

**JOURNEYS AND VISITS ARE ONE SCREEN, because a visit is read against the route
it belonged to.** `/sales/journeys` is Team · Today · One salesman · Visit log.
Team is every salesman before anybody picks a name: his areas and whether he
accepted them, today's city, the fortnight ahead day by day, who owes whom an
answer, and thirty days of shops allocated against shops visited. One salesman
is a month as a calendar or a list, and a day opens into the negotiation and
its history, each allocated stop against the visit that answered it, every
shop he walked into in order with its account type and outcome, and his
punch-in, leave and holiday. Proposing a run of days is its third view. The
Visit log is the old Visits screen, and `/sales/visits` forwards to it;
`0213_sales_visits_into_journeys` moved every `sales.visits` grant onto
`sales.journeys`, and the visit actions are gated on that module now.
`lib/journey-days.ts` is the one statement of what a day came to — a stop
still `planned` on a day that has gone is MISSED, never "planned" — and
`journey-service.ts` reads what surrounds it. A plan row holds only the latest
answer, so the handset's agree/refuse now writes `mbos.journey.answered` to the
audit log, which is where a day's history is read from.

**And the handset names the city.** Its Today tab counted stops and named
areas, so a salesman with a route had no line saying which city he was meant to
be in; the Journey tab now heads with it, the "days to agree" banner names the
cities, a This week strip shows seven days by city, the Journeys calendar
prints the city under each date, and a past day lists the shops visited off
the route with each shop's account type.

**THE OFFICE PICKS A CITY BEFORE IT PICKS SHOPS, and both are saved.**
"Pick the shops yourself" opened on the whole book with no city chosen, and
`saveJourneyPeriod` wrote the stops and nothing else — so the day's `city` was
null and every screen, the handset included, printed "No city named" above
shops plainly in one town. The button now waits for a city in the row's box,
the list is that city's shops (anywhere else stays a deliberate extra), and
`PlannedDay.city` is stored on the plan with them. Days arranged before this
are labelled from their shops — `dayWhere` on the web, `whereOf` and the
derived `shopCity` on the handset — and marked as read off the shops. That
fallback is a LABEL and never written back: `city` is the chosen city and the
handset hard-filters his own pick list by it.
