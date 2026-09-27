"use client";

import { registerPanel, type PanelProps } from "../panels";

/* A help video plays inside the ERP: a YouTube link in the privacy-enhanced
   player, an uploaded file through the attachment endpoint that checks the
   viewer may open it. */

type Video = { youtube: string | null; file: string | null; url: string | null };

function VideoPanel({ data }: PanelProps) {
  const v = data as Video;
  if (v.youtube)
    return (
      <div style={{ position: "relative", paddingTop: "56.25%", borderRadius: 8, overflow: "hidden", background: "#161616" }}>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${v.youtube}`}
          title="Help video"
          allow="accelerometer; encrypted-media; picture-in-picture"
          allowFullScreen
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
        />
      </div>
    );
  if (v.file) return <video src={`/api/attachments/${v.file}`} controls style={{ width: "100%", borderRadius: 8, background: "#161616" }} />;
  return <span style={{ fontSize: 13, color: "#6B7385" }}>{v.url ? "That link is not a YouTube video the ERP can play." : "No video attached."}</span>;
}

registerPanel("video", (p) => <VideoPanel {...p} />);
