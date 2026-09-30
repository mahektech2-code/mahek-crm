import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { hrmsOffices } from "@/db/schema";
import { hrmsContext } from "@/lib/hrms/access";
import { hrmsLink } from "@/lib/hrms/registry";
import { encodeQr, qrSvgPath } from "@/lib/hrms/qr";
import { PageHeader } from "@/components/ui/primitives";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Office QR code — HRMS — MahekOne" };

/**
 * An office's attendance QR code, printable (spec §5.1). The source asked
 * Google Chart's service for the image; this draws it here, from the office's
 * own QR text, so a code never leaves MahekOne to be rendered.
 */
export default async function OfficeQrPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await hrmsContext();
  if (!ctx.screens.has("offices")) redirect("/hrms");
  const [office] = await db.select().from(hrmsOffices).where(eq(hrmsOffices.id, id)).limit(1);
  if (!office) notFound();
  const back = hrmsLink("offices", { open: office.id });

  if (!office.qrText) {
    return (
      <div>
        <PageHeader title={office.name} subtitle="This office has no attendance QR text yet. Give it one on the office’s Edit form, then print." />
        <Link href={back}>Back to the office</Link>
      </div>
    );
  }

  let svg: { d: string; viewBox: string } | null = null;
  try {
    svg = qrSvgPath(encodeQr(office.qrText));
  } catch {
    svg = null;
  }

  return (
    <div>
      {/* Printing leaves the sheet and nothing else: no shell, no buttons. */}
      <style>{`@media print { body * { visibility: hidden !important; } #qr-sheet, #qr-sheet * { visibility: visible !important; } #qr-sheet { position: absolute; inset: 0; margin: auto; border: none !important; } }`}</style>
      <PageHeader
        title="Office QR code"
        subtitle="Print it and put it where people check in. Scanning it checks them in to this office."
        actions={
          <div className="flex items-center gap-2">
            <Link href={back} className="text-[13px]">
              Back to the office
            </Link>
            {svg ? <PrintButton /> : null}
          </div>
        }
      />
      <section id="qr-sheet" className="mx-auto grid max-w-[420px] justify-items-center gap-3 rounded-[8px] border border-line bg-white p-8 text-center">
        <h2 className="text-[22px] font-semibold text-ink">{office.name}</h2>
        {office.address ? <p className="text-[13px] text-muted">{office.address}</p> : null}
        {svg ? (
          <svg viewBox={svg.viewBox} width={280} height={280} role="img" aria-label={`QR code: ${office.qrText}`} shapeRendering="crispEdges">
            <rect width="100%" height="100%" fill="#fff" />
            <path d={svg.d} fill="#000" />
          </svg>
        ) : (
          <p className="text-[13px] text-danger">The QR text is too long to draw as a code. Shorten it on the office’s Edit form.</p>
        )}
        <p className="font-mono text-[14px] tracking-wide text-ink">{office.qrText}</p>
        <p className="text-[12px] text-muted">Scan with MahekOne HRMS to check in</p>
      </section>
    </div>
  );
}
