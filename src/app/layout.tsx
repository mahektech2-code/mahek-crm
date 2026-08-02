import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MahekOne — CRM",
  description:
    "Mahek Marketing India's connected workspace. CRM for the telecaller team.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/*
          App Router: this lives in the root layout, so it loads for every page.
          The rule below is a Pages Router concern and does not apply here.
        */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@9..144,100..1000&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
