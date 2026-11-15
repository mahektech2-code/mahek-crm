import React from 'react';
import { Animated, AppState, View, Text, Pressable, ScrollView, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { color as C, tabular, weight } from '../src/theme/tokens';
import { Glyph, type GlyphShape } from '../src/components/me/kit';
import { PrimaryButton, Toggle } from '../src/components/ui/primitives';
import { useStore } from '../src/state/store';
import { useBoot } from '../src/state/boot';
import { openPasswordReset, signIn as signInReal, type LoginStep } from '../src/data/session';
import { useKeyboardHeight } from '../src/components/ui/keyboard';
import * as Clipboard from 'expo-clipboard';
import { otpAvailable, requestOtp, ApiError } from '../src/sync/api';
import { otpFromClipboard } from '../src/engines/otp-clipboard';
import { Appear, Pop, Pulse, usePressScale, useShake } from '../src/components/ui/motion';
import { feedback } from '../src/components/ui/feedback';
import type { FeedbackKind } from '../src/engines/feedback';

/**
 * Sign in.
 *
 * An account can be refused for being closed, for not holding the field app,
 * or because the handset belongs to somebody else, and each has a different
 * answer for the person holding the phone — so a refusal lands on the part of
 * the screen it is about rather than as one red line under the number.
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
  const [err, setErr] = React.useState<'mob' | 'pw' | 'inactive' | 'payload' | 'network' | null>(null);
  const [pwShow, setPwShow] = React.useState(false);
  /* Password, or a code on WhatsApp — the second offered only once the
     server says it can send one (`/api/mbos/auth/otp`). */
  const [method, setMethod] = React.useState<'password' | 'code'>('password');
  const [codeOffered, setCodeOffered] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [codeSentTo, setCodeSentTo] = React.useState<string | null>(null);
  const [sendingCode, setSendingCode] = React.useState(false);

  /*
   * A REFUSAL SHAKES THE FORM, and says it in the hand too.
   *
   * The red line under a field is easy to miss on a phone held at waist
   * height in sunlight, and this screen has no toast to carry the news. The
   * shake sits on a wrapper that is mounted in BOTH stages, so a refusal that
   * arrives from the server — which swaps the check ladder back out for the
   * form in the same breath — still has a view on screen to move.
   *
   * The buzz is chosen per refusal rather than fixed on the hook: something
   * he typed is a `warning`, a code that would not send or a book that would
   * not save is a failure, `error`.
   */
  const { shake, style: shakeStyle } = useShake(null);
  const refuse = (kind: FeedbackKind = 'warning') => {
    feedback(kind);
    shake();
  };

  /* Asked again whenever the app comes back to the front: opened in a lane
     with no signal, the first answer is "no", and the WhatsApp option used to
     stay hidden until the app was restarted. */
  React.useEffect(() => {
    let live = true;
    const ask = () => otpAvailable().then((v) => { if (live) setCodeOffered(v); }).catch(() => {});
    void ask();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') void ask(); });
    return () => { live = false; sub.remove(); };
  }, []);

  /* The wait the server asked for after too many codes, counted down on the
     button rather than refused again on every press. */
  const [codeWait, setCodeWait] = React.useState(0);
  React.useEffect(() => {
    if (codeWait <= 0) return;
    const t = setTimeout(() => setCodeWait((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [codeWait]);

  async function sendCode() {
    if (sendingCode || codeWait > 0) return;
    if (mob.length !== MOBILE_DIGITS) {
      refuse();
      return setErr('mob');
    }
    setSendingCode(true);
    setErr(null);
    setServerMessage(null);
    try {
      const r = await requestOtp(mob.trim());
      setCodeSentTo(r.sentTo);
    } catch (e) {
      setErr('pw');
      setServerMessage(e instanceof ApiError && e.message ? e.message : 'Code not sent. Check your signal, or use your password.');
      if (e instanceof ApiError && e.retryInSeconds) setCodeWait(Math.ceil(e.retryInSeconds));
      refuse('error');
    } finally {
      setSendingCode(false);
    }
  }
  /* What the server actually said, shown verbatim — a generic "sign-in failed"
     leaves the salesman with nothing to do about it. */
  const [serverMessage, setServerMessage] = React.useState<string | null>(null);

  /*
   * THE OTP IS CAUGHT OFF THE CLIPBOARD, because it cannot be caught anywhere
   * else. MiniMoth sends it on WhatsApp first, and no app may read another
   * app's WhatsApp messages — the only way in is Android's notification
   * access, which would hand MBOS every notification on the phone. So the
   * salesman taps "Copy code" in WhatsApp (or long-presses the message), comes
   * back, and the screen fills the OTP in and signs him in: two taps and no
   * typing. A code arriving by SMS is still offered by the keyboard through
   * `autoComplete="sms-otp"` below.
   *
   * Read only on the way BACK to the app, only once an OTP has been sent, and
   * only while the form is waiting for one — never as a habit, because on
   * Android 12 and later every read shows a "pasted from clipboard" notice.
   * `hasStringAsync` asks without reading, so an empty clipboard costs nothing.
   * A code is submitted at most once: the same copied code coming back after a
   * refusal must not spend a second try.
   */
  const triedCodes = React.useRef<Set<string>>(new Set());
  const submitRef = React.useRef<(override?: string) => Promise<void>>(async () => {});
  React.useEffect(() => { submitRef.current = submit; });
  React.useEffect(() => {
    if (method !== 'code' || !codeSentTo || stage !== 'form') return;
    let live = true;
    const catchCode = async () => {
      try {
        if (!(await Clipboard.hasStringAsync())) return;
        const found = otpFromClipboard(await Clipboard.getStringAsync(), triedCodes.current);
        if (!found || !live) return;
        triedCodes.current.add(found);
        setCode(found);
        setErr(null);
        setServerMessage(null);
        void submitRef.current(found);
      } catch {
        /* The clipboard is a convenience; typing the OTP still works. */
      }
    };
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') void catchCode(); });
    return () => { live = false; sub.remove(); };
  }, [method, codeSentTo, stage]);

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
   * TWO STEPS, because there are only two things the phone can see.
   *
   * It used to draw five — mobile, password, status, area, day — and claim
   * they were real checks rather than a timer. They were neither: the server
   * runs all five and answers once, so "Checking mobile" pulsed for the whole
   * wait and the other four flashed green together at the end. What the phone
   * actually knows is whether MahekOne has answered, and whether the book it
   * sent has been saved here.
   */
  const STEP_INDEX: Record<LoginStep, number> = {
    mobile: 0, credential: 0, status: 0, territory: 0, network: 0, payload: 1,
  };

  async function submit(override?: string) {
    const typed = (override ?? code).replace(/\D/g, '');
    /* One at a time. Two overlapping sign-ins are two `setTokens`, two
       persists and two bootstraps writing into the same database. */
    if (stage === 'verifying') return;
    if (mob.length !== MOBILE_DIGITS) {
      refuse();
      return setErr('mob');
    }
    if (method === 'password' && pw.length < 8) {
      refuse();
      return setErr('pw');
    }
    if (method === 'code' && typed.length < 4) {
      setServerMessage(codeSentTo ? 'Enter the OTP.' : 'Send yourself an OTP first.');
      refuse();
      return setErr('pw');
    }

    setErr(null);
    setServerMessage(null);
    setStage('verifying');
    setStep(0);

    const attempt = ++attemptRef.current;
    const live = () => !cancelled.current && attemptRef.current === attempt;

    const outcome = await signInReal({
      mobile: mob.trim(),
      ...(method === 'code' ? { otp: typed } : { password: pw }),
      remember,
      onStep: (s) => { if (live()) setStep(STEP_INDEX[s]); },
      /* Cancel now stops the attempt WRITING, not only the screen reacting:
         an answer that arrives after Cancel is not stored. */
      cancelled: () => !live(),
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
          : outcome.step === 'network'
            ? 'network'
            : outcome.step === 'status' || outcome.step === 'territory'
              ? 'inactive'
              : outcome.step === 'credential'
                ? 'pw'
                : 'mob',
      );
      setServerMessage(outcome.message);
      /* A wrong password or an account switched off is a refusal; a book
         that would not save on this phone is a failure. */
      refuse(outcome.step === 'payload' || outcome.step === 'network' ? 'error' : 'warning');
      return;
    }

    signIn();
    boot.setSession(outcome.session);
    if (outcome.offline) notify('Signed in without signal. Your data is from the last time you had signal.', 'warn');
    router.replace('/home');
  }

  const signInPress = usePressScale();

  const steps = ['Checking your sign-in with MahekOne', 'Saving your day on this phone'];

  /* The splash stays up until the database has been opened and the stored
     session read. Drawn before that, the whole form appears on every cold
     start and is then yanked away by the redirect above — long enough after an
     update, when the migrations actually run, for somebody to have started
     typing into it. */
  if (!boot.ready) return null;

  const typing = keyboardHeight > 0;
  /* The digit count rides in the box while it is wrong, and only while the
     sentence under it is the count — a server refusal names its own reason. */
  const countChip = err === 'mob' && !serverMessage && mob.length > 0;
  const banner =
    err === 'payload'
      ? (serverMessage ?? "Signed in, but today's data was not saved on this phone.") +
        ' Try again. If it keeps happening, tell your manager.'
      : err === 'network'
        ? (serverMessage ?? 'No internet. Could not reach MahekOne.')
        : err === 'inactive'
          ? (serverMessage ?? 'This account cannot be used right now. Ask your manager.')
          : null;

  return (
    <KeyboardAvoidingView
      /* Android runs edge-to-edge here, so its window does not resize and
         `undefined` left the password field behind the keys. The measured
         height below does the lifting on both platforms; this only smooths
         the iOS animation. */
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: C.canvas }}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingBottom: 26 + insets.bottom + (Platform.OS === 'android' ? keyboardHeight : 0),
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        showsVerticalScrollIndicator={false}>
        {/* ---- the masthead ----
            The navy block reaches the top of the glass and gives up most of
            its height while typing. On a small phone that space is the
            difference between seeing the password field and not, and nobody
            needs the logo while they are entering a password. */}
        <View
          style={{
            backgroundColor: C.navy,
            paddingTop: insets.top + (typing ? 16 : 56),
            paddingHorizontal: 20,
            paddingBottom: 64,
            borderBottomLeftRadius: 28,
            borderBottomRightRadius: 28,
          }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 36, height: 36, backgroundColor: C.primary, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 12, height: 12, backgroundColor: C.lime, borderRadius: 4 }} />
            </View>
            <Text style={[{ fontSize: 17, color: '#FFFFFF' }, weight(700)]}>Mahek MBOS</Text>
          </View>
          <Text
            accessibilityRole="header"
            style={[{ fontSize: 32, lineHeight: 38, letterSpacing: -0.64, color: '#FFFFFF', marginTop: typing ? 14 : 28 }, weight(800)]}>
            Sign in
          </Text>
          <View
            accessible
            accessibilityLabel="Mahek field sales. Your manager has your account made for you. There is no sign-up."
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <Glyph shapes={[{ p: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' }]} size={14} color={C.onNavyMuted} />
            <Text style={{ flex: 1, fontSize: 13, color: C.onNavyMuted }}>
              Mahek field sales · your manager makes your account · no sign-up
            </Text>
          </View>
        </View>

        {/* One wrapper for both stages: it carries the refusal shake (see
            `refuse`), and the Appear inside it is keyed on the stage, so the
            form settles in on arrival and the ladder settles in over it. */}
        <Animated.View style={[shakeStyle, { marginTop: -36, marginHorizontal: 14 }]}>
        <Appear key={stage}>
        <View
          style={{
            backgroundColor: C.surface,
            borderRadius: 24,
            padding: 18,
            paddingTop: stage === 'verifying' ? 20 : 18,
            paddingBottom: stage === 'verifying' ? 10 : 18,
            boxShadow: '0 14px 34px -12px rgba(15,27,51,0.28)',
          }}>
        {/* ---- the check ladder ---- */}
        {stage === 'verifying' ? (
          <View>
            {steps.map((label, i) => {
              const done = step > i;
              const now = step === i;
              return (
                <View key={label}>
                  {i ? <View style={{ marginLeft: 15, width: 2, height: 14, backgroundColor: C.primaryEdge }} /> : null}
                  <View
                    accessible
                    accessibilityLabel={`${label}: ${done ? 'done' : now ? 'checking now' : 'waiting'}`}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 14, height: 52 }}>
                    {/* The step being checked breathes — it is waiting on the
                        server, and a still dot reads as stuck — and a step
                        passed pops as it turns lime. These are real checks,
                        so the movement follows the answers, not a timer. */}
                    <Pop trigger={done}>
                      <Pulse active={now}>
                        <View
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 16,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: done ? C.lime : now ? C.primary : C.hairline,
                            boxShadow: now ? '0 0 0 7px #E0D6FD' : undefined,
                          }}>
                          {done ? (
                            <Glyph shapes={[{ p: 'M5 12l5 5 9-10' }]} size={16} color={C.navy} strokeWidth={2.6} />
                          ) : now ? (
                            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#FFFFFF' }} />
                          ) : null}
                        </View>
                      </Pulse>
                    </Pop>
                    <Glyph shapes={i === 0 ? CLOUD : PHONE} size={16} color={done || now ? C.ink : C.muted} />
                    <Text style={[{ flex: 1, fontSize: 15, color: done || now ? C.ink : C.muted }, weight(700)]}>{label}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        {/* ---- the form ---- */}
        {stage === 'form' ? (
          <View>
            {banner ? (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: C.dangerBg, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 14 }}>
                <Glyph shapes={err === 'network' ? NO_CLOUD : err === 'payload' ? PHONE : PERSON_X} size={20} color={C.danger} />
                <Text style={[{ flex: 1, fontSize: 14, lineHeight: 20, color: C.danger }, weight(600)]}>{banner}</Text>
              </View>
            ) : null}

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Glyph shapes={PHONE} size={14} color={C.ink} />
              <Text style={[{ fontSize: 13, color: C.ink }, weight(700)]}>Mobile number</Text>
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                height: 56,
                marginTop: 8,
                borderWidth: err === 'mob' ? 2 : 1,
                borderColor: err === 'mob' ? C.danger : C.border,
                borderRadius: 18,
                backgroundColor: C.surface,
                overflow: 'hidden',
              }}>
              {/* Not a control — see `DIAL`. */}
              <Text style={[{ paddingLeft: 16, paddingRight: 10, fontSize: 17, color: C.muted }, weight(600)]}>{DIAL}</Text>
              <TextInput
                value={groupMobile(mob)}
                onChangeText={(v) => {
                  /* Digits only, and never more than ten. An Indian mobile is
                     ten digits; letting an eleventh be typed only produces a
                     refusal later, after the password has been entered too. */
                  const next = v.replace(/[^0-9]/g, '').slice(0, MOBILE_DIGITS);
                  /* A code was sent to the OLD number. Keeping "Sent to …" and
                     the typed code beside a different number is how somebody
                     signs in with a code that can only ever be refused. */
                  if (next !== mob) {
                    setCodeSentTo(null);
                    setCode('');
                  }
                  set({ mob: next });
                  setErr(null);
                  setServerMessage(null);
                }}
                maxLength={MOBILE_DIGITS + 1}
                placeholder="98250 41172"
                placeholderTextColor={C.faint}
                keyboardType="phone-pad"
                accessibilityLabel="Mobile number"
                style={[{ flex: 1, height: '100%', paddingRight: 12, fontSize: 17, letterSpacing: 0.34, color: C.ink }, weight(600)]}
              />
              {countChip ? (
                <View style={{ marginRight: 12, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: C.dangerBg, justifyContent: 'center' }}>
                  <Text style={[{ fontSize: 12, color: C.danger }, weight(700)]}>{`${mob.length}/${MOBILE_DIGITS}`}</Text>
                </View>
              ) : null}
            </View>
            {err === 'mob' ? (
              <Text style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>
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
                    : `You typed ${mob.length} digits. A mobile number has ${MOBILE_DIGITS}.`}
              </Text>
            ) : null}

            {/* THE METHOD TOGGLE IS BACK, and only where it works. It was
                removed because "SMS code" sent nothing — there was no route
                behind it. `/api/mbos/auth/otp` now sends a real code on
                WhatsApp, and this screen asks it first: no toggle is drawn on
                a deployment that cannot send one. */}
            {codeOffered ? (
              <View accessibilityRole="tablist" style={{ flexDirection: 'row', marginTop: 16, height: 48, borderRadius: 24, backgroundColor: C.canvas, padding: 4 }}>
                {(['password', 'code'] as const).map((m) => {
                  const on = method === m;
                  const ink = on ? '#FFFFFF' : C.muted;
                  return (
                    <Pressable
                      key={m}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: on }}
                      onPress={() => { if (!on) feedback('select'); setMethod(m); setErr(null); setServerMessage(null); }}
                      style={{ flex: 1, borderRadius: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: on ? C.navy : 'transparent' }}>
                      <Glyph shapes={m === 'password' ? LOCK : CHAT} size={15} color={ink} />
                      <Text style={[{ fontSize: 14, color: ink }, weight(700)]}>{m === 'password' ? 'Password' : 'OTP'}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
              <View>
                {method === 'password' ? (<>
                <View
                  style={{
                    marginTop: 14,
                    height: 56,
                    borderRadius: 18,
                    borderWidth: err === 'pw' ? 2 : 1,
                    borderColor: err === 'pw' ? C.danger : C.border,
                    backgroundColor: C.surface,
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingLeft: 14,
                  }}>
                  <Glyph shapes={LOCK} size={18} color={C.muted} />
                  <TextInput
                    value={pw}
                    onChangeText={(v) => { set({ pw: v }); setErr(null); setServerMessage(null); }}
                    placeholder="Password"
                    placeholderTextColor={C.faint}
                    accessibilityLabel="Password"
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
                    style={[
                      {
                        flex: 1,
                        height: '100%',
                        paddingHorizontal: 12,
                        /* 17, like the mobile field above it. Smaller, the dots
                           are harder to count in sunlight, on the one field
                           that cannot be read back. */
                        fontSize: 17,
                        color: C.ink,
                      },
                      weight(600),
                    ]}
                  />
                  <Pressable
                    onPress={() => setPwShow(!pwShow)}
                    accessibilityRole="button"
                    accessibilityLabel={pwShow ? 'Hide password' : 'Show password'}
                    style={{ width: 48, height: 48, marginRight: 4, borderRadius: 24, alignItems: 'center', justifyContent: 'center' }}>
                    <Glyph shapes={pwShow ? EYE_OFF : EYE} size={20} color={C.muted} />
                  </Pressable>
                </View>
                {err === 'pw' ? (
                  <Text style={{ fontSize: 13, color: C.danger, marginTop: 6 }}>
                    {serverMessage ?? 'Password must be at least 8 characters.'}
                  </Text>
                ) : null}
                </>) : (
                  <View style={{ marginTop: 14 }}>
                    {codeSentTo ? (
                      <>
                        {/* ONE box for the code, drawn as six. A single input
                            keeps the keyboard's SMS suggestion and the
                            clipboard fill working; the digit boxes under it are
                            only how it looks. */}
                        <View style={{ position: 'relative' }}>
                          <View style={{ flexDirection: 'row', gap: 8 }} pointerEvents="none">
                            {Array.from({ length: Math.max(OTP_BOXES, code.length) }, (_, i) => (
                              <View
                                key={i}
                                style={{
                                  flex: 1,
                                  height: 56,
                                  borderRadius: 16,
                                  borderWidth: err === 'pw' ? 2 : i === code.length ? 2 : 1,
                                  borderColor: err === 'pw' ? C.danger : i === code.length ? C.primary : C.border,
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}>
                                <Text style={[{ fontSize: 22, color: C.ink }, weight(800)]}>{code[i] ?? ''}</Text>
                              </View>
                            ))}
                          </View>
                          <TextInput
                            value={code}
                            onChangeText={(v) => { setCode(v.replace(/\D/g, '').slice(0, 8)); setErr(null); setServerMessage(null); }}
                            accessibilityLabel="OTP"
                            keyboardType="number-pad"
                            textContentType="oneTimeCode"
                            autoComplete="sms-otp"
                            caretHidden
                            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, color: 'transparent', fontSize: 1, opacity: 0.02 }}
                          />
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
                          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Glyph shapes={CHAT} size={14} color={C.muted} />
                            <Text style={{ flexShrink: 1, fontSize: 13, color: C.muted }}>Sent to {codeSentTo}</Text>
                          </View>
                          <Pressable
                            onPress={() => void sendCode()}
                            disabled={sendingCode || codeWait > 0}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={sendingCode ? 'Sending…' : codeWait > 0 ? `Send again in ${codeWait}s` : 'Send again'}
                            accessibilityState={{ disabled: sendingCode || codeWait > 0 }}
                            style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: C.canvas, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Glyph shapes={RETRY} size={14} color={codeWait > 0 || sendingCode ? C.muted : C.primaryDeep} />
                            <Text style={[{ fontSize: 13, color: codeWait > 0 || sendingCode ? C.muted : C.primaryDeep }, weight(700), tabular]}>
                              {sendingCode ? 'Sending…' : codeWait > 0 ? `${codeWait}s` : 'Send again'}
                            </Text>
                          </Pressable>
                        </View>
                      </>
                    ) : (
                      <>
                        <PrimaryButton
                          tone="navy"
                          label={
                            sendingCode
                              ? 'Sending…'
                              : codeWait > 0
                                ? `Wait ${codeWait}s to send another OTP`
                                : 'Send OTP'
                          }
                          disabled={sendingCode || codeWait > 0}
                          whyDisabled={sendingCode ? 'Sending the OTP now.' : 'MahekOne asked us to wait before sending another OTP.'}
                          onPress={() => void sendCode()}
                          style={{ height: 56, borderRadius: 28 }}
                        />
                        {codeWait > 0 && !sendingCode ? (
                          <Text style={{ fontSize: 12, color: C.muted, marginTop: 6, textAlign: 'center' }}>
                            MahekOne asked us to wait before sending another
                          </Text>
                        ) : null}
                      </>
                    )}
                    {err === 'pw' && serverMessage ? (
                      <View style={{ marginTop: 8, minHeight: 36, borderRadius: 12, backgroundColor: C.dangerBg, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8 }}>
                        <Glyph shapes={WARN} size={14} color={C.danger} />
                        <Text style={[{ flex: 1, fontSize: 13, color: C.danger }, weight(600)]}>{serverMessage}</Text>
                      </View>
                    ) : null}
                  </View>
                )}

                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 10, minHeight: 44 }}>
                  <Text style={[{ fontSize: 15, color: C.ink }, weight(600)]}>Remember me</Text>
                  <Toggle on={remember} label="Remember me" onPress={() => set({ remember: !remember })} />
                </View>
              </View>
          </View>
        ) : null}
        </View>
        </Appear>
        </Animated.View>

        {/* The actions sit at the foot of the screen, and ride up with the
            keyboard rather than being covered by it. */}
        <View style={{ flex: 1, minHeight: 20 }} />
        <View style={{ marginHorizontal: 14 }}>
          {stage === 'verifying' ? (
            <Pressable
              /* Bumping the attempt is what makes this a cancel rather than a
                 change of scenery — the request cannot be recalled, but its
                 answer is now somebody else's and is dropped. */
              onPress={() => { attemptRef.current += 1; setStage('form'); setStep(0); }}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={({ pressed }) => ({
                height: 60,
                borderRadius: 30,
                borderWidth: 1,
                borderColor: C.border,
                backgroundColor: pressed ? C.wash : C.surface,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              })}>
              <Glyph shapes={[{ p: 'M6 6l12 12M18 6L6 18' }]} size={18} color={C.ink} />
              <Text style={[{ fontSize: 17, color: C.ink }, weight(700)]}>Cancel</Text>
            </Pressable>
          ) : (
            <>
              <Animated.View style={signInPress.style}>
                <Pressable
                  onPress={() => void submit()}
                  onPressIn={signInPress.onPressIn}
                  onPressOut={signInPress.onPressOut}
                  accessibilityRole="button"
                  accessibilityLabel="Sign in"
                  style={({ pressed }) => ({
                    height: 60,
                    borderRadius: 30,
                    backgroundColor: C.navy,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    opacity: pressed ? 0.9 : 1,
                    boxShadow: '0 12px 30px -10px rgba(15,27,51,0.5)',
                  })}>
                  <Text style={[{ fontSize: 17, color: '#FFFFFF' }, weight(700)]}>Sign in</Text>
                  <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: C.lime, alignItems: 'center', justifyContent: 'center' }}>
                    <Glyph shapes={[{ p: 'M5 12h14M13 6l6 6-6 6' }]} size={16} color={C.navy} strokeWidth={2.4} />
                  </View>
                </Pressable>
              </Animated.View>

              <Pressable
                onPress={async () => {
                  const opened = await openPasswordReset();
                  notify(
                    opened
                      ? 'Opening the reset page. Use your work email, or an OTP if it offers one.'
                      : 'Could not open the browser. Ask your manager to reset your password.',
                    opened ? 'info' : 'error',
                  );
                }}
                accessibilityRole="button"
                style={{ width: '100%', height: 48, marginTop: 6, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={[{ fontSize: 15, color: C.primaryDeep }, weight(700)]}>Forgot password</Text>
              </Pressable>
            </>
          )}
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** How many boxes the OTP is drawn in. A longer code grows the row. */
const OTP_BOXES = 6;

/* The marks the Version 3 artboards draw on this screen. */
const PHONE: GlyphShape[] = [{ r: [7, 3, 10, 18, 2] }, { p: 'M11 18h2' }];
const CLOUD: GlyphShape[] = [{ p: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z' }];
const NO_CLOUD: GlyphShape[] = [{ p: 'M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z' }, { p: 'M4 4l16 16' }];
const PERSON_X: GlyphShape[] = [{ c: [9, 8, 4] }, { p: 'M2 21c0-4 3-6 7-6M16 14l5 5M21 14l-5 5' }];
const LOCK: GlyphShape[] = [{ r: [5, 11, 14, 10, 2] }, { p: 'M8 11V8a4 4 0 0 1 8 0v3' }];
const CHAT: GlyphShape[] = [{ p: 'M4 20l1.5-4A8 8 0 1 1 9 19z' }];
const EYE: GlyphShape[] = [{ p: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z' }, { c: [12, 12, 3] }];
const EYE_OFF: GlyphShape[] = [{ p: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z' }, { c: [12, 12, 3] }, { p: 'M4 4l16 16' }];
const RETRY: GlyphShape[] = [{ p: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6' }];
const WARN: GlyphShape[] = [{ p: 'M12 4l9 16H3z' }, { p: 'M12 10v4M12 17h.01' }];
