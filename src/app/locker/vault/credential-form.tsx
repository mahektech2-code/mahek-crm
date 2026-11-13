"use client";

import { useState } from "react";
import { Button, checkboxClass, controlClass, cx } from "@/components/ui/primitives";
import { useRouter } from "next/navigation";
import { createCredential, updateCredential } from "@/lib/actions/locker-vault";
import { CREDENTIAL_KINDS, DEFAULT_FIELDS } from "@/lib/locker/catalogue";
import type { Tier } from "@/lib/locker/engine";
import type { CredentialInput } from "@/lib/locker/vault-core";
import { useToast } from "../_ui/kit";
import { Block, LList } from "../_ui/vault-parts";

export type Opt = { v: string; l: string };
export type IdentOpt = { id: string; email: string; provider: string; controlled: boolean; controlledByName: string | null; deps: number };

type Method = "direct" | "sso" | "api" | "ssh";
const METHOD_AUTH: Record<Method, string> = { direct: "direct", sso: "federated_sso", api: "api_key", ssh: "ssh_key" };
const METHOD_KIND: Record<Method, string> = { direct: "Web login", sso: "Web login", api: "API key", ssh: "SSH key" };
const TIER_HINT: Record<Tier, string> = {
  standard: "Hides after 60s. No reason needed.",
  sensitive: "Password and reason on reveal. Owner notified.",
  restricted: "Two people to reveal. No copy. Management notified.",
};

/* The v4 control, said once for every input and select on this form. */
const field = controlClass({ className: "h-9" });
const area = controlClass({ className: "resize-y py-2 leading-5" });

function F({ l, hint, warn, children }: { l: string; hint?: string; warn?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="ui-field-label mb-1 block text-xs font-medium tracking-label text-muted uppercase">{l}</span>
      {children}
      {hint ? <span className={cx("mt-1 block text-xs", warn ? "font-medium text-danger" : "text-muted")}>{hint}</span> : null}
    </label>
  );
}

