"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { addDays, daysBetween } from "@/lib/format";
import { createAsset, updateAsset, type AssetInput } from "@/lib/actions/locker-assets";
import { CRIT, daysLabel, endFromValidity, validityFromDates, type ValidityUnit } from "@/lib/locker/engine";
import type { TimeModel } from "@/lib/locker/catalogue";
import { BTN_OFF, Btn, C, LBL, btnStyle, fd } from "../_ui/kit";

/* ---------------------------------------------------------------------------
 * ONE FORM FOR A NEW ASSET AND FOR EDITING ONE, shaped by the type's time
 * model (spec §4.3): a document is issued and ends, a subscription renews on
 * a cycle, a lifetime asset never ends (support may), a contract has a notice
 * deadline that is computed and is the date that matters. Validity is typed
 * either way round (§4.4) — a duration fills the end date and an end date
 * fills the duration — and "No expiry" is a choice, never a blank.
 * ------------------------------------------------------------------------- */

export type TypeOpt = { code: string; name: string; category: string; model: TimeModel; validityMonths: number; leadDays: number; graceDays: number; criticality: number; authority: string; fields: { key: string; label: string }[] };
export type PersonOpt = { id: string; name: string; title: string };
export type PmOpt = { id: string; label: string; last4: string; expiresOn: string | null };

export type FormInit = Partial<{
  title: string;
  criticality: number;
  entityId: string;
  siteId: string;
  endDate: string;
  issuedOn: string;
  docNo: string;
  provider: string;
  amountRupees: string;
  billingCycle: string;
  paymentMethodId: string;
  autoRenew: boolean;
  seats: string;
  noticeDays: string;
  conditions: string;
  department: string;
  externalContact: string;
  ownerId: string;
  backupId: string;
  extra: Record<string, string>;
}>;

const inputStyle = (bad?: boolean): CSSProperties => ({ width: "100%", height: 36, padding: "0 10px", border: `1px solid ${bad ? C.red : "#C2C8D2"}`, borderRadius: 4, fontSize: 14, background: "#FFFFFF", color: C.ink });

function Field({ l, hint, hintC, err, children, req }: { l: string; hint?: ReactNode; hintC?: string; err?: string; children: ReactNode; req?: boolean }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ ...LBL, display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span>{l}</span>
        {req ? <span>Required</span> : null}
      </span>
      {children}
      {hint ? <span style={{ display: "block", fontSize: 12, marginTop: 4, color: hintC ?? C.muted, fontWeight: hintC ? 500 : 400 }}>{hint}</span> : null}
      {err ? <span style={{ display: "block", fontSize: 12, marginTop: 4, color: C.red }}>{err}</span> : null}
    </label>
  );
}

