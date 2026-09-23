"use client";

/* ---------------------------------------------------------------------------
 * BRINGING PRICE LISTS IN — one PDF or thirty, checked and approved in place.
 *
 * The office receives a month's lists as a folder of PDFs, and the job is
 * always the same: read them, check what was read, say what each one is and
 * who it applies to, and put them in force. This modal is that whole job.
 * One file is simply a folder of one, so a single upload goes through the
 * same place and nobody learns two screens.
 *
 *   READ IN PARALLEL. Thirty files read one after another is thirty times the
 *   wait; three at a time is what the server takes without the pollers
 *   falling behind. Every file has its own row, its own stage and its own
 *   answer, and one bad file never stops the others.
 *
 *   CHECKED WITHOUT LEAVING. The selected file's grid is drawn here as it was
 *   read — every cell's figure and whether we know its product — with the held
 *   cells answerable in place and the header editable beside it. The full
 *   review screen is still one click away for a hard one.
 *
 *   APPROVED ONE AT A TIME OR ALL AT ONCE. "Approve" publishes one list;
 *   "Approve all ready" publishes every list that has nothing held and a name
 *   and a date — after a page that says, list by list, what is about to go
 *   into force. Each approval goes through `publishDocument`, the same action
 *   the review screen uses, so a batch is never a second, looser path.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, Checkbox, Field, Input, Select, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { WorkspaceModal } from "@/components/pricing/workspace-modal";
import { ParseAnimation, type DocumentStatusPoll } from "@/components/pricing/parse-animation";
import { ResolveProductModal } from "@/components/pricing/modals/resolve-product-modal";
import { ParsePriceModal } from "@/components/pricing/modals/parse-price-modal";
import { suggestedName } from "@/components/pricing/modals/publish-document-modal";
import { publishDocument, rejectDocument, reparseDocument } from "@/lib/actions/price-lists";
import {
  DELIVERY_BASIS_LABEL,
  DOCUMENT_STATUS_LABEL,
  DOCUMENT_STATUS_TONE,
  FREIGHT_TERM_LABEL,
  MATCH_STATUS_LABEL,
  PARSE_STAGES,
} from "@/lib/price-list-labels";
import type { DocumentView, ParseGrid, ParseRowView, PricingOptions } from "@/lib/price-list-views";
import type { PriceDeliveryBasis, PriceFreightTerm } from "@/db/schema";
import { groupRupees } from "@/lib/price-sheet";

const ACCEPTED = "application/pdf,image/jpeg,image/png";
const POLL_MS = 700;
const PARALLEL = 3;

type Phase = "queued" | "uploading" | "reading" | "read" | "failed" | "approving" | "approved" | "drafted" | "rejected";

type Row = {
  key: string;
  file: File;
  phase: Phase;
  documentId: string | null;
  error: string | null;
  status: DocumentStatusPoll | null;
  /** True where these exact bytes had been imported before. */
  seenBefore: boolean;
  /** The priced list, once approved or drafted. */
  listId: string | null;
  outcome: string | null;
};

type Detail = { document: DocumentView; rows: ParseRowView[]; grid: ParseGrid };

type Draft = {
  name: string;
  refNo: string;
  effectiveFrom: string;
  taxBasis: "inclusive" | "exclusive";
  gstPercent: string;
  deliveryBasis: string;
  freightTerm: PriceFreightTerm;
  validityDays: string;
  signatory: string;
  supersedesId: string;
  /** "everybody" | "none" | `state:${key}` */
  scope: string;
  includeSuggested: boolean;
};

const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The usual answer for every field, from the header the parser read and the filename. */
function draftFor(detail: Detail, options: PricingOptions, todayIso: string): Draft {
  const d = detail.document;
  const h = d.header;
  const hints = d.filenameHints;
  const published = options.lists.filter((l) => l.status === "published");
  const tokens = [hints?.region, hints?.customer].filter((t): t is string => !!t).map((t) => t.toLowerCase());
  const supersedes = tokens.length ? published.find((l) => tokens.some((t) => l.name.toLowerCase().includes(t))) : null;
  const region = hints?.region?.toLowerCase() ?? null;
  const state = region ? options.places.states.find((s) => s.label.toLowerCase() === region) : null;
  return {
    name: suggestedName(d),
    refNo: h?.refNo ?? "",
    effectiveFrom: h?.effectiveFrom ?? todayIso,
    taxBasis: h?.taxBasis ?? "inclusive",
    gstPercent: h?.gstBp != null ? String(h.gstBp / 100) : "18",
    deliveryBasis: h?.deliveryBasis ?? "",
    freightTerm: hints?.freightTerm ?? h?.freightTerm ?? "not_stated",
    validityDays: h?.validityDays != null ? String(h.validityDays) : "",
    signatory: h?.signatory ?? "",
    supersedesId: supersedes?.id ?? "",
    // A list that supersedes another inherits its customers on publish, so it
    // needs no scope of its own; otherwise the region the filename named.
    scope: supersedes ? "none" : state ? `state:${state.key}` : "everybody",
    includeSuggested: d.suggestedCount > 0,
  };
}

