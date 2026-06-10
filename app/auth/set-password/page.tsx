"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

function SetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);

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
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 flex flex-col gap-4 text-center">
        <p className="text-sm text-red-400">{error}</p>
        <button
          onClick={() => router.push("/login")}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 text-center">
        <p className="text-sm text-zinc-500">Verifying your link…</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 flex flex-col gap-4">
      <h1 className="text-base font-semibold text-zinc-100">Set your password</h1>
      <p className="text-xs text-zinc-500">Choose a password to complete your account setup.</p>

      {error && (
        <p className="text-sm text-red-400 bg-red-950/30 border border-red-900/50 rounded px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-zinc-400">New password</label>
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
          placeholder="At least 8 characters"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-zinc-400">Confirm password</label>
        <input
          type="password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
          placeholder="Re-enter password"
        />
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="mt-1 w-full bg-amber-500 hover:bg-amber-400 disabled:bg-amber-500/50 text-zinc-950 font-semibold text-sm rounded py-2 transition-colors"
      >
        {submitting ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}

export default function SetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="text-2xl font-bold text-zinc-100 tracking-wide">TPB</span>
          <p className="mt-1 text-sm text-zinc-500">Terrier Point Brewing</p>
        </div>
        <Suspense fallback={<p className="text-sm text-zinc-500 text-center">Loading…</p>}>
          <SetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
