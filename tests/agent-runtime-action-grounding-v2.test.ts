import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * A follow-up Telegram smoke test after the first action-reminder-ux hardening pass found the
 * fix itself was incomplete/regressive in three distinct ways:
 *
 * 1. "show me my actions" said "You have 10 open actions" while claiming a fixed page size as the
 *    real total — with 12 real open actions, the extra 2 were silently hidden with no indication
 *    more existed. Fixed: action.list now says "Showing 10 of 12 open actions:" whenever the real
 *    total exceeds what's displayed, only "You have N ..." when everything really is shown.
 *
 * 2. "complete brainstorm meeting" completed a real action that was NOT in the shown page at all
 *    (item 11 of 12) with a plain "Completed" reply giving no hint it came from outside the
 *    visible list. Fixed: a supplied actionId not found in session.visibleEntities is now
 *    verified against the wider open-actions pool and ONLY trusted for a genuinely strong
 *    (exact/word-exact) title match — the executor's own reply then says plainly it was found
 *    outside the last shown list.
 *
 * 3. A repeated "complete brainstorm meeting" (after the first had already completed it)
 *    suggested "Hola Miquel, tu opinión es muy importante para nosotros." — the planner's own
 *    next guess, sharing NOTHING with what the user said beyond the word "meeting." Fixed: the
 *    "did you mean X?" suggestion now requires a real similarity tier (exact/word-exact/fuzzy on
 *    a genuinely distinctive word) — a purely generic-word-only or zero overlap never produces a
 *    suggestion, only an honest "I don't see one called X."
 *
 * 4. "complete action 10 and 9 now" (right after cancelling an unrelated ambiguity question)
 *    completed the WRONG actions — validator.ts's own digit-exemption let the planner supply
 *    whatever actionId it inferred from context.openActions's own DB ordering, a completely
 *    different order than the numbered list the user actually saw, because cancelling had wiped
 *    session.visibleEntities. Fixed: a single explicit number is now resolved deterministically
 *    against the CURRENT visibleEntities' own `index` field, overriding whatever the planner
 *    supplied, and cancelling an action-reference clarification no longer clears visibleEntities
 *    (only every OTHER kind of pending operation still does).
 */

async function seedNumberedActions(userId: string, titlesNewestFirst: string[]): Promise<void> {
  // getActionItems orders ties (no dueAt) by updatedAt DESC — the LAST one created lands at
  // position 1. Seeding in reverse of the desired numbered order gives an exact, predictable page.
  for (const title of [...titlesNewestFirst].reverse()) {
    await createActionItem(userId, { source: "manual", title });
  }
}

async function listActions(server: ReturnType<typeof buildServer>, userId: string, message = "show me my actions") {
  mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  return sendAgentMessage(server, userId, message);
}

