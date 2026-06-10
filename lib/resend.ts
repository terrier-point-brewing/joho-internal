import { Resend } from "resend";
import { env } from "./env";

export const RESEND_FROM = "noreply@terrierpoint.com";
export const ADMIN_EMAIL  = "will.liao@terrierpoint.com";

let _client: Resend | null = null;

function getClient(): Resend | null {
  const apiKey = env.resendApiKey();
  if (!apiKey) return null;
  if (!_client) _client = new Resend(apiKey);
  return _client;
}

/**
 * Send a transactional email via Resend.
 * Silently returns if RESEND_API_KEY is not set (dev / CI environments).
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const client = getClient();
  if (!client) return;
  await client.emails.send({ from: RESEND_FROM, to, subject, html });
}
