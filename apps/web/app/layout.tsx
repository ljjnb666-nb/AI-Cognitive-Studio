import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Cognitive Studio",
  description: "把书转化为有证据支撑的内容",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
