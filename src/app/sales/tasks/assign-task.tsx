"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { bulkAssignTask, createTask, previewTaskTargets } from "@/lib/actions/sales";
import type { Salesman } from "@/lib/services/sales-service";
import { Button } from "../parts";

/* ---------------------------------------------------------------------------
 * Assigning a task — to one person, or to everyone a filter matches.
 *
 * One modal rather than two, because the fields that differ (who it goes to)
 * are a small part of it and the fields that do not (what, and by when) would
 * otherwise be typed twice into two screens that drift.
 *
 * The filtered half follows the same shape the customer-reassignment tool
 * uses elsewhere in this product: a preview names a count, and the save
 * re-derives that count server-side and refuses if it has moved — never a
 * bulk write acting on a set nobody actually reviewed.
 * ------------------------------------------------------------------------- */

type Mode = "one" | "filter";
type Priority = "low" | "medium" | "high";

const TAB = "inline-flex h-8 items-center rounded-[4px] border px-3 text-[13px]";
const TAB_ON = "border-brand bg-brand-soft font-medium text-[#5223E0]";
const TAB_OFF = "border-line bg-surface text-body hover:bg-canvas";
const CONTROL = "h-8.5 w-full rounded-[4px] border border-line bg-surface px-2 text-[13px]";
const LABEL = "mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase";

export function AssignTask({ salesmen }: { salesmen: Salesman[] }) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>("one");

  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [priority, setPriority] = React.useState<Priority>("medium");
  const [dueDate, setDueDate] = React.useState("");

  const [assigneeId, setAssigneeId] = React.useState("");

  const [salesmanId, setSalesmanId] = React.useState("");
  const [beat, setBeat] = React.useState("");
  const [missingGpsOnly, setMissingGpsOnly] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [preview, setPreview] = React.useState<{
    count: number;
    names: string[];
    unassigned: number;
  } | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function reset() {
    setMode("one");
    setTitle("");
    setDescription("");
    setPriority("medium");
    setDueDate("");
    setAssigneeId("");
    setSalesmanId("");
    setBeat("");
    setMissingGpsOnly(false);
    setSearch("");
    setPreview(null);
    setError(null);
  }

  const filter = {
    salesmanId: salesmanId || undefined,
    beat: beat.trim() || undefined,
    missingGpsOnly: missingGpsOnly || undefined,
    search: search.trim() || undefined,
  };

  async function runPreview() {
    setPreviewing(true);
    setError(null);
    try {
      const result = await previewTaskTargets(filter);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.data);
    } finally {
      setPreviewing(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "one"
          ? await createTask({
              assignedToUserId: assigneeId,
              title,
              description: description.trim() || undefined,
              priority,
              dueDate,
            })
          : await bulkAssignTask({
              filter,
              expectedCount: preview?.count ?? 0,
              title,
              description: description.trim() || undefined,
              priority,
              dueDate,
            });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.push(result.message ?? "Assigned.");
      setOpen(false);
      reset();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const canSave =
    title.trim().length >= 3 &&
    /^\d{4}-\d{2}-\d{2}$/.test(dueDate) &&
    (mode === "one" ? Boolean(assigneeId) : Boolean(preview && preview.count > 0));

  return (
    <>
      <Button tone="primary" onClick={() => setOpen(true)}>
        Assign a task
      </Button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title="Assign a task"
        width={560}
      >
        <div className="mb-3 flex gap-1.5">
          <button
            type="button"
            onClick={() => setMode("one")}
            className={`${TAB} ${mode === "one" ? TAB_ON : TAB_OFF}`}
          >
            One person
          </button>
          <button
            type="button"
            onClick={() => setMode("filter")}
            className={`${TAB} ${mode === "filter" ? TAB_ON : TAB_OFF}`}
          >
            Everyone matching a filter
          </button>
        </div>

        {mode === "one" ? (
          <label className="mb-3 block">
            <span className={LABEL}>For</span>
            <select
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              className={CONTROL}
            >
              <option value="">Pick a salesman…</option>
              {salesmen.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="mb-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={LABEL}>Salesman</span>
                <select
                  value={salesmanId}
                  onChange={(e) => {
                    setSalesmanId(e.target.value);
                    setPreview(null);
                  }}
                  className={CONTROL}
                >
                  <option value="">Anyone</option>
                  {salesmen.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={LABEL}>Beat</span>
                <input
                  value={beat}
                  onChange={(e) => {
                    setBeat(e.target.value);
                    setPreview(null);
                  }}
                  placeholder="Any beat"
                  className={CONTROL}
                />
              </label>
            </div>
            <label className="flex items-center gap-1.5 text-[13px] text-body">
              <input
                type="checkbox"
                checked={missingGpsOnly}
                onChange={(e) => {
                  setMissingGpsOnly(e.target.checked);
                  setPreview(null);
                }}
              />
              Only shops with no location saved
            </label>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPreview(null);
              }}
              placeholder="Search by name, phone or city (optional)"
              className={CONTROL}
            />

            {preview ? (
              <p className="text-[13px] text-pretty text-muted">
                {preview.count === 0
                  ? "Nothing matches this filter."
                  : `${preview.count} shop${preview.count === 1 ? "" : "s"} match — ${preview.names
                      .slice(0, 5)
                      .join(", ")}${preview.count > 5 ? ", …" : ""}.`}
                {preview.unassigned
                  ? ` ${preview.unassigned} of them ${
                      preview.unassigned === 1 ? "has" : "have"
                    } nobody to assign to and will be skipped.`
                  : ""}
              </p>
            ) : (
              <Button size="sm" disabled={previewing} onClick={() => void runPreview()}>
                {previewing ? "Checking…" : "See who this matches"}
              </Button>
            )}
          </div>
        )}

        <label className="mb-3 block">
          <span className={LABEL}>Task</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What should they do?"
            className={CONTROL}
          />
        </label>

        <label className="mb-3 block">
          <span className={LABEL}>Note (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-[4px] border border-line bg-surface px-2 py-1.5 text-[13px]"
          />
        </label>

        <div className="mb-3 grid grid-cols-2 gap-2">
          <label className="block">
            <span className={LABEL}>Due by</span>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={CONTROL}
            />
          </label>
          <label className="block">
            <span className={LABEL}>Priority</span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className={CONTROL}
            >
              <option value="low">Low</option>
              <option value="medium">Normal</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>

        {error ? <p className="mb-2 text-[13px] text-danger">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <Button
            tone="quiet"
            onClick={() => {
              setOpen(false);
              reset();
            }}
          >
            Cancel
          </Button>
          <Button tone="primary" disabled={busy || !canSave} onClick={() => void save()}>
            {busy
              ? "Assigning…"
              : mode === "one"
                ? "Assign"
                : `Assign to ${preview?.count ?? 0}`}
          </Button>
        </div>
      </Modal>
    </>
  );
}
