import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chief of Staff",
  description: "Multi-channel communication agent — triage, draft, approve, send.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
