import { MyFeedbackPage } from "@/components/feedback/my-feedback-page";

export const metadata = { title: "Feedback - MahekOne ERP" };

/** ERP's own Feedback — what this person sent in from any app, and the replies. */
export default function FeedbackPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <MyFeedbackPage searchParams={searchParams} />;
}
