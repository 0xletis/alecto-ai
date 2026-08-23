import assert from "node:assert/strict";
import test from "node:test";
import { describeDeployConfigWarnings, looksLikeLocalhostUrl } from "../packages/core/src/deploy-config-check.ts";

/**
 * fix/private-alpha-known-gaps, task 4: the RC smoke pass found API_BASE_URL and
 * GMAIL_REDIRECT_URI silently default to localhost with zero startup-time visibility. This is a
 * small, dependency-free, shared warning helper (never a hard failure, never a secret in its
 * output) used by all three processes' own startup logging (apps/api, apps/worker,
 * apps/telegram-bot).
 */

test("looksLikeLocalhostUrl recognizes every common localhost form", () => {
  assert.equal(looksLikeLocalhostUrl("http://localhost:3000/oauth/gmail/callback"), true);
  assert.equal(looksLikeLocalhostUrl("http://127.0.0.1:3000"), true);
  assert.equal(looksLikeLocalhostUrl("http://[::1]:3000"), true);
  assert.equal(looksLikeLocalhostUrl("http://0.0.0.0:3000"), true);
});

test("looksLikeLocalhostUrl does not flag a real deployed hostname", () => {
  assert.equal(looksLikeLocalhostUrl("https://api.alecto.example.com"), false);
  assert.equal(looksLikeLocalhostUrl("https://alecto-api.fly.dev"), false);
});

test("looksLikeLocalhostUrl never throws on a malformed URL — just reports false", () => {
  assert.equal(looksLikeLocalhostUrl("not a url"), false);
  assert.equal(looksLikeLocalhostUrl(""), false);
});

test("describeDeployConfigWarnings reports a localhost API_BASE_URL as a warning", () => {
  const warnings = describeDeployConfigWarnings({ apiBaseUrl: "http://localhost:3000" });
  assert.ok(warnings.some((warning) => warning.includes("API_BASE_URL")), `expected an API_BASE_URL warning — got: ${JSON.stringify(warnings)}`);
});

test("describeDeployConfigWarnings reports a localhost GMAIL_REDIRECT_URI as a warning", () => {
  const warnings = describeDeployConfigWarnings({ gmailRedirectUri: "http://localhost:3000/oauth/gmail/callback" });
  assert.ok(warnings.some((warning) => warning.includes("GMAIL_REDIRECT_URI")), `expected a GMAIL_REDIRECT_URI warning — got: ${JSON.stringify(warnings)}`);
});

test("describeDeployConfigWarnings reports nothing for real, non-localhost deploy URLs", () => {
  const warnings = describeDeployConfigWarnings({
    apiBaseUrl: "https://api.alecto.example.com",
    gmailRedirectUri: "https://api.alecto.example.com/oauth/gmail/callback",
    databaseUrlPresent: true,
    openaiApiKeyPresent: true
  });
  assert.deepEqual(warnings, []);
});

test("describeDeployConfigWarnings warns on a missing DATABASE_URL/OPENAI_API_KEY only when the caller actually checks for them", () => {
  const checked = describeDeployConfigWarnings({ databaseUrlPresent: false, openaiApiKeyPresent: false });
  assert.equal(checked.length, 2);
  assert.ok(checked.some((warning) => warning.startsWith("DATABASE_URL")));
  assert.ok(checked.some((warning) => warning.startsWith("OPENAI_API_KEY")));

  // A process that doesn't itself talk to the DB or call OpenAI directly (e.g. the worker/
  // telegram-bot checking only its own API_BASE_URL) must never get a false warning for concerns
  // it never opted into checking.
  const unchecked = describeDeployConfigWarnings({ apiBaseUrl: "https://api.alecto.example.com" });
  assert.deepEqual(unchecked, []);
});

test("describeDeployConfigWarnings never includes a real secret value — only presence booleans and already-public URLs", () => {
  const fakeSecretDatabaseUrl = "postgresql://user:supersecretpassword@db.internal:5432/alecto";
  const fakeSecretOpenAiKey = "sk-supersecretkey1234567890";

  // The function's own input type only accepts booleans for these two — this test documents and
  // locks in that contract: even if a caller mistakenly had the raw secret in scope, there is no
  // parameter that could pass it through into a warning string.
  const warnings = describeDeployConfigWarnings({ databaseUrlPresent: false, openaiApiKeyPresent: false });
  const joined = warnings.join(" ");
  assert.doesNotMatch(joined, /supersecretpassword|supersecretkey/i);
  assert.doesNotMatch(joined, new RegExp(fakeSecretDatabaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(joined, new RegExp(fakeSecretOpenAiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
