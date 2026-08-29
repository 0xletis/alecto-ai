import { config } from "dotenv";
import { describeDeployConfigWarnings, proactiveOperatorDeliveryEnabledFromEnv } from "@operator-agent/core";
import { buildServer } from "./server.js";
import { resolveGmailRedirectUri } from "./gmail/oauth.js";
import { buildApiConfigStatus } from "./operator/config-status.js";

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
  const redirect = resolveGmailRedirectUri();

  const sharedWarnings = describeDeployConfigWarnings({
    databaseUrlPresent: Boolean(process.env.DATABASE_URL),
    openaiApiKeyPresent: Boolean(process.env.OPENAI_API_KEY),
    gmailRedirectUri: redirect.uri
  });

  const apiOnlyWarnings = [
    !process.env.ALECTO_SECRET_ENCRYPTION_KEY && "ALECTO_SECRET_ENCRYPTION_KEY is not set — Gmail connect will fail on first use.",
    !(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) && "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set — Gmail OAuth will report itself unconfigured.",
    // fix/private-alpha-launch-config-sanity (task 5): GOOGLE_REDIRECT_URI is a legacy fallback
    // name — GMAIL_REDIRECT_URI always wins when both are set, so a real, silent disagreement
    // between them (one stale, one current) would otherwise be invisible.
    redirect.conflict &&
      `GMAIL_REDIRECT_URI (${redirect.conflict.gmailRedirectUri}) and legacy GOOGLE_REDIRECT_URI (${redirect.conflict.googleRedirectUri}) are both set and DISAGREE — using GMAIL_REDIRECT_URI. Remove GOOGLE_REDIRECT_URI or make them match.`
  ].filter((value): value is string => Boolean(value));

  for (const warning of [...sharedWarnings, ...apiOnlyWarnings]) {
    console.warn(`[startup] ${warning}`);
  }

  console.log(`[startup] Gmail OAuth callback URL: ${redirect.uri} (source: ${redirect.source})`);
  console.log(`[startup] PROACTIVE_OPERATOR_DELIVERY_ENABLED=${proactiveOperatorDeliveryEnabledFromEnv()}`);

  // fix/private-alpha-launch-config-sanity (task 4): the rest of the API startup config summary —
  // shares buildApiConfigStatus with the read-only GET /diagnostics/config-status route (server.ts)
  // so the two can never drift apart. Never a secret value, only presence booleans and already-
  // public config.
  const status = buildApiConfigStatus();
  console.log(
    [
      "[startup] API config summary:",
      `NODE_ENV=${status.nodeEnv}`,
      `OpenAI configured=${status.openaiConfigured}`,
      `proactive brief personalization enabled=${status.proactiveBriefPersonalizationEnabled}`,
      `Gmail OAuth configured=${status.gmailOAuthConfigured}`,
      // This process never itself calls out to API_BASE_URL — logged only so an operator can
      // cross-check it against what the worker/telegram-bot are actually configured to call.
      `API_BASE_URL (as seen by this process, unused by the API itself)=${process.env.API_BASE_URL ?? "(unset)"}`,
      `diagnostics enabled=${status.diagnosticsEnabled}`
    ].join(" ")
  );
}

try {
  await server.listen({ host, port });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
