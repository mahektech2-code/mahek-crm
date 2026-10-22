"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { bankDiscardUpload, bankEditUploadRows, bankImportUpload, bankUploadStatus } from "@/lib/actions/bank-statements";
import { addDays } from "@/lib/business-date";
import type { CheckedRow } from "@/lib/engines/bank-statements";
import type { UploadDetail } from "@/lib/services/bank-statement-service";
import { Btn, Conf, Dialog, FieldLabel, figure, inputCls, inr, LinkBtn, Note, Pill, dayLabel, istDay } from "./bank-ui";

/* ---------------------------------------------------------------------------
 * UPLOADING A STATEMENT — three steps in one dialog, as the mockups draw it:
 * choose the PDF, the AI reads it (the screen polls while it does, and can be
 * closed), check what was read and import the new lines.
 * ------------------------------------------------------------------------- */

export type UploadAccount = {
  id: string;
  name: string;
  last4: string | null;
  accountType: string | null;
  mark: { letters: string; color: string };
  lastUploadAt: string | null;
};

const STEPS = ["Choose the PDF", "AI reads it", "Check and import"];

export function UploadFlow({
  open,
  onClose,
  accounts,
  today,
  retentionDays,
  maxPdfMb,
  initial,
  lastLabel,
  canRecord,
}: {
  open: boolean;
  onClose: () => void;
  accounts: UploadAccount[];
  today: string;
  retentionDays: number;
  maxPdfMb: number;
  /** An upload to open straight at its reading or its review. */
  initial: string | null;
  lastLabel: (at: string | null) => string;
  canRecord: boolean;
}) {
  const [uploadId, setUploadId] = React.useState<string | null>(initial);
  const [detail, setDetail] = React.useState<UploadDetail | null>(null);
  const phase: "choose" | "reading" | "review" = !uploadId ? "choose" : detail && detail.status !== "reading" && detail.status !== "failed" ? "review" : "reading";

  React.useEffect(() => {
    if (!uploadId) return;
    let stop = false;
    const tick = async () => {
      const d = await bankUploadStatus(uploadId);
      if (stop) return;
      setDetail(d);
      if (d && d.status === "reading") setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [uploadId]);

  if (phase === "choose")
    return (
      <ChooseStep
        open={open}
        onClose={onClose}
        accounts={accounts}
        today={today}
        retentionDays={retentionDays}
        maxPdfMb={maxPdfMb}
        lastLabel={lastLabel}
        canRecord={canRecord}
        onStarted={(id) => setUploadId(id)}
      />
    );
  if (phase === "reading")
    return (
      <ReadingStep
        open={open}
        onClose={onClose}
        detail={detail}
        onRetry={() => {
          setUploadId(null);
          setDetail(null);
        }}
      />
    );
  return <ReviewStep open={open} onClose={onClose} detail={detail!} onDetail={setDetail} canRecord={canRecord} />;
}

/* ------------------------------------------------------------- 1 · choose */

function ChooseStep({
  open,
  onClose,
  accounts,
  today,
  retentionDays,
  maxPdfMb,
  lastLabel,
  canRecord,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  accounts: UploadAccount[];
  today: string;
  retentionDays: number;
  maxPdfMb: number;
  lastLabel: (at: string | null) => string;
  canRecord: boolean;
  onStarted: (id: string) => void;
}) {
  const [account, setAccount] = React.useState(accounts[0]?.id ?? "");
  const [file, setFile] = React.useState<File | null>(null);
  const [password, setPassword] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const keptUntil = dayLabel(addDays(today, retentionDays));
  const chosen = accounts.find((a) => a.id === account);

  async function send() {
    if (!file || !account) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    form.set("accountId", account);
    if (password.trim()) form.set("password", password.trim());
    if (note.trim()) form.set("note", note.trim());
    try {
      const res = await fetch("/api/accounts/bank-statements/upload", { method: "POST", body: form });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) setError(body.error ?? "The PDF could not be uploaded.");
      else onStarted(body.id);
    } catch {
      setError("The PDF could not be uploaded. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function pick(f: File | null | undefined) {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") {
      setError(`${f.name} is not a PDF.`);
      return;
    }
    if (f.size > maxPdfMb * 1024 * 1024) {
      setError(`${f.name} is ${(f.size / 1024 / 1024).toFixed(1)} MB. The limit is ${maxPdfMb} MB — set on Accounts → Settings.`);
      return;
    }
    setError(null);
    setFile(f);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Upload bank PDF"
      steps={STEPS}
      step={0}
      width={760}
      top={110}
      foot={
        <>
          <span className="text-[11.5px] text-muted">Lines already imported from an earlier upload are skipped automatically.</span>
          <Btn className="ml-auto" onClick={onClose}>
            Cancel
          </Btn>
          <Btn tone="primary" disabled={!file || !account || busy || !canRecord} onClick={send} title={canRecord ? undefined : "Uploading needs the payment.record permission on Accounts."}>
            {busy ? "Uploading…" : "Read statement →"}
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-3.5 px-5 py-4">
        <div>
          <FieldLabel required>Bank account</FieldLabel>
          {accounts.length ? (
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(4, accounts.length)}, minmax(0, 1fr))` }}>
              {accounts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAccount(a.id)}
                  className={cx(
                    "flex cursor-pointer items-start gap-[9px] rounded-[10px] border bg-surface px-[11px] py-[9px] text-left text-[12px] text-muted",
                    account === a.id ? "border-brand bg-[#fbfaff] shadow-[0_0_0_3px_var(--color-brand-soft)]" : "border-line hover:border-line-strong",
                  )}
                >
                  <span className={cx("mt-0.5 h-[15px] w-[15px] flex-none rounded-full", account === a.id ? "border-[5px] border-brand" : "border-[1.6px] border-line-strong")} />
                  <span className="min-w-0">
                    <b className="block truncate text-[12.8px] text-ink">
                      {a.name.replace(/\s*(bank|mahindra)\s*$/i, "")}
                      {a.last4 ? ` ··${a.last4}` : ""}
                    </b>
                    {a.accountType ?? "Account"} · last {lastLabel(a.lastUploadAt)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <Note tone="w">No bank account is set up. Add one with “Bank accounts” first.</Note>
          )}
        </div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pick(e.dataTransfer.files?.[0]);
          }}
          onClick={() => input.current?.click()}
          className={cx("cursor-pointer rounded-[14px] border-2 border-dashed p-[26px] text-center text-muted", drag ? "border-brand bg-brand-soft" : "border-brand-softer bg-[#fbfaff]")}
        >
          <b className="mb-1 block text-[14px] text-brand-deep">Drop the statement PDF here</b>
          or click to choose · PDF up to {maxPdfMb} MB · any number of pages · no password needed unless the PDF asks for one
          <input ref={input} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        </div>
        {file ? (
          <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-[9px]">
            <i className="grid h-[34px] w-7 flex-none place-items-center rounded-[5px] bg-danger-soft text-[9px] font-extrabold text-danger not-italic">PDF</i>
            <div className="min-w-0">
              <b className="block truncate text-[13px] text-ink">{file.name}</b>
              <div className="text-[11.5px] text-muted">{(file.size / 1024 > 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`)}</div>
            </div>
            {chosen ? <Pill tone="brand" className="ml-auto">For {chosen.name}{chosen.last4 ? ` ··${chosen.last4}` : ""}</Pill> : null}
            <button type="button" onClick={() => setFile(null)} className="ml-2.5 cursor-pointer border-none bg-transparent text-[11.5px] text-muted hover:text-ink" aria-label="Remove the file">
              ✕
            </button>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-x-3.5 gap-y-3">
          <div>
            <FieldLabel hint="(if the bank locks it)">PDF password</FieldLabel>
            <input type="password" autoComplete="off" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave empty if it opens without one" />
            <div className="mt-1 text-[11.5px] text-muted">Used once to open the file. Not stored.</div>
          </div>
          <div>
            <FieldLabel hint="(optional)">Note</FieldLabel>
            <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. afternoon download" />
          </div>
        </div>
        {error ? <Note tone="r">{error}</Note> : null}
        <Note tone="i">
          <b>Kept for {retentionDays} days.</b> The PDF is stored so anybody can check a line against it until <b>{keptUntil}</b>, then deleted. The lines read from it stay for good.
        </Note>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------ 2 · reading */

function ReadingStep({ open, onClose, detail, onRetry }: { open: boolean; onClose: () => void; detail: UploadDetail | null; onRetry: () => void }) {
  const rawStep = detail?.step ?? "uploaded";
  const step = rawStep.split(" ")[0];
  const failed = detail?.status === "failed";
  // "reading 3/10": pieces of PAGES_PER_CALL pages read so far.
  const prog = /^reading (\d+)\/(\d+)$/.exec(rawStep);
  const done = prog ? Number(prog[1]) : 0;
  const total = prog ? Number(prog[2]) : 0;
  const pagesRead = detail?.pages && total ? Math.min(detail.pages, Math.round((done / total) * detail.pages)) : null;
  const [pct, setPct] = React.useState(8);
  React.useEffect(() => {
    if (failed) return;
    const floor = total ? 8 + (done / total) * 80 : 0;
    const t = setInterval(() => setPct((p) => Math.max(floor, Math.min(step === "checking" ? 96 : 88, p + (88 - p) * 0.06))), 600);
    return () => clearInterval(t);
  }, [step, failed, done, total]);
  const order = ["uploaded", "reading", "checking", "ready"];
  const at = Math.max(0, order.indexOf(step));
  const rows: { t: string; s: string; state: "d" | "a" | "w" }[] = [
    { t: "Uploaded and stored", s: detail ? `Kept until ${dayLabel(istDay(detail.pdfExpiresAt), true)}, then deleted` : "Storing the PDF", state: "d" },
    { t: "Account and period found", s: detail ? `${detail.account}${detail.last4 ? ` · ··${detail.last4}` : ""}${detail.periodFrom ? ` · ${detail.periodFrom} to ${detail.periodTo ?? "…"}` : ""}` : "", state: at >= 2 ? "d" : at === 1 ? "a" : "w" },
    { t: "Reading the transactions table", s: pagesRead != null && step === "reading" ? `${pagesRead} of ${detail?.pages} pages read · a few pages at a time` : "Date, narration, reference, debit, credit, balance", state: at >= 2 ? "d" : at === 1 ? "a" : "w" },
    { t: "Checking the balances", s: "Opening + credits − debits must equal closing, and every running balance must follow", state: at >= 3 ? "d" : at === 2 ? "a" : "w" },
    { t: "Finding what is already in", s: "Lines an earlier upload brought in are skipped", state: at >= 3 ? "d" : "w" },
  ];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Upload bank PDF"
      steps={STEPS}
      step={1}
      width={760}
      top={110}
      foot={
        failed ? (
          <>
            <Btn onClick={onClose}>Close</Btn>
            <Btn tone="primary" className="ml-auto" onClick={onRetry}>
              Upload again
            </Btn>
          </>
        ) : (
          <>
            <Btn onClick={onClose}>Run in background</Btn>
            <Btn tone="primary" className="ml-auto" disabled>
              Check and import →
            </Btn>
          </>
        )
      }
    >
      <div className="px-5 py-4">
        <div className="mb-3 flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-[9px]">
          <i className="grid h-[34px] w-7 flex-none place-items-center rounded-[5px] bg-danger-soft text-[9px] font-extrabold text-danger not-italic">PDF</i>
          <div className="min-w-0">
            <b className="block truncate text-[13px] text-ink">{detail?.fileName ?? "Statement"}</b>
            <div className="text-[11.5px] text-muted">
              {detail?.account ?? ""}
              {detail?.last4 ? ` ··${detail.last4}` : ""}
              {detail?.pages ? ` · ${detail.pages} page${detail.pages === 1 ? "" : "s"}` : ""}
            </div>
          </div>
          {failed ? <Pill tone="danger" className="ml-auto">Could not be read</Pill> : <Pill tone="ai" className="ml-auto">{step === "checking" ? "Checking the balances" : "Reading with AI"}</Pill>}
        </div>
        {failed ? (
          <Note tone="r">{detail?.error ?? "The PDF could not be read."}</Note>
        ) : (
          <>
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-divider">
              <span className="block h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            {rows.map((r, i) => (
              <div key={r.t} className={cx("flex gap-3 py-2.5", i < rows.length - 1 && "border-b border-dashed border-divider")}>
                <span
                  className={cx(
                    "grid h-6 w-6 flex-none place-items-center rounded-full text-[12px] font-extrabold",
                    r.state === "d" ? "bg-success text-white" : r.state === "a" ? "bg-brand text-white shadow-[0_0_0_4px_var(--color-brand-soft)]" : "bg-divider text-faint",
                  )}
                >
                  {r.state === "d" ? "✓" : i + 1}
                </span>
                <div>
                  <b className="block text-[13px] text-ink">{r.t}</b>
                  <small className="text-[11.8px] text-muted">{r.s}</small>
                </div>
              </div>
            ))}
            <Note tone="i" className="mt-1.5">
              You can close this window. Reading continues, and the statement waits under <b>Needs review</b> for you to check.
            </Note>
          </>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------- 3 · review */

type Edit = { date?: string; narration?: string; reference?: string | null; debitPaise?: number; creditPaise?: number; balancePaise?: number | null };

function ReviewStep({
  open,
  onClose,
  detail,
  onDetail,
  canRecord,
}: {
  open: boolean;
  onClose: () => void;
  detail: UploadDetail;
  onDetail: (d: UploadDetail) => void;
  canRecord: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = React.useState<"all" | "new" | "in" | "check">("all");
  const [q, setQ] = React.useState("");
  const [edits, setEdits] = React.useState<Record<number, Edit>>({});
  const [editing, setEditing] = React.useState<{ line: number; field: keyof Edit } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const imported = detail.status === "imported";
  const rows = detail.rows.map((r) => ({ ...r, ...(edits[r.lineNo] ?? {}) })) as CheckedRow[];
  const check = detail.check;
  const fresh = rows.filter((r) => !r.existing);
  const toCheck = rows.filter((r) => !r.existing && (r.breakHere || r.lowConfidence));
  const shown = rows
    .filter((r) => (tab === "new" ? !r.existing : tab === "in" ? r.existing : tab === "check" ? !r.existing && (r.breakHere || r.lowConfidence) : true))
    .filter((r) => !q.trim() || `${r.narration} ${r.reference ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  const dirty = Object.keys(edits).length > 0;
  const firstCheck = toCheck[0];

  async function saveEdits(): Promise<boolean> {
    if (!dirty) return true;
    const r = await bankEditUploadRows(
      detail.id,
      Object.entries(edits).map(([lineNo, e]) => ({ lineNo: Number(lineNo), ...e })),
    );
    if (!r.ok) {
      toast.push(r.error, "error");
      return false;
    }
    setEdits({});
    onDetail(r.data);
    return true;
  }

  async function doImport() {
    setBusy(true);
    try {
      if (!(await saveEdits())) return;
      const r = await toast.run(bankImportUpload(detail.id));
      if (r.ok) {
        onClose();
        router.push(`/accounts/bank-reconcile?account=${detail.accountId}`);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    setBusy(true);
    const r = await toast.run(bankDiscardUpload(detail.id));
    setBusy(false);
    if (r.ok) {
      onClose();
      router.refresh();
    }
  }

  const cell = (r: CheckedRow, field: keyof Edit, shownText: React.ReactNode, cls?: string) => {
    const on = editing?.line === r.lineNo && editing.field === field;
    const editable = !r.existing && !imported && canRecord;
    if (!on)
      return (
        <span
          onClick={() => editable && setEditing({ line: r.lineNo, field })}
          className={cx(editable && "cursor-text rounded-[4px] hover:bg-brand-soft", cls)}
          title={editable ? "Click to correct" : undefined}
        >
          {shownText}
        </span>
      );
    const isMoney = field === "debitPaise" || field === "creditPaise" || field === "balancePaise";
    const cur = r[field as keyof CheckedRow] as unknown;
    const start = isMoney ? (cur == null || cur === 0 ? "" : ((cur as number) / 100).toFixed(2)) : String(cur ?? "");
    return (
      <input
        autoFocus
        defaultValue={start}
        type={field === "date" ? "date" : "text"}
        inputMode={isMoney ? "decimal" : undefined}
        className="h-7 w-full min-w-[90px] rounded-[6px] border border-brand bg-surface px-1.5 text-[12.5px] text-ink outline-none"
        onBlur={(e) => {
          const v = e.target.value.trim();
          const next: Edit = { ...(edits[r.lineNo] ?? {}) };
          if (isMoney) {
            const p = v === "" ? (field === "balancePaise" ? null : 0) : Math.round(Number(v.replace(/[,₹\s]/g, "")) * 100);
            if (p != null && !Number.isFinite(p)) return setEditing(null);
            (next as Record<string, unknown>)[field] = p;
          } else (next as Record<string, unknown>)[field] = field === "reference" ? v || null : v;
          setEdits({ ...edits, [r.lineNo]: next });
          setEditing(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(null);
        }}
      />
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={1160}
      top={40}
      title={
        <>
          {detail.account}
          {detail.last4 ? ` ··${detail.last4}` : ""} · {detail.periodFrom ?? "?"} – {detail.periodTo ?? "?"}
        </>
      }
      aside={check.ok ? <Pill tone="ok" className="ml-1.5">Balances agree</Pill> : <Pill tone="flag" className="ml-1.5">Breaks at line {check.breaks[0]}</Pill>}
      steps={STEPS}
      step={imported ? 3 : 2}
      foot={
        <>
          <span className="text-[11.5px] text-muted">
            {detail.pdfKept ? `PDF kept until ${dayLabel(istDay(detail.pdfExpiresAt))} · open it beside this table` : "The PDF has been deleted · the lines are kept"}
          </span>
          {detail.pdfKept ? (
            <a href={`/api/accounts/bank-statements/${detail.id}/pdf`} target="_blank" rel="noreferrer" className="text-[12.5px] font-semibold text-brand hover:underline">
              View PDF ↗
            </a>
          ) : null}
          {imported ? (
            <Btn tone="primary" className="ml-auto" onClick={() => router.push(`/accounts/bank-reconcile?upload=${detail.id}&tab=all`)}>
              See its lines on Reconcile
            </Btn>
          ) : (
            <>
              <Btn tone="danger" className="ml-auto" disabled={busy || !canRecord} onClick={discard}>
                Discard upload
              </Btn>
              {dirty ? (
                <Btn disabled={busy} onClick={() => void saveEdits()}>
                  Check again
                </Btn>
              ) : null}
              <Btn tone="primary" disabled={busy || !canRecord || fresh.length === 0} onClick={doImport}>
                {busy ? "Importing…" : fresh.length ? `Import ${fresh.length} new line${fresh.length === 1 ? "" : "s"}` : "Nothing new to import"}
              </Btn>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        {detail.warnings.map((w) => (
          <Note key={w} tone="w">
            {w}
          </Note>
        ))}
        <div className={cx("flex flex-wrap items-center gap-2.5 rounded-[12px] border px-4 py-3", check.ok ? "border-[#cfe8d9] bg-success-soft" : "border-warn-line bg-warn-soft")}>
          <Eq l="Opening balance" v={inr(check.openingPaise, { paise: true })} />
          <span className="text-[18px] font-bold text-faint">+</span>
          <Eq l={`Credits (${check.creditCount})`} v={inr(check.credits, { paise: true })} cls="text-success" />
          <span className="text-[18px] font-bold text-faint">−</span>
          <Eq l={`Debits (${check.debitCount})`} v={inr(check.debits, { paise: true })} cls="text-danger" />
          <span className="text-[18px] font-bold text-faint">=</span>
          <Eq l="Closing, worked out" v={inr(check.workedPaise, { paise: true })} />
          <span className="text-[18px] font-bold text-faint">{check.workedPaise != null && check.closingPaise != null && check.workedPaise === check.closingPaise ? "✓" : "≠"}</span>
          <Eq l="Closing, as printed" v={inr(detail.closingPaise ?? check.closingPaise, { paise: true })} />
          <div className="ml-auto text-right">
            <div className="text-[11px] font-[650] text-muted">This upload</div>
            <div className="text-[16px] font-[750] text-heading tabular-nums">
              {rows.length} lines · <span className="text-brand-deep">{fresh.length} new</span> · {rows.length - fresh.length} already in
            </div>
          </div>
        </div>
        <div className="overflow-hidden rounded-[12px] border border-line bg-surface">
          <div className="flex items-center gap-2 border-b border-divider px-3 py-2.5">
            {(
              [
                ["all", `All ${rows.length}`],
                ["new", `New ${fresh.length}`],
                ["in", `Already in ${rows.length - fresh.length}`],
                ["check", `Check these ${toCheck.length}`],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={cx("-mb-[11px] cursor-pointer border-b-2 bg-transparent px-2 pt-1 pb-2.5 text-[13px] font-semibold", tab === k ? "border-brand text-brand-deep" : "border-transparent text-muted")}
              >
                {l}
              </button>
            ))}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search narration…" className="ml-auto h-8 w-[220px] rounded-[8px] border border-line px-2.5 text-[12.5px] outline-none focus:border-brand" />
          </div>
          <div className="max-h-[52vh] overflow-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-1">
                <tr>
                  {["Date", "Narration", "Ref / UTR", "Debit", "Credit", "Balance", "Read", ""].map((h, i) => (
                    <th key={i} className={cx("border-b border-line bg-[#fafbfc] px-3 py-[9px] text-left text-[11px] font-bold tracking-[0.06em] whitespace-nowrap text-muted uppercase", i >= 3 && i <= 5 && "text-right")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const fl = !r.existing && (r.breakHere || r.lowConfidence);
                  const dup = r.existing;
                  const td = "border-b border-divider px-3 py-2.5 text-[12.8px] whitespace-nowrap";
                  return (
                    <tr key={r.lineNo} className={cx(dup ? "bg-[#fafbfc] text-faint" : fl ? "bg-[#fffaf3]" : "", "text-body")}>
                      <td className={td}>{cell(r, "date", dayLabel(r.date))}</td>
                      <td className={cx(td, "max-w-[330px] overflow-hidden text-ellipsis")} title={r.narration}>
                        {cell(r, "narration", dup ? r.narration : <b className="font-[650] text-ink">{r.narration}</b>)}
                      </td>
                      <td className={cx(td, "font-mono text-[12px]", dup ? "text-faint" : "text-brand-deep")}>{cell(r, "reference", r.reference || "—")}</td>
                      <td className={cx(td, "text-right tabular-nums", !dup && r.debitPaise ? "font-[650] text-danger" : "")}>{cell(r, "debitPaise", r.debitPaise ? figure(r.debitPaise) : "")}</td>
                      <td className={cx(td, "text-right tabular-nums", !dup && r.creditPaise ? "font-[650] text-success" : "")}>{cell(r, "creditPaise", r.creditPaise ? figure(r.creditPaise) : "")}</td>
                      <td className={cx(td, "text-right tabular-nums", !dup && r.breakHere && "text-[#a14b00] underline decoration-dotted")}>{cell(r, "balancePaise", figure(r.balancePaise))}</td>
                      <td className={td}>
                        <Conf value={r.confidence} low={r.lowConfidence} />
                      </td>
                      <td className={td}>
                        {dup ? (
                          <Pill tone="muted">Already in</Pill>
                        ) : r.breakHere ? (
                          <Pill tone="flag">Balance breaks</Pill>
                        ) : r.lowConfidence ? (
                          <Pill tone="flag">Check a figure</Pill>
                        ) : (r as CheckedRow & { edited?: boolean }).edited || edits[r.lineNo] ? (
                          <Pill tone="info">Corrected</Pill>
                        ) : (
                          <Pill tone="brand">New</Pill>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!shown.length ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-[12.5px] text-muted">
                      Nothing here.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        {firstCheck ? (
          <Note tone="w">
            <b>
              {toCheck.length === 1 ? "One line to check." : `${toCheck.length} lines to check.`}
            </b>{" "}
            {firstCheck.breakHere
              ? `Line ${firstCheck.lineNo}'s printed balance does not follow from the line before — a figure on it or near it was probably misread.`
              : `Line ${firstCheck.lineNo} was read at ${firstCheck.confidence}% — the AI is unsure of a figure.`}{" "}
            Click any cell to correct it before importing{detail.pdfKept ? ", with the PDF open beside this table" : ""}.
          </Note>
        ) : !check.ok ? (
          <Note tone="w">The closing worked out does not equal the closing printed. Check the opening and closing balances against the PDF.</Note>
        ) : null}
        {imported ? (
          <Note tone="o">
            Imported{detail.imported ? ` · ${detail.imported} line${detail.imported === 1 ? "" : "s"} brought in` : ""}. <LinkBtn onClick={() => router.push(`/accounts/bank-reconcile?upload=${detail.id}&tab=all`)}>Reconcile them</LinkBtn>
          </Note>
        ) : null}
      </div>
    </Dialog>
  );
}

function Eq({ l, v, cls }: { l: string; v: string; cls?: string }) {
  return (
    <div className="text-center">
      <div className="text-[11px] font-[650] text-muted">{l}</div>
      <div className={cx("text-[16px] font-[750] text-heading tabular-nums", cls)}>{v}</div>
    </div>
  );
}