test("A. the action list never claims a fixed page size as the real total", async () => {
  const server = buildServer();
  const userId = `action-grounding-v2-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, [
      "Upgrade to Node.js 24",
      "Apply to 3 developer jobs",
      "Renew passport",
      "Follow up with recruiter",
      "Plan next quarter roadmap",
      "Buy birthday gift",
      "Book dentist appointment",
      "Set aside time each day to read",
      "Hola Miquel, tu opinión es muy importante para nosotros.",
      "Branding direction meeting",
      "Brainstorm meeting",
      "Extra task"
    ]);

    const reply = await listActions(server, userId);

    assert.match(reply.reply, /showing 10 of 12 open actions:/i);
    assert.doesNotMatch(reply.reply, /you have 10 open actions/i, "must never claim the page size is the real total when more exist");
    assert.doesNotMatch(reply.reply, /brainstorm meeting/i, "item 11 must not appear on a 10-item page");
    assert.doesNotMatch(reply.reply, /extra task/i, "item 12 must not appear on a 10-item page");

    const session = await getAgentSession(userId, "telegram");
    const visible = session?.visibleEntities as Array<{ index: number; id: string; label: string }>;
    assert.equal(visible.length, 10, "visibleEntities must exactly match the numbered list shown, not the full 12");
    const rows = await prisma.actionItem.findMany({ where: { userId } });
    for (const entity of visible) {
      const row = rows.find((item) => item.id === entity.id);
      assert.ok(row, `visible entity ${entity.id} must be a real seeded action`);
      assert.equal(entity.label, row?.title);
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. an exact title outside the visible page still resolves, and says so honestly", async () => {
  const server = buildServer();
  const userId = `action-grounding-v2-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, [
      "Upgrade to Node.js 24",
      "Apply to 3 developer jobs",
      "Renew passport",
      "Follow up with recruiter",
      "Plan next quarter roadmap",
      "Buy birthday gift",
      "Book dentist appointment",
      "Set aside time each day to read",
      "Hola Miquel, tu opinión es muy importante para nosotros.",
      "Branding direction meeting",
      "Brainstorm meeting",
      "Extra task"
    ]);
    const brainstorm = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Brainstorm meeting" } });

    const list = await listActions(server, userId);
    assert.doesNotMatch(list.reply, /brainstorm meeting/i, "confirms it really was outside the shown page");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: brainstorm.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete brainstorm meeting");

    // Deterministic: an exact title match outside the page is completed, with an explicit note
    // that it was not on the last shown list — never a silent, plain "Completed" that hides this.
    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /brainstorm meeting/i);
    assert.match(reply.reply, /outside your last shown list/i);

    const row = await prisma.actionItem.findUnique({ where: { id: brainstorm.id } });
    assert.equal(row?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. no nonsense 'did you mean' suggestion — an unrelated low-quality email-derived title is never offered", async () => {
  const server = buildServer();
  const userId = `action-grounding-v2-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    const branding = await createActionItem(userId, { source: "manual", title: "Branding direction meeting" });
    const hola = await createActionItem(userId, {
      source: "email_review",
      sourceProvider: "gmail",
      title: "Hola Miquel, tu opinión es muy importante para nosotros."
    });
    await createActionItem(userId, { source: "manual", title: "Upgrade to Node.js 24" });

    await listActions(server, userId);

    // Simulates the exact real reported bug: the planner's own next guess for a repeated
    // "complete brainstorm meeting" (after the real Brainstorm meeting was already completed
    // elsewhere) was the totally unrelated Hola Miquel action.
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: hola.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete brainstorm meeting");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.doesNotMatch(reply.reply, /hola miquel/i, "must never suggest a candidate sharing nothing with what the user said");
    assert.match(reply.reply, /don't see an open action called "brainstorm meeting"/i);
    assert.match(reply.reply, /which action do you mean/i);

    const holaRow = await prisma.actionItem.findUnique({ where: { id: hola.id } });
    const brandingRow = await prisma.actionItem.findUnique({ where: { id: branding.id } });
    assert.equal(holaRow?.status, "open");
    assert.equal(brandingRow?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. generic/shared-word-only overlap across multiple candidates is never enough — asks clarification, no mutation", async () => {
  const server = buildServer();
  const userId = `action-grounding-v2-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    const branding = await createActionItem(userId, { source: "manual", title: "Branding direction meeting" });
    const brainstorm = await createActionItem(userId, { source: "manual", title: "Brainstorm meeting" });

    await listActions(server, userId);

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete meeting");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /which action do you mean/i);

    const rowBranding = await prisma.actionItem.findUnique({ where: { id: branding.id } });
    const rowBrainstorm = await prisma.actionItem.findUnique({ where: { id: brainstorm.id } });
    assert.equal(rowBranding?.status, "open");
    assert.equal(rowBrainstorm?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. cancelling a pending 'did you mean'/ambiguity question never corrupts later numbered references", async () => {
  const server = buildServer();
  const userId = `action-grounding-v2-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, [
      "Upgrade to Node.js 24",
      "Apply to 3 developer jobs",
      "Renew passport",
      "Follow up with recruiter",
      "Plan next quarter roadmap",
      "Buy birthday gift",
      "Book dentist appointment",
      "Draft weekly status update",
      "Set aside time each day to read",
      "Hola Miquel, tu opinión es muy importante para nosotros."
    ]);

    const list = await listActions(server, userId);
    assert.match(list.reply, /9\. set aside time each day to read/i);
    assert.match(list.reply, /10\. .*hola miquel/i);

    const session = await getAgentSession(userId, "telegram");
    const visibleBefore = session?.visibleEntities as Array<{ index: number; id: string }>;
    const idAtNine = visibleBefore.find((e) => e.index === 9)!.id;
    const idAtTen = visibleBefore.find((e) => e.index === 10)!.id;

    // "complete brainstorm meeting" names something not on this list at all and not a real open
    // action anywhere — an honest ambiguity/no-match clarification opens (either a "did you
    // mean" suggestion or a plain one is acceptable; what matters is that SOMETHING pending
    // opens and the ORIGINAL numbered list survives it).
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: idAtTen })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const ambiguous = await sendAgentMessage(server, userId, "complete brainstorm meeting");
    assert.equal(ambiguous.debug.mutationExecuted, false);
    assert.equal(ambiguous.needsConfirmation, true);

    const cancelReply = await sendAgentMessage(server, userId, "cancel");
    assert.match(cancelReply.reply, /^(cancelled — i won.t do that\.|okay — i won.t complete anything\.)$/i);

    const sessionAfterCancel = await getAgentSession(userId, "telegram");
    const visibleAfterCancel = sessionAfterCancel?.visibleEntities as Array<{ index: number; id: string }>;
    assert.equal(visibleAfterCancel.length, 10, "the original numbered list must survive cancelling an unrelated ambiguity question");

    // A well-behaved planner routes a compound numbered request through action.hygiene_apply,
    // whose own index resolution reads session.visibleEntities directly.
    mockPlan({
      topic: "actions",
      intent: "hygiene_apply",
      operations: [op("action.hygiene_apply", { selections: [{ index: 10, decision: "complete" }, { index: 9, decision: "complete" }] })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const finalReply = await sendAgentMessage(server, userId, "complete action 10 and 9 now");
    assert.equal(finalReply.debug.mutationExecuted, true);

    const rowNine = await prisma.actionItem.findUnique({ where: { id: idAtNine } });
    const rowTen = await prisma.actionItem.findUnique({ where: { id: idAtTen } });
    assert.equal(rowNine?.status, "completed", "index 9 must resolve to 'Set aside time each day to read', the item actually shown at position 9");
    assert.equal(rowTen?.status, "completed", "index 10 must resolve to 'Hola Miquel...', the item actually shown at position 10");

    const apply = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Apply to 3 developer jobs" } });
    const upgrade = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Upgrade to Node.js 24" } });
    assert.equal(apply.status, "open", "an unrelated action must never be completed by a stale/wrong index mapping");
    assert.equal(upgrade.status, "open", "an unrelated action must never be completed by a stale/wrong index mapping");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. an explicit new numbered command while a suggestion is pending never blocks forever or later uses wrong indices", async () => {
  const server = buildServer();
  const userId = `action-grounding-v2-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, [
      "Upgrade to Node.js 24",
      "Apply to 3 developer jobs",
      "Renew passport",
      "Follow up with recruiter",
      "Plan next quarter roadmap",
      "Buy birthday gift",
      "Book dentist appointment",
      "Draft weekly status update",
      "Set aside time each day to read",
      "Hola Miquel, tu opinión es muy importante para nosotros."
    ]);

    await listActions(server, userId);

    const session = await getAgentSession(userId, "telegram");
    const visibleBefore = session?.visibleEntities as Array<{ index: number; id: string }>;
    const idAtNine = visibleBefore.find((e) => e.index === 9)!.id;
    const idAtTen = visibleBefore.find((e) => e.index === 10)!.id;

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: idAtTen })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const ambiguous = await sendAgentMessage(server, userId, "complete brainstorm meeting");
    assert.equal(ambiguous.needsConfirmation, true);

    // No cancel first — an explicit new numbered command right on top of the pending question.
    mockPlan({
      topic: "actions",
      intent: "hygiene_apply",
      operations: [op("action.hygiene_apply", { selections: [{ index: 10, decision: "complete" }, { index: 9, decision: "complete" }] })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const immediateReply = await sendAgentMessage(server, userId, "complete action 10 and 9 now");

    // Acceptable: either it's blocked with an explicit "cancel first" style message (never
    // silently misapplied), or it superseded the pending suggestion outright and completed
    // correctly. Either way nothing may complete against the WRONG items, and it must not hang.
    if (!immediateReply.debug.mutationExecuted) {
      assert.match(immediateReply.reply, /pending confirmation|confirm.*cancel/i);

      const cancelReply = await sendAgentMessage(server, userId, "cancel");
      assert.match(cancelReply.reply, /^(cancelled — i won.t do that\.|okay — i won.t complete anything\.)$/i);

      mockPlan({
        topic: "actions",
        intent: "hygiene_apply",
        operations: [op("action.hygiene_apply", { selections: [{ index: 10, decision: "complete" }, { index: 9, decision: "complete" }] })],
        needsClarification: false,
        clarificationQuestion: null,
        replyDraft: ""
      });
      const retryReply = await sendAgentMessage(server, userId, "complete action 10 and 9 now");
      assert.equal(retryReply.debug.mutationExecuted, true, "must not keep blocking forever once the user actually cancels");
    }

    const rowNine = await prisma.actionItem.findUnique({ where: { id: idAtNine } });
    const rowTen = await prisma.actionItem.findUnique({ where: { id: idAtTen } });
    assert.equal(rowNine?.status, "completed");
    assert.equal(rowTen?.status, "completed");

    const apply = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Apply to 3 developer jobs" } });
    const upgrade = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Upgrade to Node.js 24" } });
    assert.equal(apply.status, "open");
    assert.equal(upgrade.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G. old email-generated actions are labeled lightly and never used as an unrelated fuzzy suggestion", async () => {
  const server = buildServer();
  const userId = `action-grounding-v2-g-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createActionItem(userId, {
      source: "email_review",
      sourceProvider: "gmail",
      title: "Hola Miquel, tu opinión es muy importante para nosotros."
    });
    await createActionItem(userId, { source: "manual", title: "Renew passport" });

    const reply = await listActions(server, userId);

    assert.match(reply.reply, /hola miquel/i);
    assert.match(reply.reply, /\(from gmail\)/i, "an email-derived action should be labeled lightly with its source");
    const lines = reply.reply.split("\n");
    const passportLineIndex = lines.findIndex((line) => /renew passport/i.test(line));
    assert.ok(passportLineIndex >= 0);
    assert.doesNotMatch(lines[passportLineIndex + 1] ?? "", /from gmail/i, "a manually-created action must never carry a source label");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
