import React from 'react';
import { View, Pressable, Text } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { router, useFocusEffect } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { HERO } from '../src/components/shell/Chrome';
import { Input } from '../src/components/ui/primitives';
import { Pill, PillButton, SheetActions } from '../src/components/ui/v3';
import { Icon } from '../src/components/ui/Icon';
import { SearchBox } from '../src/components/ui/book-controls';
import { feedback } from '../src/components/ui/feedback';
import { BottomSheet, Calendar } from '../src/components/ui/overlays';
import { VoiceField } from '../src/components/ui/dictate';
import { takePhoto } from '../src/native/capture';
import { discardQueuedMedia } from '../src/sync/media';
import { getConfig } from '../src/data/config';
import { useBoot } from '../src/state/boot';
import { color as C, weight } from '../src/theme/tokens';
import {
  bucketOf,
  completeTask,
  createTask,
  dropTaskDraft,
  listOpenTasks,
  loadTaskDraft,
  saveTaskDraft,
  snoozeTarget,
  snoozeTask,
  taskFormForShop,
  taskFormOf,
  type Task,
} from '../src/data/tasks';
import { TaskFormFields } from '../src/components/task-form';
import { cleanTaskAnswers, taskAnswerProblems, taskAnswersNote, type TaskAnswers } from '../src/engines/task-form';
import { customerNames, daysSince, listCustomersPage, type Customer } from '../src/data/customers';
import { dmy, isoDate, plural } from '../src/lib/format';
import { useStore } from '../src/state/store';
import { Stagger, SwipeRow, animateLayoutFor } from '../src/components/ui/motion';

/**
 * Tasks, in five buckets.
 *
 * A bucket with nothing in it is not shown at all — an empty "Tomorrow"
 * heading is a line of furniture between the salesman and the work that is
 * actually overdue. Snoozing asks why, because a task pushed back three times
 * is something the manager needs to see rather than a habit the app helps.
 *
 * The buckets are DERIVED from the due date on every render rather than stored
 * on the row: a task written "Today" yesterday is overdue this morning, and
 * that is exactly the morning it matters.
 *
 * IT MUST NAME EVERY BUCKET `bucketOf` CAN RETURN. It listed four of five, so
 * anything more than a week out was filed under `Later` and drawn by no branch
 * at all — and because the list was not empty the empty state was suppressed
 * too, leaving a salesman holding only far-dated work looking at a "+ New task"
 * button over blank space. The office's nurture and reorder tasks are routinely
 * 14 to 30 days out, so that was not an edge case: it was work assigned to him,
 * counting against him, invisible and impossible to complete.
 */

const BUCKETS = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later'] as const;
const WHENS = ['Today', 'Tomorrow', 'This week'] as const;
const PRIS = ['Normal', 'High'] as const;

/** What a form asks, in one line: "4 questions · 2 photos". */
function formLine(fields: ReturnType<typeof taskFormOf>): string {
  const asks = fields.filter((f) => f.type !== 'info' && f.type !== 'photo').length;
  const photos = fields.filter((f) => f.type === 'photo').length;
  return [
    asks ? plural(asks, 'question') : '',
    photos ? plural(photos, 'photo') + ' to take' : '',
  ]
    .concat(fields.some((f) => f.link) ? ['updates the shop record'] : [])
    .filter(Boolean)
    .join(' · ') || 'Read and confirm';
}

/** The three offers the design makes, as real dates. */
function dateFor(when: (typeof WHENS)[number], today: string): string {
  const base = new Date(today + 'T00:00:00');
  const add = when === 'Today' ? 0 : when === 'Tomorrow' ? 1 : 7;
  base.setDate(base.getDate() + add);
  return isoDate(base);
}

