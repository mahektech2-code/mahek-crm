"use client";

/* ---------------------------------------------------------------------------
 * BRINGING A FOLDER OF PRICE LISTS IN.
 *
 * Thirty scanned PDFs is the ordinary import, and the two mistakes it would be
 * easy to make are both about what happens when one of them goes wrong.
 *
 *   THE UPLOAD IS ONE REQUEST AND THE READING IS THIRTY. A server action's
 *   body is capped at a megabyte, so the files go to the upload route — all of
 *   them at once, because that is one journey over a slow office line — and it
 *   answers with a row per file saying what it became. Reading them is then
 *   one call each, watched through the status endpoint, so the screen has
 *   something to show for every one of the minutes this takes.
 *
 *   ONE FILE FAILING IS NOT THE IMPORT FAILING. A duplicate, a photograph of
 *   somebody's desk, a PDF with no text in it: each one is its own row with
 *   its own answer, and the other twenty-nine carry on. Nothing here is
 *   all-or-nothing.
 *
 * Only the file being read right now draws the animation. Finished ones
 * collapse to a line with a link into the review screen, because a wall of
 * five animations is a wall of movement nobody can read.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import {
  ParseAnimation,
  isTerminalParseStatus,
  type DocumentStatusPoll,
} from "@/components/pricing/parse-animation";
import { DOCUMENT_STATUS_LABEL, DOCUMENT_STATUS_TONE } from "@/lib/price-list-labels";

const ACCEPTED = "application/pdf,image/jpeg,image/png";
const POLL_MS = 600;

type RowState =
  | "queued"
  | "uploading"
  | "parsing"
  | "done"
  | "review"
  | "failed"
  | "duplicate";

type Row = {
  key: string;
  name: string;
  size: number;
  state: RowState;
  documentId: string | null;
  duplicateOf: string | null;
  error: string | null;
  status: DocumentStatusPoll | null;
};

type UploadAnswer = {
  filename: string;
  documentId?: string | null;
  duplicateOf?: string | null;
  error?: string | null;
};

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A row as it stands before anything has been sent. Keyed by the file's own place in the list. */
function blankRow(file: File, index: number): Row {
  return {
    key: `${file.name}:${file.size}:${index}`,
    name: file.name,
    size: file.size,
    state: "queued",
    documentId: null,
    duplicateOf: null,
    error: null,
    status: null,
  };
}

/** What a poll answer means for the row it belongs to. */
function stateFor(status: DocumentStatusPoll | null): RowState {
  if (!status) return "parsing";
  if (!isTerminalParseStatus(status.parseStatus)) return "parsing";
  if (status.parseStatus === "needs_review") return "review";
  if (status.parseStatus === "failed" || status.parseStatus === "rejected") return "failed";
  return "done";
}

export function ImportModal({
  open,
  onClose,
  basePath,
  openKey = 0,
}: {
  open: boolean;
  onClose: () => void;
  basePath: string;
  /** Bumped by the caller each time it opens, so a reopen starts from nothing. */
  openKey?: number;
}) {
  if (!open) return null;
  return <ImportBody key={openKey} onClose={onClose} basePath={basePath} />;
}

