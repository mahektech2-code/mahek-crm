import { handlePromoFeedRequest } from "@/lib/promo-feed";
import { getPromoRecord, listPromoRecords, promoFacets } from "@/lib/services/promo-feed-service";

/* ---------------------------------------------------------------------------
 * GET /api/integrations/promo/v1/recipients
 *   ?scope=active|lost&kind=lead|customer&q=&state=&district=&city=&owner=&salesManager=
 *   &stage=&status=&sort=&page=&pageSize=
 *
 * The Promotional App's read-only window onto leads and customers (see
 * `lib/promo-feed.ts` for the contract): one page at a time, at most 100
 * records, with the total. Not open: a caller sends
 * `Authorization: Bearer $PROMO_FEED_SECRET`, and without that variable set the
 * route refuses rather than answering — the same fail-closed rule
 * /api/hrms/sync follows. POST, PUT, PATCH and DELETE answer 405; HEAD and
 * OPTIONS are Next's own and return no data.
 *
 * It writes nothing and returns no phone number, address, tax number, credit
 * figure, location fix or note.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

const handle = (request: Request) => handlePromoFeedRequest(request, { secret: process.env.PROMO_FEED_SECRET, list: listPromoRecords, facets: promoFacets, get: getPromoRecord });

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
