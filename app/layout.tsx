import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import NavBar from "./components/NavBar";
import Providers from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-screen flex flex-row bg-zinc-950">
        <Providers>
          <Suspense>
            <NavBar />
          </Suspense>
          <div className="flex-1 min-w-0 overflow-auto pt-11 md:pt-0 pb-16 md:pb-0">
            {children}
          </div>
        </Providers>
      </body>
    </html>
  );
}
