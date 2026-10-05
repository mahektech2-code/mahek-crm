"use client";

import * as React from "react";
import { PageHeader, Button, Card, CardHeader, Field, Input, Textarea, Checkbox, Th, Td, Tr, Badge, Callout } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { INITIAL_SETTINGS, INITIAL_PRODUCTS, INITIAL_INDUSTRIES, INITIAL_PAGES } from "../mock-data";

export default function SeoPage() {
  const toast = useToast();
  const [global, setGlobal] = React.useState(INITIAL_SETTINGS.seoDefaults);

  const rows = [
    ...INITIAL_PRODUCTS.map((p) => ({ type: "Product", name: p.name, hasOverride: Boolean(p.seo.title), fallback: p.shortDescription, href: "/website/products" })),
    ...INITIAL_INDUSTRIES.map((i) => ({ type: "Industry", name: i.name, hasOverride: Boolean(i.seo.title), fallback: i.shortDescription, href: "/website/industries" })),
    ...INITIAL_PAGES.map((p) => ({ type: "Page", name: p.name, hasOverride: Boolean(p.seo.title), fallback: p.seo.description, href: "/website/pages" })),
  ];

  return (
    <>
      <PageHeader title="SEO" subtitle="Controlled metadata overrides — sitemap, robots and structured data stay developer-controlled." />

      <Callout tone="brand">
        This is not a free-form SEO/page-builder system. Only the fields below are editable here; technical SEO implementation (JSON-LD, canonical generation logic, sitemap/robots behavior) remains in code.
      </Callout>

      <Card className="mb-5">
        <CardHeader title="Global SEO defaults" hint="Used as a fallback when a page/product has no override set" />
        <div className="grid gap-4 p-5">
          <Field label="Site title"><Input value={global.siteTitle} onChange={(e) => setGlobal({ ...global, siteTitle: e.target.value })} /></Field>
          <Field label="Default description"><Textarea rows={2} value={global.defaultDescription} onChange={(e) => setGlobal({ ...global, defaultDescription: e.target.value })} /></Field>
          <Field label="Default OG image" hint="Chosen from the Media Library">
            <Button variant="secondary" size="sm" className="w-fit">Choose image</Button>
          </Field>
          <Checkbox label="Allow search engines to index the site" checked={global.indexable} onChange={() => setGlobal({ ...global, indexable: !global.indexable })} />
          <div>
            <Button variant="primary" onClick={() => toast.push("Global SEO defaults saved")}>Save defaults</Button>
          </div>
        </div>
      </Card>

      <Card className="overflow-x-auto">
        <CardHeader title="Per-content SEO" hint="Current override status across Products, Industries and Pages" />
        <table className="w-full">
          <thead><Tr><Th>Type</Th><Th>Name</Th><Th>Current value</Th><Th>Override status</Th><Th align="right">Manage</Th></Tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <Tr key={i}>
                <Td><Badge tone="muted">{r.type}</Badge></Td>
                <Td className="font-medium text-ink">{r.name}</Td>
                <Td className="max-w-[320px] truncate whitespace-normal text-muted">{r.fallback}</Td>
                <Td>{r.hasOverride ? <Badge tone="success">Custom override</Badge> : <Badge tone="muted">Using fallback/default</Badge>}</Td>
                <Td align="right">
                  <a href={r.href} className="text-[13px] font-medium text-brand hover:text-brand-hover">Edit →</a>
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
