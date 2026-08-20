export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function gmailOAuthConfig(): GmailOAuthConfig | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI ?? "http://localhost:3000/oauth/gmail/callback";

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
