import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { has, hrmsContext } from "@/lib/hrms/access";
import { allPeople } from "@/lib/hrms/services/people";
import { REVIEW_QUESTIONS, canSeePoints, pointLines, pointsFor } from "@/lib/hrms/screens/perf";
import { fdShort } from "@/lib/hrms/time";
import { today } from "@/lib/hrms/server";

/**
 * The performance-points report (spec §12.4, §18.3): every count, point and
 * the total for one employee over a period, and the four review answers.
 * Drawn on request from the same `pointsFor` the screen reads, so the paper
 * and the row cannot disagree; "Regenerate" moves the version printed on it.
 *
 * Opened by whoever holds the performance powers (perfAdmin, HR, admin), or
 * the Performance points screen within its own scope. Anything else — an
 * unknown employee included — answers 404, so the URL cannot be used to learn
 * how somebody is doing.
 */
export const runtime = "nodejs";

const A4: [number, number] = [595.28, 841.89];
const M = 40;
const INK = rgb(0.086, 0.086, 0.086);
const MUTED = rgb(0.42, 0.45, 0.52);
const LINE = rgb(0.8, 0.82, 0.86);
const BAND = rgb(0.95, 0.95, 0.97);

/** Text the standard font can encode; anything else becomes "?" rather than failing the file. */
function safe(text: string, font: PDFFont): string {
  let out = "";
  for (const ch of text.replace(/₹\s*/g, "Rs. ").replace(/[−–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

/** Splits a paragraph into lines that fit `width` at `size`. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of safe(text, font).split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

const iso = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export async function GET(request: Request) {
  const ctx = await hrmsContext();
  const notFound = () => new NextResponse("Not found", { status: 404 });
  if (!ctx.level) return notFound();
  const wide = has(ctx, "perfAdmin") || has(ctx, "hr") || ctx.administrator;
  if (!wide && !ctx.screens.has("points")) return notFound();

  const q = new URL(request.url).searchParams;
  const emp = q.get("emp") ?? "";
  const t = today();
  const from = iso(q.get("from")) ?? `${t.slice(0, 7)}-01`;
  const to = iso(q.get("to")) ?? t;
  if (to < from) return notFound();

  const people = await allPeople();
  const person = people.find((p) => p.id === emp);
  if (!person || !canSeePoints(ctx, people, person.id)) return notFound();

  const { rows, financialDate } = await pointsFor([person], from, to);
  const r = rows[0];
  if (!r) return notFound();

  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(`Performance report · ${person.name} · ${from} to ${to}`);
  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - M;
  const width = A4[0] - M * 2;

  const ensure = (h: number) => {
    if (y - h < M + 20) {
      page = doc.addPage(A4);
      y = A4[1] - M;
    }
  };
  const text = (s: string, x: number, at: number, o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {}) =>
    page.drawText(safe(s, o.font ?? regular), { x, y: at, size: o.size ?? 9, font: o.font ?? regular, color: o.color ?? INK });

  text("Mahek Marketing India", M, y, { size: 9, color: MUTED });
  y -= 20;
  text("Performance report", M, y, { size: 16, font: bold });
  y -= 18;
  text(`${person.name}${person.code ? ` · ${person.code}` : ""} · ${person.positionType ?? ""}${person.office ? ` · ${person.office}` : ""}`, M, y, { size: 10 });
  y -= 14;
  text(`${fdShort(from)} ${from.slice(0, 4)} – ${fdShort(to)} ${to.slice(0, 4)}`, M, y, { size: 9, color: MUTED });
  y -= 18;

  const total = Math.round(r.points.total * 1000) / 10;
  page.drawRectangle({ x: M, y: y - 26, width, height: 30, color: BAND });
  text("Total", M + 8, y - 16, { size: 10, font: bold });
  text(`${total}%`, M + width - 8 - bold.widthOfTextAtSize(`${total}%`, 12), y - 17, { size: 12, font: bold });
  y -= 44;

  text("Counts and points", M, y, { size: 11, font: bold });
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: M + width, y }, thickness: 0.6, color: LINE });
  y -= 14;
  for (const line of pointLines(r, financialDate)) {
    const vLines = wrap(line.v, regular, 9, width - 200);
    ensure(vLines.length * 12 + 4);
    text(line.l, M + 4, y, { size: 9, color: MUTED });
    vLines.forEach((v, i) => text(v, M + 200, y - i * 12, { size: 9, font: line.l === "Total" ? bold : regular }));
    y -= vLines.length * 12 + 3;
  }

  y -= 10;
  ensure(30);
  text("Review", M, y, { size: 11, font: bold });
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: M + width, y }, thickness: 0.6, color: LINE });
  y -= 14;
  for (const qq of REVIEW_QUESTIONS) {
    const answer = r.review?.[qq.k]?.trim() || "Not answered";
    const lines = wrap(answer, regular, 9, width - 8);
    ensure(14 + lines.length * 12);
    text(qq.l, M + 4, y, { size: 9, font: bold });
    y -= 13;
    for (const l of lines) {
      ensure(12);
      text(l, M + 4, y, { size: 9, color: r.review?.[qq.k]?.trim() ? INK : MUTED });
      y -= 12;
    }
    y -= 6;
  }

  const version = r.review?.pdfCode ?? "1";
  doc.getPages().forEach((p) =>
    p.drawText(safe(`Report version ${version} · drawn ${fdShort(t)} from the live figures · computer-generated`, regular), { x: M, y: M - 10, size: 7.5, font: regular, color: MUTED }),
  );

  const bytes = await doc.save();
  const file = `performance-${person.code || "employee"}-${from}-${to}.pdf`;
  const download = q.get("download") === "1";
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${file}"`,
      "cache-control": "private, no-store",
    },
  });
}
