/**
 * fix/private-alpha-known-gaps, task 4: a small, dependency-free deployment config check, shared
 * by all three processes' own startup logging (apps/api, apps/worker, apps/telegram-bot) — the RC
 * smoke pass found API_BASE_URL and GMAIL_REDIRECT_URI silently default to localhost with zero
 * startup-time visibility, which is exactly the kind of thing that's invisible in local dev and
 * only surfaces as a confusing failure after a real deploy. Deliberately NOT a config framework:
 * one pure function, no validation library, no schema — it only ever WARNS (never throws, never
 * blocks startup) and never logs a secret value, only presence booleans and already-public
 * URLs/flags that are safe to print (a callback URL is not a credential).
 */

export function looksLikeLocalhostUrl(url: string): boolean {
  try {
    // node's URL keeps an IPv6 host bracketed (e.g. "[::1]") — stripped here so "::1" compares
    // the same way whether or not the input URL itself included the brackets.
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0";
  } catch {
    return false;
  }
}

export interface DeployConfigCheckInput {
  /** Only presence, never the real value — DATABASE_URL itself is a secret (embeds DB credentials).
   * Omit entirely for a process that doesn't itself talk to the database. */
  databaseUrlPresent?: boolean;
  /** Only presence, never the real value — OPENAI_API_KEY is a secret. Omit entirely for a process
   * that never calls the LLM planner directly (e.g. the worker/telegram-bot). */
  openaiApiKeyPresent?: boolean;
  /** A public base URL, safe to print in full. */
  apiBaseUrl?: string;
  /** A public OAuth callback URL, safe to print in full. */
  gmailRedirectUri?: string;
}

/** Human-readable warning lines for anything this process's own env looks private-alpha-deploy-
 * risky — never a hard error, never printed automatically; callers decide how/whether to log
 * these. Empty array means nothing looked wrong. Each check only runs when the caller actually
 * passed that field — a process that doesn't care about a given concern (e.g. the worker never
 * calls OPENAI_API_KEY directly) simply omits it rather than getting a false warning. */
export function describeDeployConfigWarnings(input: DeployConfigCheckInput): string[] {
  const warnings: string[] = [];

  if (input.databaseUrlPresent === false) {
    warnings.push("DATABASE_URL is not set — every database call will fail.");
  }
  if (input.openaiApiKeyPresent === false) {
    warnings.push("OPENAI_API_KEY is not set — the real LLM planner will fail on first use (deterministic shortcuts still work).");
  }
  if (input.apiBaseUrl && looksLikeLocalhostUrl(input.apiBaseUrl)) {
    warnings.push(`API_BASE_URL (${input.apiBaseUrl}) looks like localhost — do not deploy with this unless this process truly runs on the same host as the API.`);
  }
  if (input.gmailRedirectUri && looksLikeLocalhostUrl(input.gmailRedirectUri)) {
    warnings.push(`GMAIL_REDIRECT_URI (${input.gmailRedirectUri}) looks like localhost — Gmail OAuth callbacks will fail for any user not on this exact machine. Do not deploy with this unset in production.`);
  }

  return warnings;
}
