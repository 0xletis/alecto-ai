import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, mockPlan, prisma, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * V3 intent-planner hardening — plural/all Gmail review references. A real Telegram smoke test
 * found "keep both in review for now" (with exactly two similarly-subjected visible reviews)
 * asking "which one did you mean?" instead of keeping both pending. Root cause: the deterministic
 * numbered-index extractor (extractExplicitGmailReviewIntentEntries in
 * apps/api/src/agent-runtime/runtime.ts) only ever recognized explicit digits ("keep 1", "keep 3
 * in review") — a plural/all quantifier with no number fell through to the real LLM planner,
 * which had no reliable way to turn "both"/"them" into two separate operations and instead sent a
 * single vague `ref` that failed resolveGmailReviewRef's exact/token-overlap match against two
 * near-identical GitHub security-advisory subjects. The fix adds plural-quantifier recognition
 * (English/Spanish/Catalan) to the same deterministic extractor, expanding to one operation per
 * currently visible review — never touching the real Gmail mailbox, never creating a task.
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedTwoAdvisoryReviews(userId: string): Promise<{ connectionId: string; ssrfId: string; dosId: string }> {
  const connectionId = await seedGmailUser(userId);
  const rule = await prisma.emailSignalRule.create({
    data: { userId, connectionId, adapterId: "custom_email_review", name: "GitHub security advisories", status: "active", createdBy: "user" }
  });
  const ssrf = await prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId: rule.id,
      adapterId: "custom_email_review",
      provider: "gmail",
      providerMessageId: "advisory-ssrf",
      externalId: `gmail-review:${rule.id}:advisory-ssrf`,
      subject: "[0xletis] A security advisory on next affects at least one of your repositories — SSRF in image optimizer",
      snippet: "SSRF vulnerability details.",
      evidence: "SSRF vulnerability details.",
      confidence: 0.8,
      reason: "custom_rule_match",
      extracted: {},
      status: "pending"
    }
  });
  const dos = await prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId: rule.id,
      adapterId: "custom_email_review",
      provider: "gmail",
      providerMessageId: "advisory-dos",
      externalId: `gmail-review:${rule.id}:advisory-dos`,
      subject: "[0xletis] A security advisory on next affects at least one of your repositories — DoS via crafted request",
      snippet: "DoS vulnerability details.",
      evidence: "DoS vulnerability details.",
      confidence: 0.8,
      reason: "custom_rule_match",
      extracted: {},
      status: "pending"
    }
  });
  return { connectionId, ssrfId: ssrf.id, dosId: dos.id };
}

const KEEP_PHRASES = [
  ["1", "okay keep them there for now"],
  ["2", "keep both in review for now"],
  ["3", "leave them for later"],
  ["4", "keep all of them pending"],
  ["5-es", "deja los dos para luego"],
  ["6-es", "mantén ambos en revisión"],
  ["7-ca", "deixa'ls per després"]
] as const;

