import { handlePromoRecordRequest } from "@/lib/promo-feed";
import { getPromoRecord, listPromoRecords, promoFacets } from "@/lib/services/promo-feed-service";

/* ---------------------------------------------------------------------------
 * GET /api/integrations/promo/v1/recipients/{id}
 *
 * One lead or customer by id, so a link to a record keeps working whatever
 * page it was on and whether or not anyone has listed it since a restart. The
 * same bearer secret, the same allow-listed fields and the same eligibility as
 * the list (see `lib/promo-feed.ts`): a lead in the trash, or an id that does
 * not exist, is 404. It takes no query string. Read only: GET answers; POST,
 * PUT, PATCH and DELETE are 405.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const handle = async (request: Request, { params }: Context) => {
  const { id } = await params;
  return handlePromoRecordRequest(request, id, { secret: process.env.PROMO_FEED_SECRET, list: listPromoRecords, facets: promoFacets, get: getPromoRecord });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