export default function TasksScreen() {
  const set = useStore((st) => st.set);
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);

  const [tasks, setTasks] = React.useState<Task[]>([]);
  /* THE PICKER IS A PAGE, NOT THE BOOK. This rendered a Choice per customer
     and read every row to do it — the same fault the Customers screen had, on
     a screen nobody had opened with a full book yet. The names on the task
     rows are looked up by id instead, so capping the picker cannot blank
     them. */
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [bookTotal, setBookTotal] = React.useState(0);
  const [names, setNames] = React.useState<Map<string, string>>(new Map());
  const [today] = React.useState(() => isoDate(new Date()));

  const [formOpen, setFormOpen] = React.useState(false);
  const [title, setTitle] = React.useState('');
  /* THE SHOP IS PICKED, NEVER PRE-PICKED. The sheet used to open with
     `customers[0]` already selected — the alphabetically first of a capped
     fifty — and `Choice` is a radio with no way to deselect, so there was no
     way to clear it, no way to reach the fifty-first shop of a thousand, and no
     way to raise a task that belongs to no customer at all. Every task somebody
     added without scrolling was filed against whichever shop sorts first. The
     name is held beside the id so a pick survives the search being typed
     over. */
  const [picked, setPicked] = React.useState<{ id: string; name: string } | null>(null);
  const [custQuery, setCustQuery] = React.useState('');
  const [when, setWhen] = React.useState<(typeof WHENS)[number]>('Today');
  const [pri, setPri] = React.useState<(typeof PRIS)[number]>('Normal');
  const [titleErr, setTitleErr] = React.useState(false);

  /* DONE ASKS HOW. See `completeTask` — the office refuses a closed task with
     nothing said about it, so the note is asked here, at the one moment the
     salesman still remembers what he did. */
  const boot = useBoot();
  const me = boot.session?.user.id ?? null;
  const [closing, setClosing] = React.useState<Task | null>(null);
  const [doneNote, setDoneNote] = React.useState('');
  const [donePhoto, setDonePhoto] = React.useState<string | null>(null);
  const [doneErr, setDoneErr] = React.useState<string | null>(null);
  const [doneBusy, setDoneBusy] = React.useState(false);
  /* A task the office attached a form to is answered by the form. The
     answers are kept as a draft as they are given, so a form left half done
     opens where he left it. */
  const [answers, setAnswers] = React.useState<TaskAnswers>({});
  const [answerErrs, setAnswerErrs] = React.useState<Map<string, string>>(new Map());
  /* The form as he answers it on this shop — linked questions show what the
     customer record holds, and a question about every contact is asked once
     per person. */
  const closingForm = React.useMemo(() => (closing ? taskFormForShop(closing).fields : []), [closing]);
  const doneLock = React.useRef(false);
  const [noteRequired, setNoteRequired] = React.useState(true);
  React.useEffect(() => {
    void getConfig<boolean>('mbos.tasks.requireCompletionNote', true)
      .then((v) => setNoteRequired(v !== false))
      .catch(() => setNoteRequired(true));
  }, []);

  const [snoozing, setSnoozing] = React.useState<Task | null>(null);
  const [snoozeTo, setSnoozeTo] = React.useState('');
  const [snoozeWhy, setSnoozeWhy] = React.useState('');
  const [snoozeErr, setSnoozeErr] = React.useState<string | null>(null);

  /* `animate` is asked for by the two acts that move a row — done and snooze —
     and not by focus: a screen opening on its list is not that list changing. */
  const load = React.useCallback((animate?: boolean) => {
    let live = true;
    void listOpenTasks().then(async (t) => {
      if (!live) return;
      if (animate === true) animateLayoutFor(t.length);
      setTasks(t);
      const found = await customerNames(t.map((x) => x.customerId ?? '').filter(Boolean));
      if (live) setNames(found);
    });
    return () => {
      live = false;
    };
  }, []);

  useFocusEffect(React.useCallback(() => load(), [load]));

  /* The book is read by the SEARCH rather than once on focus, which is what
     makes a shop past the first page reachable at all. An empty query is the
     same first page this always showed. */
  React.useEffect(() => {
    let live = true;
    void listCustomersPage({ query: custQuery.trim() || undefined, limit: 50 }).then((page) => {
      if (!live) return;
      setCustomers(page.rows);
      setBookTotal(page.total);
    });
    return () => {
      live = false;
    };
  }, [custQuery]);

  const nameOf = (id: string | null) => (id ? (names.get(id) ?? '') : '');

  const openForm = () => {
    setTitle('');
    setPicked(null);
    setCustQuery('');
    setWhen('Today');
    setPri('Normal');
    setTitleErr(false);
    setFormOpen(true);
  };

  const save = async () => {
    const t = title.trim();
    if (!t) return setTitleErr(true);
    await createTask({ title: t, customerId: picked?.id ?? null, priority: pri, dueDate: dateFor(when, today) });
    setFormOpen(false);
    load();
    notify('Task added · ' + t);
  };

  const openDone = (t: Task) => {
    setClosing(t);
    setDoneNote('');
    setDonePhoto(null);
    setDoneErr(null);
    setAnswerErrs(new Map());
    setAnswers({});
    if (taskFormOf(t).length) void loadTaskDraft(t).then(setAnswers).catch(() => undefined);
  };

  const changeAnswers = (next: TaskAnswers) => {
    setAnswers(next);
    setAnswerErrs(new Map());
    setDoneErr(null);
    if (closing) void saveTaskDraft(closing.id, next).catch(() => undefined);
  };

  const closeDone = () => {
    /* A photograph taken for a task that was then not closed belongs to
       nothing — drop it rather than let it upload as an orphan. */
    if (donePhoto) void discardQueuedMedia(donePhoto).catch(() => undefined);
    setClosing(null);
  };

  const addDonePhoto = async () => {
    if (!closing) return;
    const shot = await takePhoto({ parentType: 'task', parentId: closing.id, kind: 'task_proof' });
    if (!shot.ok) {
      if (shot.reason !== 'cancelled') setDoneErr(shot.reason);
      return;
    }
    if (donePhoto) void discardQueuedMedia(donePhoto).catch(() => undefined);
    setDonePhoto(shot.mediaId);
    setDoneErr(null);
  };

  /* The row leaves once the write has landed, not before: a local SQLite
     write is instant, and a row that vanished on a write that then threw
     would come back with nothing on the screen saying why. */
  const markDone = async () => {
    const t = closing;
    if (!t || doneLock.current) return;
    const form = taskFormForShop(t).fields;
    let responses: TaskAnswers | null = null;
    let note = doneNote;
    if (form.length) {
      const problems = taskAnswerProblems(form, answers);
      if (problems.length) {
        setAnswerErrs(new Map(problems.map((p) => [p.fieldId, p.message])));
        setDoneErr(problems.length === 1 ? 'One answer is still needed.' : problems.length + ' answers are still needed.');
        return;
      }
      responses = cleanTaskAnswers(form, answers);
      /* The answers are the "how"; a note he adds goes on top of them. */
      const summary = taskAnswersNote(form, responses);
      note = [doneNote.trim(), summary].filter(Boolean).join('\n');
    } else if (noteRequired && !doneNote.trim()) {
      setDoneErr('Say what you did. Your manager reads this.');
      return;
    }
    doneLock.current = true;
    setDoneBusy(true);
    try {
      await completeTask(t.id, { note, photoId: donePhoto, responses });
      if (responses) void dropTaskDraft(t.id);
      animateLayoutFor(tasks.length);
      setClosing(null);
      notify('Done · ' + t.title);
    } catch (e) {
      setDoneErr(e instanceof Error && e.message ? e.message : 'Could not save. Try again.');
    } finally {
      doneLock.current = false;
      setDoneBusy(false);
      load();
    }
  };

  const openSnooze = (t: Task) => {
    setSnoozing(t);
    setSnoozeTo(snoozeTarget(t.dueDate, today, 1));
    setSnoozeWhy('');
    setSnoozeErr(null);
  };

  const saveSnooze = async () => {
    const t = snoozing;
    if (!t) return;
    const why = snoozeWhy.trim();
    if (!why) return setSnoozeErr('Say why it is moving. Three moves is a story your manager needs.');
    if (!snoozeTo) return setSnoozeErr('Pick the day it moves to.');
    try {
      /* Both halves are kept: the new day and the reason for it, appended
         rather than replaced, because three snoozes is the story. */
      await snoozeTask(t.id, snoozeTo, why);
      setSnoozing(null);
      load(true);
      notify('Moved to ' + dmy(snoozeTo));
    } catch (e) {
      setSnoozeErr(e instanceof Error && e.message ? e.message : 'Could not save. Try again.');
    }
  };

  const h = HERO.lavender;

  return (
    <AppFrame
      chipsBelowTitle
      title="Tasks"
      activeTab={null}
      onBack={back.go}
      showTitle={false}
      hero={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
          <Text
            accessibilityRole="header"
            style={[{ flex: 1, fontSize: 26, lineHeight: 32, letterSpacing: -0.52, color: h.ink }, weight(800)]}>
            Tasks
          </Text>
          <PillButton label="New task" variant="primary" height={44} icon="add" onPress={openForm} />
        </View>
      }
      contentStyle={{ padding: 14, paddingTop: 16, paddingBottom: 24, gap: 10 }}>
      {tasks.length === 0 ? (
        <View
          accessible
          style={{ backgroundColor: C.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 28, alignItems: 'center' }}>
          <Icon name="task" size={32} color={C.faint} strokeWidth={1.8} />
          <Text style={[{ fontSize: 17, lineHeight: 24, color: C.ink, marginTop: 6, textAlign: 'center' }, weight(800)]}>Nothing pending</Text>
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, textAlign: 'center', marginTop: 4 }}>
            What you promise a customer on a visit shows here.
          </Text>
        </View>
      ) : null}

      {BUCKETS.map((g) => {
        const items = tasks.filter((t) => bucketOf(t.dueDate, today) === g);
        const before = BUCKETS.slice(0, BUCKETS.indexOf(g)).reduce(
          (n, b) => n + tasks.filter((t) => bucketOf(t.dueDate, today) === b).length,
          0,
        );
        if (items.length === 0) return null;
        const headInk = g === 'Overdue' ? C.danger : g === 'Today' ? C.warnInk : C.muted;
        return (
          <React.Fragment key={g}>
            {g === 'Overdue' ? (
              <View
                accessible
                accessibilityRole="header"
                accessibilityLabel={g + ', ' + items.length}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: before ? 4 : 0 }}>
                <Text style={[{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: headInk }, weight(800)]}>{g}</Text>
                <View
                  style={{
                    minHeight: 22,
                    minWidth: 22,
                    paddingHorizontal: 6,
                    borderRadius: 11,
                    backgroundColor: C.dangerBg,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                  <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger }, weight(800)]}>{String(items.length)}</Text>
                </View>
              </View>
            ) : (
              <Text accessibilityRole="header" style={[{ fontSize: 13, lineHeight: 18, color: headInk, marginTop: before ? 4 : 0 }, weight(800)]}>
                {g + ' · ' + items.length}
              </Text>
            )}
            {items.map((t, i) => {
              const edge = t.priority === 'High' || g === 'Overdue' ? C.danger : g === 'Today' ? C.warn : null;
              const form = taskFormOf(t);
              const shop = nameOf(t.customerId) || (t.customerId ? '' : 'No shop');
              const fromOffice = t.assignerId && me && t.assignerId !== me;
              /* A heading of "Later" says nothing a man planning a week can
                 use, so anything past tomorrow prints its own date instead of
                 repeating the bucket's name. */
              const due =
                g === 'Overdue'
                  ? 'Overdue by ' + plural(daysSince(t.dueDate, today) ?? 0, 'day')
                  : g === 'This week' || g === 'Later'
                    ? dmy(t.dueDate)
                    : g;
              const action =
                t.sourceType === 'lead_validation' && t.customerId
                  ? 'call'
                  : t.sourceType === 'requirement_visit' && t.customerId
                    ? 'shop'
                    : null;
              const roomy = Boolean(t.description || form.length || action || g === 'Overdue');
              const doneLabel = form.length ? 'Answer' : 'Done';
              const buttons = (
                <>
                  <Pressable
                    onPress={() => openSnooze(t)}
                    accessibilityRole="button"
                    accessibilityLabel="Snooze"
                    accessibilityHint="Move this task to another day"
                    style={({ pressed }) => ({
                      width: 48,
                      height: 48,
                      borderRadius: 24,
                      backgroundColor: pressed ? C.hairline : C.canvas,
                      alignItems: 'center',
                      justifyContent: 'center',
                    })}>
                    <Icon name="forward" size={18} color={C.ink} strokeWidth={2} />
                  </Pressable>
                  <Pressable
                    onPress={() => openDone(t)}
                    accessibilityRole="button"
                    accessibilityLabel={doneLabel}
                    style={({ pressed }) => ({
                      minHeight: 48,
                      paddingVertical: 6,
                      minWidth: 48,
                      paddingHorizontal: form.length ? 18 : 0,
                      borderRadius: 24,
                      backgroundColor: C.primary,
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: pressed ? 0.88 : 1,
                    })}>
                    {form.length ? (
                      <Text style={[{ fontSize: 14, lineHeight: 20, color: '#FFFFFF' }, weight(700)]}>Answer</Text>
                    ) : (
                      <Icon name="tick" size={18} color="#FFFFFF" strokeWidth={2.4} />
                    )}
                  </Pressable>
                </>
              );
              const meta = [shop, fromOffice ? 'From the office' : ''].filter(Boolean);
              /* Swiping left is a SHORTCUT to the Done button on the row,
                 and opens the same sheet: a closed task has to say how. */
              return (
                <Stagger key={t.id} index={before + i}>
                  <SwipeRow
                    /* The "Done" toast already buzzes. */
                    buzz={false}
                    right={{ label: doneLabel, color: C.success, run: () => openDone(t) }}
                    style={{ borderRadius: 20, overflow: 'hidden' }}>
                    <View
                      accessible={false}
                      style={{
                        backgroundColor: C.surface,
                        borderRadius: 20,
                        paddingHorizontal: 16,
                        paddingVertical: 14,
                        overflow: 'hidden',
                      }}>
                      {edge ? (
                        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: edge }} />
                      ) : null}
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                        <Text style={[{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 20, color: C.ink }, weight(700)]}>
                          {t.title}
                        </Text>
                        {t.priority === 'High' ? (
                          <View
                            accessible
                            accessibilityRole="image"
                            accessibilityLabel="High priority"
                            style={{
                              minHeight: 24,
                              paddingVertical: 3,
                              paddingHorizontal: 8,
                              borderRadius: 12,
                              backgroundColor: C.dangerBg,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}>
                            <Text style={[{ fontSize: 11, color: C.danger }, weight(800)]}>HIGH</Text>
                          </View>
                        ) : null}
                      </View>

                      {roomy ? (
                        <>
                          {/* The shop, or — for a task that belongs to none — who
                              set it, so the caption line is never left blank. */}
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                            {shop ? (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                {t.customerId ? <Icon name="shop" size={12} color={C.muted} strokeWidth={2} /> : null}
                                <Text style={[{ flexShrink: 1, fontSize: 12, lineHeight: 17, color: t.customerId ? C.muted : C.faint }, weight(600)]}>{shop}</Text>
                              </View>
                            ) : null}
                            {fromOffice ? (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                <OfficeGlyph />
                                <Text style={[{ flexShrink: 1, fontSize: 12, lineHeight: 17, color: C.muted }, weight(600)]}>From the office</Text>
                              </View>
                            ) : null}
                          </View>
                          {/* What the office wrote is the half of the task that says
                              what to do — a refusal's reason, a manager's
                              instruction. It was stored and never drawn. */}
                          {t.description ? (
                            <Text style={{ fontSize: 13, lineHeight: 18, color: C.body, marginTop: 8 }}>{t.description}</Text>
                          ) : null}
                          {/* A task with a form says how much it asks before he
                              opens it, so "two questions" and "fifteen questions
                              and four photos" are not the same tap. */}
                          {form.length ? (
                            <View
                              accessible
                              accessibilityLabel={formLine(form)}
                              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                              {formLine(form)
                                .split(' · ')
                                .map((part) => (
                                  <Pill key={part} text={part} bg={C.primaryTint} fg={C.primaryDeep} height={28} />
                                ))}
                            </View>
                          ) : null}
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
                            {/* A task that ASKS for something specific opens the screen
                                that answers it. Without this the office raises a
                                validation call and the salesman reads a title with
                                nowhere to go — which is how a workflow becomes a list
                                of sentences people tick off without doing. */}
                            {action === 'call' ? (
                              <Pressable
                                onPress={() => router.push(`/validate?id=${t.customerId}&taskId=${t.id}&from=tasks`)}
                                accessibilityRole="button"
                                accessibilityLabel="Call now"
                                style={({ pressed }) => ({
                                  minHeight: 48,
                                  paddingVertical: 6,
                                  paddingHorizontal: 14,
                                  borderRadius: 24,
                                  backgroundColor: C.navy,
                                  flexDirection: 'row',
                                  alignItems: 'center',
                                  gap: 6,
                                  opacity: pressed ? 0.88 : 1,
                                })}>
                                <Icon name="call" size={16} color={C.lime} strokeWidth={2.2} />
                                <Text style={[{ flexShrink: 1, fontSize: 14, lineHeight: 20, color: '#FFFFFF' }, weight(700)]}>Call now</Text>
                              </Pressable>
                            ) : null}
                            {action === 'shop' ? (
                              <Pressable
                                onPress={() => {
                                  set({ custId: t.customerId ?? undefined, pTab: 0 });
                                  router.push('/customer');
                                }}
                                accessibilityRole="button"
                                accessibilityLabel="Open shop"
                                style={({ pressed }) => ({
                                  minHeight: 48,
                                  paddingVertical: 6,
                                  paddingHorizontal: 14,
                                  borderRadius: 24,
                                  backgroundColor: pressed ? C.hairline : C.canvas,
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                })}>
                                <Text style={[{ fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>Open shop</Text>
                              </Pressable>
                            ) : null}
                            <View
                              accessible
                              accessibilityLabel={due}
                              style={{
                                flex: 1,
                                flexDirection: 'row',
                                alignItems: 'center',
                                justifyContent: action ? 'flex-end' : 'flex-start',
                                gap: 4,
                              }}>
                              {g === 'Overdue' ? (
                                <>
                                  <Icon name="clock" size={14} color={C.danger} strokeWidth={2.2} />
                                  <Text style={[{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: C.danger }, weight(700)]}>
                                    {plural(daysSince(t.dueDate, today) ?? 0, 'day') + ' late'}
                                  </Text>
                                </>
                              ) : g === 'This week' || g === 'Later' ? (
                                <>
                                  <Icon name="cal" size={13} color={C.muted} strokeWidth={2} />
                                  <Text style={[{ flexShrink: 1, fontSize: 12, lineHeight: 17, color: C.muted }, weight(700)]}>{due}</Text>
                                </>
                              ) : null}
                            </View>
                            {buttons}
                          </View>
                        </>
                      ) : (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                          <Text
                            accessibilityLabel={[...meta, due].join(', ')}
                            style={[{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17, color: t.customerId || fromOffice ? C.muted : C.faint }, weight(600)]}>
                            {[...meta, g === 'Later' || g === 'This week' ? due : ''].filter(Boolean).join(' · ')}
                          </Text>
                          {buttons}
                        </View>
                      )}
                    </View>
                  </SwipeRow>
                </Stagger>
              );
            })}
          </React.Fragment>
        );
      })}

      <BottomSheet open={formOpen} onClose={() => setFormOpen(false)} scroll>
        <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 25, color: C.ink }, weight(800)]}>
          New task
        </Text>

        <Input
          value={title}
          onChangeText={(v) => {
            setTitle(v);
            setTitleErr(false);
          }}
          accessibilityLabel="What to do"
          placeholder="What to do: take the rate list to Balaji"
          invalid={titleErr}
          style={[WASH, { minHeight: 52, borderRadius: 26, marginTop: 12 }, titleErr ? { borderWidth: 2, borderColor: C.danger } : null]}
        />
        {titleErr ? (
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger, marginTop: 6 }, weight(600)]}>Write what needs to be done.</Text>
        ) : null}

        <Text style={[{ fontSize: 13, lineHeight: 18, color: C.ink, marginTop: 14 }, weight(700)]} accessibilityLabel="Which customer">
          Customer
        </Text>
        <View style={{ flexDirection: 'row', marginTop: 6 }}>
          <SearchBox
            value={custQuery}
            onChange={setCustQuery}
            onClear={() => setCustQuery('')}
            placeholder="Name, area or phone"
            bg={C.canvas}
          />
        </View>
        <View style={{ marginTop: 6 }}>
          {/* A job that belongs to nobody in particular is a real task —
              "collect the rate cards from the office" — and a radio list with
              no such row made it unrecordable. It is first because it is also
              the only way to undo a pick. */}
          <PickRow
            label="No customer · general work"
            a11y="No customer. General work"
            picked={picked === null}
            onPress={() => setPicked(null)}
          />
          {/* A pick made before the search was typed stays on screen and
              stays chosen, even once it has fallen out of the results. */}
          {picked && !customers.some((c) => c.id === picked.id) ? (
            <PickRow label={picked.name} picked onPress={() => setPicked(null)} />
          ) : null}
          {customers.map((x, i) => (
            <PickRow
              key={x.id}
              label={x.name}
              sub={[x.area, x.city].filter(Boolean).join(' · ') || undefined}
              picked={picked?.id === x.id}
              last={i === customers.length - 1}
              onPress={() => setPicked({ id: x.id, name: x.name })}
            />
          ))}
          {custQuery.trim() && customers.length === 0 ? (
            <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, textAlign: 'center', marginTop: 6 }}>No customer found.</Text>
          ) : null}
          {bookTotal > customers.length ? (
            <Text
              accessibilityLabel={'Showing ' + customers.length + ' of ' + bookTotal + '. Search to find more.'}
              style={{ fontSize: 12, lineHeight: 17, color: C.muted, textAlign: 'center', marginTop: 4 }}>
              {customers.length + ' of ' + bookTotal + ' · search for more'}
            </Text>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <Icon name="cal" size={18} color={C.ink} strokeWidth={2} />
          <Seg options={WHENS} value={when} onChange={setWhen} label="When" />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <FlagGlyph />
          <Seg options={PRIS} value={pri} onChange={setPri} label="Priority" danger="High" />
        </View>

        <SheetActions onCancel={() => setFormOpen(false)} label="Add task" onPress={save} />
      </BottomSheet>

      <BottomSheet open={closing !== null} onClose={closeDone} scroll>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: closingForm.length ? C.primaryTint : C.successBg,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            {closingForm.length ? (
              <ClipboardGlyph />
            ) : (
              <Icon name="tick" size={22} color={C.success} strokeWidth={2.2} />
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 25, color: C.ink }, weight(800)]}>
              {closingForm.length ? 'Answer and finish' : 'Mark as done'}
            </Text>
            {closing ? <Text style={{ marginTop: 4, fontSize: 12, lineHeight: 17, color: C.muted }}>{closing.title}</Text> : null}
          </View>
        </View>
        {closing?.description && closingForm.length ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.body, marginTop: 8 }}>{closing.description}</Text>
        ) : null}
        {closing && closingForm.length ? (
          <View style={{ marginTop: 14 }}>
            <TaskFormFields
              taskId={closing.id}
              fields={closingForm}
              answers={answers}
              onChange={changeAnswers}
              problems={answerErrs}
            />
          </View>
        ) : null}
        <Text
          accessibilityLabel={closingForm.length ? 'Anything else (optional)' : noteRequired ? 'What you did · needed' : 'What you did'}
          style={[{ fontSize: 13, lineHeight: 18, color: C.ink, marginTop: 14 }, weight(700)]}>
          {closingForm.length ? 'Anything else' : 'What you did'}
          {closingForm.length ? (
            <Text style={[{ color: C.faint }, weight(500)]}>{' optional'}</Text>
          ) : noteRequired ? (
            <Text style={{ color: C.danger }}>{' *'}</Text>
          ) : null}
        </Text>
        <VoiceField
          value={doneNote}
          onChangeText={(v) => {
            setDoneNote(v);
            setDoneErr(null);
          }}
          placeholder={closingForm.length ? 'Anything the questions did not ask.' : 'Gave them the new rate list. They will order next week.'}
          multiline
          maxLength={2000}
          style={[WASH, { borderRadius: 20, minHeight: closingForm.length ? 64 : 88, marginTop: 6, paddingVertical: 12 }]}
        />
        {closingForm.length ? null : (
          <Pressable
            onPress={() => void addDonePhoto()}
            accessibilityRole="button"
            accessibilityLabel={donePhoto ? 'Photo added. Take it again' : 'Add a photo (optional)'}
            style={({ pressed }) => ({
              marginTop: 10,
              minHeight: 48,
              paddingVertical: 8,
              borderRadius: 24,
              borderWidth: 1.5,
              borderStyle: 'dashed',
              borderColor: donePhoto ? C.success : '#B9A6FF',
              backgroundColor: donePhoto ? C.successBg : pressed ? C.primaryTint : '#F7F4FF',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            })}>
            <Icon name={donePhoto ? 'tick' : 'camera'} size={18} color={donePhoto ? C.success : C.primaryDeep} strokeWidth={2} />
            <Text style={[{ flexShrink: 1, fontSize: 14, lineHeight: 20, color: donePhoto ? C.success : C.primaryDeep }, weight(700)]}>
              {donePhoto ? 'Photo added · take it again' : 'Photo · optional'}
            </Text>
          </Pressable>
        )}
        {closingForm.length ? (
          <View
            accessible
            accessibilityLabel="Your answers are kept on the phone if you close this — finish later."
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <SaveGlyph />
            <Text style={{ flex: 1, fontSize: 12, lineHeight: 17, color: C.muted }}>Answers kept on the phone if you close · finish later</Text>
          </View>
        ) : null}
        {doneErr ? <ErrBox text={doneErr} /> : null}
        <SheetActions
          onCancel={closeDone}
          label={doneBusy ? 'Saving…' : closingForm.length ? 'Submit' : 'Done'}
          busy={doneBusy}
          onPress={() => void markDone()}
        />
      </BottomSheet>

      <BottomSheet open={snoozing !== null} onClose={() => setSnoozing(null)} scroll>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.warnBg, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="forward" size={22} color={C.warnInk} strokeWidth={2} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text accessibilityRole="header" style={[{ fontSize: 20, lineHeight: 25, color: C.ink }, weight(800)]}>
              Move to another day
            </Text>
            {snoozing ? <Text style={{ marginTop: 4, fontSize: 12, lineHeight: 17, color: C.muted }}>{snoozing.title}</Text> : null}
          </View>
        </View>
        {snoozing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 }}>
            {(
              [
                { n: 1, label: '+1 day', a11y: 'Next day' },
                { n: 7, label: '+1 week', a11y: 'A week later' },
              ] as const
            ).map((o) => {
              const d = snoozeTarget(snoozing.dueDate, today, o.n);
              const on = snoozeTo === d;
              return (
                <Pressable
                  key={o.n}
                  onPress={() => {
                    if (!on) feedback('select');
                    setSnoozeTo(d);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={o.a11y}
                  hitSlop={{ top: 4, bottom: 4 }}
                  style={{
                    minHeight: 40,
                    paddingVertical: 6,
                    paddingHorizontal: 16,
                    borderRadius: 20,
                    backgroundColor: on ? C.navy : C.canvas,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                  <Text style={[{ fontSize: 13, lineHeight: 18, color: on ? '#FFFFFF' : C.ink }, weight(700)]}>{o.label}</Text>
                </Pressable>
              );
            })}
            <Text
              accessibilityLabel={snoozeTo ? 'Moves to ' + dmy(snoozeTo) : undefined}
              style={[{ flex: 1, textAlign: 'right', fontSize: 14, lineHeight: 20, color: C.ink }, weight(700)]}>
              {snoozeTo ? '→ ' + dmy(snoozeTo) : ''}
            </Text>
          </View>
        ) : null}
        <View style={{ marginTop: 12 }}>
          <Calendar
            selected={snoozeTo}
            onPick={(d) => {
              setSnoozeTo(d);
              setSnoozeErr(null);
            }}
            disabledReason={(d) =>
              snoozing && d <= (snoozing.dueDate > today ? snoozing.dueDate : today)
                ? 'Pick a day after ' + dmy(snoozing.dueDate > today ? snoozing.dueDate : today) + '.'
                : null
            }
          />
        </View>
        <Text accessibilityLabel="Why · needed" style={[{ fontSize: 13, lineHeight: 18, color: C.ink, marginTop: 12 }, weight(700)]}>
          Why
          <Text style={{ color: C.danger }}>{' · needed'}</Text>
        </Text>
        <Input
          value={snoozeWhy}
          onChangeText={(v) => {
            setSnoozeWhy(v);
            setSnoozeErr(null);
          }}
          accessibilityLabel="Why it is moving"
          placeholder="Shop was closed today"
          style={[WASH, { marginTop: 6 }]}
        />
        {snoozeErr ? (
          <Text style={[{ fontSize: 12, lineHeight: 17, color: C.danger, marginTop: 6 }, weight(600)]}>{snoozeErr}</Text>
        ) : null}
        <SheetActions onCancel={() => setSnoozing(null)} label="Move it" onPress={() => void saveSnooze()} />
      </BottomSheet>
    </AppFrame>
  );
}

