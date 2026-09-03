import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (Task 14): the acceptance test — the
 * user's own screenshot-like case. Twelve real-shaped Gmail signals (5 standalone confirmations, 2
 * duplicate-evidence pairs, 3 noise items) must present as a grouped operator summary by default
 * (never a raw 12-row queue), must ask the exact "7 unique or 9 raw" question, and "count the 7"
 * must count exactly 7 applications — attaching the 4 duplicate-evidence emails to their sibling
 * without a second progress write, and leaving all 3 noise items untouched and still pending.
 *
 * Understanding is forced to gracefully degrade (EMAIL_UNDERSTANDING_MOCK_THROW) so counting relies
 * on each review's own already-stored reason/proposedEventType — the same fallback path a real
 * production run takes whenever a fresh LLM understanding call is unavailable — keeping this test
 * deterministic and network-free while still exercising the real executor/progress-command code.
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

interface SeedInput {
  subject: string;
  from: string;
  reason: string;
  proposedEventType?: string;
  extracted?: Record<string, unknown>;
  providerMessageId: string;
  createdAt: Date;
}

async function seedReview(userId: string, connectionId: string, ruleId: string, input: SeedInput) {
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
      from: input.from,
      snippet: input.subject,
      evidence: input.subject,
      confidence: 0.85,
      reason: input.reason,
      proposedEventType: input.proposedEventType,
      extracted: input.extracted ?? {},
      status: "pending",
      priority: "normal",
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    }
  });
}

