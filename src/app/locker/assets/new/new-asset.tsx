"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CATEGORIES, CATEGORY } from "@/lib/locker/catalogue";
import { Btn, CritPill, PageHead } from "../../_ui/kit";
import { ListBlock } from "../../_ui/register-parts";
import { AssetForm, type PersonOpt, type PmOpt, type TypeOpt } from "../asset-form";

const MODEL_LINE = {
  document: "Document · issue and end dates",
  subscription: "Subscription · billing cycle and auto-renew",
  perpetual: "Lifetime · never ends",
  term_contract: "Contract with notice period · last day to give notice",
} as const;

export function NewAsset(props: { types: TypeOpt[]; cats: string[]; initialCat: string | null; people: PersonOpt[]; entities: { id: string; name: string }[]; sites: { id: string; name: string }[]; pms: PmOpt[]; today: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"cat" | "type" | "form">(props.initialCat ? "type" : "cat");
  const [cat, setCat] = useState<string | null>(props.initialCat);
  const [type, setType] = useState<TypeOpt | null>(null);
  const steps: [typeof step, string][] = [
    ["cat", "1 · Category"],
    ["type", "2 · Type"],
    ["form", "3 · Details"],
  ];
  const sub = steps.map((x) => (x[0] === step ? "● " : "") + x[1]).join("   ·   ");
  return (
    <>
      <PageHead crumb="Locker · Register" title="Add asset" sub={sub} />
      <div className="flex flex-col gap-5 px-6 pb-12">
        {step === "cat" ? (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            <ListBlock
              title="Choose a category"
              sub="The category decides who sees it and which types it offers."
              items={CATEGORIES.filter((c) => props.cats.includes(c.slug)).map((c) => ({
                t: c.name,
                sub: props.types.filter((t) => t.category === c.slug).map((t) => t.name).slice(0, 4).join(" · "),
                action: (
                  <Btn
                    kind="p"
                    small
                    onClick={() => {
                      setCat(c.slug);
                      setStep("type");
                    }}
                  >
                    Choose
                  </Btn>
                ),
              }))}
            />
          </div>
        ) : null}
        {step === "type" && cat ? (
          <ListBlock
            title={`${CATEGORY[cat]?.name} · choose a type`}
            sub="The type sets the time model, and the form changes shape."
            items={props.types
              .filter((t) => t.category === cat)
              .map((t) => ({
                t: t.name,
                sub: `${MODEL_LINE[t.model]} · time needed ${t.leadDays} days`,
                badge: <CritPill crit={t.criticality} />,
                action: (
                  <Btn
                    kind="p"
                    small
                    onClick={() => {
                      setType(t);
                      setStep("form");
                    }}
                  >
                    Choose
                  </Btn>
                ),
              }))
              .concat([{ t: "← Back to categories", sub: "", badge: <span />, action: <Btn small onClick={() => setStep("cat")}>Back</Btn> }])}
            emptyLine="No types in this category yet. A Locker admin adds them under Admin › Types."
          />
        ) : null}
        {step === "form" && type && cat ? (
          <AssetForm
            key={type.code}
            type={type}
            categoryName={CATEGORY[cat]?.name ?? cat}
            people={props.people}
            entities={props.entities}
            sites={props.sites}
            pms={props.pms}
            today={props.today}
            onBack={() => setStep("type")}
            onSaved={(id) => router.push(`/locker/assets/${id}`)}
          />
        ) : null}
        <div className="text-xs text-muted">Every asset is saved with a named owner and starts its reminder schedule the moment it is saved.</div>
      </div>
    </>
  );
}
