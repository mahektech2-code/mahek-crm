import { getConfig } from "@/lib/config/store";
import { secretStatuses } from "@/lib/secrets";
import { OLA_KEY_NAMES, olaPoolStatus } from "@/lib/services/ola-key-service";
import { integrationStatus } from "@/lib/services/admin-platform-service";
import { Card } from "@/components/ui/primitives";
import { AdminPage } from "../_shell/admin-page";
import { SecretCredentialRow } from "../secret-credential-row";
import { requirePlatformAdmin } from "../_shell/context";
import { IntegrationsTab } from "../platform-real";
import { MapsSection } from "../maps-section";
import { VoiceSection } from "../voice-section";

/**
 * Everything MahekOne calls out to, and the keys it calls with — on one page.
 *
 * Credentials were in three places: Voice and Maps each had a section of their
 * own, and Overview → Integrations listed the rest while leaving those two
 * out. "Is everything we pay for connected" is one question, and it now has
 * one answer.
 */
export default async function IntegrationsPage() {
  const ctx = await requirePlatformAdmin();
  const [config, secrets, olaPool, integrations] = await Promise.all([
    getConfig(),
    secretStatuses(),
    olaPoolStatus(),
    integrationStatus(),
  ]);

  /*
   * Statuses only — which credentials exist, from where, and their last four
   * characters. `secretStatuses` cannot return a key, so nothing here can
   * start leaking one onto the page.
   */
  const row = (s: (typeof secrets)[number]) => ({
    name: s.name,
    source: s.source,
    last4: s.last4,
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
  });
  const canWrite = ctx.isPlatformAdmin;

  return (
    <AdminPage
      title="Integrations"
      subtitle="Every outside service MahekOne talks to, whether it is connected, and the keys it uses. Keys are set here so a deploy nobody has shell access to can still be connected."
    >
      <IntegrationsTab data={{ integrations }} />

      <Section id="speech" title="Speech and writing" hint={"The keys dictation calls out with. Which provider hears the speech, and which models are used, are settings — they live under Settings → Voice & AI."}>
        <VoiceSection
          data={{
            secrets: secrets.filter((s) => s.name === "sarvam.apiKey" || s.name === "openai.apiKey").map(row),
            provider: config["voice.transcriptionProvider"],
            fallbackToOpenai: config["voice.fallbackToOpenai"],
            sarvamModel: config["voice.transcriptionModel"],
            openaiTranscriptionModel: config["voice.openaiTranscriptionModel"],
            languageModel: config["voice.languageModel"],
            maxSeconds: config["voice.maxSeconds"],
            enabled: config["voice.enabled"],
            canWrite,
          }}
        />
      </Section>

      <Section
        id="enquiries"
        title="Website enquiries"
        hint="What the website's own backend proves it holds when it forwards a submitted enquiry. Server to server only — it never reaches a browser on either side."
      >
        <Card>
          <div className="divide-y divide-divider">
            {secrets
              .filter((s) => s.name === "enquiries.ingestSecret")
              .map((s) => (
                <SecretCredentialRow
                  key={s.name}
                  row={row(s)}
                  canWrite={canWrite}
                  meta={{
                    label: "Website enquiry secret",
                    env: "ENQUIRY_INGEST_SECRET",
                    what: "Checked on every enquiry the website forwards to /api/public/enquiries. Anything arriving without it is refused.",
                    where: "Make one up — a long random string — and give the same value to whoever runs the website.",
                    removalConsequence: "The website's enquiries stop arriving in Website Enquiries until a new one is set on both sides.",
                  }}
                />
              ))}
          </div>
        </Card>
      </Section>

      <Section
        id="sign-in-codes"
        title="Sign-in codes"
        hint="The key MiniMoth sends one-time sign-in codes with — for the MahekOne web sign-in, the MBOS handset, and password resets. Setting it is what switches codes on."
      >
        <Card>
          <div className="divide-y divide-divider">
            {secrets
              .filter((s) => s.name === "minimoth.apiKey")
              .map((s) => (
                <SecretCredentialRow
                  key={s.name}
                  row={row(s)}
                  canWrite={canWrite}
                  meta={{
                    label: "MiniMoth API key",
                    env: "MINIMOTH_API_KEY",
                    what: "Sends a code to the work number on the account, on WhatsApp first and by SMS when WhatsApp does not deliver. No DLT registration of ours is involved.",
                    where: "app.minimoth.dev → your project → API keys. Use the live key (mm_live_…) here; a test key sends nothing and is ignored in production.",
                    removalConsequence: "Sign-in codes stop being offered on the web and on the handset. Everybody signs in with their password.",
                  }}
                />
              ))}
          </div>
        </Card>
      </Section>

      <Section id="maps" title="Maps" hint={"The key the Live map and Territory's shop map call Ola Maps with — for the streets under both, and for laying a salesman's trail onto the road he actually walked."}>
        <MapsSection
          data={{
            /* All five pool names, in order. The screen decides which to draw —
               an unset slot is not a gap to be filled. */
            secrets: (OLA_KEY_NAMES as readonly string[]).flatMap((name) => secrets.filter((s) => s.name === name)).map(row),
            pool: olaPool.keys.map((k) => ({
              name: k.name,
              position: k.position,
              state: k.state,
              retryAt: k.retryAt ? k.retryAt.toISOString() : null,
              spentAt: k.spentAt ? k.spentAt.toISOString() : null,
            })),
            allKeysSpent: olaPool.allSpent,
            canWrite,
          }}
        />
      </Section>
    </AdminPage>
  );
}

function Section({ id, title, hint, children }: { id: string; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-8 scroll-mt-6">
      <h2 className="text-lg leading-6 font-semibold text-ink">{title}</h2>
      <p className="mt-0.5 mb-4 text-[13px] leading-[18px] text-muted">{hint}</p>
      {children}
    </section>
  );
}
