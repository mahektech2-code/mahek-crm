"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { setHireRole } from "@/lib/hire/actions/team";
import { HIRE_ROLES, ROLE_LABEL, type HireRole } from "@/lib/hire/roles";

export function RolePicker({ userId, role, fallback, self }: { userId: string; role: string | null; fallback: string; self: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <select
      value={role ?? "default"}
      disabled={busy}
      title={self ? "Changing your own role takes effect on your next page" : undefined}
      onChange={async (e) => {
        setBusy(true);
        const r = await setHireRole(userId, e.target.value as HireRole | "default");
        setBusy(false);
        if (!r.ok) return toast.push(r.error, "error");
        toast.push("Role saved.");
        router.refresh();
      }}
      className="h-[34px] rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm"
    >
      <option value="default">Level default — {fallback}</option>
      {HIRE_ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABEL[r]}
        </option>
      ))}
    </select>
  );
}
