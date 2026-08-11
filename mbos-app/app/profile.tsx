import React from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';

import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Card, Input, ListCard, PrimaryButton, SecondaryButton, T, Toggle } from '../src/components/ui/primitives';
import { signOut as signOutReal } from '../src/data/session';
import { pendingCount } from '../src/sync/queue';
import { plural } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { color as C, radius, weight } from '../src/theme/tokens';

/**
 * Profile — the four things about him the office may have wrong, and three
 * switches about this handset.
 *
 * Cancel reverts because it clears only the draft: nothing is written until
 * Save commits it into `pfSaved`, so an edit abandoned halfway leaves the
 * record exactly as it was rather than half-changed.
 */

const PREFS: { k: 'wifi' | 'push' | 'bio'; l: string; s: string }[] = [
  { k: 'wifi', l: 'Sync on Wi-Fi only', s: 'Saves data when you are on mobile' },
  { k: 'push', l: 'Push notifications', s: 'Tasks, approvals and announcements' },
  { k: 'bio', l: 'Sign in with fingerprint', s: 'Instead of typing a password' },
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
              <T style={{ fontSize: 16, lineHeight: 22, color: C.ink }}>{p.l}</T>
              <T s="caption" style={{ marginTop: 1 }}>
                {p.s}
              </T>
            </View>
            <Toggle size="sm" on={pfPrefs[p.k]} onPress={() => set({ pfPrefs: { ...pfPrefs, [p.k]: !pfPrefs[p.k] } })} />
          </View>
        ))}
      </ListCard>

      <SecondaryButton
        label="Change password"
        style={{ marginTop: 16 }}
        onPress={() => notify('A link to set a new password has been sent to your mobile')}
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
