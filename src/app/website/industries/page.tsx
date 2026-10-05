"use client";

import * as React from "react";
import { PageHeader, Button, Card, Field, Input, Select, Textarea, Th, Td, Tr, EmptyState, Checkbox, Callout } from "@/components/ui/primitives";
import { Drawer, DrawerHeader, ConfirmDialog, Tabs, FilterPills, RowMenu } from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { StatusBadge } from "../status-badge";
import { INITIAL_INDUSTRIES, INITIAL_PRODUCTS, ADMIN_USERS, formatDate, formatDateTime, type WebsiteIndustry, type ContentStatus } from "../mock-data";

const CURRENT_USER = ADMIN_USERS[0];
type StatusFilter = "all" | ContentStatus;

export default function IndustriesPage() {
  const toast = useToast();
  const [industries, setIndustries] = React.useState<WebsiteIndustry[]>(INITIAL_INDUSTRIES);
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState<WebsiteIndustry | null>(null);
  const [isNew, setIsNew] = React.useState(false);
  const [confirmArchive, setConfirmArchive] = React.useState<WebsiteIndustry | null>(null);

  const filtered = industries
    .filter((i) => (statusFilter === "all" ? true : i.status === statusFilter))
    .filter((i) => i.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.displayOrder - b.displayOrder);

  function upsert(i: WebsiteIndustry) {
    setIndustries((prev) => (prev.some((x) => x.id === i.id) ? prev.map((x) => (x.id === i.id ? i : x)) : [...prev, i]));
  }
  function setStatus(i: WebsiteIndustry, status: ContentStatus) {
    upsert({ ...i, status, updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER, ...(status === "published" ? { publishedAt: new Date().toISOString(), publishedBy: CURRENT_USER } : {}) });
  }
  function openNew() {
    setIsNew(true);
    setEditing({
      id: `ind_${Date.now()}`, name: "", slug: "", status: "draft", displayOrder: industries.length + 1,
      shortDescription: "", image: null, productSlugs: [], seo: { title: "", description: "", canonical: "" },
      updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER,
    });
  }

  function move(i: WebsiteIndustry, dir: -1 | 1) {
    const sorted = [...industries].sort((a, b) => a.displayOrder - b.displayOrder);
    const idx = sorted.findIndex((x) => x.id === i.id);
    const swapWith = sorted[idx + dir];
    if (!swapWith) return;
    const a = { ...i, displayOrder: swapWith.displayOrder };
    const b = { ...swapWith, displayOrder: i.displayOrder };
    setIndustries((prev) => prev.map((x) => (x.id === a.id ? a : x.id === b.id ? b : x)));
  }

  return (
    <>
      <PageHeader
        title="Industries"
        subtitle={`${industries.length} industries · ${industries.filter((i) => i.status === "published").length} published`}
        actions={<Button variant="primary" onClick={openNew}><Icon name="plus" size={16} /> Add Industry</Button>}
      />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <FilterPills
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { key: "all", label: "All", count: industries.length },
            { key: "published", label: "Published", count: industries.filter((i) => i.status === "published").length },
            { key: "draft", label: "Draft", count: industries.filter((i) => i.status === "draft").length },
            { key: "archived", label: "Archived", count: industries.filter((i) => i.status === "archived").length },
          ]}
        />
        <Input placeholder="Search industries…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-56" />
      </div>

      <Card className="overflow-x-auto">
        {filtered.length === 0 ? (
          <EmptyState title="No industries match" action={<Button variant="primary" onClick={openNew}>Add Industry</Button>} />
        ) : (
          <table className="w-full">
            <thead><Tr><Th>Industry</Th><Th>Slug</Th><Th>Status</Th><Th align="right">Order</Th><Th>Image</Th><Th>Updated</Th><Th align="right">Actions</Th></Tr></thead>
            <tbody>
              {filtered.map((i) => (
                <Tr key={i.id}>
                  <Td className="whitespace-normal">
                    <button onClick={() => { setIsNew(false); setEditing(i); }} className="cursor-pointer text-left font-medium text-ink hover:text-brand">
                      {i.name}
                    </button>
                  </Td>
                  <Td className="text-muted">/{i.slug}</Td>
                  <Td><StatusBadge status={i.status} /></Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1">
                      {i.displayOrder}
                      <button onClick={() => move(i, -1)} className="cursor-pointer text-muted hover:text-ink" aria-label="Move up">↑</button>
                      <button onClick={() => move(i, 1)} className="cursor-pointer text-muted hover:text-ink" aria-label="Move down">↓</button>
                    </div>
                  </Td>
                  <Td>{i.image ? "Yes" : "—"}</Td>
                  <Td>{formatDate(i.updatedAt)} · {i.updatedBy}</Td>
                  <Td align="right">
                    <RowMenu
                      items={[
                        { label: "Edit", onSelect: () => { setIsNew(false); setEditing(i); } },
                        { label: "Preview", onSelect: () => toast.push(`Preview: /industries/${i.slug} (prototype only)`) },
                        ...(i.status !== "published" ? [{ label: "Publish", onSelect: () => setStatus(i, "published") }] : [{ label: "Unpublish", onSelect: () => setStatus(i, "draft") }]),
                        ...(i.status !== "archived" ? [{ label: "Archive", onSelect: () => setConfirmArchive(i), destructive: true }] : []),
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
        <IndustryEditor
          key={editing.id}
          industry={editing}
          isNew={isNew}
          onClose={() => setEditing(null)}
          onSave={(i, publish) => {
            upsert({ ...i, status: publish ? "published" : i.status, updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER, ...(publish ? { publishedAt: new Date().toISOString(), publishedBy: CURRENT_USER } : {}) });
            toast.push(publish ? `${i.name} published` : "Draft saved");
            setEditing(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmArchive !== null}
        title="Archive this industry?"
        body={<>Archiving removes <strong>{confirmArchive?.name}</strong> from the live site. It is never deleted and can be restored.</>}
        confirmLabel="Archive"
        destructive
        onClose={() => setConfirmArchive(null)}
        onConfirm={() => { if (confirmArchive) setStatus(confirmArchive, "archived"); toast.push("Archived"); }}
      />
    </>
  );
}

function IndustryEditor({ industry, isNew, onClose, onSave }: { industry: WebsiteIndustry; isNew: boolean; onClose: () => void; onSave: (i: WebsiteIndustry, publish: boolean) => void }) {
  const [draft, setDraft] = React.useState<WebsiteIndustry>(industry);
  const [tab, setTab] = React.useState<"basic" | "products" | "seo" | "publishing">("basic");
  function set<K extends keyof WebsiteIndustry>(key: K, value: WebsiteIndustry[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  function toggleProduct(slug: string) {
    set("productSlugs", draft.productSlugs.includes(slug) ? draft.productSlugs.filter((s) => s !== slug) : [...draft.productSlugs, slug]);
  }

  return (
    <Drawer open onClose={onClose} width={640} label="Industry editor">
      <DrawerHeader onClose={onClose}>
        <div className="text-lg font-semibold text-ink">{isNew ? "Add Industry" : draft.name || "Untitled industry"}</div>
        <div className="mt-0.5 text-[13px] text-muted">{isNew ? "New industry · not yet saved" : `Last updated ${formatDateTime(draft.updatedAt)} by ${draft.updatedBy}`}</div>
      </DrawerHeader>
      <Tabs value={tab} onChange={setTab} className="flex-none px-5" tabs={[{ key: "basic", label: "Basic Info" }, { key: "products", label: "Related Products" }, { key: "seo", label: "SEO" }, { key: "publishing", label: "Publishing" }]} />
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {tab === "basic" && (
          <div className="grid gap-4">
            <Field label="Industry name"><Input value={draft.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Slug"><Input value={draft.slug} onChange={(e) => set("slug", e.target.value)} /></Field>
              <Field label="Status">
                <Select value={draft.status} onChange={(e) => set("status", e.target.value as ContentStatus)}>
                  <option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option>
                </Select>
              </Field>
            </div>
            <Field label="Short description"><Textarea rows={3} value={draft.shortDescription} onChange={(e) => set("shortDescription", e.target.value)} /></Field>
            <Field label="Industry image" hint="Chosen from the shared Media Library">
              <Button variant="secondary" size="sm" className="w-fit" onClick={() => set("image", draft.image ?? "placeholder.webp")}>
                <Icon name="plus" size={14} /> {draft.image ? "Replace image" : "Choose image"}
              </Button>
            </Field>
            <Field label="Display order"><Input type="number" value={draft.displayOrder} onChange={(e) => set("displayOrder", Number(e.target.value))} className="w-32" /></Field>
          </div>
        )}
        {tab === "products" && (
          <div>
            <p className="mb-3 text-[13px] text-muted">Select which products this industry&apos;s page should list as relevant.</p>
            <div className="grid gap-1 rounded-[4px] border border-line p-3">
              {INITIAL_PRODUCTS.map((p) => (
                <Checkbox key={p.slug} label={p.name} checked={draft.productSlugs.includes(p.slug)} onChange={() => toggleProduct(p.slug)} />
              ))}
            </div>
          </div>
        )}
        {tab === "seo" && (
          <div className="grid gap-4">
            <Field label="SEO title"><Input value={draft.seo.title} onChange={(e) => set("seo", { ...draft.seo, title: e.target.value })} /></Field>
            <Field label="SEO description"><Textarea rows={2} value={draft.seo.description} onChange={(e) => set("seo", { ...draft.seo, description: e.target.value })} /></Field>
            <Field label="Canonical URL"><Input value={draft.seo.canonical} onChange={(e) => set("seo", { ...draft.seo, canonical: e.target.value })} /></Field>
          </div>
        )}
        {tab === "publishing" && (
          <div className="grid gap-3 text-[13.5px]">
            <Callout tone="brand">Revision history for this record is available via Website Activity (the shared MahekOne audit log).</Callout>
            <div className="flex items-center justify-between border-b border-divider py-2"><span className="text-muted">Status</span><StatusBadge status={draft.status} /></div>
            <div className="flex items-center justify-between border-b border-divider py-2"><span className="text-muted">Published at</span><span className="font-medium text-ink">{draft.publishedAt ? formatDateTime(draft.publishedAt) : "— not yet published"}</span></div>
          </div>
        )}
      </div>
      <div className="flex flex-none items-center justify-between gap-2 border-t border-line px-5 py-3.5">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <div className="flex items-center gap-2.5">
          <Button variant="secondary" onClick={() => onSave(draft, false)}>Save Draft</Button>
          <Button variant="primary" onClick={() => onSave(draft, true)}>Publish</Button>
        </div>
      </div>
    </Drawer>
  );
}
