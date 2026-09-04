import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 2): "uncertain signal" must
 * never be the user-facing label for an email Alecto can actually classify. Obvious cases (a job
 * alert, an application confirmation, a viewed-application ping, a profile/open-to-work status
 * notification) must present with their real, specific label — never a generic uncertain catch-all
 * — and a genuinely ambiguous email must explain the SPECIFIC ambiguity in one sentence, via
 * Stage B's own `ambiguity` field (packages/llm/src/prompts/email-understanding.prompt.ts),
 * threaded through refreshEmailReviewClassification's extracted-JSON stash (executor.ts) into
 * Stage D/E's grouped summary (email-review-service.ts).
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedReview(
  userId: string,
  connectionId: string,
  ruleId: string,
  input: { providerMessageId: string; subject: string; reason: string; proposedEventType?: string; extracted?: Record<string, unknown> }
) {
  return prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId,
      adapterId: "job_search_email",
      provider: "gmail",
      providerMessageId: input.providerMessageId,
      externalId: `gmail-review:${ruleId}:${input.providerMessageId}`,
      subject: input.subject,
      from: "no-reply@example.com",
      snippet: input.subject,
      evidence: input.subject,
      confidence: 0.85,
      reason: input.reason,
      proposedEventType: input.proposedEventType,
      extracted: input.extracted ?? {},
      status: "pending",
      priority: "normal"
    }
  });
}

test("obvious cases never show 'uncertain signal'; a genuinely ambiguous email explains why", async () => {
  const server = buildServer();
  const userId = `uncertain-signal-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    // 1. An obvious job alert.
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "5 new jobs matching your search", reason: "filtered_marketing" });
    // 2. An obvious application confirmation.
    await seedReview(userId, connectionId, rule.id, {
      providerMessageId: "m2",
      subject: "Thanks for applying to Cohere",
      reason: "application_confirmation",
      proposedEventType: "career.application_confirmation_received",
      extracted: { company: "Cohere", role: "Software Engineer" }
    });
    // 3. An obvious viewed-application ping.
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m3", subject: "Okify ha visto tu solicitud", reason: "application_viewed" });
    // 4. An obvious profile/open-to-work status notification.
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m4", subject: "You are no longer showing recruiters you're open to work", reason: "filtered_marketing" });
    // 5. A recruiter reply, action-worthy, unambiguous.
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m5", subject: "Following up on your application", reason: "recruiter_reply" });
    // 6. A genuinely ambiguous email.
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m6", subject: "Opportunity at Example Corp", reason: "unknown" });

    const initialList = await sendAgentMessage(server, userId, "show email reviews");
    assert.doesNotMatch(initialList.reply, /uncertain signal/i, "the old lazy catch-all must never appear in real output");

    const indexMatch = initialList.reply.match(/^(\d+)\. Opportunity at Example Corp/m);
    assert.ok(indexMatch, "the ambiguous item must appear numbered in the list");
    const ambiguousIndex = indexMatch![1];

    // "details for N" (buildGmailReviewDetailResult) is what actually runs a fresh understanding
    // call and stashes its signalBucket/ambiguity into the review's `extracted` — the auto-refresh-
    // on-list path requires a live Gmail fetch to succeed first, which this test deliberately does
    // not mock (no Gmail connection token), so the interactive detail flow is the real trigger here.
    process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE = JSON.stringify({
      emailKind: "job_alert",
      relevance: "low",
      goalRelevance: "unclear",
      summary: "This could be a job alert or a personal recruiter message.",
      why: ["Opportunity at Example Corp"],
      suggestedUserAction: "ask_clarification",
      confidence: 0.3,
      keyDetails: null,
      keyFacts: [],
      realWorldEvent: "Possible job opportunity at Example Corp",
      signalBucket: "needs_decision",
      ambiguity: "This looks like either a job alert or a recruiter opportunity, but there is no personal reply in the body."
    });
    await sendAgentMessage(server, userId, `details for ${ambiguousIndex}`);
    delete process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE;

    const listReply = await sendAgentMessage(server, userId, "show email reviews");
    assert.doesNotMatch(listReply.reply, /uncertain signal/i, "the old lazy catch-all must never appear in real output");

    // The ambiguous item must show a SPECIFIC explanation, not a bare "needs decision" label.
    assert.match(listReply.reply, /needs decision/i);
    assert.match(listReply.reply, /job alert or a recruiter opportunity/i);
  } finally {
    delete process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("humanEmailKindLabel and gmailReviewSignalTypeLabel fallbacks never say 'uncertain signal'", async () => {
  const { humanEmailKindLabel, gmailReviewSignalTypeLabel } = await import("../apps/api/src/email-reviews/email-review-service.ts");

  assert.notEqual(humanEmailKindLabel("unknown"), "uncertain signal");
  assert.match(humanEmailKindLabel("unknown"), /needs details/i);

  assert.notEqual(gmailReviewSignalTypeLabel({ proposedEventType: undefined, reason: "some_never_seen_reason" }), "uncertain signal");
  assert.match(gmailReviewSignalTypeLabel({ proposedEventType: undefined, reason: "some_never_seen_reason" }), /needs decision/i);
});