/** The wash pill a typed answer goes into on these sheets. */
const WASH = { backgroundColor: C.canvas, borderWidth: 0, borderRadius: 24, minHeight: 48, fontSize: 15, paddingHorizontal: 16 } as const;

/** The red line a sheet refuses with. */
function ErrBox({ text }: { text: string }) {
  return (
    <View style={{ marginTop: 10, backgroundColor: C.dangerBg, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 }}>
      <Text style={[{ fontSize: 13, lineHeight: 18, color: C.danger }, weight(600)]}>{text}</Text>
    </View>
  );
}

/** A pickable row: the name, the line under it, a ring that ticks. */
function PickRow({
  label,
  sub,
  a11y,
  picked,
  last,
  onPress,
}: {
  label: string;
  sub?: string;
  a11y?: string;
  picked: boolean;
  last?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: picked }}
      accessibilityLabel={[a11y ?? label, sub].filter(Boolean).join(', ')}
      style={({ pressed }) => ({
        minHeight: sub ? 56 : 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: C.hairline,
        opacity: pressed ? 0.7 : 1,
      })}>
      <View style={{ flex: 1, minWidth: 0, paddingVertical: 8 }}>
        <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink }, weight(700)]}>{label}</Text>
        {sub ? <Text style={{ marginTop: 2, fontSize: 12, lineHeight: 17, color: C.muted }}>{sub}</Text> : null}
      </View>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: picked ? 0 : 2,
          borderColor: '#DCE3EE',
          backgroundColor: picked ? C.primary : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        {picked ? <Icon name="tick" size={12} color="#FFFFFF" strokeWidth={3} /> : null}
      </View>
    </Pressable>
  );
}