export function AssetForm({
  type,
  categoryName,
  people,
  entities,
  sites,
  pms,
  today,
  init,
  assetId,
  onBack,
  onSaved,
}: {
  type: TypeOpt;
  categoryName: string;
  people: PersonOpt[];
  entities: { id: string; name: string }[];
  sites: { id: string; name: string }[];
  pms: PmOpt[];
  today: string;
  init?: FormInit;
  /** Present when editing. */
  assetId?: string;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const m = type.model;
  const [v, setV] = useState<FormInit>(() => ({
    criticality: type.criticality,
    autoRenew: m === "subscription",
    billingCycle: m === "subscription" ? "Annual" : "",
    noticeDays: m === "term_contract" ? String(type.leadDays) : "",
    extra: {},
    ...init,
  }));
  const [validN, setValidN] = useState<string>(() => {
    if (init?.issuedOn && init?.endDate) return String(validityFromDates(init.issuedOn, init.endDate).n);
    return m === "term_contract" ? String(type.validityMonths || 12) : type.validityMonths ? String(type.validityMonths % 12 === 0 ? type.validityMonths / 12 : type.validityMonths) : "";
  });
  const [unit, setUnit] = useState<ValidityUnit>(() => {
    if (init?.issuedOn && init?.endDate) return validityFromDates(init.issuedOn, init.endDate).unit;
    return m === "term_contract" ? "months" : type.validityMonths && type.validityMonths % 12 === 0 ? "years" : "months";
  });
  const [noExpiry, setNoExpiry] = useState<boolean>(m === "perpetual" && !init?.endDate);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [fail, setFail] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof FormInit, x: unknown) => {
    setV({ ...v, [k]: x });
    setErrs({ ...errs, [k]: "" });
  };
  const setExtra = (k: string, x: string) => setV({ ...v, extra: { ...(v.extra ?? {}), [k]: x } });

  /* Either direction: a duration recomputes the end; typing an end recomputes the duration. */
  const recompute = (issued: string | undefined, n: string, u: ValidityUnit) => {
    if (issued && Number(n) > 0) return endFromValidity(issued, Number(n), u);
    return v.endDate;
  };
  const onIssued = (iso: string) => setV({ ...v, issuedOn: iso, endDate: m === "subscription" ? v.endDate : recompute(iso, validN, unit) });
  const onDuration = (n: string, u: ValidityUnit) => {
    setValidN(n);
    setUnit(u);
    setV({ ...v, endDate: recompute(v.issuedOn, n, u) });
  };
  const onEnd = (iso: string) => {
    setV({ ...v, endDate: iso });
    setErrs({ ...errs, endDate: "" });
    if (v.issuedOn && iso && iso >= v.issuedOn) {
      const r = validityFromDates(v.issuedOn, iso);
      setValidN(String(r.n));
      setUnit(r.unit);
    }
  };

  const end = noExpiry ? null : v.endDate || null;
  const left = end ? daysBetween(today, end) : null;
  const notice = Number(v.noticeDays || 0);
  const noticeBy = m === "term_contract" && end ? addDays(end, -notice) : null;
  const pm = pms.find((p) => p.id === v.paymentMethodId);
  const cardFirst = pm?.expiresOn && end && pm.expiresOn < end;
  const crit = Number(v.criticality ?? type.criticality);
  const ownerOk = !!v.ownerId;
  const backupOk = crit < 3 || !!v.backupId;
  const ok = !!v.title?.trim() && ownerOk && backupOk && (m === "perpetual" || !!end);
  const why = !v.title?.trim() ? "Give it a title" : !ownerOk ? "Choose a primary owner" : !backupOk ? "Choose a backup owner" : !end && m !== "perpetual" ? "Enter when it ends" : "";

  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setFail("");
    const input: AssetInput = {
      typeCode: type.code,
      title: v.title ?? "",
      criticality: crit,
      entityId: v.entityId || null,
      siteId: v.siteId || null,
      endDate: end,
      issuedOn: v.issuedOn || null,
      docNo: v.docNo,
      provider: v.provider,
      amountRupees: v.amountRupees ? Number(v.amountRupees) : null,
      billingCycle: v.billingCycle,
      paymentMethodId: v.paymentMethodId || null,
      autoRenew: !!v.autoRenew,
      seats: v.seats ? Number(v.seats) : null,
      noticeDays: m === "term_contract" ? notice : null,
      conditions: v.conditions,
      department: v.department,
      externalContact: v.externalContact,
      ownerId: v.ownerId ?? "",
      backupId: v.backupId || null,
      extra: v.extra,
    };
    const r = assetId ? await updateAsset(assetId, input) : await createAsset(input);
    setBusy(false);
    if (!r.ok) {
      setFail(r.error);
      setErrs(Object.fromEntries((r.fieldErrors ?? []).map((f) => [f.field, f.message])));
      return;
    }
    onSaved(assetId ?? (r.data as { id: string }).id);
  };

  const sel = (k: keyof FormInit, opts: { v: string; l: string }[], bad?: boolean) => (
    <select value={String(v[k] ?? "")} onChange={(e) => set(k, e.target.value)} style={inputStyle(bad)}>
      {opts.map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
    </select>
  );
  const txt = (k: keyof FormInit, ph?: string, type2 = "text") => <input type={type2} value={String(v[k] ?? "")} placeholder={ph} onChange={(e) => set(k, e.target.value)} style={inputStyle(!!errs[k])} />;
  const peopleOpts = (blank: string) => [{ v: "", l: blank }].concat(people.map((p) => ({ v: p.id, l: p.title ? `${p.name} · ${p.title}` : p.name })));
  const durationRow = (label: string) => (
    <Field l={label} hint={end ? `→ ${m === "term_contract" ? "Term ends" : "Expires"} ${fd(end)} · ${daysLabel(left)} ${left != null && left >= 0 ? "remaining" : ""}. Type an end date below instead and the duration fills itself.` : "Enter the start date and the end date computes."} hintC={end ? C.ink : undefined}>
      <span style={{ display: "flex", gap: 8 }}>
        <input type="number" min={1} value={validN} onChange={(e) => onDuration(e.target.value, unit)} style={{ ...inputStyle(), width: 120 }} />
        <select value={unit} onChange={(e) => onDuration(validN, e.target.value as ValidityUnit)} style={{ ...inputStyle(), width: 160 }}>
          <option value="days">days</option>
          <option value="months">months</option>
          <option value="quarters">quarters</option>
          <option value="years">years</option>
        </select>
      </span>
    </Field>
  );

  return (
    <div style={{ background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" }}>
      <div style={{ padding: "12px 20px", borderBottom: `1px solid ${C.line2}` }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{type.name}</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
          {categoryName} · {{ document: "Document", subscription: "Subscription", perpetual: "Lifetime", term_contract: "Contract with notice period" }[m]}
        </div>
      </div>
      <div style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 14 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field l="Title" req err={errs.title}>
            {txt("title", `${type.name} · location`)}
          </Field>
        </div>

        {m === "document" ? (
          <>
            <Field l="Document number">{txt("docNo")}</Field>
            <Field l="Issued by">
              <input value={v.extra?.issued_by ?? ""} placeholder={type.authority} onChange={(e) => setExtra("issued_by", e.target.value)} style={inputStyle()} />
            </Field>
            <Field l="Issued on">
              <input type="date" value={v.issuedOn ?? ""} onChange={(e) => onIssued(e.target.value)} style={inputStyle()} />
            </Field>
            {durationRow("Valid for")}
            <Field l="Or expires on" req hint="Typing an end date fills the duration above." err={errs.endDate}>
              <input type="date" value={v.endDate ?? ""} onChange={(e) => onEnd(e.target.value)} style={inputStyle(!!errs.endDate)} />
            </Field>
            <Field l="Grace period" hint={type.graceDays ? `${type.graceDays} days after expiry — set on the type` : "None — runs out on the end date"}>
              <input disabled value={type.graceDays ? `${type.graceDays} days` : "None"} style={{ ...inputStyle(), background: C.soft, color: C.muted }} />
            </Field>
          </>
        ) : null}

        {m === "subscription" ? (
          <>
            <Field l="Provider">{txt("provider")}</Field>
            <Field l="Started on">
              <input type="date" value={v.issuedOn ?? ""} onChange={(e) => set("issuedOn", e.target.value)} style={inputStyle()} />
            </Field>
            <Field l="Billing cycle">{sel("billingCycle", ["Monthly", "Quarterly", "Half-yearly", "Annual", "Biennial", "Triennial"].map((x) => ({ v: x, l: x })))}</Field>
            <Field l="Current period ends" req err={errs.endDate}>
              <input type="date" value={v.endDate ?? ""} onChange={(e) => set("endDate", e.target.value)} style={inputStyle(!!errs.endDate)} />
            </Field>
            <Field l="Amount · ₹ per cycle, GST extra">{txt("amountRupees", "", "number")}</Field>
            <Field l="Auto-renew">
              <select value={v.autoRenew ? "On" : "Off"} onChange={(e) => set("autoRenew", e.target.value === "On")} style={inputStyle()}>
                <option>On</option>
                <option>Off</option>
              </select>
            </Field>
            <Field l="Payment method" hint={cardFirst ? `⚠ This card expires on ${fd(pm!.expiresOn)}, before the renewal on ${fd(end)}. The charge will fail.` : undefined} hintC={C.amber}>
              {sel("paymentMethodId", [{ v: "", l: "Manual transfer · none on file" }].concat(pms.map((p) => ({ v: p.id, l: `${p.label} ····${p.last4}${p.expiresOn ? ` · expires ${fd(p.expiresOn)}` : ""}` }))))}
            </Field>
            <Field l="Seats">{txt("seats", "", "number")}</Field>
            <Field l="Cancellation deadline">
              <input type="date" value={v.extra?.cancellation_deadline ?? ""} onChange={(e) => setExtra("cancellation_deadline", e.target.value)} style={inputStyle()} />
            </Field>
          </>
        ) : null}

        {m === "perpetual" ? (
          <>
            <Field l="Document number">{txt("docNo")}</Field>
            <Field l="Acquired on">
              <input type="date" value={v.issuedOn ?? ""} onChange={(e) => set("issuedOn", e.target.value)} style={inputStyle()} />
            </Field>
            <Field l="Version">
              <input value={v.extra?.version ?? ""} onChange={(e) => setExtra("version", e.target.value)} style={inputStyle()} />
            </Field>
            <Field l="Seats">{txt("seats", "", "number")}</Field>
            <Field l="Validity" hint="The licence is forever; support is not. Reminders follow the support date where there is one.">
              <select value={noExpiry ? "none" : "support"} onChange={(e) => setNoExpiry(e.target.value === "none")} style={inputStyle()}>
                <option value="none">No expiry</option>
                <option value="support">Support expires on a date</option>
              </select>
            </Field>
            {!noExpiry ? (
              <Field l="Support expires on">
                <input type="date" value={v.endDate ?? ""} onChange={(e) => set("endDate", e.target.value)} style={inputStyle()} />
              </Field>
            ) : null}
          </>
        ) : null}

        {m === "term_contract" ? (
          <>
            <Field l="Other party">{txt("provider", type.authority)}</Field>
            <Field l="Signed on">
              <input type="date" value={v.issuedOn ?? ""} onChange={(e) => onIssued(e.target.value)} style={inputStyle()} />
            </Field>
            {durationRow("Term")}
            <Field l="Or term ends on" req err={errs.endDate}>
              <input type="date" value={v.endDate ?? ""} onChange={(e) => onEnd(e.target.value)} style={inputStyle(!!errs.endDate)} />
            </Field>
            <Field l="Notice period · days">{txt("noticeDays", String(type.leadDays), "number")}</Field>
            <Field
              l="Last day to give notice · computed"
              hint={`This is the date that matters: miss it and the contract renews for another term. Reminders fire on it, not on the expiry${end ? ` (${fd(end)})` : ""}.`}
              hintC={C.redInk}
            >
              <input disabled value={noticeBy ? `${fd(noticeBy)} · ${daysLabel(daysBetween(today, noticeBy))}` : "Enter the term"} style={{ ...inputStyle(), background: C.soft, color: C.ink }} />
            </Field>
          </>
        ) : null}

        {type.fields.map((f) => (
          <Field key={f.key} l={f.label}>
            <input value={v.extra?.[f.key] ?? ""} onChange={(e) => setExtra(f.key, e.target.value)} style={inputStyle()} />
          </Field>
        ))}

        <Field l="Company">{sel("entityId", [{ v: "", l: "Choose a company" }].concat(entities.map((e) => ({ v: e.id, l: e.name }))))}</Field>
        <Field l="Site">{sel("siteId", [{ v: "", l: "Company-wide" }].concat(sites.map((s) => ({ v: s.id, l: s.name }))))}</Field>
        <Field l="Importance" hint={`${type.name} is ${CRIT[type.criticality].label.toLowerCase()} by default.`}>
          {sel("criticality", [4, 3, 2, 1].map((k) => ({ v: String(k), l: CRIT[k].label })))}
        </Field>
        <Field l="Department">{txt("department", "Compliance, Finance, IT…")}</Field>
        <Field l="Primary owner" req hint={!ownerOk ? "An asset cannot be saved without a responsible person." : undefined} hintC={C.red} err={errs.ownerId}>
          {sel("ownerId", peopleOpts("Choose an owner"), !!errs.ownerId)}
        </Field>
        <Field l={`Backup owner${crit >= 3 ? "" : " · optional"}`} req={crit >= 3} hint={crit >= 3 && !v.backupId ? `Every ${CRIT[crit].label.toLowerCase()} asset needs one — if the owner is away, nobody receives the reminder.` : undefined} hintC={C.amber} err={errs.backupId}>
          {sel("backupId", peopleOpts("No backup"), !!errs.backupId)}
        </Field>
        <Field l="External contact" hint="The CA, lawyer, agent or broker who does this renewal.">
          {txt("externalContact")}
        </Field>
        <div style={{ gridColumn: "1 / -1" }}>
          <Field l="Conditions imposed">
            <textarea value={v.conditions ?? ""} onChange={(e) => set("conditions", e.target.value)} rows={3} style={{ width: "100%", padding: "8px 10px", border: "1px solid #C2C8D2", borderRadius: 4, fontSize: 14, lineHeight: "20px" }} />
          </Field>
        </div>
        {fail ? <div style={{ gridColumn: "1 / -1", fontSize: 13, color: C.red }}>{fail}</div> : null}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn onClick={onBack}>Back</Btn>
          <button type="button" title={why} onClick={save} style={ok && !busy ? btnStyle("p") : BTN_OFF}>
            {busy ? "Saving…" : assetId ? "Save changes" : "Save asset"}
          </button>
        </div>
      </div>
    </div>
  );
}
