import { all, newId, one, run } from '../db';
import { isoDate } from '../lib/format';
import { enqueue } from '../sync/queue';
import { pickOrigin } from '../engines/route';
import { haversineMetres } from '../engines/geo';

/**
 * The day's route.
 *
 * `journey_stops` is reference data — the plan is made in MahekOne and pulled
 * down — so nothing here enqueues. What the salesman changes on the handset is
 * the ORDER he walks it in, which is his own decision about his own morning and
 * which the next pull is entitled to overwrite. The visit he logs against a
 * stop is the thing that syncs, and `saveVisit` already does that.
 */

export type JourneyStop = {
  id: string;
  planDate: string;
  customerId: string;
  seq: number;
  plannedAt: string | null;
  actualAt: number | null;
  visitId: string | null;
  status: string;
  skipReason: string | null;
  /* Joined from the customer, because a stop with no name is not a stop. */
  customerName: string;
  area: string | null;
  /** The town, for Navigate on an unpinned shop: `area` is empty on most of
      an imported book, and a maps search on the bare name lands anywhere. */
  city: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  outstandingPaise: number;
};

export function today(): string {
  return isoDate(new Date());
}

export async function todayStops(planDate = today()): Promise<JourneyStop[]> {
  return all<JourneyStop>(
    `SELECT j.*, COALESCE(c.name, 'Unknown customer') AS customerName, c.area, c.city,
            c.gpsLat, c.gpsLng, COALESCE(c.outstandingPaise, 0) AS outstandingPaise
       FROM journey_stops j LEFT JOIN customers c ON c.id = j.customerId
      WHERE j.planDate = ?
      ORDER BY j.seq`,
    [planDate],
  );
}

/** The stop the salesman is walking to now — the first one not yet visited. */
export async function nextStop(planDate = today()): Promise<JourneyStop | null> {
  const stops = await todayStops(planDate);
  return stops.find((s) => s.status === 'planned') ?? null;
}

/**
 * Write a new walking order — HERE AND AT THE OFFICE.
 *
 * The sequence is rewritten from the array's own order, so a reorder that
 * dropped or duplicated a stop could not silently produce two stop 3s.
 *
 * It used to stop there. Nothing was queued, so the manager never saw the new
 * order, the planned times stayed attached to the old one, and the first
 * office change to any single stop came back with its ORIGINAL `seq` — two
 * stops numbered 3 and a scrambled list. The day's shops now go up as the same
 * `plan_stops` answer picking sends, in the new order: the office re-sequences
 * what is still planned and works the times out again, and keeps what has
 * already been visited.
 */
export async function saveStopOrder(orderedIds: string[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    await run('UPDATE journey_stops SET seq = ? WHERE id = ?', [i + 1, orderedIds[i]]);
  }
  if (!orderedIds.length) return;
  const head = await one<{ planDate: string }>('SELECT planDate FROM journey_stops WHERE id = ?', [orderedIds[0]]);
  if (!head) return;
  const day = await one<{ id: string }>('SELECT id FROM journey_days WHERE planDate = ? LIMIT 1', [head.planDate]);
  if (!day) return;
  const stops = await all<{ customerId: string; status: string }>(
    `SELECT customerId, status FROM journey_stops WHERE planDate = ? ORDER BY seq`,
    [head.planDate],
  );
  const customerIds = stops.filter((x) => x.status === 'planned').map((x) => x.customerId);
  if (!customerIds.length) return;
  await enqueue({
    entityType: 'plan_stops',
    entityId: day.id,
    op: 'update',
    location: false,
    payload: { id: day.id, customerIds },
  });
}

