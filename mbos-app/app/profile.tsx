import React from 'react';
import { Pressable, View } from 'react-native';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { ListCard, T, Toggle } from '../src/components/ui/primitives';
import { GLYPH, Glyph, HeroPill, type GlyphShape } from '../src/components/me/kit';
import { feedback, primeSounds } from '../src/components/ui/feedback';
import { setFeedbackPref, useFeedbackPrefs } from '../src/data/feedback-prefs';
import { openPasswordReset } from '../src/data/session';
import { useStore } from '../src/state/store';
import { useSignOut } from '../src/state/sign-out';
import { useBoot } from '../src/state/boot';
import { color as C, weight } from '../src/theme/tokens';
import { canOffer, isOn as lockIsOn, setOn as rememberLockChoice } from '../src/data/app-lock';
import { prompt as promptBiometric } from '../src/native/biometrics';
import { pushStatus, registerForPush, type PushReadiness } from '../src/native/push';

/**
 * Profile — the four things about him the office may have wrong, and three
 * switches about this handset.
 *
 * **CONTACT IS READ-ONLY, AND IT USED TO BE A FORM THAT SAVED NOTHING.**
 * Edit → type → Save wrote the four fields into `pfSaved` on the Zustand
 * store and toasted "Profile updated". The store carries no `persist`
 * middleware, nothing anywhere reads `pfSaved`, and nothing enqueues it — so
 * a corrected mobile number and an emergency contact were congratulated and
 * thrown away, and were gone again the next time the app launched. There is
 * no profile channel on the wire to enqueue them onto, and inventing one is
 * not a screen's decision, so the section says who to ask instead. A form
 * that lies is worse than no form: it is where somebody goes to fix the
 * problem and it tells them they already have — the same rule the dead
 * toggles below this list were corrected under.
 *
 * An empty field says "Not set" rather than sitting blank, because the office
 * having no emergency contact for him is the fact worth knowing.
 */

/**
 * THE SWITCHES HERE ALL DO SOMETHING.
 *
 * "Send on Wi-Fi only" was drawn off and unpressable with "Not ready yet"
 * under it — a switch for a feature that does not exist, which is where
 * somebody goes to save data and is told nothing they can use. It is gone
 * until the sync can honour it. Push, the app lock, vibration and sounds are
 * each real, and each says whether it is working on THIS phone.
 */

