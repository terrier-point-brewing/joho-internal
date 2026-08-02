"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import Banner from "@/app/components/ui/Banner";

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18" />
      <path d="M10.58 10.58a3 3 0 0 0 4.24 4.24" />
      <path d="M9.88 5.09A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a13.2 13.2 0 0 1-3.17 3.88M6.61 6.61C4.06 8.3 2 12 2 12s3.5 7 10 7a10.4 10.4 0 0 0 3.39-.56" />
    </svg>
  );
}

function SetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let settled = false;

    function markReady() {
      if (!settled) {
        settled = true;
        setReady(true);
      }
    }

    // Path 1: PKCE flow — ?code= in the query string.
    const code = new URLSearchParams(window.location.search).get("code");
    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error) {
          settled = true;
          setError("This invitation link is invalid or has already been used. Please contact an admin.");
        } else {
          markReady();
        }
      });
      return;
    }

    // Path 2: Implicit flow — invite emails redirect with #access_token=... in the hash.
    // @supabase/ssr forces flowType:"pkce" so it won't process the hash automatically;
    // we must parse it and call setSession ourselves.
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.slice(1));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      if (accessToken && refreshToken) {
        supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
          .then(({ error }) => {
            if (error) {
              settled = true;
              setError("This invitation link is invalid or has already been used. Please contact an admin.");
            } else {
              markReady();
            }
          });
        return;
      }
    }

    // Path 3: Session already established (e.g. page refresh after sign-in).
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        markReady();
      } else {
        settled = true;
        setError("No valid invitation token found. Please use the link from your invitation email, or contact an admin for a new invite.");
      }
    });

    return () => {};
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setError(null);
    setSubmitting(true);

    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(error.message);
      setSubmitting(false);
    } else {
      window.location.href = "/";
    }
  }

  if (error) {
    return (
      <div className="bg-surface border border-line rounded-lg p-6 flex flex-col gap-4 text-center">
        <p className="text-sm text-danger">{error}</p>
        <button
          onClick={() => router.push("/login")}
          className="text-xs text-muted hover:text-body transition-colors"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="bg-surface border border-line rounded-lg p-6 text-center">
        <p className="text-sm text-muted">Verifying your link…</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-surface border border-line rounded-lg p-6 flex flex-col gap-4">
      <h1 className="text-base font-semibold text-primary">Set your password</h1>
      <p className="text-xs text-muted">Choose a password to complete your account setup.</p>

      {error && <Banner tone="danger">{error}</Banner>}

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-secondary">New password</label>
        <div className="relative">
          <input
            type={showPassword ? "text" : "password"}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="inp pr-9"
            placeholder="At least 8 characters"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex items-center px-2.5 text-faint hover:text-secondary transition-colors"
          >
            <EyeIcon open={showPassword} />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-secondary">Confirm password</label>
        <div className="relative">
          <input
            type={showConfirm ? "text" : "password"}
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="inp pr-9"
            placeholder="Re-enter password"
          />
          <button
            type="button"
            onClick={() => setShowConfirm((v) => !v)}
            aria-label={showConfirm ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex items-center px-2.5 text-faint hover:text-secondary transition-colors"
          >
            <EyeIcon open={showConfirm} />
          </button>
        </div>
      </div>

      <button type="submit" disabled={submitting} className="btn-primary mt-1 w-full">
        {submitting ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}

export default function SetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="text-2xl font-bold text-primary tracking-wide">TPB</span>
          <p className="mt-1 text-sm text-muted">Terrier Point Brewing</p>
        </div>
        <Suspense fallback={<p className="text-sm text-muted text-center">Loading…</p>}>
          <SetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
