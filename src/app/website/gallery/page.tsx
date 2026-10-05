"use client";

import * as React from "react";
import {
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  EmptyState,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader, Modal, RowMenu, ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { StatusBadge } from "../status-badge";
import { GALLERY, type GalleryItem, type Status } from "../mock-data";

export default function GalleryPage() {
  const toast = useToast();
  const [items, setItems] = React.useState<GalleryItem[]>(GALLERY);
  const [editing, setEditing] = React.useState<GalleryItem | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [removing, setRemoving] = React.useState<GalleryItem | null>(null);

  function save(item: GalleryItem, isNew: boolean) {
    setItems((all) => (isNew ? [item, ...all] : all.map((i) => (i.id === item.id ? item : i))));
    toast.push(isNew ? "Photo uploaded." : "Photo saved.");
    setUploading(false);
    setEditing(null);
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Gallery"
        subtitle="Photos shown on the public site."
        actions={<Button variant="primary" onClick={() => setUploading(true)}>Upload</Button>}
      />

      {items.length === 0 ? (
        <Card><EmptyState title="No photos" body="Upload the first one." /></Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => (
            <Card key={item.id} className="overflow-hidden">
              <div className="flex h-28 items-center justify-center bg-canvas text-xs text-muted">Preview</div>
              <div className="flex items-start justify-between gap-2 p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{item.title}</div>
                  <div className="text-xs text-muted">{item.category}</div>
                  <div className="mt-1.5"><StatusBadge status={item.status} /></div>
                </div>
                <RowMenu
                  items={[
                    { label: "Edit", onSelect: () => setEditing(item) },
                    { label: "Delete", destructive: true, onSelect: () => setRemoving(item) },
                  ]}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      {uploading ? (
        <GalleryEditor isNew item={null} onClose={() => setUploading(false)} onSave={(i) => save(i, true)} />
      ) : null}
      {editing ? (
        <GalleryEditor isNew={false} item={editing} onClose={() => setEditing(null)} onSave={(i) => save(i, false)} />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="Delete photo"
        body={`Delete "${removing?.title}"? This cannot be undone.`}
        destructive
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          setItems((all) => all.filter((i) => i.id !== removing?.id));
          toast.push("Photo deleted.");
        }}
      />
    </div>
  );
}

function GalleryEditor({
  isNew,
  item,
  onClose,
  onSave,
}: {
  isNew: boolean;
  item: GalleryItem | null;
  onClose: () => void;
  onSave: (item: GalleryItem) => void;
}) {
  const [form, setForm] = React.useState<GalleryItem>(() =>
    item ?? {
      id: `g${Date.now()}`,
      title: "",
      category: "Facility",
      status: "draft",
      updatedAt: new Date().toISOString().slice(0, 10),
    },
  );

  const fields = (
    <div className="flex flex-col gap-3.5">
      {isNew ? (
        <Field label="Photo" hint="No storage is wired up yet — this records the title and category only.">
          <div className="flex h-24 items-center justify-center rounded-[4px] border border-dashed border-line-strong text-xs text-muted">
            Drop a file or click to choose
          </div>
        </Field>
      ) : null}
      <Field label="Title">
        <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      <Field label="Category">
        <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          <option>Facility</option>
          <option>Events</option>
          <option>Products</option>
        </Select>
      </Field>
      <Field label="Status">
        <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Status })}>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </Select>
      </Field>
    </div>
  );

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={() => onSave({ ...form, updatedAt: new Date().toISOString().slice(0, 10) })}>
        {isNew ? "Upload" : "Save"}
      </Button>
    </>
  );

  if (isNew) {
    return (
      <Modal open onClose={onClose} title="Upload" footer={footer} width={560}>
        {fields}
      </Modal>
    );
  }

  return (
    <Drawer open onClose={onClose} width={480} label="Edit photo">
      <DrawerHeader onClose={onClose}>Edit Photo</DrawerHeader>
      <div className="flex-1 overflow-y-auto px-5 py-4">{fields}</div>
      <div className="flex flex-none justify-end gap-2.5 border-t border-divider px-5 py-3">{footer}</div>
    </Drawer>
  );
}