export async function stopCounts(planDate = today()): Promise<{ total: number; done: number }> {
  const row = await one<{ total: number; done: number }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'visited' THEN 1 ELSE 0 END) AS done
       FROM journey_stops WHERE planDate = ?`,
    [planDate],
  );
  return { total: row?.total ?? 0, done: row?.done ?? 0 };
}

/**
 * The same rollup as `stopCounts`, for a whole window of past days at once —
 * one query rather than one per row on a screen that lists a fortnight of
 * them.
 */
export async function stopCountsSince(from: string): Promise<Record<string, { total: number; done: number }>> {
  const rows = await all<{ planDate: string; total: number; done: number }>(
    `SELECT planDate, COUNT(*) AS total, SUM(CASE WHEN status = 'visited' THEN 1 ELSE 0 END) AS done
       FROM journey_stops WHERE planDate >= ? AND planDate < ? GROUP BY planDate`,
    [from, today()],
  );
  return Object.fromEntries(rows.map((r) => [r.planDate, { total: r.total, done: r.done }]));
}


/**
 * How far back the Journeys screen reads. Must match `PLAN_HISTORY_DAYS` in
 * the server's `mbos-service.ts`, or the screen asks for days the pull never
 * sent and reads their absence as days nothing happened.
 */
export const JOURNEY_HISTORY_DAYS = 60;

/** One day of the plan with what happened on it, for the list and the calendar. */
export type JourneyDay = PlanDay & {
  stops: number;
  visited: number;
  skipped: number;
};

/**
 * Every day from `from` onwards — past and future — with its stop counts.
 *
 * Counted in SQL from the stops rather than trusted from `picked`, because
 * `picked` is how many he chose and this is what became of them.
 */
export async function journeyDays(from: string): Promise<JourneyDay[]> {
  return all<JourneyDay>(
    `SELECT d.*,
            (SELECT COUNT(*) FROM journey_stops s WHERE s.planDate = d.planDate) AS stops,
            (SELECT COUNT(*) FROM journey_stops s WHERE s.planDate = d.planDate AND s.status = 'visited') AS visited,
            (SELECT COUNT(*) FROM journey_stops s WHERE s.planDate = d.planDate AND s.status = 'skipped') AS skipped
       FROM journey_days d
      WHERE d.planDate >= ?
      ORDER BY d.planDate ASC`,
    [from],
  );
}

/** Every stop of one day, in walking order, with its shop — the day in full. */
export async function stopsOn(planDate: string): Promise<(JourneyStop & { city: string | null })[]> {
  return all<JourneyStop & { city: string | null }>(
    `SELECT j.*, COALESCE(c.name, 'Unknown customer') AS customerName, c.area, c.city,
            c.gpsLat, c.gpsLng, COALESCE(c.outstandingPaise, 0) AS outstandingPaise
       FROM journey_stops j LEFT JOIN customers c ON c.id = j.customerId
      WHERE j.planDate = ?
      ORDER BY j.seq`,
    [planDate],
  );
}

/* ══════════════════════════════════════════════════════ the days themselves */

export type PlanDay = {
  id: string;
  planDate: string;
  city: string | null;
  beat: string | null;
  dayState: 'proposed' | 'refused' | 'agreed' | 'planned';
  refusalReason: string | null;
  counterCity: string | null;
  proposedAt: number | null;
  proposedBy: string | null;
  picked: number;
  syncState: string;
  /* What the office SAID when it refused an answer, written onto the row by
     `setEntityState`. The card reads it, because "the shops were not accepted"
     with no reason attached sends somebody back to pick the same ones. */
  syncMessage: string | null;
};

/**
 * Where the office has asked you to work, and what you have said about it.
 *
 * A plan is AGREED rather than issued. The office proposes a city; you are the
 * one who knows whether that market is open on a Wednesday, so you answer —
 * and once a day is agreed you pick the shops yourself, because you know which
 * of them are worth the walk.
 *
 * Only days from today onwards. A proposal about last Tuesday is not a
 * question anybody can still answer.
 */
export async function planDays(from = today()): Promise<PlanDay[]> {
  return all<PlanDay>(
    `SELECT * FROM journey_days WHERE planDate >= ? ORDER BY planDate ASC`,
    [from],
  );
}

/** How many days are waiting on an answer from this handset. */
export async function daysAwaitingAnswer(from = today()): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM journey_days WHERE planDate >= ? AND dayState = 'proposed'`,
    [from],
  );
  return row?.n ?? 0;
}

/**
 * Yes — you will work that city.
 *
 * The day moves to `agreed` here and to `planned` only when you pick the
 * shops, which is an ordinary stop write. Keeping those two apart is what
 * stops an empty day claiming to be a route.
 */
