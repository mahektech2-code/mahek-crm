"use client";

import * as React from "react";
import { Button, Card, Field, Input, PageHeader, Select, Td, Th, Tr, EmptyState } from "@/components/ui/primitives";
import { Drawer, DrawerHeader, Modal, RowMenu, ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { calendarDate } from "@/lib/business-date";
import { StatusBadge } from "../status-badge";
import { MILESTONES, type Milestone, type Status } from "../mock-data";

export default function MilestonesPage() {
  const toast = useToast();
  const [items, setItems] = React.useState<Milestone[]>(
    [...MILESTONES].sort((a, b) => a.year.localeCompare(b.year)),
  );
  const [editing, setEditing] = React.useState<Milestone | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [removing, setRemoving] = React.useState<Milestone | null>(null);

  function save(m: Milestone, isNew: boolean) {
    setItems((all) =>
      (isNew ? [m, ...all] : all.map((x) => (x.id === m.id ? m : x))).sort((a, b) => a.year.localeCompare(b.year)),
    );
    toast.push(isNew ? "Milestone added." : "Milestone saved.");
    setCreating(false);
    setEditing(null);
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Milestones"
        subtitle="The company timeline shown on the public site."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Add Milestone</Button>}
      />

      <Card className="overflow-x-auto">
        {items.length === 0 ? (
          <EmptyState title="No milestones" />
        ) : (
          <table className="w-full border-collapse" style={{ "--rowh": "48px" } as React.CSSProperties}>
            <thead>
              <tr>
                <Th>Year</Th>
                <Th>Title</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <Tr key={m.id}>
                  <Td>{m.year}</Td>
                  <Td className="whitespace-normal">{m.title}</Td>
                  <Td><StatusBadge status={m.status} /></Td>
                  <Td align="right">
                    <RowMenu
                      items={[
                        { label: "Edit", onSelect: () => setEditing(m) },
                        { label: "Delete", destructive: true, onSelect: () => setRemoving(m) },
                      ]}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {creating ? (
        <MilestoneEditor isNew milestone={null} onClose={() => setCreating(false)} onSave={(m) => save(m, true)} />
      ) : null}
      {editing ? (
        <MilestoneEditor isNew={false} milestone={editing} onClose={() => setEditing(null)} onSave={(m) => save(m, false)} />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="Delete milestone"
        body={`Delete "${removing?.title}"? This cannot be undone.`}
        destructive
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          setItems((all) => all.filter((m) => m.id !== removing?.id));
          toast.push("Milestone deleted.");
        }}
      />
    </div>
  );
}

function MilestoneEditor({
  isNew,
  milestone,
  onClose,
  onSave,
}: {
  isNew: boolean;
  milestone: Milestone | null;
  onClose: () => void;
  onSave: (m: Milestone) => void;
}) {
  const [form, setForm] = React.useState<Milestone>(() =>
    milestone ?? {
      id: `ms${Date.now()}`,
      year: calendarDate(new Date()).slice(0, 4),
      title: "",
      status: "draft",
      updatedAt: calendarDate(new Date()),
    },
  );

  const fields = (
    <div className="flex flex-col gap-3.5">
      <Field label="Year">
        <Input value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} />
      </Field>
      <Field label="Title">
        <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
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
      <Button variant="primary" onClick={() => onSave({ ...form, updatedAt: calendarDate(new Date()) })}>
        {isNew ? "Add milestone" : "Save"}
      </Button>
    </>
  );

  if (isNew) {
    return (
      <Modal open onClose={onClose} title="Add Milestone" footer={footer} width={480}>
        {fields}
      </Modal>
    );
  }

  return (
    <Drawer open onClose={onClose} width={420} label="Edit milestone">
      <DrawerHeader onClose={onClose}>Edit Milestone</DrawerHeader>
      <div className="flex-1 overflow-y-auto px-5 py-4">{fields}</div>
      <div className="flex flex-none justify-end gap-2.5 border-t border-divider px-5 py-3">{footer}</div>
    </Drawer>
  );
}
