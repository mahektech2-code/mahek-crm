import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color as C, HIT, radius, type, weight } from '../src/theme/tokens';
import { Icon } from '../src/components/ui/Icon';
import { PrimaryButton, Toggle } from '../src/components/ui/primitives';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { signIn as signInReal, type LoginStep } from '../src/data/session';
import { useKeyboardHeight } from '../src/components/ui/keyboard';

/**
 * Sign in.
 *
 * The five checks the design shows running are not decoration. An account can
 * be refused for being inactive or for having no territory, and each has a
 * different answer for the person holding the phone — so the ladder names the
 * step it is on rather than showing one spinner and one eventual failure.
 */

type Stage = 'form' | 'verifying' | 'otp';

/** An Indian mobile number. Ten digits, no more, no fewer. */
const MOBILE_DIGITS = 10;

/**
 * `9820011007` shown as `98250 41172`.
 *
 * The number is STORED as bare digits and only grouped on the way to the
 * screen — a space that reached the server would be a number it does not
 * recognise, and a space the person has to delete twice is worse again.
 */
function groupMobile(digits: string): string {
  return digits.length > 5 ? digits.slice(0, 5) + ' ' + digits.slice(5) : digits;
}

export default function Login() {
  const insets = useSafeAreaInsets();
  const set = useStore((s) => s.set);
  const signIn = useStore((s) => s.signIn);
  const notify = useStore((s) => s.notify);
  const method = useStore((s) => s.method);
  const mob = useStore((s) => s.mob);
  const pw = useStore((s) => s.pw);
  const dial = useStore((s) => s.dial);
  const remember = useStore((s) => s.remember);
  const bio = useStore((s) => s.bio);

  const [stage, setStage] = React.useState<Stage>('form');
  const [step, setStep] = React.useState(0);
  const [err, setErr] = React.useState<'mob' | 'pw' | 'inactive' | null>(null);
  const [pwShow, setPwShow] = React.useState(false);
  const [otp, setOtp] = React.useState('');
  const [otpErr, setOtpErr] = React.useState(false);
  /* What the server actually said, shown verbatim — a generic "sign-in failed"
     leaves the salesman with nothing to do about it. */
  const [serverMessage, setServerMessage] = React.useState<string | null>(null);

  const boot = useBoot();
  const keyboardHeight = useKeyboardHeight();
  const cancelled = React.useRef(false);
  React.useEffect(() => () => { cancelled.current = true; }, []);

  /* Already signed in — go straight to the day rather than showing a form the
     salesman has to dismiss every morning. */
  React.useEffect(() => {
    if (boot.ready && boot.session) router.replace('/home');
  }, [boot.ready, boot.session]);

  const digits = otp.replace(/[^0-9]/g, '').slice(0, 6);
  const rawMob = (mob || '98250 41172').replace(/[^0-9]/g, '');
  const masked =
    dial + ' ' + (rawMob.length > 4 ? '•'.repeat(rawMob.length - 4) + ' ' + rawMob.slice(-4) : rawMob);

  /**
   * The five steps are real checks happening on the server, not a timer.
   *
   * Each one has a different answer for the person holding the phone — an
   * inactive account and a wrong password are not the same problem — so the
   * ladder names the step it reached and the failure lands on that step.
   */
  const STEP_INDEX: Record<LoginStep, number> = {
    mobile: 0, credential: 1, status: 2, territory: 3, payload: 4,
  };

  async function submit(skipChecks = false) {
    if (!skipChecks) {
      if (mob.length !== MOBILE_DIGITS) return setErr('mob');
      if (method === 'password' && pw.length < 8) return setErr('pw');
    }
    setErr(null);
    setServerMessage(null);
    setStage('verifying');
    setStep(0);

    const outcome = await signInReal({
      mobile: mob.trim(),
      password: method === 'password' ? pw : undefined,
      otp: method === 'otp' ? digits : undefined,
      onStep: (s) => { if (!cancelled.current) setStep(STEP_INDEX[s]); },
    });

    if (cancelled.current) return;

    if (!outcome.ok) {
      setStage('form');
      setStep(0);
      /* An inactive account gets the design's own banner; anything else lands
         on the field that caused it. */
      setErr(outcome.step === 'status' || outcome.step === 'territory' ? 'inactive' : outcome.step === 'credential' ? 'pw' : 'mob');
      setServerMessage(outcome.message);
      if (method === 'otp') setOtpErr(true);
      return;
    }

    signIn();
    boot.setSession(outcome.session);
    if (outcome.offline) notify('Signed in from this phone — your book is as of the last time you had signal');
    router.replace('/home');
  }

  const steps = [
    'Verifying mobile',
    method === 'otp' ? 'Checking the code' : 'Verifying password',
    'Checking employee status',
    'Checking assigned territory',
    'Loading your day',
  ];

  return (
    <KeyboardAvoidingView
      /* Android runs edge-to-edge here, so its window does not resize and
         `undefined` left the password field behind the keys. The measured
         height below does the lifting on both platforms; this only smooths
         the iOS animation. */
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: C.surface }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: insets.top,
          paddingBottom: 40 + (Platform.OS === 'android' ? keyboardHeight : 0),
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        showsVerticalScrollIndicator={false}>
        {/* The masthead gives up its space while typing. On a small phone that
            96px is the difference between seeing the password field and not,
            and nobody needs the logo while they are entering a password. */}
        <View style={{ height: keyboardHeight > 0 ? 24 : 96 }} />

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 28, height: 28, backgroundColor: C.primary, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 10, height: 10, backgroundColor: C.lime, borderRadius: 3 }} />
          </View>
          <Text style={[{ fontSize: 18, color: C.ink, letterSpacing: -0.18 }, weight(600)]}>MBOS</Text>
        </View>

        <Text style={[type.h2, { marginTop: 28 }]}>Sign in</Text>
        <Text style={[type.body, { color: C.muted, marginTop: 6 }]}>
          Mahek field sales. Your accounts team sets this up — there is no sign-up.
        </Text>

        {/* ---- the check ladder ---- */}
        {stage === 'verifying' ? (
          <View style={{ borderWidth: 1, borderColor: C.border, backgroundColor: C.wash, borderRadius: radius.xl, padding: 16, marginTop: 24 }}>
            {steps.map((label, i) => {
              const done = step > i;
              const now = step === i;
              return (
                <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
                  <View
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      backgroundColor: done ? C.lime : now ? C.primary : C.hairline,
                    }}
                  />
                  <Text style={{ fontSize: 14, color: done || now ? C.ink : C.muted }}>{label}</Text>
                </View>
              );
            })}
            <Pressable
              onPress={() => { setStage('form'); setStep(0); }}
              style={{ width: '100%', height: HIT, marginTop: 12, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 15, color: C.muted }}>Cancel</Text>
            </Pressable>
          </View>
        ) : null}

        {/* ---- the form ---- */}
        {stage === 'form' ? (
          <View style={{ marginTop: 24 }}>
            {err === 'inactive' ? (
              <View style={{ backgroundColor: C.dangerBg, borderLeftWidth: 3, borderLeftColor: C.danger, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 16 }}>
                <Text style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>
                  {serverMessage ?? 'This account is not active. Ask your sales manager to switch it back on.'}
                </Text>
              </View>
            ) : null}

            <Text style={[type.label, { marginBottom: 6 }]}>Mobile number</Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                height: 52,
                borderWidth: 1,
                borderColor: err === 'mob' ? C.danger : C.border,
                borderRadius: radius.lg,
                backgroundColor: C.surface,
                overflow: 'hidden',
              }}>
              {/* The dial code is a short fixed list, so it cycles rather than
                  opening a picker over a field the thumb is already on. */}
              <Pressable
                onPress={() => {
                  const codes = ['+91', '+971', '+977', '+880', '+94'];
                  set({ dial: codes[(codes.indexOf(dial) + 1) % codes.length] });
                }}
                style={{ height: '100%', paddingLeft: 10, paddingRight: 6, justifyContent: 'center' }}>
                <Text style={{ fontSize: 16, color: C.ink }}>{dial}</Text>
              </Pressable>
              <View style={{ width: 1, height: 24, backgroundColor: C.border }} />
              <TextInput
                value={groupMobile(mob)}
                onChangeText={(v) => {
                  /* Digits only, and never more than ten. An Indian mobile is
                     ten digits; letting an eleventh be typed only produces a
                     refusal later, after the password has been entered too. */
                  set({ mob: v.replace(/[^0-9]/g, '').slice(0, MOBILE_DIGITS) });
                  setErr(null);
                  setServerMessage(null);
                }}
                maxLength={MOBILE_DIGITS + 1}
                placeholder="98250 41172"
                placeholderTextColor={C.faint}
                keyboardType="phone-pad"
                style={{ flex: 1, height: '100%', paddingHorizontal: 12, fontSize: 16, color: C.ink }}
              />
            </View>
            {err === 'mob' ? (
              <Text style={{ fontSize: 14, color: C.danger, marginTop: 6 }}>
                {/* The server's own sentence wins. It names the reason — no
                    such account, already signed in on another handset, the
                    book would not load — and each sends the person somewhere
                    different. The digit count is only ever right when nothing
                    reached the server, and printing it over a real refusal is
                    how a valid ten-digit number came to be told it was not
                    ten digits. */}
                {serverMessage
                  ? serverMessage
                  : mob.length === 0
                    ? 'Enter your mobile number.'
                    : `That is ${mob.length} digits — a mobile number has ${MOBILE_DIGITS}.`}
              </Text>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 20, backgroundColor: C.wash, borderRadius: radius.xl, padding: 4 }}>
              {(['password', 'otp'] as const).map((m) => {
                const on = method === m;
                return (
                  <Pressable
                    key={m}
                    onPress={() => { set({ method: m }); setErr(null); setServerMessage(null); }}
                    style={[
                      { flex: 1, minHeight: HIT, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? C.surface : 'transparent' },
                      on && { boxShadow: '0 1px 3px rgba(22,22,22,0.08)' },
                    ]}>
                    <Text style={[{ fontSize: 15, color: on ? C.ink : C.muted }, weight(on ? 600 : 400)]}>
                      {m === 'password' ? 'Password' : 'SMS code'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {method === 'password' ? (
              <View>
                <Text style={[type.label, { marginTop: 16, marginBottom: 6 }]}>Password</Text>
                <View style={{ position: 'relative' }}>
                  <TextInput
                    value={pw}
                    onChangeText={(v) => { set({ pw: v }); setErr(null); setServerMessage(null); }}
                    placeholder="••••••••"
                    placeholderTextColor={C.faint}
                    secureTextEntry={!pwShow}
                    style={{
                      width: '100%',
                      height: 52,
                      borderWidth: 1,
                      borderColor: err === 'pw' ? C.danger : C.border,
                      borderRadius: radius.md,
                      paddingLeft: 12,
                      paddingRight: 68,
                      fontSize: 14,
                      color: C.ink,
                      backgroundColor: C.surface,
                    }}
                  />
                  <Pressable
                    onPress={() => setPwShow(!pwShow)}
                    style={{ position: 'absolute', right: 2, top: 2, height: HIT, minWidth: 64, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 14, color: C.muted }}>{pwShow ? 'Hide' : 'Show'}</Text>
                  </Pressable>
                </View>
                {err === 'pw' ? (
                  <Text style={{ fontSize: 14, color: C.danger, marginTop: 6 }}>
                    {serverMessage ?? 'Password must be at least 8 characters.'}
                  </Text>
                ) : null}

                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 20 }}>
                  <Text style={{ fontSize: 15, color: C.body }}>Remember me</Text>
                  <Toggle on={remember} onPress={() => set({ remember: !remember })} />
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 15, color: C.body }}>Use fingerprint next time</Text>
                    <Text style={{ fontSize: 13, color: C.muted }}>Faster on site, no typing</Text>
                  </View>
                  <Toggle on={bio} onPress={() => set({ bio: !bio })} />
                </View>

                <PrimaryButton label="Sign in" onPress={() => void submit()} style={{ marginTop: 24 }} />

                {bio ? (
                  <Pressable
                    onPress={() => void submit(true)}
                    style={{ width: '100%', height: 52, marginTop: 12, borderRadius: radius.md, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                    <Icon name="finger" size={24} color={C.primary} strokeWidth={1.5} />
                    <Text style={[{ fontSize: 15, color: C.body }, weight(500)]}>Fingerprint</Text>
                  </Pressable>
                ) : null}

                <Pressable
                  onPress={() => notify('Reset flow — three steps, mobile then OTP then new password')}
                  style={{ width: '100%', height: HIT, marginTop: 8, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={[{ fontSize: 15, color: C.primary }, weight(500)]}>Forgot password</Text>
                </Pressable>
              </View>
            ) : (
              <View>
                <Text style={[type.body, { color: C.muted, marginTop: 16 }]}>
                  We send a six-digit code by SMS. No password to remember.
                </Text>
                <PrimaryButton
                  label="Send the code"
                  onPress={() => {
                    if (mob.length !== MOBILE_DIGITS) return setErr('mob');
                    setStage('otp');
                    setOtp('');
                    setOtpErr(false);
                    notify('Code sent by SMS');
                  }}
                  style={{ marginTop: 24 }}
                />
              </View>
            )}
          </View>
        ) : null}

        {/* ---- the code ---- */}
        {stage === 'otp' ? (
          <View style={{ marginTop: 24 }}>
            <Pressable
              onPress={() => { setStage('form'); setOtp(''); setOtpErr(false); }}
              style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: HIT, marginTop: -8, marginLeft: -8, paddingHorizontal: 8 }}>
              <Text style={{ fontSize: 18, lineHeight: 18, color: C.muted }}>‹</Text>
              <Text style={{ fontSize: 15, color: C.muted }}>Change number</Text>
            </Pressable>

            <Text style={[type.body, { color: C.body, marginTop: 8 }]}>
              Code sent to <Text style={[{ color: C.ink }, weight(600)]}>{masked}</Text>
            </Text>

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 20 }}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <View
                  key={i}
                  style={{
                    flex: 1,
                    height: 56,
                    borderRadius: radius.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: 1,
                    borderColor: otpErr ? C.danger : digits[i] ? C.primary : C.border,
                    backgroundColor: digits[i] ? C.primaryTint : C.surface,
                  }}>
                  <Text style={[{ fontSize: 22, color: C.ink }, weight(600)]}>{digits[i] ?? ''}</Text>
                </View>
              ))}
            </View>

            <TextInput
              value={otp}
              onChangeText={(v) => { setOtp(v.replace(/[^0-9]/g, '').slice(0, 6)); setOtpErr(false); }}
              placeholder="Type the six digits"
              placeholderTextColor={C.faint}
              keyboardType="number-pad"
              maxLength={6}
              style={{ width: '100%', height: 52, marginTop: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: C.border, borderRadius: radius.lg, fontSize: 16, color: C.ink, backgroundColor: C.surface }}
            />
            {otpErr ? (
              <Text style={{ fontSize: 14, color: C.danger, marginTop: 8 }}>That code is not right. Check the SMS again.</Text>
            ) : null}

            {/* The one button on this screen that was hand-rolled. Through the
                primitive it gets the same press feedback, the same disabled
                treatment and the same explanation as every other. */}
            <PrimaryButton
              label="Sign in"
              onPress={() => (digits.length === 6 ? void submit(true) : notify('Type all six digits'))}
              disabled={digits.length !== 6}
              whyDisabled="Type all six digits from the SMS."
              style={{ marginTop: 16 }}
            />

            <Pressable
              onPress={() => notify('Code sent again to ' + masked)}
              style={{ width: '100%', height: HIT, marginTop: 8, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={[{ fontSize: 15, color: C.primary }, weight(500)]}>Send it again</Text>
            </Pressable>
            <Text style={[type.caption, { marginTop: 8 }]}>
              No SMS on site? Go back and sign in with your password instead.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
