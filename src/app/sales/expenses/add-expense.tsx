"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { addExpenseFor } from "@/lib/actions/sales";
import { Modal } from "@/components/ui/overlays";
import { Button } from "@/components/console/parts";
import { cx } from "@/components/ui/primitives";
import { uploadPublishFile, type Uploaded } from "../publish-upload";
import { inrExact as inr } from "./labels";

/* ---------------------------------------------------------------------------
 * ADD EXPENSE — the office entering one expense on a salesman's behalf: the
 * bill handed over at the desk, the claim older than his phone will take.
 *
 * It writes exactly what his claim sheet writes (see `addExpenseFor`), so it
 * is priced by the policy, decided, paid and reported like any other, and
 * reaches his phone as an ordinary expense on its next sync. Bills upload as
 * they are chosen, to a route handler, because a scanned bill is past a server
 * action's one-megabyte ceiling.
 * ------------------------------------------------------------------------- */

const KINDS = [
  { value: "travel", label: "Bus or train" },
  { value: "local_transport", label: "Local transport" },
  { value: "food", label: "Food" },
  { value: "lodging", label: "Hotel" },
  { value: "other", label: "Other" },
] as const;
type Kind = (typeof KINDS)[number]["value"];

const field =
  "w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand";
const labelCls = "mb-1 block text-[13px] font-medium text-ink";

