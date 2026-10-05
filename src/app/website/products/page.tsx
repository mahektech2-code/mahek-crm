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
import { calendarDate } from "@/lib/business-date";
import { StatusBadge } from "../status-badge";
import { PRODUCTS, type Product, type Status } from "../mock-data";

type Filter = "all" | Status;

export default function ProductsPage() {
  const toast = useToast();
  const [products, setProducts] = React.useState<Product[]>(PRODUCTS);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [editing, setEditing] = React.useState<Product | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [removing, setRemoving] = React.useState<Product | null>(null);

  const rows = products.filter((p) => filter === "all" || p.status === filter);

  function save(product: Product, isNew: boolean) {
    setProducts((all) => (isNew ? [product, ...all] : all.map((p) => (p.id === product.id ? product : p))));
    toast.push(isNew ? "Product added." : "Product saved.");
    setCreating(false);
    setEditing(null);
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Products"
        subtitle="The catalogue shown on the public site."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>Add Product</Button>}
      />

      <div className="mb-3">
        <FilterPills
          value={filter}
          onChange={setFilter}
          options={[
            { key: "all", label: "All", count: products.length },
            { key: "published", label: "Published", count: products.filter((p) => p.status === "published").length },
            { key: "draft", label: "Draft", count: products.filter((p) => p.status === "draft").length },
            { key: "archived", label: "Archived", count: products.filter((p) => p.status === "archived").length },
          ]}
        />
      </div>

      <Card className="overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState title="No products" body="Nothing matches this filter." />
        ) : (
          <table className="w-full border-collapse" style={{ "--rowh": "52px" } as React.CSSProperties}>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Category</Th>
                <Th>Status</Th>
                <Th>Updated</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <Tr key={p.id}>
                  <Td className="whitespace-normal">
                    <div className="font-medium text-ink">{p.name}</div>
                    <div className="text-xs text-muted">{p.slug}</div>
                  </Td>
                  <Td>{p.category}</Td>
                  <Td><StatusBadge status={p.status} /></Td>
                  <Td>{p.updatedAt}</Td>
                  <Td align="right">
                    <RowMenu
                      items={[
                        { label: "Edit", onSelect: () => setEditing(p) },
                        { label: "Delete", destructive: true, onSelect: () => setRemoving(p) },
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
        <ProductEditor isNew product={null} onClose={() => setCreating(false)} onSave={(p) => save(p, true)} />
      ) : null}
      {editing ? (
        <ProductEditor isNew={false} product={editing} onClose={() => setEditing(null)} onSave={(p) => save(p, false)} />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title="Delete product"
        body={`Delete "${removing?.name}"? This cannot be undone.`}
        destructive
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          setProducts((all) => all.filter((p) => p.id !== removing?.id));
          toast.push("Product deleted.");
        }}
      />
    </div>
  );
}

function ProductEditor({
  isNew,
  product,
  onClose,
  onSave,
}: {
  isNew: boolean;
  product: Product | null;
  onClose: () => void;
  onSave: (product: Product) => void;
}) {
  const [form, setForm] = React.useState<Product>(() =>
    product ?? {
      id: `p${Date.now()}`,
      slug: "",
      name: "",
      category: "Thinners",
      status: "draft",
      description: "",
      updatedAt: calendarDate(new Date()),
    },
  );

  const fields = (
    <div className="flex flex-col gap-3.5">
      <Field label="Name">
        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Slug" hint="Used in the product URL.">
        <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
      </Field>
      <Field label="Category">
        <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          <option>Thinners</option>
          <option>Polish</option>
          <option>Cleaners</option>
        </Select>
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
      <Button variant="primary" onClick={() => onSave({ ...form, updatedAt: calendarDate(new Date()) })}>
        {isNew ? "Add product" : "Save"}
      </Button>
    </>
  );

  if (isNew) {
    return (
      <Modal open onClose={onClose} title="Add Product" footer={footer} width={560}>
        {fields}
      </Modal>
    );
  }

  return (
    <Drawer open onClose={onClose} width={520} label="Edit product">
      <DrawerHeader onClose={onClose}>Edit Product</DrawerHeader>
      <div className="flex-1 overflow-y-auto px-5 py-4">{fields}</div>
      <div className="flex flex-none justify-end gap-2.5 border-t border-divider px-5 py-3">{footer}</div>
    </Drawer>
  );
}
