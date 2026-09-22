import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  keepAliveSteps,
  oemOf,
  RESTART_ANSWER,
  shouldOfferSetup,
  trackingVerdict,
} from './oem-keepalive';

describe('which handset this is', () => {
  it('folds the sub-brands onto the OEM whose settings they run', () => {
    /* Redmi and Poco are Xiaomi's MIUI, and the Autostart switch is in the
       same place on all three. A salesman on a Redmi read a path for "other"
       would be sent looking for a menu that is there and unnamed. */
    for (const m of ['Xiaomi', 'redmi', 'POCO']) assert.equal(oemOf(m), 'xiaomi');
    for (const m of ['vivo', 'iQOO']) assert.equal(oemOf(m), 'vivo');
    assert.equal(oemOf('OnePlus'), 'oneplus');
    assert.equal(oemOf('realme'), 'realme');
    assert.equal(oemOf('OPPO'), 'oppo');
    assert.equal(oemOf('samsung'), 'samsung');
  });

  it('answers other for a manufacturer it does not know, and for none', () => {
    assert.equal(oemOf('Nothing'), 'other');
    assert.equal(oemOf(null), 'other');
    assert.equal(oemOf(''), 'other');
    assert.equal(oemOf('   '), 'other');
  });

  /* OnePlus and Realme are not folded into Oppo although all three are
     ColorOS underneath: the MENU PATH differs, and a path that does not match
     what is on his screen is worse than none — he stops following any of it. */
  it('keeps the ColorOS family apart, because the menus differ', () => {
    const paths = new Set(
      (['oppo', 'oneplus', 'realme'] as const).map(
        (o) => keepAliveSteps(o).find((s) => s.key === 'autostart')?.detail,
      ),
    );
    assert.equal(paths.size, 2, 'OnePlus reads differently from Oppo and Realme');
  });
});

describe('what a handset is asked to do', () => {
  it('always asks for battery first', () => {
    for (const oem of ['xiaomi', 'oppo', 'vivo', 'samsung', 'oneplus', 'realme', 'other'] as const) {
      assert.equal(keepAliveSteps(oem)[0].key, 'battery');
    }
  });

  /* A handset with no quirk we know of gets the battery step alone. Printing
     an autostart path we are guessing at sends somebody looking for a menu
     that is not there. */
  it('claims no autostart path it does not have', () => {
    assert.deepEqual(
      keepAliveSteps('other').map((s) => s.key),
      ['battery'],
    );
  });

  /*
   * THE SCREEN MAY NOT CLAIM WHAT THE PHONE CANNOT KNOW.
   *
   * Battery optimisation is granted by a system dialog and comes back with an
   * answer. Autostart is a page we can open and a sentence we can print, and
   * nothing tells the app what was tapped there. Marking both done the same
   * way would be the app asserting something it has no way to learn.
   */
  it('says which steps can actually be granted', () => {
    const steps = keepAliveSteps('xiaomi');
    assert.equal(steps.find((s) => s.key === 'battery')?.grantable, true);
    assert.equal(steps.find((s) => s.key === 'autostart')?.grantable, false);
  });

  it('names MahekOne in every path, so he can find the row', () => {
    for (const oem of ['xiaomi', 'oppo', 'vivo', 'samsung', 'oneplus', 'realme'] as const) {
      const detail = keepAliveSteps(oem).find((s) => s.key === 'autostart')!.detail;
      assert.ok(detail.includes('MahekOne'), `${oem} path does not say which app to look for`);
    }
  });
});

describe('when to put it in front of somebody', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('offers it to a handset that has never been asked', () => {
    assert.equal(
      shouldOfferSetup({ askedAt: null, trailStalled: false, now: 1_000, remindAfterMs: DAY }),
      true,
    );
  });

  /* A prompt on every check-in is one people learn to dismiss without
     reading, and this one only works if it is read. */
  it('does not ask again straight away', () => {
    assert.equal(
      shouldOfferSetup({ askedAt: 1_000, trailStalled: false, now: 2_000, remindAfterMs: DAY }),
      false,
    );
  });

  /*
   * SILENCE OUTRANKS THE COOLDOWN. The watchdog catching the tracker dead is
   * evidence that whatever was tapped is not holding, and that is exactly the
   * moment the steps are worth reading again — whenever they were last shown.
   */
  it('asks again the moment the tracker is caught silent', () => {
    assert.equal(
      shouldOfferSetup({ askedAt: 1_000, trailStalled: true, now: 1_001, remindAfterMs: DAY }),
      true,
    );
  });

  it('comes back once the reminder window has passed', () => {
    assert.equal(
      shouldOfferSetup({ askedAt: 0, trailStalled: false, now: DAY, remindAfterMs: DAY }),
      true,
    );
  });
});

