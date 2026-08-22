import { config } from "dotenv";
import { buildServer } from "./server.js";

config({
  path: new URL("../../../.env", import.meta.url).pathname
});

logMissingEnvWarnings();

const server = buildServer();

const host = process.env.API_HOST ?? "0.0.0.0";
const port = Number(process.env.API_PORT ?? 3000);

/**
 * Logged once at startup, never blocks it — every one of these already degrades gracefully with
 * its own honest, feature-scoped error at the point of use (a missing OPENAI_API_KEY fails the
 * next planner call; a missing ALECTO_SECRET_ENCRYPTION_KEY fails the next Gmail connect attempt
 * with "Set ALECTO_SECRET_ENCRYPTION_KEY and restart"; missing GOOGLE_CLIENT_ID/SECRET makes Gmail
 * OAuth report itself unconfigured) — so this is pure operator visibility, not a new failure mode.
 * A rc/private-alpha-smoke pass found no startup-time signal at all for any of these; the first a
 * private-alpha operator would otherwise hear about a missing key is a confused user's bug report.
 */
function logMissingEnvWarnings(): void {
  const missing = [
    !process.env.DATABASE_URL && "DATABASE_URL",
    !process.env.OPENAI_API_KEY && "OPENAI_API_KEY (goal/action planning will fail on first use)",
    !process.env.ALECTO_SECRET_ENCRYPTION_KEY && "ALECTO_SECRET_ENCRYPTION_KEY (Gmail connect will fail on first use)",
    !(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) && "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (Gmail OAuth will report itself unconfigured)"
  ].filter((value): value is string => Boolean(value));

  if (missing.length > 0) {
    console.warn(`[startup] Missing environment variables: ${missing.join("; ")}`);
  }
}

try {
  await server.listen({ host, port });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