/**
 * Planning a day nobody proposed.
 *
 * The negotiation runs one way — the office proposes a city, you agree or
 * refuse — and until this existed that was the ONLY way a day could come into
 * being. A Tuesday the office had not thought about could not be worked at
 * all, which is most Tuesdays.
 *
 * The day is born `agreed`, because there is nobody to agree with: `agreed`
 * means the city is settled and the shops are next, which is exactly true of a
 * day you chose. It is not `planned` — that means the shops are picked, and
 * picking is the next screen.
 *
 * **The city is required and the server refuses without one.** `pickCandidates`
 * filters the shop list by it and applies no clause at all when it is empty, so
 * a day with no city would open the picker on your entire book rather than the
 * town you are standing in.
 */
export async function createDay(
  planDate: string,
  city: string,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const where = city.trim();
  if (!where) {
    return { ok: false, message: 'Which city are you working in? The shop list shows only that city.' };
  }
  if (planDate < today()) {
    return { ok: false, message: 'That day is over. Pick today or a later day.' };
  }

  /* One row per day, here as well as on the server's unique index: a second
     row for a date would show the same day twice on the Journey tab, and only
     one of them would ever get its shops. */
  const clash = await one<{ id: string }>(
    'SELECT id FROM journey_days WHERE planDate = ? LIMIT 1',
    [planDate],
  );
  if (clash) {
    return {
      ok: false,
      message: 'That day is already on your plan. Open it from the Journey tab.',
    };
  }

  const id = newId('plan');
  await run(
    `INSERT INTO journey_days (id, planDate, city, dayState, picked, selfPlanned, syncState)
     VALUES (?, ?, ?, 'agreed', 0, 1, 'queued')`,
    [id, planDate, where],
  );

  await enqueue({
    entityType: 'plan_day',
    entityId: id,
    op: 'create',
    /* Paperwork, like answering a proposed day. He plans tomorrow at home in
       the evening as often as anywhere, and where a form was filled in answers
       no question worth holding a coordinate for. */
    location: false,
    payload: { id, answer: 'agreed', planDate, city: where },
  });

  return { ok: true, id };
}

export async function agreeDay(id: string): Promise<void> {
  await answer(id, { answer: 'agreed' });
}

/**
 * No — and why.
 *
 * The reason is required, and not out of politeness: without one your manager
 * has nothing to act on, and the day sits unplanned while each of you waits
 * for the other. Naming somewhere you would rather go is optional — "not this"
 * is a legitimate answer, and being made to produce an alternative on the spot
 * is how people stop refusing things they should refuse.
 */
export async function refuseDay(
  id: string,
  reason: string,
  counterCity?: string | null,
): Promise<{ ok: boolean; message?: string }> {
  const said = reason.trim();
  if (!said) {
    return {
      ok: false,
      message: 'Say why it will not work. Your manager needs a reason.',
    };
  }
  await answer(id, { answer: 'refused', reason: said, counterCity: counterCity?.trim() || null });
  return { ok: true };
}

/**
 * The write itself.
 *
 * Local first, then queued, like every other write in this app — the screen
 * must not wait on a network that is not there. The row is marked `queued` so
 * the day can say "sent, not yet acknowledged" rather than pretending the
 * office has already heard.
 */
async function answer(
  id: string,
  payload: { answer: 'agreed' | 'refused'; reason?: string; counterCity?: string | null },
): Promise<void> {
  await run(
    `UPDATE journey_days
        SET dayState = ?, refusalReason = ?, counterCity = ?, syncState = 'queued'
      WHERE id = ?`,
    [payload.answer, payload.reason ?? null, payload.counterCity ?? null, id],
  );

  await enqueue({
    entityType: 'plan_day',
    entityId: id,
    op: 'update',
    /* Paperwork, not field work. Answering a proposed day happens on a sofa
       at nine in the evening as often as anywhere, and recording a salesman's
       home coordinates because he replied to his manager is surveillance with
       no business purpose behind it. Where an ORDER was taken answers a real
       question; where a form was filled in answers none. */
    location: false,

    payload: { id, ...payload },
  });
}


/* ══════════════════════════════════════════════════════════ picking the shops */

export type Candidate = {
  id: string;
  name: string;
  area: string | null;
  city: string | null;
  beat: string | null;
  outstandingPaise: number;
  lastVisitDate: string | null;
  lastOrderDate: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
};

/**
 * How many shops the pick list offers unprompted.
 *
 * The whole book was, which on this handset is thousands of rows — every one
 * of them a card in a list, and the buttons that save the day sat underneath
 * the last of them. Nobody scrolls a book to find a button. A day is twenty
 * stops at the very outside, so what a cap costs is the shop somebody was
 * going to reach by scrolling rather than by typing its name, and the search
 * box is right above it.
 */