function ImportBody({ onClose, basePath }: { onClose: () => void; basePath: string }) {
  const router = useRouter();
  const [rows, setRows] = React.useState<Row[]>([]);
  const [running, setRunning] = React.useState(false);
  const [finished, setFinished] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  /* The import outlives a stray unmount only in the sense that the server
     carries on; the polling loop has to stop, and this is what tells it to. */
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const patch = React.useCallback((key: string, next: Partial<Row>) => {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...next } : r)));
  }, []);

  /*
   * The File objects live in a ref rather than in state: they are not
   * rendered, and a re-render for a byte array is a re-render for nothing.
   * The rows are DERIVED from them in one pass, so the two lists cannot fall
   * out of step — which is what made the same file appear twice the first time
   * somebody dropped a folder they had already dropped half of.
   */
  const filesRef = React.useRef<File[]>([]);

  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setError(null);
    const existing = filesRef.current;
    const seen = new Set(existing.map((f) => `${f.name}:${f.size}`));
    const added: File[] = [];
    for (const file of Array.from(list)) {
      const id = `${file.name}:${file.size}`;
      if (seen.has(id)) continue;
      seen.add(id);
      added.push(file);
    }
    if (!added.length) return;
    const next = [...existing, ...added];
    filesRef.current = next;
    setRows(next.map(blankRow));
  }

  async function start() {
    if (!filesRef.current.length || running) return;
    setRunning(true);
    setError(null);

    try {
      const form = new FormData();
      for (const file of filesRef.current) form.append("files", file);
      setRows((current) => current.map((r) => (r.state === "queued" ? { ...r, state: "uploading" } : r)));

      const response = await fetch("/api/price-lists/upload", { method: "POST", body: form });
      const payload = (await response.json().catch(() => null)) as
        | { documents?: UploadAnswer[]; error?: string }
        | null;

      if (!response.ok) {
        setError(payload?.error ?? "That upload was refused.");
        setRows((current) =>
          current.map((r) => (r.state === "uploading" ? { ...r, state: "failed", error: payload?.error ?? "Refused." } : r)),
        );
        return;
      }

      const answers = payload?.documents ?? [];
      const sent = filesRef.current;
      const paired: Row[] = sent.map((file, i) => {
        const row = blankRow(file, i);
        const answer = answers.length === sent.length ? answers[i] : answers.find((a) => a.filename === row.name);
        if (!answer) return { ...row, state: "failed", error: "The server said nothing about this file." };
        if (answer.error) return { ...row, state: "failed", error: answer.error };
        if (answer.duplicateOf) {
          return { ...row, state: "duplicate", documentId: answer.duplicateOf, duplicateOf: answer.duplicateOf };
        }
        if (answer.documentId) return { ...row, state: "parsing", documentId: answer.documentId };
        return { ...row, state: "failed", error: "This file produced no document." };
      });
      setRows(paired);

      /* One at a time. The parser is the expensive half and thirty at once
         would simply queue on the server with nothing on the screen saying so. */
      for (const row of paired) {
        if (!alive.current) return;
        if (row.state !== "parsing" || !row.documentId) continue;
        await parseOne(row.key, row.documentId);
      }
    } catch {
      setError("The import could not be sent. Check the connection and try again.");
    } finally {
      if (alive.current) {
        setRunning(false);
        setFinished(true);
        router.refresh();
      }
    }
  }

  /**
   * Start the reading, and watch it.
   *
   * The POST does not answer until the parse is over, so the watching is a
   * detached loop beside it rather than a race — and the POST is what says
   * whether the reading was refused outright, which no amount of polling a
   * status that never moves would ever tell us.
   */
  async function parseOne(key: string, documentId: string) {
    const stop = { value: false };
    void watch(key, documentId, stop);

    let refusal: string | null = null;
    try {
      const response = await fetch(`/api/price-lists/documents/${documentId}/parse`, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        refusal = body?.error ?? "Reading this file was refused.";
      }
    } catch {
      refusal = "Reading this file failed part-way.";
    }
    stop.value = true;
    if (!alive.current) return;

    if (refusal) {
      patch(key, { state: "failed", error: refusal });
      return;
    }
    const final = await poll(documentId);
    patch(key, { status: final, state: stateFor(final) });
  }

  /** The poll, running while the parse request is open. */
  async function watch(key: string, documentId: string, stop: { value: boolean }) {
    while (!stop.value && alive.current) {
      const status = await poll(documentId);
      if (stop.value || !alive.current) return;
      if (status) patch(key, { status, state: stateFor(status) });
      await sleep(POLL_MS);
    }
  }

  async function poll(documentId: string): Promise<DocumentStatusPoll | null> {
    try {
      const response = await fetch(`/api/price-lists/documents/${documentId}/status`, { cache: "no-store" });
      if (!response.ok) return null;
      return (await response.json()) as DocumentStatusPoll;
    } catch {
      return null;
    }
  }

  function reset() {
    filesRef.current = [];
    setRows([]);
    setFinished(false);
    setError(null);
  }

  const activeKey = rows.find((r) => r.state === "parsing")?.key ?? null;

  return (
    <Modal
      open
      onClose={running ? () => undefined : onClose}
      title="Import a price list"
      width={640}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={running}
            title={running ? "Wait for the files being read to finish." : undefined}
          >
            {finished ? "Close" : "Cancel"}
          </Button>
          {finished ? (
            <Button variant="primary" onClick={reset}>
              Import more
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void start()}
              disabled={running || rows.length === 0}
              title={rows.length === 0 ? "Choose at least one file first." : undefined}
            >
              {running ? "Reading…" : `Start${rows.length ? ` (${rows.length})` : ""}`}
            </Button>
          )}
        </>
      }
    >
      {error ? <Callout tone="danger">{error}</Callout> : null}

      {!running && !finished ? (
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
            "mb-4 cursor-pointer rounded-[6px] border border-dashed px-6 py-8 text-center transition-colors duration-100",
            dragging ? "border-brand bg-brand-soft" : "border-line-strong bg-canvas hover:border-brand",
          )}
        >
          <div className="text-sm font-medium text-ink">Drop the price lists here</div>
          <div className="mt-1 text-[13px] text-muted">
            Or click to choose them. PDF, JPG or PNG — a scan of a signed sheet is fine.
          </div>
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
      ) : null}

      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">
          Nothing chosen yet. A price list starts life as the PDF somebody was sent.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.key}>
              {row.key === activeKey ? (
                <ParseAnimation status={row.status} filename={row.name} />
              ) : (
                <CompactRow row={row} basePath={basePath} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function CompactRow({ row, basePath }: { row: Row; basePath: string }) {
  const tone =
    row.state === "done"
      ? "success"
      : row.state === "review"
        ? "warn"
        : row.state === "failed"
          ? "danger"
          : row.state === "duplicate"
            ? "muted"
            : "neutral";

  const label =
    row.state === "queued"
      ? "Waiting"
      : row.state === "uploading"
        ? "Uploading"
        : row.state === "duplicate"
          ? "Already here"
          : row.status
            ? DOCUMENT_STATUS_LABEL[row.status.parseStatus]
            : row.state === "failed"
              ? "Could not be read"
              : "Reading";

  const badgeTone = row.status ? DOCUMENT_STATUS_TONE[row.status.parseStatus] : tone;

  return (
    <div className="flex items-center gap-3 rounded-[4px] border border-line bg-surface px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-ink" title={row.name}>
          {row.name}
        </div>
        <div className="text-[11px] text-muted">
          {sizeLabel(row.size)}
          {row.error ? ` · ${row.error}` : null}
          {row.status && row.state !== "failed"
            ? ` · ${row.status.rowCount} cells · ${row.status.matchedCount} matched`
            : null}
        </div>
      </div>
      <Badge tone={badgeTone}>{label}</Badge>
      {row.documentId && row.state !== "failed" ? (
        <Link
          href={`${basePath}/documents/${row.documentId}`}
          className="text-[13px] font-medium text-brand hover:underline"
        >
          Review
        </Link>
      ) : null}
    </div>
  );
}
