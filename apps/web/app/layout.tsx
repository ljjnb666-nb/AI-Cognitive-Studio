import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Cognitive Studio",
  description: "Phase 0 engineering foundation",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
