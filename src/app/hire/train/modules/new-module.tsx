"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createModuleAction } from "@/lib/hire/actions/training";
import { CATEGORY_LABEL, TRAINING_CATEGORIES } from "@/lib/training/types";
import { Btn, Label, Panel } from "../../_ui/kit";
import { inputCls, useRun } from "../_shared";

export function NewModule() {
  const router = useRouter();
  const { pending, run } = useRun();
  const [title, setTitle] = useState("");
  const [key, setKey] = useState("");
  const [category, setCategory] = useState("product");
  const slug = key || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return (
    <Panel title="New module" sub="Starts as a draft with no questions.">
      <div className="flex flex-col gap-3">
        <label>
          <Label className="mb-1.5">Title</Label>
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Product Overview — Nano" />
        </label>
        <label>
          <Label className="mb-1.5">Key</Label>
          <input className={inputCls} value={slug} onChange={(e) => setKey(e.target.value.toLowerCase())} placeholder="product-nano" />
          <span className="mt-1 block text-xs text-muted">Tracks name a module by this. It never changes.</span>
        </label>
        <label>
          <Label className="mb-1.5">Category</Label>
          <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
            {TRAINING_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <Btn
          kind="primary"
          disabled={pending || !title.trim()}
          title={!title.trim() ? "Give it a title first" : undefined}
          onClick={() => run(() => createModuleAction({ key: slug, title, category }), (r) => r.ok && router.push(`/hire/train/modules/${r.data.id}`))}
        >
          Create draft
        </Btn>
      </div>
    </Panel>
  );
}
