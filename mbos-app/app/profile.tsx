import React from 'react';
import { Pressable, View } from 'react-native';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, ListCard, SecondaryButton, T, Toggle } from '../src/components/ui/primitives';
import { feedback, primeSounds } from '../src/components/ui/feedback';
import { setFeedbackPref, useFeedbackPrefs } from '../src/data/feedback-prefs';
import { openPasswordReset } from '../src/data/session';
import { useStore } from '../src/state/store';
import { useSignOut } from '../src/state/sign-out';
import { useBoot } from '../src/state/boot';
import { color as C, radius, weight } from '../src/theme/tokens';
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

  return (
    <AppFrame title="Profile" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <Card style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 20 }}>
        <View
          style={{
            width: 60,
            height: 60,
            borderRadius: 30,
            backgroundColor: C.primaryTint,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <T style={[{ fontSize: 20, color: C.primaryDeep }, weight(600)]}>{me?.initials ?? ''}</T>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T s="h2">{me?.name ?? ''}</T>
          <T s="small" style={{ color: C.muted, marginTop: 1 }}>
            {[me?.designation ?? me?.role, me?.territory].filter(Boolean).join(' · ')}
          </T>
          <T s="caption" style={{ marginTop: 3 }}>
            {me?.employeeCode ?? ''}
          </T>
        </View>
      </Card>

      <T s="label" style={{ marginTop: 20, marginBottom: 8 }}>
        Contact
      </T>

      <ListCard>
        {PF_FIELDS.map((f, i) => (
          <View
            key={f.k}
            style={{ paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
            <T s="caption">{f.label}</T>
            <T style={{ fontSize: 16, lineHeight: 22, color: f.value ? C.ink : C.muted, marginTop: 2 }}>
              {f.value || 'Not set'}
            </T>
            {f.hint ? (
              <T s="caption" style={{ marginTop: 3 }}>
                {f.hint}
              </T>
            ) : null}
          </View>
        ))}
      </ListCard>
      <T s="caption" style={{ marginTop: 8 }}>
        This is what the office has for you. To change anything, ask your manager.
        You cannot change it here.
      </T>

      <T s="label" style={{ marginTop: 20, marginBottom: 8 }}>
        Your posting
      </T>
      <ListCard>
        {PF_WORK.map((w, i) => (
          <View
            key={w.l}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 16,
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderTopWidth: i ? 1 : 0,
              borderTopColor: C.wash,
            }}>
            <T style={{ fontSize: 15, lineHeight: 22, color: C.muted }}>{w.l}</T>
            <T style={{ flex: 1, fontSize: 15, lineHeight: 22, color: C.ink, textAlign: 'right' }}>{w.v}</T>
          </View>
        ))}
      </ListCard>
      <T s="caption" style={{ marginTop: 8 }}>
        The office sets your area and your manager. If either is wrong, ask your manager.
      </T>

      <T s="label" style={{ marginTop: 20, marginBottom: 8 }}>
        Preferences
      </T>
      <ListCard>
        {/*
          Push, and whether it can actually reach this phone.

          Three different answers with three different things to do about
          them — the office has not finished setting it up, this phone has
          notifications switched off, or it is working — and a single toggle
          could express none of them. Where the person can fix it themselves
          the row is a button; where they cannot, it says who can.
        */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 16,
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={{ fontSize: 16, lineHeight: 22, color: C.ink, opacity: push?.ok ? 1 : 0.5 }}>
              Push notifications
            </T>
            <T s="caption" style={{ marginTop: 1 }}>
              {push == null
                ? 'Checking…'
                : push.ok
                  ? 'On. Office replies reach you even when the app is closed.'
                  : push.why}
            </T>
          </View>
          {push && !push.ok && push.reason === 'permission' ? (
            <Pressable
              accessibilityRole="button"
              disabled={pushBusy}
              onPress={() => {
                setPushBusy(true);
                void registerForPush()
                  .then((r) => {
                    setPush(r);
                    if (!r.ok) notify(r.why, 'error');
                  })
                  .finally(() => setPushBusy(false));
              }}
              style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 }}>
              <T style={[{ fontSize: 15, color: C.primary }, weight(500)]}>
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
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 16,
            paddingHorizontal: 16,
            paddingVertical: 14,
            borderTopWidth: 1,
            borderTopColor: C.wash,
          }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={{ fontSize: 16, lineHeight: 22, color: C.ink }}>
              {'Lock MBOS with ' + (lockOffer?.label ?? 'fingerprint').toLowerCase()}
            </T>
            <T s="caption" style={{ marginTop: 1 }}>
              {lockOffer && !lockOffer.ok
                ? lockOffer.why
                : 'Asked when you open the app. Your work keeps sending while it is locked.'}
            </T>
          </View>
          {lockOffer?.ok ? (
            <Toggle size="sm" on={lockOn} onPress={() => void toggleLock()} />
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
          label="Vibrate on actions"
          sub="A short buzz when something is saved, refused or arrives."
          on={feedbackPrefs.haptics}
          onToggle={() => {
            const next = !feedbackPrefs.haptics;
            void setFeedbackPref('haptics', next).then(() => {
              if (next) feedback('success');
            });
          }}
        />
        <FeedbackRow
          label="Sounds"
          sub="A soft tone with the buzz. Silent when your phone is on silent or vibrate."
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

      {/* It opens MahekOne's reset page, so it is named for what that page
          does. "Change password" promised a form here that asks for the old
          one, and there is none. */}
      <SecondaryButton
        label="Reset your password"
        style={{ marginTop: 16 }}
        onPress={async () => {
          const opened = await openPasswordReset();
          notify(
            opened
              ? 'Opening the reset page. Use your work email, or a WhatsApp code if it offers one.'
              : 'Could not open the browser. Ask your manager to reset your password.',
            opened ? 'info' : 'error',
          );
        }}
      />

      <Pressable
        accessibilityRole="button"
        onPress={askSignOut}
        style={{
          width: '100%',
          minHeight: 52,
          marginTop: 10,
          borderWidth: 1,
          borderColor: C.dangerBg,
          backgroundColor: C.dangerBg,
          borderRadius: radius.lg,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <T style={[{ fontSize: 16, color: C.danger }, weight(600)]}>Sign out</T>
      </Pressable>
    </AppFrame>
  );
}

function FeedbackRow({ label, sub, on, onToggle }: { label: string; sub: string; on: boolean; onToggle: () => void }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: 1,
        borderTopColor: C.wash,
      }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={{ fontSize: 16, lineHeight: 22, color: C.ink }}>{label}</T>
        <T s="caption" style={{ marginTop: 1 }}>
          {sub}
        </T>
      </View>
      <Toggle size="sm" on={on} onPress={onToggle} />
    </View>
  );
}