export const PICK_PAGE = 60;

/**
 * Who there is to pick from, for a day in a given city.
 *
 * **The city NARROWS rather than filters.** Everything is offered, with the
 * proposed city's shops first — a salesman going to Nagpur often has one call
 * to make on the way, and a list that refused to show it would send him back
 * to the office to ask. The word "elsewhere" on the row is what keeps that
 * honest.
 *
 * Ordered by how long it has been. The question being answered is "who have I
 * not seen", and a customer visited yesterday is the last one to put on
 * tomorrow — a name that has never been visited sorts to the very top, because
 * that is the strongest version of the same answer.
 *
 * **Capped, and the screen says what it is a slice of.** `total` is a
 * `count(*)` rather than the length of what came back, for the reason the
 * web app's timeline pills carry: a capped list that counts itself reports
 * sixty shops on a book of five thousand and nothing on the screen says so.
 *
 * **Already-picked shops are never cut.** They are read by id alongside the
 * page, because a shop ticked, then searched past, then found again outside
 * the cap would come back with its number gone — and the number IS the plan.
 */
/**
 * The shops a salesman may pick for an agreed day.
 *
 * THIS FUNCTION CARRIES TWO SEPARATE PIECES OF WORK and they meet here.
 *
 * From the cap: the read is LIMITed. The whole book drawn at once is what
 * stopped this screen answering — 1,076 shops mounted as native views in one
 * pass — so `PICK_PAGE` bounds it, `total` says what the list is a slice of,
 * and already-ticked shops are fetched separately so one ticked, searched past
 * and found again never comes back with its number gone. The number IS the
 * plan: it is the order he means to walk.
 *
 * From the day's picking, on Mahek's instruction, reversing two things this
 * file used to argue for:
 *
 *   The agreed city is a HARD FILTER. It used to rise to the top without
 *   filtering, on the reasoning that a man going to Nagpur often has one call
 *   to make on the way. A day is a city; that call is added from the customers
 *   list or made unplanned with a deviation reason, which is what that field
 *   exists for.
 *
 *   The sort is NEAREST. It was "who you have not seen longest", which answers
 *   a real question — but a man filling a Tuesday morning in one town is
 *   choosing a walking order.
 *
 * THE FILTER MOVED INTO SQL because of the cap. Filtering by city in JavaScript
 * after a LIMIT of sixty would page the wrong sixty: the read would take the
 * sixty least-recently-seen shops in the BOOK and then discard whichever were
 * not in the city, so a salesman could open a Nagpur day and be shown four
 * shops out of the eighty there are. The two changes are only compatible in
 * this order.
 *
 * WHAT NEAREST IS MEASURED FROM is `pickOrigin`: today, where he stands; any
 * other day, the middle of our shops in that city — he plans tomorrow at home,
 * and sorting Wardha from a sofa in Nagpur puts the list upside down. With no
 * origin at all it keeps the query's own ordering rather than inventing a
 * point, because a list sorted around a made-up origin looks right and is
 * wrong.
 *
 * THE ORIGIN IS THE CITY'S, AND THE PAGE IS ORDERED AROUND IT IN SQL. Both
 * halves of that sentence are corrections, and they are the same bug read from
 * either end.
 *
 *   The centroid used to be taken over whatever rows had just come back, which
 *   is the SEARCH RESULT and not the city. So typing a letter moved the point
 *   every distance on the screen was measured from, and the figure printed
 *   against a shop nobody had touched changed as he typed. It is one
 *   `AVG(gpsLat), AVG(gpsLng)` over the city's pinned shops now — the same
 *   answer whatever is in the search box, which is what makes the number a
 *   fact about the shop rather than about the query.
 *
 *   And the PAGE was still chosen by longest-unseen and only then re-sorted by
 *   distance, so "nearest first" ordered the sixty shops he had not seen in
 *   longest — a shop two hundred metres away that he called on last week was
 *   not on the list at all, on a screen whose header says nearest sorts first.
 *   The LIMIT has to sort by the same thing the screen does or the cap and the
 *   order disagree, exactly as the city filter had to move into SQL for the
 *   cap to mean anything.
 *
 * The SQL orders on a flat-earth square of the distance rather than the great
 * circle: SQLite here has no trigonometry to call, and over one town a plain
 * `Δlat² + (Δlng · cos lat)²` is monotone in the real distance, which is all an
 * ORDER BY needs. The exact haversine still decides the order of the rows that
 * come back — the held ticks are merged in there — so the number on the screen
 * and the order it is in cannot disagree.
 */
