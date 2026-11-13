"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveSettings } from "@/lib/actions/locker-admin";
import type { Tier } from "@/lib/locker/engine";
import type { LockerSettings, TierRules } from "@/lib/locker/settings";
import { Button, Td, Th, Tr, checkboxClass, controlClass } from "@/components/ui/primitives";
import { TierPill, useToast } from "../../_ui/kit";
import { Alert, Block, LList } from "../../_ui/vault-parts";

const num = controlClass({ className: "h-8 w-20 disabled:bg-canvas" });

function N({ v, on, disabled }: { v: number; on: (n: number) => void; disabled?: boolean }) {
  return <input type="number" value={v} disabled={disabled} onChange={(e) => on(Number(e.target.value))} className={num} />;
}
function B({ v, on, disabled }: { v: boolean; on: (b: boolean) => void; disabled?: boolean }) {
  return <input type="checkbox" checked={v} disabled={disabled} onChange={(e) => on(e.target.checked)} className={checkboxClass} />;
}

export function SecurityScreen({ settings, vault }: { settings: LockerSettings; vault: { ready: boolean; kekVersion: number; explicit: boolean } }) {
  const router = useRouter();
  const toast = useToast();
  const [s, setS] = useState<LockerSettings>(settings);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const tier = (t: Tier, k: keyof TierRules, v: number | boolean) => setS({ ...s, tiers: { ...s.tiers, [t]: { ...s.tiers[t], [k]: v } } });
  const top = (k: keyof LockerSettings, v: number) => setS({ ...s, [k]: v });
  return (
    <div className="flex flex-col gap-4 px-6 pb-12">
      {vault.ready ? (
        <Alert tone="vault" t={`The vault is encrypting · key version ${vault.kekVersion}`} m={`Every value has its own data key, wrapped by a key-encryption key held in the server's environment (${vault.explicit ? "LOCKER_KEK" : "derived from the app signing secret"}) — never in the database, so a database copy opens nothing. Keep the key's recovery material offline with two officers; the Locker's own hosting and domain logins belong in that sealed envelope too, not in the Locker.`} />
      ) : (
        <Alert tone="red" t="The vault has no key on this deployment" m="Set LOCKER_KEK (or the app signing secret) on the server. Until then nothing can be stored or revealed." />
      )}
      <Block vault title="Secret levels" sub="What each level asks for before showing a value, and how long it stays on screen.">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Level</Th>
                <Th>Password re-entry</Th>
                <Th>Reason</Th>
                <Th>On screen (s)</Th>
                <Th>Clipboard (s)</Th>
                <Th>Watermark</Th>
                <Th>Change (days)</Th>
              </tr>
            </thead>
            <tbody>
          {(["standard", "sensitive", "restricted"] as Tier[]).map((t) => {
            const r = s.tiers[t];
            const fixed = t === "restricted";
            return (
              <Tr key={t}>
                <Td>
                  <TierPill tier={t} />
                </Td>
                <Td>
                  <B v={r.stepUp} disabled={fixed} on={(b) => tier(t, "stepUp", b)} />
                </Td>
                <Td>
                  <B v={r.reason} disabled={fixed} on={(b) => tier(t, "reason", b)} />
                </Td>
                <Td>
                  <N v={r.showSeconds} on={(n) => tier(t, "showSeconds", n)} />
                </Td>
                <Td>{fixed ? <span className="text-[13px] text-muted">Copy disabled</span> : <N v={r.clipboardSeconds} on={(n) => tier(t, "clipboardSeconds", n)} />}</Td>
                <Td>
                  <B v={r.watermark} on={(b) => tier(t, "watermark", b)} />
                </Td>
                <Td>
                  <N v={r.rotateDays} on={(n) => tier(t, "rotateDays", n)} />
                </Td>
              </Tr>
            );
          })}
            </tbody>
          </table>
        </div>
      </Block>
      <Block title="Rules for everybody">
        <LList
          items={[
            { key: "r", t: "Shortest reason (characters)", extra: <div className="mt-1.5"><N v={s.reasonMin} on={(n) => top("reasonMin", n)} /></div> },
            { key: "a", t: "A restricted request waits for its approver (minutes)", sub: "And an approval must be used within the same time.", extra: <div className="mt-1.5"><N v={s.approvalMinutes} on={(n) => top("approvalMinutes", n)} /></div> },
            { key: "h", t: "Reveals one person may make in an hour", sub: "Past it they are paused and the Locker admins are told.", extra: <div className="mt-1.5"><N v={s.revealsPerHour} on={(n) => top("revealsPerHour", n)} /></div> },
            { key: "w", t: "Working hours (24h clock, IST)", sub: "A reveal outside them is recorded as notable and the Locker admins are told.", extra: <div className="mt-1.5 flex items-center gap-2"><N v={s.workStartHour} on={(n) => top("workStartHour", n)} /> to <N v={s.workEndHour} on={(n) => top("workEndHour", n)} /></div> },
            { key: "b", t: "Emergency access window (minutes)", extra: <div className="mt-1.5"><N v={s.breakglassMinutes} on={(n) => top("breakglassMinutes", n)} /></div> },
            { key: "br", t: "Review emergency access within (hours)", extra: <div className="mt-1.5"><N v={s.breakglassReviewHours} on={(n) => top("breakglassReviewHours", n)} /></div> },
            { key: "c", t: "Warn about a card expiring within (days)", sub: "Every subscription charged to it is named in the warning.", extra: <div className="mt-1.5"><N v={s.cardWarnDays} on={(n) => top("cardWarnDays", n)} /></div> },
          ]}
        />
      </Block>
      <Block vault title="Fixed — not configurable">
        <LList
          items={[
            { key: "1", t: "A restricted reveal needs a second person", sub: "Somebody holding Approvals, never the person asking — admins included." },
            { key: "2", t: "Emergency access is never started and approved by one person", sub: "And it is recorded, announced to every approver, and reviewed afterwards." },
            { key: "3", t: "Restricted values cannot be copied", sub: "Read it and type it." },
            { key: "4", t: "Nobody without Passwords & keys can reveal anything", sub: "An auditor reads the registers and the audit log, never a secret." },
            { key: "5", t: "The audit log cannot be changed or deleted", sub: "Each entry carries the fingerprint of the one before it." },
          ]}
        />
      </Block>
      <div className="flex justify-end gap-2.5">
        <Button disabled={!dirty} onClick={() => setS(settings)}>
          Undo changes
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || busy}
          onClick={async () => {
            setBusy(true);
            const r = await saveSettings(s);
            setBusy(false);
            toast(r.ok ? "Saved — the other Locker admins have been told" : r.error);
            if (r.ok) router.refresh();
          }}
        >
          {busy ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
