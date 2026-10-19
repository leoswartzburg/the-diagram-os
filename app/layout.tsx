import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

export const metadata: Metadata = {
  title: "The Diagram",
  description: "Personal AI Operating System — powered by Spectre",
  // iOS home-screen install (prerequisite for Web Push on iOS): apple-touch-icon + standalone
  // status bar. The manifest (app/manifest.ts) carries the rest.
  appleWebApp: {
    capable: true,
    title: "Diagram",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// maximumScale: 1 stops iOS Safari from auto-zooming on input focus. iOS 10+ still
// permits manual pinch-zoom even with this set, which is acceptable for a personal app.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} h-full`}>
      <body className="h-full bg-[#03030A] text-white antialiased" style={{ fontFamily: "var(--font-space-grotesk)" }}>
        {children}
      </body>
    </html>
  );
}