export default function ProfileScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const askSignOut = useSignOut();

  const boot = useBoot();
  const me = boot.session?.user ?? null;

  /*
   * The app lock, which is a property of THIS HANDSET rather than of the
   * account — so it is read from the phone, not from the session, and it is
   * asked again every time the screen opens. Somebody can add or remove a
   * fingerprint in the phone's own Settings between two visits here, and a row
   * that answered from a value cached at boot would offer a switch that no
   * longer works.
   */
  /*
   * Push, asked WITHOUT prompting.
   *
   * It said "Not switched on for this build" until push was built, which was
   * true and is now false — and a switch that lies in the reassuring
   * direction is worse than one that lies in the other, because it is where
   * somebody goes to fix the problem and it tells them they already have.
   */
  const [push, setPush] = React.useState<PushReadiness | null>(null);
  const [pushBusy, setPushBusy] = React.useState(false);

  const [lockOn, setLockOn] = React.useState(false);
  const feedbackPrefs = useFeedbackPrefs();
  const [lockOffer, setLockOffer] = React.useState<{ ok: boolean; why: string; label: string } | null>(null);
  const [lockBusy, setLockBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void Promise.all([lockIsOn(), canOffer(), pushStatus()]).then(([on, offer, p]) => {
      if (!live) return;
      setLockOn(on);
      setLockOffer(offer);
      setPush(p);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Turning it on asks for the finger first.
   *
   * Nobody should be able to switch on a lock they have not just proved they
   * can open — that is how a handset ends up shut with a day's unsent orders
   * inside it. Turning it OFF asks too, for the opposite reason: the person
   * standing over somebody else's unlocked phone is exactly who would
   * otherwise switch the protection off.
   */
  const toggleLock = async () => {
    if (lockBusy || !lockOffer?.ok) return;
    setLockBusy(true);
    try {
      const wanted = !lockOn;
      const outcome = await promptBiometric(wanted ? 'Turn the app lock on' : 'Turn the app lock off');
      if (!outcome.ok) {
        if (outcome.kind !== 'cancelled') notify(outcome.message, 'error');
        return;
      }
      await rememberLockChoice(wanted);
      setLockOn(wanted);
      notify(
        wanted
          ? 'App lock on. MBOS will ask for your fingerprint when you open it.'
          : 'App lock off',
      );
    } finally {
      setLockBusy(false);
    }
  };

  /* What the office holds for him, READ from the session it issued.
     "Emergency contact" and "Address" were drawn here as well, always reading
     "Not set" — not because the office has none, but because neither is sent
     to the phone at all. A row that claims the office holds nothing, when HR
     may hold both, is worse than no row. */
  const PF_FIELDS: { k: string; label: string; value: string; hint?: string }[] = [
    { k: 'mobile', label: 'Mobile', value: me?.phone ?? '', hint: 'You sign in with this' },
    { k: 'email', label: 'Email', value: me?.email ?? '' },
  ];

  const PF_WORK = [
    { l: 'Reports to', v: me?.reportsToName ?? '' },
    { l: 'Area', v: me?.territory ?? '' },
    { l: 'Employee code', v: me?.employeeCode ?? '' },
  ].filter((w) => w.v);

  const hero = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 18 }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: C.primary,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <T style={[{ fontSize: 22, color: C.onNavy }, weight(800)]}>{me?.initials ?? ''}</T>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={[{ fontSize: 22, lineHeight: 28, letterSpacing: -0.44, color: C.lavenderInk }, weight(800)]}>{me?.name ?? ''}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {me?.designation ?? me?.role ? (
            <HeroPill ink={C.primaryDeep} style={{ height: 26 }}>{me?.designation ?? me?.role}</HeroPill>
          ) : null}
          {me?.territory ? (
            <HeroPill ink={C.lavenderMuted} icon={GLYPH.pin} style={{ height: 26 }}>{me.territory}</HeroPill>
          ) : null}
          {me?.employeeCode ? (
            <HeroPill ink={C.lavenderMuted} style={{ height: 26 }}>{me.employeeCode}</HeroPill>
          ) : null}
        </View>
      </View>
    </View>
  );

  /* One list in Version 3: what he can be reached on, then where he is posted.
     Each says "Not set" where the office holds nothing, rather than vanishing
     — except the posting rows, which were only ever drawn when known. */
  const INFO: { k: string; icon: GlyphShape[]; value: string; label: string }[] = [
    ...PF_FIELDS.map((f) => ({
      k: f.k,
      icon: f.k === 'mobile' ? PHONE : GLYPH.mail,
      value: f.value,
      label: f.hint ? `${f.label} · ${f.hint.charAt(0).toLowerCase()}${f.hint.slice(1)}` : f.label,
    })),
    ...PF_WORK.map((w) => ({
      k: w.l,
      icon: w.l === 'Reports to' ? REPORTS_TO : w.l === 'Area' ? AREA : EMP_CARD,
      value: w.v,
      label: w.l,
    })),
  ];

  return (
    <AppFrame title="Profile" activeTab={null} hero={hero} contentStyle={{ padding: 14, paddingBottom: 24, gap: 12 }}>
      <BackLink label={back.label} onPress={back.go} />

      <ListCard style={{ borderRadius: 22 }}>
        {INFO.map((f, i) => (
          <View
            key={f.k}
            accessible
            accessibilityLabel={`${f.label}: ${f.value || 'Not set'}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              minHeight: 60,
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderTopWidth: i ? 1 : 0,
              borderTopColor: C.hairline,
            }}>
            <Glyph shapes={f.icon} size={20} color={f.value ? C.primaryDeep : C.faint} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T
                selectable={f.k === 'mobile' || f.k === 'email'}
                style={[{ fontSize: 16, lineHeight: 22, color: f.value ? C.ink : C.faint }, weight(f.value ? 600 : 400)]}>
                {f.value || 'Not set'}
              </T>
              <T style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>{f.label}</T>
            </View>
          </View>
        ))}
      </ListCard>
      {/* Both notes the old screen carried, said once: contact, area and
          manager all come from the office, and none of it changes here. */}
      <View
        accessible
        accessibilityLabel="This is what the office has for you. The office sets your area and your manager. To change anything, ask your manager. You cannot change it here."
        style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 6 }}>
        <Glyph shapes={LOCK} size={16} color={C.muted} />
        <T style={{ flex: 1, fontSize: 12, lineHeight: 17, color: C.muted }}>
          Set by the office. Contact, area or manager wrong? Ask your manager — it cannot be changed here.
        </T>
      </View>

      <ListCard style={{ borderRadius: 22 }}>
        {/*
          Push, and whether it can actually reach this phone.

          Three different answers with three different things to do about
          them — the office has not finished setting it up, this phone has
          notifications switched off, or it is working — and a single toggle
          could express none of them. Where the person can fix it themselves
          the row is a button; where they cannot, it says who can.
        */}
        <View style={rowStyle(true)}>
          <Glyph shapes={GLYPH.bell} size={20} color={push?.ok ? C.ink : C.faint} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 15, lineHeight: 20, color: push?.ok ? C.ink : C.faint }, weight(700)]}>
              Push notifications
            </T>
            <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 1 }}>
              {push == null
                ? 'Checking…'
                : push.ok
                  ? 'On · office replies reach you when closed'
                  : push.why}
            </T>
          </View>
          {push && !push.ok && push.reason === 'permission' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Turn on push notifications"
              accessibilityState={{ busy: pushBusy }}
              disabled={pushBusy}
              hitSlop={4}
              onPress={() => {
                setPushBusy(true);
                void registerForPush()
                  .then((r) => {
                    setPush(r);
                    if (!r.ok) notify(r.why, 'error');
                  })
                  .finally(() => setPushBusy(false));
              }}
              style={{ height: 40, paddingHorizontal: 16, borderRadius: 20, backgroundColor: C.primary, justifyContent: 'center', opacity: pushBusy ? 0.7 : 1 }}>
              <T style={[{ fontSize: 13, color: C.onNavy }, weight(700)]}>
                {pushBusy ? 'Asking…' : 'Turn on'}
              </T>
            </Pressable>
          ) : null}
        </View>

        {/*
          The app lock. Drawn with the switch where the phone can actually
          honour it, and as a sentence where it cannot — the same rule the
          microphone follows in MahekOne: a control that fails when pressed is
          worse than one never shown, and "add a fingerprint in Settings first"
          is something the person can act on.
        */}
        <View style={rowStyle(false)}>
          <Glyph shapes={GLYPH.finger} size={20} color={C.ink} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>
              {'Lock MBOS with ' + (lockOffer?.label ?? 'fingerprint').toLowerCase()}
            </T>
            <T
              style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 1 }}>
              {lockOffer && !lockOffer.ok
                ? lockOffer.why
                : 'Asked on open · work keeps sending'}
            </T>
          </View>
          {lockOffer?.ok ? (
            <Toggle
              size="sm"
              on={lockOn}
              label="App lock. Asked when you open the app. Your work keeps sending while it is locked."
              onPress={() => void toggleLock()}
            />
          ) : null}
        </View>

        {/*
          VIBRATION AND SOUNDS — what the phone does, besides draw, when
          something is saved, refused or arrives. Both are kept on this phone
          (see `data/feedback-prefs.ts`) and both take effect on the next tap.

          Sounds are OFF until somebody turns them on: this is used in other
          people's shops, and a phone that chimes at every order is not a
          default anybody should have to find a switch to undo. Turning them
          on plays one, so the choice is made having heard it.
        */}
        <FeedbackRow
          icon={GLYPH.vibrate}
          label="Vibrate on actions"
          sub="Buzz on saved, refused, arrived"
          longSub="A short buzz when something is saved, refused or arrives."
          on={feedbackPrefs.haptics}
          onToggle={() => {
            const next = !feedbackPrefs.haptics;
            void setFeedbackPref('haptics', next).then(() => {
              if (next) feedback('success');
            });
          }}
        />
        <FeedbackRow
          icon={SOUND}
          label="Sounds"
          sub="Soft tone with the buzz · silent on silent/vibrate"
          longSub="A soft tone with the buzz. Silent when your phone is on silent or vibrate."
          on={feedbackPrefs.sounds}
          onToggle={() => {
            const next = !feedbackPrefs.sounds;
            void setFeedbackPref('sounds', next).then(() => {
              if (next) {
                primeSounds();
                feedback('success');
              }
            });
          }}
        />
      </ListCard>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        {/* It opens MahekOne's reset page, so it is named for what that page
            does. "Change password" promised a form here that asks for the old
            one, and there is none. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset your password"
          onPress={async () => {
            const opened = await openPasswordReset();
            notify(
              opened
                ? 'Opening the reset page. Use your work email, or an OTP if it offers one.'
                : 'Could not open the browser. Ask your manager to reset your password.',
              opened ? 'info' : 'error',
            );
          }}
          style={({ pressed }) => [pillBtn, { backgroundColor: C.surface, opacity: pressed ? 0.85 : 1 }]}>
          <Glyph shapes={GLYPH.key} size={18} color={C.ink} />
          <T style={[{ fontSize: 14, color: C.ink }, weight(700)]}>Reset your password</T>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={askSignOut}
          style={({ pressed }) => [pillBtn, { backgroundColor: C.dangerBg, opacity: pressed ? 0.85 : 1 }]}>
          <Glyph shapes={GLYPH.exit} size={18} color={C.danger} />
          <T style={[{ fontSize: 14, color: C.danger }, weight(700)]}>Sign out</T>
        </Pressable>
      </View>
    </AppFrame>
  );
}

const PHONE: GlyphShape[] = [{ p: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2' }];
const REPORTS_TO: GlyphShape[] = [{ c: [12, 8, 4] }, { p: 'M4 21c0-4 4-6 8-6s8 2 8 6' }];
const AREA: GlyphShape[] = [{ p: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z' }, { c: [12, 10, 2.5] }];
const EMP_CARD: GlyphShape[] = [{ r: [3, 6, 18, 13, 2] }, { c: [9, 12, 2] }, { p: 'M14 11h4M14 14h3' }];
const LOCK: GlyphShape[] = [{ r: [5, 11, 14, 10, 2] }, { p: 'M8 11V8a4 4 0 0 1 8 0v3' }];
const SOUND: GlyphShape[] = [{ p: 'M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6' }];

const pillBtn = {
  flex: 1,
  minHeight: 56,
  borderRadius: 28,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
  gap: 8,
  paddingHorizontal: 10,
};

function rowStyle(first: boolean) {
  return {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: first ? 0 : 1,
    borderTopColor: C.hairline,
  };
}

function FeedbackRow({
  icon,
  label,
  sub,
  longSub,
  on,
  onToggle,
}: {
  icon: GlyphShape[];
  label: string;
  sub: string;
  /** The full sentence, read out with the switch. */
  longSub: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={rowStyle(false)}>
      <Glyph shapes={icon} size={20} color={C.ink} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>{label}</T>
        <T style={{ fontSize: 12, lineHeight: 16, color: C.muted, marginTop: 1 }}>{sub}</T>
      </View>
      <Toggle size="sm" on={on} label={`${label}. ${longSub}`} onPress={onToggle} />
    </View>
  );
}
