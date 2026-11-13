"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveSettings } from "@/lib/actions/locker-admin";
import type { Tier } from "@/lib/locker/engine";
import type { LockerSettings, TierRules } from "@/lib/locker/settings";
import { C, LBL, TierPill, btnStyle, useToast } from "../../_ui/kit";
import { Alert, Block, LList } from "../../_ui/vault-parts";

const num: React.CSSProperties = { width: 80, height: 32, padding: "0 8px", border: "1px solid #C2C8D2", borderRadius: 4, fontSize: 14 };

function N({ v, on, disabled }: { v: number; on: (n: number) => void; disabled?: boolean }) {
  return <input type="number" value={v} disabled={disabled} onChange={(e) => on(Number(e.target.value))} style={{ ...num, background: disabled ? "#F7F8FA" : "#FFFFFF" }} />;
}
function B({ v, on, disabled }: { v: boolean; on: (b: boolean) => void; disabled?: boolean }) {
  return <input type="checkbox" checked={v} disabled={disabled} onChange={(e) => on(e.target.checked)} style={{ width: 18, height: 18, accentColor: C.v700 }} />;
}

export function SecurityScreen({ settings, vault }: { settings: LockerSettings; vault: { ready: boolean; kekVersion: number; explicit: boolean } }) {
  const router = useRouter();
  const toast = useToast();
  const [s, setS] = useState<LockerSettings>(settings);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const tier = (t: Tier, k: keyof TierRules, v: number | boolean) => setS({ ...s, tiers: { ...s.tiers, [t]: { ...s.tiers[t], [k]: v } } });
  const top = (k: keyof LockerSettings, v: number) => setS({ ...s, [k]: v });
  const cols = "110px 130px 110px 120px 120px 120px 100px";
  return (
    <div style={{ padding: "0 24px 48px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
      {vault.ready ? (
        <Alert tone="vault" t={`The vault is encrypting · key version ${vault.kekVersion}`} m={`Every value has its own data key, wrapped by a key-encryption key held in the server's environment (${vault.explicit ? "LOCKER_KEK" : "derived from the app signing secret"}) — never in the database, so a database copy opens nothing. Keep the key's recovery material offline with two officers; the Locker's own hosting and domain logins belong in that sealed envelope too, not in the Locker.`} />
      ) : (
        <Alert tone="red" t="The vault has no key on this deployment" m="Set LOCKER_KEK (or the app signing secret) on the server. Until then nothing can be stored or revealed." />
      )}
      <Block vault title="Secret levels" sub="What each level asks for before showing a value, and how long it stays on screen.">
        <div style={{ overflowX: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: cols, gap: 12, padding: "0 20px", height: 34, alignItems: "center", background: C.v50, borderBottom: `1px solid ${C.v100}`, ...LBL, color: C.v500 }}>
            <span>Level</span>
            <span>Password re-entry</span>
            <span>Reason</span>
            <span>On screen (s)</span>
            <span>Clipboard (s)</span>
            <span>Watermark</span>
            <span>Change (days)</span>
          </div>
          {(["standard", "sensitive", "restricted"] as Tier[]).map((t) => {
            const r = s.tiers[t];
            const fixed = t === "restricted";
            return (
              <div key={t} style={{ display: "grid", gridTemplateColumns: cols, gap: 12, padding: "10px 20px", alignItems: "center", borderTop: `1px solid ${C.line3}`, boxShadow: `inset 3px 0 0 ${C.v700}` }}>
                <TierPill tier={t} />
                <B v={r.stepUp} disabled={fixed} on={(b) => tier(t, "stepUp", b)} />
                <B v={r.reason} disabled={fixed} on={(b) => tier(t, "reason", b)} />
                <N v={r.showSeconds} on={(n) => tier(t, "showSeconds", n)} />
                {fixed ? <span style={{ fontSize: 13, color: C.muted }}>Copy disabled</span> : <N v={r.clipboardSeconds} on={(n) => tier(t, "clipboardSeconds", n)} />}
                <B v={r.watermark} on={(b) => tier(t, "watermark", b)} />
                <N v={r.rotateDays} on={(n) => tier(t, "rotateDays", n)} />
              </div>
            );
          })}
        </div>
      </Block>
      <Block title="Rules for everybody">
        <LList
          items={[
            { key: "r", t: "Shortest reason (characters)", extra: <div style={{ marginTop: 6 }}><N v={s.reasonMin} on={(n) => top("reasonMin", n)} /></div> },
            { key: "a", t: "A restricted request waits for its approver (minutes)", sub: "And an approval must be used within the same time.", extra: <div style={{ marginTop: 6 }}><N v={s.approvalMinutes} on={(n) => top("approvalMinutes", n)} /></div> },
            { key: "h", t: "Reveals one person may make in an hour", sub: "Past it they are paused and the Locker admins are told.", extra: <div style={{ marginTop: 6 }}><N v={s.revealsPerHour} on={(n) => top("revealsPerHour", n)} /></div> },
            { key: "w", t: "Working hours (24h clock, IST)", sub: "A reveal outside them is recorded as notable and the Locker admins are told.", extra: <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}><N v={s.workStartHour} on={(n) => top("workStartHour", n)} /> to <N v={s.workEndHour} on={(n) => top("workEndHour", n)} /></div> },
            { key: "b", t: "Emergency access window (minutes)", extra: <div style={{ marginTop: 6 }}><N v={s.breakglassMinutes} on={(n) => top("breakglassMinutes", n)} /></div> },
            { key: "br", t: "Review emergency access within (hours)", extra: <div style={{ marginTop: 6 }}><N v={s.breakglassReviewHours} on={(n) => top("breakglassReviewHours", n)} /></div> },
            { key: "c", t: "Warn about a card expiring within (days)", sub: "Every subscription charged to it is named in the warning.", extra: <div style={{ marginTop: 6 }}><N v={s.cardWarnDays} on={(n) => top("cardWarnDays", n)} /></div> },
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
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" disabled={!dirty} onClick={() => setS(settings)} style={btnStyle("s")}>
          Undo changes
        </button>
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={async () => {
            setBusy(true);
            const r = await saveSettings(s);
            setBusy(false);
            toast(r.ok ? "Saved — the other Locker admins have been told" : r.error);
            if (r.ok) router.refresh();
          }}
          style={dirty ? btnStyle("p") : { ...btnStyle("p"), opacity: 0.5, cursor: "not-allowed" }}
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
