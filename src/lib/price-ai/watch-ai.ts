import "server-only";
import { z } from "zod";
import { askEither, PROVIDER_LABEL } from "@/lib/price-ai/providers";
import { APPROVAL_LABEL, type WatchReport } from "@/lib/engines/price-watch";

/* ---------------------------------------------------------------------------
 * THE PATTERN SUMMARY on Watch — where the money below the book concentrates,
 * who gives it away with nothing on record approving it, and which of it
 * looks agreed. Every figure in the prompt was computed by code; the model is
 * asked to READ them, never to compute or change a price. Advice only.
 * ------------------------------------------------------------------------- */

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const summarySchema = z.object({
  summary: z.string().describe("Three or four plain sentences: where the money given away concentrates."),
  concentrations: z.array(z.string()).describe("Up to five short points naming shops, products or people, with the figures given."),
  unapproved: z
    .array(z.object({ person: z.string(), note: z.string() }))
    .describe("People who billed below the book with nothing on record approving it. Only names from the evidence."),
  looksApproved: z.array(z.string()).describe("Groups whose discount has an override, an approved request or an ERP authorisation behind it."),
});

export type WatchSummary =
  | {
      ok: true;
      by: string;
      summary: string;
      concentrations: string[];
      unapproved: Array<{ person: string; note: string }>;
      looksApproved: string[];
    }
  | { ok: false; reason: string };

export async function aiSummariseWatch(input: {
  report: WatchReport;
  from: string;
  to: string;
  userId: string;
}): Promise<WatchSummary> {
  const { report } = input;
  const top = report.byShopProduct.slice(0, 60);
  if (!top.length) return { ok: false, reason: "Nothing was billed below the book in this window, so there is no pattern to read." };

  const groups = top
    .map(
      (g, i) =>
        `${i + 1}. ${g.customerName} — ${g.productName}: book ${g.listExPaise == null ? "—" : rupees(g.listExPaise)} ex-GST, billed ${rupees(g.billedMinPaise)}–${rupees(g.billedMaxPaise)} (median ${rupees(g.billedMedianPaise)}), ${g.lines} lines, ${g.cans} cans, given away ${rupees(g.givenAwayPaise)}, unapproved ${rupees(g.unapprovedPaise)}; taken by ${g.people.join(", ")}; source ${g.sources.join("/")}; approval on record: ${g.approvals.length ? g.approvals.map((a) => APPROVAL_LABEL[a]).join(", ") : "none"}.`,
    )
    .join("\n");
  const people = report.byPerson
    .filter((p) => p.givenAwayPaise > 0)
    .slice(0, 20)
    .map((p) => `- ${p.name}: ${p.belowLines} of ${p.lines} priced lines below, given away ${rupees(p.givenAwayPaise)}, unapproved ${rupees(p.unapprovedPaise)}, ${p.shops} shops.`)
    .join("\n");
  const t = report.totals;

  const answer = await askEither({
    feature: "watch_summary",
    subject: { kind: "price_watch", id: `${input.from}..${input.to}` },
    userId: input.userId,
    timeoutSeconds: 45,
    schema: summarySchema,
    system: [
      "You read a paint company's order lines billed below its own price book and say where the money goes.",
      "Every figure is given to you already computed. Never compute a new price, never suggest one, never approve anything.",
      "Name only shops, products and people that appear in the evidence. Say plainly when a discount has approval on record.",
      "Write short, plain English for an owner. Rupees are ex-GST.",
    ].join(" "),
    prompt: [
      `Window: ${input.from} to ${input.to}.`,
      `Totals: ${t.lines} lines, ${t.priced} priced, ${t.on} on the book, ${t.below} below, ${t.above} above, ${t.unpriced} with no book price. Given away ${rupees(t.givenAwayPaise)}, of which ${rupees(t.unapprovedPaise)} has nothing on record approving it.`,
      "",
      "Top shop × product groups by money given away:",
      groups,
      "",
      "By person:",
      people || "(none)",
    ].join("\n"),
  });
  if (!answer.ok) return { ok: false, reason: answer.reason };
  return { ok: true, by: PROVIDER_LABEL[answer.provider], ...answer.output };
}
