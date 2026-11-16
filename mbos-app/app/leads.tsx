import React from 'react';
import { AppFrame, useCameFrom } from '../src/components/shell/AppFrame';
import { LeadsBook } from '../src/components/leads/leads-book';

/**
 * The Leads route — the door that already existed.
 *
 * The list itself moved into `LeadsBook` when the Customers tab grew a Leads
 * half, because a salesman who reaches leads from the tab he already has open
 * and one who reaches them from More must be looking at the same list. This
 * route is kept rather than redirected: it is on the More screen with an open
 * count beside it, it is where anybody who has used this app already looks,
 * and a redirect would take the back link with it — `useCameFrom` is how
 * somebody who opened this from a task gets back to the task.
 *
 * V3 draws the title, the count and the search row inside the lavender hero,
 * and those belong to the book's own state — so the book is handed the frame
 * and fills both halves. `scroll={false}` because the book owns its own
 * scrolling. See its header.
 */
export default function LeadsScreen() {
  const back = useCameFrom('more');
  return (
    <LeadsBook
      frame={({ hero, body }) => (
        <AppFrame
          title="Leads"
          tone="lavender"
          showTitle={false}
          hero={hero}
          activeTab={null}
          onBack={back.go}
          scroll={false}
          contentStyle={{ padding: 0 }}>
          {body}
        </AppFrame>
      )}
    />
  );
}
