"use client";

import * as React from "react";
import { Button, Card, CardHeader, Field, Input, PageHeader } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { SETTINGS } from "../mock-data";
import { tempFeedback } from "../prototype";
import { emailError, gaIdError, hasErrors, phoneError, required, urlError, type Errors } from "../validation";

type FieldKey = "name" | "phone" | "email" | "facebook" | "instagram" | "gaId";

export default function SettingsPage() {
  const toast = useToast();
  const [form, setForm] = React.useState(SETTINGS);
  const [errors, setErrors] = React.useState<Errors<FieldKey>>({});

  /* A field's message goes as soon as the person starts correcting it. */
  const clear = (key: FieldKey) => setErrors((x) => ({ ...x, [key]: undefined }));

  function save() {
    const found: Errors<FieldKey> = {
      name: required(form.company.name, "Company name"),
      phone: phoneError(form.contact.phone),
      email: emailError(form.contact.email),
      facebook: urlError(form.social.facebook),
      instagram: urlError(form.social.instagram),
      gaId: gaIdError(form.analytics.gaId),
    };
    if (hasErrors(found)) {
      setErrors(found);
      toast.push("Some settings need attention — see the highlighted fields.", "error");
      return;
    }
    setErrors({});
    /* Nothing is stored: the values live in this screen's memory only, and
       a success message without the prototype note would say they were kept. */
    toast.push(tempFeedback("Settings updated on this screen"));
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Settings"
        subtitle="Company, social, contact and analytics settings for the public site."
        actions={<Button variant="primary" onClick={save}>Save</Button>}
      />

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Company" />
          <div className="grid grid-cols-1 gap-3.5 p-5 sm:grid-cols-2">
            <Field label="Name" error={errors.name}>
              <Input
                value={form.company.name}
                aria-invalid={!!errors.name}
                onChange={(e) => {
                  setForm({ ...form, company: { ...form.company, name: e.target.value } });
                  clear("name");
                }}
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
            <Field label="Phone" error={errors.phone}>
              <Input
                value={form.contact.phone}
                aria-invalid={!!errors.phone}
                onChange={(e) => {
                  setForm({ ...form, contact: { ...form.contact, phone: e.target.value } });
                  clear("phone");
                }}
              />
            </Field>
            <Field label="Email" error={errors.email}>
              <Input
                value={form.contact.email}
                aria-invalid={!!errors.email}
                onChange={(e) => {
                  setForm({ ...form, contact: { ...form.contact, email: e.target.value } });
                  clear("email");
                }}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Social" />
          <div className="grid grid-cols-1 gap-3.5 p-5 sm:grid-cols-2">
            <Field label="Facebook" error={errors.facebook}>
              <Input
                value={form.social.facebook}
                aria-invalid={!!errors.facebook}
                onChange={(e) => {
                  setForm({ ...form, social: { ...form.social, facebook: e.target.value } });
                  clear("facebook");
                }}
              />
            </Field>
            <Field label="Instagram" error={errors.instagram}>
              <Input
                value={form.social.instagram}
                aria-invalid={!!errors.instagram}
                onChange={(e) => {
                  setForm({ ...form, social: { ...form.social, instagram: e.target.value } });
                  clear("instagram");
                }}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Analytics" />
          <div className="grid grid-cols-1 gap-3.5 p-5 sm:grid-cols-2">
            <Field label="Google Analytics ID" error={errors.gaId}>
              <Input
                value={form.analytics.gaId}
                aria-invalid={!!errors.gaId}
                onChange={(e) => {
                  setForm({ ...form, analytics: { ...form.analytics, gaId: e.target.value } });
                  clear("gaId");
                }}
              />
            </Field>
          </div>
        </Card>
      </div>
    </div>
  );
}
