/**
 * The book's reads, as SQL and nothing else.
 *
 * Pure on purpose. Everything below builds a string and a parameter list and
 * touches no database, which is what makes it testable against a real SQLite
 * without a handset — and this is exactly the code that needs it. A distance
 * ordering is arithmetic with six repeated parameters in it; whether they are
 * bound in the right order is not a thing anybody can see by reading, and
 * getting it wrong sorts the book by nonsense rather than failing.
 *
 * The same reasoning `lib/wire.ts` gives for living where it does: a mapping
 * written inline in the call site needs a device to exercise, so it never is.
 */

/**
 * A PAGE OF THE BOOK IS FIFTEEN SHOPS, however big the territory is.
 *
 * The list used to read every row and render every one, and it survived only
 * because the book was empty — the pull had never once landed, so every
 * handset had nothing to draw. The first sync that worked put two thousand
 * rows on a phone, the screen built two thousand cards on the JS thread, and
 * Android offered to close the app.
 *
 * One constant, so the first read, the Load more button and the sentence
 * counting them cannot disagree.
 */
export const CUSTOMER_PAGE = 15;

/** Where to measure from: a fix, a city's centre, or nothing. */
export type Origin = { lat: number; lng: number } | null;

export type Query = { sql: string; params: (string | number)[] };

/* Name, contact, city, phone, GST and dealer code — because a salesman looking
   somebody up mid-conversation has whichever of those the customer just said. */
const SEARCH = `lower(name) LIKE ? OR lower(COALESCE(contactPerson,'')) LIKE ?
     OR lower(COALESCE(city,'')) LIKE ? OR COALESCE(phone,'') LIKE ?
     OR lower(COALESCE(gstin,'')) LIKE ? OR lower(COALESCE(dealerCode,'')) LIKE ?`;

function searchParams(q: string): string[] {
  const like = `%${q}%`;
  return [like, like, like, like, like, like];
}

function normalise(query: string | undefined): string {
  return (query ?? '').trim().toLowerCase();
}

/** How many shops MATCH — the number the screen prints, never a loaded length. */
export function customerCountQuery(query?: string): Query {
  const q = normalise(query);
  return q
    ? { sql: `SELECT COUNT(*) AS n FROM customers WHERE ${SEARCH}`, params: searchParams(q) }
    : { sql: 'SELECT COUNT(*) AS n FROM customers', params: [] };
}

/**
 * One page of the book, nearest first.
 *
 * NO TRIGONOMETRY IN SQL. SQLite has `cos` only where it was compiled with the
 * math extension, and whether Expo's build carries it is not a thing to bet a
 * screen on. So the one cosine is taken in JavaScript — the latitude scaling
 * for the ORIGIN, which is identical for every row being compared — and SQL is
 * left with multiplication. Over a beat, that equirectangular approximation and
 * a great-circle distance agree to far less than the width of a street, and
 * this is a SORT: it has to get the order right, not the metres.
 *
 * The squared distance is never rooted. Ordering by d² is ordering by d, and
 * the root is arithmetic nobody reads.
 *
 * A shop with no coordinates sorts LAST and is still there. Half this book has
 * never been pinned, and dropping those rows would empty the only screen that
 * lists them — a worse answer than putting them under the ones we can place.
 *
 * `id` ends every ordering. A great many shops share a name and, near an
 * origin, a distance; a page boundary falling inside a tie shows one row twice
 * and another not at all. The web app has a test that pages 55 bills for
 * exactly this reason.
 */
export function customerPageQuery(args: {
  query?: string;
  origin?: Origin;
  limit?: number;
  offset?: number;
} = {}): Query {
  const q = normalise(args.query);
  const limit = args.limit ?? CUSTOMER_PAGE;
  const offset = args.offset ?? 0;
  const origin = args.origin ?? null;

  const where = q ? `WHERE ${SEARCH}` : '';
  const whereParams = q ? searchParams(q) : [];

  if (!origin) {
    return {
      sql: `SELECT * FROM customers ${where} ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`,
      params: [...whereParams, limit, offset],
    };
  }

  const kx = Math.cos((origin.lat * Math.PI) / 180);
  /* The SELECT list is bound BEFORE the WHERE, because that is the order the
     placeholders appear in the statement. Six of them, all in the projection. */
  return {
    sql: `SELECT *,
            CASE WHEN gpsLat IS NULL OR gpsLng IS NULL THEN NULL
                 ELSE ((gpsLat - ?) * (gpsLat - ?))
                    + (((gpsLng - ?) * ?) * ((gpsLng - ?) * ?))
            END AS dist2
          FROM customers ${where}
          ORDER BY (dist2 IS NULL), dist2, name COLLATE NOCASE, id
          LIMIT ? OFFSET ?`,
    params: [
      origin.lat, origin.lat,
      origin.lng, kx, origin.lng, kx,
      ...whereParams,
      limit, offset,
    ],
  };
}

/** Degrees of latitude to metres. Good to a few parts in ten thousand. */
const METRES_PER_DEGREE = 111_320;

/**
 * The `dist2` a page carries, as metres.
 *
 * Deliberately here, beside the SQL that produced it, because the two share a
 * definition: `dist2` is squared degrees with longitude already scaled by
 * cos(latitude), so the conversion is one square root and one constant. Put
 * this anywhere else and the day the ordering changes shape, the number on the
 * card goes on being computed the old way and quietly disagrees with the order
 * the rows are in.
 *
 * That shared origin is the point. A card cannot show a smaller distance than
 * the card above it, because the figure it prints and the figure it was sorted
 * by are the same number.
 */
export function metresFromDist2(dist2: number | null | undefined): number | null {
  if (dist2 == null || !Number.isFinite(dist2) || dist2 < 0) return null;
  return Math.sqrt(dist2) * METRES_PER_DEGREE;
}

/**
 *
 * Built from the book rather than from a list of town names typed into a
 * screen — the same rule the web app states about product lists, for the same
 * reason: the day somebody sells into a new town, a hardcoded list is wrong and
 * nothing says so. A city with no pinned shop cannot be an origin, so it is not
 * offered as one.
 */
export function cityOriginsQuery(limit = 40): Query {
  return {
    sql: `SELECT city AS city, COUNT(*) AS n,
                 AVG(gpsLat) AS lat, AVG(gpsLng) AS lng
            FROM customers
           WHERE city IS NOT NULL AND trim(city) <> ''
             AND gpsLat IS NOT NULL AND gpsLng IS NOT NULL
           GROUP BY lower(trim(city))
           ORDER BY n DESC, city COLLATE NOCASE
           LIMIT ?`,
    params: [limit],
  };
}
