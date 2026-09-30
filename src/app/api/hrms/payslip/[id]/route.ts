import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { db } from "@/db";
import { employees, hrmsSalaries } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { fdLong } from "@/lib/erp/ui";
import { hrmsContext } from "@/lib/hrms/access";
import { figuresOf, mayOpenPayslip } from "@/lib/hrms/screens/pay";
import { monLabel } from "@/lib/hrms/time";

/**
 * A salary's payslip (spec §18.2), drawn on request from the salary's FROZEN
 * figures — never from today's attendance — so the paper always says what was
 * approved and paid. Regenerating changes the payslip code printed on it.
 *
 * The employee opens their own once it is Paid; whoever runs or pays payroll
 * opens any. Anything else — including a salary that does not exist — answers
 * 404, so this URL cannot be used to learn who was paid what.
 */
export const runtime = "nodejs";

const A4: [number, number] = [595.28, 841.89];
const M = 40;
const INK = rgb(0.086, 0.086, 0.086);
const MUTED = rgb(0.42, 0.45, 0.52);
const LINE = rgb(0.8, 0.82, 0.86);
const BAND = rgb(0.95, 0.95, 0.97);

/** Paise → "Rs. 18,420.00": the standard font has no rupee sign. */
function rs(paise: number | null | undefined): string {
  const n = Number(paise ?? 0) / 100;
  const s = Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}Rs. ${s}`;
}

const num = (v: number | null | undefined) => (Number(v ?? 0) % 1 === 0 ? String(Number(v ?? 0)) : Number(v ?? 0).toFixed(2));

/** Text the standard font can encode; anything else becomes "?" rather than failing the file. */
function safe(text: string, font: PDFFont): string {
  let out = "";
  for (const ch of text.replace(/₹\s*/g, "Rs. ").replace(/[−–—]/g, "-")) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await hrmsContext();
  const notFound = () => new NextResponse("Not found", { status: 404 });
  if (!ctx.level) return notFound();

  const [s] = await db.select().from(hrmsSalaries).where(eq(hrmsSalaries.id, id));
  if (!s || !mayOpenPayslip(ctx, s)) return notFound();
  const [e] = await db
    .select({ name: employees.name, code: employees.employeeCode, position: employees.position, office: employees.officeName })
    .from(employees)
    .where(eq(employees.id, s.employeeId));
  const f = figuresOf(s);
  const company = (await getConfig())["people.companyName"] || "Mahek Marketing India";

  const doc = await PDFDocument.create();
  doc.setTitle(`Payslip ${monLabel(s.month)} · ${e?.name ?? ""}`);
  const page: PDFPage = doc.addPage(A4);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [W, H] = A4;
  let y = H - M;

  const text = (t: string, x: number, yy: number, o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {}) => {
    const font = o.font ?? reg;
    page.drawText(safe(t, font), { x, y: yy, size: o.size ?? 9, font, color: o.color ?? INK });
  };
  const right = (t: string, xr: number, yy: number, o: { size?: number; font?: PDFFont } = {}) => {
    const font = o.font ?? reg;
    const s2 = safe(t, font);
    page.drawText(s2, { x: xr - font.widthOfTextAtSize(s2, o.size ?? 9), y: yy, size: o.size ?? 9, font, color: INK });
  };
  const rule = (yy: number) => page.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: 0.6, color: LINE });

  /* Letterhead */
  text(company, M, y - 14, { size: 16, font: bold });
  right(`Payslip · ${monLabel(s.month)}`, W - M, y - 14, { size: 12, font: bold });
  y -= 34;
  text(`${e?.name ?? ""} · ${e?.code ?? ""}${e?.position ? ` · ${e.position}` : ""}${e?.office ? ` · ${e.office}` : ""}`, M, y, { size: 10 });
  right(`Salary ID ${s.salaryNo}`, W - M, y, { size: 9 });
  y -= 10;
  rule(y);
  y -= 22;

  /* Three columns: attendance, earnings, deductions. */
  const colW = (W - 2 * M - 24) / 3;
  const cols: { title: string; rows: [string, string][] }[] = [
    {
      title: "Attendance",
      rows: [
        ["Days in month", num(s.daysInMonth)],
        ["Full days", num(f.fullDays)],
        ["Half days", num(f.halfDays)],
        ["Paid leave", num(f.paidLeave)],
        ["Unpaid leave", num(f.unpaidLeave)],
        ["Leave days", num(f.leaveDays)],
        ["Holidays inside leave", num(f.holidaysInsideLeave)],
        ["Official holidays", num(f.officialHolidays)],
        ["Compensation days", num(f.compDays)],
        ["Attendance count", num(f.attendanceCount)],
        ["Late check-ins", `${num(f.lateCount)} (${num(f.lateHalfDays)} half-days)`],
      ],
    },
    {
      title: "Earnings",
      rows: [
        ["Fixed salary", rs(f.fixedPaise)],
        ["Basic", rs(f.basicPaise)],
        ["Incentive", rs(f.incentivePaise)],
        ["Conveyance", rs(f.conveyancePaise)],
        ["Special allowance", rs(f.specialPaise)],
        ["Gross earning", rs(f.grossPaise)],
      ],
    },
    {
      title: "Deductions",
      rows: [
        ["Employee PF", rs(f.pfPaise)],
        ["Employee ESIC", rs(f.esicPaise)],
        ["Professional tax", rs(f.ptPaise)],
        ["Advance deduction", rs(f.advanceDeductionPaise)],
        ["Late deduction", rs(f.lateDeductionPaise)],
        ["Gross deduction", rs(f.grossDeductionPaise)],
      ],
    },
  ];
  let lowest = y;
  cols.forEach((c, i) => {
    const x = M + i * (colW + 12);
    let yy = y;
    page.drawRectangle({ x, y: yy - 4, width: colW, height: 16, color: BAND });
    text(c.title, x + 4, yy, { size: 9, font: bold });
    yy -= 18;
    c.rows.forEach(([l, v], j) => {
      const last = j === c.rows.length - 1 && c.title !== "Attendance";
      text(l, x + 4, yy, { size: 8.5, font: last ? bold : reg, color: last ? INK : MUTED });
      right(v, x + colW - 4, yy, { size: 8.5, font: last ? bold : reg });
      yy -= 14;
    });
    lowest = Math.min(lowest, yy);
  });
  y = lowest - 6;
  rule(y);
  y -= 26;

  /* The figure the page exists for. */
  text("Salary in hand", M, y, { size: 13, font: bold });
  right(rs(f.inHandPaise), W - M, y, { size: 15, font: bold });
  y -= 18;
  if (f.otherPaymentPaise) {
    text(`Other payment ${rs(f.otherPaymentPaise)} — paid separately, not part of salary in hand`, M, y, { size: 9, color: MUTED });
    y -= 16;
  }
  y -= 6;
  rule(y);
  y -= 20;

  text("Employer contributions", M, y, { size: 9, font: bold });
  y -= 14;
  for (const [l, v] of [
    ["Employer PF", rs(f.employerPfPaise)],
    ["Employer ESIC", rs(f.employerEsicPaise)],
    ["CTC gross", rs(f.ctcPaise)],
  ] as [string, string][]) {
    text(l, M + 4, y, { size: 8.5, color: MUTED });
    right(v, M + 4 + colW, y, { size: 8.5 });
    y -= 13;
  }
  y -= 8;

  text("Payment", M, y, { size: 9, font: bold });
  y -= 14;
  const pay: [string, string][] = [
    ["PF/ESIC applicable", `${f.pfEsic ?? ""}${f.uanNo ? ` · UAN ${f.uanNo}` : ""}${f.esicNo ? ` · ESIC ${f.esicNo}` : ""}`],
    ["Bank details", f.bank ?? ""],
    ["Payment UTR no.", s.utr ?? (s.status === "Paid" ? "" : `Not paid yet · ${s.status}`)],
    ["Payment date", s.paidOn ? fdLong(s.paidOn) : "—"],
    ["Salary date", fdLong(s.salaryDate)],
  ];
  for (const [l, v] of pay) {
    text(l, M + 4, y, { size: 8.5, color: MUTED });
    text(v, M + 120, y, { size: 8.5 });
    y -= 13;
  }

  text(`Payslip ${s.payslipCode ?? ""} · This is a computer-generated payslip.`, M, M, { size: 7.5, color: MUTED });

  const bytes = await doc.save();
  const file = `payslip-${e?.code ?? "employee"}-${s.month}.pdf`;
  const download = new URL(request.url).searchParams.get("download") === "1";
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${file}"`,
      "cache-control": "private, no-store",
    },
  });
}
