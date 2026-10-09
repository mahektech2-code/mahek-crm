"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import {
  publishDocument,
  setDocumentPeople,
  setDocumentPublished,
  updateDocument,
} from "@/lib/actions/sales";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_HELP,
  documentCategoryLabel,
  type DocumentCategory,
} from "@/lib/mbos/library-labels";
import type { DocumentPerson, DocumentRow } from "@/lib/services/sales-service";
import {
  Banner,
  Button,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  RowMenu,
  ScreenHeader,
  Table,
} from "@/components/console/parts";
import { ConfirmDialog, Drawer, DrawerHeader, Modal } from "@/components/ui/overlays";
import { cx } from "@/components/ui/primitives";
import { plural } from "@/components/console/words";
import { callAction } from "@/lib/call-action";
import { uploadPublishFile } from "../publish-upload";
import { AudienceLine, Initials, TagPeopleModal } from "./tag-people";

/**
 * The library a handset can open, who each document is for, and the doors that
 * fill it, narrow it and take it back.
 *
 * **Nothing ever reached this screen bigger than a megabyte.** The file went up
 * through a server action, Next refuses those past 1 MB before our code runs,
 * and the rejection was never caught — so a real price list stopped the spinner
 * and did nothing else. It goes to `/api/sales/publish-file` now, and every
 * failure comes back as a sentence on this screen.
 *
 * **Who it is for is a list of people, and empty means everybody.** Tagging
 * narrows a document to named salesmen; the pull, the handset's file route and
 * the attachment endpoint all ask the same `visible_to_user_ids`, and untagging
 * somebody writes the tombstone that takes it off his phone.
 *
 * **The file is uploaded when it is chosen, not when the form saves.** §4 — an
 * attachment is created before its parent exists and bound when the parent is
 * written, which is what makes an abandoned form leave an orphan for the
 * nightly sweep rather than making the save wait on a network.
 *
 * **Withdrawing is not deleting.** A policy a salesman quoted to a customer in
 * March is a fact about March. Withdrawing takes it off every handset — that
 * is what the tombstone is for — and leaves the record of it here, publishable
 * again with its tags intact.
 */

type View = "all" | "published" | "tagged" | "withdrawn";
type Picked = { id: string; filename: string; sizeBytes: number };

