import { handlePromoFacetsRequest } from "@/lib/promo-feed";
import { getPromoRecord, listPromoRecords, promoFacets } from "@/lib/services/promo-feed-service";

/* ---------------------------------------------------------------------------
 * GET /api/integrations/promo/v1/facets?kind=lead|customer
 *
 * The values the Promotional App's filters can take (states, districts,
 * cities, owners, sales managers, stages, statuses), each with how many
 * eligible records carry it. Same secret, same refusals, same read-only
 * promise as /recipients. See `lib/promo-feed.ts`.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

const handle = (request: Request) => handlePromoFacetsRequest(request, { secret: process.env.PROMO_FEED_SECRET, list: listPromoRecords, facets: promoFacets, get: getPromoRecord });

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
