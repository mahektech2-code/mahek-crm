"use client";

import * as React from "react";
import { PageHeader, Button, Card, Field, Input, Select, EmptyState, Badge } from "@/components/ui/primitives";
import { Drawer, DrawerHeader, ConfirmDialog, FilterPills } from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { StatusBadge } from "../status-badge";
import { INITIAL_GALLERY, ADMIN_USERS, formatDate, type GalleryItem, type ContentStatus } from "../mock-data";

const CURRENT_USER = ADMIN_USERS[0];
type StatusFilter = "all" | ContentStatus;

export default function GalleryPage() {
  const toast = useToast();
  const [items, setItems] = React.useState<GalleryItem[]>(INITIAL_GALLERY);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [category, setCategory] = React.useState<string>("all");
  const [editing, setEditing] = React.useState<GalleryItem | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<GalleryItem | null>(null);

  const categories = ["all", ...Array.from(new Set(items.map((i) => i.category)))];
  const filtered = items
    .filter((i) => (statusFilter === "all" ? true : i.status === statusFilter))
    .filter((i) => category === "all" || i.category === category)
    .sort((a, b) => a.displayOrder - b.displayOrder);

  function upsert(i: GalleryItem) {
    setItems((prev) => (prev.some((x) => x.id === i.id) ? prev.map((x) => (x.id === i.id ? i : x)) : [...prev, i]));
  }
  function setStatus(i: GalleryItem, status: ContentStatus) {
    upsert({ ...i, status, updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER, ...(status === "published" ? { publishedAt: new Date().toISOString(), publishedBy: CURRENT_USER } : {}) });
  }
  function openNew() {
    setEditing({ id: `g_${Date.now()}`, category: "Factory", label: "", image: "", alt: "", status: "draft", displayOrder: items.length + 1, updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER });
  }

  return (
    <>
      <PageHeader title="Gallery" subtitle={`${items.length} items`} actions={<Button variant="primary" onClick={openNew}><Icon name="plus" size={16} /> Upload</Button>} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <FilterPills
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { key: "all", label: "All", count: items.length },
            { key: "published", label: "Published", count: items.filter((i) => i.status === "published").length },
            { key: "draft", label: "Draft", count: items.filter((i) => i.status === "draft").length },
          ]}
        />
        <Select value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => <option key={c} value={c}>{c === "all" ? "All categories" : c}</option>)}
        </Select>
      </div>

      {filtered.length === 0 ? (
        <Card><EmptyState title="No gallery items" action={<Button variant="primary" onClick={openNew}>Upload</Button>} /></Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((i) => (
            <Card key={i.id} className="overflow-hidden">
              <button onClick={() => setEditing(i)} className="flex aspect-[4/3] w-full cursor-pointer items-center justify-center bg-canvas text-[11px] text-muted hover:opacity-90">
                IMAGE
              </button>
              <div className="p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Badge tone="muted">{i.category}</Badge>
                  <StatusBadge status={i.status} />
                </div>
                <div className="truncate text-[13.5px] font-medium text-ink" title={i.label}>{i.label}</div>
                <div className="mt-0.5 text-[11px] text-muted">Order {i.displayOrder} · {formatDate(i.updatedAt)}</div>
                <div className="mt-2 flex items-center gap-1.5">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(i)}>Edit</Button>
                  {i.status !== "published" ? (
                    <Button variant="primary" size="sm" onClick={() => { setStatus(i, "published"); toast.push("Published"); }}>Publish</Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => { setStatus(i, "draft"); toast.push("Unpublished"); }}>Unpublish</Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(i)}>Delete</Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing ? (
        <Drawer open onClose={() => setEditing(null)} label="Gallery item editor">
          <DrawerHeader onClose={() => setEditing(null)}>
            <div className="text-lg font-semibold text-ink">{editing.label || "New gallery item"}</div>
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            <GalleryForm
              item={editing}
              onChange={setEditing}
            />
          </div>
          <div className="flex flex-none items-center justify-end gap-2.5 border-t border-line px-5 py-3.5">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="secondary" onClick={() => { upsert(editing); toast.push("Saved"); setEditing(null); }}>Save</Button>
            <Button variant="primary" onClick={() => { upsert({ ...editing, status: "published", publishedAt: new Date().toISOString(), publishedBy: CURRENT_USER }); toast.push("Published"); setEditing(null); }}>Publish</Button>
          </div>
        </Drawer>
      ) : null}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this gallery item?"
        body={<>This permanently removes <strong>{confirmDelete?.label}</strong> from the gallery. The underlying file stays in the Media Library unless also removed there.</>}
        confirmLabel="Delete"
        destructive
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => { if (confirmDelete) setItems((prev) => prev.filter((x) => x.id !== confirmDelete.id)); toast.push("Deleted"); }}
      />
    </>
  );
}

function GalleryForm({ item, onChange }: { item: GalleryItem; onChange: (i: GalleryItem) => void }) {
  return (
    <div className="grid gap-4">
      <Field label="Label"><Input value={item.label} onChange={(e) => onChange({ ...item, label: e.target.value })} /></Field>
      <Field label="Category"><Input value={item.category} onChange={(e) => onChange({ ...item, category: e.target.value })} /></Field>
      <Field label="Alt text" hint="Describes the image for accessibility and SEO"><Input value={item.alt} onChange={(e) => onChange({ ...item, alt: e.target.value })} /></Field>
      <Field label="Display order"><Input type="number" value={item.displayOrder} onChange={(e) => onChange({ ...item, displayOrder: Number(e.target.value) })} className="w-32" /></Field>
    </div>
  );
}
