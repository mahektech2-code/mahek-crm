import React from 'react';
import { View, Text, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { useAudioRecorderState } from 'expo-audio';
import { File } from 'expo-file-system';
import { color as C, HIT, radius, type, weight } from '../../theme/tokens';
import { Icon } from './Icon';
import { BottomSheet } from './overlays';
import { Input } from './primitives';
import { getConfig } from '../../data/config';
import { prepareMicrophone, useDictationRecorder } from '../../native/capture';
import * as api from '../../sync/api';

/* ---------------------------------------------------------------------------
 * SPEAKING INTO A TEXT BOX, on a handset.
 *
 * The same feature the CRM gives a telecaller, and it is here for a stronger
 * version of the same reason. A telecaller types slowly with a customer on the
 * line; a salesman types on a phone, one-handed, standing in a shop, in the
 * rain, in a language he does not write. What got written was the short
 * version of what was actually said, and the loss is invisible afterwards —
 * "will pay" reads exactly like a sentence that never named a date or an
 * amount.
 *
 * Every decision below is the CRM's, because they were right there and they
 * are right here:
 *
 *   IT SHOWS THE FAITHFUL ENGLISH FIRST, not a summary. Tightening is a button
 *   pressed after reading it. A note that quietly lost the bill number reads
 *   exactly like one that never had it.
 *
 *   IT IS EDITABLE IN PLACE. Most corrections are one word.
 *
 *   IT NEVER OVERWRITES BY ACCIDENT. Where the box has words already, Add and
 *   Replace are two buttons and Add is the default one.
 *
 *   IT SHOWS WHAT WAS HEARD. The original-language line is one tap away,
 *   because the only way to catch a translation that went wrong is to read the
 *   sentence it came from.
 *
 * WHAT IS DIFFERENT HERE IS THE SIGNAL. A browser is online or it is broken; a
 * handset is offline for half the working day and that is ordinary. So the mic
 * distinguishes two things a browser never has to:
 *
 *   A DEPLOYMENT THAT CANNOT DICTATE draws nothing at all — dictation switched
 *   off, or no provider key. That is permanent, and a microphone that fails
 *   when pressed is worse than one never offered.
 *
 *   A HANDSET WITH NO BARS draws the mic, dimmed, and says why when pressed.
 *   That is temporary and it changes minute to minute, so hiding it would make
 *   a control appear and vanish while somebody looks at the screen, and they
 *   would learn it is not there. The visit note is the one field with an
 *   answer to this rather than an apology: it can record now and let the
 *   office write it out later, because a visit has somewhere to keep audio.
 *
 * NOTHING IS STORED. The recording is sent as the body of one request and the
 * file is deleted. There is no attachment row, no queue entry and no id to
 * fetch it back by — except where a caller asks for `keepAudio`, which is the
 * visit's voice note and a different thing with its own rules.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------ availability */

type Dictation =
  | { available: true; maxSeconds: number; canRefine: boolean }
  | { available: false };

/**
 * What the office said this deployment can do, read from the local cache.
 *
 * It arrives on the pull (`mbos.ai.dictation`) rather than being asked for at
 * the moment a screen draws, which is the whole difference between this and
 * the CRM's `/api/dictate`. A handset that had to ask would offer no
 * microphone in exactly the godown where speaking beats typing most.
 *
 * Unavailable until proven otherwise: a handset that has never completed a
 * bootstrap has no idea whether there is a provider behind this, and guessing
 * yes draws a button that cannot work.
 */
export function useDictation(): Dictation {
  const [state, setState] = React.useState<Dictation>({ available: false });

  React.useEffect(() => {
    let live = true;
    void getConfig<{ available?: boolean; maxSeconds?: number; canRefine?: boolean } | null>(
      'mbos.ai.dictation',
      null,
    ).then((cfg) => {
      if (!live) return;
      if (!cfg?.available) return setState({ available: false });
      setState({
        available: true,
        maxSeconds: Math.max(5, cfg.maxSeconds ?? 30),
        canRefine: cfg.canRefine !== false,
      });
    });
    return () => {
      live = false;
    };
  }, []);

  return state;
}

/**
 * Whether there is signal, watched rather than asked once.
 *
 * A salesman walks in and out of coverage while a form is open, so a single
 * reading taken when the screen mounted would be wrong within a minute — and
 * the direction it is wrong in matters: telling somebody they cannot dictate
 * when they can is how a feature stops being used.
 */
function useOnline(): boolean {
  const [online, setOnline] = React.useState(true);

  React.useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void import('@react-native-community/netinfo').then(({ default: NetInfo }) => {
      if (!live) return;
      stop = NetInfo.addEventListener((s) => setOnline(s.isConnected !== false));
      void NetInfo.fetch().then((s) => live && setOnline(s.isConnected !== false));
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  return online;
}

/* ------------------------------------------------------------------- clock */

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------- level meter */

/**
 * Nine bars, and they move with the voice rather than on a timer.
 *
 * This is the only thing on the screen that proves the microphone is hearing
 * anything. A running timer proves a recorder is running, which is a different
 * claim and the one that is true when a phone is recording a pocket.
 *
 * `metering` is decibels full scale — silence is about -60 and a voice at
 * arm's length lands around -20 — so it is mapped onto a 0-1 loudness before
 * it becomes a height. On a HELD recording it is drawn STILL rather than idle:
 * bars travelling under the word "Held" would be the screen claiming it can
 * still hear you.
 */
function LevelMeter({ level, live }: { level: number; live: boolean }) {
  const bars = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 4, height: 40 }}>
      {bars.map((i) => {
        /* A shape, not a spectrum: the middle bars stand taller so a voice
           reads as a voice rather than as a progress bar. */
        const shape = 0.55 + 0.45 * Math.sin((i / (bars.length - 1)) * Math.PI);
        const height = live ? 6 + Math.round(30 * level * shape) : 6;
        return (
          <View
            key={i}
            style={{
              width: 5,
              height,
              borderRadius: 3,
              backgroundColor: live ? C.primary : C.primaryEdge,
            }}
          />
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------- sheet */

type Phase = 'starting' | 'recording' | 'working' | 'review' | 'failed' | 'kept';

export type DictationResult = {
  /** The text the person approved, and where it should go. */
  text: string;
  replace: boolean;
};

/**
 * What to do with the recording once the words are out of it.
 *
 * `drop` is the honest default and what every field but one wants: the audio
 * was a keyboard, and a recording of a customer conversation is not a thing to
 * hold without a reason. `keep` hands the file back so the caller can queue it
 * — the visit's voice note, where the audio IS a record of what was said and
 * the office keeps it.
 */
export type AudioDisposal = 'drop' | 'keep';

function DictationBody({
  mode,
  maxSeconds,
  canRefine,
  hasExistingText,
  keepAudio,
  onImport,
  onAgain,
  onRecording,
  onClose,
}: {
  /**
   * `dictate` sends the audio and waits for the words. `record` keeps it and
   * does not — the offline answer, and only reachable on a field that has
   * somewhere to keep a recording.
   */
  mode: 'dictate' | 'record';
  maxSeconds: number;
  canRefine: boolean;
  hasExistingText: boolean;
  keepAudio: AudioDisposal;
  onImport: (result: DictationResult) => void;
  /** Throw this take away and start a new one. Remounts, so nothing lingers. */
  onAgain: () => void;
  /**
   * The file, where the caller asked to keep it. Called before anything else,
   * and told WHICH of the two things just happened — a caller that keeps audio
   * has a screen to be honest on afterwards, and "we wrote it out" and "the
   * office will write it out" are not the same sentence.
   */
  onRecording: (uri: string, seconds: number, mode: 'dictate' | 'record') => void;
  onClose: () => void;
}) {
  const recorder = useDictationRecorder();
  /* 120ms: fast enough that the bars read as a voice, slow enough that a
     five-year-old handset is not re-rendering nine views every frame. */
  const status = useAudioRecorderState(recorder, 120);

  const [phase, setPhase] = React.useState<Phase>('starting');
  const [paused, setPaused] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [english, setEnglish] = React.useState('');
  const [spoken, setSpoken] = React.useState('');
  const [language, setLanguage] = React.useState<string | null>(null);
  const [showSpoken, setShowSpoken] = React.useState(false);
  const [busy, setBusy] = React.useState<'tighten' | 'rewrite' | null>(null);
  const [instruction, setInstruction] = React.useState('');
  const [askingRewrite, setAskingRewrite] = React.useState(false);
  /* One step is enough: Tighten then Undo is the whole of what people do. */
  const [previous, setPrevious] = React.useState<string | null>(null);
  /* The seconds that were actually recorded, frozen at the moment of stopping
     — `status.durationMillis` goes to zero once the recorder is done. */
  const [recorded, setRecorded] = React.useState(0);

  /* What the clock read when it was held, so the display can stop dead. */
  const [heldAt, setHeldAt] = React.useState(0);

  /*
   * The recorded length, which is NOT how long the sheet has been open.
   *
   * `pause()` leaves the held seconds out of the file, so this is what the
   * ceiling has to be measured in — a two-minute interruption must not eat
   * somebody's limit — and it is what the server routes on, since Sarvam's
   * thirty-second refusal is about the length of the audio.
   *
   * FROZEN while held rather than polled. The recorder is the authority on
   * this number and it is not being asked while paused: whether a native
   * recorder reports the last duration or zero across a pause is a detail
   * that differs by platform, and a timer that jumped to 0:00 under the word
   * "Held" would read as a recording thrown away. What it shows is what it
   * last counted, which is the truth on both.
   */
  const counted = (status.durationMillis ?? 0) / 1000;
  const elapsed = paused ? heldAt : counted;

  /* Decibels full scale onto 0-1. -60 is a quiet room, -10 is loud. */
  const level = Math.min(1, Math.max(0, ((status.metering ?? -60) + 60) / 50));

  const sendRef = React.useRef(false);

  const send = React.useCallback(
    async (uri: string, seconds: number) => {
      setRecorded(seconds);

      /* Handed over BEFORE anything can fail. A recording the office is meant
         to keep must not be lost to a transcription that did not come back. */
      if (keepAudio === 'keep') onRecording(uri, seconds, mode);

      if (mode === 'record') {
        setPhase('kept');
        return;
      }

      setPhase('working');
      const heard = await api.dictateTranscribe({ uri, seconds });

      /* The file goes as soon as the bytes are somebody else's problem, and
         only where nobody asked to keep it — the media queue reads this uri
         later and deleting it would empty the visit's voice note. */
      if (keepAudio === 'drop') {
        try {
          const file = new File(uri);
          if (file.exists) file.delete();
        } catch {
          /* A file that will not delete is a tidy-up problem, never a data
             problem, and never a reason to fail a note somebody just spoke. */
        }
      }

      if (!heard.ok) {
        setError(heard.error);
        setPhase('failed');
        return;
      }
      setEnglish(heard.english);
      setSpoken(heard.spoken);
      setLanguage(heard.language);
      setPhase('review');
    },
    [keepAudio, mode, onRecording],
  );

  const stop = React.useCallback(async () => {
    if (sendRef.current) return;
    sendRef.current = true;
    const seconds = (recorder.getStatus().durationMillis ?? 0) / 1000;
    try {
      await recorder.stop();
    } catch {
      /* Stopping can throw on a recorder the OS has already torn down. The
         uri below is the thing that decides whether there is anything to
         send, so this is not the failure — an absent file is. */
    }
    const uri = recorder.uri;
    if (!uri) {
      setError('That recording did not come out. Try again.');
      setPhase('failed');
      return;
    }
    await send(uri, seconds);
  }, [recorder, send]);

  /*
   * Recording starts when the sheet opens. The person pressed a microphone;
   * asking them to press a second one while a shopkeeper waits is a tap that
   * buys nothing.
   */
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ready = await prepareMicrophone();
      if (cancelled) return;
      if (!ready.ok) {
        setError(
          ready.reason === 'permission'
            ? 'MahekOne is not allowed to use the microphone. Turn it on for MahekOne in your phone settings, then try again.'
            : 'The microphone would not open. Type the note instead.',
        );
        setPhase('failed');
        return;
      }
      try {
        await recorder.prepareToRecordAsync();
        if (cancelled) return;
        recorder.record();
        setPhase('recording');
      } catch {
        if (cancelled) return;
        setError('The microphone would not start. Type the note instead.');
        setPhase('failed');
      }
    })();

    return () => {
      cancelled = true;
      /* A HELD recorder is neither recording nor inactive, so `=== recording`
         would leave a paused one running with the microphone open. */
      if (recorder.isRecording || recorder.currentTime > 0) {
        recorder.stop().catch(() => {});
      }
    };
    /* Once, on mount. `recorder` is stable for the life of this component and
       putting it in the deps would restart the recording on every render. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* The ceiling, enforced where the seconds are counted rather than trusted to
     a timer the pause button would have to remember to stop. */
  React.useEffect(() => {
    if (phase !== 'recording' || paused) return;
    if (elapsed >= maxSeconds) void stop();
  }, [phase, paused, elapsed, maxSeconds, stop]);

  const refine = async (mode: 'tighten' | 'rewrite') => {
    if (busy) return;
    setBusy(mode);
    setError(null);
    const before = english;
    const out = await api.dictateRefine({
      text: english,
      mode,
      instruction: mode === 'rewrite' ? instruction.trim() : undefined,
    });
    setBusy(null);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setPrevious(before);
    setEnglish(out.text);
    setAskingRewrite(false);
    setInstruction('');
  };

  /* ------------------------------------------------------------- starting */

  if (phase === 'starting') {
    return (
      <View style={{ paddingVertical: 32, alignItems: 'center' }}>
        <ActivityIndicator color={C.primary} />
        <Text style={[type.small, { marginTop: 14, color: C.body }]}>Opening the microphone…</Text>
      </View>
    );
  }

  /* ------------------------------------------------------------ recording */

  if (phase === 'recording') {
    return (
      <View>
        <Text style={type.h2}>{paused ? 'Held' : 'Listening'}</Text>
        <Text style={[type.caption, { marginTop: 2 }]}>
          {paused
            ? 'Nothing is being recorded. Carry on when you are ready.'
            : mode === 'record'
              ? 'No signal, so this is being kept as a recording. The office writes it out and it appears on this visit.'
              : 'Speak in any language. You will read it before it goes in.'}
        </Text>

        <View
          style={{
            marginTop: 18,
            borderWidth: 1,
            borderColor: paused ? C.border : C.primaryEdge,
            backgroundColor: paused ? C.wash : C.primaryTint,
            borderRadius: radius.lg,
            paddingVertical: 18,
          }}>
          <LevelMeter level={level} live={!paused} />
          <Text
            style={[
              { fontSize: 15, textAlign: 'center', marginTop: 12, color: paused ? C.muted : C.primaryDeep },
              weight(500),
            ]}>
            {clock(elapsed)} of {clock(maxSeconds)}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          <Pressable
            onPress={() => {
              /*
               * Held, not stopped: `pause()` leaves the held seconds OUT of the
               * file rather than recording silence, so what comes back is what
               * was said before and after, joined. The alternative to a pause
               * button is starting again, and on a note somebody has half
               * spoken that is worse than not offering dictation at all.
               */
              if (paused) {
                recorder.record();
                setPaused(false);
              } else {
                setHeldAt((recorder.getStatus().durationMillis ?? 0) / 1000);
                recorder.pause();
                setPaused(true);
              }
            }}
            style={{
              flex: 1,
              height: HIT + 4,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: radius.xl,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Text style={[{ fontSize: 16, color: C.body }, weight(500)]}>
              {paused ? 'Carry on' : 'Hold'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void stop()}
            style={{
              flex: 2,
              height: HIT + 4,
              borderRadius: radius.xl,
              backgroundColor: C.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Text style={[{ fontSize: 16, color: '#FFFFFF' }, weight(600)]}>
              {mode === 'record' ? 'Done — keep it' : 'Done — write it out'}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  /* -------------------------------------------------------------- working */

  if (phase === 'working') {
    return (
      <View style={{ paddingVertical: 26, alignItems: 'center' }}>
        {/* The same bars, now still: the microphone is closed and there is
            nothing left to measure, so nothing here claims to be measuring. */}
        <LevelMeter level={0} live={false} />
        <Text style={[type.h3, { marginTop: 16 }]}>Writing down what you said…</Text>
        <Text style={[type.caption, { marginTop: 4, textAlign: 'center' }]}>
          {clock(recorded)} of speech. A few seconds on a good signal, longer on a bad one.
        </Text>
      </View>
    );
  }

  /* ----------------------------------------------------------------- kept */

  if (phase === 'kept') {
    return (
      <View style={{ paddingVertical: 18 }}>
        <Text style={type.h3}>Recorded — {clock(recorded)}</Text>
        <Text style={[type.body, { marginTop: 8 }]}>
          It goes to the office with this visit, and is written out from there. You will see the
          words on the visit once it has been. Type anything you need in the meantime — nothing
          overwrites what you write.
        </Text>
        <Pressable
          onPress={onClose}
          style={{
            height: HIT + 4,
            marginTop: 20,
            borderRadius: radius.xl,
            backgroundColor: C.primary,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <Text style={[{ fontSize: 16, color: '#FFFFFF' }, weight(600)]}>Done</Text>
        </Pressable>
      </View>
    );
  }

  /* --------------------------------------------------------------- failed */

  if (phase === 'failed') {
    return (
      <View style={{ paddingVertical: 12 }}>
        <Text style={[type.body, { color: C.danger }]}>{error}</Text>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
          <Pressable
            onPress={onClose}
            style={{
              flex: 1,
              height: HIT + 4,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: radius.xl,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Text style={[{ fontSize: 16, color: C.body }, weight(500)]}>Close</Text>
          </Pressable>
          <Pressable
            onPress={onAgain}
            style={{
              flex: 1,
              height: HIT + 4,
              borderRadius: radius.xl,
              backgroundColor: C.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Text style={[{ fontSize: 16, color: '#FFFFFF' }, weight(600)]}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  /* --------------------------------------------------------------- review */

  return (
    <View>
      <Text style={type.label}>What you said, in English</Text>
      <TextInput
        value={english}
        onChangeText={setEnglish}
        multiline
        style={{
          width: '100%',
          minHeight: 132,
          marginTop: 8,
          padding: 12,
          borderWidth: 1,
          borderColor: C.border,
          borderRadius: radius.lg,
          fontSize: 15,
          lineHeight: 21,
          color: C.ink,
          backgroundColor: C.surface,
          textAlignVertical: 'top',
        }}
      />
      <Text style={[type.caption, { marginTop: 6 }]}>
        Everything you said, not a summary. Correct it here, or ask below.
      </Text>

      {spoken && spoken !== english ? (
        <View style={{ marginTop: 12 }}>
          <Pressable onPress={() => setShowSpoken((v) => !v)} hitSlop={8}>
            <Text style={[{ fontSize: 14, color: C.primaryDeep }, weight(500)]}>
              {showSpoken ? 'Hide' : 'Show'} what was heard{language ? ` (${language})` : ''}
            </Text>
          </Pressable>
          {showSpoken ? (
            <Text
              style={[
                type.small,
                {
                  marginTop: 8,
                  padding: 10,
                  borderWidth: 1,
                  borderColor: C.hairline,
                  backgroundColor: C.wash,
                  borderRadius: radius.sm,
                },
              ]}>
              {spoken}
            </Text>
          ) : null}
        </View>
      ) : null}

      {error ? <Text style={[type.small, { color: C.danger, marginTop: 12 }]}>{error}</Text> : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
        {/* Left out rather than shown broken where no text model is set up. */}
        {canRefine ? (
          <>
            <SmallButton
              label={busy === 'tighten' ? 'Tightening…' : 'Tighten'}
              disabled={busy !== null || !english.trim()}
              onPress={() => void refine('tighten')}
            />
            <SmallButton
              label="Rewrite"
              disabled={busy !== null || !english.trim()}
              onPress={() => setAskingRewrite((v) => !v)}
            />
          </>
        ) : null}
        {previous !== null ? (
          <SmallButton
            label="Undo"
            disabled={busy !== null}
            onPress={() => {
              setEnglish(previous);
              setPrevious(null);
            }}
          />
        ) : null}
        <SmallButton label="Say it again" disabled={busy !== null} onPress={onAgain} />
      </View>

      {askingRewrite && canRefine ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <TextInput
            value={instruction}
            onChangeText={setInstruction}
            placeholder="Say it shorter / drop the part about the driver"
            placeholderTextColor={C.faint}
            style={{
              flex: 1,
              height: 46,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: radius.lg,
              paddingHorizontal: 12,
              fontSize: 15,
              color: C.ink,
              backgroundColor: C.surface,
            }}
          />
          <SmallButton
            label={busy === 'rewrite' ? '…' : 'Go'}
            disabled={busy !== null || !instruction.trim()}
            onPress={() => void refine('rewrite')}
          />
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 22 }}>
        <Pressable
          onPress={onClose}
          style={{
            flex: 1,
            height: HIT + 4,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: radius.xl,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <Text style={[{ fontSize: 16, color: C.body }, weight(500)]}>Cancel</Text>
        </Pressable>
        <Pressable
          disabled={!english.trim()}
          onPress={() => onImport({ text: english.trim(), replace: false })}
          style={{
            flex: 2,
            height: HIT + 4,
            borderRadius: radius.xl,
            backgroundColor: english.trim() ? C.primary : C.faint,
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <Text style={[{ fontSize: 16, color: '#FFFFFF' }, weight(600)]}>
            {hasExistingText ? 'Add to the note' : 'Put it in the box'}
          </Text>
        </Pressable>
      </View>

      {/* Replacing is offered SECOND and on its own line, because it is the
          destructive one and the two must never sit side by side looking
          alike. Absent entirely where the box is empty, since there is
          nothing to replace. */}
      {hasExistingText ? (
        <Pressable
          disabled={!english.trim()}
          onPress={() => onImport({ text: english.trim(), replace: true })}
          style={{ height: HIT, alignItems: 'center', justifyContent: 'center', marginTop: 4 }}>
          <Text style={[{ fontSize: 15, color: C.muted }, weight(500)]}>
            Replace what is there instead
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SmallButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={{
        height: 38,
        paddingHorizontal: 14,
        borderWidth: 1,
        borderColor: C.border,
        borderRadius: radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.45 : 1,
        backgroundColor: C.surface,
      }}>
      <Text style={[{ fontSize: 14, color: C.body }, weight(500)]}>{label}</Text>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ button */

/**
 * How dictated text joins text already in the box. A blank line, because two
 * thoughts spoken at two moments are two paragraphs, and running them together
 * is how a note stops being readable.
 */
export function joinDictation(existing: string, added: string): string {
  const kept = existing.trimEnd();
  return kept ? `${kept}\n\n${added}` : added;
}

/**
 * The microphone itself.
 *
 * TINTED, and that is the whole of why it works. It shipped in the CRM as a
 * grey glyph the same weight as the furniture around it, and nobody presses
 * furniture — least of all the person who is not confident with computers and
 * is exactly who it was built for. Colour is what makes it read as something
 * offered rather than something structural.
 */
export function MicButton({
  onPress,
  disabled,
  reason,
  style,
}: {
  onPress: () => void;
  disabled?: boolean;
  /** Said out loud when a disabled one is pressed. Never a silent no. */
  reason?: string;
  style?: object;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityLabel={
        disabled && reason ? reason : 'Speak instead of typing — say it in any language'
      }
      style={[
        {
          width: 38,
          height: 38,
          borderRadius: radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: disabled ? C.wash : C.primaryTint,
          borderWidth: 1,
          borderColor: disabled ? C.border : C.primaryEdge,
        },
        style,
      ]}>
      <Icon name="mic" size={19} color={disabled ? C.faint : C.primaryDeep} strokeWidth={1.6} />
    </Pressable>
  );
}

/* ------------------------------------------------------------------- field */

/**
 * A prose box with a microphone in its corner. A drop-in wherever somebody
 * writes a sentence on this app.
 *
 * `onChangeText` takes the FINISHED value rather than the dictated fragment,
 * so joining, replacing and the length ceiling are decided here instead of at
 * seven call sites that would each get one of them slightly wrong.
 */
export function VoiceField({
  value,
  onChangeText,
  /**
   * What to do with the audio.
   *
   * `drop` is the honest default and what every field but one wants: the
   * recording was a keyboard, and a recording of a customer conversation is
   * not a thing to hold without a reason.
   *
   * `keep` is the visit note. The recording there IS a record of what a
   * customer said, the office keeps it, and — because there is somewhere for
   * it to go — that field is the only one with an answer to having no signal
   * rather than an apology.
   */
  keepAudio = 'drop',
  onRecording,
  style,
  ...rest
}: React.ComponentProps<typeof Input> & {
  value: string;
  onChangeText: (v: string) => void;
  keepAudio?: AudioDisposal;
  onRecording?: (uri: string, seconds: number, mode: 'dictate' | 'record') => void;
}) {
  const dictation = useDictation();
  const online = useOnline();
  const [open, setOpen] = React.useState(false);
  const [nudge, setNudge] = React.useState<string | null>(null);
  /* Bumping this remounts the body, which is how "say it again" resets — a
     fresh recorder, a blank transcript and no leftover Undo, without an effect
     that has to remember every piece of state it should have cleared. */
  const [take, setTake] = React.useState(0);

  const offline = !online;
  /* Offline is a dead end only where there is nowhere to keep a recording.
     Where there is, the mic still works — it just stops promising the words
     back straight away. */
  const canRecordOffline = keepAudio === 'keep';
  const blocked = offline && !canRecordOffline;
  const maxLength = typeof rest.maxLength === 'number' ? rest.maxLength : undefined;

  return (
    <View>
      <View>
        {/*
          THE SAME `Input` every other field on this app draws, not a second
          box that looks like it. The border, the focus colour, the invalid
          state and the minimum height are decided in one place; a copy here
          would be right on the day it was written and wrong by the next
          design change, on seven screens at once.
        */}
        <Input
          {...rest}
          value={value}
          onChangeText={onChangeText}
          multiline
          style={[
            /* Room on the right so a long line never runs under the mic. */
            dictation.available ? { paddingRight: 58 } : null,
            style,
          ]}
        />
        {/*
          DRAWN AT ALL only where this deployment can actually hear — dictation
          switched off, or no provider key, and there is no microphone on any
          screen. That is permanent, and one that fails when pressed is worse
          than one never offered.

          DRAWN DIM when there is no signal, rather than removed. That is
          temporary and it changes minute to minute; a control that appeared
          and vanished while somebody looked at the screen is one they learn is
          not there.
        */}
        {dictation.available ? (
          <MicButton
            disabled={blocked}
            reason="No signal — dictation needs a connection. Type the note instead."
            onPress={() => {
              setNudge(null);
              if (blocked) {
                setNudge('No signal — dictation needs a connection. Type the note instead.');
                return;
              }
              setOpen(true);
            }}
            style={{ position: 'absolute', right: 10, bottom: 10 }}
          />
        ) : null}
      </View>

      {/* Said before it is pressed, not after. A salesman deciding whether to
          speak or type needs to know which of the two he is about to get. */}
      {dictation.available && offline && canRecordOffline ? (
        <Text style={[type.caption, { marginTop: 6 }]}>
          No signal — the mic will record it, and the office writes it out.
        </Text>
      ) : null}
      {nudge ? <Text style={[type.caption, { marginTop: 6, color: C.warnInk }]}>{nudge}</Text> : null}

      <BottomSheet open={open} onClose={() => setOpen(false)} scroll>
        {/* Mounted only while open, so closing it drops the recorder, the
            transcript and every button state — the next visit starts blank
            without an effect resetting anything. */}
        {open && dictation.available ? (
          <DictationBody
            key={take}
            mode={offline ? 'record' : 'dictate'}
            maxSeconds={dictation.maxSeconds}
            canRefine={dictation.canRefine}
            hasExistingText={value.trim().length > 0}
            keepAudio={keepAudio}
            onRecording={(uri, seconds, mode) => onRecording?.(uri, seconds, mode)}
            onClose={() => setOpen(false)}
            onAgain={() => setTake((t) => t + 1)}
            onImport={({ text, replace }) => {
              const joined = replace ? text : joinDictation(value, text);
              /* `maxLength` stops typing but not a programmatic set, so the
                 box would otherwise accept more than the form will save. */
              onChangeText(maxLength && maxLength > 0 ? joined.slice(0, maxLength) : joined);
              setOpen(false);
            }}
          />
        ) : null}
      </BottomSheet>
    </View>
  );
}
