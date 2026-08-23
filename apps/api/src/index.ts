import { config } from "dotenv";
import { describeDeployConfigWarnings, proactiveOperatorDeliveryEnabledFromEnv } from "@operator-agent/core";
import { buildServer } from "./server.js";

config({
  path: new URL("../../../.env", import.meta.url).pathname
});

logStartupDiagnostics();

const server = buildServer();

const host = process.env.API_HOST ?? "0.0.0.0";
const port = Number(process.env.API_PORT ?? 3000);

/**
 * Logged once at startup, never blocks it — every one of these already degrades gracefully with
 * its own honest, feature-scoped error at the point of use (a missing OPENAI_API_KEY fails the
 * next planner call; a missing ALECTO_SECRET_ENCRYPTION_KEY fails the next Gmail connect attempt
 * with "Set ALECTO_SECRET_ENCRYPTION_KEY and restart"; missing GOOGLE_CLIENT_ID/SECRET or a
 * localhost GMAIL_REDIRECT_URI makes Gmail OAuth report itself unconfigured or fail for real
 * users) — so this is pure operator visibility, not a new failure mode. A rc/private-alpha-smoke
 * pass found no startup-time signal at all for any of these; the first a private-alpha operator
 * would otherwise hear about a missing/misconfigured key is a confused user's bug report. Reuses
 * @operator-agent/core's shared describeDeployConfigWarnings (also used by apps/worker and
 * apps/telegram-bot's own startup logging) for the two checks common to all three processes —
 * never prints a secret value, only presence booleans and already-public URLs.
 */
function logStartupDiagnostics(): void {
  const sharedWarnings = describeDeployConfigWarnings({
    databaseUrlPresent: Boolean(process.env.DATABASE_URL),
    openaiApiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
    gmailRedirectUri: process.env.GMAIL_REDIRECT_URI
  });

  const apiOnlyWarnings = [
    !process.env.ALECTO_SECRET_ENCRYPTION_KEY && "ALECTO_SECRET_ENCRYPTION_KEY is not set — Gmail connect will fail on first use.",
    !(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) && "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set — Gmail OAuth will report itself unconfigured."
  ].filter((value): value is string => Boolean(value));

  for (const warning of [...sharedWarnings, ...apiOnlyWarnings]) {
    console.warn(`[startup] ${warning}`);
  }

  // Not a secret — a callback URL, safe to print in full. Defaults mirror gmail/oauth.ts's own
  // default exactly, so this always reflects what a real OAuth attempt would actually use.
  const gmailRedirectUri = process.env.GMAIL_REDIRECT_URI ?? "http://localhost:3000/oauth/gmail/callback";
  console.log(`[startup] Gmail OAuth callback URL: ${gmailRedirectUri}`);
  console.log(`[startup] PROACTIVE_OPERATOR_DELIVERY_ENABLED=${proactiveOperatorDeliveryEnabledFromEnv()}`);
}

try {
  await server.listen({ host, port });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
