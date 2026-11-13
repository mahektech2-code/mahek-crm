"use client";

import { buttonClass } from "@/components/ui/primitives";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { setLockerModules } from "@/lib/actions/locker-admin";
import { C, Pill, nf, useModal, useToast } from "../../_ui/kit";
import { Alert, Block, Cell, GTable, Grid, LList } from "../../_ui/vault-parts";

type Holder = { id: string; name: string; role: string; modules: string[]; active: boolean };
type Mod = { key: string; label: string; group: string; note: string; off: boolean };

export function AccessScreen({ me, holders, people, modules }: { me: string; holders: Holder[]; people: { v: string; l: string }[]; modules: Mod[] }) {
  const router = useRouter();
  const modal = useModal();
  const toast = useToast();
  const [selId, setSel] = useState<string | null>(holders[0]?.id ?? null);
  const sel = holders.find((h) => h.id === selId) ?? null;
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const tabs = sel ? (draft[sel.id] ?? sel.modules) : [];
  const dirty = sel ? JSON.stringify([...tabs].sort()) !== JSON.stringify([...sel.modules].sort()) : false;
  const groups = [...new Set(modules.map((m) => m.group))];
  const setTabs = (next: string[]) => sel && setDraft({ ...draft, [sel.id]: next });
  const save = async (userId: string, mods: string[], why: string) => {
    const r = await setLockerModules(userId, mods, why);
    toast(r.ok ? (mods.length ? "Saved — they have been told" : "Locker taken away") : r.error);
    if (r.ok) {
      setDraft({});
      router.refresh();
    }
    return r;
  };
  const vaultKeys = modules.filter((m) => m.group === "Vault").map((m) => m.key);
  return (
    <div className="flex flex-col gap-4 px-6 pb-12">
      {sel && sel.id === me && !tabs.includes("locker.access") ? <Alert tone="amber" t="You are removing your own Access" m="Once saved you can no longer change access. Another Locker admin will have to restore it." /> : null}
      {sel && sel.role === "admin" ? <Alert tone="grey" t={`${sel.name} holds the Locker as an administrator`} m="An administrator always holds the vault and admin screens, ticked or not. Change their level on the MahekOne Access screen to narrow those." /> : null}
      <Grid cols={2}>
        <Block
          wide
          title="People"
          sub={`${nf(holders.length)} with Locker access · click a person to edit their screens`}
          acts={
            <>
              {sel ? (
                <button
                  type="button"
                  onClick={() =>
                    modal({
                      title: `Copy ${sel.name}’s screens`,
                      fields: [{ k: "to", l: "To", type: "select", req: true, opts: [{ v: "", l: "Choose" }, ...people.filter((p) => p.v !== sel.id)] }],
                      okL: "Copy screens",
                      danger: true,
                      done: async (v) => {
                        const r = await save(v.to, sel.modules, `Copied from ${sel.name}`);
                        if (!r.ok) return r.error;
                      },
                    })
                  }
                  className={buttonClass({ variant: "secondary", size: "sm" })}
                >
                  Copy {sel.name.split(" ")[0]}’s access to…
                </button>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  modal({
                    title: "Add a person to the Locker",
                    sub: "They start with the screens of whoever you copy from, or with the Dashboard and their own work. Tick more after adding.",
                    fields: [
                      { k: "n", l: "Person", type: "select", req: true, opts: [{ v: "", l: "Choose" }, ...people.filter((p) => !holders.some((h) => h.id === p.v))] },
                      { k: "cp", l: "Copy access from", type: "select", opts: [{ v: "", l: "Nobody — Dashboard, My assets and Renewals" }, ...holders.map((h) => ({ v: h.id, l: h.name }))] },
                    ],
                    okL: "Add",
                    done: async (v) => {
                      const from = holders.find((h) => h.id === v.cp);
                      const r = await save(v.n, from ? from.modules : ["locker.dashboard", "locker.myassets", "locker.renewals"], from ? `Copied from ${from.name}` : "Added");
                      if (!r.ok) return r.error;
                      setSel(v.n);
                    },
                  })
                }
                className={buttonClass({ variant: "primary", size: "sm" })}
              >
                Add person
              </button>
            </>
          }
        >
          <GTable
            emptyLine="Nobody holds the Locker yet."
            cols={[["Person", "minmax(200px,1.6fr)"], ["Screens", "100px"], ["Vault", "110px"], ["Sections", "minmax(260px,2.6fr)"]]}
            rows={holders.map((h) => ({
              key: h.id,
              edge: h.id === selId ? C.brand : null,
              bg: h.id === selId ? "var(--color-brand-soft)" : null,
              onClick: () => setSel(h.id),
              cells: [
                <Cell key="a" t={h.name} sub={[h.role === "admin" ? "Administrator" : "", h.active ? "" : "Sign-in disabled"].filter(Boolean).join(" · ") || undefined} />,
                <Cell key="b" t={`${h.modules.length} of ${modules.length}`} />,
                h.modules.some((k) => vaultKeys.includes(k)) ? <Pill key="c" label="Vault" tone="brand" /> : <Pill key="c" label="No vault" tone="muted" />,
                <Cell key="d" t={groups.filter((g) => modules.some((m) => m.group === g && h.modules.includes(m.key))).join(", ")} className="text-[13px]" />,
              ],
            }))}
          />
        </Block>
        {sel ? (
          <Block
            wide
            title={`${sel.name} · ${tabs.length} screens`}
            sub="Changes apply when saved, are recorded in the audit log, and the person is told."
            acts={
              <>
                <button
                  type="button"
                  onClick={() =>
                    modal({
                      title: `Take the Locker away from ${sel.name}?`,
                      sub: "Every screen goes, with its rows. Their assets and logins stay — reassign them under Offboard.",
                      danger: true,
                      fields: [{ k: "w", l: "Why", min: 5 }],
                      okL: "Take it away",
                      done: async (v) => {
                        const r = await save(sel.id, [], v.w);
                        if (!r.ok) return r.error;
                      },
                    })
                  }
                  className={buttonClass({ variant: "secondary", size: "sm" })}
                >
                  Remove from the Locker
                </button>
                <button type="button" disabled={!dirty} onClick={() => save(sel.id, tabs, "")} className={buttonClass({ variant: "primary", size: "sm" })}>
                  Save
                </button>
              </>
            }
          >
            <span />
          </Block>
        ) : null}
        {sel
          ? groups.map((g) => {
              const items = modules.filter((m) => m.group === g);
              const on = items.filter((i) => tabs.includes(i.key)).length;
              const allOn = on === items.length;
              const vault = g === "Vault";
              return (
                <Block
                  key={g}
                  vault={vault}
                  title={vault ? "Vault" : g}
                  sub={`${on} of ${items.length} screens${vault ? " · every screen here shows secrets, masked" : ""}`}
                  acts={
                    <button type="button" onClick={() => setTabs(allOn ? tabs.filter((k) => !items.some((i) => i.key === k)) : [...new Set([...tabs, ...items.map((i) => i.key)])])} className={buttonClass({ variant: "secondary", size: "sm" })}>
                      {allOn ? "Remove all" : "Grant all"}
                    </button>
                  }
                >
                  <LList items={items.map((i) => ({ key: i.key, t: i.label, sub: i.note, check: true, on: tabs.includes(i.key), flip: () => setTabs(tabs.includes(i.key) ? tabs.filter((k) => k !== i.key) : [...tabs, i.key]) }))} />
                </Block>
              );
            })
          : null}
      </Grid>
    </div>
  );
}
