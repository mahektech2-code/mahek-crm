import { Callout } from "@/components/ui/primitives";
import { hasSecret } from "@/lib/secrets";

/**
 * Shown above every Website screen while the live site is not connected, so
 * nobody believes a publish reached mahekindia.com when it could not have.
 * Nothing is drawn once both secrets are set; whether the site has actually
 * answered is checked on the Dashboard, on demand.
 */
export async function ConnectionNotice() {
  const [read, publish] = await Promise.all([hasSecret("website.cmsReadSecret"), hasSecret("website.cmsPublishSecret")]);
  if (read && publish) return null;
  return (
    <div className="px-6 pt-5">
      <Callout tone="warn" className="mb-0">
        <span role="note" data-testid="connection-notice" className="text-sm text-body">
          <strong className="font-semibold text-ink">The live website is not connected yet.</strong> What you save and publish here is stored in MahekOne but does not reach
          mahekindia.com until the website secrets are set (Admin → Integrations → Website content) and the site is switched on.
        </span>
      </Callout>
    </div>
  );
}