export function AddExpense({
  people,
  defaultUserId,
  today,
  canApprove,
}: {
  /** Who it may be entered for — the Salesman App holders in the reader's scope. */
  people: { id: string; name: string }[];
  /** Pre-picked where the screen is already about one salesman. */
  defaultUserId?: string;
  /** The business date, from the server: a client may not read the clock in render. */
  today: string;
  /** Whether "Add and approve" is offered — the reader may decide expenses. */
  canApprove: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [userId, setUserId] = React.useState("");
  const [day, setDay] = React.useState(today);
  const [kind, setKind] = React.useState<Kind>("local_transport");
  const [amount, setAmount] = React.useState("");
  const [vendor, setVendor] = React.useState("");
  const [billNumber, setBillNumber] = React.useState("");
  const [billDate, setBillDate] = React.useState("");
  const [remarks, setRemarks] = React.useState("");
  const [files, setFiles] = React.useState<Uploaded[]>([]);
  const [uploading, setUploading] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const typed = Number(amount.replace(/[^0-9.]/g, ""));
  const asPaise = Number.isFinite(typed) ? Math.round(typed * 100) : 0;
  const missing = !userId
    ? "Pick the salesman."
    : !day
      ? "Pick the day."
      : asPaise <= 0
        ? "Type the amount."
        : null;

  const start = () => {
    setUserId(
      defaultUserId && people.some((p) => p.id === defaultUserId)
        ? defaultUserId
        : "",
    );
    setDay(today);
    setKind("local_transport");
    setAmount("");
    setVendor("");
    setBillNumber("");
    setBillDate("");
    setRemarks("");
    setFiles([]);
    setError(null);
    setOpen(true);
  };

  const choose = async (list: FileList | null) => {
    if (!list?.length) return;
    setError(null);
    for (const f of Array.from(list)) {
      setUploading((n) => n + 1);
      const r = await uploadPublishFile(
        f,
        undefined,
        "/api/sales/expense-file",
      );
      setUploading((n) => n - 1);
      if (r.ok) setFiles((prev) => [...prev, r.data]);
      else setError(r.error ?? `${f.name} did not upload.`);
    }
  };

  const save = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    const r = await addExpenseFor({
      userId,
      day,
      kind,
      amountPaise: asPaise,
      vendorName: vendor.trim() || undefined,
      billNumber: billNumber.trim() || undefined,
      billDate: billDate || undefined,
      remarks: remarks.trim() || undefined,
      attachmentIds: files.map((f) => f.id),
      approve,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "That did not save.");
      return;
    }
    setOpen(false);
    router.refresh();
  };

  const who = people.find((p) => p.id === userId)?.name;

  return (
    <>
      <Button tone="primary" onClick={start}>
        + Add expense
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add an expense for a salesman"
        width={600}
      >
        {open ? (
          <>
            <p className="mb-3 text-[13px] text-muted">
              For a bill handed in at the office, or a claim his phone could not
              send. It shows on his phone on its next sync, marked as entered by
              you.
            </p>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={labelCls}>Salesman</span>
                <select
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  className={cx(field, "cursor-pointer")}
                >
                  <option value="">Pick a salesman…</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelCls}>Day it was spent</span>
                <input
                  type="date"
                  value={day}
                  max={today}
                  onChange={(e) => setDay(e.target.value)}
                  className={field}
                />
              </label>
            </div>

            <div className="mt-3">
              <span className={labelCls}>Type</span>
              <div className="flex flex-wrap gap-1.5">
                {KINDS.map((k) => (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => setKind(k.value)}
                    className={cx(
                      "h-8 cursor-pointer rounded-full border px-3 text-[13px]",
                      kind === k.value
                        ? "border-brand bg-brand-soft text-brand"
                        : "border-line bg-surface text-body",
                    )}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              {kind === "food" || kind === "lodging" ? (
                <p className="mt-1.5 text-[12px] text-muted">
                  {kind === "food"
                    ? "Meals are usually paid as an allowance from his punch times — the policy may allow nothing on a food bill."
                    : "The policy may pay a fixed hotel rate rather than the bill — the Review shows what it allows."}
                </p>
              ) : null}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className={labelCls}>Amount (₹)</span>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="0"
                  className={field}
                />
              </label>
              <label className="block">
                <span className={labelCls}>
                  Paid to{" "}
                  <span className="font-normal text-muted">(optional)</span>
                </span>
                <input
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  placeholder="Hotel, transporter…"
                  className={field}
                />
              </label>
              <label className="block">
                <span className={labelCls}>
                  Bill number{" "}
                  <span className="font-normal text-muted">(optional)</span>
                </span>
                <input
                  value={billNumber}
                  onChange={(e) => setBillNumber(e.target.value)}
                  className={field}
                />
              </label>
              <label className="block">
                <span className={labelCls}>
                  Bill date{" "}
                  <span className="font-normal text-muted">(optional)</span>
                </span>
                <input
                  type="date"
                  value={billDate}
                  max={today}
                  onChange={(e) => setBillDate(e.target.value)}
                  className={field}
                />
              </label>
            </div>

            <label className="mt-3 block">
              <span className={labelCls}>What it was for</span>
              <textarea
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                rows={2}
                placeholder="Auto from the station to the Wardha market"
                className={field}
              />
            </label>

            <div className="mt-3">
              <span className={labelCls}>Bills</span>
              <div className="flex flex-wrap items-center gap-2">
                {files.map((f) => (
                  <span
                    key={f.id}
                    className="inline-flex items-center gap-1.5 rounded-[4px] border border-line bg-canvas px-2 py-1 text-[12px] text-body"
                  >
                    <span className="max-w-[180px] truncate" title={f.filename}>
                      {f.filename}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setFiles((prev) => prev.filter((x) => x.id !== f.id))
                      }
                      className="cursor-pointer text-muted hover:text-danger"
                      aria-label={`Remove ${f.filename}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <label className="inline-flex h-8 cursor-pointer items-center rounded-[4px] border border-dashed border-line px-3 text-[13px] text-brand hover:bg-canvas">
                  {uploading
                    ? "Uploading…"
                    : files.length
                      ? "Add another"
                      : "Attach bill"}
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      void choose(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              {!files.length && !uploading ? (
                <p className="mt-1 text-[12px] text-muted">
                  A photo or PDF of the bill. Without one it shows as “No bill
                  attached”.
                </p>
              ) : null}
            </div>

            {error ? (
              <p className="mt-3 text-[13px] text-danger">{error}</p>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2 border-t border-line pt-4">
              {who && asPaise > 0 ? (
                <span className="mr-auto truncate text-[12px] text-muted">
                  {inr(asPaise)} for {who}
                </span>
              ) : null}
              <Button tone="quiet" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                tone={canApprove ? "default" : "primary"}
                disabled={busy || !!uploading || !!missing}
                title={
                  missing ??
                  (uploading
                    ? "Wait for the bill to finish uploading."
                    : undefined)
                }
                onClick={() => void save(false)}
              >
                {busy ? "Saving…" : "Add for approval"}
              </Button>
              {canApprove ? (
                <Button
                  tone="primary"
                  disabled={busy || !!uploading || !!missing}
                  title={
                    missing ??
                    (uploading
                      ? "Wait for the bill to finish uploading."
                      : undefined)
                  }
                  onClick={() => void save(true)}
                >
                  {busy ? "Saving…" : "Add and approve"}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
}
