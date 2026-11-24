import type { Metadata, Viewport } from "next";

import { MotionProviders } from "@/components/providers/MotionProviders";
import { SITE_NAME, SITE_URL } from "@/lib/site";

import { fontVariables } from "./fonts";
import "./globals.css";

// Placeholders: the real title, description and share image come from the Sanity Site settings document (W72).
// Each page's own title goes into the template (docs/build-standards.md, section 2).
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME,
  title: { default: SITE_NAME, template: "%s | The Paddock" },
  description: "Transform your mind, body, and spirit at The Paddock Wellness Club",
  openGraph: { siteName: SITE_NAME, locale: "en_GB", type: "website" },
};

// Zoom is never switched off (docs/build-standards.md, section 1: no maximum scale, no user-scalable=no).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-GB" data-theme="light" className={`${fontVariables} antialiased`}>
      {/* The page is at least the window's height by the body's own minimum, not by a height on <html>: Lenis sets
          <html> and <body> to `height: auto` while it runs, which would undo a height passed down from <html>. */}
      <body className="flex min-h-dvh flex-col">
        <MotionProviders>{children}</MotionProviders>
      </body>
    </html>
  );
}
