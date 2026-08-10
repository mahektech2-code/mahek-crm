"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Dot,
  Input,
} from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { stamp } from "@/lib/format";
import { clearSecretAction, setSecretAction } from "@/lib/actions/secrets";

/* ---------------------------------------------------------------------------
 * Voice credentials.
 *
 * This screen exists because the alternative is a shell. Dictation needs a key
 * from an outside service, and on a deploy nobody has terminal access to, an
 * environment variable is a door somebody else has to open — the feature stays
 * off until they do, and nothing on any screen says why.
 *
 * What it shows is deliberately almost nothing: which credentials are set,
 * where each came from, its last four characters, and when it changed. A key
 * that has been saved can never be read back out — not by this screen, not by
 * the action behind it, not by anything except the request about to spend it.
 * Replacing one means pasting a new one.
 *
 * Which is exactly why a set key has to LOOK set. The only question this
 * screen is ever asked is "is there a key", and the answer has to survive
 * being read at a glance: a dot, a badge, and a row of bullets ending in the
 * four characters that say WHICH key it is against the provider's dashboard.
 * A row whose loudest element was an empty paste box answered "no" no matter
 * what the small print beside it said.
 *
 * It also says plainly that a saved key is stored in the database as written.
 * A screen that quietly implied otherwise would be worse than the storage.
 * ------------------------------------------------------------------------- */

export type SecretRow = {
  name: string;
  source: "console" | "environment" | "unset";
  last4: string | null;
  updatedAt: string | null;
};

export type VoiceData = {
  secrets: SecretRow[];
  provider: "sarvam" | "openai";
  fallbackToOpenai: boolean;
  sarvamModel: string;
  openaiTranscriptionModel: string;
  languageModel: string;
  maxSeconds: number;
  enabled: boolean;
  canWrite: boolean;
};

export const VOICE_SUBTITLE =
  "The keys dictation calls out with. Which provider hears the speech, and which models are used, are settings — they live under CRM → Voice.";

export const VOICE_TABS = [{ slug: "credentials", label: "Credentials" }];

const META: Record<
  string,
  { label: string; env: string; what: string; where: string }
> = {
  "sarvam.apiKey": {
    label: "Sarvam",
    env: "SARVAM_API_KEY",
    what: "Hears the speech, and gives back both the original language and the English. Built for Indian languages and for sentences that switch language halfway. Refuses audio over 30 seconds.",
    where: "dashboard.sarvam.ai → API keys",
  },
  "openai.apiKey": {
    label: "OpenAI",
    env: "OPENAI_API_KEY",
    what: "Takes the recordings Sarvam cannot — anything over 30 seconds, and anything it fails on. Also the only thing that can do Tighten and Rewrite, which are a text call.",
    where: "platform.openai.com → API keys",
  },
};

export function VoiceSection({ data }: { data: VoiceData }) {
  return (
    <div className="space-y-5">
      <Wiring data={data} />

      <Card>
        <CardHeader title="Credentials" />
        <div className="divide-y divide-divider">
          {data.secrets.map((s) => (
            <SecretRowForm key={s.name} row={s} canWrite={data.canWrite} />
          ))}
        </div>
      </Card>

      <Callout tone="warn">
        A key saved here is stored in this database as written, not encrypted.
        There is nowhere to keep an encryption key that MahekOne can read and a
        database backup cannot — one in the environment would put us back to
        needing shell access, which is the problem this screen exists to solve.
        So: a database dump carries these keys. Prefer a key scoped to what
        dictation actually needs, and rotate it at the provider if a dump ever
        leaves your hands.
      </Callout>
    </div>
  );
}

/* --------------------------------------------------------- what is in force */

