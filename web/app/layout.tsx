import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Paddock Wellness Club",
  description: "Transform your mind, body, and spirit at The Paddock Wellness Club",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
