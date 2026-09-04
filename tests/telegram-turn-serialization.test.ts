import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 5): audits and exercises
 * per-user turn serialization for rapid/overlapping requests — the exact concern the task raised
 * ("rapid Telegram messages can arrive before previous processing finishes").
 *
 * Finding from inspection (not assumption): two independent mechanisms already serialize this,
 * both pre-existing (not added by this branch):
 *   1. apps/telegram-bot/src/index.ts runs in long-polling mode only (`mode=long-polling` is
 *      logged at startup, and `bot.start()` is the only start path — no webhook path exists in
 *      this codebase). grammy's own Bot.handleUpdates (node_modules/grammy/out/bot.js) processes
 *      every incoming update with a plain `for (const update of updates) { await this.handleUpdate(update); }`
 *      loop — literally commented "handle updates sequentially (!)" in grammy's own source. This
 *      serializes ALL updates globally (a strictly stronger guarantee than per-user), and since
 *      apps/telegram-bot/src/agent-runtime-routing.ts's routeToAgentRuntimeV3 awaits the full
 *      /agent/message round trip before returning, grammy will not start handling the next update
 *      until the current one's entire agent turn (including any mutation) has fully settled.
 *   2. Independently, at the API layer, apps/api/src/agent-runtime/runtime.ts's handleAgentMessage
 *      (the actual /agent/message handler, wired in apps/api/src/routes/agent.ts) wraps every call
 *      in runExclusive(userId, ...) (apps/api/src/agent-runtime/user-lock.ts) — a real per-user
 *      FIFO queue, already covered in isolation by tests/agent-runtime-user-lock.test.ts. This is
 *      the layer that actually matters for correctness even if the Telegram-layer guarantee above
 *      were ever weakened (e.g. by a future webhook migration, or a second caller hitting
 *      /agent/message directly, like a debug tool or another channel).
 *
 * Residual, disclosed gap: apps/api/src/routes/pending-actions.ts (the LEGACY /messages/process
 * pending-decision confirm/reject routes) does not go through runExclusive. This is only reachable
 * when TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false opts a deployment back into the legacy pipeline —
 * off by default — so it is not a live risk for the current default configuration, but is not
 * covered by the guarantee below either.
 *
 * The tests here exercise the REAL /agent/message path exactly as apps/telegram-bot's v3 routing
 * calls it, firing same-user requests back-to-back without awaiting between dispatches (the same
 * pattern tests/agent-runtime-user-lock.test.ts uses to prove real queuing, not just test-code
 * await ordering) — proving the domain-level scenarios the task named, not just the primitive.
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
  input: { providerMessageId: string; subject: string; reason: string; proposedEventType?: string; extracted?: Record<string, unknown>; updatedAt?: Date }
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
      updatedAt: input.updatedAt,
      reason: input.reason,
      proposedEventType: input.proposedEventType,
      extracted: input.extracted ?? {},
      status: "pending",
      priority: "normal"
    }
  });
}

