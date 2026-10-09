"use client";

import * as React from "react";
import { Button, Card, CardHeader, Field, Input, PageHeader, Select, EmptyState } from "@/components/ui/primitives";
import { Drawer, DrawerHeader, Modal, RowMenu, ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { NAV, NAV_GROUP_LABEL, type NavGroup, type NavItem } from "../mock-data";
import { tempFeedback } from "../prototype";
import { hasErrors, linkError, required, type Errors } from "../validation";

type Editing = { group: NavGroup; item: NavItem };

export default function NavigationPage() {
  const toast = useToast();
  const [draft, setDraft] = React.useState<Record<NavGroup, NavItem[]>>(NAV);
  const [editing, setEditing] = React.useState<Editing | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [removing, setRemoving] = React.useState<Editing | null>(null);

  function save(group: NavGroup, item: NavItem, isNew: boolean) {
    setDraft((all) => ({
      ...all,
      [group]: isNew ? [...all[group], item] : all[group].map((x) => (x.id === item.id ? item : x)),
    }));
    toast.push(tempFeedback(isNew ? "Menu item added" : "Menu item saved"));
    setCreating(false);
    setEditing(null);
  }

  const groups = Object.keys(draft) as NavGroup[];

  return (
    <div className="p-6">
      <PageHeader
        title="Navigation"
        subtitle="The header and footer menus."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Add Item</Button>}
      />

      <div className="flex flex-col gap-4">
        {groups.map((g) => (
          <Card key={g}>
            <CardHeader title={NAV_GROUP_LABEL[g]} hint={`${draft[g].length} items`} />
            {draft[g].length === 0 ? (
              <EmptyState title="No items in this menu" />
            ) : (
              <div className="flex flex-col">
                {draft[g].map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 border-b border-divider px-5 py-2.5 last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink">{item.label}</div>
                      <div className="text-xs text-muted">{item.href}</div>
                    </div>
                    <RowMenu
                      items={[
                        { label: "Edit", onSelect: () => setEditing({ group: g, item }) },
                        { label: "Delete", destructive: true, onSelect: () => setRemoving({ group: g, item }) },
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>

      {creating ? (
        <NavItemEditor isNew entry={null} onClose={() => setCreating(false)} onSave={(g, i) => save(g, i, true)} />
      ) : null}
      {editing ? (
        <NavItemEditor
          isNew={false}
          entry={editing}
          onClose={() => setEditing(null)}
          onSave={(g, i) => save(g, i, false)}
        />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="Delete menu item"
        body={`Delete "${removing?.item.label}"? This cannot be undone.`}
        destructive
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          setDraft((all) => ({
            ...all,
            [removing.group]: all[removing.group].filter((x) => x.id !== removing.item.id),
          }));
          toast.push(tempFeedback("Menu item deleted"));
        }}
      />
    </div>
  );
}

function NavItemEditor({
  isNew,
  entry,
  onClose,
  onSave,
}: {
  isNew: boolean;
  entry: Editing | null;
  onClose: () => void;
  onSave: (group: NavGroup, item: NavItem) => void;
}) {
  const [errors, setErrors] = React.useState<Errors<"label" | "href">>({});
  const [group, setGroup] = React.useState<NavGroup>(entry?.group ?? "header");
  const [item, setItem] = React.useState<NavItem>(() =>
    entry?.item ?? { id: `n${Date.now()}`, label: "", href: "" },
  );

  function submit() {
    const clean = { ...item, label: item.label.trim(), href: item.href.trim() };
    const found = { label: required(clean.label, "Label"), href: linkError(clean.href) };
    if (hasErrors(found)) {
      setErrors(found);
      return;
    }
    onSave(group, clean);
  }

  const fields = (
    <div className="flex flex-col gap-3.5">
      <Field label="Menu">
        <Select value={group} onChange={(e) => setGroup(e.target.value as NavGroup)} disabled={!isNew}>
          {Object.entries(NAV_GROUP_LABEL).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </Select>
      </Field>
      <Field label="Label" error={errors.label}>
        <Input
          value={item.label}
          aria-invalid={!!errors.label}
          onChange={(e) => {
            setItem({ ...item, label: e.target.value });
            setErrors((x) => ({ ...x, label: undefined }));
          }}
        />
      </Field>
      <Field label="Link" hint="A path on the public site, e.g. /products." error={errors.href}>
        <Input
          value={item.href}
          aria-invalid={!!errors.href}
          onChange={(e) => {
            setItem({ ...item, href: e.target.value });
            setErrors((x) => ({ ...x, href: undefined }));
          }}
        />
      </Field>
    </div>
  );

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={submit}>{isNew ? "Add item" : "Save"}</Button>
    </>
  );

  if (isNew) {
    return (
      <Modal open onClose={onClose} title="Add Item" footer={footer} width={480}>
        {fields}
      </Modal>
    );
  }

  return (
    <Drawer open onClose={onClose} width={420} label="Edit menu item">
      <DrawerHeader onClose={onClose}>Edit Navigation Item</DrawerHeader>
      <div className="flex-1 overflow-y-auto px-5 py-4">{fields}</div>
      <div className="flex flex-none justify-end gap-2.5 border-t border-divider px-5 py-3">{footer}</div>
    </Drawer>
  );
}