test("Task 14 acceptance: 12-email batch groups into 7 unique applications, hides 3 noise items, asks the exact count question, and 'count the 7' logs exactly 7", async () => {
  const server = buildServer();
  const userId = `email-intel-acceptance-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId, adapterId: "job_search_email", name: "Job search emails", status: "active", createdBy: "user" }
    });

    const day = new Date("2026-09-03T09:00:00.000Z");
    const minutesLater = (n: number) => new Date(day.getTime() + n * 60_000);

    const CONFIRMATION = { reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" };

    // 5 standalone application confirmations
    await seedReview(userId, connectionId, rule.id, {
      subject: "Thanks for applying to Jiga",
      from: "no-reply@jiga.example",
      providerMessageId: "jiga-1",
      createdAt: minutesLater(1),
      ...CONFIRMATION,
      extracted: { company: "Jiga", role: "Full Stack Product Engineer" }
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Thanks for applying to Cohere",
      from: "no-reply@cohere.example",
      providerMessageId: "cohere-1",
      createdAt: minutesLater(2),
      ...CONFIRMATION,
      extracted: { company: "Cohere", role: "Software Engineer" }
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Your application has been received — Lightdash",
      from: "no-reply@lightdash.example",
      providerMessageId: "lightdash-1",
      createdAt: minutesLater(3),
      ...CONFIRMATION,
      extracted: { company: "Lightdash", role: "Product Engineer" }
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "cander — solicitud enviada",
      from: "jobs-noreply@linkedin.com",
      providerMessageId: "cander-li-1",
      createdAt: minutesLater(4),
      ...CONFIRMATION,
      extracted: { company: "cander", role: "Software Engineer" }
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Conquer AI — solicitud enviada",
      from: "jobs-noreply@linkedin.com",
      providerMessageId: "conquer-li-1",
      createdAt: minutesLater(5),
      ...CONFIRMATION,
      extracted: { company: "Conquer AI", role: "Software Engineer" }
    });

    // GoMining — 2 confirmation emails (Workable + LinkedIn), same company/role/day -> 1 application
    await seedReview(userId, connectionId, rule.id, {
      subject: "Thanks for applying to GoMining",
      from: "no-reply@workable.com",
      providerMessageId: "gomining-workable-1",
      createdAt: minutesLater(6),
      ...CONFIRMATION,
      extracted: { company: "GoMining", role: "Backend Engineer" }
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "GoMining — solicitud enviada",
      from: "jobs-noreply@linkedin.com",
      providerMessageId: "gomining-li-1",
      createdAt: minutesLater(7),
      ...CONFIRMATION,
      extracted: { company: "GoMining", role: "Backend Engineer" }
    });

    // Exoticca — 2 confirmation emails (Workable + LinkedIn), same company/role/day -> 1 application
    await seedReview(userId, connectionId, rule.id, {
      subject: "Thanks for applying to Exoticca",
      from: "no-reply@workable.com",
      providerMessageId: "exoticca-workable-1",
      createdAt: minutesLater(8),
      ...CONFIRMATION,
      extracted: { company: "Exoticca", role: "Product Manager" }
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Exoticca — solicitud enviada",
      from: "jobs-noreply@linkedin.com",
      providerMessageId: "exoticca-li-1",
      createdAt: minutesLater(9),
      ...CONFIRMATION,
      extracted: { company: "Exoticca", role: "Product Manager" }
    });

    // 3 noise items: a job-matches digest, an "apply now" prompt (not a confirmation), a similar-jobs alert
    await seedReview(userId, connectionId, rule.id, {
      subject: "Built In: New job matches for you",
      from: "jobs@builtin.com",
      providerMessageId: "builtin-digest",
      createdAt: minutesLater(10),
      reason: "filtered_marketing"
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Technical Solutions Blockchain — solicita ya el empleo",
      from: "jobs-noreply@linkedin.com",
      providerMessageId: "tsb-apply-prompt",
      createdAt: minutesLater(11),
      reason: "filtered_marketing"
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Jobs similar to ones you've applied to",
      from: "jobs-noreply@linkedin.com",
      providerMessageId: "similar-jobs-alert",
      createdAt: minutesLater(12),
      reason: "filtered_marketing"
    });

    const allReviewIds = (await prisma.emailReviewItem.findMany({ where: { userId }, select: { id: true } })).map((r) => r.id);
    assert.equal(allReviewIds.length, 12, "sanity: exactly 12 emails seeded");

    // --- Stage E: default view must be grouped, never a raw 12-row queue ---
    const listReply = await sendAgentMessage(server, userId, "show email reviews");

    assert.match(listReply.reply, /Gmail found 12 relevant emails\./i);
    assert.match(listReply.reply, /Likely new applications:/i);
    assert.match(listReply.reply, /jiga/i);
    assert.match(listReply.reply, /cohere/i);
    assert.match(listReply.reply, /lightdash/i);
    assert.match(listReply.reply, /cander/i);
    assert.match(listReply.reply, /conquer ai/i);

    assert.match(listReply.reply, /Possible duplicate confirmations:/i);
    assert.match(listReply.reply, /gomining.*2 confirmation emails, likely 1 application/i);
    assert.match(listReply.reply, /exoticca.*2 confirmation emails, likely 1 application/i);

    assert.match(listReply.reply, /Noise hidden:/i);
    assert.doesNotMatch(listReply.reply, /built in/i, "noise items must be hidden by default, not listed individually");
    assert.doesNotMatch(listReply.reply, /technical solutions blockchain/i);

    // Never a flat numbered list of all 12 items as the DEFAULT view.
    assert.equal((listReply.reply.match(/^\d+\.\s/gm) ?? []).length < 12, true, "must not show a flat raw list of all 12 emails by default");

    // The exact count question from the acceptance spec.
    assert.match(listReply.reply, /Count 7 unique applications, or count 9 confirmation emails\/manual applications\?/i);

    // Raw view remains available on request — itemized per-row, not grouped (still capped at 10
    // rows like any other flat list, unlike the grouped view's higher ceiling).
    const rawReply = await sendAgentMessage(server, userId, "show raw email reviews");
    assert.match(rawReply.reply, /^\d+\.\s.*exoticca/im);
    assert.doesNotMatch(rawReply.reply, /Likely new applications:|Possible duplicate confirmations:/i);

    // Re-show the grouped view so the session's visible entities point at the grouped indexes again.
    await sendAgentMessage(server, userId, "show email reviews");

    // --- Bulk count: "count the 7" must count exactly 7 unique applications ---
    process.env.EMAIL_UNDERSTANDING_MOCK_THROW = "true";
    const countReply = await sendAgentMessage(server, userId, "count the 7");
    delete process.env.EMAIL_UNDERSTANDING_MOCK_THROW;

    assert.match(countReply.reply, /Counted 7 applications:/i);
    assert.match(countReply.reply, /Today: 7 CVs sent\. This week: 7 CVs sent\./i);

    const events = await prisma.event.findMany({ where: { userId, type: "career.application_sent" } });
    assert.equal(events.length, 7, "exactly 7 progress events — one per unique application, never one per raw email");

    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    const approved = reviews.filter((review) => review.status === "approved");
    const stillPending = reviews.filter((review) => review.status === "pending");

    assert.equal(approved.length, 9, "all 9 confirmation emails (5 standalone + 4 duplicate-evidence) resolve, even though only 7 events were written");
    assert.equal(stillPending.length, 3, "the 3 noise items are untouched and remain pending — never silently counted or mutated");

    const gomining = reviews.filter((review) => (review.extracted as Record<string, unknown> | null)?.company === "GoMining");
    assert.equal(gomining.length, 2);
    assert.ok(gomining.every((review) => review.status === "approved"));
    const gominingEventIds = new Set(gomining.map((review) => review.eventId).filter(Boolean));
    assert.equal(gominingEventIds.size, 1, "both GoMining emails resolve to the SAME event id — duplicate evidence, not a second count");

    const exoticca = reviews.filter((review) => (review.extracted as Record<string, unknown> | null)?.company === "Exoticca");
    assert.equal(exoticca.length, 2);
    const exoticcaEventIds = new Set(exoticca.map((review) => review.eventId).filter(Boolean));
    assert.equal(exoticcaEventIds.size, 1, "both Exoticca emails resolve to the SAME event id — duplicate evidence, not a second count");
  } finally {
    delete process.env.EMAIL_UNDERSTANDING_MOCK_THROW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
