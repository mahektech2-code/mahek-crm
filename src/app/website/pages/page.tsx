"use client";

import * as React from "react";
import { PageHeader, Button, Card, Field, Input, Textarea, Td, Tr, Th, SectionLabel, Callout } from "@/components/ui/primitives";
import { Drawer, DrawerHeader, Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { StatusBadge } from "../status-badge";
import { INITIAL_PAGES, ADMIN_USERS, formatDateTime, type WebsitePage } from "../mock-data";

const CURRENT_USER = ADMIN_USERS[0];

export default function PagesPage() {
  const toast = useToast();
  const [pages, setPages] = React.useState<WebsitePage[]>(INITIAL_PAGES);
  const [editing, setEditing] = React.useState<WebsitePage | null>(null);

  function upsert(p: WebsitePage) {
    setPages((prev) => prev.map((x) => (x.key === p.key ? p : x)));
  }

  return (
    <>
      <PageHeader title="Pages" subtitle="Structured content areas for the website's existing pages — not a free-form page builder." />

      <Callout tone="brand">
        Page layout and React structure stay developer-controlled. Only the content fields inside each section below are editable here.
      </Callout>

      <Card className="overflow-x-auto">
        <table className="w-full">
          <thead><Tr><Th>Page</Th><Th>Route</Th><Th>Sections</Th><Th>Status</Th><Th>Updated</Th><Th align="right">Actions</Th></Tr></thead>
          <tbody>
            {pages.map((p) => (
              <Tr key={p.key}>
                <Td className="font-medium text-ink">
                  <button onClick={() => setEditing(p)} className="cursor-pointer hover:text-brand">{p.name}</button>
                </Td>
                <Td className="text-muted">{p.route}</Td>
                <Td>{p.sections.length} sections</Td>
                <Td><StatusBadge status={p.status} /></Td>
                <Td>{formatDateTime(p.updatedAt)} · {p.updatedBy}</Td>
                <Td align="right">
                  <Button variant="secondary" size="sm" onClick={() => setEditing(p)}>Edit</Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </Card>

      {editing ? (
        <PageEditor
          key={editing.key}
          page={editing}
          onClose={() => setEditing(null)}
          onSave={(p, publish) => {
            upsert({ ...p, status: publish ? "published" : p.status, updatedAt: new Date().toISOString(), updatedBy: CURRENT_USER, ...(publish ? { publishedAt: new Date().toISOString(), publishedBy: CURRENT_USER } : {}) });
            toast.push(publish ? `${p.name} published` : "Draft saved");
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function PageEditor({ page, onClose, onSave }: { page: WebsitePage; onClose: () => void; onSave: (p: WebsitePage, publish: boolean) => void }) {
  const [draft, setDraft] = React.useState<WebsitePage>(page);
  const [tab, setTab] = React.useState<string>(draft.sections[0]?.key ?? "seo");

  function setField(sectionKey: string, fieldKey: string, value: string) {
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s) => (s.key === sectionKey ? { ...s, fields: s.fields.map((f) => (f.key === fieldKey ? { ...f, value } : f)) } : s)),
    }));
  }

  const tabs = [...draft.sections.map((s) => ({ key: s.key, label: s.label })), { key: "seo", label: "SEO" }];

  return (
    <Drawer open onClose={onClose} width={680} label="Page editor">
      <DrawerHeader onClose={onClose}>
        <div className="text-lg font-semibold text-ink">{draft.name}</div>
        <div className="mt-0.5 text-[13px] text-muted">{draft.route} · last updated {formatDateTime(draft.updatedAt)} by {draft.updatedBy}</div>
      </DrawerHeader>
      <Tabs value={tab} onChange={setTab} className="flex-none overflow-x-auto px-5" tabs={tabs} />
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {tab === "seo" ? (
          <div className="grid gap-4">
            <Field label="SEO title"><Input value={draft.seo.title} onChange={(e) => setDraft((d) => ({ ...d, seo: { ...d.seo, title: e.target.value } }))} /></Field>
            <Field label="SEO description"><Textarea rows={2} value={draft.seo.description} onChange={(e) => setDraft((d) => ({ ...d, seo: { ...d.seo, description: e.target.value } }))} /></Field>
            <Field label="Canonical URL"><Input value={draft.seo.canonical} onChange={(e) => setDraft((d) => ({ ...d, seo: { ...d.seo, canonical: e.target.value } }))} /></Field>
          </div>
        ) : (
          draft.sections
            .filter((s) => s.key === tab)
            .map((s) => (
              <div key={s.key} className="grid gap-4">
                <SectionLabel>{s.label}</SectionLabel>
                {s.fields.map((f) => (
                  <Field key={f.key} label={f.label}>
                    {f.type === "textarea" ? (
                      <Textarea rows={4} value={f.value} onChange={(e) => setField(s.key, f.key, e.target.value)} />
                    ) : (
                      <Input value={f.value} onChange={(e) => setField(s.key, f.key, e.target.value)} />
                    )}
                  </Field>
                ))}
              </div>
            ))
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
