import React from 'react';
import { View, Text, Pressable, ScrollView, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color as C, HIT, radius, type, weight } from '../src/theme/tokens';
import { PrimaryButton, Toggle } from '../src/components/ui/primitives';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { openPasswordReset, signIn as signInReal, type LoginStep } from '../src/data/session';
import { useKeyboardHeight } from '../src/components/ui/keyboard';

/**
 * Sign in.
 *
 * The five checks the design shows running are not decoration. An account can
 * be refused for being inactive or for having no territory, and each has a
 * different answer for the person holding the phone — so the ladder names the
 * step it is on rather than showing one spinner and one eventual failure.
 */

type Stage = 'form' | 'verifying';

/** An Indian mobile number. Ten digits, no more, no fewer. */
const MOBILE_DIGITS = 10;

/**
 * The only dial code, drawn as a fact rather than as a control.
 *
 * It used to be a cycler — +91 → +971 → +977 → +880 → +94 — and `dial` was
 * never put in the request, so nothing it did reached the server; meanwhile
 * `MOBILE_DIGITS` is ten for every one of them, so a nine-digit +971 number was
 * refused by this screen before it got anywhere near MahekOne. A stray thumb
 * changed the country on a handset issued to Mahek's own field team in India
 * and made no difference to the sign-in either way.
 */
