"use client";

import * as React from "react";
import {
  PageHeader,
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
  Th,
  Td,
  Tr,
  EmptyState,
  Callout,
  Badge,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader, ConfirmDialog, Tabs, FilterPills, RowMenu } from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { StatusBadge } from "../status-badge";
import {
  INITIAL_PRODUCTS,
  ADMIN_USERS,
  formatDate,
  formatDateTime,
  type WebsiteProduct,
  type ContentStatus,
} from "../mock-data";

type StatusFilter = "all" | ContentStatus;
type EditorTab = "basic" | "content" | "media" | "visibility" | "seo" | "publishing";

const CURRENT_USER = ADMIN_USERS[0];

export default function ProductsPage() {
  const toast = useToast();
  const [products, setProducts] = React.useState<WebsiteProduct[]>(INITIAL_PRODUCTS);
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [sortBy, setSortBy] = React.useState<"order" | "updated" | "name">("order");

  const [editing, setEditing] = React.useState<WebsiteProduct | null>(null);
  const [isNew, setIsNew] = React.useState(false);
  const [confirmArchive, setConfirmArchive] = React.useState<WebsiteProduct | null>(null);
  const [confirmUnpublish, setConfirmUnpublish] = React.useState<WebsiteProduct | null>(null);

  const filtered = products
    .filter((p) => (statusFilter === "all" ? true : p.status === statusFilter))
    .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()) || p.slug.includes(query.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "updated") return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return a.displayOrder - b.displayOrder;
    });

  function upsert(product: WebsiteProduct) {
    setProducts((prev) => {
      const exists = prev.some((p) => p.id === product.id);
      return exists ? prev.map((p) => (p.id === product.id ? product : p)) : [...prev, product];
    });
  }

  function setStatus(product: WebsiteProduct, status: ContentStatus, extra?: Partial<WebsiteProduct>) {
    upsert({
      ...product,
      status,
      updatedAt: new Date().toISOString(),
      updatedBy: CURRENT_USER,
      ...extra,
    });
  }

  function openNew() {
    setIsNew(true);
    setEditing({
      id: `prod_${Date.now()}`,
      name: "",
      slug: "",
      tag: "",
      status: "draft",
      displayOrder: products.length + 1,
      shortDescription: "",
      longDescription: "",
      applications: [],
      benefits: [],
      packaging: [],
      specs: [],
      images: [],
      industries: [],
      seo: { title: "", description: "", canonical: "", ogImage: null },
      updatedAt: new Date().toISOString(),
      updatedBy: CURRENT_USER,
    });
  }

  function openEdit(p: WebsiteProduct) {
    setIsNew(false);
    setEditing(p);
  }

  function duplicate(p: WebsiteProduct) {
    const copy: WebsiteProduct = {
      ...p,
      id: `prod_copy_${p.id}_${products.length}`,
      name: `${p.name} (Copy)`,
      slug: `${p.slug}-copy`,
      status: "draft",
      displayOrder: products.length + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: CURRENT_USER,
      publishedAt: undefined,
      publishedBy: undefined,
    };
    upsert(copy);
    toast.push(`Duplicated as "${copy.name}" (draft)`);
  }

  return (
    <>
      <PageHeader
        title="Products"
        subtitle={`${products.length} products · ${products.filter((p) => p.status === "published").length} published`}
        actions={
          <Button variant="primary" onClick={openNew}>
            <Icon name="plus" size={16} /> Add Product
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <FilterPills
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { key: "all", label: "All", count: products.length },
            { key: "published", label: "Published", count: products.filter((p) => p.status === "published").length },
            { key: "draft", label: "Draft", count: products.filter((p) => p.status === "draft").length },
            { key: "archived", label: "Archived", count: products.filter((p) => p.status === "archived").length },
          ]}
        />
        <div className="flex items-center gap-2">
          <Input placeholder="Search products…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-56" />
          <Select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
            <option value="order">Sort: Display order</option>
            <option value="updated">Sort: Last updated</option>
            <option value="name">Sort: Name</option>
          </Select>
        </div>
      </div>

      <Card className="overflow-x-auto">
        {filtered.length === 0 ? (
          <EmptyState
            title="No products match"
            body="Try clearing filters or search, or add a new product."
            action={<Button variant="primary" onClick={openNew}>Add Product</Button>}
          />
        ) : (
          <table className="w-full">
            <thead>
              <Tr>
                <Th>Product</Th>
                <Th>Slug</Th>
                <Th>Tag</Th>
                <Th>Status</Th>
                <Th align="right">Order</Th>
                <Th>Updated</Th>
                <Th>Updated by</Th>
                <Th align="right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <Tr key={p.id}>
                  <Td className="whitespace-normal">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[4px] bg-canvas text-[11px] font-medium text-muted">
                        {p.images[0] ? "IMG" : "—"}
                      </span>
                      <button onClick={() => openEdit(p)} className="cursor-pointer text-left font-medium text-ink hover:text-brand">
                        {p.name}
                      </button>
                    </div>
                  </Td>
                  <Td className="text-muted">/{p.slug}</Td>
                  <Td>{p.tag ? <Badge tone="brand">{p.tag}</Badge> : "—"}</Td>
                  <Td>
                    <StatusBadge status={p.status} />
                  </Td>
                  <Td align="right">{p.displayOrder}</Td>
                  <Td>{formatDate(p.updatedAt)}</Td>
                  <Td>{p.updatedBy}</Td>
                  <Td align="right">
                    <RowMenu
                      items={[
                        { label: "Edit", onSelect: () => openEdit(p) },
                        { label: "Preview", onSelect: () => toast.push(`Preview: /products/${p.slug} (prototype only)`) },
                        { label: "Duplicate", onSelect: () => duplicate(p) },
                        ...(p.status !== "published"
                          ? [{ label: "Publish", onSelect: () => setStatus(p, "published", { publishedAt: new Date().toISOString(), publishedBy: CURRENT_USER }) }]
                          : [{ label: "Unpublish", onSelect: () => setConfirmUnpublish(p) }]),
                        ...(p.status !== "archived"
                          ? [{ label: "Archive", onSelect: () => setConfirmArchive(p), destructive: true }]
                          : [{ label: "Restore to draft", onSelect: () => setStatus(p, "draft") }]),
                      ]}
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing ? (
        <ProductEditor
          key={editing.id}
          product={editing}
          isNew={isNew}
          onClose={() => setEditing(null)}
          onSaveDraft={(p) => {
            upsert({ ...p, status: p.status === "published" ? "published" : "draft", updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER });
            toast.push("Draft saved");
            setEditing(null);
          }}
          onPublish={(p) => {
            upsert({ ...p, status: "published", updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER, publishedAt: new Date().toISOString(), publishedBy: CURRENT_USER });
            toast.push(`${p.name} published`);
            setEditing(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmUnpublish !== null}
        title="Unpublish this product?"
        body={<>This removes <strong>{confirmUnpublish?.name}</strong> from the live website. It stays editable as a draft.</>}
        confirmLabel="Unpublish"
        onClose={() => setConfirmUnpublish(null)}
        onConfirm={() => {
          if (confirmUnpublish) setStatus(confirmUnpublish, "draft");
          toast.push("Unpublished");
        }}
      />
      <ConfirmDialog
        open={confirmArchive !== null}
        title="Archive this product?"
        body={
          <>
            Archiving removes <strong>{confirmArchive?.name}</strong> from the live site and search. It is never deleted — the
            record and its URL history stay intact, and it can be restored.
          </>
        }
        confirmLabel="Archive"
        destructive
        onClose={() => setConfirmArchive(null)}
        onConfirm={() => {
          if (confirmArchive) setStatus(confirmArchive, "archived");
          toast.push("Archived");
        }}
      />
    </>
  );
}

function ProductEditor({
  product,
  isNew,
  onClose,
  onSaveDraft,
  onPublish,
}: {
  product: WebsiteProduct;
  isNew: boolean;
  onClose: () => void;
  onSaveDraft: (p: WebsiteProduct) => void;
  onPublish: (p: WebsiteProduct) => void;
}) {
  const [draft, setDraft] = React.useState<WebsiteProduct>(product);
  const [tab, setTab] = React.useState<EditorTab>("basic");

  function set<K extends keyof WebsiteProduct>(key: K, value: WebsiteProduct[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  function setList(key: "applications" | "benefits" | "packaging", text: string) {
    set(key, text.split("\n").map((s) => s.trim()).filter(Boolean));
  }

  return (
    <Drawer open onClose={onClose} width={720} label="Product editor">
      <DrawerHeader onClose={onClose}>
        <div className="text-lg font-semibold text-ink">{isNew ? "Add Product" : draft.name || "Untitled product"}</div>
        <div className="mt-0.5 text-[13px] text-muted">
          {isNew ? "New product · not yet saved" : `Last updated ${formatDateTime(draft.updatedAt)} by ${draft.updatedBy}`}
        </div>
      </DrawerHeader>

      <Tabs
        value={tab}
        onChange={setTab}
        className="flex-none px-5"
        tabs={[
          { key: "basic", label: "Basic Info" },
          { key: "content", label: "Content" },
          { key: "media", label: "Media" },
          { key: "visibility", label: "Visibility" },
          { key: "seo", label: "SEO" },
          { key: "publishing", label: "Publishing" },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {tab === "basic" && (
          <div className="grid gap-4">
            <Field label="Product name">
              <Input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Mahek Universal Thinner" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Slug" hint="Used in the URL — changing this changes the live product page's address.">
                <Input value={draft.slug} onChange={(e) => set("slug", e.target.value)} placeholder="universal-thinner" />
              </Field>
              <Field label="Tag / badge">
                <Input value={draft.tag} onChange={(e) => set("tag", e.target.value)} placeholder="Best Seller" />
              </Field>
            </div>
            <Field label="Short description" hint="Shown on product cards and as the default meta description.">
              <Textarea rows={2} value={draft.shortDescription} onChange={(e) => set("shortDescription", e.target.value)} />
            </Field>
            <Field label="Long description">
              <Textarea rows={5} value={draft.longDescription} onChange={(e) => set("longDescription", e.target.value)} />
            </Field>
          </div>
        )}

        {tab === "content" && (
          <div className="grid gap-4">
            <Field label="Applications" hint="One per line">
              <Textarea rows={4} value={draft.applications.join("\n")} onChange={(e) => setList("applications", e.target.value)} />
            </Field>
            <Field label="Benefits" hint="One per line">
              <Textarea rows={4} value={draft.benefits.join("\n")} onChange={(e) => setList("benefits", e.target.value)} />
            </Field>
            <Field label="Packaging sizes" hint="One per line, e.g. 500ml">
              <Textarea rows={3} value={draft.packaging.join("\n")} onChange={(e) => setList("packaging", e.target.value)} />
            </Field>
            <Field label="Specifications">
              <div className="grid gap-2">
                {draft.specs.map((s, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <Input
                      value={s.label}
                      placeholder="Label (e.g. Appearance)"
                      onChange={(e) => {
                        const specs = [...draft.specs];
                        specs[i] = { ...s, label: e.target.value };
                        set("specs", specs);
                      }}
                    />
                    <Input
                      value={s.value}
                      placeholder="Value"
                      onChange={(e) => {
                        const specs = [...draft.specs];
                        specs[i] = { ...s, value: e.target.value };
                        set("specs", specs);
                      }}
                    />
                    <Button variant="ghost" size="sm" onClick={() => set("specs", draft.specs.filter((_, idx) => idx !== i))}>
                      Remove
                    </Button>
                  </div>
                ))}
                <Button variant="secondary" size="sm" className="w-fit" onClick={() => set("specs", [...draft.specs, { label: "", value: "" }])}>
                  <Icon name="plus" size={14} /> Add spec row
                </Button>
              </div>
            </Field>
          </div>
        )}

        {tab === "media" && (
          <div className="grid gap-4">
            <Callout tone="brand">
              Images are chosen from the shared Media Library — this prototype represents the picker; uploads happen there, not here.
            </Callout>
            <div className="grid gap-2">
              {draft.images.map((img, i) => (
                <div key={img.id} className="flex items-center gap-3 rounded-[4px] border border-line p-3">
                  <span className="flex h-12 w-12 flex-none items-center justify-center rounded-[4px] bg-canvas text-[10px] text-muted">IMG</span>
                  <div className="min-w-0 flex-1">
                    <Input
                      value={img.label}
                      placeholder="Size label (e.g. 5L)"
                      onChange={(e) => {
                        const images = [...draft.images];
                        images[i] = { ...img, label: e.target.value };
                        set("images", images);
                      }}
                      className="mb-1.5"
                    />
                    <Input
                      value={img.alt}
                      placeholder="Alt text"
                      onChange={(e) => {
                        const images = [...draft.images];
                        images[i] = { ...img, alt: e.target.value };
                        set("images", images);
                      }}
                    />
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => set("images", draft.images.filter((_, idx) => idx !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                className="w-fit"
                onClick={() => set("images", [...draft.images, { id: `img_${Date.now()}`, label: "", alt: "" }])}
              >
                <Icon name="plus" size={14} /> Choose from Media Library
              </Button>
            </div>
          </div>
        )}

        {tab === "visibility" && (
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Status">
                <Select value={draft.status} onChange={(e) => set("status", e.target.value as ContentStatus)}>
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                  <option value="archived">Archived</option>
                </Select>
              </Field>
              <Field label="Display order" hint="Lower numbers appear first on /products">
                <Input type="number" value={draft.displayOrder} onChange={(e) => set("displayOrder", Number(e.target.value))} />
              </Field>
            </div>
            <Field label="Industries served" hint="One per line — a future phase replaces this with a real linked picker (see Industries module).">
              <Textarea
                rows={3}
                value={draft.industries.join("\n")}
                onChange={(e) => set("industries", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
              />
            </Field>
          </div>
        )}

        {tab === "seo" && (
          <div className="grid gap-4">
            <Field label="SEO title" hint={`Falls back to "${draft.name} | Mahek Marketing India" if left blank`}>
              <Input value={draft.seo.title} onChange={(e) => set("seo", { ...draft.seo, title: e.target.value })} />
            </Field>
            <Field label="SEO description" hint="Falls back to the short description above if left blank">
              <Textarea rows={2} value={draft.seo.description} onChange={(e) => set("seo", { ...draft.seo, description: e.target.value })} />
            </Field>
            <Field label="Canonical URL">
              <Input value={draft.seo.canonical} onChange={(e) => set("seo", { ...draft.seo, canonical: e.target.value })} />
            </Field>
            <Callout tone="brand">
              Sitemap inclusion, JSON-LD structured data and robots directives stay developer-controlled — only the fields above are editable here.
            </Callout>
          </div>
        )}

        {tab === "publishing" && (
          <div className="grid gap-3 text-[13.5px]">
            <Row label="Status"><StatusBadge status={draft.status} /></Row>
            <Row label="Last updated">{formatDateTime(draft.updatedAt)}</Row>
            <Row label="Updated by">{draft.updatedBy}</Row>
            <Row label="Published at">{draft.publishedAt ? formatDateTime(draft.publishedAt) : "— not yet published"}</Row>
            <Row label="Published by">{draft.publishedBy ?? "—"}</Row>
          </div>
        )}
      </div>

      <div className="flex flex-none items-center justify-between gap-2 border-t border-line px-5 py-3.5">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <div className="flex items-center gap-2.5">
          <Button variant="secondary" onClick={() => onSaveDraft(draft)}>
            Save Draft
          </Button>
          <Button variant="primary" onClick={() => onPublish(draft)}>
            Publish
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-divider py-2">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-ink">{children}</span>
    </div>
  );
}
