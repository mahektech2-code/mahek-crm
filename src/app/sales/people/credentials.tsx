"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { endSessionsFor, sendPasswordResetFor } from "@/lib/actions/people";
import { releaseDevice } from "@/lib/actions/sales";
import type { Salesman } from "@/lib/services/sales-service";
import { ReasonModal, RowMenu } from "@/components/console/parts";

/**
 * Getting somebody back into the app, from the screen that lists them.
 *
 * Every one of these already existed and none of them were reachable from
 * here. A national sales manager who wanted to give a salesman a new password
 * had to open the Admin Console, and releasing a handset — which is what stops
 * somebody signing in on a phone at all after they change it — was on no
 * screen the sales team holds. So the three things that go wrong with a
 * salesman's sign-in were answered in three different places, one of which
 * most of this team cannot open.
 *
 * THEY ARE NOT ALL THE SAME KIND OF ACT and the menu says so:
 *
 *   A password-reset link is the ordinary one. It works once, expires, and is the
 *   answer to "he has forgotten his password".
 *
 *   Ending sessions signs him out everywhere. It is what you do when a phone
 *   is lost, and it costs him nothing but a fresh sign-in.
 *
 *   Releasing the handset is the one with a consequence: `mbos.devices.
 *   onePerPerson` binds an account to one phone, so until the old binding goes
 *   the new phone cannot sign in at all — and lifting it means whoever holds
 *   the OLD phone can bind again. That is why it takes a reason, like every
 *   other release in this app.
 *
 * The first two belong to a PLATFORM ADMINISTRATOR — `people.ts` checks
 * `requirePlatformAdminUser`, not holding this app and not `isManager`, and
 * that boundary is deliberate: handing out credentials is an account decision
 * rather than a sales one. They used to be drawn disabled for everybody else
 * with the reason on them; they are now not drawn at all, because a national
 * sales manager is never going to become a platform administrator by reading
 * a tooltip, and a menu where two of three items are permanently grey is a
 * menu people stop opening. The release stays for everybody who holds the
 * screen — it is the Sales Dashboard's own act.
 */
export function Credentials({
  salesman,
  canManageAccounts,
}: {
  salesman: Salesman;
  /** Whether the viewer is a platform administrator — see `people.ts`'s own guard. */
  canManageAccounts: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [releasing, setReleasing] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const say = (r: { ok: boolean; message?: string; error?: string }) => {
    toast.push(r.ok ? (r.message ?? "Done.") : (r.error ?? "That did not work."));
    if (r.ok) router.refresh();
  };

  return (
    <>
      <RowMenu
        items={[
          ...(canManageAccounts
            ? [
                {
                  label: "Send a password-reset link",
                  disabled: !salesman.active,
                  title: !salesman.active
                    ? "This account is closed, so it cannot be signed in to."
                    : "Mails a single-use link to their work email. It expires, and using it signs them out everywhere else.",
                  run: () => void sendPasswordResetFor(salesman.id).then(say),
                },
                {
                  label: "Sign them out everywhere",
                  title:
                    "Ends every session this account has open, on the web and on the handset. They sign in again with the password they already have.",
                  run: () => void endSessionsFor(salesman.id).then(say),
                },
              ]
            : []),
          {
            label: "Release their handset",
            danger: true,
            disabled: !salesman.boundDeviceId,
            title: salesman.boundDeviceId
              ? "One account binds to one phone. Release it so they can sign in on a new one — whoever holds the old phone can bind again, so say why."
              : "No handset is bound to this account, so there is nothing to release.",
            run: () => {
              setReason("");
              setError(null);
              setReleasing(true);
            },
          },
        ]}
      />

      <ReasonModal
        open={releasing}
        title="Release this handset"
        subject={salesman.name}
        subjectDetail={
          salesman.boundDeviceId
            ? `Bound to ${salesman.boundDeviceId}. They can sign in on a new phone once it is released — and so can whoever is holding this one.`
            : undefined
        }
        fieldLabel="Why is it being released"
        reason={reason}
        onReasonChange={(v) => {
          setReason(v);
          setError(null);
        }}
        confirmLabel="Release it"
        busy={busy}
        error={error}
        onClose={() => setReleasing(false)}
        onConfirm={() => {
          if (!salesman.boundDeviceId) return;
          setBusy(true);
          void releaseDevice({ deviceId: salesman.boundDeviceId, reason }).then((r) => {
            setBusy(false);
            if (r.ok) {
              setReleasing(false);
              say(r);
            } else {
              setError(r.error ?? "That did not work.");
            }
          });
        }}
      />
    </>
  );
}
