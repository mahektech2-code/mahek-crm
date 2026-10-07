"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { Checkbox, Field, Input, Select } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { addCandidate } from "@/lib/hire/actions/pipeline";
import { Btn, Callout } from "../_ui/kit";
import type { BoardBlueprint, StaffOption } from "./types";

const SOURCES = ["Walk-in", "Referral", "Naukri", "Candidate portal", "WhatsApp enquiry", "Job fair", "Other"];
const LANGUAGES = ["English", "Hindi", "Marathi", "Gujarati"];

/**
 * Adding a candidate by hand. Identity is the PHONE NUMBER — a returning
 * number links to the earlier application instead of creating a second
 * person, and a near-identical name is raised for a person to decide, never
 * merged. Consent and the notice that AI assists evaluation are recorded at
 * this moment, or the candidate is not added.
 */
export function AddCandidate({ blueprints, staff, me, onClose }: { blueprints: BoardBlueprint[]; staff: StaffOption[]; me: { id: string; role: string }; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState({
    fullName: "",
    phone: "",
    email: "",
    blueprintId: blueprints[0]?.id ?? "",
    location: blueprints[0]?.locations[0] ?? "",
    source: "Walk-in",
    referredBy: "",
    preferredLanguage: "English",
    gender: "",
    ageBand: "",
    recruiterId: me.role === "recruiter" ? me.id : "",
    consent: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const bp = blueprints.find((b) => b.id === v.blueprintId);
  const recruiters = staff.filter((s) => ["recruiter", "hr_head", "admin", "hiring_manager"].includes(s.role ?? ""));

  const up = (k: keyof typeof v, val: string | boolean) => {
    setV((x) => ({ ...x, [k]: val }));
    setErrors((e) => ({ ...e, [k]: "" }));
    setFormError(null);
  };

  const submit = () => {
    const e: Record<string, string> = {};
    if (v.fullName.trim().length < 2) e.fullName = "Required";
    if (v.phone.replace(/\D/g, "").length < 10) e.phone = "Enter a 10-digit mobile number";
    if (!v.blueprintId) e.blueprintId = "Required";
    if (!v.consent) e.consent = "Required";
    setErrors(e);
    if (Object.keys(e).length) return;
    start(async () => {
      const r = await addCandidate({
        fullName: v.fullName,
        phone: v.phone,
        email: v.email || undefined,
        blueprintId: v.blueprintId,
        location: v.location || undefined,
        source: v.source,
        referredBy: v.source === "Referral" ? v.referredBy || undefined : undefined,
        sourceDetail: v.source === "Referral" && v.referredBy ? `Referral · ${v.referredBy}` : undefined,
        preferredLanguage: v.preferredLanguage,
        gender: v.gender || undefined,
        ageBand: v.ageBand || undefined,
        recruiterId: v.recruiterId || null,
        consent: v.consent,
      });
      if (!r.ok) {
        const fe: Record<string, string> = {};
        for (const x of r.fieldErrors ?? []) fe[x.field] = x.message;
        setErrors(fe);
        setFormError(r.error);
        return;
      }
      toast.push(r.data.duplicate ? `Added — a possible duplicate is waiting for a decision on ${v.fullName.trim()}’s record.` : (r.message ?? "Candidate added."), "info");
      onClose();
      router.push(`/hire/c/${r.data.applicationId}`);
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={620}
      title="Add a candidate"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={pending} onClick={submit}>
            {pending ? "Adding…" : "Add candidate"}
          </Btn>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label="Full name" error={errors.fullName}>
          <Input value={v.fullName} invalid={Boolean(errors.fullName)} onChange={(e) => up("fullName", e.target.value)} placeholder="As the candidate spells it" />
        </Field>
        <Field label="Mobile number" error={errors.phone} hint="Their identity in Hire — not the name.">
          <Input value={v.phone} invalid={Boolean(errors.phone)} inputMode="tel" onChange={(e) => up("phone", e.target.value)} placeholder="98220 41736" />
        </Field>
        <Field label="Role" error={errors.blueprintId} hint="Candidates enter against a published blueprint version and stay on it.">
          <Select
            value={v.blueprintId}
            onChange={(e) => {
              const b = blueprints.find((x) => x.id === e.target.value);
              setV((x) => ({ ...x, blueprintId: e.target.value, location: b?.locations[0] ?? "" }));
            }}
            className="w-full"
          >
            {blueprints.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title} · v{b.version}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Location">
          <Select value={v.location} onChange={(e) => up("location", e.target.value)} className="w-full">
            <option value="">Not stated</option>
            {(bp?.locations ?? []).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Email" hint="Optional">
          <Input value={v.email} type="email" onChange={(e) => up("email", e.target.value)} />
        </Field>
        <Field label="Preferred language" hint="Messages are drafted in it.">
          <Select value={v.preferredLanguage} onChange={(e) => up("preferredLanguage", e.target.value)} className="w-full">
            {LANGUAGES.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </Select>
        </Field>
        <Field label="Source">
          <Select value={v.source} onChange={(e) => up("source", e.target.value)} className="w-full">
            {SOURCES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
        {v.source === "Referral" ? (
          <Field label="Referred by" hint="Optional">
            <Input value={v.referredBy} onChange={(e) => up("referredBy", e.target.value)} />
          </Field>
        ) : (
          <Field label="Recruiter" hint="Optional — unassigned candidates are visible to every recruiter.">
            <Select value={v.recruiterId} onChange={(e) => up("recruiterId", e.target.value)} className="w-full">
              <option value="">Unassigned</option>
              {recruiters.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <div className="mt-5 rounded-[6px] border border-divider bg-page px-4 py-3">
        <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">For aggregate fairness monitoring only</div>
        <p className="mt-1 mb-3 text-[13px] text-muted">Optional. Never shown beside a score, never sent to a model, and only ever read as group totals on the Fairness screen.</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Gender">
            <Select value={v.gender} onChange={(e) => up("gender", e.target.value)} className="w-full">
              <option value="">Prefer not to say</option>
              <option value="F">Female</option>
              <option value="M">Male</option>
              <option value="X">Another gender</option>
            </Select>
          </Field>
          <Field label="Age band">
            <Select value={v.ageBand} onChange={(e) => up("ageBand", e.target.value)} className="w-full">
              <option value="">Prefer not to say</option>
              {["18–25", "26–35", "36–45", "46+"].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      <div className="mt-5">
        <Checkbox
          checked={v.consent}
          onChange={(e) => up("consent", e.target.checked)}
          label={<span>The candidate consents to Mahek holding their details for this application, and has been told that AI assists evaluation — a person makes every decision.</span>}
        />
        {errors.consent ? <span className="mt-1 block text-[13px] text-danger">Consent and the AI notice must be recorded before a candidate is added.</span> : null}
      </div>
      {formError && !Object.values(errors).some(Boolean) ? (
        <Callout tone="danger" className="mt-4">
          {formError}
        </Callout>
      ) : null}
      {formError && /already has an open application/.test(formError) ? (
        <div className="mt-2 text-[13px]">
          <Link href="/hire/candidates">Find them in Candidates</Link>
        </div>
      ) : null}
    </Modal>
  );
}
