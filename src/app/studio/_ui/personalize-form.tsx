"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field, Input, Select, Textarea, checkboxClass, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { makePoster } from "@/lib/actions/studio";
import type { Language } from "@/lib/studio/domain/language";
import { PERSONALIZATION_MAX } from "@/lib/studio/domain/personalization";

/* ---------------------------------------------------------------------------
 * PERSONALISE: the language, the approved wording (or their own), and what
 * this one poster says about the recipient. Nothing typed here touches the
 * CRM record — the notice says so, because somebody correcting a spelling on
 * a poster will otherwise assume they corrected the customer.
 *
 * Preview draws the poster on the server exactly as Make will, so a name that
 * wraps or a message that is too long is seen before anything is stored.
 * ------------------------------------------------------------------------- */

type Wording = { id: string; label: string; text: string };
type Inputs = { hasGreeting: boolean; takesPhone: boolean; takesTypedProduct: boolean; showsProduct: boolean; optionalProduct: boolean };

const OWN = "__own__";

export function PersonalizeForm(props: {
  customerId: string;
  designId: string;
  designPreview: string;
  languages: { code: Language; label: string }[];
  defaultLanguage: Language;
  wordings: Record<string, Wording[]>;
  inputs: Inputs;
  products: { id: string; name: string }[];
  recipient: { contact: string | null; company: string };
  sender: string;
  notice: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [language, setLanguage] = useState<Language>(props.defaultLanguage);
  const options = props.wordings[language] ?? [];
  const [variant, setVariant] = useState<string>(options[0]?.id ?? OWN);
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [phone, setPhone] = useState("");
  const [typedProduct, setTypedProduct] = useState("");
  const [productId, setProductId] = useState<string>(props.products[0]?.id ?? "");
  const [showProduct, setShowProduct] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ text: string; field: string | null } | null>(null);
  const [busy, setBusy] = useState<"preview" | "make" | null>(null);
  const lastUrl = useRef<string | null>(null);

  useEffect(() => () => {
    if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
  }, []);

  const own = variant === OWN;
  const body = () => {
    const personal: Record<string, string> = {};
    if (name.trim()) personal.name = name.trim();
    if (company.trim()) personal.company = company.trim();
    if (own && message.trim()) personal.message = message.trim();
    if (props.inputs.takesPhone && phone.trim()) personal.phone = phone.trim();
    if (props.inputs.takesTypedProduct && typedProduct.trim()) personal.product = typedProduct.trim();
    return {
      customerId: props.customerId,
      templateId: props.designId,
      language,
      variantId: own ? null : variant,
      showProduct: props.inputs.optionalProduct ? showProduct : true,
      productId: props.products.length ? productId : undefined,
      personal,
    };
  };
  const stale = () => {
    setPreview(null);
    setProblem(null);
  };

  async function runPreview() {
    setBusy("preview");
    setProblem(null);
    try {
      const res = await fetch("/api/studio/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; field?: string | null };
        setProblem({ text: j.error ?? "The preview could not be drawn.", field: j.field ?? null });
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
      lastUrl.current = url;
      setPreview(url);
    } catch {
      setProblem({ text: "The server could not be reached. Check your connection and try again.", field: null });
    } finally {
      setBusy(null);
    }
  }

  async function make() {
    setBusy("make");
    const res = await toast.run(makePoster(body()));
    setBusy(null);
    if (res.ok) router.push(`/studio/posters/${res.data.id}`);
    else setProblem({ text: res.error, field: res.fieldErrors?.[0]?.field ?? null });
  }

  const fieldError = (f: string) => (problem?.field === f ? problem.text : null);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
      <Card className="p-3 lg:sticky lg:top-4 lg:self-start">
        <div className="relative overflow-hidden rounded-control bg-canvas">
          {/* eslint-disable-next-line @next/next/no-img-element -- a server-drawn preview or the design's own preview */}
          <img src={preview ?? props.designPreview} alt={preview ? "Preview of this poster" : "The design, with sample text"} className="mx-auto block max-h-[70vh] w-auto" />
          {!preview ? <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-xs font-semibold text-white">Sample text — press Preview to see theirs</span> : null}
        </div>
      </Card>

      <div className="flex flex-col gap-3">
        <Card className="flex flex-col gap-3 p-4">
          {props.languages.length > 1 ? (
            <Field label="Language">
              <Select
                value={language}
                onChange={(e) => {
                  const l = e.target.value as Language;
                  setLanguage(l);
                  setVariant(props.wordings[l]?.[0]?.id ?? OWN);
                  stale();
                }}
              >
                {props.languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {props.inputs.hasGreeting ? (
            <Field label="Greeting" group error={fieldError("message") ?? fieldError("variantId")}>
              <div className="flex flex-col gap-2">
                {options.map((o) => (
                  <label key={o.id} className={cx("flex cursor-pointer gap-2 rounded-control border px-3 py-2", variant === o.id ? "border-brand bg-brand-soft" : "border-line")}>
                    <input
                      type="radio"
                      className={checkboxClass}
                      name="wording"
                      checked={variant === o.id}
                      onChange={() => {
                        setVariant(o.id);
                        stale();
                      }}
                    />
                    <span className="text-sm">
                      <span className="font-medium text-ink">{o.label}</span>
                      <span className="block text-muted">{o.text}</span>
                    </span>
                  </label>
                ))}
                <label className={cx("flex cursor-pointer gap-2 rounded-control border px-3 py-2", own ? "border-brand bg-brand-soft" : "border-line")}>
                  <input
                      type="radio"
                      className={checkboxClass}
                    name="wording"
                    checked={own}
                    onChange={() => {
                      setVariant(OWN);
                      stale();
                    }}
                  />
                  <span className="text-sm font-medium text-ink">Write my own</span>
                </label>
                {own ? (
                  <Textarea
                    rows={3}
                    maxLength={PERSONALIZATION_MAX.message}
                    value={message}
                    placeholder="In English, or in the poster's language. No prices, offers, links or phone numbers."
                    onChange={(e) => {
                      setMessage(e.target.value);
                      stale();
                    }}
                  />
                ) : null}
              </div>
            </Field>
          ) : null}

          {props.inputs.showsProduct && props.products.length ? (
            <Field label="Product" hint="What they buy most, first. Only this poster shows it.">
              <Select
                value={productId}
                onChange={(e) => {
                  setProductId(e.target.value);
                  stale();
                }}
              >
                {props.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value="">No product</option>
              </Select>
            </Field>
          ) : null}
          {props.inputs.optionalProduct && props.products.length ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={showProduct}
                onChange={(e) => {
                  setShowProduct(e.target.checked);
                  stale();
                }}
              />
              Show the product on the poster
            </label>
          ) : null}
        </Card>

        <Card className="flex flex-col gap-3 p-4">
          <div className="text-sm font-semibold text-ink">Only on this poster</div>
          <p className="-mt-2 text-[12.5px] text-muted">{props.notice}</p>
          <Field label="Name" optional error={fieldError("name")}>
            <Input value={name} maxLength={PERSONALIZATION_MAX.name} placeholder={props.recipient.contact ?? props.recipient.company} onChange={(e) => {
              setName(e.target.value);
              stale();
            }} />
          </Field>
          <Field label="Company" optional error={fieldError("company")}>
            <Input value={company} maxLength={PERSONALIZATION_MAX.company} placeholder={props.recipient.company} onChange={(e) => {
              setCompany(e.target.value);
              stale();
            }} />
          </Field>
          {props.inputs.takesPhone ? (
            <Field label="Contact number" optional hint="Printed on the poster. Leave empty to leave it off." error={fieldError("phone")}>
              <Input value={phone} inputMode="tel" maxLength={20} onChange={(e) => {
              setPhone(e.target.value);
              stale();
            }} />
            </Field>
          ) : null}
          {props.inputs.takesTypedProduct ? (
            <Field label="Product name" optional error={fieldError("product")}>
              <Input value={typedProduct} maxLength={PERSONALIZATION_MAX.product} onChange={(e) => {
              setTypedProduct(e.target.value);
              stale();
            }} />
            </Field>
          ) : null}
          <p className="text-[12.5px] text-muted">Signed by you, as {props.sender}.</p>
        </Card>

        {problem && !problem.field ? <p className="text-sm text-danger">{problem.text}</p> : null}
        <div className="flex gap-2">
          <Button onClick={runPreview} disabled={busy !== null}>
            {busy === "preview" ? "Drawing…" : "Preview"}
          </Button>
          <Button variant="primary" onClick={make} disabled={busy !== null || (own && !message.trim() && props.inputs.hasGreeting)}>
            {busy === "make" ? "Making…" : "Make the poster"}
          </Button>
        </div>
      </div>
    </div>
  );
}
