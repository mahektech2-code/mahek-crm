import { ADMIN } from "@/lib/admin-routes";
import { getConfig } from "@/lib/config/store";
import { securityFigures } from "@/lib/services/admin-security-view-service";
import { otpAvailability } from "@/lib/services/otp-service";
import { AdminPage } from "../_shell/admin-page";
import type { TabItem } from "../_shell/kit";
import {
  EndEverySessionButton,
  PolicyPanel,
  type PolicyField,
} from "./security-parts";

/**
 * SECURITY & SIGN-INS, the canvas's one screen over five addresses: who is
 * signed in now, the day's sign-in log, the accounts paused by wrong
 * passwords, the codes, the accounts never used, and the policy. The figures
 * and the tab strip are the same on every one of them, read here once.
 */

export type SecurityTab =
  | "now"
  | "log"
  | "paused"
  | "codes"
  | "never"
  | "policy";

export async function SecurityFrame({
  active,
  children,
}: {
  active: SecurityTab;
  children: React.ReactNode;
}) {
  const f = await securityFigures();
  const tabs: TabItem[] = [
    {
      slug: "now",
      label: "Signed in now",
      href: ADMIN.signIns("now"),
      count: f.signedInNow,
    },
    { slug: "log", label: "Sign-in log", href: ADMIN.signIns() },
    {
      slug: "paused",
      label: "Paused",
      href: `${ADMIN.signIns()}?view=paused`,
      count: f.paused || null,
    },
    { slug: "codes", label: "Codes (OTP)", href: ADMIN.otp("requests") },
    {
      slug: "never",
      label: "Never signed in",
      href: ADMIN.signIns("never"),
      count: f.neverSignedIn,
    },
    { slug: "policy", label: "Policies", href: ADMIN.security },
  ];
  return (
    <AdminPage
      title="Security & sign-ins"
      subtitle="Who is signed in, who was turned away and why, and the rules that decide it."
      actions={<EndEverySessionButton />}
      figures={[
        { label: "Signed in now", value: f.signedInNow, href: tabs[0].href },
        {
          label: "Wrong passwords · 24 h",
          value: f.wrongPasswords24h,
          href: tabs[1].href,
        },
        {
          label: "Paused accounts",
          value: f.paused,
          tone: f.paused ? "danger" : undefined,
          href: tabs[2].href,
        },
        {
          label: "Codes sent today",
          value: f.codesSentToday,
          href: tabs[3].href,
        },
        {
          label: "Codes refused today",
          value: f.codesRefusedToday,
          tone: f.codesRefusedToday ? "warn" : undefined,
          href: tabs[3].href,
        },
        { label: "Signed in as others · 7 d", value: f.impersonations7d },
      ]}
      tabs={{
        items: tabs,
        active,
        href: (slug) => tabs.find((t) => t.slug === slug)?.href ?? tabs[1].href,
      }}
    >
      {children}
    </AdminPage>
  );
}

/** The policy panel beside the log: the figures the pause and the codes run on. */
export async function SecurityPolicy({ canWrite }: { canWrite: boolean }) {
  const [config, otp] = await Promise.all([getConfig(), otpAvailability()]);
  const n = (k: string) =>
    Number((config as unknown as Record<string, unknown>)[k]);
  const fields: PolicyField[] = [
    {
      key: "auth.password.maxFailures",
      label: "Pause after wrong passwords",
      unit: "tries",
      value: n("auth.password.maxFailures"),
    },
    {
      key: "auth.password.maxFailuresPerAddress",
      label: "Per address",
      unit: "tries",
      value: n("auth.password.maxFailuresPerAddress"),
    },
    {
      key: "auth.password.failureWindowMinutes",
      label: "Counting window",
      unit: "min",
      value: n("auth.password.failureWindowMinutes"),
    },
    {
      key: "auth.console.confirmMinutes",
      label: "Console asks password again",
      unit: "min",
      value: n("auth.console.confirmMinutes"),
    },
    {
      key: null,
      label: "Session lasts",
      unit: "days",
      value: 30,
      title: "Fixed in the code, not a setting.",
    },
    {
      key: "auth.otp.maxVerifyAttempts",
      label: "Code tries",
      unit: "tries",
      value: n("auth.otp.maxVerifyAttempts"),
    },
    {
      key: "auth.otp.resendCooldownSeconds",
      label: "Code resend wait",
      unit: "sec",
      value: n("auth.otp.resendCooldownSeconds"),
    },
  ];
  const template = otp.available
    ? {
        ok: true,
        why:
          otp.provider === "wati"
            ? `Wati template “${otp.template}”.`
            : "Sent through MiniMoth.",
      }
    : { ok: false, why: otp.why };
  return (
    <PolicyPanel fields={fields} template={template} canWrite={canWrite} />
  );
}
