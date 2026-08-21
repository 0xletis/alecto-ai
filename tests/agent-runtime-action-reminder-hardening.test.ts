import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Real Telegram smoke found two remaining blockers after the first action-reminder-ux pass:
 *
 * 1. "Reminder for Branding direction meeting" still leaked into a normal action list.
 *    Root cause: the prior fix only recognized a companion via `actionType === "reminder"`, but
 *    the real row in the connected DB had a different/legacy actionType — genuinely malformed or
 *    pre-dating that convention. Fixed generically in
 *    apps/api/src/actions/reminder-companion.ts's isReminderCompanionAction, which now also
 *    checks the sourceId prefix and the denormalized "Reminder for X"/"Reminder: X" title shape,
 *    so a companion is recognized even when one specific field is unreliable.
 *
 * 2. "complete brainstorm meeting" completed "Branding direction meeting" — the only shared word
 *    was "meeting," a generic activity-shape word carrying no information about WHICH meeting.
 *    Root cause: validator.ts's ACTION_GROUNDING_STOPWORDS didn't include "meeting" (or
 *    call/thing/todo/reminder), so a purely generic overlap was accepted as real grounding. Fixed
 *    by widening the stopword list, and — since a rejected-but-planner-supplied guess is often a
 *    reasonable candidate, not garbage — by downgrading it to a confirmable suggestion ("Did you
 *    mean X? Reply yes...") instead of silently discarding it into a generic "which one?"
 *    question, via a new `suggestedConfirmOperation` carried on the ValidatedOperation and
 *    installed as a real (not inert) pending operation in runtime.ts.
 */

async function seedActionWithReminder(
  userId: string,
  title: string,
  dueAt: Date,
  options: { reminderTitle?: string; leadMinutes?: number; malformed?: boolean } = {}
): Promise<{ parentId: string; reminderId: string }> {
  const parent = await createActionItem(userId, { source: "manual", title, dueAt });
  const leadMinutes = options.leadMinutes ?? 30;
  const reminder = await createActionItem(userId, {
    source: options.malformed ? "manual" : "system",
    sourceId: options.malformed ? undefined : `pre_due_reminder:${parent.id}:${leadMinutes}`,
    title: options.reminderTitle ?? `Reminder for ${title}`,
    dueAt: new Date(dueAt.getTime() - leadMinutes * 60_000),
    actionType: options.malformed ? "manual" : "reminder"
  });
  return { parentId: parent.id, reminderId: reminder.id };
}

async function listActions(server: ReturnType<typeof buildServer>, userId: string, message = "show me my actions") {
  mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  return sendAgentMessage(server, userId, message);
}

test("A. a legacy/malformed reminder companion never leaks into the normal action list", async () => {
  const server = buildServer();
  const userId = `action-hardening-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // 1. Real parent action.
    await createActionItem(userId, { source: "manual", title: "Branding direction meeting", dueAt: future });

    // 2. Proper reminder companion (actionType "reminder", well-formed sourceId).
    const parent = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Branding direction meeting" } });
    await createActionItem(userId, {
      source: "system",
      sourceId: `pre_due_reminder:${parent.id}:30`,
      title: "Reminder for Branding direction meeting",
      dueAt: new Date(future.getTime() - 30 * 60_000),
      actionType: "reminder"
    });

    // 3. Legacy/malformed reminder companion — wrong actionType, no sourceId, no real parent.
    await createActionItem(userId, { source: "manual", title: "Reminder for Brainstorm meeting", dueAt: future });

    const reply = await listActions(server, userId);

    assert.match(reply.reply, /branding direction meeting/i);
    assert.doesNotMatch(reply.reply, /^.*reminder for branding direction meeting.*$/im);
    assert.doesNotMatch(reply.reply, /reminder for brainstorm meeting/i);

    const session = await getAgentSession(userId, "telegram");
    const visible = session?.visibleEntities as Array<{ type: string; label: string }>;
    assert.ok(!visible.some((entity) => /reminder for/i.test(entity.label)), "visibleEntities from a normal action list must exclude reminder companions");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. the reminder list still shows reminders, grouped under parent, and shows an unlinked legacy reminder honestly", async () => {
  const server = buildServer();
  const userId = `action-hardening-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const parent = await createActionItem(userId, { source: "manual", title: "Branding direction meeting", dueAt: future });
    await createActionItem(userId, {
      source: "system",
      sourceId: `pre_due_reminder:${parent.id}:30`,
      title: "Reminder for Branding direction meeting",
      dueAt: new Date(future.getTime() - 30 * 60_000),
      actionType: "reminder"
    });
    // Malformed companion with no resolvable parent (no action titled "Brainstorm meeting" exists).
    await createActionItem(userId, { source: "manual", title: "Reminder for Brainstorm meeting", dueAt: future });

    const reply = await sendAgentMessage(server, userId, "show my reminders");

    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["action.reminder_list"]);
    assert.doesNotMatch(reply.reply, /no reminders are currently scheduled/i);
    assert.match(reply.reply, /branding direction meeting/i);
    assert.match(reply.reply, /30 minutes before/i);
    assert.match(reply.reply, /unlinked/i, "a reminder with no resolvable parent must be shown honestly, not silently dropped");
    assert.match(reply.reply, /brainstorm meeting/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. completing the parent hides/archives its reminder from later normal-action and reminder lists", async () => {
  const server = buildServer();
  const userId = `action-hardening-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { parentId } = await seedActionWithReminder(userId, "Branding direction meeting", future);

    await listActions(server, userId);

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: parentId })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const completeReply = await sendAgentMessage(server, userId, "complete branding direction meeting");
    assert.match(completeReply.reply, /completed "branding direction meeting"/i);

    const secondList = await listActions(server, userId);
    assert.doesNotMatch(secondList.reply, /branding direction meeting/i);
    assert.doesNotMatch(secondList.reply, /reminder/i);

    const reminderReply = await sendAgentMessage(server, userId, "show my reminders");
    assert.doesNotMatch(reminderReply.reply, /branding direction meeting/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. a target sharing only a generic word is never silently completed or suggested — a genuinely wrong guess gets a plain 'I don't see one' instead", async () => {
  const server = buildServer();
  const userId = `action-hardening-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    const branding = await createActionItem(userId, { source: "manual", title: "Branding direction meeting" });
    await createActionItem(userId, { source: "manual", title: "Upgrade Node.js 24" });
    await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs" });

    await listActions(server, userId);

    // Simulates the real reported bug: the planner's own best (wrong) guess for "brainstorm
    // meeting" was the branding one. "brainstorm" does not fuzzy-match "branding" (too different
    // an edit distance) and the only literal shared word is "meeting" — generic, not real
    // evidence — so this must be rejected outright, with no "did you mean" suggestion at all. A
    // second, later real Telegram smoke test found this exact shape of weak match instead
    // producing a nonsense suggestion for an unrelated low-quality email-derived action ("Did you
    // mean 'Hola Miquel, tu opinión...'?") — see tests/agent-runtime-action-grounding-v2.test.ts
    // for that specific regression's own coverage.
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: branding.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete brainstorm meeting");

    assert.equal(reply.debug.mutationExecuted, false, "no action may be completed on a generic-only/no match");
    assert.match(reply.reply, /don't see an open action called "brainstorm meeting"/i);
    assert.doesNotMatch(reply.reply, /did you mean/i, "a purely generic-word overlap must never produce a fabricated suggestion");

    const row = await prisma.actionItem.findUnique({ where: { id: branding.id } });
    assert.equal(row?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. generic-word-only overlap across multiple candidates asks a plain clarification, no suggestion, no mutation", async () => {
  const server = buildServer();
  const userId = `action-hardening-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    const branding = await createActionItem(userId, { source: "manual", title: "Branding direction meeting" });
    const brainstorm = await createActionItem(userId, { source: "manual", title: "Brainstorm meeting" });

    await listActions(server, userId);

    // A well-behaved planner recognizes true ambiguity and omits actionId — the shape this
    // system already handles via resolveSingleVisibleEntity's ambiguous path.
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete meeting");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /which action do you mean/i);
    assert.doesNotMatch(reply.reply, /did you mean/i);

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

test("F. an exact/named target still completes directly, no clarification needed", async () => {
  const server = buildServer();
  const userId = `action-hardening-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    const branding = await createActionItem(userId, { source: "manual", title: "Branding direction meeting" });
    await createActionItem(userId, { source: "manual", title: "Brainstorm meeting" });

    await listActions(server, userId);

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: branding.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete branding direction meeting");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /completed "branding direction meeting"/i);

    const row = await prisma.actionItem.findUnique({ where: { id: branding.id } });
    assert.equal(row?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G. a numbered target still completes the correct visible action", async () => {
  const server = buildServer();
  const userId = `action-hardening-g-${randomUUID()}`;

  try {
    await seedUser(userId);
    // getActionItems orders ties (no dueAt on any of these) by updatedAt DESC — created last so
    // it lands at position 1 in the numbered list, matching this test's own "complete 1" intent.
    await createActionItem(userId, { source: "manual", title: "Upgrade Node.js 24" });
    await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs" });
    const branding = await createActionItem(userId, { source: "manual", title: "Branding direction meeting" });

    const list = await listActions(server, userId);
    assert.match(list.reply, /1\. branding direction meeting/i);

    mockPlan({ topic: "actions", intent: "complete_numbered", operations: [op("action.complete", { actionId: branding.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete 1");

    assert.equal(reply.debug.mutationExecuted, true);
    const row = await prisma.actionItem.findUnique({ where: { id: branding.id } });
    assert.equal(row?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