/** The wash segmented switch the New task sheet picks When and Priority with. */
function Seg<K extends string>({
  options,
  value,
  onChange,
  label,
  danger,
}: {
  options: readonly K[];
  value: K;
  onChange: (k: K) => void;
  label: string;
  /** The option drawn in red when not picked — High. */
  danger?: K;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{ flex: 1, minHeight: 44, borderRadius: 22, backgroundColor: C.canvas, padding: 4, flexDirection: 'row', gap: 4 }}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable
            key={o}
            onPress={() => {
              if (!on) feedback('select');
              onChange(o);
            }}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={label + ': ' + o}
            hitSlop={{ top: 4, bottom: 4 }}
            style={{ flex: 1, borderRadius: 18, backgroundColor: on ? C.navy : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[{ fontSize: 13, lineHeight: 18, color: on ? '#FFFFFF' : o === danger ? C.danger : C.ink }, weight(700)]}>{o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function OfficeGlyph() {
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24" fill="none">
      <Path d="M4 21V5l8-2 8 2v16M9 21v-4h6v4" stroke={C.muted} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

function FlagGlyph() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path d="M5 21V4h11l-2 4 2 4H5" stroke={C.ink} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

function ClipboardGlyph() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path d="M9 4h6v3H9zM6 6h12v15H6zM9 12l2 2 4-4" stroke={C.primaryDeep} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

function SaveGlyph() {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
      <Path d="M5 5h11l3 3v11H5zM8 5v5h7V5" stroke={C.success} strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}
