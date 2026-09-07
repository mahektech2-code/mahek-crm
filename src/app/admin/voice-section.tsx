"use client";

import { Callout, Card, CardHeader, Dot } from "@/components/ui/primitives";
import {
  resolveReadiness,
  SARVAM_LANGUAGE_MODEL,
  SARVAM_MAX_SECONDS,
} from "@/lib/voice-readiness";
import { SecretCredentialRow, type SecretMeta, type SecretRow } from "./secret-credential-row";

export type { SecretRow };

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
 * The row itself — the paste box, the reveal, the confirm-and-clear — is
 * `SecretCredentialRow`, shared with `maps-section.tsx`. It used to be written
 * here, with the confirm dialog's wording hardcoded to which of dictation's
 * two keys the row was; a second screen wanting the same behaviour for a key
 * of its own would have meant a second copy that drifted the day one changed.
 * ------------------------------------------------------------------------- */

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

const META: Record<string, SecretMeta> = {
  "sarvam.apiKey": {
    label: "Sarvam",
    env: "SARVAM_API_KEY",
    what: "Hears the speech, and gives back both the original language and the English. Built for Indian languages and for sentences that switch language halfway. Refuses audio over 30 seconds.",
    where: "dashboard.sarvam.ai → API keys",
    removalConsequence:
      "Dictation falls back to whatever the deployment sets, and to OpenAI where that is allowed.",
  },
  "openai.apiKey": {
    label: "OpenAI",
    env: "OPENAI_API_KEY",
    what: "Takes the recordings Sarvam cannot — anything over 30 seconds, and anything it fails on. Also the only thing that can do Tighten and Rewrite, which are a text call.",
    where: "platform.openai.com → API keys",
    removalConsequence: "Tighten and Rewrite disappear from the dictation modal.",
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
            <SecretCredentialRow key={s.name} row={s} meta={META[s.name]} canWrite={data.canWrite} />
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

  /* The same function the route answers from, so this panel cannot describe a
   * deployment the runtime does not agree with. It is pure and has no server
   * imports, which is what lets a client component read it. */
  const ready = resolveReadiness({
    provider: data.provider,
    fallbackToOpenai: data.fallbackToOpenai,
    maxSeconds: data.maxSeconds,
    hasSarvamKey: sarvam,
    hasOpenaiKey: openai,
  });
  const longOnes = data.maxSeconds > SARVAM_MAX_SECONDS;

  const hearing = sarvamFirst
    ? sarvam
      ? longOnes && data.fallbackToOpenai
        ? openai
          ? `Sarvam up to 30s, then OpenAI — recordings run to ${data.maxSeconds}s.`
          : /* This used to say recordings over 30s "will fail", which was true
               and was the bug: the recorder ran to the configured limit and
               the telecaller found out afterwards. The limit is now capped to
               Sarvam's ceiling wherever OpenAI cannot catch the long ones, so
               the setting is overridden rather than disappointed. */
            `Sarvam only — OpenAI has no key to catch the long ones, so recordings stop at 30s rather than the ${data.maxSeconds}s configured.`
        : "Sarvam. Recordings are capped at its 30-second ceiling."
      : openai
        ? /* No Sarvam key. The fallback switch is not consulted here: it
             exists to honour a deliberate Sarvam-only deployment, and there
             is no Sarvam in this one to keep anything inside. */
          "Sarvam is chosen but has no key, so every recording goes to OpenAI. Adding a Sarvam key improves the short ones; nothing breaks without it."
        : "Neither provider has a key — no microphone is drawn anywhere."
    : openai
      ? "OpenAI."
      : "OpenAI is chosen and has no key — no microphone is drawn anywhere. A Sarvam key does not help: it is only reached when Sarvam is the chosen provider.";


  return (
    <Card>
      <CardHeader title="What dictation is wired to" />
      <div className="grid gap-px bg-divider [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
        <Half
          title="Hearing the speech"
          who={sarvamFirst ? "Sarvam, then OpenAI" : "OpenAI"}
          model={sarvamFirst ? data.sarvamModel : data.openaiTranscriptionModel}
          ready={ready.canHear}
          consequence={hearing}
        />
        <Half
          title="Writing the English"
          who={openai ? "OpenAI" : "Sarvam"}
          model={openai ? data.languageModel : SARVAM_LANGUAGE_MODEL}
          ready={ready.canRefine}
          consequence={
            openai
              ? "Renders every note, whichever provider heard it, and powers Tighten and Rewrite."
              : ready.canRefine
                ? "OpenAI has no key, so Sarvam writes the English and powers Tighten and Rewrite. Plainer prose than OpenAI, and the note still gets written."
                : "No key for either, so notes arrive as raw transcription and Tighten and Rewrite are left out of the modal."
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
