"use client";

import * as React from "react";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import type { PageBlock } from "@/lib/website-cms/contract";
import type { ItemView } from "@/lib/website-cms/service";
import { DocEditor, docKey } from "./doc-editor";
import { NAVIGATION_FIELDS, SETTINGS_FIELDS, type FieldDef } from "./field-defs";
import { StateBadge } from "./report";

/* ---------------------------------------------------------------------------
 * The three screens built on `DocEditor`: site settings, the menus, and pages.
 * ------------------------------------------------------------------------- */

const NOT_IMPORTED = (what: string) => (
  <Card>
    <EmptyState
      title={`${what} has not been brought in from the website yet`}
      body="Open the Dashboard and use “Import the website's current content”. It copies exactly what the site shows today, as live, and changes nothing for visitors."
    />
  </Card>
);

export function SettingsScreen({ item, canPublish }: { item: ItemView | null; canPublish: boolean }) {
  return (
    <div className="max-w-[900px] p-6">
      <PageHeader title="Settings" subtitle="Company details, the figures quoted across the site, social links and analytics." />
      {item ? <DocEditor key={docKey(item)} kind="settings" item={item} fields={SETTINGS_FIELDS} canPublish={canPublish} what="the site settings" /> : NOT_IMPORTED("The site settings")}
    </div>
  );
}

export function NavigationScreen({ item, canPublish }: { item: ItemView | null; canPublish: boolean }) {
  return (
    <div className="max-w-[900px] p-6">
      <PageHeader title="Navigation" subtitle="The header menu and the footer links. The order here is the order visitors see." />
      {item ? <DocEditor key={docKey(item)} kind="navigation" item={item} fields={NAVIGATION_FIELDS} canPublish={canPublish} what="the menus" /> : NOT_IMPORTED("The menus")}
    </div>
  );
}

/* ------------------------------------------------------------------- pages */

const pretty = (s: string) => s.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The page's blocks as field definitions, grouped by the first part of their key (`hero.title` → Hero). */
function blockFields(blocks: PageBlock[]): FieldDef[] {
  const groups = new Map<string, FieldDef[]>();
  blocks.forEach((b, i) => {
    const section = b.key.includes(".") ? b.key.slice(0, b.key.indexOf(".")) : "General";
    const path = `blocks.${i}.value`;
    const def: FieldDef =
      b.type === "list"
        ? { type: "strings", path, label: b.label, addLabel: "Add item" }
        : b.type === "paragraph"
          ? { type: "textarea", path, label: b.label, rows: 5, counter: 4000 }
          : { type: "text", path, label: b.label, maxLength: 600 };
    groups.set(section, [...(groups.get(section) ?? []), def]);
  });
  return [...groups.entries()].map(([section, fields]) => ({ type: "group", label: pretty(section), fields }));
}

export function PagesScreen({ items, canPublish }: { items: ItemView[]; canPublish: boolean }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const page = items.find((i) => i.id === open) ?? null;
  return (
    <div className="p-6">
      <PageHeader
        title="Pages"
        subtitle="The wording of each page — headings, introductions and sections. The pages themselves belong to the website; only their text is edited here."
      />
      {items.length === 0 ? (
        NOT_IMPORTED("The page wording")
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {items.map((p) => {
            const blocks = ((p.data.blocks as unknown[]) ?? []).length;
            return (
              <button key={p.id} type="button" onClick={() => setOpen(p.id)} className="cursor-pointer text-left">
                <Card className="flex h-full flex-col gap-2 p-4 hover:bg-canvas">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-ink">{p.label}</div>
                      <div className="text-xs text-muted">{String(p.data.path ?? "")}</div>
                    </div>
                    <StateBadge item={p} />
                  </div>
                  <Badge tone="brand" className="w-fit">{blocks} editable {blocks === 1 ? "block" : "blocks"}</Badge>
                </Card>
              </button>
            );
          })}
        </div>
      )}
      <Drawer open={page !== null} onClose={() => setOpen(null)} width={640} label="Edit page wording">
        {page ? (
          <>
            <DrawerHeader onClose={() => setOpen(null)}>{page.label}</DrawerHeader>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <DocEditor
                key={docKey(page)}
                kind="page"
                item={page}
                fields={blockFields((page.data.blocks as PageBlock[]) ?? [])}
                canPublish={canPublish}
                what="this page's wording"
                stacked
              />
            </div>
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
