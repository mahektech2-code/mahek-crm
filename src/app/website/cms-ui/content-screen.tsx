"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, Card, EmptyState, PageHeader, Td, Th, Tr } from "@/components/ui/primitives";
import { Drawer, DrawerHeader, FilterPills, Modal, RowMenu, type MenuItem } from "@/components/ui/overlays";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import type { ImpactConfirmation } from "@/lib/impact/types";
import type { Result } from "@/lib/result";
import { useToast } from "@/components/ui/toast";
import {
  archiveItemAction,
  createContentAction,
  deleteDraftAction,
  discardChangesAction,
  moveContentAction,
  previewItemAction,
  publishItemsAction,
  publishPendingAction,
  restoreItemAction,
  saveContentAction,
  unpublishItemAction,
  withdrawRequestAction,
} from "@/lib/actions/website-cms";
import { validateKindData } from "@/lib/website-cms/kinds";
import type { ItemReview } from "@/lib/website-cms/review-queries";
import type { ItemView, PublishOutcome } from "@/lib/website-cms/service";
import { FieldEditor, firstPerPath, type Errors } from "./field-editor";
import { LIST_UI, type ListKind } from "./field-defs";
import { MediaThumb } from "./media-picker";
import { reportPublish, reportResult, StateBadge } from "./report";
import { isHeldByRequest } from "@/lib/website-cms/review-status";
import { LockedFields } from "./locked-fields";
import { ReviewBadge, ReviewLockNotice, ReviewReturnNotice, SubmitDialog } from "./review-ui";

/* ---------------------------------------------------------------------------
 * ONE SCREEN FOR EVERY LIST OF WEBSITE CONTENT — products, industries, gallery,
 * jobs, testimonials, milestones and SEO entries.
 *
 * They differ in which fields they have (`field-defs.ts`), not in what a person
 * does: add a record, edit it, look at it on the real page, publish it, take it
 * down, retire it. Create opens a centered dialog; editing an existing record
 * opens a drawer on the right, as the approved design has it.
 *
 * Nothing here decides what is allowed. It asks the server, and says what the
 * server answered.
 * ------------------------------------------------------------------------- */

type Filter = "all" | "live" | "draft" | "archived";
type Confirm = { action: "unpublish" | "archive" | "delete" | "discard"; item: ItemView } | null;

/* Each of the four is confirmed under its own impact kind: what the modal
   lists for taking a product down (the industries it leaves, the address that
   goes "not found") is nothing like what it lists for discarding an edit. */
const IMPACT_KIND: Record<NonNullable<Confirm>["action"], string> = {
  unpublish: "site-content-unpublish",
  archive: "site-content-archive",
  delete: "site-content-delete",
  discard: "site-content-discard",
};
const CONFIRM_LABEL: Record<NonNullable<Confirm>["action"], string> = {
  unpublish: "Unpublish",
  archive: "Archive",
  delete: "Delete draft",
  discard: "Discard changes",
};

const plainDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const errorMap = (issues: { field: string; message: string }[] | undefined): Errors =>
  firstPerPath((issues ?? []).map((i) => ({ path: i.field, message: i.message })));