/** Held cells that carry a price — the ones approving would silently drop. */
function heldPricedCount(detail: Detail): number {
  return detail.rows.filter((r) => r.matchStatus === "held" && r.offered && r.rateInclGstPaise != null).length;
}

/** Whether a read file can be approved without anybody looking further. */
function readiness(row: Row, detail: Detail | undefined, draft: Draft | undefined): { ready: boolean; why: string | null } {
  if (row.phase !== "read") return { ready: false, why: null };
  if (!detail || !draft) return { ready: false, why: "Loading what was read" };
  const d = detail.document;
  if (!d.rowCount) return { ready: false, why: "Nothing was read from it" };
  // A held DASH is not work: it is a pack this list does not sell, and it would
  // be left out whatever product it matched. Only a held cell carrying a price
  // loses a price if it is approved as it stands.
  const heldPriced = heldPricedCount(detail);
  if (heldPriced) return { ready: false, why: `${heldPriced} price${heldPriced === 1 ? "" : "s"} with no product` };
  if (!draft.name.trim()) return { ready: false, why: "No name" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveFrom)) return { ready: false, why: "No effective date" };
  return { ready: true, why: null };
}

export function ImportModal({
  open,
  onClose,
  basePath,
  todayIso,
  openKey = 0,
}: {
  open: boolean;
  onClose: () => void;
  basePath: string;
  todayIso: string;
  /** Bumped by the caller each time it opens, so a reopen starts from nothing. */
  openKey?: number;
}) {
  if (!open) return null;
  return <Workbench key={openKey} onClose={onClose} basePath={basePath} todayIso={todayIso} />;
}

