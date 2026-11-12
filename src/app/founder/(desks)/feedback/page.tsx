import { MyFeedbackPage } from "@/components/feedback/my-feedback-page";

export const metadata = { title: "Feedback - MahekOne Founder" };

/** The Founder app's own Feedback, as a desk in the Command Centre's frame. */
export default function FounderFeedbackPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <MyFeedbackPage searchParams={searchParams} className="w-full max-w-[1280px]" />;
}
