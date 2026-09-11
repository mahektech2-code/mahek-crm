import React from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Input, ListCard, PrimaryButton, SecondaryButton, T, Toggle } from '../src/components/ui/primitives';
import { openPasswordReset, signOut as signOutReal } from '../src/data/session';
import { pendingCount } from '../src/sync/queue';
import { plural } from '../src/lib/format';
import { useStore } from '../src/state/store';
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
 * TWO SWITCHES THAT MOVE AND CHANGE NOTHING, AND ONE THAT NOW DOES.
 *
 * `pfPrefs` is written by these toggles and read by NOTHING — not the sync, not
 * the push registration. It is not even persisted, so a switch somebody set
 * went back the next time the app started. Settings that looked like settings.
 *
 * Push is the one that was reported, and it is the one that cannot simply be
 * wired up: `registerForPush` needs an EAS project id in `app.json`
 * (`extra.eas.projectId`) to ask Expo's service for a token, `extra` is empty,
 * and so nine handsets have registered zero tokens between them. No token means
 * nothing to push TO, which is why a test push arrived nowhere. That needs an
 * Expo account and `eas init`, not a code change.
 *
 * A switch that cannot do anything is worse than no switch: it is where
 * somebody goes to fix the problem, and it tells them they already have. So
 * each one says whether it works, and the ones that do not are shown off and
 * unpressable with the reason underneath.
 *
 * THE FINGERPRINT IS NO LONGER ONE OF THEM. It sat here reading "Not built —
 * sign in with your password", which was true of the dead toggle it described
 * and is now false: it is a real app lock, with its own row beneath this list,
 * because it has state a static entry cannot carry — whether the phone has a
 * sensor, whether a finger is enrolled on it, and whether this handset has the
 * lock switched on. Leaving it here as "not built" would be the same lie in the
 * other direction.
 */
type Pref = { k: 'wifi'; l: string; s: string; blocked?: string };

const PREFS: Pref[] = [
  {
    k: 'wifi',
    l: 'Sync on Wi-Fi only',
    s: 'Saves data when you are on mobile',
    blocked: 'Not built — the sync runs on whatever connection there is.',
  },
];

