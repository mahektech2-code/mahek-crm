import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "@/db";
import { hireOffers } from "@/db/schema";
import { hireContext } from "@/lib/hire/access";
import { audit, getApplication } from "@/lib/hire/services/core";
import { letterFor } from "@/lib/hire/services/offers";

/**
 * The offer letter as a PDF. The text is the same template the preview draws,
 * from the offer's own figures, so the PDF and the screen cannot differ.
 * Scope-checked like every Hire read; not found and not allowed are one 404.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ offerId: string }> }) {
  const notFound = () => new Response("Not found", { status: 404 });
  const ctx = await hireContext();
  if (!ctx) return notFound();
  const { offerId } = await params;
  const [o] = await db.select().from(hireOffers).where(eq(hireOffers.id, offerId)).limit(1);
  if (!o) return notFound();
  const b = await getApplication(ctx, o.applicationId);
  if (!b || !(ctx.can("offer") || ctx.can("onboard"))) return notFound();

  const text = o.letter ?? letterFor(b, o, o.issuedAt);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  /* The standard fonts are WinAnsi: the rupee sign and Indic scripts are not
     in it, so they are spelt out rather than dropped. */
  const safe = (s: string) =>
    s
      .replace(/₹/g, "Rs. ")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/·/g, "-")
      .replace(/[^\x20-\x7E -ÿ—–]/g, "?");
  const W = 595;
  const H = 842;
  const M = 56;
  const size = 11;
  const lh = 16;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const wrap = (line: string, f = font) => {
    const words = line.split(" ");
    const out: string[] = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(t, size) > W - 2 * M && cur) {
        out.push(cur);
        cur = w;
      } else cur = t;
    }
    out.push(cur);
    return out;
  };
  const lines = safe(text).split("\n");
  lines.forEach((raw, i) => {
    const isHead = i === 0 || raw === "Growth plan";
    for (const l of raw === "" ? [""] : wrap(raw, isHead ? bold : font)) {
      if (y < M + lh) {
        page = pdf.addPage([W, H]);
        y = H - M;
      }
      page.drawText(l, { x: M, y, size: i === 0 ? 14 : size, font: isHead ? bold : font, color: rgb(0.1, 0.12, 0.16) });
      y -= i === 0 ? lh + 6 : lh;
    }
  });
  if (o.status === "draft") page.drawText("DRAFT - not issued", { x: M, y: M - 20, size: 9, font: bold, color: rgb(0.54, 0.36, 0.02) });
  const bytes = await pdf.save();
  await audit(ctx, { applicationId: o.applicationId, candidateId: b.candidate.id, entityType: "offer", entityId: o.id, eventType: "offer_pdf", summary: `Downloaded the offer letter PDF (${o.status})` });
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="offer-${b.candidate.code}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
