"use client";

import { useRouter } from "next/navigation";
import { erpSetWorkingGodown } from "@/lib/actions/erp";
import { GodownPicker } from "../_ui/godown-picker";
import { useErpUi } from "../_ui/erp-ui";

export function WorkingLocation({ godowns, working }: { godowns: { id: string; name: string }[]; working: { id: string; name: string } | null }) {
  const ui = useErpUi();
  const router = useRouter();
  if (!godowns.length) return null;
  return (
    <GodownPicker
      value={working?.id ?? ""}
      label={working?.name ?? "Choose a working location"}
      align="left"
      items={godowns.map((g) => ({ v: g.id, l: g.name }))}
      onPick={(id) => {
        if (!id) return;
        void erpSetWorkingGodown(id).then((res) => {
          ui.toast(res.ok ? res.message ?? "Working location changed" : res.error, res.ok ? "info" : "error");
          if (res.ok) router.refresh();
        });
      }}
    />
  );
}
