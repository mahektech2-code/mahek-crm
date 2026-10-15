"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Callout, Card, EmptyState, PageHeader, Td, Th, Tr } from "@/components/ui/primitives";
import { ConfirmDialog, Drawer, DrawerHeader, FilterPills, Modal, RowMenu, type MenuItem } from "@/components/ui/overlays";
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
} from "@/lib/actions/website-cms";
import { validateKindData } from "@/lib/website-cms/kinds";
import type { ItemView } from "@/lib/website-cms/service";
import { FieldEditor, firstPerPath, type Errors } from "./field-editor";
import { LIST_UI, type ListKind } from "./field-defs";
import { MediaThumb } from "./media-picker";
import { reportPublish, reportResult, StateBadge } from "./report";

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

const plainDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

const errorMap = (issues: { field: string; message: string }[] | undefined): Errors =>
  firstPerPath((issues ?? []).map((i) => ({ path: i.field, message: i.message })));

export function ContentScreen({
  kind,
  items,
  canPublish,
  orderChanged,
}: {
  kind: ListKind;
  items: ItemView[];
  canPublish: boolean;
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
  const [busy, setBusy] = React.useState(false);

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
    if (item.state === "draft" && !item.everPublished) m.push({ label: "Delete draft", destructive: true, onSelect: () => setConfirm({ action: "delete", item }) });
    if (ui.ordered && filter === "all") {
      const i = items.findIndex((x) => x.id === item.id);
      m.push({ label: "Move up", disabled: i <= 0, onSelect: () => void run(async () => void reportResult(toast, await moveContentAction(item.id, "up"))) });
      m.push({ label: "Move down", disabled: i === items.length - 1, onSelect: () => void run(async () => void reportResult(toast, await moveContentAction(item.id, "down"))) });
    }
    return m;
  }

  async function confirmed() {
    if (!confirm) return;
    const { action, item } = confirm;
    await run(async () => {
      if (action === "unpublish") reportPublish(toast, await unpublishItemAction(item.id));
      else if (action === "archive") reportPublish(toast, await archiveItemAction(item.id));
      else if (action === "delete") reportResult(toast, await deleteDraftAction(item.id));
      else reportResult(toast, await discardChangesAction(item.id));
    });
  }

  const confirmCopy: Record<NonNullable<Confirm>["action"], { title: string; body: (i: ItemView) => string; label: string; destructive: boolean }> = {
    unpublish: {
      title: `Unpublish this ${ui.noun}`,
      body: (i) => `“${i.label}” will be taken off mahekindia.com${kind === "product" || kind === "industry" ? ` and its page will show "not found"` : ""}. Your working copy is kept and you can publish it again.`,
      label: "Unpublish",
      destructive: true,
    },
    archive: {
      title: `Archive this ${ui.noun}`,
      body: (i) => `“${i.label}” will be taken off mahekindia.com and moved to Archived. Nothing is deleted — you can restore it as a draft later.`,
      label: "Archive",
      destructive: true,
    },
    delete: {
      title: "Delete this draft",
      body: (i) => `“${i.label}” has never been published and will be deleted for good.`,
      label: "Delete draft",
      destructive: true,
    },
    discard: {
      title: "Discard unpublished changes",
      body: (i) => `Your edits to “${i.label}” will be thrown away and it goes back to exactly what is live now.`,
      label: "Discard changes",
      destructive: true,
    },
  };

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
            <Button variant="primary" onClick={() => setCreating(true)}>{ui.addLabel}</Button>
          </div>
        }
      />

      {!canPublish ? (
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
                    <Td><StateBadge item={item} /></Td>
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
      {editing ? <ItemEditor kind={kind} item={editing} canPublish={canPublish} onClose={() => setEditing(null)} /> : null}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? confirmCopy[confirm.action].title : ""}
        body={confirm ? confirmCopy[confirm.action].body(confirm.item) : ""}
        destructive={confirm ? confirmCopy[confirm.action].destructive : false}
        confirmLabel={confirm ? confirmCopy[confirm.action].label : "Confirm"}
        onClose={() => setConfirm(null)}
        onConfirm={confirmed}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function ItemEditor({ kind, item, canPublish, onClose }: { kind: ListKind; item: ItemView | null; canPublish: boolean; onClose: () => void }) {
  const ui = LIST_UI[kind];
  const router = useRouter();
  const toast = useToast();
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

  const fields = <FieldEditor fields={ui.fields} value={data} onChange={setData} errors={errors} existing={!isNew} />;
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
      <Button variant="primary" onClick={onSave} disabled={busy !== null || (!isNew && !dirty)}>
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
        {summary}
        {current?.state === "published" && !dirty && !current.hasChanges ? (
          <p className="mb-3 text-[13px] text-muted">This is exactly what is live. Changes you save stay private until you publish.</p>
        ) : null}
        {fields}
      </div>
      <div className="flex flex-none flex-wrap justify-end gap-2.5 border-t border-divider px-5 py-3">{footer}</div>
    </Drawer>
  );
}
