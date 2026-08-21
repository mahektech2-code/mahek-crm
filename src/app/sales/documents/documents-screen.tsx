"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import {
  publishDocument,
  setDocumentPublished,
  uploadPublishFile,
} from "@/lib/actions/sales";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_HELP,
  documentCategoryLabel,
  type DocumentCategory,
} from "@/lib/mbos/library-labels";
import type { DocumentRow } from "@/lib/services/sales-service";
import {
  Banner,
  Button,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";

/**
 * The library a handset can open, and the door that fills it.
 *
 * The table and the handset screen have existed since MBOS shipped; nothing
 * put a file in between, so the field's document library was empty because it
 * could not be filled. This is that door.
 *
 * **The file is uploaded when it is chosen, not when the form saves.** §4 — an
 * attachment is created before its parent exists and bound when the parent is
 * written, which is what makes an abandoned form leave an orphan for the
 * nightly sweep rather than making the save wait on a network.
 *
 * **Withdrawing is not deleting.** A policy a salesman quoted to a customer in
 * March is a fact about March. Withdrawing takes it off every handset — that
 * is what the tombstone is for — and leaves the record of it here.
 */
export function DocumentsScreen({ rows }: { rows: DocumentRow[] }) {
  const router = useRouter();
  const toast = useToast();

  const [title, setTitle] = React.useState("");
  const [category, setCategory] = React.useState<DocumentCategory>("price_list");
  const [file, setFile] = React.useState<{ id: string; filename: string } | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /* Remounts the file input after a save, which is how a file input is
     cleared — its value cannot be set from code. */
  const [pickerKey, setPickerKey] = React.useState(0);

  async function choose(chosen: File | undefined) {
    if (!chosen) return;
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.set("file", chosen);
    let result;
    try {
      result = await uploadPublishFile(form);
    } finally {
      // Cleared whatever happened: an action that rejects rather
      // than returning a Result would otherwise leave this button
      // disabled until the page was reloaded.
      setUploading(false);
    }
    if (!result.ok) {
      setError(result.error);
      setPickerKey((k) => k + 1);
      return;
    }
    setFile(result.data);
    if (!title.trim()) setTitle(stripExtension(result.data.filename));
  }

  async function publish() {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await publishDocument({
        title,
        category,
        attachmentId: file?.id ?? null,
      });
    } finally {
      // Cleared whatever happened: an action that rejects rather
      // than returning a Result would otherwise leave this button
      // disabled until the page was reloaded.
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setTitle("");
    setFile(null);
    setPickerKey((k) => k + 1);
    toast.push(result.message ?? "Published.");
    router.refresh();
  }

  async function toggle(row: DocumentRow) {
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await setDocumentPublished({
        documentId: row.id,
        published: !row.active,
      });
    } finally {
      // Cleared whatever happened: an action that rejects rather
      // than returning a Result would otherwise leave this button
      // disabled until the page was reloaded.
      setBusy(false);
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  const live = rows.filter((d) => d.active);

  return (
    <div className="p-6">
      <ScreenHeader
        title="Documents"
        subtitle="Price lists, policies and certificates the handset can open. They are held in the same attachment subsystem as every other file in MahekOne — one backup, one restore, one place they can leak from."
      />

      {error ? <Banner tone="danger" title="That did not work" body={error} /> : null}

      <div className="mb-4 rounded-[6px] border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              The file
            </span>
            <input
              key={pickerKey}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              onChange={(e) => void choose(e.target.files?.[0])}
              className="h-8.5 w-[300px] rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px] text-body file:mr-2 file:rounded-[3px] file:border-0 file:bg-canvas file:px-2 file:py-1 file:text-[12px] file:text-body"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              What it is called
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Dealer price list — August"
              title="What the handset lists it by. Choosing a file fills this in from its name; change it to whatever a salesman would look for."
              className="h-8.5 w-[320px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Kind
            </span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as DocumentCategory)}
              className="h-8.5 w-[190px] rounded-[4px] border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-brand"
            >
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {documentCategoryLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <Button
            tone="primary"
            disabled={busy || uploading || !file || !title.trim()}
            title={
              uploading
                ? "Storing the file."
                : !file
                  ? "Choose the file first — a document with nothing behind it is a row the handset can list and cannot open."
                  : !title.trim()
                    ? "It needs a title."
                    : undefined
            }
            onClick={() => void publish()}
          >
            {busy ? "Publishing…" : "Publish"}
          </Button>
        </div>

        <p className="mt-2 text-[13px] text-muted">
          {uploading
            ? "Storing the file…"
            : file
              ? `${file.filename} is stored and will be attached when you publish.`
              : DOCUMENT_CATEGORY_HELP[category]}
        </p>
      </div>

      {rows.length === 0 ? (
        <Empty
          title="Nothing has been published"
          body="Choose a file above and it reaches every handset on its next sync."
        />
      ) : (
        <>
          <MetricRow
            metrics={[
              { label: "Published", value: String(live.length) },
              { label: "Withdrawn", value: String(rows.length - live.length) },
              {
                label: "Against a customer",
                value: String(rows.filter((d) => d.customerName).length),
              },
            ]}
          />

          <Table
            minWidth={1160}
            head={
              <>
                <HeadCell width={300}>Document</HeadCell>
                <HeadCell width={150}>Kind</HeadCell>
                <HeadCell width={110}>Size</HeadCell>
                <HeadCell width={200}>Who can open it</HeadCell>
                <HeadCell width={170}>Updated</HeadCell>
                <HeadCell width={120}>State</HeadCell>
                <HeadCell align="right" width={130} />
              </>
            }
          >
            {rows.map((d, i) => (
              <Row key={d.id} striped={i % 2 === 1}>
                <Cell truncate={300}>
                  {d.attachmentId ? (
                    <a
                      href={`/api/attachments/${d.attachmentId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-ink no-underline hover:underline"
                    >
                      {d.title}
                    </a>
                  ) : (
                    <span className="font-medium text-ink">{d.title}</span>
                  )}
                  {d.customerName ? (
                    <span className="block truncate text-[12px] text-muted">
                      {d.customerName}
                    </span>
                  ) : null}
                </Cell>
                <Cell>{documentCategoryLabel(d.category)}</Cell>
                <Cell>
                  {d.sizeBytes ? (
                    `${Math.round(d.sizeBytes / 1024)} KB`
                  ) : (
                    <span className="text-muted">No file</span>
                  )}
                </Cell>
                <Cell truncate={200}>
                  {d.visibleToRoles?.length ? (
                    d.visibleToRoles.join(", ")
                  ) : (
                    <span className="text-muted">Everybody in the field</span>
                  )}
                </Cell>
                <Cell>{stamp(d.updatedAt)}</Cell>
                <Cell>
                  {d.active ? <Pill tone="success">Published</Pill> : <Pill>Withdrawn</Pill>}
                </Cell>
                <Cell align="right">
                  <Button
                    size="sm"
                    tone={d.active ? "danger" : "default"}
                    disabled={busy}
                    title={
                      d.active
                        ? "Takes it off every handset on their next sync. The record of it stays here."
                        : "Puts it back on every handset."
                    }
                    onClick={() => void toggle(d)}
                  >
                    {d.active ? "Withdraw" : "Publish again"}
                  </Button>
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}