export async function pickCandidates(
  city: string | null,
  query = '',
  keep: string[] = [],
  opts: { forToday?: boolean; fix?: { lat: number; lng: number } | null } = {},
): Promise<{ rows: Candidate[]; total: number; origin: { lat: number; lng: number } | null }> {
  const q = query.trim().toLowerCase();
  const here = (city ?? '').trim().toLowerCase();

  /*
   * IN THE TOWN, not spelled exactly as the town. `customers.city` holds
   * whatever the sheet typed, and much of it is a whole postal address —
   * "06, Mahadev Towers, LBS Marg, Thane, Maharashtra, 400602" — so an exact
   * match left those shops out of a Thane day. The town as one of the
   * address's comma-separated parts, or as the shop's area, counts too.
   */
  const inTown = `(lower(trim(COALESCE(city,''))) = ? OR lower(trim(COALESCE(area,''))) = ?
       OR (',' || replace(lower(COALESCE(city,'')), ', ', ',') || ',') LIKE ?)`;
  const townArgs = here ? [here, here, `%,${here},%`] : [];

  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (here) {
    clauses.push(inTown);
    args.push(...townArgs);
  }
  if (q) {
    clauses.push(`(lower(name) LIKE ? OR lower(COALESCE(area,'')) LIKE ?)`);
    args.push(`%${q}%`, `%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const COLS = `id, name, area, city, beat, outstandingPaise, lastVisitDate, lastOrderDate, gpsLat, gpsLng`;

  /* The middle of our business in that town, asked of the CITY and never of
     the page. The search box narrows what is listed; it must not move what the
     listing is measured from. */
  const centre = await one<{ lat: number | null; lng: number | null }>(
    `SELECT AVG(gpsLat) AS lat, AVG(gpsLng) AS lng
       FROM customers
      WHERE gpsLat IS NOT NULL AND gpsLng IS NOT NULL
            ${here ? `AND ${inTown}` : ''}`,
    townArgs,
  );

  const origin = pickOrigin({
    fix: opts.fix ?? null,
    forToday: opts.forToday ?? false,
    /* One element, and it is already the mean of them — `pickOrigin` averages
       what it is given, so handing it the centroid hands it the centroid. The
       rule about WHICH point to use stays in the engine, where the route screen
       can read it too. */
    cityShops:
      centre?.lat != null && centre?.lng != null ? [{ lat: centre.lat, lng: centre.lng }] : [],
  });

  /* Asked of SQLite rather than of the array. A capped list that counts itself
     reports sixty shops on a book of a thousand and nothing says otherwise. */
  const counted = await one<{ n: number }>(`SELECT COUNT(*) AS n FROM customers ${where}`, args);

  /* A shop with no pin cannot be measured and sorts LAST rather than being
     dropped — the route engine's rule, for its reason: a shop missing from the
     day's list is a shop nobody visits and nobody ever finds out why. */
  const squash = origin ? Math.cos((origin.lat * Math.PI) / 180) ** 2 : 0;
  const nearestFirst = `(gpsLat IS NULL OR gpsLng IS NULL) ASC,
        ((gpsLat - ?) * (gpsLat - ?)) + ((gpsLng - ?) * (gpsLng - ?) * ?) ASC,
        name ASC`;
  const longestUnseen = `lastVisitDate IS NULL DESC, lastVisitDate ASC, name ASC`;

  const page = await all<Candidate>(
    `SELECT ${COLS}
       FROM customers ${where}
      ORDER BY ${origin ? nearestFirst : longestUnseen}
      LIMIT ${PICK_PAGE}`,
    origin ? [...args, origin.lat, origin.lat, origin.lng, origin.lng, squash] : args,
  );

  /* Already-ticked shops are never cut. A shop ticked, then searched past, then
     found again outside the cap would come back with its number gone — and the
     number IS the plan, because it is the order he means to walk. */
  const missing = keep.filter((id) => !page.some((r) => r.id === id));
  const held = missing.length
    ? await all<Candidate>(
        `SELECT ${COLS} FROM customers WHERE id IN (${missing.map(() => '?').join(',')})`,
        missing,
      )
    : [];

  const rows = [...held, ...page];
  const total = counted?.n ?? rows.length;

  if (!origin) return { rows, total, origin };

  const far = Number.POSITIVE_INFINITY;
  const away = (r: Candidate) =>
    r.gpsLat != null && r.gpsLng != null
      ? haversineMetres(origin, { lat: r.gpsLat, lng: r.gpsLng })
      : far;

  return { rows: [...rows].sort((x, y) => away(x) - away(y)), total, origin };
}

/**
 * The shops already picked for a day, so reopening the screen shows them.
 *
 * Two sources, in this order, and the order is the point. `journey_stops` is
 * what the OFFICE issued — the real route, and the one to walk. `pickedIds` is
 * what this handset ASKED for, held on the day row because the stops are
 * minted server-side and arrive on the next pull: without it, backing out of
 * this screen and returning before that pull showed nothing ticked, and twelve
 * shops chosen in a doorway had to be chosen again.
 */
export async function pickedFor(planDayId: string): Promise<string[]> {
  /*
   * AN EDIT NOT YET SENT IS THE NEWER ANSWER. `pickShops` writes the list to
   * `pickedIds` and queues it; the stop rows below are what the office last
   * sent and stay as they were until the next pull. Reading them first meant
   * reopening a day he had just changed showed the shops he had just taken
   * off — so on a queued day the list he sent wins.
   */
  const queued = await one<{ pickedIds: string | null }>(
    "SELECT pickedIds FROM journey_days WHERE id = ? AND syncState = 'queued' AND pickedIds IS NOT NULL",
    [planDayId],
  );
  if (queued?.pickedIds) {
    const ids = parseIds(queued.pickedIds);
    if (ids) return ids;
  }

  /* Stops are keyed by the DATE here rather than by the day's id — the handset
     table came down flat, one row per stop with its `planDate`, and adding a
     plan id to it would be a second way of saying the same thing. */
  const rows = await all<{ customerId: string }>(
    `SELECT s.customerId FROM journey_stops s
       JOIN journey_days d ON d.planDate = s.planDate
      WHERE d.id = ? ORDER BY s.seq`,
    [planDayId],
  );
  if (rows.length) return rows.map((r) => r.customerId);

  const day = await one<{ pickedIds: string | null }>(
    'SELECT pickedIds FROM journey_days WHERE id = ?',
    [planDayId],
  );
  if (!day?.pickedIds) return [];
  /* A row nobody can parse is a row nobody picked. Losing the ticks is bad;
     failing the screen that would let somebody re-tick them is worse. */
  return parseIds(day.pickedIds) ?? [];
}

function parseIds(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/** The shops picked for a day, in order, with what the screen needs to name them. */
export async function pickedShops(
  planDayId: string,
): Promise<{ customerId: string; name: string; area: string | null; outstandingPaise: number }[]> {
  const ids = await pickedFor(planDayId);
  if (!ids.length) return [];
  const rows = await all<{ id: string; name: string; area: string | null; city: string | null; outstandingPaise: number | null }>(
    `SELECT id, name, area, city, outstandingPaise FROM customers WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const c = byId.get(id);
    return {
      customerId: id,
      /* A shop that has left his book since he picked it keeps its line; the
         server drops it and says so. Naming it "a shop" is the honest answer. */
      name: c?.name ?? 'A shop no longer in your list',
      area: c?.area ?? c?.city ?? null,
      outstandingPaise: c?.outstandingPaise ?? 0,
    };
  });
}

