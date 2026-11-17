"use client";

import * as React from "react";
import { useToast } from "@/components/ui/toast";
import { cx } from "@/components/ui/primitives";
import { testConnection, type TestableProvider } from "@/lib/actions/admin-console";
import { btnClass } from "../_shell/kit";

const Bolt = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
  </svg>
);

/** One cheap read-only request with the stored key; the answer is the provider's. */
export function TestButton({ provider, name, icon = false }: { provider: TestableProvider; name: string; icon?: boolean }) {
  const notify = useToast().push;
  const [state, setState] = React.useState<"idle" | "busy" | "ok" | "bad">("idle");
  const label = state === "busy" ? "Testing…" : state === "ok" ? "Connected" : state === "bad" ? "Failed" : "Test";
  return (
    <button
      type="button"
      disabled={state === "busy"}
      aria-label={`Test the ${name} connection`}
      title={icon ? `Test connection — ${label}` : "Test connection"}
      className={cx(
        icon
          ? "inline-flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-control border border-line-strong bg-surface hover:bg-[#f7f9fc] disabled:opacity-50"
          : btnClass("plain", "sm"),
        state === "ok" ? "text-success" : state === "bad" ? "text-danger" : "text-ink",
      )}
      onClick={async () => {
        setState("busy");
        const r = await testConnection(provider);
        setState(r.ok ? "ok" : "bad");
        notify(r.ok ? `${name}: ${r.message ?? "connected"}` : `${name}: ${r.error}`, r.ok ? "info" : "error");
      }}
    >
      <Bolt />
      {icon ? null : label}
    </button>
  );
}

/** Test every service that has a key and a read-only check, one after another. */
export function TestAll({ providers }: { providers: { provider: TestableProvider; name: string }[] }) {
  const notify = useToast().push;
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      className={cx(btnClass("plain"), "h-[38px]")}
      disabled={busy || providers.length === 0}
      title={providers.length ? `Tests ${providers.map((p) => p.name).join(", ")}` : "No service with a key has a check"}
      onClick={async () => {
        setBusy(true);
        const failed: string[] = [];
        for (const p of providers) {
          const r = await testConnection(p.provider);
          if (!r.ok) failed.push(`${p.name}: ${r.error}`);
        }
        setBusy(false);
        notify(
          failed.length ? `${failed.length} of ${providers.length} failed — ${failed.join(" · ")}` : `All ${providers.length} connected`,
          failed.length ? "error" : "info",
        );
      }}
    >
      {busy ? "Testing…" : "Test all"}
    </button>
  );
}
