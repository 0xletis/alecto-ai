import { proactiveOperatorAllowlistActiveFromEnv, proactiveOperatorDeliveryEnabledFromEnv } from "@operator-agent/core";
import { resolveGmailRedirectUri } from "../gmail/oauth.js";
import { shouldUseProactiveBriefLLM } from "./proactive-brief-llm.js";

/**
 * fix/private-alpha-launch-config-sanity (tasks 4 and 7): the ONE place the API's own safe config
 * summary is built — used by both apps/api/src/index.ts's startup log and the read-only
 * GET /diagnostics/config-status route, so they can never drift apart. Never returns a secret
 * value, only presence booleans and already-public config (a callback URL is not a credential).
 */
export interface ApiConfigStatus {
  nodeEnv: string;
  openaiConfigured: boolean;
  proactiveDeliveryEnabled: boolean;
  proactiveDeliveryAllowlistActive: boolean;
  proactiveBriefPersonalizationEnabled: boolean;
  gmailOAuthConfigured: boolean;
  gmailRedirectUri: string;
  gmailRedirectUriSource: "GMAIL_REDIRECT_URI" | "GOOGLE_REDIRECT_URI" | "default";
  gmailRedirectUriConflict: boolean;
  diagnosticsEnabled: boolean;
}

export function buildApiConfigStatus(): ApiConfigStatus {
  const redirect = resolveGmailRedirectUri();

  return {
    nodeEnv: process.env.NODE_ENV ?? "(unset)",
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    proactiveDeliveryEnabled: proactiveOperatorDeliveryEnabledFromEnv(),
    proactiveDeliveryAllowlistActive: proactiveOperatorAllowlistActiveFromEnv(),
    proactiveBriefPersonalizationEnabled: shouldUseProactiveBriefLLM(),
    gmailOAuthConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    gmailRedirectUri: redirect.uri,
    gmailRedirectUriSource: redirect.source,
    gmailRedirectUriConflict: Boolean(redirect.conflict),
    diagnosticsEnabled: process.env.AGENT_RUNTIME_DIAGNOSTICS === "true"
  };
}

export function formatApiConfigStatusForChat(status: ApiConfigStatus): string {
  return [
    "API config status:",
    `- Environment: ${status.nodeEnv}`,
    `- OpenAI configured: ${status.openaiConfigured ? "yes" : "no"}`,
    `- Proactive delivery: ${status.proactiveDeliveryEnabled ? "enabled" : "disabled"}${status.proactiveDeliveryAllowlistActive ? " (allowlist active)" : ""}`,
    `- Proactive brief personalization: ${status.proactiveBriefPersonalizationEnabled ? "enabled" : "disabled"}`,
    `- Gmail OAuth: ${status.gmailOAuthConfigured ? "configured" : "not configured"}`,
    `- Gmail redirect URI: ${status.gmailRedirectUri} (source: ${status.gmailRedirectUriSource})${status.gmailRedirectUriConflict ? " — WARNING: GOOGLE_REDIRECT_URI is also set and disagrees" : ""}`,
    `- Diagnostics logging: ${status.diagnosticsEnabled ? "on" : "off"}`
  ].join("\n");
}