test("1. sync + email reviews rapid sequence: a bulk-count mutation racing a list call never shows a torn/partial state", async () => {
  const server = buildServer();
  const userId = `turnser-1-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    for (let i = 0; i < 4; i += 1) {
      await seedReview(userId, connectionId, rule.id, {
        providerMessageId: `confirm-${i}`,
        subject: `Thanks for applying to Company${i}`,
        reason: "application_confirmation",
        proposedEventType: "career.application_confirmation_received",
        extracted: { company: `Company${i}`, role: "Engineer" }
      });
    }

    await sendAgentMessage(server, userId, "show email reviews");

    process.env.EMAIL_UNDERSTANDING_MOCK_THROW = "true";
    // Dispatched back-to-back, without awaiting between them — the mutation is registered in
    // runExclusive's queue first (program order), so the list call is guaranteed to observe either
    // the fully-pre-count state or the fully-post-count state, never a partial 1-3 count.
    const countPromise = sendAgentMessage(server, userId, "count all applications");
    const listPromise = sendAgentMessage(server, userId, "show raw email reviews");
    const [countReply, listReply] = await Promise.all([countPromise, listPromise]);
    delete process.env.EMAIL_UNDERSTANDING_MOCK_THROW;

    assert.match(countReply.reply, /Counted 4 applications/i);

    const pendingCount = (listReply.reply.match(/^\d+\.\s/gm) ?? []).length;
    assert.ok(pendingCount === 0 || pendingCount === 4, `expected a coherent 0 or 4 pending rows, got a torn ${pendingCount}`);

    const approved = await prisma.emailReviewItem.count({ where: { userId, status: "approved" } });
    assert.equal(approved, 4, "the mutation must have fully completed, not partially, regardless of dispatch race");
  } finally {
    delete process.env.EMAIL_UNDERSTANDING_MOCK_THROW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. details + ignore rapid sequence: no interleaved corruption, review ends in exactly one coherent state", async () => {
  const server = buildServer();
  const userId = `turnser-2-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "Recruiter opportunity at Acme", reason: "recruiter_reply" });

    await sendAgentMessage(server, userId, "show email reviews");

    const detailsPromise = sendAgentMessage(server, userId, "details for 1");
    const ignorePromise = sendAgentMessage(server, userId, "ignore 1");
    const [detailsReply, ignoreReply] = await Promise.all([detailsPromise, ignorePromise]);

    assert.doesNotMatch(detailsReply.reply, /unexpected problem|hit an error/i);
    assert.doesNotMatch(ignoreReply.reply, /unexpected problem|hit an error/i);

    const review = await prisma.emailReviewItem.findFirst({ where: { userId } });
    assert.equal(review?.status, "rejected", "the review must land in exactly one final status — never left half-mutated");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. ignore + show reviews rapid sequence: the later-dispatched list call never shows a stale just-ignored item", async () => {
  const server = buildServer();
  const userId = `turnser-3-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });
    // getEmailReviewItems orders by updatedAt desc (newest first) — explicit timestamps here so
    // index 1 is deterministically "Kraken job digest", matching the assertions below.
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "Kraken job digest", reason: "filtered_marketing", updatedAt: new Date("2026-09-03T09:01:00.000Z") });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m2", subject: "Endesa factura", reason: "invoice", updatedAt: new Date("2026-09-03T09:00:00.000Z") });

    await sendAgentMessage(server, userId, "show email reviews");

    // "ignore 1" is dispatched (and so registered in runExclusive's FIFO queue) strictly before
    // "show reviews" here, so the guarantee under test predicts the list call deterministically
    // observes the POST-ignore state, not a race.
    const ignorePromise = sendAgentMessage(server, userId, "ignore 1");
    const listPromise = sendAgentMessage(server, userId, "show raw email reviews");
    const [ignoreReply, listReply] = await Promise.all([ignorePromise, listPromise]);

    assert.doesNotMatch(ignoreReply.reply, /unexpected problem|hit an error/i);
    assert.doesNotMatch(listReply.reply, /kraken job digest/i, "the later-dispatched list call must reflect the ignore that was queued ahead of it, not a stale pre-ignore view");
    assert.match(listReply.reply, /endesa factura/i, "the still-pending item must still be listed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. no stale focus mutation: a concurrent re-list cannot make a mutation dispatched against index 2 land on the wrong item", async () => {
  const server = buildServer();
  const userId = `turnser-4-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });
    // getEmailReviewItems orders by updatedAt desc (newest first) — explicit timestamps here so
    // index 1 is deterministically "Endesa factura" and index 2 "Acme", matching the assertions below.
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "Endesa factura", reason: "invoice", updatedAt: new Date("2026-09-03T09:01:00.000Z") });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m2", subject: "Recruiter opportunity at Acme", reason: "recruiter_reply", updatedAt: new Date("2026-09-03T09:00:00.000Z") });

    await sendAgentMessage(server, userId, "show email reviews");

    // Dispatched together: a re-list (which could, in a broken implementation, race a renumbering
    // against the mutation below) and "ignore 2" targeting the item shown as #2 in the list this
    // session already has in view.
    const relistPromise = sendAgentMessage(server, userId, "show raw email reviews");
    const ignoreSecondPromise = sendAgentMessage(server, userId, "ignore 2");
    await Promise.all([relistPromise, ignoreSecondPromise]);

    const acme = await prisma.emailReviewItem.findFirst({ where: { userId, providerMessageId: "m2" } });
    const endesa = await prisma.emailReviewItem.findFirst({ where: { userId, providerMessageId: "m1" } });
    assert.equal(acme?.status, "rejected", "index 2 (Acme recruiter reply) must be the one actually mutated");
    assert.equal(endesa?.status, "pending", "index 1 (Endesa invoice) must be untouched by a concurrently-dispatched relist");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
