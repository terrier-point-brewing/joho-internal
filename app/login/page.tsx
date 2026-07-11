"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import Banner from "@/app/components/ui/Banner";

type View = "login" | "request";

export default function LoginPage() {
  const router = useRouter();
  const [view, setView] = useState<View>("login");

  // Login state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  // Request state
  const [reqName, setReqName] = useState("");
  const [reqEmail, setReqEmail] = useState("");
  const [reqReason, setReqReason] = useState("");
  const [reqError, setReqError] = useState<string | null>(null);
  const [reqDone, setReqDone] = useState(false);
  const [requesting, setRequesting] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setLoggingIn(true);

    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setLoginError(error.message);
      setLoggingIn(false);
    } else {
      window.location.href = "/";
    }
  }

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setReqError(null);
    setRequesting(true);

    const res = await fetch("/api/admin/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: reqName, email: reqEmail, reason: reqReason }),
    });

    if (!res.ok) {
      const data = await res.json();
      setReqError(data.error ?? "Failed to submit request");
    } else {
      setReqDone(true);
    }
    setRequesting(false);
  }

  return (
    <div className="min-h-[calc(100svh-6.75rem)] md:min-h-screen flex items-center justify-center bg-canvas">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="text-2xl font-bold text-primary tracking-wide">TPB</span>
          <p className="mt-1 text-sm text-muted">Terrier Point Brewing</p>
        </div>

        {view === "login" ? (
          <form
            onSubmit={handleLogin}
            className="bg-surface border border-line rounded-lg p-6 flex flex-col gap-4"
          >
            <h1 className="text-base font-semibold text-primary">Sign in</h1>

            {loginError && <Banner tone="danger">{loginError}</Banner>}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-xs font-medium text-secondary">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="inp"
                placeholder="you@example.com"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-xs font-medium text-secondary">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="inp"
                placeholder="••••••••"
              />
            </div>

            <button type="submit" disabled={loggingIn} className="btn-primary mt-1 w-full">
              {loggingIn ? "Signing in…" : "Sign in"}
            </button>

            <button
              type="button"
              onClick={() => setView("request")}
              className="text-xs text-faint hover:text-secondary transition-colors text-center"
            >
              Don&apos;t have an account? Request access
            </button>
          </form>
        ) : reqDone ? (
          <div className="bg-surface border border-line rounded-lg p-6 flex flex-col gap-4 text-center">
            <div className="text-success mx-auto">
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <circle cx="16" cy="16" r="15" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M10 16l4 4 8-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <p className="text-sm text-body">
              Your request has been submitted. An admin will review it and create your account.
            </p>
            <button
              onClick={() => setView("login")}
              className="text-xs text-muted hover:text-body transition-colors"
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <form
            onSubmit={handleRequest}
            className="bg-surface border border-line rounded-lg p-6 flex flex-col gap-4"
          >
            <h1 className="text-base font-semibold text-primary">Request access</h1>
            <p className="text-xs text-muted">
              Fill out this form and an admin will create your account.
            </p>

            {reqError && <Banner tone="danger">{reqError}</Banner>}

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-secondary">Name</label>
              <input
                type="text"
                required
                value={reqName}
                onChange={(e) => setReqName(e.target.value)}
                className="inp"
                placeholder="Your name"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-secondary">Email</label>
              <input
                type="email"
                required
                value={reqEmail}
                onChange={(e) => setReqEmail(e.target.value)}
                className="inp"
                placeholder="you@example.com"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-secondary">Reason <span className="text-faint">(optional)</span></label>
              <textarea
                value={reqReason}
                onChange={(e) => setReqReason(e.target.value)}
                rows={3}
                className="inp resize-none"
                placeholder="What will you use this for?"
              />
            </div>

            <div className="flex gap-2 mt-1">
              <button
                type="button"
                onClick={() => setView("login")}
                className="btn-secondary flex-1"
              >
                Back
              </button>
              <button type="submit" disabled={requesting} className="btn-primary flex-1">
                {requesting ? "Submitting…" : "Submit request"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
