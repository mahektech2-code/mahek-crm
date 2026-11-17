"use client";

import * as React from "react";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { testConnection, type TestableProvider } from "@/lib/actions/admin-console";

/** One cheap read-only request with the stored key; the answer is the provider's. */
export function TestButton({ provider, name }: { provider: TestableProvider; name: string }) {
  const notify = useToast().push;
  const [state, setState] = React.useState<"idle" | "busy" | "ok" | "bad">("idle");
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={state === "busy"}
      aria-label={`Test the ${name} connection`}
      title="Test connection"
      onClick={async () => {
        setState("busy");
        const r = await testConnection(provider);
        setState(r.ok ? "ok" : "bad");
        notify(r.ok ? `${name}: ${r.message ?? "connected"}` : `${name}: ${r.error}`, r.ok ? "info" : "error");
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
      </svg>
      {state === "busy" ? "Testing…" : state === "ok" ? "Connected" : state === "bad" ? "Failed" : "Test"}
    </Button>
  );
}
