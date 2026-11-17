import { s3Config } from "@/lib/storage";
import { getConfig } from "@/lib/config/store";
import { definition } from "@/lib/config/registry";
import { sizeLine, storageSummary } from "@/lib/services/admin-console-service";
import { AdminPage } from "../_shell/admin-page";
import { requirePlatformAdmin } from "../_shell/context";
import { Card, CardHead, Pill } from "../_shell/kit";
import { storageExtras } from "./data";
import { KeptFor, StoreCheckButton, SweepButton, type KeepRow } from "./storage-client";

/**
 * STORAGE & FILES — what the attachment store holds, by kind, and how long
 * each kind is kept. The windows are the settings that already enforce them,
 * edited here through the same audited write the Settings screen uses.
 */

const KIND_WORDS: Record<string, string> = {
  mbos_visit: "Visit photos",
  mbos_attendance: "Selfies",
  mbos_travel_leg: "Odometer",
  mbos_expense: "Expense bills",
  complaint: "Complaint photos",
  payment_receipt: "Payment proofs",
  erp_invoice: "Invoices (PDF)",
  erp_lr: "LR & signed copies",
  feedback: "Feedback screenshots",
  feedback_message: "Feedback screenshots",
};

/** Where the windows are enforced, said beside each. */
const KEEP: { key: string; unit: string; schedule: string; isNew?: boolean }[] = [
  { key: "mbos.attendance.selfieRetentionHours", unit: "hours", schedule: "Hourly" },
  { key: "bankStatements.pdfRetentionDays", unit: "days", schedule: "Hourly" },
  { key: "attachments.orphanCleanupHours", unit: "hours", schedule: "Nightly" },
  { key: "attachments.removedRetentionDays", unit: "days", schedule: "Nightly" },
];

const nf = new Intl.NumberFormat("en-IN");

export default async function StoragePage() {
  await requirePlatformAdmin();
  const [s, extra, config] = await Promise.all([storageSummary(), storageExtras(), getConfig()]);
  const c = config as unknown as Record<string, unknown>;

  /* Kinds grouped by the words people use, biggest first; the long tail is "Other". */
  const grouped = new Map<string, { bytes: number; files: number }>();
  for (const k of s.kinds) {
    const label = KIND_WORDS[k.kind] ?? words(k.kind);
    const g = grouped.get(label) ?? { bytes: 0, files: 0 };
    g.bytes += k.bytes;
    g.files += k.files;
    grouped.set(label, g);
  }
  const sorted = [...grouped.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  const shown = sorted.slice(0, 6);
  const rest = sorted.slice(6).reduce((acc, [, g]) => ({ bytes: acc.bytes + g.bytes, files: acc.files + g.files }), { bytes: 0, files: 0 });
  if (rest.files) shown.push(["Other", rest]);
  const biggest = Math.max(1, ...shown.map(([, g]) => g.bytes));

  const keep: KeepRow[] = KEEP.flatMap((k) => {
    const def = definition(k.key);
    const v = Number(c[k.key]);
    return def && Number.isFinite(v) ? [{ ...k, label: def.label, value: v }] : [];
  });

  return (
    <AdminPage
      title={
        <span className="inline-flex items-center gap-2.5">
          Storage &amp; files
          <Pill tone="muted">{s3Config() ? "Bucket (R2)" : "Postgres"}</Pill>
        </span>
      }
      actions={
        <>
          <StoreCheckButton />
          <SweepButton />
        </>
      }
      figures={[
        { label: "Database", value: sizeLine(extra.databaseBytes), navy: true },
        { label: "Files", value: nf.format(s.files) },
        { label: "Size", value: sizeLine(s.bytes) },
        { label: "Swept · 24 h", value: nf.format(extra.sweptDay) },
        { label: "Attached to nothing", value: nf.format(s.unattached), tone: s.unattached ? "warn" : undefined, sub: s.removed ? `${nf.format(s.removed)} removed` : undefined },
      ]}
    >
      <div className="grid items-start gap-[18px] lg:grid-cols-2">
        <Card>
          <CardHead title="By kind" />
          {shown.length === 0 ? (
            <div className="px-[18px] py-8 text-center text-muted">Nothing is stored yet.</div>
          ) : (
            <div className="flex flex-col gap-3.5 p-[18px]">
              {shown.map(([label, g]) => (
                <div key={label} className="grid grid-cols-[150px_minmax(0,1fr)_70px] items-center gap-3" title={`${nf.format(g.files)} files`}>
                  <span className="truncate">{label}</span>
                  <div className="h-2.5 overflow-hidden rounded-[5px] bg-divider">
                    <i className="block h-full bg-brand" style={{ width: `${(g.bytes / biggest) * 100}%` }} />
                  </div>
                  <b className="text-right font-bold text-ink tabular-nums">{sizeLine(g.bytes)}</b>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <CardHead title="Kept for" />
          <KeptFor rows={keep} largest={s.largest ? { size: sizeLine(s.largest.bytes), name: s.largest.filename } : null} />
        </Card>
      </div>
    </AdminPage>
  );
}

/** `mbos_visit` → "Mbos visit". */
function words(code: string): string {
  const w = code.replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
}
