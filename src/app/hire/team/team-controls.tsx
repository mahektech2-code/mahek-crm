"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { addToHire, removeFromHire, searchPeopleForHire } from "@/lib/hire/actions/team";
import { HIRE_ROLES, ROLE_LABEL, type HireRole } from "@/lib/hire/roles";
import { Btn } from "../_ui/kit";

/** Give somebody Hire with their job in it — search any MahekOne account that does not hold it. */
export function AddPerson({ canMakeAdmin }: { canMakeAdmin: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; meta: string }[]>([]);
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const [role, setRole] = useState<HireRole>("interviewer");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    const t = setTimeout(() => void searchPeopleForHire(term).then(setHits), 180);
    return () => clearTimeout(t);
  }, [q]);
  const roles = HIRE_ROLES.filter((r) => r !== "admin" || canMakeAdmin);
  return (
    <div className="mb-5 rounded-[6px] border border-line bg-surface p-4">
      <div className="mb-2 text-[15px] font-semibold text-heading">Add a person</div>
      <div className="flex flex-wrap items-start gap-2">
        <div className="relative w-[340px]">
          <input
            value={pick ? pick.name : q}
            onChange={(e) => {
              setPick(null);
              setQ(e.target.value);
            }}
            placeholder="Search any MahekOne account by name, email or number"
            className="h-9 w-full rounded-[4px] border border-line-strong bg-surface px-3 text-sm text-heading outline-none focus:border-brand"
          />
          {!pick && q.trim().length >= 2 ? (
            <div className="absolute top-10 right-0 left-0 z-20 overflow-hidden rounded-[6px] border border-line bg-surface shadow-[0_8px_24px_rgba(26,30,40,0.12)]">
              {hits.length ? (
                hits.map((h) => (
                  <button key={h.id} onClick={() => setPick({ id: h.id, name: h.name })} className="block w-full cursor-pointer border-0 border-t border-canvas bg-surface px-3 py-2 text-left hover:bg-canvas">
                    <span className="block text-sm font-medium text-heading">{h.name}</span>
                    <span className="block text-[13px] text-muted">{h.meta || "—"}</span>
                  </button>
                ))
              ) : (
                <div className="px-3 py-2.5 text-[13px] text-muted">Nobody without Hire matches.</div>
              )}
            </div>
          ) : null}
        </div>
        <select value={role} onChange={(e) => setRole(e.target.value as HireRole)} className="h-9 rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm">
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <Btn
          kind="primary"
          disabled={!pick || busy}
          onClick={async () => {
            if (!pick) return;
            setBusy(true);
            const r = await addToHire(pick.id, role);
            setBusy(false);
            if (!r.ok) return toast.push(r.error, "error");
            toast.push(r.message ?? "Added.");
            setPick(null);
            setQ("");
            router.refresh();
          }}
        >
          Give Hire
        </Btn>
      </div>
      <div className="mt-2 text-[13px] text-muted">They get the Hire tile on their launcher and a notification. Their role decides what they see.</div>
    </div>
  );
}

export function RemovePerson({ userId, name }: { userId: string; name: string }) {
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <Btn size="sm" kind="ghost" onClick={() => setConfirming(true)}>
        Remove
      </Btn>
    );
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-muted">
      Remove {name}?
      <Btn
        size="sm"
        kind="danger"
        onClick={async () => {
          const r = await removeFromHire(userId);
          setConfirming(false);
          if (!r.ok) return toast.push(r.error, "error");
          toast.push(r.message ?? "Removed.");
          router.refresh();
        }}
      >
        Remove
      </Btn>
      <Btn size="sm" onClick={() => setConfirming(false)}>
        Keep
      </Btn>
    </span>
  );
}