const DIAL = '+91';

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
  const mob = useStore((s) => s.mob);
  const pw = useStore((s) => s.pw);
  const remember = useStore((s) => s.remember);

  const [stage, setStage] = React.useState<Stage>('form');
  const [step, setStep] = React.useState(0);
  const [err, setErr] = React.useState<'mob' | 'pw' | 'inactive' | 'payload' | null>(null);
  const [pwShow, setPwShow] = React.useState(false);
  /* What the server actually said, shown verbatim — a generic "sign-in failed"
     leaves the salesman with nothing to do about it. */
  const [serverMessage, setServerMessage] = React.useState<string | null>(null);

  const boot = useBoot();
  const keyboardHeight = useKeyboardHeight();
  const cancelled = React.useRef(false);
  React.useEffect(() => () => { cancelled.current = true; }, []);

  /*
   * WHICH ATTEMPT THIS IS.
   *
   * `cancelled` is set on unmount and nowhere else, so Cancel — which only put
   * the form back — left the in-flight sign-in running, and it walked straight
   * past that guard on the way back: it signed him in, set the session and
   * replaced the route, minutes after he had pressed Cancel because he had
   * typed the wrong number. And the form being interactive again meant a second
   * `signIn` could be started on top of the first, two bootstraps racing into
   * one SQLite database. Every attempt takes a number; Cancel and the next
   * attempt both bump it, and an answer that is not the current number is
   * dropped rather than acted on.
   */
  const attemptRef = React.useRef(0);

  /* Already signed in — go straight to the day rather than showing a form the
     salesman has to dismiss every morning. */
  React.useEffect(() => {
    if (boot.ready && boot.session) router.replace('/home');
  }, [boot.ready, boot.session]);

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

  async function submit() {
    /* One at a time. Two overlapping sign-ins are two `setTokens`, two
       persists and two bootstraps writing into the same database. */
    if (stage === 'verifying') return;
    if (mob.length !== MOBILE_DIGITS) return setErr('mob');
    if (pw.length < 8) return setErr('pw');

    setErr(null);
    setServerMessage(null);
    setStage('verifying');
    setStep(0);

    const attempt = ++attemptRef.current;
    const live = () => !cancelled.current && attemptRef.current === attempt;

    const outcome = await signInReal({
      mobile: mob.trim(),
      password: pw,
      remember,
      onStep: (s) => { if (live()) setStep(STEP_INDEX[s]); },
    });

    if (!live()) return;

    if (!outcome.ok) {
      setStage('form');
      setStep(0);
      /*
       * WHICH ANSWER GOES WHERE.
       *
       * `payload` is the fifth check and it is about this phone's storage, not
       * about anything he typed — it used to fall through every arm of this
       * ternary onto `'mob'`, so a book that would not save put a red border
       * round a mobile number that was never wrong and asked him to retype it.
       * It gets the full-width banner, like the other two failures no field
       * can answer.
       */
      setErr(
        outcome.step === 'payload'
          ? 'payload'
          : outcome.step === 'status' || outcome.step === 'territory'
            ? 'inactive'
            : outcome.step === 'credential'
              ? 'pw'
              : 'mob',
      );
      setServerMessage(outcome.message);
      return;
    }

    signIn();
    boot.setSession(outcome.session);
    if (outcome.offline) notify('Signed in from this phone — your book is as of the last time you had signal');
    router.replace('/home');
  }

  const steps = [
    'Verifying mobile',
    'Verifying password',
    'Checking employee status',
    'Checking assigned territory',
    'Loading your day',
  ];

  /* The splash stays up until the database has been opened and the stored
     session read. Drawn before that, the whole form appears on every cold
     start and is then yanked away by the redirect above — long enough after an
     update, when the migrations actually run, for somebody to have started
     typing into it. */
  if (!boot.ready) return null;

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
              /* Bumping the attempt is what makes this a cancel rather than a
                 change of scenery — the request cannot be recalled, but its
                 answer is now somebody else's and is dropped. */
              onPress={() => { attemptRef.current += 1; setStage('form'); setStep(0); }}
              style={{ width: '100%', height: HIT, marginTop: 12, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 15, color: C.muted }}>Cancel</Text>
            </Pressable>
          </View>
        ) : null}

        {/* ---- the form ---- */}
        {stage === 'form' ? (
          <View style={{ marginTop: 24 }}>
            {err === 'inactive' || err === 'payload' ? (
              <View style={{ backgroundColor: C.dangerBg, borderLeftWidth: 3, borderLeftColor: C.danger, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 16 }}>
                <Text style={{ fontSize: 14, lineHeight: 20, color: C.ink }}>
                  {err === 'payload'
                    ? (serverMessage ?? "Signed in, but the day's data could not be saved on this phone.") +
                      ' Try again; if it keeps happening tell your manager, this one will not fix itself.'
                    : (serverMessage ?? 'This account is not active. Ask your sales manager to switch it back on.')}
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
              {/* Not a control — see `DIAL`. */}
              <View style={{ height: '100%', paddingLeft: 10, paddingRight: 6, justifyContent: 'center' }}>
                <Text style={{ fontSize: 16, color: C.muted }}>{DIAL}</Text>
              </View>
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

            {/* NO METHOD TOGGLE, AND NO SMS STAGE.
                It offered "SMS code" beside "Password" as a peer, and pressing
                "Send the code" made no request at all — it moved the screen to
                the code stage and toasted "Code sent by SMS". There is no OTP
                service: `/api/mbos/auth/otp`, the route this app's own
                `requestOtp` posts to, is not on the server. So the one method
                that needs no password sent a salesman to watch an inbox that
                would never receive anything. It follows the rule the microphone
                already follows — a control that fails when pressed is worse
                than one never offered — and is drawn only once there is a
                service behind it. */}
              <View>
                <Text style={[type.label, { marginTop: 16, marginBottom: 6 }]}>Password</Text>
                <View style={{ position: 'relative' }}>
                  <TextInput
                    value={pw}
                    onChangeText={(v) => { set({ pw: v }); setErr(null); setServerMessage(null); }}
                    placeholder="••••••••"
                    placeholderTextColor={C.faint}
                    secureTextEntry={!pwShow}
                    /*
                     * PRESSING "SHOW" USED TO CAPITALISE THE FIRST LETTER.
                     *
                     * While `secureTextEntry` is on, Android forces a password
                     * keyboard and none of this applies. The moment "Show"
                     * turns it off the box becomes an ordinary text input with
                     * React Native's default `autoCapitalize="sentences"` and
                     * the suggestion strip — so the person who taps Show first,
                     * which is exactly what somebody unsure of their typing
                     * does, types `Mahek1234`. A silent wrong character,
                     * refused as a bad password, on the one screen where being
                     * shut out costs the whole day.
                     */
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    textContentType="password"
                    style={{
                      width: '100%',
                      height: 52,
                      borderWidth: 1,
                      borderColor: err === 'pw' ? C.danger : C.border,
                      borderRadius: radius.md,
                      paddingLeft: 12,
                      paddingRight: 68,
                      /* 16, like the mobile field above it and the shared
                         `Input` primitive. At 14 the dots are harder to count
                         in sunlight, on the one field that cannot be read
                         back. */
                      fontSize: 16,
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

                <PrimaryButton label="Sign in" onPress={() => void submit()} style={{ marginTop: 24 }} />

                <Pressable
                  onPress={async () => {
                    const opened = await openPasswordReset();
                    notify(
                      opened
                        ? 'Opening the reset page. It emails a link to your work address.'
                        : 'Could not open the browser. Ask your manager to send you a reset link.',
                    );
                  }}
                  style={{ width: '100%', height: HIT, marginTop: 8, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={[{ fontSize: 15, color: C.primary }, weight(500)]}>Forgot password</Text>
                </Pressable>
              </View>
          </View>
        ) : null}

      </ScrollView>
    </KeyboardAvoidingView>
  );
}
