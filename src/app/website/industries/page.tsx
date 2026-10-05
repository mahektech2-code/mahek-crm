"use client";

import * as React from "react";
import {
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Td,
  Textarea,
  Th,
  Tr,
  EmptyState,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader, FilterPills, Modal, RowMenu, ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { StatusBadge } from "../status-badge";
import { INDUSTRIES, type Industry, type Status } from "../mock-data";

type Filter = "all" | Status;

export default function IndustriesPage() {
  const toast = useToast();
  const [industries, setIndustries] = React.useState<Industry[]>(INDUSTRIES);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [editing, setEditing] = React.useState<Industry | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [removing, setRemoving] = React.useState<Industry | null>(null);

  const rows = industries.filter((i) => filter === "all" || i.status === filter);

  function save(industry: Industry, isNew: boolean) {
    setIndustries((all) => (isNew ? [industry, ...all] : all.map((i) => (i.id === industry.id ? industry : i))));
    toast.push(isNew ? "Industry added." : "Industry saved.");
    setCreating(false);
    setEditing(null);
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Industries"
        subtitle="The industries the public site says Mahek serves."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Add Industry</Button>}
      />

      <div className="mb-3">
        <FilterPills
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "All", count: industries.length },
            { key: "published", label: "Published", count: industries.filter((i) => i.status === "published").length },
            { key: "draft", label: "Draft", count: industries.filter((i) => i.status === "draft").length },
            { key: "archived", label: "Archived", count: industries.filter((i) => i.status === "archived").length },
          ]}
        />
      </div>

      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState title="No industries" body="Nothing matches this filter." />
        ) : (
          <table className="w-full border-collapse" style={{ "--rowh": "52px" } as React.CSSProperties}>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Updated</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <Tr key={i.id}>
                  <Td className="whitespace-normal">
                    <div className="font-medium text-ink">{i.name}</div>
                    <div className="text-xs text-muted">{i.slug}</div>
                  </Td>
                  <Td><StatusBadge status={i.status} /></Td>
                  <Td>{i.updatedAt}</Td>
                  <Td align="right">
                    <RowMenu
                      items={[
                        { label: "Edit", onSelect: () => setEditing(i) },
                        { label: "Delete", destructive: true, onSelect: () => setRemoving(i) },
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
        <IndustryEditor isNew industry={null} onClose={() => setCreating(false)} onSave={(i) => save(i, true)} />
      ) : null}
      {editing ? (
        <IndustryEditor isNew={false} industry={editing} onClose={() => setEditing(null)} onSave={(i) => save(i, false)} />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="Delete industry"
        body={`Delete "${removing?.name}"? This cannot be undone.`}
        destructive
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          setIndustries((all) => all.filter((i) => i.id !== removing?.id));
          toast.push("Industry deleted.");
        }}
      />
    </div>
  );
}

function IndustryEditor({
  isNew,
  industry,
  onClose,
  onSave,
}: {
  isNew: boolean;
  industry: Industry | null;
  onClose: () => void;
  onSave: (industry: Industry) => void;
}) {
  const [form, setForm] = React.useState<Industry>(() =>
    industry ?? {
      id: `i${Date.now()}`,
      slug: "",
      name: "",
      status: "draft",
      description: "",
      updatedAt: new Date().toISOString().slice(0, 10),
    },
  );

  const fields = (
    <div className="flex flex-col gap-3.5">
      <Field label="Name">
        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Slug">
        <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
      </Field>
      <Field label="Status">
        <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Status })}>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </Select>
      </Field>
      <Field label="Description">
        <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
    </div>
  );

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={() => onSave({ ...form, updatedAt: new Date().toISOString().slice(0, 10) })}>
        {isNew ? "Add industry" : "Save"}
      </Button>
    </>
  );

  if (isNew) {
    return (
      <Modal open onClose={onClose} title="Add Industry" footer={footer} width={560}>
        {fields}
      </Modal>
    );
  }

  return (
    <Drawer open onClose={onClose} width={520} label="Edit industry">
      <DrawerHeader onClose={onClose}>Edit Industry</DrawerHeader>
      <div className="flex-1 overflow-y-auto px-5 py-4">{fields}</div>
      <div className="flex flex-none justify-end gap-2.5 border-t border-divider px-5 py-3">{footer}</div>
    </Drawer>
  );
}
