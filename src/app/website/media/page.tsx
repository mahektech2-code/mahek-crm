"use client";

import * as React from "react";
import { PageHeader, Button, Card, CardHeader, Input, Select, EmptyState, Badge, Callout } from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { INITIAL_MEDIA, formatDateTime, type MediaAsset } from "../mock-data";

export default function MediaPage() {
  const toast = useToast();
  const [assets] = React.useState<MediaAsset[]>(INITIAL_MEDIA);
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [preview, setPreview] = React.useState<MediaAsset | null>(null);

  const types = ["all", ...Array.from(new Set(assets.map((a) => a.contentType)))];
  const filtered = assets.filter((a) => a.filename.toLowerCase().includes(query.toLowerCase())).filter((a) => typeFilter === "all" || a.contentType === typeFilter);

  return (
    <>
      <PageHeader
        title="Media Library"
        subtitle="Shared storage reused by Products, Industries, Gallery, Pages and SEO/OG images — no separate Website storage system."
        actions={<Button variant="primary" onClick={() => toast.push("Upload dialog (prototype — storage is wired to MahekOne's existing FileStorage, not re-implemented here)")}><Icon name="plus" size={16} /> Upload</Button>}
      />

      <Callout tone="brand">
        This prototype represents the future shared Website Media system — bytes will live in MahekOne&apos;s existing file storage (Postgres or R2, whichever is already configured), the same mechanism other modules already use.
      </Callout>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Input placeholder="Search filename…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-56" />
          <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            {types.map((t) => <option key={t} value={t}>{t === "all" ? "All file types" : t}</option>)}
          </Select>
        </div>
        <div className="flex items-center gap-1 rounded-[4px] border border-line p-0.5">
          <button onClick={() => setView("grid")} className={`rounded-[3px] px-2 py-1 ${view === "grid" ? "bg-brand-soft text-[#5223E0]" : "text-muted"}`}><Icon name="grid" size={16} /></button>
          <button onClick={() => setView("list")} className={`rounded-[3px] px-2 py-1 ${view === "list" ? "bg-brand-soft text-[#5223E0]" : "text-muted"}`}><Icon name="doc" size={16} /></button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card><EmptyState title="No media found" /></Card>
      ) : view === "grid" ? (
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          {filtered.map((a) => (
            <Card key={a.id} className="overflow-hidden">
              <button onClick={() => setPreview(a)} className="flex aspect-square w-full cursor-pointer items-center justify-center bg-canvas text-[10px] text-muted hover:opacity-90">IMG</button>
              <div className="p-2">
                <div className="truncate text-[12px] font-medium text-ink" title={a.filename}>{a.filename}</div>
                <div className="text-[11px] text-muted">{a.width}×{a.height} · {a.sizeKb} KB</div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full">
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} className="border-b border-divider last:border-0">
                  <td className="p-3">
                    <button onClick={() => setPreview(a)} className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-[4px] bg-canvas text-[9px] text-muted">IMG</button>
                  </td>
                  <td className="p-3 text-[13.5px] font-medium text-ink">{a.filename}</td>
                  <td className="p-3 text-[13px] text-muted">{a.contentType}</td>
                  <td className="p-3 text-[13px] text-muted">{a.width}×{a.height}</td>
                  <td className="p-3 text-[13px] text-muted">{a.sizeKb} KB</td>
                  <td className="p-3 text-[13px] text-muted">{formatDateTime(a.uploadedAt)}</td>
                  <td className="p-3 text-right"><Button variant="secondary" size="sm" onClick={() => setPreview(a)}>Details</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {preview ? (
        <Drawer open onClose={() => setPreview(null)} label="Media details">
          <DrawerHeader onClose={() => setPreview(null)}>
            <div className="text-lg font-semibold text-ink">{preview.filename}</div>
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            <div className="mb-4 flex aspect-video items-center justify-center rounded-[4px] bg-canvas text-[12px] text-muted">Preview</div>
            <div className="grid gap-2 text-[13.5px]">
              <Row label="Filename">{preview.filename}</Row>
              <Row label="Alt text">{preview.alt}</Row>
              <Row label="File type">{preview.contentType}</Row>
              <Row label="Dimensions">{preview.width} × {preview.height}</Row>
              <Row label="Size">{preview.sizeKb} KB</Row>
              <Row label="Uploaded">{formatDateTime(preview.uploadedAt)} by {preview.uploadedBy}</Row>
            </div>
            <CardHeader title="Used by" className="mt-5 px-0" />
            {preview.usedBy.length === 0 ? (
              <p className="text-[13px] text-muted">Not currently referenced by any content.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {preview.usedBy.map((u) => <Badge key={u} tone="brand">{u}</Badge>)}
              </div>
            )}
          </div>
          <div className="flex flex-none items-center justify-between gap-2 border-t border-line px-5 py-3.5">
            <Button variant="ghost" onClick={() => toast.push(`Copied reference: ${preview.id}`)}>Copy reference</Button>
            <Button variant="danger" disabled={preview.usedBy.length > 0} title={preview.usedBy.length > 0 ? "In use — remove from content first" : undefined}>
              Delete
            </Button>
          </div>
        </Drawer>
      ) : null}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-divider py-1.5">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-ink">{children}</span>
    </div>
  );
}
