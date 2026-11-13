"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { addLink, recordChange, removeLink } from "@/lib/actions/locker-vault";
import { btnStyle, useModal, useToast } from "../../_ui/kit";

export function CredActions({ id, title, provider, fields, canWrite }: { id: string; title: string; provider: string; fields: string[]; canWrite: boolean }) {
  const modal = useModal();
  const toast = useToast();
  const router = useRouter();
  const all = fields.length ? fields : ["Password"];
  return (
    <span style={{ display: "flex", gap: 8, flex: "none" }}>
      <button
        type="button"
        disabled={!canWrite}
        title={canWrite ? "" : "The vault has no key on this deployment"}
        style={btnStyle("s")}
        onClick={() =>
          modal({
            title: "Record a password change",
            sub: `Change it at ${provider || "the provider"} first, then record the new value here. The old value is kept, encrypted, as a previous value.`,
            vault: true,
            fields: [
              ...(all.length > 1 ? [{ k: "f", l: "Which secret", type: "select" as const, req: true, init: all[0], opts: all }] : []),
              { k: "v", l: "New value", type: "password", req: true, hint: "Encrypted the moment you save. Never shown in this form again." },
              { k: "n", l: "What you changed and checked", type: "area", min: 10 },
            ],
            okL: "Save the change",
            done: async (v) => {
              const r = await recordChange(id, v.f || all[0], v.v, v.n);
              if (!r.ok) return r.error;
              toast(r.data.reusedWith.length ? `Change recorded · the new value is also used on ${r.data.reusedWith.join(", ")}` : `Change recorded for ${title}`);
              router.refresh();
            },
          })
        }
      >
        Change
      </button>
      <Link href={`/locker/vault/${id}/edit`} style={btnStyle("s")}>
        Edit
      </Link>
    </span>
  );
}

export function LinkControls(p: { mode: "add"; credentialId: string; identities: { id: string; email: string }[] } | { mode: "remove"; credentialId: string; linkId: string }) {
  const modal = useModal();
  const toast = useToast();
  const router = useRouter();
  if (p.mode === "remove")
    return (
      <button
        type="button"
        title="Remove this connection"
        onClick={async () => {
          const r = await removeLink(p.linkId, p.credentialId);
          if (!r.ok) return toast(r.error);
          router.refresh();
        }}
        style={{ border: "none", background: "transparent", color: "#6B7385", cursor: "pointer", fontSize: 14 }}
      >
        ×
      </button>
    );
  return (
    <button
      type="button"
      style={{ ...btnStyle("g", true), padding: 0, color: "#5B5080" }}
      onClick={() =>
        modal({
          title: "Record a connection",
          sub: "What this login relies on: the account it signs in with, the inbox its password reset goes to, or the account that pays for it.",
          vault: true,
          fields: [
            { k: "i", l: "Sign-in account", type: "select", req: true, opts: [{ v: "", l: "Choose" }, ...p.identities.map((i) => ({ v: i.id, l: i.email }))] },
            { k: "k", l: "How it relies on it", type: "select", req: true, init: "Recovery email", opts: ["Shared sign-in", "Recovery email", "Billing owner"] },
            { k: "s", l: "Is it the only way in?", type: "select", init: "no", opts: [{ v: "no", l: "No — there is another way in" }, { v: "yes", l: "Yes — no other way in" }] },
          ],
          okL: "Save",
          done: async (v) => {
            const r = await addLink(p.credentialId, v.i, v.k, v.s === "yes");
            if (!r.ok) return r.error;
            router.refresh();
          },
        })
      }
    >
      + Record a connection
    </button>
  );
}
