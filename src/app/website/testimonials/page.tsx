"use client";

import * as React from "react";
import { PageHeader, Button, Card, Field, Input, Textarea, EmptyState } from "@/components/ui/primitives";
import { Drawer, DrawerHeader, ConfirmDialog } from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { StatusBadge } from "../status-badge";
import { INITIAL_TESTIMONIALS, ADMIN_USERS, type Testimonial, type ContentStatus } from "../mock-data";

const CURRENT_USER = ADMIN_USERS[0];

export default function TestimonialsPage() {
  const toast = useToast();
  const [items, setItems] = React.useState<Testimonial[]>(INITIAL_TESTIMONIALS);
  const [editing, setEditing] = React.useState<Testimonial | null>(null);
  const [confirmArchive, setConfirmArchive] = React.useState<Testimonial | null>(null);

  const sorted = [...items].sort((a, b) => a.displayOrder - b.displayOrder);

  function upsert(t: Testimonial) {
    setItems((prev) => (prev.some((x) => x.id === t.id) ? prev.map((x) => (x.id === t.id ? t : x)) : [...prev, t]));
  }
  function move(t: Testimonial, dir: -1 | 1) {
    const idx = sorted.findIndex((x) => x.id === t.id);
    const swap = sorted[idx + dir];
    if (!swap) return;
    setItems((prev) => prev.map((x) => (x.id === t.id ? { ...x, displayOrder: swap.displayOrder } : x.id === swap.id ? { ...x, displayOrder: t.displayOrder } : x)));
  }
  function openNew() {
    setEditing({ id: `t_${Date.now()}`, name: "", role: "", company: "", quote: "", initials: "", status: "draft", displayOrder: items.length + 1, updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER });
  }

  return (
    <>
      <PageHeader title="Testimonials" subtitle={`${items.length} testimonials`} actions={<Button variant="primary" onClick={openNew}><Icon name="plus" size={16} /> Add Testimonial</Button>} />

      {sorted.length === 0 ? (
        <Card><EmptyState title="No testimonials yet" action={<Button variant="primary" onClick={openNew}>Add Testimonial</Button>} /></Card>
      ) : (
        <div className="grid gap-3">
          {sorted.map((t, i) => (
            <Card key={t.id} className="flex items-start gap-4 p-4">
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-brand-soft text-[13px] font-semibold text-[#5223E0]">{t.initials}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{t.name}</span>
                  <span className="text-[13px] text-muted">· {t.role}, {t.company}</span>
                  <StatusBadge status={t.status} />
                </div>
                <p className="mt-1 text-[13.5px] text-body">&ldquo;{t.quote}&rdquo;</p>
              </div>
              <div className="flex flex-none flex-col items-end gap-1.5">
                <div className="flex items-center gap-1 text-muted">
                  <button onClick={() => move(t, -1)} disabled={i === 0} className="cursor-pointer disabled:opacity-30">↑</button>
                  <button onClick={() => move(t, 1)} disabled={i === sorted.length - 1} className="cursor-pointer disabled:opacity-30">↓</button>
                </div>
                <div className="flex gap-1.5">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(t)}>Edit</Button>
                  {t.status !== "published" ? (
                    <Button variant="primary" size="sm" onClick={() => { upsert({ ...t, status: "published", publishedAt: new Date().toISOString(), publishedBy: CURRENT_USER }); toast.push("Published"); }}>Publish</Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => { upsert({ ...t, status: "draft" }); toast.push("Unpublished"); }}>Unpublish</Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(t)}>Archive</Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing ? (
        <Drawer open onClose={() => setEditing(null)} label="Testimonial editor">
          <DrawerHeader onClose={() => setEditing(null)}><div className="text-lg font-semibold text-ink">{editing.name || "New testimonial"}</div></DrawerHeader>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Name"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
                <Field label="Initials"><Input value={editing.initials} onChange={(e) => setEditing({ ...editing, initials: e.target.value.slice(0, 2).toUpperCase() })} className="w-24" /></Field>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Role"><Input value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })} /></Field>
                <Field label="Company"><Input value={editing.company} onChange={(e) => setEditing({ ...editing, company: e.target.value })} /></Field>
              </div>
              <Field label="Quote"><Textarea rows={4} value={editing.quote} onChange={(e) => setEditing({ ...editing, quote: e.target.value })} /></Field>
            </div>
          </div>
          <div className="flex flex-none items-center justify-end gap-2.5 border-t border-line px-5 py-3.5">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="secondary" onClick={() => { upsert(editing); toast.push("Saved"); setEditing(null); }}>Save Draft</Button>
            <Button variant="primary" onClick={() => { upsert({ ...editing, status: "published", publishedAt: new Date().toISOString(), publishedBy: CURRENT_USER }); toast.push("Published"); setEditing(null); }}>Publish</Button>
          </div>
        </Drawer>
      ) : null}

      <ConfirmDialog
        open={confirmArchive !== null}
        title="Archive this testimonial?"
        body={<>Archiving removes <strong>{confirmArchive?.name}</strong>&apos;s quote from the live site.</>}
        confirmLabel="Archive"
        destructive
        onClose={() => setConfirmArchive(null)}
        onConfirm={() => { if (confirmArchive) setItems((prev) => prev.map((x) => (x.id === confirmArchive.id ? { ...x, status: "archived" as ContentStatus } : x))); toast.push("Archived"); }}
      />
    </>
  );
}
