import React from 'react';
import { View, Pressable } from 'react-native';
import { AppFrame, BackLink, useCameFrom } from '../src/components/shell/AppFrame';
import { Badge, ListCard, T } from '../src/components/ui/primitives';
import { color as C, type, weight, type BadgeTone } from '../src/theme/tokens';
import { KNOWLEDGE } from '../src/data/fixtures';
import { useStore } from '../src/state/store';

/**
 * Training, short enough to do between two shops. The line under the title
 * says a manager can see who has finished, because a module that nobody is
 * accountable for is a module nobody opens.
 */

export default function KnowledgeScreen() {
  const back = useCameFrom('more');
  const notify = useStore((s) => s.notify);

  return (
    <AppFrame title="Knowledge centre" activeTab={null} onBack={back.go} contentStyle={{ padding: 16, paddingBottom: 24 }}>
      <BackLink label={back.label} onPress={back.go} />

      <T style={type.h1}>Knowledge centre</T>
      <T s="small" style={{ color: C.muted, marginTop: 2 }}>
        One module is due. Your manager sees who has finished.
      </T>

      <ListCard style={{ marginTop: 12 }}>
        {KNOWLEDGE.map((k, i) => {
          const tone: BadgeTone = k.done ? 'success' : k.due ? 'amber' : 'neutral';
          return (
            <Pressable
              key={k.title}
              onPress={() => notify(k.title)}
              accessibilityRole="button"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingHorizontal: 16,
                paddingVertical: 14,
                borderTopWidth: i ? 1 : 0,
                borderTopColor: C.wash,
              }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T style={[{ fontSize: 15, color: C.ink }, weight(500)]}>{k.title}</T>
                <T s="caption">{k.kind + ' · ' + k.mins + ' min'}</T>
              </View>
              <Badge tone={tone}>{k.done ? 'Done' : k.due ? 'Due' : 'Not started'}</Badge>
            </Pressable>
          );
        })}
      </ListCard>
      <T s="caption" style={{ marginTop: 12 }}>This list is not live yet.</T>
    </AppFrame>
  );
}
