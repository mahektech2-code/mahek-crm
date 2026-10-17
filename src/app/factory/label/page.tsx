import { redirect } from "next/navigation";
import { factoryContext } from "@/lib/factory/server";
import { encodeQr, qrSvgPath } from "@/lib/hrms/qr";
import { PrintOnOpen } from "./print-on-open";

export const dynamic = "force-dynamic";

/**
 * The lot label the floor sticks on a tank, a pallet or a batch: the code as
 * a QR that scans back to the same code, and the words a person reads beside
 * it. Sized for a 50 × 30 mm thermal label and printed from the phone's own
 * print dialog — the station printer is whatever that phone is paired with.
 */
export default async function FactoryLabel({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await factoryContext())) redirect("/factory");
  const sp = await searchParams;
  const code = String(sp.code ?? "").slice(0, 60);
  let path = "", viewBox = "0 0 29 29";
  try {
    ({ d: path, viewBox } = qrSvgPath(encodeQr(code), 2));
  } catch {}
  return (
    <div className="lbl-page">
      <style>{`
        @page { size: 50mm 30mm; margin: 0 }
        body { margin: 0; background: #E6E8EE }
        .lbl-page { display: flex; align-items: center; justify-content: center; min-height: 100vh }
        .lbl { width: 50mm; height: 30mm; background: #fff; display: flex; gap: 2mm; padding: 2mm; align-items: center; font-family: 'Google Sans Flex', system-ui, sans-serif; color: #1A1E28 }
        .lbl svg { width: 25mm; height: 25mm; flex: none }
        .lbl .k { font-size: 5pt; font-weight: 700; letter-spacing: .06em; color: #6B7385 }
        .lbl .c { font-family: 'IBM Plex Mono', monospace; font-size: 8pt; font-weight: 600; margin-top: 1mm; word-break: break-all }
        .lbl .n { font-size: 6.5pt; margin-top: .6mm; line-height: 1.15 }
        .lbl .m { font-size: 5.5pt; color: #6B7385; margin-top: .6mm }
        @media print { body { background: #fff } .lbl-page { min-height: 0 } }
      `}</style>
      <div className="lbl">
        <svg viewBox={viewBox} shapeRendering="crispEdges" role="img" aria-label={"QR " + code}>
          <rect width="100%" height="100%" fill="#fff" />
          <path d={path} fill="#000" />
        </svg>
        <div style={{ minWidth: 0 }}>
          <div className="k">MAHEK ONE · LOT LABEL</div>
          <div className="c">{code}</div>
          <div className="n">{sp.name ?? ""}</div>
          <div className="m">{[sp.meta, sp.loc].filter(Boolean).join(" · ")}</div>
        </div>
      </div>
      <PrintOnOpen />
    </div>
  );
}
