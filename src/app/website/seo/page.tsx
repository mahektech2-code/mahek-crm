"use client";

import * as React from "react";
import { Button, Card, Field, Input, PageHeader, Td, Textarea, Th, Tr, EmptyState } from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { PAGES, PRODUCTS } from "../mock-data";

type SeoEntry = { id: string; path: string; label: string; title: string; description: string };

function initialEntries(): SeoEntry[] {
  return [
    ...PAGES.map((p) => ({ id: p.id, path: `/${p.slug}`, label: p.title, title: `${p.title} | Mahek Chemicals`, description: "" })),
    ...PRODUCTS.map((p) => ({ id: p.id, path: `/products/${p.slug}`, label: p.name, title: `${p.name} | Mahek Chemicals`, description: p.description })),
  ];
}

export default function SeoPage() {
  const toast = useToast();
  const [entries, setEntries] = React.useState<SeoEntry[]>(initialEntries);
  const [editing, setEditing] = React.useState<SeoEntry | null>(null);

  return (
    <div className="p-6">
      <PageHeader title="SEO" subtitle="Per-page titles, descriptions and metadata." />

      <Card className="overflow-x-auto">
        {entries.length === 0 ? (
          <EmptyState title="Nothing to show" />
        ) : (
          <table className="w-full border-collapse" style={{ "--rowh": "48px" } as React.CSSProperties}>
            <thead>
              <tr>
                <Th>Page</Th>
                <Th>Path</Th>
                <Th>Title</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <Tr key={e.id}>
                  <Td>{e.label}</Td>
                  <Td className="text-muted">{e.path}</Td>
                  <Td className="truncate whitespace-normal">{e.title}</Td>
                  <Td align="right">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(e)}>Edit</Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Drawer open={editing !== null} onClose={() => setEditing(null)} width={480} label="Edit SEO">
        {editing ? (
          <SeoEditor
            entry={editing}
            onClose={() => setEditing(null)}
            onSave={(e) => {
              setEntries((all) => all.map((x) => (x.id === e.id ? e : x)));
              toast.push("SEO metadata saved.");
              setEditing(null);
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function SeoEditor({
  entry,
  onClose,
  onSave,
}: {
  entry: SeoEntry;
  onClose: () => void;
  onSave: (entry: SeoEntry) => void;
}) {
  const [form, setForm] = React.useState(entry);

  return (
    <>
      <DrawerHeader onClose={onClose}>{form.label}</DrawerHeader>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-3.5">
          <Field label="Path">
            <Input value={form.path} disabled />
          </Field>
          <Field label="Title">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Description">
            <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </div>
      </div>
      <div className="flex flex-none justify-end gap-2.5 border-t border-divider px-5 py-3">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave(form)}>Save</Button>
      </div>
    </>
  );
}
