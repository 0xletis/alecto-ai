import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 2 hardening): Stage D's
 * advisory batch-reconciliation pass (packages/llm/src/prompts/batch-reconciliation.prompt.ts),
 * wired into the default grouped-summary and bulk-count paths via a deterministic pre-filter
 * (isNearDuplicateCandidate, email-intelligence-grouping.ts) — only pairs sharing the same entity
 * within a small day window are ever even asked about; the exact-key dedupe pass above it remains
 * fully authoritative and always runs first. These fixtures deliberately use a ONE-DAY GAP between
 * the two confirmation emails per company — the exact case the exact dedupe key structurally cannot
 * catch (day is baked into the key), which is what makes the advisory pass the thing actually under
 * test here, not the pre-existing same-day exact match already covered by
 * tests/email-intelligence-acceptance.test.ts.
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
  input: { providerMessageId: string; subject: string; company: string; role: string; createdAt: Date }
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
      reason: "application_confirmation",
      proposedEventType: "career.application_confirmation_received",
      extracted: { company: input.company, role: input.role },
      status: "pending",
      priority: "normal",
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    }
  });
}

function mockReconcile(response: Record<string, unknown>): void {
  process.env.BATCH_RECONCILIATION_MOCK_RESPONSE = JSON.stringify(response);
}

function clearMocks(): void {
  delete process.env.BATCH_RECONCILIATION_MOCK_RESPONSE;
  delete process.env.BATCH_RECONCILIATION_MOCK_THROW;
}

// 6+ pending reviews are needed to engage the grouped view (GROUPED_VIEW_MIN_ITEMS in executor.ts).
async function seedPadding(userId: string, connectionId: string, ruleId: string, count: number, dayOffset: number) {
  for (let i = 0; i < count; i += 1) {
    await seedReview(userId, connectionId, ruleId, {
      providerMessageId: `padding-${i}`,
      subject: `Thanks for applying to Padding${i}`,
      company: `Padding${i}`,
      role: "Engineer",
      createdAt: new Date(Date.UTC(2026, 8, 3 - dayOffset, 9, i))
    });
  }
}

