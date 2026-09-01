import assert from "node:assert/strict";
import test from "node:test";
import { cleanEmailBodyForDisplay, redactSecrets, DEFAULT_EMAIL_DETAIL_LENGTH, FULL_EMAIL_DETAIL_LENGTH } from "../packages/core/src/email-content-cleaner.ts";
import { validateEmailUnderstanding, LOW_CONFIDENCE_THRESHOLD } from "../packages/llm/src/understand-email.ts";

/**
 * fix/private-alpha-email-review-detail-and-general-mail-understanding: unit coverage for the
 * general, reusable email cleaner/redactor (packages/core/src/email-content-cleaner.ts, Part 3) and
 * the deterministic validator that sits between the LLM email-understanding call and anything ever
 * shown to a user (packages/llm/src/understand-email.ts, Part 4). Both are domain-agnostic — no
 * job-search-specific assumptions anywhere in either module.
 */

// --- Part 3: cleaner/redactor ---

test("3A. a text/plain email is cleaned (whitespace collapsed, still readable)", () => {
  const raw = "Hi,\n\n\n\nThanks for your interest in Elastic. We received your resume for the Software Engineer role.\n\n\nBest,\nElastic Careers";
  const cleaned = cleanEmailBodyForDisplay(raw);
  assert.match(cleaned, /received your resume/i);
  assert.match(cleaned, /Software Engineer/);
  assert.doesNotMatch(cleaned, /\n{3,}/);
});

test("3B. an HTML-only email is converted to readable text", () => {
  const html = "<html><body><p>Hi Miquel,</p><p>Your flight <b>BA456</b> has been <i>rescheduled</i> to 14:20.</p></body></html>";
  const cleaned = cleanEmailBodyForDisplay(html, { isHtml: true });
  assert.doesNotMatch(cleaned, /<[a-z]/i);
  assert.match(cleaned, /BA456/);
  assert.match(cleaned, /rescheduled/);
});

test("3C. a long footer/unsubscribe/legal block is trimmed", () => {
  const raw = "Your invoice #4821 for September is attached. Amount due: $120.\n\nUnsubscribe here. You are receiving this email because you have an account with us. © 2026 Acme Inc. All rights reserved.";
  const cleaned = cleanEmailBodyForDisplay(raw);
  assert.match(cleaned, /invoice #4821/i);
  assert.doesNotMatch(cleaned, /unsubscribe/i);
  assert.doesNotMatch(cleaned, /all rights reserved/i);
});

test("3D. a verification code is redacted", () => {
  const raw = "Your verification code is 482913. This code is valid for 10 minutes.";
  const cleaned = cleanEmailBodyForDisplay(raw);
  assert.doesNotMatch(cleaned, /482913/);
  assert.match(cleaned, /\[redacted\]/);
});

test("3E. important business content is preserved alongside redaction", () => {
  const raw = "Thank you for applying to Innovation Labs for the Front-End Engineer role. Your verification code is 118204.";
  const cleaned = cleanEmailBodyForDisplay(raw);
  assert.match(cleaned, /Innovation Labs/);
  assert.match(cleaned, /Front-End Engineer/);
  assert.doesNotMatch(cleaned, /118204/);
});

test("3F. tracking/unsubscribe garbage and invisible characters are removed", () => {
  const zeroWidthSpace = "\u200B";
  const withInvisible = `New${zeroWidthSpace}sletter content. View in browser. Unsubscribe.`;
  const cleaned = cleanEmailBodyForDisplay(withInvisible);
  assert.doesNotMatch(cleaned, new RegExp(zeroWidthSpace));
  assert.doesNotMatch(cleaned, /unsubscribe/i);
  assert.doesNotMatch(cleaned, /view in browser/i);
});

test("3G. the full cleaned view is longer than the default detail view", () => {
  const raw = "Paragraph about the trip itinerary and booking confirmation details. ".repeat(200);
  const defaultView = cleanEmailBodyForDisplay(raw);
  const fullView = cleanEmailBodyForDisplay(raw, { maxLength: FULL_EMAIL_DETAIL_LENGTH });
  assert.ok(defaultView.length <= DEFAULT_EMAIL_DETAIL_LENGTH + 3);
  assert.ok(fullView.length > defaultView.length);
  assert.ok(fullView.length <= FULL_EMAIL_DETAIL_LENGTH + 3);
});

test("redactSecrets: does not false-positive on ordinary numbers near unrelated words", () => {
  const text = "This code is valid for 10 minutes. Order #482913 confirmed. Total: $1,234.56.";
  assert.equal(redactSecrets(text), text);
});

test("redactSecrets: redacts a password-reset link's token but keeps the link visible", () => {
  const text = "Reset your password: https://example.com/reset?token=aZ9kLmQpR3xTvWbN7cYdEf2gHj";
  const result = redactSecrets(text);
  assert.match(result, /https:\/\/example\.com\/reset\?token=\[redacted\]/);
});

// --- Part 4: email-understanding validator ---

test("4-validator: an unsupported emailKind enum value is rejected, not silently accepted", () => {
  const result = validateEmailUnderstanding(
    {
      emailKind: "not_a_real_kind",
      relevance: "high",
      goalRelevance: "direct",
      summary: "x",
      why: ["x"],
      suggestedUserAction: "approve",
      confidence: 0.9
    },
    "some grounding text"
  );
  assert.equal(result.status, "needs_clarification");
});

test("4-validator: confidence is clamped into [0, 1]", () => {
  const result = validateEmailUnderstanding(
    {
      emailKind: "invoice",
      relevance: "high",
      goalRelevance: "unclear",
      summary: "An invoice for September.",
      why: ["invoice"],
      suggestedUserAction: "monitor",
      confidence: 5
    },
    "Your invoice for September is attached, amount due $120."
  );
  assert.equal(result.status, "ok");
  assert.equal(result.understanding?.confidence, 1);
});

test("4-validator: a why-phrase not grounded in the actual cleaned content is dropped", () => {
  const result = validateEmailUnderstanding(
    {
      emailKind: "rejection",
      relevance: "high",
      goalRelevance: "direct",
      summary: "fabricated",
      why: ["completely unrelated invented phrase about dragons and wizards"],
      suggestedUserAction: "ignore",
      confidence: 0.9
    },
    "Thank you for applying to Innovation Labs. We received your application for the Front-End Engineer role."
  );
  assert.equal(result.status, "needs_clarification");
  assert.equal(result.understanding?.why.length, 0);
});

test("4-validator: low confidence asks for clarification even with valid enums", () => {
  const result = validateEmailUnderstanding(
    {
      emailKind: "personal_message",
      relevance: "low",
      goalRelevance: "unclear",
      summary: "Not sure what this is about.",
      why: ["applying"],
      suggestedUserAction: "ask_clarification",
      confidence: LOW_CONFIDENCE_THRESHOLD - 0.1
    },
    "Thank you for applying to Innovation Labs."
  );
  assert.equal(result.status, "needs_clarification");
});

test("4-validator: a well-grounded, confident, valid result passes through as ok", () => {
  const result = validateEmailUnderstanding(
    {
      emailKind: "flight_update",
      relevance: "high",
      goalRelevance: "direct",
      summary: "Your flight BA456 has been rescheduled to 14:20.",
      why: ["flight BA456", "rescheduled to 14:20"],
      suggestedUserAction: "monitor",
      confidence: 0.85
    },
    "Your flight BA456 has been rescheduled to 14:20. Please arrive at the gate 30 minutes early."
  );
  assert.equal(result.status, "ok");
  assert.equal(result.understanding?.why.length, 2);
});
