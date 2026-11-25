import { Card } from "@/components/ui/primitives";
import { shortDate } from "@/lib/format";
import type { ProviderSummary } from "@/lib/engines/read-trial";
import { ReadBillsButton } from "./read-trial-button";

/* ---------------------------------------------------------------------------
 * The reading trial's results — Sarvam beside OpenAI on our own photographs.
 * Counts only; the table behind it holds verdicts, never a value read.
 * ------------------------------------------------------------------------- */

const NAME: Record<string, string> = { openai: "OpenAI", sarvam: "Sarvam" };

const BILL_FIELDS: [string, string][] = [
  ["amount", "Amount"],
  ["billNumber", "Bill number"],
  ["billDate", "Bill date"],
];

const CARD_FIELDS: [string, string][] = [
  ["businessName", "Shop name"],
  ["contactPerson", "Contact person"],
  ["mobile", "Mobile"],
  ["city", "Town"],
  ["address", "Address"],
  ["gstin", "GSTIN"],
];

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");
const secs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);

export function ReadTrialSection({
  summary,
  billsPerRun,
  keys,
  leadScan,
}: {
  summary: { leadScan: ProviderSummary[]; expenseBill: ProviderSummary[]; days: number; since: Date | null };
  billsPerRun: number;
  keys: { openai: boolean; sarvam: boolean };
  leadScan: { provider: string; trial: boolean };
}) {
  const missing = !keys.openai ? "OpenAI" : !keys.sarvam ? "Sarvam" : null;
  return (
    <div className="grid gap-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="m-0 text-[15px] font-bold text-ink">Expense bills</h3>
            <p className="m-0 mt-1 max-w-[640px] text-[13px] text-muted">
              Each bill photo is read by both and scored against what the salesman typed beside it. The typed amount is what
              he claimed, which can be less than the bill, so neither reader can score 100% on amount; compare the two, not
              each against perfect.
            </p>
          </div>
          <ReadBillsButton bills={billsPerRun} disabledWhy={missing ? `Needs the ${missing} key, which is not set.` : null} />
        </div>
        <Results
          rows={summary.expenseBill}
          empty="No bills read yet. Press “Read bills with both”."
          fields={BILL_FIELDS}
          cell={(s, f) => {
            const v = s.fields[f] ?? {};
            const scored = (v.right ?? 0) + (v.wrong ?? 0) + (v.missed ?? 0);
            return scored ? `${pct(v.right ?? 0, scored)} right of ${scored}` : "—";
          }}
        />
      </Card>

      <Card>
        <h3 className="m-0 text-[15px] font-bold text-ink">Visiting card scans</h3>
        <p className="m-0 mt-1 max-w-[640px] text-[13px] text-muted">
          {leadScan.trial
            ? `On: every scan is also read by ${leadScan.provider === "openai" ? "Sarvam" : "OpenAI"} after the salesman has his answer.`
            : "Off. Turn on “Trial the other reader on every scan” under Settings → Voice & AI to collect these — it sends each card photo to both companies."}{" "}
          A scan keeps no photo and no reading, so this is agreement, not accuracy — except the GSTIN, whose checksum says
          whether a reading can be right. {NAME[leadScan.provider] ?? leadScan.provider} reads first.
        </p>
        <Results
          rows={summary.leadScan}
          empty="No scans compared yet."
          fields={[]}
          cell={() => ""}
        />
        <Agreement rows={summary.leadScan} />
      </Card>

      <p className="m-0 text-[12px] text-muted">
        The last {summary.days} days{summary.since ? `, since ${shortDate(summary.since)}` : ""}. Times are the middle reading
        time of the reads that succeeded.
      </p>
    </div>
  );
}

function Results({
  rows,
  empty,
  fields,
  cell,
}: {
  rows: ProviderSummary[];
  empty: string;
  fields: [string, string][];
  cell: (s: ProviderSummary, field: string) => string;
}) {
  if (rows.length === 0) return <p className="m-0 mt-3 text-[13px] text-muted">{empty}</p>;
  const cols = `minmax(90px,1fr) repeat(${2 + fields.length}, minmax(110px,1fr))`;
  return (
    <div className="mt-3 overflow-x-auto text-[13px]">
      <div className="grid gap-x-3 border-b border-divider pb-1 font-semibold text-muted" style={{ gridTemplateColumns: cols }}>
        <span>Reader</span>
        <span>Read · failed</span>
        <span>Time</span>
        {fields.map(([, label]) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      {rows.map((s) => (
        <div key={s.provider} className="grid gap-x-3 py-1.5 tabular-nums text-ink" style={{ gridTemplateColumns: cols }}>
          <span className="font-semibold">{NAME[s.provider] ?? s.provider}</span>
          <span>
            {s.reads} · {s.failed}
          </span>
          <span>{secs(s.medianMs)}</span>
          {fields.map(([f]) => (
            <span key={f}>{cell(s, f)}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The comparison is kept on Sarvam's rows, once per scan. */
function Agreement({ rows }: { rows: ProviderSummary[] }) {
  const sarvam = rows.find((r) => r.provider === "sarvam");
  if (!sarvam || Object.keys(sarvam.fields).length === 0) return null;
  const count = (f: string, v: string) => sarvam.fields[f]?.[v] ?? 0;
  const cols = "minmax(110px,1fr) repeat(4, minmax(90px,1fr))";
  return (
    <div className="mt-4 overflow-x-auto text-[13px]">
      <div className="grid gap-x-3 border-b border-divider pb-1 font-semibold text-muted" style={{ gridTemplateColumns: cols }}>
        <span>Field</span>
        <span>Same</span>
        <span>Differ</span>
        <span>Only OpenAI</span>
        <span>Only Sarvam</span>
      </div>
      {CARD_FIELDS.map(([f, label]) => (
        <div key={f} className="grid gap-x-3 py-1 tabular-nums text-ink" style={{ gridTemplateColumns: cols }}>
          <span>{label}</span>
          <span>{count(f, "same")}</span>
          <span>{count(f, "differs")}</span>
          <span>{count(f, "only_openai")}</span>
          <span>{count(f, "only_sarvam")}</span>
        </div>
      ))}
      <p className="m-0 mt-2 text-muted">
        GSTIN passing its checksum — OpenAI {count("gstinCheck_openai", "valid") + count("gstinCheck_openai", "corrected")},
        Sarvam {count("gstinCheck_sarvam", "valid") + count("gstinCheck_sarvam", "corrected")}; failing it — OpenAI{" "}
        {count("gstinCheck_openai", "invalid")}, Sarvam {count("gstinCheck_sarvam", "invalid")}.
      </p>
    </div>
  );
}
