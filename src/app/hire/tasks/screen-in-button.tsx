"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { screenInCandidate } from "@/lib/hire/actions/pipeline";
import { Btn } from "../_ui/kit";

/** Pass the Application stage from the task list — the person has read it, and says so. */
export function ScreenInButton({ applicationId }: { applicationId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Btn
      size="sm"
      disabled={pending}
      title="You have read the application and it should go on to the next stage"
      onClick={() =>
        start(async () => {
          const r = await toast.run(screenInCandidate(applicationId));
          if (r.ok) router.refresh();
        })
      }
    >
      {pending ? "Saving…" : "Screen in"}
    </Btn>
  );
}