/* ------------------------------------------------------------ a day, looked back on */

export type ShopDay = {
  stopId: string;
  customerId: string;
  name: string;
  area: string | null;
  seq: number;
  status: string;
  plannedAt: string | null;
  arrivedAt: number | null;
  skipReason: string | null;
  visit: {
    checkInAt: number | null;
    checkOutAt: number | null;
    durationSeconds: number | null;
    outcome: string | null;
    notes: string | null;
  } | null;
  orders: {
    id: string;
    valuePaise: number | null;
    lines: number | null;
    orderNo: string | null;
    /** What was on it, where this phone took it — the office's copy carries a count, not the lines. */
    items: { name: string; cans: number }[];
    at: number | null;
  }[];
  payments: { id: string; amountPaise: number; mode: string | null; at: number | null }[];
  /** Everything else the timeline holds for this shop on this day. */
  other: { id: string; summary: string; at: number }[];
};

/**
 * What happened at each shop on one day — the stop, the visit, the order, the
 * money, and anything else the timeline knows about that shop that day.
 *
 * TWO SOURCES FOR ORDERS AND MONEY, de-duplicated by id: what this phone
 * took itself (`orders`, `payments`) and the office's copy
 * (`customer_orders`, `customer_payments`). Either alone misses half — a
 * phone reinstalled last week has none of its own, and an order taken this
 * morning has not reached the office's copy yet.
 *
 * Days are compared as DATES. The office sends its order and receipt dates
 * already as Kolkata dates; the phone's own instants are turned into local
 * dates here with `isoDate`, never by slicing an ISO string, which answers in
 * UTC and files a 2am order on the day before.
 */
