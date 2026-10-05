"use client";

import * as React from "react";
import { PageHeader, Button, Card, Field, Input, Textarea, EmptyState } from "@/components/ui/primitives";
import { Drawer, DrawerHeader, ConfirmDialog } from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { INITIAL_MILESTONES, type Milestone } from "../mock-data";

export default function MilestonesPage() {
  const toast = useToast();
  const [items, setItems] = React.useState<Milestone[]>(INITIAL_MILESTONES);
  const [editing, setEditing] = React.useState<Milestone | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<Milestone | null>(null);

  const sorted = [...items].sort((a, b) => a.displayOrder - b.displayOrder);

  function upsert(m: Milestone) {
    setItems((prev) => (prev.some((x) => x.id === m.id) ? prev.map((x) => (x.id === m.id ? m : x)) : [...prev, m]));
  }
  function move(m: Milestone, dir: -1 | 1) {
    const idx = sorted.findIndex((x) => x.id === m.id);
    const swap = sorted[idx + dir];
    if (!swap) return;
    setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, displayOrder: swap.displayOrder } : x.id === swap.id ? { ...x, displayOrder: m.displayOrder } : x)));
  }
  function openNew() {
    setEditing({ id: `ms_${Date.now()}`, year: "", title: "", description: "", displayOrder: items.length + 1 });
  }

  return (
    <>
      <PageHeader title="Milestones" subtitle="Company timeline, shown on the About page." actions={<Button variant="primary" onClick={openNew}><Icon name="plus" size={16} /> Add Milestone</Button>} />

      {sorted.length === 0 ? (
        <Card><EmptyState title="No milestones yet" action={<Button variant="primary" onClick={openNew}>Add Milestone</Button>} /></Card>
      ) : (
        <Card className="p-5">
          <div className="relative ml-3 border-l border-line pl-6">
            {sorted.map((m, i) => (
              <div key={m.id} className="relative mb-6 last:mb-0">
                <span className="absolute top-1 -left-[29px] h-2.5 w-2.5 rounded-full bg-brand" />
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-semibold text-brand">{m.year}</div>
                    <div className="font-medium text-ink">{m.title}</div>
                    <p className="mt-0.5 max-w-[640px] text-[13.5px] text-muted">{m.description}</p>
                  </div>
                  <div className="flex flex-none items-center gap-1.5">
                    <button onClick={() => move(m, -1)} disabled={i === 0} className="cursor-pointer text-muted disabled:opacity-30">↑</button>
                    <button onClick={() => move(m, 1)} disabled={i === sorted.length - 1} className="cursor-pointer text-muted disabled:opacity-30">↓</button>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(m)}>Edit</Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(m)}>Delete</Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {editing ? (
        <Drawer open onClose={() => setEditing(null)} label="Milestone editor">
          <DrawerHeader onClose={() => setEditing(null)}><div className="text-lg font-semibold text-ink">{editing.title || "New milestone"}</div></DrawerHeader>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            <div className="grid gap-4">
              <Field label="Year"><Input value={editing.year} onChange={(e) => setEditing({ ...editing, year: e.target.value })} className="w-32" /></Field>
              <Field label="Title"><Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
              <Field label="Description"><Textarea rows={4} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
            </div>
          </div>
          <div className="flex flex-none items-center justify-end gap-2.5 border-t border-line px-5 py-3.5">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { upsert(editing); toast.push("Saved"); setEditing(null); }}>Save</Button>
          </div>
        </Drawer>
      ) : null}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this milestone?"
        body={<>This removes <strong>{confirmDelete?.title}</strong> from the About page timeline.</>}
        confirmLabel="Delete"
        destructive
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => { if (confirmDelete) setItems((prev) => prev.filter((x) => x.id !== confirmDelete.id)); toast.push("Deleted"); }}
      />
    </>
  );
}
