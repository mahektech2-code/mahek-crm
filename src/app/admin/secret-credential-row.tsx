"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Dot, Input } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import { clearSecretAction, setSecretAction } from "@/lib/actions/secrets";

/* ---------------------------------------------------------------------------
 * One row of `app_secrets`, paste box and all.
 *
 * This was written once for dictation's two keys, inside `voice-section.tsx`,
 * with the sentence shown on removal hardcoded to which of those two keys the
 * row was. A second console section wanting the same paste/reveal/clear
 * behaviour for a key of its own — Ola Maps' — would otherwise mean copying
 * the whole form and drifting the day one of the copies changed. `meta` is
 * what makes it generic: every word specific to a credential is a field on
 * it, and the form itself now knows nothing about which key it is showing.
 * ------------------------------------------------------------------------- */

export type SecretRow = {
  name: string;
  source: "console" | "environment" | "unset";
  last4: string | null;
  updatedAt: string | null;
};

export type SecretMeta = {
  label: string;
  env: string;
  what: string;
  where: string;
  /** What is lost by removing it — said plainly, in the confirm dialog. */
  removalConsequence: string;
};

export function SecretCredentialRow({
  row,
  meta,
  canWrite,
}: {
  row: SecretRow;
  meta: SecretMeta | undefined;
  canWrite: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  // A key that is already set does NOT show a paste box until asked for. An
  // empty input is the loudest thing in a row, and it reads as "nothing here"
  // however carefully the line above it says otherwise — which is exactly the
  // wrong answer to the only question this screen is asked: is a key set.
  const held = row.source !== "unset";
  const [editing, setEditing] = React.useState(false);
  const open = editing || !held;

  async function save() {
    setBusy(true);
    try {
      const result = await run(setSecretAction(row.name, value));
      if (result.ok) {
        setValue("");
        setEditing(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const result = await run(clearSecretAction(row.name));
      if (result.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-2">
          <Dot tone={held ? "success" : "danger"} />
          <span className="text-sm font-medium text-ink">{meta?.label ?? row.name}</span>
          <Badge tone={held ? "success" : "danger"}>
            {row.source === "console"
              ? "Set here"
              : row.source === "environment"
                ? "On the deployment"
                : "Not set"}
          </Badge>
        </div>

        {canWrite && held && !editing ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {/* Replacing a key kept here and overriding one the deployment
                  sets are different acts, and the button says which. */}
              {row.source === "console" ? "Replace" : "Set one here"}
            </Button>
            {row.source === "console" ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <p className="mt-1.5 text-[13px] text-pretty text-muted">{meta?.what}</p>

      {/* The key itself, as much of it as anybody may see. A row of dots and
          the last four characters is what makes "a key is stored" legible at a
          glance — and the four characters are enough to tell WHICH key it is
          against the provider's own dashboard, which is the question somebody
          rotating one actually has. */}
      {held ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-[3px] border border-line bg-canvas px-2 py-1 font-mono text-[13px] text-body">
            <span aria-hidden className="tracking-[0.15em] text-muted">
              ••••••••••••
            </span>
            {row.source === "console" && row.last4 ? (
              row.last4
            ) : (
              <span className="font-sans text-[12px] text-muted">hidden by the deployment</span>
            )}
          </span>
          <span className="text-[13px] text-muted">
            {row.source === "console"
              ? row.updatedAt
                ? `Changed ${stamp(new Date(row.updatedAt))}`
                : "Set from this screen"
              : `From ${meta?.env} — this screen cannot show or change it`}
          </span>
        </div>
      ) : null}

      {canWrite ? (
        open ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              /* A saved key is never read back, so there is nothing to prefill
               * and the box is always empty. The placeholder says which. */
              placeholder={held ? "Paste the new key" : "Paste the key"}
              autoComplete="off"
              spellCheck={false}
              className="min-w-[260px] flex-1 font-mono"
            />
            <Button size="sm" disabled={busy || !value.trim()} onClick={save}>
              {busy ? "Saving…" : held ? "Replace" : "Save"}
            </Button>
            {held ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setValue("");
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null
      ) : (
        <p className="mt-2.5 text-[13px] text-muted">Only a platform admin can change credentials.</p>
      )}

      {/* Where to get one, and what happens to the other place it can live.
          Each state gets the sentence that is actually true of it — the row
          used to say "without a key here, the environment is used" even while
          showing a key that was here, which is the sort of line somebody reads
          twice and then stops trusting. */}
      <p className="mt-2.5 text-[13px] text-muted">
        From <span className="font-mono">{meta?.where}</span>.{" "}
        {row.source === "console" ? (
          <>
            Remove it and <span className="font-mono">{meta?.env}</span> on the deployment is used
            instead.
          </>
        ) : row.source === "environment" ? (
          <>A key set here wins over the deployment&rsquo;s.</>
        ) : (
          <>
            Without one here, <span className="font-mono">{meta?.env}</span> on the deployment is used
            instead.
          </>
        )}
      </p>

      <ConfirmDialog
        open={confirming}
        title={`Remove the ${meta?.label ?? row.name} key?`}
        body={
          <>
            It cannot be recovered from here — a saved key is never read back, so putting it again
            means pasting it again. {meta?.removalConsequence}
          </>
        }
        confirmLabel="Remove"
        destructive
        onConfirm={clear}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}
