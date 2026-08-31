export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const GMAIL_REDIRECT_URI_DEFAULT = "http://localhost:3000/oauth/gmail/callback";

export interface GmailRedirectUriResolution {
  uri: string;
  /** Which env var actually supplied the value — "default" means neither was set. */
  source: "GMAIL_REDIRECT_URI" | "GOOGLE_REDIRECT_URI" | "default";
  /** Set only when BOTH vars are present and disagree — the caller should warn loudly, since one
   * of them is silently being ignored (GMAIL_REDIRECT_URI always wins). */
  conflict?: { gmailRedirectUri: string; googleRedirectUri: string };
}

/**
 * fix/private-alpha-launch-config-sanity (task 5): GMAIL_REDIRECT_URI is the one canonical name
 * this codebase's OAuth flow actually reads. GOOGLE_REDIRECT_URI was never read anywhere — only a
 * stale, wrong placeholder in .env.example (`/oauth/google/callback`, a path this app has never
 * served) — but is supported here as a legacy fallback anyway, since a real deploy may already
 * have set it by that name before this was caught, and silently ignoring an already-configured
 * value would be a worse surprise than honoring it with a clear warning. Fallback order:
 * GMAIL_REDIRECT_URI, then GOOGLE_REDIRECT_URI, then the localhost default.
 */
export function resolveGmailRedirectUri(): GmailRedirectUriResolution {
  const gmailRedirectUri = process.env.GMAIL_REDIRECT_URI;
  const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (gmailRedirectUri) {
    const conflict =
      googleRedirectUri && googleRedirectUri !== gmailRedirectUri ? { gmailRedirectUri, googleRedirectUri } : undefined;
    return { uri: gmailRedirectUri, source: "GMAIL_REDIRECT_URI", conflict };
  }

  if (googleRedirectUri) {
    return { uri: googleRedirectUri, source: "GOOGLE_REDIRECT_URI" };
  }

  return { uri: GMAIL_REDIRECT_URI_DEFAULT, source: "default" };
}

export function gmailOAuthConfig(): GmailOAuthConfig | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = resolveGmailRedirectUri().uri;

  return clientId && clientSecret ? { clientId, clientSecret, redirectUri } : undefined;
}

export function buildGmailOAuthUrl(userId: string, config: Pick<GmailOAuthConfig, "clientId" | "redirectUri">): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    state: Buffer.from(JSON.stringify({ userId }), "utf8").toString("base64url")
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function gmailOAuthLocalhostCallbackWarning(config: Pick<GmailOAuthConfig, "redirectUri">): string | undefined {
  try {
    const url = new URL(config.redirectUri);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
      return "Open this link on the same machine running Alecto, or configure a public callback URL.";
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function decodeGmailOAuthState(state: string): string | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { userId?: unknown };
    return typeof parsed.userId === "string" ? parsed.userId : undefined;
  } catch {
    return undefined;
  }
}

export function gmailOAuthMissingConfigMessage(): string {
  return "Gmail OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GMAIL_REDIRECT_URI.";
}

/**
 * fix/private-alpha-gmail-account-switch-and-personalized-examples: best-effort revocation of a
 * Gmail OAuth grant at Google's own revoke endpoint — there was no precedent for this anywhere in
 * the codebase before this branch (disconnect previously only ever flipped a local DB status, the
 * refresh token stayed live at Google indefinitely). Accepts either a refresh token (revokes the
 * whole grant, preferred) or an access token (revokes just that token) — whichever the caller has
 * on hand. Deliberately never throws: a disconnect must always succeed locally even if Google's
 * endpoint is unreachable or the token was already invalid/expired — the local archive is the
 * source of truth for "is Alecto still using this account," not Google's own revocation state.
 * Never logs the token value itself, only the boolean outcome.
 */
export async function revokeGoogleOAuthToken(token: string): Promise<boolean> {
  if (!token) {
    return false;
  }
  try {
    const response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token })
    });
    return response.ok;
  } catch {
    return false;
  }
}