export function ContentScreen({
  kind,
  items,
  canPublish,
  canSubmit = false,
  canCreate = true,
  canMove = true,
  review = {},
  orderChanged,
}: {
  kind: ListKind;
  items: ItemView[];
  canPublish: boolean;
  /** Hands work in for review rather than publishing it. */
  canSubmit?: boolean;
  /** Adding needs a whole-kind assignment where assignments are enforced. */
  canCreate?: boolean;
  /** So does reordering. */
  canMove?: boolean;
  /** Where each item stands in review: held by a request, or returned to this person. */
  review?: Record<string, ItemReview>;
  /** The editor's order differs from the live order for this list. */
  orderChanged: boolean;
}) {
  const ui = LIST_UI[kind];
  const router = useRouter();
  const toast = useToast();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<ItemView | null>(null);
  const [confirm, setConfirm] = React.useState<Confirm>(null);
  /** A review request being taken back — the items it frees, and the approval it gives up. */
  const [withdrawing, setWithdrawing] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState<ItemView | null>(null);
  const [busy, setBusy] = React.useState(false);

  /** Held by an OPEN request: it cannot be changed, deleted or submitted again. */
  const held = (item: ItemView) => isHeldByRequest(review[item.id]);
  /** Something to hand in: a draft nobody has seen, or a live item with unpublished changes. */
  const submittable = (item: ItemView) => item.state !== "archived" && ((item.state === "published" && item.hasChanges) || (item.state === "draft" && !item.everPublished));

  const pending = items.filter((i) => (i.state === "published" && i.hasChanges) || (i.state === "draft" && !i.everPublished)).length + (orderChanged ? 1 : 0);
  const rows = items.filter((i) => filter === "all" || (filter === "live" && i.state === "published") || (filter === "draft" && i.state === "draft") || (filter === "archived" && i.state === "archived"));

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const preview = (item: ItemView) =>
    run(async () => {
      const r = await previewItemAction(item.id);
      if (!r.ok) return void toast.push(r.error, "error");
      window.open(r.data.url, "_blank", "noopener");
      if (item.hasChanges || item.state !== "published") toast.push("Opened a preview of your saved working copy. It is not live.");
    });

  function menuFor(item: ItemView): MenuItem[] {
    const m: MenuItem[] = [];
    if (item.state !== "archived") m.push({ label: "Edit", onSelect: () => setEditing(item) });
    if (item.state !== "archived") m.push({ label: "Preview on the site", onSelect: () => void preview(item) });
    if (canPublish && item.state !== "archived") {
      if (item.state === "draft") m.push({ label: "Publish", onSelect: () => void run(async () => void reportPublish(toast, await publishItemsAction([item.id]))) });
      if (item.state === "published" && item.hasChanges) m.push({ label: "Publish changes", onSelect: () => void run(async () => void reportPublish(toast, await publishItemsAction([item.id]))) });
      if (item.state === "published" && item.hasChanges) m.push({ label: "Discard unpublished changes", onSelect: () => setConfirm({ action: "discard", item }) });
      if (item.state === "published") m.push({ label: "Unpublish", onSelect: () => setConfirm({ action: "unpublish", item }) });
      m.push({ label: "Archive", destructive: true, onSelect: () => setConfirm({ action: "archive", item }) });
    }
    if (canPublish && item.state === "archived") m.push({ label: "Restore as draft", onSelect: () => void run(async () => void reportPublish(toast, await restoreItemAction(item.id))) });
    const request = review[item.id];
    if (canSubmit && submittable(item) && !held(item)) m.push({ label: "Submit for Verification", onSelect: () => setSubmitting(item) });
    if (request?.mine) {
      m.push({ label: request.status === "approved" ? "Open request — publish" : "Open request", onSelect: () => router.push(`/website/my-work/${request.requestId}`) });
      if (held(item)) {
        m.push({
          label: "Withdraw request",
          onSelect: () => setWithdrawing(request.requestId),
        });
      }
    }
    if (item.state === "draft" && !item.everPublished && !held(item)) m.push({ label: "Delete draft", destructive: true, onSelect: () => setConfirm({ action: "delete", item }) });
    if (ui.ordered && filter === "all" && canMove) {
      const i = items.findIndex((x) => x.id === item.id);
      m.push({ label: "Move up", disabled: i <= 0, onSelect: () => void run(async () => void reportResult(toast, await moveContentAction(item.id, "up"))) });
      m.push({ label: "Move down", disabled: i === items.length - 1, onSelect: () => void run(async () => void reportResult(toast, await moveContentAction(item.id, "down"))) });
    }
    return m;
  }

  async function confirmed(confirmation: ImpactConfirmation): Promise<Result<unknown>> {
    if (!confirm) return { ok: false, error: "Nothing was chosen." };
    const { action, item } = confirm;
    const r =
      action === "unpublish"
        ? await unpublishItemAction(item.id, confirmation)
        : action === "archive"
          ? await archiveItemAction(item.id, confirmation)
          : action === "delete"
            ? await deleteDraftAction(item.id, confirmation)
            : await discardChangesAction(item.id, confirmation);
    /* A refusal is the dialog's to show — it reloads the list on `conflict`. */
    if (r.ok) {
      if (action === "unpublish" || action === "archive") reportPublish(toast, r as Result<PublishOutcome>);
      else reportResult(toast, r as Result<unknown>);
      router.refresh();
    }
    return r;
  }

  return (
    <div className="p-6">
      <PageHeader
        title={ui.title}
        subtitle={ui.subtitle}
        actions={
          <div className="flex items-center gap-2">
            {canPublish && pending > 0 ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void run(async () => void reportPublish(toast, await publishPendingAction([kind])))}
              >
                Publish all pending ({pending})
              </Button>
            ) : null}
            {canCreate ? <Button variant="primary" onClick={() => setCreating(true)}>{ui.addLabel}</Button> : null}
          </div>
        }
      />

      {!canPublish && canSubmit ? (
        <Callout tone="brand">
          You can edit and preview. Your changes go live only after a reviewer approves them — press “Submit for Verification” on an item when it is ready.
        </Callout>
      ) : !canPublish ? (
        <Callout tone="brand">You can edit and preview. Publishing to the live site needs the “Publish to the live site” permission.</Callout>
      ) : null}
      {orderChanged ? <Callout tone="warn">The order here is different from the live order. It goes live with the next publish of this list.</Callout> : null}

      <div className="mb-3">
        <FilterPills
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "All", count: items.length },
            { key: "live", label: "Live", count: items.filter((i) => i.state === "published").length },
            { key: "draft", label: "Draft", count: items.filter((i) => i.state === "draft").length },
            { key: "archived", label: "Archived", count: items.filter((i) => i.state === "archived").length },
          ]}
        />
      </div>

      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState title={items.length === 0 ? `No ${ui.title.toLowerCase()} yet` : "Nothing matches this filter"} body={items.length === 0 ? ui.emptyHint : undefined} />
        ) : (
          <table className="w-full border-collapse" style={{ "--rowh": "56px" } as React.CSSProperties}>
            <thead>
              <tr>
                <Th>{ui.title.replace(/s$/, "")}</Th>
                <Th>{ui.meta.header}</Th>
                <Th>Status</Th>
                <Th>Updated</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const img = ui.imageOf?.(item.data);
                return (
                  <Tr key={item.id}>
                    <Td className="whitespace-normal">
                      <div className="flex items-center gap-3">
                        {ui.imageOf ? <MediaThumb url={img ?? ""} className="h-10 w-10" /> : null}
                        <div className="min-w-0">
                          <div className="font-medium text-ink">{item.label}</div>
                          {ui.subOf ? <div className="text-xs text-muted">{ui.subOf(item.data)}</div> : null}
                        </div>
                      </div>
                    </Td>
                    <Td className="whitespace-normal">{ui.meta.of(item.data)}</Td>
                    <Td>
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <StateBadge item={item} />
                        {review[item.id] ? <ReviewBadge review={review[item.id]} /> : null}
                      </span>
                    </Td>
                    <Td>{plainDate(item.updatedAt)}</Td>
                    <Td align="right"><RowMenu items={menuFor(item)} /></Td>
                  </Tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {creating ? <ItemEditor kind={kind} item={null} canPublish={canPublish} onClose={() => setCreating(false)} /> : null}
      {editing ? (
        <ItemEditor
          kind={kind}
          item={editing}
          canPublish={canPublish}
          canSubmit={canSubmit}
          review={review[editing.id]}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <SubmitDialog
        open={submitting !== null}
        ids={submitting ? [submitting.id] : []}
        onClose={() => setSubmitting(null)}
        onDone={() => {
          setSubmitting(null);
          router.refresh();
        }}
      />

      {/* What the act reaches on mahekindia.com and in the editors' own work,
          read off the database, with the item's name typed to confirm. */}
      {confirm ? (
        <ImpactDialog
          key={`${confirm.action}:${confirm.item.id}`}
          kind={IMPACT_KIND[confirm.action]}
          id={confirm.item.id}
          confirmLabel={CONFIRM_LABEL[confirm.action]}
          onClose={() => setConfirm(null)}
          onConfirm={confirmed}
        />
      ) : null}
      {withdrawing ? (
        <ImpactDialog
          key={withdrawing}
          kind="site-request-withdraw"
          id={withdrawing}
          confirmLabel="Withdraw"
          onClose={() => setWithdrawing(null)}
          onConfirm={async (confirmation) => {
            const r = await withdrawRequestAction(withdrawing, confirmation);
            if (r.ok) {
              reportResult(toast, r);
              router.refresh();
            }
            return r;
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function ItemEditor({
  kind,
  item,
  canPublish,
  canSubmit = false,
  review,
  onClose,
}: {
  kind: ListKind;
  item: ItemView | null;
  canPublish: boolean;
  canSubmit?: boolean;
  review?: ItemReview;
  onClose: () => void;
}) {
  const ui = LIST_UI[kind];
  const router = useRouter();
  const toast = useToast();
  const [submitOpen, setSubmitOpen] = React.useState(false);
  /* A request holds this item: what the reviewer reads must be what gets published, so it cannot be changed under them. */
  const locked = isHeldByRequest(review);
  const [current, setCurrent] = React.useState<ItemView | null>(item);
  const [data, setData] = React.useState<Record<string, unknown>>(() => clone(item?.data ?? ui.blank()));
  const [saved, setSaved] = React.useState<string>(() => JSON.stringify(item?.data ?? ui.blank()));
  const [errors, setErrors] = React.useState<Errors>({});
  const [busy, setBusy] = React.useState<null | "save" | "preview" | "publish">(null);

  const dirty = JSON.stringify(data) !== saved;
  const isNew = current === null;

  /** Validates in the browser with the server's own rules, then asks the server. Returns the saved item, or null. */
  async function save(): Promise<ItemView | null> {
    const checked = validateKindData(kind, data);
    if (!checked.ok) {
      setErrors(firstPerPath(checked.issues));
      toast.push(`${checked.issues.length === 1 ? "One field needs" : `${checked.issues.length} fields need`} attention — see the highlighted fields.`, "error");
      return null;
    }
    const r = current ? await saveContentAction(current.id, checked.data, current.version) : await createContentAction(kind, checked.data);
    if (!r.ok) {
      setErrors(errorMap(r.fieldErrors));
      toast.push(r.error, "error");
      return null;
    }
    setErrors({});
    setCurrent(r.data);
    setData(clone(r.data.data));
    setSaved(JSON.stringify(r.data.data));
    toast.push(r.message ?? "Saved.");
    router.refresh();
    return r.data;
  }

  async function onSave() {
    setBusy("save");
    const saved_ = await save();
    setBusy(null);
    if (saved_ && isNew) onClose();
  }

  async function onPreview() {
    setBusy("preview");
    const target = dirty || !current ? await save() : current;
    if (target) {
      const r = await previewItemAction(target.id);
      if (r.ok) window.open(r.data.url, "_blank", "noopener");
      else toast.push(r.error, "error");
    }
    setBusy(null);
  }

  async function onPublish() {
    setBusy("publish");
    const target = dirty || !current ? await save() : current;
    if (target) {
      reportPublish(toast, await publishItemsAction([target.id]));
      router.refresh();
      onClose();
    }
    setBusy(null);
  }

  /** Saves first if there is something unsaved — the request freezes what is SAVED — then asks for the note. */
  async function onSubmit() {
    setBusy("save");
    const target = dirty ? await save() : current;
    setBusy(null);
    if (target) setSubmitOpen(true);
  }

  const fields = (
    <LockedFields locked={locked}>
      <FieldEditor fields={ui.fields} value={data} onChange={setData} errors={errors} existing={!isNew} />
    </LockedFields>
  );
  const lockedNotice = locked && review ? <ReviewLockNotice review={review} /> : null;
  const problems = Object.entries(errors);
  const summary =
    problems.length > 0 ? (
      <div className="mb-3 rounded-[4px] border border-danger-soft bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
        {problems.slice(0, 4).map(([path, message]) => (
          <div key={path}>{message}</div>
        ))}
        {problems.length > 4 ? <div>…and {problems.length - 4} more.</div> : null}
      </div>
    ) : null;

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} disabled={busy !== null}>Close</Button>
      {!isNew ? (
        <Button variant="secondary" onClick={onPreview} disabled={busy !== null} title="Opens the real page showing your saved working copy">
          {busy === "preview" ? "Opening…" : dirty ? "Save and preview" : "Preview"}
        </Button>
      ) : null}
      {!isNew && canPublish && current && (current.state !== "published" || current.hasChanges || dirty) ? (
        <Button variant="secondary" onClick={onPublish} disabled={busy !== null}>
          {busy === "publish" ? "Publishing…" : dirty ? "Save and publish" : "Publish"}
        </Button>
      ) : null}
      {!isNew && canSubmit && !locked && current && (dirty || (current.state === "published" && current.hasChanges) || (current.state === "draft" && !current.everPublished)) ? (
        <Button variant="secondary" onClick={() => void onSubmit()} disabled={busy !== null}>
          {dirty ? "Save and submit for verification" : "Submit for Verification"}
        </Button>
      ) : null}
      <Button variant="primary" onClick={onSave} disabled={busy !== null || locked || (!isNew && !dirty)}>
        {busy === "save" ? "Saving…" : isNew ? `Create ${ui.noun}` : "Save"}
      </Button>
    </>
  );

  if (isNew) {
    return (
      <Modal open onClose={onClose} title={ui.addLabel} footer={footer} width={640}>
        {summary}
        {fields}
        <p className="mt-3 text-[13px] text-muted">It is created as a draft. Nothing reaches mahekindia.com until you publish it.</p>
      </Modal>
    );
  }
  return (
    <Drawer open onClose={onClose} width={620} label={`Edit ${ui.noun}`}>
      <DrawerHeader onClose={onClose}>
        <span className="flex items-center gap-2">
          Edit {ui.noun}
          {current ? <StateBadge item={current} /> : null}
        </span>
      </DrawerHeader>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {lockedNotice}
        {review && !locked ? <ReviewReturnNotice review={review} /> : null}
        {summary}
        {current?.state === "published" && !dirty && !current.hasChanges ? (
          <p className="mb-3 text-[13px] text-muted">This is exactly what is live. Changes you save stay private until you publish.</p>
        ) : null}
        {fields}
      </div>
      <div className="flex flex-none flex-wrap justify-end gap-2.5 border-t border-divider px-5 py-3">{footer}</div>
      <SubmitDialog
        open={submitOpen}
        ids={current ? [current.id] : []}
        onClose={() => setSubmitOpen(false)}
        onDone={() => {
          setSubmitOpen(false);
          router.refresh();
          onClose();
        }}
      />
    </Drawer>
  );
}
