"use client";

import { erpSetWorkingGodown } from "@/lib/actions/erp";
import { GodownPicker } from "../_ui/godown-picker";
import { useAct } from "../_ui/use-act";

export function WorkingLocation({ godowns, working }: { godowns: { id: string; name: string }[]; working: { id: string; name: string } | null }) {
  const { run } = useAct();
  if (!godowns.length) return null;
  return (
    <GodownPicker
      value={working?.id ?? ""}
      label={working?.name ?? "Choose a working location"}
      align="left"
      items={godowns.map((g) => ({ v: g.id, l: g.name }))}
      onPick={(id) => {
        if (!id) return;
        void run(() => erpSetWorkingGodown(id));
      }}
    />
  );
}
