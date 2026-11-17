import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { Icon } from '../src/components/ui/Icon';
import { Glyph, type GlyphShape } from '../src/components/me/kit';
import { color as C, weight } from '../src/theme/tokens';
import { listCourses, type CourseRow } from '../src/data/library';
import { useStore } from '../src/state/store';
import { Stagger } from '../src/components/ui/motion';

/**
 * Training, short enough to do between two shops.
 *
 * Like the document library, this listed four invented modules and admitted it
 * in a caption. The pull carries `courses`, so the real ones are read here and
 * an empty centre says nothing has been published rather than showing a course
 * nobody can open.
 */

export default function KnowledgeScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);
  const [courses, setCourses] = React.useState<CourseRow[] | null>(null);

  useFocusEffect(
    React.useCallback(() => {
      void listCourses().then(setCourses);
    }, []),
  );

  return (
    <AppFrame
      tone="canvas"
      title="Knowledge centre"
      activeTab={null}
      onBack={back.go}
      hero={
        /* THE NAG IS GONE, because nothing on this screen can answer it.
           It read "2 modules are due. Your manager sees who has finished." on a
           screen where a module can be neither opened nor ticked off — the
           course's material is not on the wire at all, and `completedAt` is read
           here and written by nobody, in the office or on the phone. So the
           count could never fall, and being chased for work with no way to do it
           and a manager named as watching is worse than not being told. What it
           says instead is what is true: this is the list, and the doing is not
           here yet. It comes back the day something writes a completion. */
        <View
          accessible
          accessibilityLabel="Training from the office, and when each is due. You cannot open or finish a module on the phone yet."
          style={{
            marginTop: 8,
            alignSelf: 'flex-start',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minHeight: 36,
            paddingHorizontal: 12,
            borderRadius: 18,
            backgroundColor: C.warnBg,
          }}>
          <Icon name="lock" size={16} color={C.warnInk} strokeWidth={2} />
          <Text style={[{ fontSize: 13, lineHeight: 18, color: C.warnInk }, weight(600)]}>List only · cannot open or finish it here yet</Text>
        </View>
      }
      contentStyle={{ padding: 16, paddingBottom: 24 }}>
      {courses === null ? (
        <View style={{ backgroundColor: C.surface, borderRadius: 20, paddingVertical: 22, paddingHorizontal: 12 }}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: C.muted, textAlign: 'center' }}>Looking…</Text>
        </View>
      ) : courses.length === 0 ? (
        <View
          accessible
          accessibilityLabel="Nothing published yet. Training will show here when the office adds it."
          style={{ backgroundColor: C.surface, borderRadius: 20, padding: 16 }}>
          <Text style={[{ fontSize: 15, lineHeight: 21, color: C.ink, textAlign: 'center' }, weight(800)]}>Nothing published yet</Text>
          <Text style={{ fontSize: 12, lineHeight: 17, color: C.muted, textAlign: 'center', marginTop: 2 }}>
            Shows when the office adds it.
          </Text>
        </View>
      ) : (
        <View style={{ backgroundColor: C.surface, borderRadius: 22, paddingHorizontal: 16 }}>
          {courses.map((k, i) => {
            const done = k.completedAt != null;
            /* No amber "Due": a course cannot be opened or finished on the
               phone yet, so a badge demanding one is a demand he has no way to
               meet. Required is said plainly instead. */
            const isDue = !done && k.mandatory === 1;
            const badge = done ? 'Done' : isDue ? 'Required' : 'Not started';
            const facts = [k.kind, k.minutes ? k.minutes + ' min' : null, k.deadline ? 'by ' + k.deadline : null];
            const lead = done ? LEAD.done : LEAD[kindKey(k.kind)];
            return (
              <Stagger key={k.id} index={i}>
                <Pressable
                  /* A DURATION CANNOT SAY WHETHER THERE IS ANYTHING TO OPEN, and
                     it was the thing deciding. This chose between "about 20
                     minutes" and "nothing attached to open" on `minutes`, so a
                     course with material and no stated length said there was
                     nothing there, and one with a length and no material said how
                     long it would take and then did nothing at all.

                     The handset cannot answer that question either way:
                     `mbos_courses.attachment_id` exists in the office and is not
                     on the wire, so there is no file reference on this row to
                     branch on. Until it is sent, the tap says the one thing that
                     is true of every row — which is a refusal, and better than a
                     confident wrong sentence about somebody's training. */
                  onPress={() => notify(k.title + ' cannot be opened on the phone yet.', 'error')}
                  accessibilityRole="button"
                  accessibilityLabel={`${k.title}. ${facts.filter(Boolean).join(', ') || 'Course'}. ${badge}`}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 68,
                    paddingVertical: 10,
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: C.hairline,
                    opacity: pressed ? 0.7 : 1,
                  })}>
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      backgroundColor: lead.bg,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                    <Glyph shapes={lead.glyph} size={18} color={lead.ink} strokeWidth={done ? 2.4 : 2} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[{ fontSize: 15, lineHeight: 20, color: C.ink }, weight(600)]}>{k.title}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, marginTop: 2 }}>
                      {facts.some(Boolean) ? (
                        <>
                          {k.kind ? <Text style={META}>{k.kind}</Text> : null}
                          {k.minutes ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                              <Icon name="clock" size={12} color={C.muted} strokeWidth={2.2} />
                              <Text style={META}>{k.minutes + ' min'}</Text>
                            </View>
                          ) : null}
                          {k.deadline ? (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                              <Icon name="cal" size={12} color={C.muted} strokeWidth={2.2} />
                              <Text style={META}>{'by ' + k.deadline}</Text>
                            </View>
                          ) : null}
                        </>
                      ) : (
                        <Text style={META}>Course</Text>
                      )}
                    </View>
                  </View>
                  <View
                    style={{
                      minHeight: 28,
                      paddingVertical: 4,
                      paddingHorizontal: 10,
                      borderRadius: 14,
                      justifyContent: 'center',
                      backgroundColor: done ? C.successBg : isDue ? C.navy : C.canvas,
                    }}>
                    <Text style={[{ fontSize: 12, lineHeight: 17, color: done ? C.success : isDue ? '#FFFFFF' : C.muted }, weight(700)]}>
                      {badge}
                    </Text>
                  </View>
                </Pressable>
              </Stagger>
            );
          })}
        </View>
      )}
    </AppFrame>
  );
}

const META = { fontSize: 12, lineHeight: 16, color: C.muted } as const;

/** Which mark leads a row: what kind of training it is, or that it is done. */
function kindKey(kind: string | null): 'video' | 'reading' | 'course' {
  const k = (kind ?? '').toLowerCase();
  if (k.includes('video')) return 'video';
  if (k.includes('read') || k.includes('article') || k.includes('pdf')) return 'reading';
  return 'course';
}

const LEAD: Record<'video' | 'reading' | 'course' | 'done', { glyph: GlyphShape[]; bg: string; ink: string }> = {
  video: { glyph: [{ r: [3, 6, 13, 12, 2] }, { p: 'M16 10l5-3v10l-5-3z' }], bg: C.primaryTint, ink: C.primaryDeep },
  reading: {
    glyph: [{ p: 'M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z' }],
    bg: C.canvas,
    ink: C.muted,
  },
  course: { glyph: [{ p: 'M3 9l9-5 9 5-9 5z' }, { p: 'M7 11v5c3 2 7 2 10 0v-5' }], bg: C.canvas, ink: C.muted },
  done: { glyph: [{ p: 'M5 12l5 5 9-10' }], bg: C.successBg, ink: C.success },
};