function Workbench({ onClose, basePath, todayIso }: { onClose: () => void; basePath: string; todayIso: string }) {
  const router = useRouter();
  const { run } = useToast();
  const [rows, setRows] = React.useState<Row[]>([]);
  const [started, setStarted] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [details, setDetails] = React.useState<Record<string, Detail>>({});
  const [edits, setEdits] = React.useState<Record<string, Draft>>({});
  const [options, setOptions] = React.useState<PricingOptions | null>(null);
  const [confirmingAll, setConfirmingAll] = React.useState<"publish" | "draft" | null>(null);
  const [resolving, setResolving] = React.useState<ParseRowView | null>(null);
  const [pricing, setPricing] = React.useState<ParseRowView | null>(null);
  const [rejecting, setRejecting] = React.useState<Row | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    fetch("/api/price-lists/options", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((o) => {
        if (alive.current && o) setOptions(o as PricingOptions);
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, []);

  /* A file's form is its suggestion until somebody changes a field. */
  const draftOf = (documentId: string | null): Draft | undefined => {
    if (!documentId) return undefined;
    if (edits[documentId]) return edits[documentId];
    const d = details[documentId];
    return d && options ? draftFor(d, options, todayIso) : undefined;
  };

  const patch = React.useCallback((key: string, next: Partial<Row>) => {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...next } : r)));
  }, []);

  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setError(null);
    setRows((current) => {
      const seen = new Set(current.map((r) => `${r.file.name}:${r.file.size}`));
      const added: Row[] = [];
      for (const file of Array.from(list)) {
        const id = `${file.name}:${file.size}`;
        if (seen.has(id)) continue;
        seen.add(id);
        added.push({ key: `${id}:${current.length + added.length}`, file, phase: "queued", documentId: null, error: null, status: null, seenBefore: false, listId: null, outcome: null });
      }
      return [...current, ...added];
    });
  }

  async function loadDetail(documentId: string): Promise<Detail | null> {
    try {
      const r = await fetch(`/api/price-lists/documents/${documentId}`, { cache: "no-store" });
      if (!r.ok) return null;
      return (await r.json()) as Detail;
    } catch {
      return null;
    }
  }

  async function refreshDetail(documentId: string): Promise<Detail | null> {
    const d = await loadDetail(documentId);
    if (d && alive.current) setDetails((m) => ({ ...m, [documentId]: d }));
    return d;
  }

  async function poll(documentId: string): Promise<DocumentStatusPoll | null> {
    try {
      const r = await fetch(`/api/price-lists/documents/${documentId}/status`, { cache: "no-store" });
      return r.ok ? ((await r.json()) as DocumentStatusPoll) : null;
    } catch {
      return null;
    }
  }

  async function parseOne(row: Row, documentId: string) {
    const stop = { value: false };
    void (async () => {
      while (!stop.value && alive.current) {
        const s = await poll(documentId);
        if (stop.value || !alive.current) return;
        if (s) patch(row.key, { status: s });
        await sleep(POLL_MS);
      }
    })();
    let refusal: string | null = null;
    try {
      const r = await fetch(`/api/price-lists/documents/${documentId}/parse`, { method: "POST" });
      if (!r.ok) refusal = ((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "Reading this file was refused.";
    } catch {
      refusal = "Reading this file failed part-way.";
    }
    stop.value = true;
    if (!alive.current) return;
    const final = await poll(documentId);
    const failed = !!refusal || !final || final.parseStatus === "failed" || final.parseStatus === "rejected";
    patch(row.key, {
      status: final,
      phase: failed ? "failed" : "read",
      error: refusal ?? (final?.parseStatus === "failed" ? (final.stageNote ?? "Could not be read.") : null),
    });
    if (!failed) {
      await refreshDetail(documentId);
      setSelected((s) => s ?? row.key);
    }
  }

  async function start() {
    const queued = rows.filter((r) => r.phase === "queued");
    if (!queued.length || running) return;
    setStarted(true);
    setRunning(true);
    setError(null);
    try {
      const form = new FormData();
      for (const r of queued) form.append("files", r.file);
      setRows((c) => c.map((r) => (r.phase === "queued" ? { ...r, phase: "uploading" } : r)));
      const response = await fetch("/api/price-lists/upload", { method: "POST", body: form });
      const payload = (await response.json().catch(() => null)) as {
        documents?: Array<{ filename: string; documentId?: string; duplicateOf?: string; error?: string }>;
        error?: string;
      } | null;
      if (!response.ok) {
        setError(payload?.error ?? "That upload was refused.");
        setRows((c) => c.map((r) => (r.phase === "uploading" ? { ...r, phase: "failed", error: payload?.error ?? "Refused." } : r)));
        return;
      }
      const answers = payload?.documents ?? [];
      const toRead: Array<{ row: Row; documentId: string }> = [];
      const seenBefore: Array<{ row: Row; documentId: string }> = [];
      const next = queued.map((row, i): Row => {
        const a = answers.length === queued.length ? answers[i] : answers.find((x) => x.filename === row.file.name);
        if (!a) return { ...row, phase: "failed", error: "The server said nothing about this file." };
        if (a.error) return { ...row, phase: "failed", error: a.error };
        if (a.duplicateOf) {
          seenBefore.push({ row, documentId: a.duplicateOf });
          return { ...row, phase: "reading", documentId: a.duplicateOf, seenBefore: true };
        }
        toRead.push({ row, documentId: a.documentId! });
        return { ...row, phase: "reading", documentId: a.documentId! };
      });
      setRows((c) => c.map((r) => next.find((n) => n.key === r.key) ?? r));

      /* A file imported before opens straight into what was read then —
         approvable if it never became a list, a link to the list if it did. */
      for (const { row, documentId } of seenBefore) {
        void refreshDetail(documentId).then((d) => {
          if (!d) return patch(row.key, { phase: "failed", error: "It was imported before, and that document could not be read back." });
          const s = d.document.parseStatus;
          patch(row.key, {
            phase: s === "published" ? "approved" : s === "rejected" ? "rejected" : s === "failed" ? "failed" : "read",
            listId: d.document.priceListId,
            outcome: s === "published" ? `Imported before and already published${d.document.priceListName ? ` as ${d.document.priceListName}` : ""}` : "Imported before — picked up where it was left",
            error: s === "failed" ? d.document.stageNote : null,
          });
          setSelected((cur) => cur ?? row.key);
        });
      }

      /* Three at a time: each worker takes the next file until none are left. */
      let cursor = 0;
      const worker = async () => {
        while (alive.current && cursor < toRead.length) {
          const job = toRead[cursor++];
          await parseOne(job.row, job.documentId);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, toRead.length) }, worker));
    } catch {
      setError("The import could not be sent. Check the connection and try again.");
    } finally {
      if (alive.current) {
        setRunning(false);
        router.refresh();
      }
    }
  }

  /* ---- approving ------------------------------------------------------- */

  async function approve(row: Row, publishNow: boolean): Promise<boolean> {
    const detail = row.documentId ? details[row.documentId] : undefined;
    const draft = draftOf(row.documentId);
    if (!row.documentId || !detail || !draft) return false;
    patch(row.key, { phase: "approving" });
    const [kind, value] = draft.scope.split(":");
    const state = kind === "state" ? options?.places.states.find((s) => s.key === value) : null;
    const r = await run(
      publishDocument(row.documentId, {
        name: draft.name.trim(),
        refNo: draft.refNo.trim() || null,
        effectiveFrom: draft.effectiveFrom,
        validityDays: draft.validityDays.trim() ? Number(draft.validityDays) : null,
        taxBasis: draft.taxBasis,
        gstBp: draft.gstPercent.trim() ? Math.round(Number(draft.gstPercent) * 100) : undefined,
        deliveryBasis: (draft.deliveryBasis || null) as PriceDeliveryBasis | null,
        freightTerm: draft.freightTerm,
        termsText: detail.document.header?.termsText ?? null,
        signatory: draft.signatory.trim() || null,
        notes: null,
        supersedesId: draft.supersedesId || null,
        publishNow,
        includeSuggested: draft.includeSuggested,
        scopes:
          kind === "everybody"
            ? [{ scopeKind: "everybody", scopeValue: "", scopeLabel: "Everybody", parentKey: "", freightTermMatch: "any" }]
            : state
              ? [{ scopeKind: "state", scopeValue: state.key, scopeLabel: state.label, parentKey: "", freightTermMatch: "any" }]
              : [],
      }),
    );
    if (!r.ok) {
      patch(row.key, { phase: "read", error: r.error });
      return false;
    }
    // `publishDocument` answers ok with the list left as a draft when the
    // publish step itself was refused, and says why in the first warning.
    const stayedDraft = publishNow && r.message === "Read in as a draft.";
    patch(row.key, {
      phase: publishNow && !stayedDraft ? "approved" : "drafted",
      listId: r.data.priceListId,
      outcome: r.data.warnings[0] ?? (publishNow ? "In force" : "Saved as a draft"),
      error: null,
    });
    return true;
  }

  async function approveAll(publishNow: boolean, keys: string[]) {
    setConfirmingAll(null);
    for (const key of keys) {
      const row = rows.find((r) => r.key === key);
      if (row) await approve(row, publishNow);
    }
    router.refresh();
  }

  async function reread(row: Row) {
    if (!row.documentId) return;
    patch(row.key, { phase: "reading", error: null });
    const r = await run(reparseDocument(row.documentId));
    const final = await poll(row.documentId);
    patch(row.key, { phase: r.ok && final?.parseStatus !== "failed" ? "read" : "failed", status: final });
    await refreshDetail(row.documentId);
  }

  /* ---- derived --------------------------------------------------------- */

  const ready = new Map(rows.map((r) => [r.key, readiness(r, r.documentId ? details[r.documentId] : undefined, draftOf(r.documentId))]));
  const readyKeys = rows.filter((r) => ready.get(r.key)?.ready).map((r) => r.key);
  const counts = {
    total: rows.length,
    reading: rows.filter((r) => r.phase === "uploading" || r.phase === "reading").length,
    ready: readyKeys.length,
    attention: rows.filter((r) => r.phase === "read" && !ready.get(r.key)?.ready).length,
    failed: rows.filter((r) => r.phase === "failed").length,
    done: rows.filter((r) => r.phase === "approved" || r.phase === "drafted").length,
  };
  const current = rows.find((r) => r.key === selected) ?? null;
  const currentDetail = current?.documentId ? details[current.documentId] : undefined;
  const currentDraft = draftOf(current?.documentId ?? null);

  const setDraft = (change: Partial<Draft>) => {
    const id = current?.documentId;
    const base = draftOf(id ?? null);
    if (!id || !base) return;
    setEdits((m) => ({ ...m, [id]: { ...base, ...change } }));
  };

  /* ---- the drop zone, before anything is sent -------------------------- */

  if (!started) {
    return (
      <WorkspaceModal
        title="Import price lists"
        subtitle="One PDF or a whole folder. Each is read, checked and approved here."
        onRequestClose={onClose}
        maxWidth={860}
        footer={
          <>
            <span className="text-[12.5px] text-muted">{rows.length ? `${rows.length} file${rows.length === 1 ? "" : "s"} chosen` : "Nothing chosen yet"}</span>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void start()} disabled={!rows.length}>
                Read {rows.length || ""} file{rows.length === 1 ? "" : "s"}
              </Button>
            </div>
          </>
        }
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={cx(
            "cursor-pointer rounded-[8px] border-2 border-dashed px-6 py-12 text-center transition-colors",
            dragging ? "border-brand bg-brand-soft" : "border-line-strong bg-canvas hover:border-brand",
          )}
        >
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-soft text-brand">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 13V3m0 0L6 7m4-4l4 4M3 13v3a1 1 0 001 1h12a1 1 0 001-1v-3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="text-[15px] font-semibold text-ink">Drop the price lists here</div>
          <div className="mt-1 text-[13px] text-muted">Or click to choose them — as many as you have. PDF, JPG or PNG; a scan of a signed sheet is fine.</div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPTED}
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {rows.length ? (
          <ul className="mt-4 divide-y divide-divider rounded-[6px] border border-line">
            {rows.map((r) => (
              <li key={r.key} className="flex items-center gap-3 px-3 py-2">
                <FileGlyph />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{r.file.name}</span>
                <span className="text-[12px] text-muted">{sizeLabel(r.file.size)}</span>
                <button type="button" className="cursor-pointer text-[12px] text-danger hover:underline" onClick={() => setRows((c) => c.filter((x) => x.key !== r.key))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-[13px] text-muted">
            Text PDFs are read exactly, in seconds; scans and photographs are read by a model and always held for a person to check.
          </p>
        )}
      </WorkspaceModal>
    );
  }

  /* ---- reading and approving ------------------------------------------- */

  return (
    <WorkspaceModal
      title="Import price lists"
      subtitle={
        <span className="flex flex-wrap gap-x-3">
          <span>{counts.total} file{counts.total === 1 ? "" : "s"}</span>
          {counts.reading ? <span className="text-brand">{counts.reading} reading</span> : null}
          <span className="text-success">{counts.ready} ready</span>
          {counts.attention ? <span className="text-warn-ink">{counts.attention} need a look</span> : null}
          {counts.failed ? <span className="text-danger">{counts.failed} failed</span> : null}
          {counts.done ? <span>{counts.done} done</span> : null}
        </span>
      }
      onRequestClose={() => (running ? undefined : onClose())}
      bodyClassName="p-0"
      actions={
        <label className="cursor-pointer">
          <span className="inline-flex h-8 items-center rounded-[4px] border border-line bg-surface px-2.5 text-[13px] font-medium text-body hover:bg-canvas">+ Add files</span>
          <input
            type="file"
            multiple
            accept={ACCEPTED}
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      }
      footer={
        <>
          <span className="text-[12.5px] text-muted">
            {running ? "Reading — check and approve the finished ones while the rest are read." : "Each approval publishes through the same checks as the review screen."}
          </span>
          <div className="flex flex-wrap gap-2">
            {rows.some((r) => r.phase === "queued") ? (
              <Button variant="secondary" onClick={() => void start()} disabled={running}>
                Read {rows.filter((r) => r.phase === "queued").length} more
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onClose} disabled={running} title={running ? "Wait for the files being read to finish." : undefined}>
              Close
            </Button>
            <Button variant="secondary" disabled={!counts.ready} onClick={() => setConfirmingAll("draft")}>
              Save ready as drafts
            </Button>
            <Button variant="primary" disabled={!counts.ready} onClick={() => setConfirmingAll("publish")}>
              Approve all ready ({counts.ready})
            </Button>
          </div>
        </>
      }
    >
      <div className="grid h-full min-h-0 lg:grid-cols-[320px_1fr]">
        {/* ------------------------------------------------ the files */}
        <ul className="min-h-0 overflow-auto border-r border-divider bg-canvas/50">
          {rows.map((r) => {
            const rd = ready.get(r.key);
            const d = r.documentId ? details[r.documentId] : undefined;
            return (
              <li key={r.key}>
                <button
                  type="button"
                  onClick={() => setSelected(r.key)}
                  className={cx(
                    "flex w-full cursor-pointer items-start gap-2.5 border-b border-divider px-3 py-2.5 text-left",
                    selected === r.key ? "bg-surface shadow-[inset_3px_0_0_var(--color-brand)]" : "hover:bg-surface",
                  )}
                >
                  <FileGlyph />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink" title={r.file.name}>
                      {draftOf(r.documentId)?.name || r.file.name}
                    </span>
                    <span className="block truncate text-[11.5px] text-muted">
                      {r.phase === "reading" && r.status
                        ? (r.status.stageNote ?? DOCUMENT_STATUS_LABEL[r.status.parseStatus])
                        : r.error
                          ? r.error
                          : r.outcome
                            ? r.outcome
                            : d
                              ? `${d.document.rowCount} cells · ${d.document.matchedCount} matched${heldPricedCount(d) ? ` · ${heldPricedCount(d)} prices held` : ""}`
                              : r.file.name}
                    </span>
                  </span>
                  <PhaseBadge row={r} ready={!!rd?.ready} why={rd?.why ?? null} />
                </button>
              </li>
            );
          })}
        </ul>

        {/* ------------------------------------------------ the one selected */}
        <div className="min-h-0 overflow-auto px-5 py-4">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {!current ? (
            <p className="py-16 text-center text-[13px] text-muted">
              {counts.reading ? "Reading the files. The first one to finish opens here." : "Choose a file on the left."}
            </p>
          ) : current.phase === "reading" || current.phase === "uploading" ? (
            <ParseAnimation status={current.status} filename={current.file.name} />
          ) : current.phase === "failed" ? (
            <div className="py-10 text-center">
              <div className="text-[15px] font-semibold text-ink">{current.file.name} could not be read</div>
              <p className="mx-auto mt-1 max-w-[480px] text-[13px] text-muted">{current.error ?? "No reason was given."}</p>
              {current.documentId ? (
                <Button className="mt-4" variant="secondary" onClick={() => void reread(current)}>
                  Try reading it again
                </Button>
              ) : null}
            </div>
          ) : !currentDetail || !currentDraft ? (
            <p className="py-16 text-center text-[13px] text-muted">Opening what was read…</p>
          ) : (
            <DocumentPane
              row={current}
              detail={currentDetail}
              draft={currentDraft}
              setDraft={setDraft}
              options={options}
              basePath={basePath}
              onApprove={(publishNow) => void approve(current, publishNow).then(() => router.refresh())}
              onReread={() => void reread(current)}
              onReject={() => setRejecting(current)}
              onResolve={setResolving}
              onPrice={setPricing}
              why={ready.get(current.key)?.why ?? null}
            />
          )}
        </div>
      </div>

      {confirmingAll ? (
        <ConfirmAll
          publish={confirmingAll === "publish"}
          rows={rows.filter((r) => readyKeys.includes(r.key))}
          details={details}
          draftOf={draftOf}
          options={options}
          onCancel={() => setConfirmingAll(null)}
          onConfirm={(keys) => void approveAll(confirmingAll === "publish", keys)}
        />
      ) : null}

      <ResolveProductModal
        open={!!resolving}
        cell={resolving}
        products={options?.products ?? []}
        onClose={() => {
          setResolving(null);
          if (current?.documentId) void refreshDetail(current.documentId);
        }}
      />
      <ParsePriceModal
        open={!!pricing}
        cell={pricing}
        gstBp={currentDetail?.document.header?.gstBp ?? 1800}
        onClose={() => {
          setPricing(null);
          if (current?.documentId) void refreshDetail(current.documentId);
        }}
      />
      {rejecting ? (
        <RejectInline
          filename={rejecting.file.name}
          onCancel={() => setRejecting(null)}
          onReject={async (reason) => {
            if (!rejecting.documentId) return;
            const r = await run(rejectDocument(rejecting.documentId, reason));
            if (r.ok) {
              patch(rejecting.key, { phase: "rejected", outcome: `Rejected — ${reason}` });
              setRejecting(null);
            }
          }}
        />
      ) : null}
    </WorkspaceModal>
  );
}

/* ------------------------------------------------------------ one file */

function DocumentPane({
  row,
  detail,
  draft,
  setDraft,
  options,
  basePath,
  onApprove,
  onReread,
  onReject,
  onResolve,
  onPrice,
  why,
}: {
  row: Row;
  detail: Detail;
  draft: Draft;
  setDraft: (p: Partial<Draft>) => void;
  options: PricingOptions | null;
  basePath: string;
  onApprove: (publishNow: boolean) => void;
  onReread: () => void;
  onReject: () => void;
  onResolve: (cell: ParseRowView) => void;
  onPrice: (cell: ParseRowView) => void;
  why: string | null;
}) {
  const d = detail.document;
  const finished = row.phase === "approved" || row.phase === "drafted" || row.phase === "rejected";
  const [onlyProblems, setOnlyProblems] = React.useState(false);
  const rates = d.matchedCount + (draft.includeSuggested ? d.suggestedCount : 0);
  const rowsShown = onlyProblems ? detail.grid.rows.filter((r) => r.cells.some((c) => c.matchStatus === "held" || c.matchStatus === "suggested")) : detail.grid.rows;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[16px] font-semibold text-ink">{row.file.name}</h3>
            <Badge tone={DOCUMENT_STATUS_TONE[d.parseStatus]}>{DOCUMENT_STATUS_LABEL[d.parseStatus]}</Badge>
            {d.confidence != null ? <Badge tone={d.confidence >= 85 ? "success" : d.confidence >= 60 ? "warn" : "danger"}>{d.confidence}% confident</Badge> : null}
            {d.sourceKind !== "pdf_text" ? <Badge tone="warn">read by a model</Badge> : null}
            {row.seenBefore ? <Badge tone="muted">imported before</Badge> : null}
          </div>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {d.pageCount ?? 1} page{d.pageCount === 1 ? "" : "s"} · {d.layout ?? "unknown"} layout · {d.rowCount} cells: {d.matchedCount} matched, {d.suggestedCount} worth checking, {d.heldCount} held
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`${basePath}/documents/${d.id}`} target="_blank" className="inline-flex h-8 items-center rounded-[4px] border border-line px-2.5 text-[13px] text-body hover:bg-canvas">
            Full review ↗
          </Link>
          {d.attachmentId ? (
            <a href={`/api/attachments/${d.attachmentId}`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center rounded-[4px] border border-line px-2.5 text-[13px] text-body hover:bg-canvas">
              Original file ↗
            </a>
          ) : null}
          {!finished ? (
            <>
              <Button size="sm" variant="ghost" onClick={onReread}>
                Read again
              </Button>
              <Button size="sm" variant="ghost" onClick={onReject}>
                Reject
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {finished ? (
        <Callout tone={row.phase === "rejected" ? "warn" : "brand"}>
          <span className="text-[13px]">
            {row.phase === "rejected" ? row.outcome : `${row.phase === "approved" ? "In force" : "Saved as a draft"}. ${row.outcome ?? ""}`}
            {row.listId ? (
              <>
                {" "}
                <Link href={`${basePath}/${row.listId}`} className="font-medium text-brand hover:underline">
                  Open the list
                </Link>
              </>
            ) : null}
          </span>
        </Callout>
      ) : null}
      {row.error && !finished ? <Callout tone="danger">{row.error}</Callout> : null}
      {d.problems.length && !finished ? (
        <div className="rounded-[6px] border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn-ink">
          {d.problems.map((p) => (
            <div key={p}>• {p}</div>
          ))}
        </div>
      ) : null}

      {!finished ? (
        <div className="rounded-[8px] border border-line p-4">
          <div className="mb-3 text-sm font-semibold text-ink">What this list is</div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Name" className="sm:col-span-2">
              <Input value={draft.name} onChange={(e) => setDraft({ name: e.target.value })} invalid={!draft.name.trim()} />
            </Field>
            <Field label="Ref no">
              <Input value={draft.refNo} onChange={(e) => setDraft({ refNo: e.target.value })} />
            </Field>
            <Field label="Effective from">
              <Input type="date" value={draft.effectiveFrom} onChange={(e) => setDraft({ effectiveFrom: e.target.value })} />
            </Field>
            <Field label="Prices print">
              <Select value={draft.taxBasis} onChange={(e) => setDraft({ taxBasis: e.target.value as Draft["taxBasis"] })} className="w-full">
                <option value="inclusive">GST inclusive</option>
                <option value="exclusive">GST extra</option>
              </Select>
            </Field>
            <Field label="GST %">
              <Input value={draft.gstPercent} inputMode="decimal" onChange={(e) => setDraft({ gstPercent: e.target.value })} />
            </Field>
            <Field label="Delivered to">
              <Select value={draft.deliveryBasis} onChange={(e) => setDraft({ deliveryBasis: e.target.value })} className="w-full">
                <option value="">Not stated</option>
                {(["for_godown", "for_mumbai", "door_delivery", "ex_factory"] as const).map((b) => (
                  <option key={b} value={b}>
                    {DELIVERY_BASIS_LABEL[b]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Transport">
              <Select value={draft.freightTerm} onChange={(e) => setDraft({ freightTerm: e.target.value as PriceFreightTerm })} className="w-full">
                {(["paid", "to_pay", "not_stated"] as const).map((f) => (
                  <option key={f} value={f}>
                    {FREIGHT_TERM_LABEL[f]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Replaces" className="sm:col-span-2">
              <Select
                value={draft.supersedesId}
                onChange={(e) => setDraft({ supersedesId: e.target.value, scope: e.target.value ? "none" : draft.scope === "none" ? "everybody" : draft.scope })}
                className="w-full"
              >
                <option value="">Nothing — a new list</option>
                {(options?.lists ?? [])
                  .filter((l) => l.status === "published")
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} (v{l.version})
                    </option>
                  ))}
              </Select>
            </Field>
            <Field
              label="Applies to"
              className="sm:col-span-2"
              hint={draft.scope === "none" ? (draft.supersedesId ? "Takes over whoever the list it replaces applied to." : "Nobody yet — it will price no shop until somebody is added.") : undefined}
            >
              <Select value={draft.scope} onChange={(e) => setDraft({ scope: e.target.value })} className="w-full">
                <option value="everybody">Every shop</option>
                <option value="none">{draft.supersedesId ? "Whoever the replaced list applied to" : "Nobody yet — decide later"}</option>
                {(options?.places.states ?? []).map((s) => (
                  <option key={s.key} value={`state:${s.key}`}>
                    Shops in {s.label} ({s.shops})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Signed by">
              <Input value={draft.signatory} onChange={(e) => setDraft({ signatory: e.target.value })} />
            </Field>
            <Field label="Valid (days)">
              <Input value={draft.validityDays} inputMode="numeric" onChange={(e) => setDraft({ validityDays: e.target.value.replace(/[^\d]/g, "") })} />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-divider pt-3">
            <div className="flex flex-wrap items-center gap-4">
              {d.suggestedCount ? (
                <Checkbox
                  label={`Include the ${d.suggestedCount} match${d.suggestedCount === 1 ? "" : "es"} worth checking`}
                  checked={draft.includeSuggested}
                  onChange={(e) => setDraft({ includeSuggested: e.target.checked })}
                />
              ) : null}
              <span className="text-[12.5px] text-muted">
                Becomes <span className="font-medium text-body">{rates}</span> rate{rates === 1 ? "" : "s"}
                {d.rowCount - rates > 0 ? `; ${d.rowCount - rates} cell${d.rowCount - rates === 1 ? "" : "s"} left out` : ""}.
              </span>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => onApprove(false)} disabled={row.phase === "approving" || !draft.name.trim() || !rates}>
                Save as draft
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => onApprove(true)}
                disabled={row.phase === "approving" || !draft.name.trim() || !rates}
                title={why ?? undefined}
              >
                {row.phase === "approving" ? "Approving…" : why ? "Approve anyway" : "Approve & publish"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-ink">What was read</div>
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            <input type="checkbox" className="accent-[#6835FB]" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
            Only rows with something to check
          </label>
        </div>
        <div className="overflow-auto rounded-[6px] border border-line">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="bg-canvas">
              <tr>
                <th className="sticky left-0 bg-canvas px-2.5 py-1.5 text-left font-medium text-muted">Product, as printed</th>
                {detail.grid.columns.map((c) => (
                  <th key={c.colIndex} className="px-2.5 py-1.5 text-right font-medium whitespace-nowrap text-muted">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowsShown.map((r) => (
                <tr key={r.rowIndex} className="border-t border-divider">
                  <td className="sticky left-0 bg-surface px-2.5 py-1.5 font-medium whitespace-nowrap text-ink">{r.rawProductText}</td>
                  {detail.grid.columns.map((c) => {
                    const cell = r.cells.find((x) => x.colIndex === c.colIndex);
                    if (!cell) return <td key={c.colIndex} />;
                    const needsProduct = cell.matchStatus === "held" || cell.matchStatus === "suggested";
                    const tone =
                      cell.matchStatus === "held"
                        ? "bg-danger-soft text-danger"
                        : cell.matchStatus === "suggested"
                          ? "bg-warn-soft text-warn-ink"
                          : cell.matchStatus === "skipped"
                            ? "text-line-strong line-through"
                            : "text-ink";
                    return (
                      <td key={c.colIndex} className="px-1 py-1 text-right">
                        <button
                          type="button"
                          disabled={finished}
                          onClick={() => (needsProduct ? onResolve(cell) : onPrice(cell))}
                          title={`${MATCH_STATUS_LABEL[cell.matchStatus]}${cell.matchedProductName ? ` — ${cell.matchedProductName}` : ""}${finished ? "" : `. Click to ${needsProduct ? "choose the product" : "correct the price"}.`}`}
                          className={cx("w-full rounded px-1.5 py-0.5 text-right tabular-nums", tone, !finished && "cursor-pointer hover:ring-1 hover:ring-brand")}
                        >
                          {cell.offered && cell.rateInclGstPaise != null ? `Rs.${groupRupees(Number(cell.rateInclGstPaise))}` : "—"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[11.5px] text-muted">
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-danger-soft ring-1 ring-danger/40" /> held — no product; click to choose
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-warn-soft ring-1 ring-warn/40" /> worth checking
          </span>
          <span>Any other cell: click to correct the price.</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- confirming */

function ConfirmAll({
  publish,
  rows,
  details,
  draftOf,
  options,
  onCancel,
  onConfirm,
}: {
  publish: boolean;
  rows: Row[];
  details: Record<string, Detail>;
  draftOf: (id: string | null) => Draft | undefined;
  options: PricingOptions | null;
  onCancel: () => void;
  onConfirm: (keys: string[]) => void;
}) {
  const [chosen, setChosen] = React.useState<Set<string>>(new Set(rows.map((r) => r.key)));
  return (
    <Modal
      open
      onClose={onCancel}
      title={publish ? `Put ${chosen.size} list${chosen.size === 1 ? "" : "s"} in force?` : `Save ${chosen.size} list${chosen.size === 1 ? "" : "s"} as drafts?`}
      width={760}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Not yet
          </Button>
          <Button variant="primary" disabled={!chosen.size} onClick={() => onConfirm([...chosen])}>
            {publish ? `Approve ${chosen.size}` : `Save ${chosen.size} drafts`}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-muted">
        {publish
          ? "Each is published through the same checks as the review screen, one after another. Untick any you want to look at again first."
          : "Drafts price nothing. Each can be opened, checked and published from the list screen."}
      </p>
      <table className="w-full text-[13px]">
        <thead className="text-left text-[11px] tracking-[0.04em] text-muted uppercase">
          <tr>
            <th className="w-8 py-1" />
            <th className="py-1">List</th>
            <th className="py-1">From</th>
            <th className="py-1">Applies to</th>
            <th className="py-1 text-right">Rates</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = details[r.documentId!];
            const draft = draftOf(r.documentId)!;
            const [kind, value] = draft.scope.split(":");
            const scope =
              kind === "everybody"
                ? "Every shop"
                : kind === "state"
                  ? `Shops in ${options?.places.states.find((s) => s.key === value)?.label ?? value}`
                  : draft.supersedesId
                    ? "Whoever the replaced list applied to"
                    : "Nobody yet";
            const rates = d.document.matchedCount + (draft.includeSuggested ? d.document.suggestedCount : 0);
            const replaces = options?.lists.find((l) => l.id === draft.supersedesId)?.name;
            return (
              <tr key={r.key} className="border-t border-divider align-top">
                <td className="py-2">
                  <input
                    type="checkbox"
                    className="h-[15px] w-[15px] accent-[#6835FB]"
                    checked={chosen.has(r.key)}
                    onChange={() =>
                      setChosen((s) => {
                        const n = new Set(s);
                        if (n.has(r.key)) n.delete(r.key);
                        else n.add(r.key);
                        return n;
                      })
                    }
                  />
                </td>
                <td className="py-2">
                  <div className="font-medium text-ink">{draft.name}</div>
                  {replaces ? <div className="text-[12px] text-muted">replaces {replaces}</div> : null}
                </td>
                <td className="py-2 whitespace-nowrap">{draft.effectiveFrom}</td>
                <td className={cx("py-2", scope === "Nobody yet" && "text-warn-ink")}>{scope}</td>
                <td className="py-2 text-right tabular-nums">{rates}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Modal>
  );
}

function RejectInline({ filename, onCancel, onReject }: { filename: string; onCancel: () => void; onReject: (reason: string) => void }) {
  const [reason, setReason] = React.useState("");
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Reject ${filename}?`}
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!reason.trim()} onClick={() => onReject(reason.trim())}>
            Reject
          </Button>
        </>
      }
    >
      <Field label="Why" hint="Kept on the document, so the next person does not upload it again.">
        <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="An old copy of last month's list" />
      </Field>
    </Modal>
  );
}

function PhaseBadge({ row, ready, why }: { row: Row; ready: boolean; why: string | null }) {
  const stage =
    row.status && (PARSE_STAGES as readonly string[]).includes(row.status.parseStatus)
      ? PARSE_STAGES.indexOf(row.status.parseStatus as (typeof PARSE_STAGES)[number]) + 1
      : 0;
  switch (row.phase) {
    case "queued":
      return <Badge tone="muted">waiting</Badge>;
    case "uploading":
      return <Badge tone="brand">sending</Badge>;
    case "reading":
      return <Badge tone="brand">{stage ? `${stage}/${PARSE_STAGES.length}` : "reading"}</Badge>;
    case "failed":
      return <Badge tone="danger">failed</Badge>;
    case "approving":
      return <Badge tone="brand">approving</Badge>;
    case "approved":
      return <Badge tone="success">in force</Badge>;
    case "drafted":
      return <Badge tone="neutral">draft</Badge>;
    case "rejected":
      return <Badge tone="muted">rejected</Badge>;
    default:
      return ready ? <Badge tone="success">ready</Badge> : <Badge tone="warn" title={why ?? undefined}>check</Badge>;
  }
}

function FileGlyph() {
  return <span className="mt-0.5 flex h-7 w-6 flex-none items-center justify-center rounded-[3px] border border-line bg-surface text-[8px] font-bold text-danger">PDF</span>;
}
