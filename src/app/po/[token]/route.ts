import { publicPoPdf } from "@/lib/erp/po-share";

/**
 * A SHARED PURCHASE ORDER — the PDF behind the link in every PO a vendor is
 * sent. No sign-in: the token is the key, twenty random characters minted the
 * first time the PO was shared. It answers only while the PO is one a vendor
 * may act on; a cancelled or sent-back PO, or a token that names nothing,
 * answers the same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const pdf = await publicPoPdf(token);
  if (!pdf) return new Response("This purchase order link is not valid any more.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(Buffer.from(pdf.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${pdf.filename}"`,
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    },
  });
}
