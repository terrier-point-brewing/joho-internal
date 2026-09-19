import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { partnerMayReach } from "@/lib/partner/confinement";

export async function proxy(request: NextRequest) {
  // Machine-to-machine endpoints authenticate themselves (Square HMAC signature,
  // CRON_SECRET bearer) and carry no session cookie. They must never be redirected
  // to /login or depend on session refresh, so let them straight through — without
  // this, Vercel cron GETs and Square webhook POSTs both 307 to /login and their
  // handlers never run.
  const { pathname: earlyPath } = request.nextUrl;
  if (earlyPath.startsWith("/api/webhooks/") || earlyPath.startsWith("/api/cron/")) {
    return NextResponse.next({ request });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new Error("Missing required environment variable: NEXT_PUBLIC_SUPABASE_URL");
  if (!key) throw new Error("Missing required environment variable: NEXT_PUBLIC_SUPABASE_ANON_KEY");

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refresh session if expired — keeps the cookie up to date.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isLoginPage = pathname === "/login";
  const isPublicApi = pathname === "/api/admin/requests" && request.method === "POST";
  const isAuthPage = pathname.startsWith("/auth/");

  if (!user && !isLoginPage && !isPublicApi && !isAuthPage) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // An external partner login is confined to the portal. The flag is
  // app_metadata, which only the service role can write and which a DB trigger
  // keeps equal to profiles.role = 'partner' — so this costs no query beyond
  // the getUser() above. It is the OUTER wall only: the partner role also
  // holds no scope any staff route accepts, and a restrictive RLS policy denies
  // the token at the database. Any one of the three failing still leaves two.
  if (user && user.app_metadata?.portal_partner === true) {
    if (!partnerMayReach(pathname)) {
      return pathname.startsWith("/api/")
        ? new NextResponse("Forbidden", { status: 403 })
        : NextResponse.redirect(new URL("/partner", request.url));
    }
    return response;
  }

  if (user && isLoginPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    // Run on all paths except Next.js internals and static assets.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
