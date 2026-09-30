"use client";

import { Button, Card } from "@/components/ui/primitives";

/**
 * A read failed. The message is ours and never the error's: a thrown query
 * carries its statement and its parameters, and that is a thing to log, not to
 * print in front of a manager. `digest` is what an administrator can search the
 * server log for.
 */
export default function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="p-6">
      <Card className="px-6 py-10 text-center">
        <div className="text-[15px] font-semibold text-ink">This screen could not be loaded</div>
        <div className="mt-1 text-sm text-muted">
          Something went wrong on the server. Nothing you did was lost, and nothing was changed.
        </div>
        {error.digest ? <div className="mt-2 font-mono text-[11px] text-muted">Reference: {error.digest}</div> : null}
        <div className="mt-4">
          <Button variant="primary" onClick={reset}>Try again</Button>
        </div>
      </Card>
    </div>
  );
}
