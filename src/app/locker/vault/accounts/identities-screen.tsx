"use client";

import { buttonClass, cx } from "@/components/ui/primitives";
import { useRouter } from "next/navigation";
import { restoreIdentity, retireIdentity, saveIdentity } from "@/lib/actions/locker-vault";
import { openImpactModal } from "../../_ui/impact-modal";
import { C, Pill, nf, useModal, useToast, type ModalField } from "../../_ui/kit";
import { Alert, Block, Cell, GTable, Stats, Yes } from "../../_ui/vault-parts";

export type IdRow = { id: string; email: string; provider: string; kind: string; controlled: boolean; mfa: boolean; recovery: boolean; controlledByName: string | null; controlledById: string | null; score: number; direct: number; ownerName: string | null; ownerId: string | null };

export function IdentitiesScreen({ rows, people, retired = [] }: { rows: IdRow[]; people: { v: string; l: string }[]; retired?: { id: string; email: string; provider: string }[] }) {
  const router = useRouter();
  const modal = useModal();
  const toast = useToast();
  const pers = rows.filter((i) => !i.controlled);
  const edit = (i?: IdRow) => {
    const fields: ModalField[] = [
      { k: "email", l: "Account", req: true, init: i?.email ?? "", ph: "accounts@mahek.com" },
      { k: "provider", l: "Provider", type: "select", req: true, init: i?.provider ?? "Google Workspace", opts: ["Google Workspace", "Google (personal)", "Microsoft 365", "GitHub organisation", "GitHub (personal)", "Apple Developer", "Meta Business", "LinkedIn", "Google Cloud", "AWS", "Other"] },
      { k: "kind", l: "Kind", type: "select", init: i?.kind ?? "organisational", opts: [{ v: "organisational", l: "Organisational" }, { v: "shared", l: "Shared mailbox" }, { v: "personal", l: "Personal" }, { v: "service", l: "Service account" }] },
      { k: "controlled", l: "Company controlled?", type: "select", init: i ? (i.controlled ? "yes" : "no") : "yes", opts: [{ v: "yes", l: "Yes — the company can recover it" }, { v: "no", l: "No — it belongs to a person" }] },
      { k: "byId", l: "Controlled by (for a personal account)", type: "select", init: i?.controlledById ?? "", opts: [{ v: "", l: "Somebody not on the staff (name them below)" }, ...people] },
      { k: "by", l: "Their name, if they are not on the staff", init: i?.controlledById ? "" : (i?.controlledByName ?? "") },
      { k: "mfa", l: "2-step sign-in", type: "select", init: i?.mfa ? "yes" : "no", opts: [{ v: "yes", l: "On" }, { v: "no", l: "Off" }] },
      { k: "recovery", l: "Recovery configured", type: "select", init: i?.recovery ? "yes" : "no", opts: [{ v: "yes", l: "Yes" }, { v: "no", l: "No" }] },
      { k: "owner", l: "Owner", type: "select", init: i?.ownerId ?? "", opts: [{ v: "", l: "Nobody" }, ...people] },
    ];
    modal({
      title: i ? `Edit ${i.email}` : "Add a sign-in account",
      sub: "Other logins sign in through it, reset to it, or are paid by it — the connection map is built from these.",
      vault: true,
      fields,
      okL: "Save",
      done: async (v) => {
        const r = await saveIdentity(i?.id ?? null, { email: v.email, provider: v.provider, kind: v.kind, controlled: v.controlled === "yes", mfa: v.mfa === "yes", recovery: v.recovery === "yes", controlledById: v.byId || null, controlledByName: v.by, ownerId: v.owner || null });
        if (!r.ok) return r.error;
        toast("Saved");
        router.refresh();
      },
    });
  };
  return (
    <div className="flex flex-col gap-5 px-6 pb-12">
      {pers.length ? (
        <Alert tone="red" t={`${pers.length} company ${pers.length === 1 ? "service is" : "services are"} rooted on personal accounts`} m={pers.map((i) => `${i.email} (${i.direct} linked services, ${i.controlledByName ?? "—"})`).join(" · ")}>
          <button type="button" onClick={() => router.push(`/locker/vault/connections?id=${pers[0].id}`)} className={buttonClass({ variant: "danger", size: "sm" })}>
            See what breaks
          </button>
        </Alert>
      ) : null}
      <Stats
        items={[
          { l: "Sign-in accounts", v: nf(rows.length), s: `across ${new Set(rows.map((i) => i.provider)).size} providers` },
          { l: "Personal", v: nf(pers.length), s: "not company controlled", red: pers.length > 0 },
          { l: "Without 2-step sign-in", v: nf(rows.filter((i) => !i.mfa).length), s: "password only", red: rows.some((i) => !i.mfa) },
          { l: "No recovery", v: nf(rows.filter((i) => !i.recovery).length), s: "lockout is permanent" },
        ]}
      />
      <Block
        vault
        title="All sign-in accounts"
        sub="Click a sign-in account to see what relies on it."
        acts={
          <button type="button" onClick={() => edit()} className={buttonClass({ variant: "primary", size: "sm" })}>
            Add account
          </button>
        }
      >
        <GTable
          vault
          emptyLine="No sign-in accounts recorded yet. Add the company's Google, Microsoft and GitHub accounts first — everything else signs in through them."
          cols={[
            ["Account", "minmax(260px,2fr)"],
            ["Type", "120px"],
            ["Controlled", "190px"],
            ["2-step sign-in", "70px"],
            ["Recovery", "90px"],
            ["Linked services", "100px"],
            ["Risk", "70px"],
            ["Owner", "150px"],
            ["", "150px"],
          ]}
          rows={rows.map((i) => ({
            key: i.id,
            edge: !i.controlled ? C.red : null,
            bg: !i.controlled ? "var(--color-danger-soft)" : null,
            href: `/locker/vault/connections?id=${i.id}`,
            cells: [
              <Cell key="a" t={i.email} sub={i.provider} />,
              <Cell key="b" t={i.kind[0].toUpperCase() + i.kind.slice(1)} />,
              i.controlled ? <Pill key="c" label="Company" tone="success" /> : <Pill key="c" label={`Personal · ${i.controlledByName ?? "—"}`} tone="danger" />,
              <Yes key="d" on={i.mfa} />,
              <Yes key="e" on={i.recovery} yes="Set" no="Missing" noTone="amber" />,
              <Cell key="f" t={nf(i.direct)} className="font-semibold text-ink" />,
              <Cell key="g" t={nf(i.score)} className={cx("font-semibold", i.score > 100 ? "text-danger" : "text-ink")} />,
              <Cell key="h" t={i.ownerName ?? "—"} />,
              <span key="i" className="flex gap-1.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    edit(i);
                  }}
                  className={buttonClass({ variant: "secondary", size: "sm" })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  title="Retire this account: kept on the record, out of the lists"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const failed = await openImpactModal(modal, "locker-identity-retire", i.id, (c) => retireIdentity(i.id, c), (m) => {
                      toast(m ?? `${i.email} retired`);
                      router.refresh();
                    });
                    if (failed) toast(failed);
                  }}
                  className={buttonClass({ variant: "secondary", size: "sm" })}
                >
                  Retire
                </button>
              </span>,
            ],
          }))}
        />
      </Block>
      {retired.length ? (
        <Block vault title="Retired sign-in accounts" sub="Kept on the record with their connections. Restore one that is in use again.">
          <GTable
            vault
            emptyLine=""
            cols={[
              ["Account", "minmax(260px,2fr)"],
              ["", "100px"],
            ]}
            rows={retired.map((r) => ({
              key: r.id,
              cells: [
                <Cell key="a" t={r.email} sub={r.provider} />,
                <button
                  key="b"
                  type="button"
                  onClick={async () => {
                    const out = await restoreIdentity(r.id);
                    toast(out.ok ? (out.message ?? `${r.email} restored`) : out.error);
                    if (out.ok) router.refresh();
                  }}
                  className={buttonClass({ variant: "secondary", size: "sm" })}
                >
                  Restore
                </button>,
              ],
            }))}
          />
        </Block>
      ) : null}
    </div>
  );
}
