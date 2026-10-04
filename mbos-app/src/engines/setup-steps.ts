import type { Readiness, ReadinessItem } from './phone-readiness';
import type { Step, StepAction, StepKey } from './setup-walkthrough';

/**
 * ONE LIST OF PHONE SETTINGS, drawn by three screens.
 *
 * The same five Android settings were explained three times: the walkthrough
 * after sign-in (`app/setup.tsx`), the start-of-day gate (`app/phone-setup.tsx`)
 * and Keep tracking on (`app/tracking-setup.tsx`). Each had its own titles,
 * its own buttons and its own idea of what a step was called — "Stop the
 * battery saver switching MBOS off", "The battery saver will stop MBOS" and
 * "Let Mahek MBOS run in the background" were one switch. A salesman sent from
 * the gate to Keep tracking on by somebody at the office was reading a
 * different list about the same phone, and the question he rang back with was
 * which of the two was right.
 *
 * So the LIST is `setupSteps` — the walkthrough's engine, because it is the
 * only one of the three that covers everything the app asks for — and each
 * screen keeps only what is genuinely its own: its header, its framing, and
 * for the gate its RULE about which steps hold the day. That rule stays in
 * `phone-readiness.ts`, untouched, and is laid over the shared list here
 * rather than drawn as a second list: a step the gate is holding the day on
 * says so in its own row, under the same title every other screen gives it.
 *
 * PURE, like every engine here, which is what lets a test say the three
 * screens list the same steps for the same phone.
 */

export type SetupEntry = 'walkthrough' | 'gate' | 'tracking';

export type StepTone =
  /** Read from the phone and it said yes, or he has said so where it cannot be read. */
  | 'done'
  /** Something to press, and pressing it can finish the step. */
  | 'todo'
  /** Nobody can check it — not the app, not the office. Never drawn as a tick. */
  | 'unknowable'
  /** Android has stopped asking and the app has run out of ways to help. */
  | 'stuck';

export type SetupStepView = {
  key: StepKey;
  /** The one title this step has, on every screen. */
  title: string;
  detail: string;
  tone: StepTone;
  action: StepAction | null;
  button: string | null;
  /** Whether the start-of-day gate is holding the day on this step. False everywhere but the gate. */
  blocksDay: boolean;
};

/** Which shared step each of the gate's checks is part of. */
const GATE_KEY: Record<ReadinessItem['key'], StepKey> = {
  location_services: 'location_services',
  /* The gate asks for location-while-using as its own row; the shared list
     asks for it inside the popups step, beside notifications and the camera. */
  foreground: 'allow',
  background: 'background',
  battery: 'battery',
  autostart: 'autostart',
};

function baseView(step: Step): SetupStepView {
  return {
    key: step.key,
    title: step.title,
    detail: step.detail,
    /* `settings` is a step whose popup Android has stopped showing — still a
       button and still finishable, so it reads as to do, never as stuck. */
    tone: step.state === 'done' ? 'done' : 'todo',
    action: step.action,
    button: step.button,
    blocksDay: false,
  };
}

/** What the gate's own action means on the shared list's buttons. */
function gateAction(item: ReadinessItem): { action: StepAction | null; button: string | null } {
  switch (item.action) {
    case 'location_settings':
      return { action: 'location_settings', button: 'Open location settings' };
    case 'ask_permission':
      return item.key === 'background'
        ? { action: 'ask_background', button: 'Open the location page' }
        : { action: 'ask_popups', button: 'Allow' };
    case 'app_settings':
      return { action: 'app_settings', button: 'Open MBOS settings' };
    case 'battery':
      return { action: 'battery', button: 'Allow MBOS to keep running' };
    case 'autostart':
      return { action: 'autostart', button: 'Open the setting' };
    default:
      return { action: null, button: null };
  }
}

/**
 * The gate's verdict laid over one shared step.
 *
 * Only a check that HOLDS THE DAY changes the row: its words become the
 * gate's, because "your last working day saved no movement" is the reason he
 * is being stopped and the shared detail does not know it. A check the gate is
 * content with leaves the shared row exactly as it was — including a step the
 * gate does not care about at all, like the camera, which is still worth doing
 * and still offered, just not demanded.
 */
function overlay(view: SetupStepView, items: readonly ReadinessItem[]): SetupStepView {
  const mine = items.filter((it) => GATE_KEY[it.key] === view.key);
  const holding = mine.find((it) => it.state === 'dead_end') ?? mine.find((it) => it.state === 'todo');
  if (holding) {
    const { action, button } = gateAction(holding);
    return {
      ...view,
      detail: holding.detail,
      tone: holding.state === 'dead_end' ? 'stuck' : 'todo',
      action: action ?? view.action,
      button: button ?? view.button,
      blocksDay: true,
    };
  }
  /* Done on the shared list but unreadable to the gate is still unreadable:
     autostart he confirmed once is as unverifiable this morning as it was
     then, and a tick would be the app claiming something it cannot know. */
  const unknowable = mine.find((it) => it.state === 'unknowable');
  if (unknowable && view.tone === 'done' && view.key !== 'autostart') {
    return { ...view, tone: 'unknowable', detail: unknowable.detail };
  }
  return view;
}

/**
 * The steps a screen draws, in the one order they have to be done.
 *
 * Every entry lists the same steps under the same titles. Only the gate adds
 * anything, and what it adds is which of them stand between him and the day.
 */
export function stepsForEntry(
  entry: SetupEntry,
  steps: readonly Step[],
  readiness?: Readiness | null,
): SetupStepView[] {
  const views = steps.map(baseView);
  if (entry !== 'gate' || !readiness) return views;
  return views.map((v) => overlay(v, readiness.items));
}

/** The first step with anything left to press, or null once the phone is set up. */
export function firstOpen(views: readonly SetupStepView[]): SetupStepView | null {
  return views.find((v) => v.tone === 'todo' || v.tone === 'stuck') ?? null;
}

/**
 * The gate's checks still outstanding, as the acknowledgement records them.
 *
 * Stored with the claim and sent to the office with the day — "he said he did
 * it while three things were still red" is a different fact from "he said he
 * did it", and only the second kind explains a day that then recorded nothing.
 */
export function outstandingChecks(readiness: Readiness | null | undefined): string[] {
  return (readiness?.items ?? []).filter((it) => it.state !== 'ok').map((it) => it.key);
}
