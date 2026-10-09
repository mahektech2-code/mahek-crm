"use client";

import * as React from "react";
import {
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  EmptyState,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader, Modal, RowMenu, ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { calendarDate } from "@/lib/business-date";
import { StatusBadge } from "../status-badge";
import { TESTIMONIALS, type Testimonial, type Status } from "../mock-data";
import { tempFeedback } from "../prototype";
import { hasErrors, required, type Errors } from "../validation";

export default function TestimonialsPage() {
  const toast = useToast();
  const [items, setItems] = React.useState<Testimonial[]>(TESTIMONIALS);
  const [editing, setEditing] = React.useState<Testimonial | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [removing, setRemoving] = React.useState<Testimonial | null>(null);

  function save(t: Testimonial, isNew: boolean) {
    setItems((all) => (isNew ? [t, ...all] : all.map((x) => (x.id === t.id ? t : x))));
    toast.push(tempFeedback(isNew ? "Testimonial added" : "Testimonial saved"));
    setCreating(false);
    setEditing(null);
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Testimonials"
        subtitle="Customer quotes shown on the public site."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Add Testimonial</Button>}
      />

      {items.length === 0 ? (
        <Card><EmptyState title="No testimonials" /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {items.map((t) => (
            <Card key={t.id} className="flex flex-col gap-3 p-4">
              <p className="text-sm text-body">&ldquo;{t.quote}&rdquo;</p>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-ink">{t.author}</div>
                  <div className="text-xs text-muted">{t.company}</div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={t.status} />
                  <RowMenu
                    items={[
                      { label: "Edit", onSelect: () => setEditing(t) },
                      { label: "Delete", destructive: true, onSelect: () => setRemoving(t) },
                    ]}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {creating ? (
        <TestimonialEditor isNew testimonial={null} onClose={() => setCreating(false)} onSave={(t) => save(t, true)} />
      ) : null}
      {editing ? (
        <TestimonialEditor isNew={false} testimonial={editing} onClose={() => setEditing(null)} onSave={(t) => save(t, false)} />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="Delete testimonial"
        body={`Delete the quote from "${removing?.author}"? This cannot be undone.`}
        destructive
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          setItems((all) => all.filter((t) => t.id !== removing?.id));
          toast.push(tempFeedback("Testimonial deleted"));
        }}
      />
    </div>
  );
}

function TestimonialEditor({
  isNew,
  testimonial,
  onClose,
  onSave,
}: {
  isNew: boolean;
  testimonial: Testimonial | null;
  onClose: () => void;
  onSave: (t: Testimonial) => void;
}) {
  const [errors, setErrors] = React.useState<Errors<"author" | "quote">>({});
  const [form, setForm] = React.useState<Testimonial>(() =>
    testimonial ?? {
      id: `t${Date.now()}`,
      author: "",
      company: "",
      status: "draft",
      quote: "",
      updatedAt: calendarDate(new Date()),
    },
  );

  function submit() {
    const clean = { ...form, author: form.author.trim(), company: form.company.trim(), quote: form.quote.trim() };
    const found = { author: required(clean.author, "Author"), quote: required(clean.quote, "Quote") };
    if (hasErrors(found)) {
      setErrors(found);
      return;
    }
    onSave({ ...clean, updatedAt: calendarDate(new Date()) });
  }

  const fields = (
    <div className="flex flex-col gap-3.5">
      <Field label="Author" error={errors.author}>
        <Input
          value={form.author}
          aria-invalid={!!errors.author}
          onChange={(e) => {
            setForm({ ...form, author: e.target.value });
            setErrors((x) => ({ ...x, author: undefined }));
          }}
        />
      </Field>
      <Field label="Company">
        <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
      </Field>
      <Field label="Quote" error={errors.quote}>
        <Textarea
          rows={3}
          value={form.quote}
          aria-invalid={!!errors.quote}
          onChange={(e) => {
            setForm({ ...form, quote: e.target.value });
            setErrors((x) => ({ ...x, quote: undefined }));
          }}
        />
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
      <Button variant="primary" onClick={submit}>
        {isNew ? "Add testimonial" : "Save"}
      </Button>
    </>
  );

  if (isNew) {
    return (
      <Modal open onClose={onClose} title="Add Testimonial" footer={footer} width={560}>
        {fields}
      </Modal>
    );
  }

  return (
    <Drawer open onClose={onClose} width={480} label="Edit testimonial">
      <DrawerHeader onClose={onClose}>Edit Testimonial</DrawerHeader>
      <div className="flex-1 overflow-y-auto px-5 py-4">{fields}</div>
      <div className="flex flex-none justify-end gap-2.5 border-t border-divider px-5 py-3">{footer}</div>
    </Drawer>
  );
}