for (const [label, phrase] of KEEP_PHRASES) {
  test(`${label}. '${phrase}' keeps both visible reviews pending, no clarification, no mutation`, async () => {
    const server = buildServer();
    const userId = `gmail-plural-keep-${label}-${randomUUID()}`;

    try {
      const { ssrfId, dosId } = await seedTwoAdvisoryReviews(userId);
      await sendAgentMessage(server, userId, "show me email reviews");

      const reply = await sendAgentMessage(server, userId, phrase);

      assert.doesNotMatch(reply.reply, /which one did you mean|couldn't tell which/i, phrase);
      assert.deepEqual(reply.operationsPlanned.map((op) => op.tool), ["gmail.review.keep", "gmail.review.keep"], phrase);
      assert.match(reply.reply, /kept review/i, phrase);
      assert.match(reply.reply, /in review for later/i, phrase);

      const ssrfAfter = await prisma.emailReviewItem.findUnique({ where: { id: ssrfId } });
      const dosAfter = await prisma.emailReviewItem.findUnique({ where: { id: dosId } });
      assert.equal(ssrfAfter?.status, "pending", phrase);
      assert.equal(dosAfter?.status, "pending", phrase);

      const actions = await prisma.actionItem.count({ where: { userId } });
      assert.equal(actions, 0, phrase);
      assert.equal(reply.debug.pendingOperation, false, phrase);
    } finally {
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
}

test("plural 'ignore them' rejects every currently visible review", async () => {
  const server = buildServer();
  const userId = `gmail-plural-ignore-${randomUUID()}`;

  try {
    const { ssrfId, dosId } = await seedTwoAdvisoryReviews(userId);
    await sendAgentMessage(server, userId, "show me email reviews");

    const reply = await sendAgentMessage(server, userId, "ignore them, nothing important");

    assert.deepEqual(reply.operationsPlanned.map((op) => op.tool), ["gmail.review.reject", "gmail.review.reject"]);
    const ssrfAfter = await prisma.emailReviewItem.findUnique({ where: { id: ssrfId } });
    const dosAfter = await prisma.emailReviewItem.findUnique({ where: { id: dosId } });
    assert.equal(ssrfAfter?.status, "rejected");
    assert.equal(dosAfter?.status, "rejected");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// Task 6: ambiguity behavior — a message with no clear operation must still ask, and mixed/
// unrelated wording must not be swallowed by the new plural handling.
test("ambiguous 'do something with the email' with multiple visible reviews still asks for clarification", async () => {
  const server = buildServer();
  const userId = `gmail-plural-ambiguous-1-${randomUUID()}`;

  try {
    await seedTwoAdvisoryReviews(userId);
    await sendAgentMessage(server, userId, "show me email reviews");

    mockPlan({
      topic: "gmail_reviews",
      intent: "unclear",
      operations: [{ tool: "clarification.ask", args: { question: "Which decision do you want for the security advisories — keep, ignore, or turn into a task?" }, rationale: null }],
      needsClarification: true,
      clarificationQuestion: "Which decision do you want for the security advisories — keep, ignore, or turn into a task?",
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "do something with the email");

    assert.equal(reply.needsConfirmation, false);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /which decision|keep, ignore, or turn/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("ambiguous 'handle it' with multiple visible reviews and no clear operation asks for clarification, no mutation", async () => {
  const server = buildServer();
  const userId = `gmail-plural-ambiguous-2-${randomUUID()}`;

  try {
    const { ssrfId, dosId } = await seedTwoAdvisoryReviews(userId);
    await sendAgentMessage(server, userId, "show me email reviews");

    // No mockPlan needed: a later ambiguity-hardening pass made "handle it" (a vague instruction
    // with no specific ignore/keep/task intent) resolve deterministically to a clarification —
    // see gmailReviewVagueMutationClarification in apps/api/src/agent-runtime/runtime.ts — so the
    // real planner is never even reached for this exact phrase.
    const reply = await sendAgentMessage(server, userId, "handle it");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /ignore them.*tasks.*keep them/i);

    const ssrfAfter = await prisma.emailReviewItem.findUnique({ where: { id: ssrfId } });
    const dosAfter = await prisma.emailReviewItem.findUnique({ where: { id: dosId } });
    assert.equal(ssrfAfter?.status, "pending");
    assert.equal(dosAfter?.status, "pending");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("'keep them for later' with multiple visible reviews needs no clarification and keeps all pending", async () => {
  const server = buildServer();
  const userId = `gmail-plural-keep-no-clarify-${randomUUID()}`;

  try {
    const { ssrfId, dosId } = await seedTwoAdvisoryReviews(userId);
    await sendAgentMessage(server, userId, "show me email reviews");

    const reply = await sendAgentMessage(server, userId, "keep them for later");

    assert.doesNotMatch(reply.reply, /which one|couldn't tell/i);
    assert.equal(reply.debug.mutationExecuted, false);
    const ssrfAfter = await prisma.emailReviewItem.findUnique({ where: { id: ssrfId } });
    const dosAfter = await prisma.emailReviewItem.findUnique({ where: { id: dosId } });
    assert.equal(ssrfAfter?.status, "pending");
    assert.equal(dosAfter?.status, "pending");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