function Wiring({ data }: { data: VoiceData }) {
  const set = (n: string) =>
    data.secrets.some((x) => x.name === n && x.source !== "unset");
  const sarvam = set("sarvam.apiKey");
  const openai = set("openai.apiKey");

  const sarvamFirst = data.provider === "sarvam";
  const longOnes = data.maxSeconds > 30;

  const hearing = sarvamFirst
    ? sarvam
      ? longOnes && data.fallbackToOpenai
        ? openai
          ? `Sarvam up to 30s, then OpenAI — recordings run to ${data.maxSeconds}s.`
          : `Sarvam up to 30s. Anything longer has nowhere to go: the fallback is on but OpenAI has no key, so recordings over 30s will fail.`
        : "Sarvam. Recordings are capped at its 30-second ceiling."
      : openai && data.fallbackToOpenai
        ? "Sarvam is chosen but has no key, so every recording falls through to OpenAI."
        : "Sarvam is chosen and has no key — no microphone is drawn anywhere."
    : openai
      ? "OpenAI."
      : "OpenAI is chosen and has no key — no microphone is drawn anywhere.";

  const canHear = sarvamFirst ? sarvam || (openai && data.fallbackToOpenai) : openai;

  return (
    <Card>
      <CardHeader title="What dictation is wired to" />
      <div className="grid gap-px bg-divider [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
        <Half
          title="Hearing the speech"
          who={sarvamFirst ? "Sarvam, then OpenAI" : "OpenAI"}
          model={sarvamFirst ? data.sarvamModel : data.openaiTranscriptionModel}
          ready={canHear}
          consequence={hearing}
        />
        <Half
          title="Tighten and Rewrite"
          who="OpenAI"
          model={data.languageModel}
          ready={openai}
          consequence={
            openai
              ? "Offered in the dictation modal."
              : "Left out of the modal — they are a text call and there is no key for one. Dictation itself still works."
          }
        />
      </div>
      {!data.enabled ? (
        <div className="border-t border-divider px-4 py-3 text-[13px] text-muted">
          Dictation is switched off in CRM → Voice, so no microphone appears
          whatever is set here.
        </div>
      ) : null}
    </Card>
  );
}

function Half({
  title,
  who,
  model,
  ready,
  consequence,
}: {
  title: string;
  who: string;
  model: string;
  ready: boolean;
  consequence: string;
}) {
  return (
    <div className="bg-surface px-4 py-3.5">
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {title}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <Dot tone={ready ? "success" : "danger"} />
        <span className="text-sm font-medium text-ink">{who}</span>
        <span className="truncate font-mono text-[13px] text-muted">{model}</span>
      </div>
      <p className="mt-1.5 text-[13px] text-pretty text-muted">{consequence}</p>
    </div>
  );
}

/* -------------------------------------------------------------- one key row */

function SecretRowForm({ row, canWrite }: { row: SecretRow; canWrite: boolean }) {
  const meta = META[row.name];
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
          <span className="text-sm font-medium text-ink">
            {meta?.label ?? row.name}
          </span>
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
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
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
              <span className="font-sans text-[12px] text-muted">
                hidden by the deployment
              </span>
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
        <p className="mt-2.5 text-[13px] text-muted">
          Only a platform admin can change credentials.
        </p>
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
            Remove it and <span className="font-mono">{meta?.env}</span> on the
            deployment is used instead.
          </>
        ) : row.source === "environment" ? (
          <>A key set here wins over the deployment&rsquo;s.</>
        ) : (
          <>
            Without one here, <span className="font-mono">{meta?.env}</span> on
            the deployment is used instead.
          </>
        )}
      </p>

      <ConfirmDialog
        open={confirming}
        title={`Remove the ${meta?.label ?? row.name} key?`}
        body={
          <>
            It cannot be recovered from here — a saved key is never read back,
            so putting it again means pasting it again.{" "}
            {row.name === "sarvam.apiKey"
              ? "Dictation falls back to whatever the deployment sets, and to OpenAI where that is allowed."
              : "Tighten and Rewrite disappear from the dictation modal."}
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
