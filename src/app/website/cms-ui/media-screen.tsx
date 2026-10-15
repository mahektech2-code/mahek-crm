"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, EmptyState, Input, PageHeader } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { deleteMediaAction, updateMediaAltAction } from "@/lib/actions/website-cms";
import { WEBSITE_IMAGE_MAX_BYTES } from "@/lib/website-cms/media-types";
import type { MediaView } from "@/lib/website-cms/media-service";
import { reportResult } from "./report";
import { MediaThumb, uploadImage } from "./media-picker";
import { useCmsEnv } from "./cms-env";

/* ---------------------------------------------------------------------------
 * THE MEDIA LIBRARY — every image the website can use.
 *
 * Uploads are real: the file goes to the server, is checked by its bytes, is
 * stored, and appears here only once the server says so. A file in use anywhere
 * (live or working copy) cannot be deleted. Files that ship inside the website
 * are listed so they can be picked, and are read-only.
 * ------------------------------------------------------------------------- */

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function MediaScreen({ canPublish }: { canPublish: boolean }) {
  void canPublish;
  const router = useRouter();
  const toast = useToast();
  const { media, addMedia } = useCmsEnv();
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState<MediaView | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const needle = q.trim().toLowerCase();
  const match = (m: MediaView) => !needle || m.filename.toLowerCase().includes(needle) || m.alt.toLowerCase().includes(needle);
  const uploads = media.filter((m) => m.source === "upload").filter(match);
  const site = media.filter((m) => m.source === "site").filter(match);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    let added = 0;
    for (const file of files) {
      const r = await uploadImage(file);
      if (r.ok) {
        addMedia(r.media);
        added += 1;
      } else {
        toast.push(r.error, "error");
      }
    }
    setBusy(false);
    if (added) toast.push(`${added} image${added === 1 ? "" : "s"} added to the library. ${added === 1 ? "It appears" : "They appear"} on the live site only once content that uses ${added === 1 ? "it is" : "them are"} published.`);
    router.refresh();
  }

  async function remove() {
    if (!removing) return;
    reportResult(toast, await deleteMediaAction(removing.id));
    router.refresh();
  }

  async function saveAlt(m: MediaView, alt: string) {
    if (alt.trim() === m.alt.trim()) return;
    reportResult(toast, await updateMediaAltAction(m.id, alt));
    router.refresh();
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Media"
        subtitle="The images the website can use. Upload a picture here or from any image field, then choose it on the product, industry, photo or page that should show it."
        actions={
          <>
            <input ref={fileRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={onFiles} />
            <Button variant="primary" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? "Uploading…" : "Upload images"}</Button>
          </>
        }
      />
      <div className="mb-3 max-w-sm">
        <Input placeholder="Search by file name or description" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p className="mb-3 text-[13px] text-muted">JPG, PNG, WebP or GIF, up to {WEBSITE_IMAGE_MAX_BYTES / (1024 * 1024)} MB. The file is checked by what it really is, not by its name.</p>

      <Card className="mb-5">
        <div className="border-b border-divider px-5 py-3 text-sm font-semibold text-ink">Uploaded here ({uploads.length})</div>
        {uploads.length === 0 ? (
          <EmptyState title="No uploaded images" body={media.some((m) => m.source === "upload") ? "Nothing matches your search." : "Upload the first one."} />
        ) : (
          <ul className="divide-y divide-divider">
            {uploads.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <MediaThumb url={m.url} className="h-14 w-14" />
                <div className="min-w-[200px] flex-1">
                  <div className="text-sm font-medium text-ink">{m.filename}</div>
                  <div className="text-xs text-muted">{m.contentType.replace("image/", "").toUpperCase()} · {kb(m.sizeBytes)} · added {new Date(m.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</div>
                  <div className="mt-1 text-xs">
                    {m.usedBy.length > 0 ? <Badge tone="brand" title={m.usedBy.join(", ")}>Used by {m.usedBy.length}</Badge> : <Badge tone="neutral">Not used</Badge>}
                  </div>
                </div>
                <Input
                  defaultValue={m.alt}
                  placeholder="Description (for accessibility)"
                  className="max-w-[260px]"
                  aria-label={`Description of ${m.filename}`}
                  onBlur={(e) => void saveAlt(m, e.target.value)}
                />
                <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(m.url).then(() => toast.push("Address copied."))}>Copy address</Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={m.usedBy.length > 0}
                  title={m.usedBy.length > 0 ? `In use by ${m.usedBy.slice(0, 3).join(", ")}. Remove it from that content first.` : "Remove from the library"}
                  onClick={() => setRemoving(m)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <div className="border-b border-divider px-5 py-3">
          <div className="text-sm font-semibold text-ink">Already on the website ({site.length})</div>
          <div className="text-[13px] text-muted">These files ship inside the website itself. They can be chosen anywhere, but are not changed or deleted from here.</div>
        </div>
        {site.length === 0 ? (
          <EmptyState title="No site files listed" body="Import the website's content from the Dashboard to list them." />
        ) : (
          <div className="flex flex-wrap gap-3 p-4">
            {site.map((m) => (
              <div key={m.id} className="flex w-[130px] flex-col gap-1" title={m.url}>
                <MediaThumb url={m.url} className="h-[96px] w-full" />
                <span className="truncate text-[11px] text-body">{m.filename}</span>
                {m.usedBy.length > 0 ? <span className="text-[11px] text-muted">Used by {m.usedBy.length}</span> : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title="Delete this image"
        body={`“${removing?.filename ?? ""}” is not used anywhere and will be removed from the library. The file itself is kept, so this can be undone by an administrator.`}
        destructive
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={remove}
      />
    </div>
  );
}