export async function dayHistory(planDate: string): Promise<ShopDay[]> {
  const stops = await all<{
    id: string;
    customerId: string;
    seq: number;
    status: string;
    plannedAt: string | null;
    actualAt: number | null;
    skipReason: string | null;
    name: string | null;
    area: string | null;
    city: string | null;
  }>(
    `SELECT s.id, s.customerId, s.seq, s.status, s.plannedAt, s.actualAt, s.skipReason,
            c.name, c.area, c.city
       FROM journey_stops s
       LEFT JOIN customers c ON c.id = s.customerId
      WHERE s.planDate = ?
      ORDER BY s.seq`,
    [planDate],
  );
  if (!stops.length) return [];

  const ids = stops.map((s) => s.customerId);
  const marks = ids.map(() => '?').join(',');
  /* A window a day wider at each end, narrowed to the date in JS — the SQL
     never has to know what zone the phone is in. */
  const from = new Date(`${planDate}T00:00:00`).getTime() - 86_400_000;
  const to = from + 3 * 86_400_000;
  const onDay = (ms: number | null) => ms != null && isoDate(new Date(ms)) === planDate;

  const [visits, ownOrders, officeOrders, ownPayments, officePayments, timeline] = await Promise.all([
    all<{ customerId: string; checkInAt: number | null; checkOutAt: number | null; durationSeconds: number | null; outcome: string | null; notes: string | null }>(
      `SELECT customerId, checkInAt, checkOutAt, durationSeconds, outcome, notes FROM visits
        WHERE customerId IN (${marks}) AND checkInAt BETWEEN ? AND ? ORDER BY checkInAt`,
      [...ids, from, to],
    ),
    all<{ id: string; customerId: string; orderedAt: number; netTotalPaise: number | null; orderNumber: string | null }>(
      `SELECT id, customerId, orderedAt, netTotalPaise, orderNumber FROM orders
        WHERE customerId IN (${marks}) AND orderedAt BETWEEN ? AND ?`,
      [...ids, from, to],
    ),
    all<{ id: string; customerId: string; valuePaise: number | null; lines: number | null; orderNo: string | null }>(
      `SELECT id, customerId, valuePaise, lines, orderNo FROM customer_orders
        WHERE customerId IN (${marks}) AND orderedAt = ?`,
      [...ids, planDate],
    ),
    all<{ id: string; customerId: string; amountPaise: number; mode: string | null; collectedAt: number }>(
      `SELECT id, customerId, amountPaise, mode, collectedAt FROM payments
        WHERE customerId IN (${marks}) AND collectedAt BETWEEN ? AND ?`,
      [...ids, from, to],
    ),
    all<{ id: string; customerId: string; amountPaise: number | null; mode: string | null }>(
      `SELECT id, customerId, amountPaise, mode FROM customer_payments
        WHERE customerId IN (${marks}) AND substr(receivedAt, 1, 10) = ?`,
      [...ids, planDate],
    ),
    all<{ id: string; customerId: string; eventType: string; summary: string; occurredAt: number }>(
      `SELECT id, customerId, eventType, summary, occurredAt FROM timeline_events
        WHERE customerId IN (${marks}) AND occurredAt BETWEEN ? AND ? ORDER BY occurredAt`,
      [...ids, from, to],
    ),
  ]);

  const ownOrderIds = ownOrders.map((o) => o.id);
  const lineRows = ownOrderIds.length
    ? await all<{ orderId: string; productName: string; cans: number }>(
        `SELECT orderId, productName, cans FROM order_lines WHERE orderId IN (${ownOrderIds.map(() => '?').join(',')})`,
        ownOrderIds,
      )
    : [];
  const itemsOf = (orderId: string) =>
    lineRows.filter((l) => l.orderId === orderId).map((l) => ({ name: l.productName, cans: l.cans }));

  return stops.map((s) => {
    const visit = visits.find((v) => v.customerId === s.customerId && onDay(v.checkInAt)) ?? null;
    const orders = new Map<string, ShopDay['orders'][number]>();
    for (const o of ownOrders) {
      if (o.customerId === s.customerId && onDay(o.orderedAt)) {
        const items = itemsOf(o.id);
        orders.set(o.id, { id: o.id, valuePaise: o.netTotalPaise, lines: items.length || null, orderNo: o.orderNumber, items, at: o.orderedAt });
      }
    }
    for (const o of officeOrders) {
      if (o.customerId === s.customerId && !orders.has(o.id)) {
        orders.set(o.id, { id: o.id, valuePaise: o.valuePaise, lines: o.lines, orderNo: o.orderNo, items: [], at: null });
      }
    }
    const payments = new Map<string, ShopDay['payments'][number]>();
    for (const p of ownPayments) {
      if (p.customerId === s.customerId && onDay(p.collectedAt)) {
        payments.set(p.id, { id: p.id, amountPaise: p.amountPaise, mode: p.mode, at: p.collectedAt });
      }
    }
    for (const p of officePayments) {
      if (p.customerId === s.customerId && !payments.has(p.id) && p.amountPaise != null) {
        payments.set(p.id, { id: p.id, amountPaise: p.amountPaise, mode: p.mode, at: null });
      }
    }
    /* The timeline restates visits, orders and payments too; those are drawn
       from their own rows above, so only what is left is listed here. */
    const other = timeline
      .filter((t) => t.customerId === s.customerId && onDay(t.occurredAt) && !/visit|order|payment|receipt|bill/i.test(t.eventType))
      .map((t) => ({ id: t.id, summary: t.summary, at: t.occurredAt }));
    return {
      stopId: s.id,
      customerId: s.customerId,
      name: s.name ?? 'A shop no longer in your list',
      area: s.area ?? s.city,
      seq: s.seq,
      status: s.status,
      plannedAt: s.plannedAt,
      arrivedAt: s.actualAt,
      skipReason: s.skipReason,
      visit: visit
        ? { checkInAt: visit.checkInAt, checkOutAt: visit.checkOutAt, durationSeconds: visit.durationSeconds, outcome: visit.outcome, notes: visit.notes }
        : null,
      orders: [...orders.values()],
      payments: [...payments.values()],
      other,
    };
  });
}

