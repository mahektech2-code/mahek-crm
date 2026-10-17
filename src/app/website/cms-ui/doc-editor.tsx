"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { discardChangesAction, previewItemAction, publishItemsAction, saveContentAction, unpublishItemAction } from "@/lib/actions/website-cms";
import { validateKindData, type KindKey } from "@/lib/website-cms/kinds";
import type { ItemView } from "@/lib/website-cms/service";
import type { FieldDef } from "./field-defs";
import { FieldEditor, firstPerPath, type Errors } from "./field-editor";
import { reportPublish, StateBadge } from "./report";

/* ---------------------------------------------------------------------------
 * THE EDITOR FOR A RECORD THAT ALWAYS EXISTS ONCE — the site settings, the
 * menus, and each page's copy. It cannot be created or archived, only edited,
 * previewed, published, and taken back to the site's built-in version.
 *
 * "Unpublish" here means exactly that: the live site stops using this record and
 * shows the content built into the website's code again. Nothing is deleted.
 * ------------------------------------------------------------------------- */

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The key a screen gives `DocEditor` so it starts over whenever the stored row changes. */
export const docKey = (i: Pick<ItemView, "id" | "version" | "state" | "hasChanges">) => `${i.id}:${i.version}:${i.state}:${i.hasChanges}`;

export function DocEditor({
  kind,
  item,
  fields,
  canPublish,
  what,
  stacked = false,
}: {
  kind: KindKey;
  item: ItemView;
  fields: FieldDef[];
  canPublish: boolean;
  /** "the site settings", "this page" — used in the confirmations. */
  what: string;
  /** Footer buttons stay at the bottom of a drawer; on a page they follow the form. */
  stacked?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [current, setCurrent] = React.useState<ItemView>(item);
  const [data, setData] = React.useState<Record<string, unknown>>(() => clone(item.data));
  const [saved, setSaved] = React.useState(() => JSON.stringify(item.data));
  const [errors, setErrors] = React.useState<Errors>({});
  const [busy, setBusy] = React.useState<null | string>(null);
  const [confirm, setConfirm] = React.useState<null | "unpublish" | "discard">(null);

  // The screen that draws this keys it on the row's version and state (`docKey`), so a
  // refresh after a save, publish or takedown remounts it on the new row.

  const dirty = JSON.stringify(data) !== saved;

  async function save(): Promise<ItemView | null> {
    const checked = validateKindData(kind, data);
    if (!checked.ok) {
      setErrors(firstPerPath(checked.issues));
      toast.push(`${checked.issues.length === 1 ? "One field needs" : `${checked.issues.length} fields need`} attention — see the highlighted fields.`, "error");
      return null;
    }
    const r = await saveContentAction(current.id, checked.data, current.version);
    if (!r.ok) {
      setErrors(firstPerPath((r.fieldErrors ?? []).map((f) => ({ path: f.field, message: f.message }))));
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

  async function guarded(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  const onSave = () => guarded("save", async () => void (await save()));
  const onPreview = () =>
    guarded("preview", async () => {
      const target = dirty ? await save() : current;
      if (!target) return;
      const r = await previewItemAction(target.id);
      if (r.ok) window.open(r.data.url, "_blank", "noopener");
      else toast.push(r.error, "error");
    });
  const onPublish = () =>
    guarded("publish", async () => {
      const target = dirty ? await save() : current;
      if (!target) return;
      reportPublish(toast, await publishItemsAction([target.id]));
      router.refresh();
    });
  const onConfirm = async () => {
    const which = confirm;
    setConfirm(null);
    if (!which) return;
    await guarded(which, async () => {
      if (which === "unpublish") reportPublish(toast, await unpublishItemAction(current.id));
      else {
        const r = await discardChangesAction(current.id);
        if (r.ok) {
          setCurrent(r.data);
          setData(clone(r.data.data));
          setSaved(JSON.stringify(r.data.data));
          setErrors({});
          toast.push(r.message ?? "Discarded.");
        } else toast.push(r.error, "error");
      }
      router.refresh();
    });
  };

  const problems = Object.entries(errors);
  const needsPublish = current.state !== "published" || current.hasChanges || dirty;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-sm text-muted">
        <StateBadge item={current} />
        {current.state === "published" && !current.hasChanges && !dirty ? <span>This is exactly what is live.</span> : null}
        {current.state === "published" && (current.hasChanges || dirty) ? <span>The live site still shows the published version until you publish.</span> : null}
        {current.state !== "published" ? <span>Not live — the website is showing the content built into it.</span> : null}
      </div>
      {problems.length > 0 ? (
        <div className="mb-3 rounded-[4px] border border-danger-soft bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
          {problems.slice(0, 5).map(([path, message]) => (
            <div key={path}>{message}</div>
          ))}
          {problems.length > 5 ? <div>…and {problems.length - 5} more.</div> : null}
        </div>
      ) : null}
      <FieldEditor fields={fields} value={data} onChange={setData} errors={errors} existing />
      <div className={stacked ? "mt-5 flex flex-wrap justify-end gap-2.5 border-t border-divider pt-3" : "mt-5 flex flex-wrap justify-end gap-2.5"}>
        {canPublish && current.state === "published" ? (
          <Button variant="secondary" onClick={() => setConfirm("unpublish")} disabled={busy !== null}>Back to the site&apos;s built-in version</Button>
        ) : null}
        {canPublish && current.state === "published" && current.hasChanges ? (
          <Button variant="secondary" onClick={() => setConfirm("discard")} disabled={busy !== null}>Discard unpublished changes</Button>
        ) : null}
        <Button variant="secondary" onClick={onPreview} disabled={busy !== null} title="Opens the real page showing your saved working copy">
          {busy === "preview" ? "Opening…" : dirty ? "Save and preview" : "Preview"}
        </Button>
        {canPublish && needsPublish ? (
          <Button variant="secondary" onClick={onPublish} disabled={busy !== null}>
            {busy === "publish" ? "Publishing…" : dirty ? "Save and publish" : "Publish"}
          </Button>
        ) : null}
        <Button variant="primary" onClick={onSave} disabled={busy !== null || !dirty}>{busy === "save" ? "Saving…" : "Save"}</Button>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "unpublish" ? "Go back to the built-in version" : "Discard unpublished changes"}
        body={
          confirm === "unpublish"
            ? `${what[0].toUpperCase()}${what.slice(1)} will stop coming from MahekOne: mahekindia.com goes back to the content built into the website. Your edits here are kept and you can publish them again.`
            : `Your unpublished edits to ${what} will be thrown away and it goes back to exactly what is live now.`
        }
        destructive
        confirmLabel={confirm === "unpublish" ? "Go back to built-in" : "Discard changes"}
        onClose={() => setConfirm(null)}
        onConfirm={onConfirm}
      />
    </div>
  );
}
