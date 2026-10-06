"use client";

import * as React from "react";
import { Button, Card, CardHeader, Field, Input, PageHeader } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { SETTINGS } from "../mock-data";

export default function SettingsPage() {
  const toast = useToast();
  const [form, setForm] = React.useState(SETTINGS);

  return (
    <div className="p-6">
      <PageHeader
        title="Settings"
        subtitle="Company, social, contact and analytics settings for the public site."
        actions={<Button variant="primary" onClick={() => toast.push("Settings saved.")}>Save</Button>}
      />

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Company" />
          <div className="grid grid-cols-1 gap-3.5 p-5 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={form.company.name}
                onChange={(e) => setForm({ ...form, company: { ...form.company, name: e.target.value } })}
              />
            </Field>
            <Field label="Tagline">
              <Input
                value={form.company.tagline}
                onChange={(e) => setForm({ ...form, company: { ...form.company, tagline: e.target.value } })}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Stats" hint="Shown on the homepage." />
          <div className="grid grid-cols-1 gap-3.5 p-5 sm:grid-cols-3">
            <Field label="Years in business">
              <Input
                value={form.stats.yearsInBusiness}
                onChange={(e) => setForm({ ...form, stats: { ...form.stats, yearsInBusiness: e.target.value } })}
              />
            </Field>
            <Field label="Distributors">
              <Input
                value={form.stats.distributors}
                onChange={(e) => setForm({ ...form, stats: { ...form.stats, distributors: e.target.value } })}
              />
            </Field>
            <Field label="States served">
              <Input
                value={form.stats.statesServed}
                onChange={(e) => setForm({ ...form, stats: { ...form.stats, statesServed: e.target.value } })}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Contact" />
          <div className="grid grid-cols-1 gap-3.5 p-5 sm:grid-cols-2">
            <Field label="Phone">
              <Input
                value={form.contact.phone}
                onChange={(e) => setForm({ ...form, contact: { ...form.contact, phone: e.target.value } })}
              />
            </Field>
            <Field label="Email">
              <Input
                value={form.contact.email}
                onChange={(e) => setForm({ ...form, contact: { ...form.contact, email: e.target.value } })}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Social" />
          <div className="grid grid-cols-1 gap-3.5 p-5 sm:grid-cols-2">
            <Field label="Facebook">
              <Input
                value={form.social.facebook}
                onChange={(e) => setForm({ ...form, social: { ...form.social, facebook: e.target.value } })}
              />
            </Field>
            <Field label="Instagram">
              <Input
                value={form.social.instagram}
                onChange={(e) => setForm({ ...form, social: { ...form.social, instagram: e.target.value } })}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Analytics" />
          <div className="grid grid-cols-1 gap-3.5 p-5 sm:grid-cols-2">
            <Field label="Google Analytics ID">
              <Input
                value={form.analytics.gaId}
                onChange={(e) => setForm({ ...form, analytics: { ...form.analytics, gaId: e.target.value } })}
              />
            </Field>
          </div>
        </Card>
      </div>
    </div>
  );
}
