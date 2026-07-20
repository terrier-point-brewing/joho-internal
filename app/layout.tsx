import type { Metadata } from "next";
import { cookies } from "next/headers";
import {
  Geist,
  Geist_Mono,
  Jost,
  Lato,
  Marcellus,
  Noto_Serif_SC,
} from "next/font/google";
import { Suspense } from "react";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import BrandStyle from "./components/brand/BrandStyle";
import NavBar from "./components/NavBar";
import Providers from "./providers";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { resolveThemeAttr, THEME_COOKIE } from "@/lib/brand/theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Brand fonts — neutral next/font variable names (avoids colliding with the
// --font-brand-* custom properties, which `@theme` in globals.css owns and
// references via `var(--font-marcellus)` etc. with a literal fallback).
const marcellus = Marcellus({
  variable: "--font-marcellus",
  subsets: ["latin"],
  weight: "400",
});

const lato = Lato({
  variable: "--font-lato",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin"],
  weight: "500",
});

const notoSerifSC = Noto_Serif_SC({
  variable: "--font-noto-serif-sc",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "TPB Square Reports",
  description: "Square sales reports for Terrier Point Brewing",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const themeAttr = resolveThemeAttr((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${marcellus.variable} ${lato.variable} ${jost.variable} ${notoSerifSC.variable} h-full antialiased`}
      {...(themeAttr ? { "data-theme": themeAttr } : {})}
    >
      <body className="min-h-screen flex flex-row bg-canvas">
        <BrandStyle />
        <Providers>
          <Suspense>
            <NavBar />
          </Suspense>
          <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden pt-11 md:pt-0 pb-16 md:pb-0">
            {children}
          </div>
        </Providers>
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  );
}
