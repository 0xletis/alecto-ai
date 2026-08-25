import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/v3-action-reschedule-grounding: closes the one remaining must-fix gap the global
 * mutating-tool-boundaries audit found — action.reschedule's own actionId field never got the
 * same tiered title-grounding action.complete/snooze/archive already have, and had no equivalent
 * of their explicit-numbered-index protection either (it has no `index` field of its own). Both
 * are now handled by validator.ts's new resolveExplicitRescheduleIndexReference (numbered refs,
 * atomic block on an out-of-range number) and applyDirectActionIdTrust (reused, not duplicated,
 * from action.complete/snooze/archive's own grounding), while action.reschedule's existing
 * ref-based resolver (resolveActionRef, which searches both visible and background actions by
 * name) is left completely untouched for the "no actionId at all" case.
 */

async function seedNumberedActions(userId: string, titles: string[]): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < titles.length; i++) {
    await createActionItem(userId, { source: "manual", title: titles[i]!, dueAt: new Date(now + (i + 1) * 60 * 60 * 1000) });
  }
}

test("A: a directly-supplied actionId with only generic word overlap is blocked, not rescheduled", async () => {
  const server = buildServer();
  const userId = `reschedule-grounding-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, ["Branding direction meeting", "Write YouTube bullets"]);
    const branding = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Branding direction meeting" } });
    const originalDueAt = branding.dueAt?.toISOString();

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    // Bad planner: "meeting" is the only shared word — generic, never real grounding evidence.
    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { actionId: branding.id, dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "move brainstorm meeting to tomorrow");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.doesNotMatch(reply.reply, /branding direction/i, "must never silently reschedule the wrong meeting based only on a generic word match");

    const stillOriginal = await prisma.actionItem.findUnique({ where: { id: branding.id } });
    assert.equal(stillOriginal?.dueAt?.toISOString(), originalDueAt, "the due date must be completely unchanged");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B: an exact ref-based reschedule still works, unaffected by the new grounding", async () => {
  const server = buildServer();
  const userId = `reschedule-grounding-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, ["Branding direction meeting", "Write YouTube bullets"]);

    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { ref: "branding direction meeting", dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "move branding direction meeting to tomorrow");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /Action rescheduled: Branding direction meeting/i);
    assert.doesNotMatch(reply.reply, /\?/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C: a numbered reschedule resolves against the visible list, not DB order", async () => {
  const server = buildServer();
  const userId = `reschedule-grounding-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, ["Renew passport", "Book dentist appointment", "Pay Endesa bill"]);
    const second = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Book dentist appointment" } });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    // A bad planner might supply ANY actionId alongside the number — the explicit index must
    // always win, ignoring whatever actionId came along with it.
    const third = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Pay Endesa bill" } });
    const thirdOriginalDueAt = third.dueAt?.toISOString();
    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { actionId: third.id, dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "push task 2 to tomorrow");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /Action rescheduled: Book dentist appointment/i, "the explicit '2' must win over whatever actionId the planner separately supplied");

    const untouchedThird = await prisma.actionItem.findUnique({ where: { id: third.id } });
    assert.equal(untouchedThird?.dueAt?.toISOString(), thirdOriginalDueAt, "item 3 (what the bad actionId pointed to) must be completely untouched");
    const rescheduledSecond = await prisma.actionItem.findUnique({ where: { id: second.id } });
    assert.notEqual(rescheduledSecond?.dueAt?.toISOString(), second.dueAt?.toISOString(), "item 2 must be the one actually rescheduled");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D: an out-of-range numbered reschedule blocks atomically", async () => {
  const server = buildServer();
  const userId = `reschedule-grounding-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, ["Renew passport", "Book dentist appointment", "Pay Endesa bill", "Review PR feedback", "Water the plants", "Call the bank"]);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const list = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(list.reply, /you have 6 open actions/i);

    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "move 12 to tomorrow");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /only showed 6 actions/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E: an ambiguous generic reference asks instead of guessing, no mutation", async () => {
  const server = buildServer();
  const userId = `reschedule-grounding-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, ["Branding direction meeting", "Brainstorm meeting"]);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { ref: "meeting", dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "move meeting to tomorrow");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /\?/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F: a bare pronoun reschedules the one visible action, but asks when more than one is visible", async () => {
  const serverSingle = buildServer();
  const userIdSingle = `reschedule-grounding-f-single-${randomUUID()}`;

  try {
    await seedUser(userIdSingle);
    await seedNumberedActions(userIdSingle, ["Brainstorm meeting"]);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(serverSingle, userIdSingle, "show me my actions");

    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    // "reschedule it," not "move it" — fix/private-alpha-action-temporal-coaching's own new
    // ACTION_SNOOZE_PATTERN deterministic shortcut now intercepts a bare "move it to tomorrow"
    // as a DEFERRAL (action.snooze) by deliberate design, ahead of the mocked planner entirely;
    // this test is specifically about action.reschedule's OWN bare-pronoun resolution, so it
    // needs wording that doesn't collide with that newer, more specific shortcut.
    const reply = await sendAgentMessage(serverSingle, userIdSingle, "reschedule it to tomorrow");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /Action rescheduled: Brainstorm meeting/i);
  } finally {
    clearAgentRuntimeMocks();
    await serverSingle.close();
    await prisma.user.deleteMany({ where: { id: userIdSingle } });
  }

  const serverMulti = buildServer();
  const userIdMulti = `reschedule-grounding-f-multi-${randomUUID()}`;

  try {
    await seedUser(userIdMulti);
    await seedNumberedActions(userIdMulti, ["Brainstorm meeting", "Write YouTube bullets"]);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(serverMulti, userIdMulti, "show me my actions");

    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(serverMulti, userIdMulti, "move it to tomorrow");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /\?/);
  } finally {
    clearAgentRuntimeMocks();
    await serverMulti.close();
    await prisma.user.deleteMany({ where: { id: userIdMulti } });
  }
});

test("G: a directly-supplied actionId for an out-of-range number is blocked, ignoring an otherwise-exact title match outside the page", async () => {
  const server = buildServer();
  const userId = `reschedule-grounding-g-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, [
      "Write 5 bullets for the YouTube script",
      "Record the intro clip",
      "Edit the B-roll",
      "Upload thumbnail draft",
      "Reply to sponsor email",
      "Set aside time each day to read",
      "Apply to jobs"
    ]);
    const applyToJobs = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Apply to jobs" } });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { limit: 6 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const list = await sendAgentMessage(server, userId, "show me my actions");
    assert.doesNotMatch(list.reply, /apply to jobs/i, "the 7th item must not be on the 6-item page");

    // Even though "action 12 to tomorrow" contains no words that would exact/word-exact match
    // "Apply to jobs" anyway, the point is the explicit index check must gate this BEFORE any
    // title-grounding fallback is even considered — a real reported bug shape for actions was
    // exactly this: an out-of-range number silently resolving via a background/outside-page path.
    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { actionId: applyToJobs.id, dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "move action 12 to tomorrow");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /only showed 6 actions/i);

    const stillUntouched = await prisma.actionItem.findUnique({ where: { id: applyToJobs.id } });
    assert.ok(stillUntouched, "the out-of-range target must not have been mutated");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
