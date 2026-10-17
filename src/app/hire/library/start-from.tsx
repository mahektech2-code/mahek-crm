"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { copyToNewRole } from "@/lib/hire/actions/blueprints";
import { Btn } from "../_ui/kit";

/** "Start a new role from this one" — asks for the new title, then opens the draft. */
export function StartFrom({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) return <Btn size="sm" onClick={() => setOpen(true)}>Start from this</Btn>;
  return (
    <span className="flex items-center gap-1.5">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`New role from ${title}`} className="h-[30px] w-44 rounded-[4px] border border-line-strong px-2 text-[13px] outline-none focus:border-brand" />
      <Btn
        size="sm"
        kind="primary"
        disabled={busy || !name.trim()}
        onClick={async () => {
          setBusy(true);
          const r = await copyToNewRole(id, name);
          setBusy(false);
          if (!r.ok) return toast.push(r.error, "error");
          toast.push(r.message ?? "Started.");
          router.push(`/hire/blueprints/${r.data.id}`);
        }}
      >
        Start
      </Btn>
      <Btn size="sm" kind="ghost" onClick={() => setOpen(false)}>Cancel</Btn>
    </span>
  );
}
