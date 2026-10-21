import { createRateLimiter, handlePromoWhatsappTargetRequest } from "@/lib/promo-whatsapp-target";
import { getPromoWhatsappTarget } from "@/lib/services/promo-whatsapp-target-service";

/* ---------------------------------------------------------------------------
 * GET /api/integrations/promo/v1/recipients/{id}/whatsapp-target?scope=lost
 *
 * One LOST lead's WhatsApp number, for the Promotional App's "open this lead's chat" button and nothing else (see
 * `lib/promo-whatsapp-target.ts`). Not part of the feed: no list, facet, count or by-id answer carries a number.
 *
 * Its own bearer secret, `PROMO_WHATSAPP_TARGET_SECRET`: without it the endpoint refuses every request, and it also refuses if it
 * is the same value as PROMO_FEED_SECRET (a leak of the general feed secret must not be able to read a number). `scope=lost` must be
 * named. The number is returned only for a lead that is lost, not archived, not trashed, not Do Not Contact and not WhatsApp Do
 * Not Disturb, checked now; otherwise it is null, or the answer is 404. At most 30 answers a minute. Read only: GET answers;
 * POST, PUT, PATCH and DELETE are 405.
 *
 * PROMO_WHATSAPP_DEFAULT_COUNTRY is optional and off by default: see the rule in `lib/promo-whatsapp-target.ts`.
 * ------------------------------------------------------------------------- */

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// one limiter for the whole endpoint, shared by every method so a flood of any kind counts
const limiter = createRateLimiter();

const handle = async (request: Request, { params }: Context) => {
  const { id } = await params;
  return handlePromoWhatsappTargetRequest(request, id, {
    secret: process.env.PROMO_WHATSAPP_TARGET_SECRET,
    feedSecret: process.env.PROMO_FEED_SECRET,
    defaultCountry: process.env.PROMO_WHATSAPP_DEFAULT_COUNTRY,
    target: getPromoWhatsappTarget,
    limiter,
  });
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