test("A. GoMining LinkedIn + Workable, one day apart, merge as one likely application", async () => {
  const server = buildServer();
  const userId = `batch-recon-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-workable", subject: "Thanks for applying to GoMining", company: "GoMining", role: "Backend Engineer", createdAt: new Date("2026-09-02T09:00:00.000Z") });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-li", subject: "GoMining - solicitud enviada", company: "GoMining", role: "Backend Engineer", createdAt: new Date("2026-09-03T09:00:00.000Z") });
    await seedPadding(userId, connectionId, rule.id, 4, 0);

    // pairId is a placeholder — reconcileEmailBatch's own mock path matches by position against
    // the real request and always echoes the REAL (dynamically generated) pairId back, so a fixture
    // never needs to predict it.
    mockReconcile({ results: [{ pairId: "__ANY__", verdict: "same_event", reason: "Same company and role, one day apart — the same real application." }] });
    const listReply = await sendAgentMessage(server, userId, "show email reviews");

    assert.match(listReply.reply, /GoMining.*2 confirmation emails, likely 1 application/is);
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. Exoticca LinkedIn + Workable, one day apart, merge as one likely application", async () => {
  const server = buildServer();
  const userId = `batch-recon-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    await seedReview(userId, connectionId, rule.id, { providerMessageId: "exoticca-workable", subject: "Thanks for applying to Exoticca", company: "Exoticca", role: "Product Manager", createdAt: new Date("2026-09-02T09:00:00.000Z") });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "exoticca-li", subject: "Exoticca - solicitud enviada", company: "Exoticca", role: "Product Manager", createdAt: new Date("2026-09-03T09:00:00.000Z") });
    await seedPadding(userId, connectionId, rule.id, 4, 0);

    mockReconcile({ results: [{ pairId: "__ANY__", verdict: "same_event", reason: "Same company and role, one day apart — the same real application." }] });
    const listReply = await sendAgentMessage(server, userId, "show email reviews");

    assert.match(listReply.reply, /Exoticca.*2 confirmation emails, likely 1 application/is);
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. same company, genuinely different role: the LLM says different_events, stays separate", async () => {
  const server = buildServer();
  const userId = `batch-recon-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-backend", subject: "Thanks for applying to GoMining", company: "GoMining", role: "Backend Engineer", createdAt: new Date("2026-09-02T09:00:00.000Z") });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-frontend", subject: "Thanks for applying to GoMining", company: "GoMining", role: "Frontend Engineer", createdAt: new Date("2026-09-03T09:00:00.000Z") });
    await seedPadding(userId, connectionId, rule.id, 4, 0);

    mockReconcile({ results: [{ pairId: "__ANY__", verdict: "different_events", reason: "Backend Engineer and Frontend Engineer are different roles, even at the same company." }] });
    const listReply = await sendAgentMessage(server, userId, "show email reviews");

    assert.doesNotMatch(listReply.reply, /GoMining.*2 confirmation emails/is, "different roles must never merge even when the LLM is asked");
    const backendCount = (listReply.reply.match(/GoMining — Backend Engineer/g) ?? []).length;
    const frontendCount = (listReply.reply.match(/GoMining — Frontend Engineer/g) ?? []).length;
    assert.equal(backendCount, 1);
    assert.equal(frontendCount, 1);
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. same role, different company: never even asked, stays separate", async () => {
  const server = buildServer();
  const userId = `batch-recon-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-eng", subject: "Thanks for applying to GoMining", company: "GoMining", role: "Software Engineer", createdAt: new Date("2026-09-02T09:00:00.000Z") });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "exoticca-eng", subject: "Thanks for applying to Exoticca", company: "Exoticca", role: "Software Engineer", createdAt: new Date("2026-09-03T09:00:00.000Z") });
    await seedPadding(userId, connectionId, rule.id, 4, 0);

    // Deliberately no mock response set — if the pre-filter incorrectly flagged this pair as a
    // candidate, reconcileEmailBatch would attempt a real, unmocked network call and this test
    // would hang/fail; passing at all proves the pre-filter correctly never asked.
    const listReply = await sendAgentMessage(server, userId, "show email reviews");

    assert.match(listReply.reply, /GoMining — Software Engineer/i);
    assert.match(listReply.reply, /Exoticca — Software Engineer/i);
    assert.doesNotMatch(listReply.reply, /Possible duplicate confirmations:/i);
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. an uncertain near-duplicate never silently merges — both stay individually visible", async () => {
  const server = buildServer();
  const userId = `batch-recon-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-a", subject: "Thanks for applying to GoMining", company: "GoMining", role: "Engineer", createdAt: new Date("2026-09-02T09:00:00.000Z") });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-b", subject: "Thanks for applying to GoMining", company: "GoMining", role: "Engineer II", createdAt: new Date("2026-09-03T09:00:00.000Z") });
    await seedPadding(userId, connectionId, rule.id, 4, 0);

    mockReconcile({ results: [{ pairId: "__ANY__", verdict: "unclear", reason: "Cannot confidently tell if 'Engineer' and 'Engineer II' are the same role." }] });
    const listReply = await sendAgentMessage(server, userId, "show email reviews");

    assert.doesNotMatch(listReply.reply, /2 confirmation emails, likely 1 application/is, "unclear must never silently merge");
    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0, "nothing is ever written just from the grouped view — the user still decides");
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. a failed/unavailable reconciliation call fails closed — never merges, never crashes", async () => {
  const server = buildServer();
  const userId = `batch-recon-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-a", subject: "Thanks for applying to GoMining", company: "GoMining", role: "Backend Engineer", createdAt: new Date("2026-09-02T09:00:00.000Z") });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-b", subject: "Thanks for applying to GoMining", company: "GoMining", role: "Backend Engineer", createdAt: new Date("2026-09-03T09:00:00.000Z") });
    await seedPadding(userId, connectionId, rule.id, 4, 0);

    // reconcileEmailBatch's own designed fallback (BATCH_RECONCILIATION_MOCK_THROW) simulates a
    // real network/API failure — this must never crash the list, and must never guess a merge for
    // a genuine near-duplicate candidate it couldn't actually get an answer about (fails closed to
    // "unclear" internally, exactly like an outcome for an unrecognized pairId would).
    process.env.BATCH_RECONCILIATION_MOCK_THROW = "true";
    const listReply = await sendAgentMessage(server, userId, "show email reviews");

    assert.doesNotMatch(listReply.reply, /2 confirmation emails, likely 1 application/is, "a failed reconciliation call must never be treated as a merge");
    assert.match(listReply.reply, /GoMining — Backend Engineer/i);
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G. the grouped summary explains an advisory-merged duplicate exactly like an exact-key one, and counting it writes exactly one event", async () => {
  const server = buildServer();
  const userId = `batch-recon-g-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-workable", subject: "Thanks for applying to GoMining", company: "GoMining", role: "Backend Engineer", createdAt: new Date("2026-09-02T09:00:00.000Z") });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "gomining-li", subject: "GoMining - solicitud enviada", company: "GoMining", role: "Backend Engineer", createdAt: new Date("2026-09-03T09:00:00.000Z") });
    await seedPadding(userId, connectionId, rule.id, 4, 0);

    mockReconcile({ results: [{ pairId: "__ANY__", verdict: "same_event", reason: "Same company and role, one day apart." }] });
    const listReply = await sendAgentMessage(server, userId, "show email reviews");
    assert.match(listReply.reply, /GoMining — 2 confirmation emails, likely 1 application/i);

    process.env.EMAIL_UNDERSTANDING_MOCK_THROW = "true";
    const countReply = await sendAgentMessage(server, userId, "count all applications");
    delete process.env.EMAIL_UNDERSTANDING_MOCK_THROW;

    assert.match(countReply.reply, /Counted 5 applications/i, "4 padding + 1 GoMining (merged from 2 emails) = 5 unique applications");
    const events = await prisma.event.count({ where: { userId, type: "career.application_sent", status: "active" } });
    assert.equal(events, 5, "the advisory-merged GoMining pair must write exactly ONE event, not two");

    const approvedReviews = await prisma.emailReviewItem.count({ where: { userId, status: "approved" } });
    assert.equal(approvedReviews, 6, "all 6 confirmation emails (4 padding + 2 GoMining) resolve, even though only 5 events were written");
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