describe('and then what', () => {
  /*
   * THE QUESTION THE WHOLE TEAM RANG THE OFFICE WITH. Nothing on either
   * tracking screen said whether to restart the app or the phone, so the
   * answers went round by word of mouth. A phone restart is never the fix, and
   * the rule has to say so in every state rather than merely not mentioning it
   * — silence is what produced the folk remedy in the first place.
   */
  it('never tells anybody to restart their phone, whatever the state', () => {
    /* Said once, from one constant, because both screens print it and a
       sentence written twice comes to read two ways. */
    assert.match(RESTART_ANSWER, /do not need to restart your phone/);

    for (const capture of ['service', 'background', 'floor', null] as const) {
      for (const exemption of ['exempt', 'optimised', 'unknown'] as const) {
        for (const canRestart of [true, false]) {
          const v = trackingVerdict({ capture, exemption, canRestart });
          /* No verdict may reach for the folk remedy. It is a restart of the
             APP or it is nothing, and "your phone" appearing next to the word
             would undo the sentence above on the same screen. */
          assert.doesNotMatch(
            v.detail,
            /restart (your |the )?phone|reboot/i,
            `${capture}/${exemption} sends somebody to reboot a handset`,
          );
          /* The union has no phone in it, and the assertion is here so that
             adding one fails a test rather than a Tuesday. */
          assert.ok(
            v.action === null || v.action === 'restart_app' || v.action === 'recheck',
            `${capture}/${exemption} offers an action nobody has reasoned about`,
          );
        }
      }
    }
  });

  /*
   * RECORDING PROPERLY OUTRANKS A BATTERY MANAGER THAT IS STILL SWITCHED ON.
   * Our own service holds capture up through a reap, so sending a working
   * handset off to change more settings spends the authority this screen needs
   * for the one time it matters.
   */
  it('says it is working, and asks for nothing, once something is capturing', () => {
    for (const capture of ['service', 'background'] as const) {
      const v = trackingVerdict({ capture, exemption: 'optimised', canRestart: true });
      assert.equal(v.tone, 'good');
      assert.equal(v.action, null);
    }
  });

  /*
   * THE FLOOR IS THE ONE STATE A RESTART FIXES: the phone refused once in this
   * process, the settings have changed under it since, and a fresh start is
   * what gets the new answer read.
   */
  it('offers the restart only at the foreground floor', () => {
    const floor = trackingVerdict({ capture: 'floor', exemption: 'exempt', canRestart: true });
    assert.equal(floor.tone, 'act');
    assert.equal(floor.action, 'restart_app');

    for (const capture of ['service', 'background', null] as const) {
      assert.notEqual(
        trackingVerdict({ capture, exemption: 'exempt', canRestart: true }).action,
        'restart_app',
      );
    }
  });

  /*
   * A BUTTON THAT CANNOT WORK IS NOT DRAWN — `reloadAsync` rejects in
   * development and on a build with updates off, and AGENTS.md records what a
   * control that fails when pressed costs. The way out is still said, in words.
   */
  it('drops the button and keeps the instruction where it cannot restart', () => {
    const v = trackingVerdict({ capture: 'floor', exemption: 'exempt', canRestart: false });
    assert.equal(v.action, null);
    assert.match(v.detail, /[Cc]lose MahekOne completely/);
  });

  /* The battery step is the readable half, so it is named where it is still
     switched on and the floor is what he is left recording at. */
  it('sends him to the battery step first where the phone says it is still on', () => {
    assert.match(
      trackingVerdict({ capture: 'floor', exemption: 'optimised', canRestart: true }).detail,
      /battery step/,
    );
  });

  /*
   * NO DAY OPEN IS NOT A FAULT, which is most readings of this screen — the
   * evening, the morning before checking in. It must not be drawn as one, and
   * it must not claim the settings are right either.
   */
  it('reads a closed day as nothing to record rather than as a fault', () => {
    const v = trackingVerdict({ capture: null, exemption: 'exempt', canRestart: true });
    assert.equal(v.tone, 'idle');
    assert.equal(v.action, 'recheck');
  });
});
