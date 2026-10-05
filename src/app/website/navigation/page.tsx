"use client";

import * as React from "react";
import { PageHeader, Button, Card, CardHeader, Field, Input, Checkbox, Callout } from "@/components/ui/primitives";
import { Drawer, DrawerHeader, ConfirmDialog } from "@/components/ui/overlays";
import { Icon } from "@/components/shell/icons";
import { useToast } from "@/components/ui/toast";
import { INITIAL_NAV, type NavItem } from "../mock-data";

const GROUPS: { key: NavItem["group"]; label: string; hint: string }[] = [
  { key: "header", label: "Header", hint: "Main site navigation, shown on every page" },
  { key: "footer-company", label: "Footer — Company", hint: "" },
  { key: "footer-quick", label: "Footer — Quick Links", hint: "" },
  { key: "footer-legal", label: "Footer — Legal", hint: "" },
  { key: "manufacturing-mega", label: "Manufacturing Mega Menu", hint: "" },
];

export default function NavigationPage() {
  const toast = useToast();
  const [saved, setSaved] = React.useState<NavItem[]>(INITIAL_NAV);
  const [draft, setDraft] = React.useState<NavItem[]>(INITIAL_NAV);
  const [editing, setEditing] = React.useState<NavItem | null>(null);
  const [confirmPublish, setConfirmPublish] = React.useState(false);

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);

  function update(item: NavItem) {
    setDraft((prev) => (prev.some((x) => x.id === item.id) ? prev.map((x) => (x.id === item.id ? item : x)) : [...prev, item]));
  }
  function move(item: NavItem, dir: -1 | 1) {
    const siblings = draft.filter((x) => x.group === item.group).sort((a, b) => a.displayOrder - b.displayOrder);
    const idx = siblings.findIndex((x) => x.id === item.id);
    const swap = siblings[idx + dir];
    if (!swap) return;
    setDraft((prev) => prev.map((x) => (x.id === item.id ? { ...x, displayOrder: swap.displayOrder } : x.id === swap.id ? { ...x, displayOrder: item.displayOrder } : x)));
  }

  return (
    <>
      <PageHeader
        title="Navigation"
        subtitle="High-impact — changes here affect every page of the live website immediately after publish."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" disabled={!dirty} onClick={() => { setDraft(saved); toast.push("Changes reset"); }}>Reset changes</Button>
            <Button variant="primary" disabled={!dirty} onClick={() => setConfirmPublish(true)}>Save changes</Button>
          </div>
        }
      />

      {dirty ? (
        <Callout tone="warn">You have unpublished navigation changes. Nothing below is live until you Save changes.</Callout>
      ) : null}

      <div className="grid gap-4">
        {GROUPS.map((g) => {
          const items = draft.filter((x) => x.group === g.key).sort((a, b) => a.displayOrder - b.displayOrder);
          return (
            <Card key={g.key}>
              <CardHeader title={g.label} hint={g.hint || undefined} action={<Button variant="secondary" size="sm" onClick={() => setEditing({ id: `n_${Date.now()}`, group: g.key, label: "", href: "", displayOrder: items.length + 1, visible: true })}><Icon name="plus" size={14} /> Add item</Button>} />
              <div className="divide-y divide-divider">
                {items.length === 0 ? (
                  <div className="px-5 py-4 text-[13px] text-muted">No items in this group.</div>
                ) : (
                  items.map((item, i) => (
                    <div key={item.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <button onClick={() => move(item, -1)} disabled={i === 0} className="cursor-pointer text-muted disabled:opacity-30">↑</button>
                        <button onClick={() => move(item, 1)} disabled={i === items.length - 1} className="cursor-pointer text-muted disabled:opacity-30">↓</button>
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-ink">{item.label}</span>
                        <span className="ml-2 text-[13px] text-muted">{item.href}</span>
                        {!item.visible ? <span className="ml-2 rounded-[3px] bg-divider px-1.5 py-0.5 text-[11px] text-muted">Hidden</span> : null}
                      </div>
                      <div className="flex flex-none items-center gap-1.5">
                        <Checkbox label="Visible" checked={item.visible} onChange={() => update({ ...item, visible: !item.visible })} />
                        <Button variant="secondary" size="sm" onClick={() => setEditing(item)}>Edit</Button>
                        <Button variant="ghost" size="sm" onClick={() => setDraft((prev) => prev.filter((x) => x.id !== item.id))}>Remove</Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {editing ? (
        <Drawer open onClose={() => setEditing(null)} label="Nav item editor">
          <DrawerHeader onClose={() => setEditing(null)}><div className="text-lg font-semibold text-ink">{editing.label || "New nav item"}</div></DrawerHeader>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            <div className="grid gap-4">
              <Field label="Label"><Input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} /></Field>
              <Field label="Link (href)" hint="Internal path (e.g. /products) or full external URL"><Input value={editing.href} onChange={(e) => setEditing({ ...editing, href: e.target.value })} /></Field>
              <Checkbox label="Visible on the live site" checked={editing.visible} onChange={() => setEditing({ ...editing, visible: !editing.visible })} />
            </div>
          </div>
          <div className="flex flex-none items-center justify-end gap-2.5 border-t border-line px-5 py-3.5">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { update(editing); setEditing(null); }}>Save to draft</Button>
          </div>
        </Drawer>
      ) : null}

      <ConfirmDialog
        open={confirmPublish}
        title="Publish navigation changes?"
        body="This updates the header, footer and mega-menu on the live public website immediately for every visitor. Double-check labels and links before confirming."
        confirmLabel="Publish changes"
        destructive
        onClose={() => setConfirmPublish(false)}
        onConfirm={() => { setSaved(draft); toast.push("Navigation published"); }}
      />
    </>
  );
}
