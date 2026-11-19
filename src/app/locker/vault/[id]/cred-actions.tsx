"use client";

import { buttonClass } from "@/components/ui/primitives";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addLink, recordChange, removeLink, restoreCredential, retireCredential } from "@/lib/actions/locker-vault";
import { openImpactModal } from "../../_ui/impact-modal";
import { useModal, useToast } from "../../_ui/kit";

export function CredActions({ id, title, provider, fields, canWrite, active = true }: { id: string; title: string; provider: string; fields: string[]; canWrite: boolean; active?: boolean }) {
  const modal = useModal();
  const toast = useToast();
  const router = useRouter();
  const all = fields.length ? fields : ["Password"];
  return (
    <span className="flex flex-none gap-2">
      <button
        type="button"
        disabled={!canWrite}
        title={canWrite ? "" : "The vault has no key on this deployment"}
        className={buttonClass({ variant: "secondary" })}
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
      <Link href={`/locker/vault/${id}/edit`} className={buttonClass({ variant: "secondary" })}>
        Edit
      </Link>
      {active ? (
        <button
          type="button"
          className={buttonClass({ variant: "secondary" })}
          onClick={async () => {
            const failed = await openImpactModal(modal, "locker-credential-retire", id, (c) => retireCredential(id, c), (m) => {
              toast(m ?? `${title} retired`);
              router.refresh();
            });
            if (failed) toast(failed);
          }}
        >
          Retire
        </button>
      ) : (
        <button
          type="button"
          className={buttonClass({ variant: "secondary" })}
          onClick={() =>
            modal({
              title: `Restore ${title}?`,
              sub: "It is back in the vault list, the change-due and reuse checks, and can be revealed again under its tier's rules.",
              vault: true,
              okL: "Restore",
              done: async () => {
                const r = await restoreCredential(id);
                if (!r.ok) return r.error;
                toast(r.message ?? `${title} restored`);
                router.refresh();
              },
            })
          }
        >
          Restore
        </button>
      )}
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
        className="cursor-pointer text-sm text-muted hover:text-danger"
      >
        ×
      </button>
    );
  return (
    <button
      type="button"
      className="cursor-pointer text-[13px] font-medium text-brand-hover hover:underline"
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