export function CredentialForm({
  id,
  initial,
  people,
  identities,
  assets,
}: {
  id?: string;
  initial?: CredentialInput & { fields: string[] };
  people: Opt[];
  identities: IdentOpt[];
  assets: Opt[];
}) {
  const router = useRouter();
  const toast = useToast();
  const editing = !!id;
  const initMethod: Method | null = initial ? (initial.auth === "federated_sso" ? "sso" : initial.auth === "api_key" ? "api" : initial.auth === "ssh_key" ? "ssh" : "direct") : null;
  const [method, setMethod] = useState<Method | null>(initMethod);
  const [v, setV] = useState<CredentialInput>(
    initial ?? {
      title: "",
      kind: "Web login",
      tier: "standard",
      provider: "",
      url: "",
      username: "",
      env: "Production",
      auth: "direct",
      viaIdentityId: null,
      sole: true,
      identityId: null,
      assetId: null,
      ownerId: null,
      backupOwnerId: null,
      mfa: false,
      mfaMethod: "none",
      recoveryEmail: "",
      accessLevel: "",
      rotateEveryDays: null,
      revealers: [],
      notes: "",
      secrets: {},
    },
  );
  const [fields, setFields] = useState<string[]>(initial?.fields ?? ["Password"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const s = <K extends keyof CredentialInput>(k: K, x: CredentialInput[K]) => setV({ ...v, [k]: x });

  if (!method) {
    return (
      <Block vault title="How does this login sign in?" sub="The method decides which fields you fill in.">
        <LList
          items={(
            [
              ["direct", "Direct login", "Username and password typed at the provider"],
              ["sso", "Sign in with Google, Microsoft or GitHub", "You choose which sign-in account it really relies on"],
              ["api", "API key or secret", "A key used by a server, never typed by a person"],
              ["ssh", "SSH key", "Private key and passphrase for a server"],
            ] as [Method, string, string][]
          ).map(([k, t, sub]) => ({
            key: k,
            t,
            sub,
            btn: "Choose",
            btnKind: "v",
            run: () => {
              setMethod(k);
              const kind = METHOD_KIND[k];
              setFields(k === "sso" ? [] : (DEFAULT_FIELDS[kind] ?? ["Password"]));
              setV({ ...v, kind, auth: METHOD_AUTH[k], tier: k === "api" || k === "ssh" ? "sensitive" : "standard" });
            },
          }))}
        />
      </Block>
    );
  }

  const sel = identities.find((i) => i.id === v.viaIdentityId);
  const secretsFilled = fields.some((f) => (v.secrets?.[f] ?? "").length > 0);
  const ok = v.title.trim() && v.ownerId && (method === "sso" ? !!v.viaIdentityId : editing || secretsFilled);
  const forcedRestricted = /^(Banking|Payment card portal)$/.test(v.kind);

  return (
    <Block vault title={{ direct: "Direct login", sso: "Sign in with another account", api: "API key", ssh: "SSH key" }[method]} sub="Non-secret fields are searchable; secret fields are encrypted and hidden.">
      <div className="grid grid-cols-2 gap-3.5 px-5 py-4">
        <F l="Title">
          <input value={v.title} onChange={(e) => s("title", e.target.value)} placeholder="Razorpay Production — API secret" className={field} />
        </F>
        <F l="Type of login">
          <select value={v.kind} onChange={(e) => s("kind", e.target.value)} className={field}>
            {CREDENTIAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </F>
        <F l="Provider">
          <input value={v.provider} onChange={(e) => s("provider", e.target.value)} placeholder="DigitalOcean" className={field} />
        </F>
        <F l="URL or where it is used">
          <input value={v.url} onChange={(e) => s("url", e.target.value)} placeholder="cloud.digitalocean.com" className={field} />
        </F>
        <F l="Level" hint={forcedRestricted ? "Bank and payment logins are always Restricted." : TIER_HINT[v.tier]}>
          <select value={forcedRestricted ? "restricted" : v.tier} disabled={forcedRestricted} onChange={(e) => s("tier", e.target.value as Tier)} className={field}>
            <option value="standard">Standard — SaaS logins, Wi-Fi, non-production</option>
            <option value="sensitive">Sensitive — production keys, cloud, SSH</option>
            <option value="restricted">Restricted — bank, payment gateway, main sign-in accounts</option>
          </select>
        </F>
        <F l="Environment">
          <select value={v.env} onChange={(e) => s("env", e.target.value)} className={field}>
            {["Production", "Staging", "Development", "Shared"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </F>
        {method === "sso" ? (
          <>
            <F
              l="Which account does it sign in with?"
              hint={sel ? (!sel.controlled ? `⚠ ${sel.email} is a personal account controlled by ${sel.controlledByName ?? "somebody"}. Saving this records a finding, not just a login.` : `${sel.email} already has ${sel.deps} linked services. This adds one.`) : "The real question is which account — this is what the connection map is built from."}
              warn={!!sel && !sel.controlled}
            >
              <select value={v.viaIdentityId ?? ""} onChange={(e) => s("viaIdentityId", e.target.value || null)} className={field}>
                <option value="">Choose the account</option>
                {identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.email} · {i.provider}
                    {i.controlled ? "" : " · PERSONAL"}
                  </option>
                ))}
              </select>
            </F>
            <F l="Is this the only way in?">
              <select value={v.sole ? "yes" : "no"} onChange={(e) => s("sole", e.target.value === "yes")} className={field}>
                <option value="yes">Yes — no other admin or login</option>
                <option value="no">No — another admin can get in</option>
              </select>
            </F>
          </>
        ) : (
          <F l={method === "api" ? "Key identifier (not the secret)" : "Username"}>
            <input value={v.username} onChange={(e) => s("username", e.target.value)} className={field} />
          </F>
        )}
        {!editing
          ? fields.map((f, k) => (
              <F key={f + k} l={f} hint={k === 0 ? "Encrypted with its own key the moment you save. Never shown in this form again." : undefined}>
                {/key/i.test(f) && method === "ssh" ? (
                  <textarea value={v.secrets?.[f] ?? ""} onChange={(e) => s("secrets", { ...(v.secrets ?? {}), [f]: e.target.value })} rows={3} autoComplete="off" spellCheck={false} className={cx(area, "font-mono text-xs")} />
                ) : (
                  <input type="password" autoComplete="new-password" value={v.secrets?.[f] ?? ""} onChange={(e) => s("secrets", { ...(v.secrets ?? {}), [f]: e.target.value })} className={field} />
                )}
              </F>
            ))
          : null}
        {!editing ? (
          <F l="Add another secret field" hint="Backup codes, a transaction password, a passphrase — each is revealed separately.">
            <span className="flex gap-2">
              <input id="lk-newfield" placeholder="e.g. Backup codes" className={field} />
              <Button
                onClick={() => {
                  const el = document.getElementById("lk-newfield") as HTMLInputElement | null;
                  const name = el?.value.trim();
                  if (name && !fields.includes(name)) setFields([...fields, name]);
                  if (el) el.value = "";
                }}
              >
                Add
              </Button>
            </span>
          </F>
        ) : null}
        <F l="Recovery email" hint="Whoever controls this inbox controls the login. It becomes a connection if the inbox is a recorded sign-in account.">
          <input value={v.recoveryEmail} onChange={(e) => s("recoveryEmail", e.target.value)} placeholder="admin@mahek.com" className={field} />
        </F>
        <F l="2-step sign-in">
          <select value={v.mfa ? v.mfaMethod || "totp" : "none"} onChange={(e) => setV({ ...v, mfa: e.target.value !== "none", mfaMethod: e.target.value })} className={field}>
            <option value="none">Not enabled</option>
            <option value="totp">Authenticator app</option>
            <option value="sms">SMS</option>
            <option value="email">Email code</option>
            <option value="hardware_key">Hardware key</option>
            <option value="app_push">App push</option>
          </select>
        </F>
        <F l="Owner">
          <select value={v.ownerId ?? ""} onChange={(e) => s("ownerId", e.target.value || null)} className={field}>
            <option value="">Choose</option>
            {people.map((p) => (
              <option key={p.v} value={p.v}>
                {p.l}
              </option>
            ))}
          </select>
        </F>
        <F l="Backup owner">
          <select value={v.backupOwnerId ?? ""} onChange={(e) => s("backupOwnerId", e.target.value || null)} className={field}>
            <option value="">None</option>
            {people.map((p) => (
              <option key={p.v} value={p.v}>
                {p.l}
              </option>
            ))}
          </select>
        </F>
        <F l="Access level" hint="What this login can do there — Administrator, Read only…">
          <input value={v.accessLevel} onChange={(e) => s("accessLevel", e.target.value)} className={field} />
        </F>
        <F l="Change every (days)" hint="Blank uses the level's policy from Admin › Security.">
          <input type="number" min={7} value={v.rotateEveryDays ?? ""} onChange={(e) => s("rotateEveryDays", e.target.value ? Number(e.target.value) : null)} className={field} />
        </F>
        <F l="Linked asset">
          <select value={v.assetId ?? ""} onChange={(e) => s("assetId", e.target.value || null)} className={field}>
            <option value="">None</option>
            {assets.map((a) => (
              <option key={a.v} value={a.v}>
                {a.l}
              </option>
            ))}
          </select>
        </F>
        <F l="This is the login OF a sign-in account" hint="An inbox's own password: losing it loses everything that signs in through that account.">
          <select value={v.identityId ?? ""} onChange={(e) => s("identityId", e.target.value || null)} className={field}>
            <option value="">No</option>
            {identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.email}
              </option>
            ))}
          </select>
        </F>
        {(forcedRestricted ? "restricted" : v.tier) === "restricted" ? (
          <div className="col-span-full">
            <span className="mb-1.5 block text-xs font-medium tracking-label text-muted uppercase">Who may reveal it (named people only, besides the owner)</span>
            <div className="flex flex-wrap gap-2.5">
              {people.map((p) => (
                <label key={p.v} className="flex items-center gap-1.5 rounded-control border border-line px-2 py-1 text-[13px]">
                  <input type="checkbox" checked={v.revealers.includes(p.v)} onChange={() => s("revealers", v.revealers.includes(p.v) ? v.revealers.filter((x) => x !== p.v) : [...v.revealers, p.v])} className={checkboxClass} />
                  {p.l}
                </label>
              ))}
            </div>
            <span className="mt-1 block text-xs text-muted">Even a named person needs a second person with Approvals to approve each reveal.</span>
          </div>
        ) : null}
        <div className="col-span-full">
          <F l="Notes">
            <textarea value={v.notes} onChange={(e) => s("notes", e.target.value)} rows={2} placeholder="Never a password here — notes are not encrypted." className={area} />
          </F>
        </div>
      </div>
      {error ? <div className="px-5 pb-3 text-[13px] text-danger">{error}</div> : null}
      <div className="flex justify-end gap-2.5 border-t border-divider px-5 py-3">
        <Button onClick={() => (editing ? router.back() : setMethod(null))}>Back</Button>
        <Button
          variant="primary"
          disabled={!ok || busy}
          title={ok ? "" : `Title, owner and ${method === "sso" ? "the sign-in account" : "the secret"} are required`}
          onClick={async () => {
            if (!ok || busy) return;
            setBusy(true);
            setError("");
            const payload = { ...v, tier: (forcedRestricted ? "restricted" : v.tier) as Tier, secrets: Object.fromEntries(fields.map((f) => [f, v.secrets?.[f] ?? ""])) };
            const r = editing ? await updateCredential(id!, payload) : await createCredential(payload);
            setBusy(false);
            if (!r.ok) return setError(r.error);
            const reused = !editing && r.data && "reusedWith" in (r.data as object) ? (r.data as { reusedWith: string[] }).reusedWith : [];
            toast(reused.length ? `Saved · this password is also used on ${reused.join(", ")}` : editing ? "Saved" : "Saved · encrypted with its own key");
            router.push(`/locker/vault/${editing ? id : (r.data as { id: string }).id}`);
            router.refresh();
          }}
        >
          {busy ? "Saving…" : "Save login"}
        </Button>
      </div>
    </Block>
  );
}
