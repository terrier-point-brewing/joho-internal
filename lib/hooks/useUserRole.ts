"use client";

import { useEffect, useState } from "react";
import type { UserRole } from "@/lib/auth";

interface Me {
  user: { id: string; email: string } | null;
  role: UserRole | null;
}

export function useUserRole(): Me & { loading: boolean } {
  const [me, setMe] = useState<Me>({ user: null, role: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data: Me) => setMe(data))
      .finally(() => setLoading(false));
  }, []);

  return { ...me, loading };
}
