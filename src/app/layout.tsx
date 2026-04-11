import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Streaming Releases",
  description:
    "Upcoming streaming movie and TV show releases with calendar and list views, powered by TMDB.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full bg-ink-950 text-ink-100 antialiased">{children}</body>
    </html>
  );
}
