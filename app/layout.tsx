import type { Metadata } from "next";
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
import BrandChrome from "./components/brand/BrandChrome";
import NavBar from "./components/NavBar";
import Providers from "./providers";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { THEME_COOKIE } from "@/lib/brand/theme";

// Pre-hydration theme script: reads the brand-theme cookie and stamps
// data-theme on <html> before first paint, so brand surfaces render in the
// chosen mode with no flash — WITHOUT a server-side cookies() read (which
// would force every route to render dynamically). Unset/"system" leaves the
// attribute off so prefers-color-scheme decides. Mirrors resolveThemeAttr.
const themeScript = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);var v=m?decodeURIComponent(m[1]):null;if(v==="light"||v==="dark"){document.documentElement.dataset.theme=v;}}catch(e){}})();`;

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${marcellus.variable} ${lato.variable} ${jost.variable} ${notoSerifSC.variable} h-full antialiased`}
    >
      <body className="min-h-screen flex flex-row bg-canvas">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <BrandStyle />
        {/* When the "brand skin" setting is on, overrides ops --color-* with the
            brand palette app-wide; renders nothing when off (zinc/amber default). */}
        <BrandChrome />
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