export async function planDay(id: string): Promise<PlanDay | null> {
  return (await one<PlanDay>('SELECT * FROM journey_days WHERE id = ?', [id])) ?? null;
}

/**
 * The shops he picked, in the order he means to walk them.
 *
 * **The payload is the WHOLE answer, not a difference.** Sending a shorter
 * list is how a shop is unpicked, and a merge on the server would make that
 * impossible — the same reasoning as the reorder above, one level up.
 *
 * Local first, then queued, like every other write here. The day moves to
 * `planned` immediately so the screen reflects the decision rather than the
 * network; the pull is what confirms it, and it is entitled to disagree.
 */
export async function pickShops(
  planDayId: string,
  customerIds: string[],
): Promise<{ ok: boolean; message?: string }> {
  /* AN EMPTY PICK CLEARS THE DAY. The office takes it — the day goes back to
     agreed — and the picker used to refuse it, so a day planned by mistake
     could not be emptied from the phone at all. */
  await run(
    `UPDATE journey_days
        SET dayState = ?, picked = ?, pickedIds = ?, syncState = 'queued'
      WHERE id = ?`,
    [customerIds.length ? 'planned' : 'agreed', customerIds.length, JSON.stringify(customerIds), planDayId],
  );

  await enqueue({
    entityType: 'plan_stops',
    entityId: planDayId,
    op: 'update',
    /* Picking shops for next Tuesday is planning, done wherever he happens to
       be sitting. See `plan_day` above. */
    location: false,
    payload: { id: planDayId, customerIds },
  });

  return { ok: true };
}