export default function ProfileScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const askConfirm = useStore((s) => s.askConfirm);
  const signOut = useStore((s) => s.signOut);
  const pfSaved = useStore((s) => s.pfSaved);
  const pfPrefs = useStore((s) => s.pfPrefs);
  const set = useStore((s) => s.set);

  const boot = useBoot();
  const me = boot.session?.user ?? null;

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [err, setErr] = React.useState<string | null>(null);
  const [waiting, setWaiting] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    void pendingCount().then((n) => {
      if (live) setWaiting(n);
    });
    return () => {
      live = false;
    };
  }, []);

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
        if (outcome.kind !== 'cancelled') notify(outcome.message);
        return;
      }
      await rememberLockChoice(wanted);
      setLockOn(wanted);
      notify(
        wanted
          ? 'App lock on — MBOS will ask for your fingerprint when you come back to it'
          : 'App lock off',
      );
    } finally {
      setLockBusy(false);
    }
  };

  /* Four facts about him, seeded from the session the office issued. The
     emergency contact and the address are not in the payload, so they start
     empty rather than showing somebody else's. */
  const PF_FIELDS: { k: string; label: string; seed: string; hint?: string }[] = [
    { k: 'mobile', label: 'Mobile', seed: me?.phone ?? '', hint: 'You sign in with this' },
    { k: 'email', label: 'Email', seed: me?.email ?? '' },
    { k: 'emg', label: 'Emergency contact', seed: '' },
    { k: 'addr', label: 'Address', seed: '' },
  ];

  const PF_WORK = [
    { l: 'Reports to', v: me?.reportsToName ?? '' },
    { l: 'Territory', v: me?.territory ?? '' },
    { l: 'Employee code', v: me?.employeeCode ?? '' },
  ].filter((w) => w.v);

  const val = (k: string, seed: string) => (draft[k] != null ? draft[k] : pfSaved[k] != null ? pfSaved[k] : seed);

  const save = () => {
    const m = val('mobile', me?.phone ?? '').replace(/[^0-9]/g, '');
    if (m.length < 10) return setErr('mobile');
    /* Commit the draft, then clear it — Cancel clears only the draft and so reverts. */
    set({ pfSaved: { ...pfSaved, ...draft } });
    setEditing(false);
    setDraft({});
    setErr(null);
    notify('Profile updated');
  };

  return (
    <AppFrame title="MBOS" activeTab={null} contentStyle={{ padding: 16, paddingBottom: 24 }}>
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

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginTop: 20,
          marginBottom: 8,
        }}>
        <T s="label">Contact</T>
        {!editing ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setEditing(true);
              setDraft({});
              setErr(null);
            }}
            style={{ minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'flex-end', paddingHorizontal: 12, marginRight: -12 }}>
            <T style={[{ fontSize: 14, color: C.primary }, weight(600)]}>Edit</T>
          </Pressable>
        ) : null}
      </View>

      <ListCard>
        {PF_FIELDS.map((f, i) => (
          <View
            key={f.k}
            style={{ paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.wash }}>
            <T s="caption">{f.label}</T>
            {editing ? (
              <Input
                value={val(f.k, f.seed)}
                onChangeText={(v) => {
                  setDraft((d) => ({ ...d, [f.k]: v }));
                  setErr(null);
                }}
                invalid={err === f.k}
                style={{ height: 48, minHeight: 48, marginTop: 4, borderRadius: radius.md }}
              />
            ) : (
              <T style={{ fontSize: 16, lineHeight: 22, color: C.ink, marginTop: 2 }}>{val(f.k, f.seed)}</T>
            )}
            {f.hint ? (
              <T s="caption" style={{ marginTop: 3 }}>
                {f.hint}
              </T>
            ) : null}
          </View>
        ))}
      </ListCard>

      {editing ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          <SecondaryButton
            label="Cancel"
            style={{ flex: 1 }}
            onPress={() => {
              setEditing(false);
              setDraft({});
              setErr(null);
            }}
          />
          <PrimaryButton label="Save" onPress={save} style={{ flex: 1 }} />
        </View>
      ) : null}

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
        Your territory and reporting line are set by the office. Ask your manager if either is wrong.
      </T>

      <T s="label" style={{ marginTop: 20, marginBottom: 8 }}>
        Preferences
      </T>
      <ListCard>
        {PREFS.map((p, i) => (
          <View
            key={p.k}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 16,
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderTopWidth: i ? 1 : 0,
              borderTopColor: C.wash,
            }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={{ fontSize: 16, lineHeight: 22, color: C.ink, opacity: p.blocked ? 0.5 : 1 }}>{p.l}</T>
              <T s="caption" style={{ marginTop: 1 }}>
                {p.blocked ?? p.s}
              </T>
            </View>
            {p.blocked ? (
              /* Off and unpressable, rather than absent: the setting is a real
                 thing somebody expects to find, and a switch that has quietly
                 disappeared reads as a bug of its own. */
              <View style={{ opacity: 0.35 }}>
                <Toggle size="sm" on={false} onPress={() => {}} />
              </View>
            ) : (
              <Toggle size="sm" on={pfPrefs[p.k]} onPress={() => set({ pfPrefs: { ...pfPrefs, [p.k]: !pfPrefs[p.k] } })} />
            )}
          </View>
        ))}

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
            borderTopWidth: 1,
            borderTopColor: C.wash,
          }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T style={{ fontSize: 16, lineHeight: 22, color: C.ink, opacity: push?.ok ? 1 : 0.5 }}>
              Push notifications
            </T>
            <T s="caption" style={{ marginTop: 1 }}>
              {push == null
                ? 'Checking…'
                : push.ok
                  ? 'On. Decisions reach you without opening the app.'
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
                    if (!r.ok) notify(r.why);
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
                : 'Asked for when you come back to the app. Your day keeps syncing while it is locked.'}
            </T>
          </View>
          {lockOffer?.ok ? (
            <Toggle size="sm" on={lockOn} onPress={() => void toggleLock()} />
          ) : null}
        </View>
      </ListCard>

      <SecondaryButton
        label="Change password"
        style={{ marginTop: 16 }}
        onPress={async () => {
          const opened = await openPasswordReset();
          notify(
            opened
              ? 'Opening the reset page. It emails a link to your work address.'
              : 'Could not open the browser. Ask your manager to send you a reset link.',
          );
        }}
      />

      <Pressable
        accessibilityRole="button"
        onPress={() =>
          askConfirm({
            title: 'Sign out?',
            body: waiting
              ? plural(waiting, 'record') +
                ' have not been sent yet. They stay on this phone and go up when you sign in again.'
              : 'Everything you have saved has gone up already.',
            confirmLabel: 'Sign out',
            run: () => {
              /* The outbox is kept. Clearing it here would make the sentence
                 above a lie, and the work is genuinely unrecoverable. */
              void signOutReal().then(() => {
                signOut();
                boot.setSession(null);
                router.replace('/');
              });
            },
          })
        }
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
