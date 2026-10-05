"use client";

import * as React from "react";
import { PageHeader, Button, Card, CardHeader, Field, Input, Callout } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { INITIAL_SETTINGS } from "../mock-data";

export default function SettingsPage() {
  const toast = useToast();
  const [settings, setSettings] = React.useState(INITIAL_SETTINGS);

  function save(section: string) {
    toast.push(`${section} saved`);
  }

  return (
    <>
      <PageHeader title="Website Settings" subtitle="Reuses MahekOne's existing settings pattern — key/value configuration, no new architecture." />

      <Callout tone="brand">
        Stored the same way every other MahekOne setting already is (one row per key, with an audit trail) — not a separate Website settings system.
      </Callout>

      <div className="grid gap-4">
        <Card>
          <CardHeader title="Company" action={<Button variant="primary" size="sm" onClick={() => save("Company")}>Save</Button>} />
          <div className="grid grid-cols-2 gap-4 p-5">
            <Field label="Company name"><Input value={settings.company.name} onChange={(e) => setSettings({ ...settings, company: { ...settings.company, name: e.target.value } })} /></Field>
            <Field label="Phone"><Input value={settings.company.phone} onChange={(e) => setSettings({ ...settings, company: { ...settings.company, phone: e.target.value } })} /></Field>
            <Field label="Email"><Input value={settings.company.email} onChange={(e) => setSettings({ ...settings, company: { ...settings.company, email: e.target.value } })} /></Field>
            <Field label="Office address"><Input value={settings.company.officeAddress} onChange={(e) => setSettings({ ...settings, company: { ...settings.company, officeAddress: e.target.value } })} /></Field>
            <Field label="Plant address"><Input value={settings.company.plantAddress} onChange={(e) => setSettings({ ...settings, company: { ...settings.company, plantAddress: e.target.value } })} /></Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Website Statistics" hint="Shown in the homepage stats strip" action={<Button variant="primary" size="sm" onClick={() => save("Statistics")}>Save</Button>} />
          <div className="grid grid-cols-3 gap-4 p-5">
            <Field label="Happy customers"><Input value={settings.stats.happyCustomers} onChange={(e) => setSettings({ ...settings, stats: { ...settings.stats, happyCustomers: e.target.value } })} /></Field>
            <Field label="Production capacity"><Input value={settings.stats.dailyProduction} onChange={(e) => setSettings({ ...settings, stats: { ...settings.stats, dailyProduction: e.target.value } })} /></Field>
            <Field label="States served"><Input value={settings.stats.statesServed} onChange={(e) => setSettings({ ...settings, stats: { ...settings.stats, statesServed: e.target.value } })} /></Field>
            <Field label="Distributor network"><Input value={settings.stats.distributorNetwork} onChange={(e) => setSettings({ ...settings, stats: { ...settings.stats, distributorNetwork: e.target.value } })} /></Field>
            <Field label="Years in business"><Input value={settings.stats.yearsExperience} onChange={(e) => setSettings({ ...settings, stats: { ...settings.stats, yearsExperience: e.target.value } })} /></Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Social" action={<Button variant="primary" size="sm" onClick={() => save("Social links")}>Save</Button>} />
          <div className="grid grid-cols-2 gap-4 p-5">
            <Field label="LinkedIn"><Input placeholder="Not yet set" value={settings.social.linkedin} onChange={(e) => setSettings({ ...settings, social: { ...settings.social, linkedin: e.target.value } })} /></Field>
            <Field label="Facebook"><Input placeholder="Not yet set" value={settings.social.facebook} onChange={(e) => setSettings({ ...settings, social: { ...settings.social, facebook: e.target.value } })} /></Field>
            <Field label="Instagram"><Input placeholder="Not yet set" value={settings.social.instagram} onChange={(e) => setSettings({ ...settings, social: { ...settings.social, instagram: e.target.value } })} /></Field>
            <Field label="YouTube"><Input placeholder="Not yet set" value={settings.social.youtube} onChange={(e) => setSettings({ ...settings, social: { ...settings.social, youtube: e.target.value } })} /></Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Contact" action={<Button variant="primary" size="sm" onClick={() => save("Contact")}>Save</Button>} />
          <div className="grid grid-cols-2 gap-4 p-5">
            <Field label="Phone"><Input value={settings.contact.phone} onChange={(e) => setSettings({ ...settings, contact: { ...settings.contact, phone: e.target.value } })} /></Field>
            <Field label="WhatsApp"><Input value={settings.contact.whatsapp} onChange={(e) => setSettings({ ...settings, contact: { ...settings.contact, whatsapp: e.target.value } })} /></Field>
            <Field label="Email"><Input value={settings.contact.email} onChange={(e) => setSettings({ ...settings, contact: { ...settings.contact, email: e.target.value } })} /></Field>
            <Field label="Business hours"><Input value={settings.contact.workingHours} onChange={(e) => setSettings({ ...settings, contact: { ...settings.contact, workingHours: e.target.value } })} /></Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Analytics" action={<Button variant="primary" size="sm" onClick={() => save("Analytics")}>Save</Button>} />
          <div className="grid grid-cols-2 gap-4 p-5">
            <Field label="Google Analytics measurement ID"><Input value={settings.analytics.gaMeasurementId} onChange={(e) => setSettings({ ...settings, analytics: { ...settings.analytics, gaMeasurementId: e.target.value } })} /></Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Permissions" hint="Represented using MahekOne's existing app/capability conventions — not a separate auth system" />
          <div className="grid gap-2 p-5 text-[13.5px]">
            <PermissionRow label="View Website module" note="Granted the same way every app is — a row in Access, scoped to the app itself." />
            <PermissionRow label="Edit website content" note="Create/update Products, Industries, Pages, Gallery, Testimonials, Milestones" />
            <PermissionRow label="Publish website content" note="Move content from Draft to Published — a separate capability from editing" />
            <PermissionRow label="Manage Media" note="Upload and remove Media Library assets" />
            <PermissionRow label="Manage Navigation" note="High-impact — recommended as its own capability, confirmed before publish" />
            <PermissionRow label="Manage SEO" note="Global defaults and per-content overrides" />
            <PermissionRow label="Manage Settings" note="Company/contact/social/analytics configuration" />
          </div>
        </Card>
      </div>
    </>
  );
}

function PermissionRow({ label, note }: { label: string; note: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-divider py-2 last:border-0">
      <span className="font-medium text-ink">{label}</span>
      <span className="max-w-[420px] text-right text-muted">{note}</span>
    </div>
  );
}