export function DocumentsScreen({
  rows,
  people,
}: {
  rows: DocumentRow[];
  people: DocumentPerson[];
}) {
  const router = useRouter();
  const toast = useToast();

  const [view, setView] = React.useState<View>("all");
  const [query, setQuery] = React.useState("");
  const [publishing, setPublishing] = React.useState(0); // a key: 0 is shut
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [tagging, setTagging] = React.useState<DocumentRow | null>(null);
  const [withdrawing, setWithdrawing] = React.useState<DocumentRow | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [tagError, setTagError] = React.useState<string | null>(null);

  const open = rows.find((r) => r.id === openId) ?? null;

  const live = rows.filter((d) => d.active);
  const counts: Record<View, number> = {
    all: rows.length,
    published: live.length,
    tagged: live.filter((d) => d.tagged.length > 0).length,
    withdrawn: rows.length - live.length,
  };

  const needle = query.trim().toLowerCase();
  const shown = rows.filter((d) => {
    if (view === "published" && !d.active) return false;
    if (view === "withdrawn" && d.active) return false;
    if (view === "tagged" && !(d.active && d.tagged.length > 0)) return false;
    if (!needle) return true;
    return (
      d.title.toLowerCase().includes(needle) ||
      (d.filename ?? "").toLowerCase().includes(needle) ||
      d.tagged.some((p) => p.name.toLowerCase().includes(needle))
    );
  });

  function startTagging(d: DocumentRow) {
    setTagError(null);
    setTagging(d);
  }

  async function saveTags(doc: DocumentRow, userIds: string[]) {
    setBusy(true);
    setTagError(null);
    setError(null);
    const result = await callAction(setDocumentPeople({ documentId: doc.id, userIds }));
    setBusy(false);
    const failure = result.ok ? null : result.error;
    if (failure) {
      // Under the picker if it is open, on the screen if the drawer asked.
      if (tagging) setTagError(failure);
      else setError(failure);
      return;
    }
    setTagging(null);
    toast.push((result?.ok && result.message) || "Saved.");
    router.refresh();
  }

  async function setPublished(doc: DocumentRow, published: boolean) {
    setBusy(true);
    setError(null);
    const result = await callAction(setDocumentPublished({ documentId: doc.id, published }));
    setBusy(false);
    setWithdrawing(null);
    if (!result.ok) return setError(result.error);
    toast.push(result.message ?? "Saved.");
    router.refresh();
  }

  function menuFor(d: DocumentRow) {
    const hr = hrmsReason(d);
    return [
      { label: "View details", run: () => setOpenId(d.id) },
      {
        label: d.tagged.length ? "Edit tagged employees" : "Tag employees",
        run: () => startTagging(d),
        disabled: !!hr,
        title: hr ?? undefined,
      },
      ...(d.attachmentId ? [{ label: "Open the file", href: `/api/attachments/${d.attachmentId}` }] : []),
      d.active
        ? {
            label: "Withdraw",
            danger: true,
            run: () => setWithdrawing(d),
            disabled: !!hr,
            title: hr ?? undefined,
          }
        : {
            label: "Publish again",
            run: () => void setPublished(d, true),
            disabled: !!hr,
            title: hr ?? undefined,
          },
    ];
  }

  return (
    <div className="p-6">
      <ScreenHeader
        title="Documents"
        subtitle="Price lists, policies and certificates the handset can open. Publish to everybody in the field, or tag the people a document is for — it reaches their phones on the next sync and leaves the phone of anybody untagged."
        actions={
          <Button
            tone="primary"
            onClick={() => {
              setError(null);
              setPublishing((k) => k + 1);
            }}
          >
            Publish a document
          </Button>
        }
      />

      {error ? <Banner tone="danger" title="That did not work" body={error} /> : null}

      {rows.length === 0 ? (
        <Empty
          title="Nothing has been published"
          body="Publish a price list, a catalogue or a policy and it reaches every handset — or only the people you tag — on their next sync."
          action={
            <Button tone="primary" onClick={() => setPublishing((k) => k + 1)}>
              Publish a document
            </Button>
          }
        />
      ) : (
        <>
          <MetricRow
            metrics={[
              { label: "Published", value: String(live.length) },
              { label: "For everybody in the field", value: String(live.length - counts.tagged) },
              { label: "Tagged to named people", value: String(counts.tagged) },
              { label: "Withdrawn", value: String(counts.withdrawn) },
            ]}
          />

          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  ["all", "All"],
                  ["published", "Published"],
                  ["tagged", "Tagged"],
                  ["withdrawn", "Withdrawn"],
                ] as [View, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  className={cx(
                    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[4px] border px-3 text-[13px] whitespace-nowrap",
                    view === key
                      ? "border-brand bg-brand-soft font-medium text-[#5223E0]"
                      : "border-line bg-surface text-body hover:bg-canvas",
                  )}
                >
                  {label}
                  <span className="text-muted">{counts[key]}</span>
                </button>
              ))}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a title or a person"
              aria-label="Search documents"
              className="h-8 w-[260px] rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand"
            />
          </div>

          {shown.length === 0 ? (
            <Empty
              title="Nothing matches"
              body={needle ? `No document or person matches “${query.trim()}” here.` : "Nothing is in this view."}
            />
          ) : (
            <Table
              minWidth={1140}
              head={
                <>
                  <HeadCell width={300}>Document</HeadCell>
                  <HeadCell width={120}>Kind</HeadCell>
                  <HeadCell width={250}>Who sees it</HeadCell>
                  <HeadCell width={150}>Updated</HeadCell>
                  <HeadCell width={120}>State</HeadCell>
                  <HeadCell align="right" width={200} />
                </>
              }
            >
              {shown.map((d, i) => {
                const hr = hrmsReason(d);
                return (
                  <Row key={d.id} striped={i % 2 === 1} onClick={() => setOpenId(d.id)}>
                    <Cell truncate={300}>
                      <span className="block truncate font-medium text-ink">{d.title}</span>
                      <span className="block truncate text-[12px] text-muted">
                        {d.filename ? `${d.filename} · ${sizeLabel(d.sizeBytes)}` : "No file"}
                        {d.customerName ? ` · ${d.customerName}` : ""}
                      </span>
                    </Cell>
                    <Cell>{documentCategoryLabel(d.category)}</Cell>
                    <Cell truncate={250}>
                      {d.fromHrms ? (
                        <span className="text-muted">Set in HRMS</span>
                      ) : (
                        <AudienceLine tagged={d.tagged} />
                      )}
                    </Cell>
                    <Cell>{stamp(d.updatedAt)}</Cell>
                    <Cell>{d.active ? <Pill tone="success">Published</Pill> : <Pill>Withdrawn</Pill>}</Cell>
                    <Cell align="right" onClick={(e) => e.stopPropagation()}>
                      <span className="inline-flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={!!hr}
                          title={hr ?? "Choose which salesmen see this on their handset."}
                          onClick={() => startTagging(d)}
                        >
                          Tag employees
                        </Button>
                        <RowMenu items={menuFor(d)} />
                      </span>
                    </Cell>
                  </Row>
                );
              })}
            </Table>
          )}
        </>
      )}

      {publishing ? (
        <PublishModal
          key={publishing}
          people={people}
          onClose={() => setPublishing(0)}
          onDone={(message) => {
            setPublishing(0);
            toast.push(message);
            router.refresh();
          }}
        />
      ) : null}

      {open ? (
        <DetailsDrawer
          key={`${open.id}:${String(open.updatedAt)}`}
          doc={open}
          busy={busy}
          failure={error}
          onClose={() => setOpenId(null)}
          onTag={() => startTagging(open)}
          onUntag={(id) => void saveTags(open, open.visibleToUserIds.filter((u) => u !== id))}
          onEveryone={() => void saveTags(open, [])}
          onWithdraw={() => setWithdrawing(open)}
          onRepublish={() => void setPublished(open, true)}
          onSaved={(message) => {
            toast.push(message);
            router.refresh();
          }}
        />
      ) : null}

      {/* After the drawer, so it opens OVER it — the drawer's "Edit tagged
          employees" is one of the two doors into it. */}
      {tagging ? (
        <TagPeopleModal
          key={tagging.id}
          title={tagging.title}
          people={people}
          initial={tagging.visibleToUserIds}
          extra={tagging.tagged}
          busy={busy}
          error={tagError}
          onClose={() => setTagging(null)}
          onSave={(ids) => void saveTags(tagging, ids)}
        />
      ) : null}

      <ConfirmDialog
        open={!!withdrawing}
        title="Withdraw this document?"
        body={
          withdrawing ? (
            <>
              <span className="font-medium text-ink">{withdrawing.title}</span> comes off{" "}
              {withdrawing.tagged.length
                ? `the handsets of the ${plural(withdrawing.tagged.length, "person", "people")} tagged`
                : "every handset in the field"}{" "}
              on their next sync. The record stays here, with who it was for, and it can be published
              again.
            </>
          ) : null
        }
        confirmLabel="Withdraw"
        cancelLabel="Keep it published"
        destructive
        onConfirm={() => (withdrawing ? setPublished(withdrawing, false) : undefined)}
        onClose={() => setWithdrawing(null)}
      />
    </div>
  );
}

