export type Level = "read" | "operate" | "manage" | "admin";

/** Ordered — each level implies every level below it. */
export const RANK: Record<Level, number> = { read: 1, operate: 2, manage: 3, admin: 4 };