/**
 * HR's documents live in the same table and are listed here so the field's
 * library is the whole library — but who they are for is HRMS's question
 * (`audience`), asked on HRMS's own screen, and a second door onto it from here
 * would be two answers to one question.
 */
function hrmsReason(d: DocumentRow): string | null {
  return d.fromHrms ? "Published from HRMS — who it is for is changed on HRMS → Documents." : null;
}

function sizeLabel(bytes: number | null): string {
  if (!bytes) return "size unknown";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function extensionBadge(filename: string | null | undefined): string {
  const ext = (filename ?? "").includes(".") ? (filename ?? "").split(".").pop() ?? "" : "";
  return ext.toUpperCase().slice(0, 4) || "FILE";
}

const FIELD_LABEL = "mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase";
const INPUT =
  "h-9 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand";

/* ------------------------------------------------------------- the file box */

/**
 * Choosing a file stores it at once and says so; a refusal says why in words
 * under the box. The input is remounted to clear it, because a file input's
 * value cannot be set from code.
 */
function FilePicker({
  file,
  current,
  onPicked,
}: {
  file: Picked | null;
  /** What is behind the document now, for the replace case. */
  current?: string | null;
  onPicked: (file: Picked) => void;
}) {
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [key, setKey] = React.useState(0);

  async function choose(chosen: File | undefined) {
    if (!chosen) return;
    setUploading(true);
    setError(null);
    // Never rejects — every failure, the network's included, is a Result.
    const result = await uploadPublishFile(chosen);
    setUploading(false);
    if (!result.ok) {
      setError(result.error);
      setKey((k) => k + 1);
      return;
    }
    onPicked(result.data);
  }

  return (
    <div>
      <label
        className={cx(
          "flex items-center gap-3 rounded-[6px] border border-dashed px-3 py-3",
          uploading ? "cursor-wait" : "cursor-pointer",
          error ? "border-danger" : "border-line-strong hover:border-brand hover:bg-canvas",
        )}
      >
        <input
          key={key}
          type="file"
          disabled={uploading}
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          onChange={(e) => void choose(e.target.files?.[0])}
          className="sr-only"
        />
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-[11px] font-semibold text-[#5223E0]">
          {file ? extensionBadge(file.filename) : "PDF"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">
            {uploading
              ? "Storing the file…"
              : file
                ? file.filename
                : current
                  ? "Choose a new file to replace it"
                  : "Choose a file"}
          </span>
          <span className="block truncate text-[12px] text-muted">
            {uploading
              ? "This can take a moment for a large PDF."
              : file
                ? `${sizeLabel(file.sizeBytes)} · stored, and attached when you save`
                : current
                  ? `Now: ${current}`
                  : "PDF, JPG or PNG"}
          </span>
        </span>
        <span className="text-[13px] font-medium text-brand">{file || current ? "Change" : "Browse"}</span>
      </label>
      {error ? <p className="mt-1.5 text-[13px] text-danger">{error}</p> : null}
    </div>
  );
}

/* ---------------------------------------------------------- the publish form */

function PublishModal({
  people,
  onClose,
  onDone,
}: {
  people: DocumentPerson[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [file, setFile] = React.useState<Picked | null>(null);
  const [title, setTitle] = React.useState("");
  const [category, setCategory] = React.useState<DocumentCategory>("price_list");
  const [tagged, setTagged] = React.useState<string[]>([]);
  const [picking, setPicking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const byId = new Map(people.map((p) => [p.id, p]));
  const chosen = tagged.map((id) => byId.get(id)).filter((p): p is DocumentPerson => !!p);

  async function publish() {
    setBusy(true);
    setError(null);
    const result = await callAction(publishDocument({
      title,
      category,
      attachmentId: file?.id ?? null,
      visibleToUserIds: tagged,
    }));
    setBusy(false);
    if (!result.ok) return setError(result.error);
    onDone(result.message ?? "Published.");
  }

  const why = !file
    ? "Choose the file first — a document with nothing behind it is a row the handset can list and cannot open."
    : !title.trim()
      ? "It needs a title."
      : undefined;

  return (
    <>
      {/* Shut while the picker is up rather than stacked under it: one dialog
          at a time, and the form's state lives here either way. */}
      <Modal
        open={!picking}
        onClose={onClose}
        width={560}
        title="Publish a document"
        footer={
          <>
            <Button tone="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button tone="primary" disabled={busy || !!why} title={why} onClick={() => void publish()}>
              {busy ? "Publishing…" : "Publish"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error ? <Banner tone="danger" title="That did not publish" body={error} /> : null}

          <div>
            <span className={FIELD_LABEL}>The file</span>
            <FilePicker
              file={file}
              onPicked={(f) => {
                setFile(f);
                if (!title.trim()) setTitle(stripExtension(f.filename));
              }}
            />
          </div>

          <div className="grid grid-cols-[1fr_180px] gap-3">
            <label className="block">
              <span className={FIELD_LABEL}>What it is called</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={160}
                placeholder="Dealer price list — August"
                title="What the handset lists it by. Choosing a file fills this in from its name; change it to whatever a salesman would look for."
                className={INPUT}
              />
            </label>
            <label className="block">
              <span className={FIELD_LABEL}>Kind</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as DocumentCategory)}
                className={INPUT}
              >
                {DOCUMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {documentCategoryLabel(c)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="-mt-2 text-[12px] text-muted">{DOCUMENT_CATEGORY_HELP[category]}</p>

          <div>
            <span className={FIELD_LABEL}>Who sees it</span>
            <div className="rounded-[6px] border border-line px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-body">
                  {chosen.length
                    ? `Only the ${plural(chosen.length, "person", "people")} you tagged`
                    : "Everybody in the field"}
                </span>
                <span className="flex gap-1.5">
                  {chosen.length ? (
                    <Button size="sm" tone="quiet" onClick={() => setTagged([])}>
                      Everybody instead
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => setPicking(true)}>
                    {chosen.length ? "Edit tags" : "Tag employees"}
                  </Button>
                </span>
              </div>
              {chosen.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {chosen.map((p) => (
                    <PersonChip
                      key={p.id}
                      person={p}
                      onRemove={() => setTagged(tagged.filter((t) => t !== p.id))}
                    />
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-[12px] text-muted">Tag employees to send it to named salesmen only.</p>
              )}
            </div>
          </div>
        </div>
      </Modal>

      {picking ? (
        <TagPeopleModal
          title={title.trim() || "A new document"}
          people={people}
          initial={tagged}
          confirmLabel="Done"
          onClose={() => setPicking(false)}
          onSave={(ids) => {
            setTagged(ids);
            setPicking(false);
          }}
        />
      ) : null}
    </>
  );
}

function PersonChip({
  person,
  onRemove,
}: {
  person: { id: string; name: string; initials: string };
  onRemove?: () => void;
}) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-[14px] border border-line bg-surface pr-1 pl-1 text-[12px] text-body">
      <Initials initials={person.initials} small />
      <span className="pr-1">{person.name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Untag ${person.name}`}
          title={`Untag ${person.name}`}
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-canvas hover:text-danger"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

/* ----------------------------------------------------------- one document */

/**
 * Everything about one document, and every change to it, in one place: who it
 * is tagged to with a way to untag each one, the file and its replacement, the
 * title and the kind, and when it was published and last changed. Keyed on the
 * row's `updatedAt`, so a save remounts it with what was saved.
 */
function DetailsDrawer({
  doc,
  busy,
  failure,
  onClose,
  onTag,
  onUntag,
  onEveryone,
  onWithdraw,
  onRepublish,
  onSaved,
}: {
  doc: DocumentRow;
  busy: boolean;
  /** The screen's own error — an untag or a withdrawal refused while this is open would otherwise land behind it. */
  failure: string | null;
  onClose: () => void;
  onTag: () => void;
  onUntag: (userId: string) => void;
  onEveryone: () => void;
  onWithdraw: () => void;
  onRepublish: () => void;
  onSaved: (message: string) => void;
}) {
  const hr = hrmsReason(doc);
  const knownCategory = (DOCUMENT_CATEGORIES as readonly string[]).includes(doc.category);
  const [editing, setEditing] = React.useState(false);
  const [title, setTitle] = React.useState(doc.title);
  const [category, setCategory] = React.useState<DocumentCategory>(
    knownCategory ? (doc.category as DocumentCategory) : "policy",
  );
  const [file, setFile] = React.useState<Picked | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    const result = await callAction(updateDocument({
      documentId: doc.id,
      title,
      category,
      attachmentId: file?.id ?? null,
    }));
    setSaving(false);
    if (!result.ok) return setError(result.error);
    setEditing(false);
    onSaved(result.message ?? "Saved.");
  }

  function cancelEdit() {
    setEditing(false);
    setTitle(doc.title);
    setFile(null);
    setError(null);
  }

  return (
    <Drawer open onClose={onClose} width={500} label={doc.title}>
      <DrawerHeader onClose={onClose}>
        <span className="block text-[12px] text-muted">{documentCategoryLabel(doc.category)}</span>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold break-words text-ink">{doc.title}</span>
          {doc.active ? <Pill tone="success">Published</Pill> : <Pill>Withdrawn</Pill>}
        </span>
      </DrawerHeader>

      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4 text-[13px] text-body">
        {failure ? <Banner tone="danger" title="That did not work" body={failure} /> : null}
        {hr ? <Banner tone="warn" title="From HRMS" body={hr} /> : null}

        {/* ------------------------------------------------- who sees it */}
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Who sees it{doc.tagged.length ? ` · ${doc.tagged.length}` : ""}
            </h3>
            {!hr ? (
              <Button size="sm" onClick={onTag}>
                {doc.tagged.length ? "Edit tagged employees" : "Tag employees"}
              </Button>
            ) : null}
          </div>
          {doc.tagged.length === 0 ? (
            <div className="rounded-[6px] border border-line bg-canvas px-3 py-3">
              <div className="font-medium text-ink">{hr ? "Decided in HRMS" : "Everybody in the field"}</div>
              <p className="mt-0.5 text-muted">
                {hr
                  ? "HRMS decides who this is for."
                  : "Nobody is tagged, so every handset holding the field app gets it. Tag employees to narrow it to named people."}
              </p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-divider rounded-[6px] border border-line">
                {doc.tagged.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                    <Initials initials={p.initials} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{p.name}</span>
                      {!p.inField ? (
                        <span className="block text-[12px] text-warn-ink">
                          No longer holds the field app — the document cannot reach them.
                        </span>
                      ) : null}
                    </span>
                    <Button
                      size="sm"
                      tone="quiet"
                      disabled={busy || !!hr}
                      title={
                        doc.tagged.length === 1
                          ? "Untagging the last person makes it for everybody in the field."
                          : `Takes it off ${p.name}'s handset on the next sync.`
                      }
                      onClick={() => onUntag(p.id)}
                    >
                      Untag
                    </Button>
                  </li>
                ))}
              </ul>
              {!hr ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onEveryone}
                  className="mt-2 cursor-pointer text-[13px] font-medium text-brand hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Make it for everybody in the field
                </button>
              ) : null}
            </>
          )}
          {!doc.active && doc.tagged.length ? (
            <p className="mt-2 text-muted">
              Withdrawn, so it is on nobody&apos;s phone now. These are the people it goes back to if it is
              published again.
            </p>
          ) : null}
        </section>

        {/* ------------------------------------------------------ the file */}
        <section>
          <h3 className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">The file</h3>
          {doc.attachmentId ? (
            <a
              href={`/api/attachments/${doc.attachmentId}`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 rounded-[6px] border border-line px-3 py-2.5 no-underline hover:border-brand hover:bg-canvas"
            >
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[4px] bg-brand-soft text-[11px] font-semibold text-[#5223E0]">
                {extensionBadge(doc.filename)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{doc.filename ?? "The file"}</span>
                <span className="block text-[12px] text-muted">{sizeLabel(doc.sizeBytes)} · opens in a new tab</span>
              </span>
              <span className="text-[13px] font-medium text-brand">Open</span>
            </a>
          ) : (
            <p className="text-muted">No file is attached.</p>
          )}
          {doc.customerName ? (
            <p className="mt-2 text-muted">
              Belongs to <span className="text-body">{doc.customerName}</span> — only handsets with that shop in
              their book can open it.
            </p>
          ) : null}
        </section>

        {/* ---------------------------------------------------- the details */}
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Details</h3>
            {!editing && !hr ? (
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
          </div>
          {editing ? (
            <div className="space-y-3 rounded-[6px] border border-line px-3 py-3">
              {error ? <p className="text-danger">{error}</p> : null}
              <label className="block">
                <span className={FIELD_LABEL}>What it is called</span>
                <input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
              </label>
              <label className="block">
                <span className={FIELD_LABEL}>Kind</span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as DocumentCategory)}
                  className={INPUT}
                >
                  {DOCUMENT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {documentCategoryLabel(c)}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <span className={FIELD_LABEL}>Replace the file</span>
                <FilePicker file={file} current={doc.filename} onPicked={setFile} />
                <p className="mt-1 text-[12px] text-muted">
                  The same document with a new file: it keeps its tags, and handsets fetch the new file on their
                  next sync.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button tone="quiet" onClick={cancelEdit}>
                  Cancel
                </Button>
                <Button
                  tone="primary"
                  disabled={saving || !title.trim()}
                  title={!title.trim() ? "It needs a title." : undefined}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          ) : (
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-muted">Title</dt>
              <dd className="text-ink">{doc.title}</dd>
              <dt className="text-muted">Kind</dt>
              <dd>{documentCategoryLabel(doc.category)}</dd>
              <dt className="text-muted">Published</dt>
              <dd>
                {stamp(doc.createdAt)}
                {doc.createdByName ? ` by ${doc.createdByName}` : ""}
              </dd>
              <dt className="text-muted">Last changed</dt>
              <dd>
                {stamp(doc.updatedAt)}
                {doc.updatedByName ? ` by ${doc.updatedByName}` : ""}
              </dd>
            </dl>
          )}
        </section>
      </div>

      {!hr ? (
        <div className="flex flex-none justify-end gap-2 border-t border-line px-5 py-3">
          {doc.active ? (
            <Button tone="danger" disabled={busy} onClick={onWithdraw}>
              Withdraw
            </Button>
          ) : (
            <Button tone="primary" disabled={busy} onClick={onRepublish}>
              {busy ? "Publishing…" : "Publish again"}
            </Button>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
