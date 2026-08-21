import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { loadContext } from "../apps/api/src/agent-runtime/context-loader.ts";
import { buildUserPayload } from "../apps/api/src/agent-runtime/planner.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/v3-action-id-boundary: closes the remaining gap the planner-context audit
 * (audit/v3-planner-context) flagged as the sharpest live risk — a planner-supplied actionId
 * trusted without enough grounding, and action.hygiene_apply silently applying valid selections
 * while dropping invalid ones instead of blocking atomically like action.complete/snooze/archive
 * already do. Most of the direct-actionId grounding this scenario set describes (validator.ts's
 * tiered title-match system) already existed going in; these tests are the regression net for it
 * plus the two real gaps this branch closes: context.openActions no longer leaks reminder
 * companions to the planner, and action.hygiene_apply now blocks atomically on any invalid index.
 */

async function seedNumberedActions(userId: string, titles: string[]): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < titles.length; i++) {
    await createActionItem(userId, { source: "manual", title: titles[i]!, dueAt: new Date(now + (i + 1) * 60 * 60 * 1000) });
  }
}

test("A: an explicit out-of-range number blocks the mutation even when the planner supplies a real background id", async () => {
  const server = buildServer();
  const userId = `action-id-boundary-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, [
      "Write 5 bullets for the YouTube script",
      "Record the intro clip",
      "Edit the B-roll",
      "Upload thumbnail draft",
      "Reply to sponsor email",
      "Set aside time each day to read",
      "Renew passport",
      "Book dentist appointment",
      "Pay Endesa bill",
      "Review PR feedback",
      "Water the plants",
      "Apply to 3 developer jobs"
    ]);
    const jobsAction = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Apply to 3 developer jobs" } });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { limit: 6 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const list = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(list.reply, /showing 6 of 12 open actions/i);
    assert.doesNotMatch(list.reply, /apply to 3 developer jobs/i, "the 12th item must not be on the 6-item page");

    // A "bad planner" that read context.backgroundOpenActions and confidently supplied the real
    // id for item 12 anyway — exactly the failure mode this branch closes.
    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: jobsAction.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete action 12");

    assert.match(reply.reply, /only showed 6 actions/i);
    assert.match(reply.reply, /1–6|1-6/);
    assert.equal(reply.debug.mutationExecuted, false);

    const stillOpen = await prisma.actionItem.findUnique({ where: { id: jobsAction.id } });
    assert.equal(stillOpen?.status, "open", "the out-of-range target must not have been mutated");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B: a direct actionId with no real title grounding is blocked, with no false \"did you mean\"", async () => {
  const server = buildServer();
  const userId = `action-id-boundary-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, ["Hola Miquel, tu opinión es muy importante para nosotros.", "Upgrade Node.js 24"]);
    const holaMiquel = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: { startsWith: "Hola Miquel" } } });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    // Bad planner: no digits, no real word overlap, but supplies a concrete (wrong) id anyway.
    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: holaMiquel.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete brainstorm meeting");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.doesNotMatch(reply.reply, /hola miquel/i, "must never suggest a candidate with zero real word overlap");
    assert.match(reply.reply, /\?/, "must ask, not silently guess");

    const stillOpen = await prisma.actionItem.findUnique({ where: { id: holaMiquel.id } });
    assert.equal(stillOpen?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C: an exact title match outside the visible page is trusted, and says so plainly", async () => {
  const server = buildServer();
  const userId = `action-id-boundary-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    const titles = ["Task A", "Task B", "Task C", "Task D", "Task E", "Task F", "Brainstorm meeting"];
    await seedNumberedActions(userId, titles);
    const brainstorm = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Brainstorm meeting" } });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { limit: 6 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const list = await sendAgentMessage(server, userId, "show me my actions");
    assert.doesNotMatch(list.reply, /brainstorm meeting/i, "must not be on the 6-item page");

    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: brainstorm.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete brainstorm meeting");

    // Pinning the existing, deliberate behavior: an exact title match outside the visible page is
    // trusted, and the reply says plainly it wasn't on the last shown page — never a plain
    // "Completed" that gives no hint the match came from outside what the user was looking at.
    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /outside your last shown list/i);

    const completed = await prisma.actionItem.findUnique({ where: { id: brainstorm.id } });
    assert.equal(completed?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D: action.hygiene_apply with one invalid index blocks the whole operation atomically", async () => {
  const server = buildServer();
  const userId = `action-id-boundary-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, ["Renew passport", "Book dentist appointment", "Pay Endesa bill", "Review PR feedback", "Water the plants", "Call the bank"]);
    const secondAction = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Book dentist appointment" } });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my actions");

    mockPlan({
      topic: "actions",
      intent: "hygiene_apply",
      operations: [
        op("action.hygiene_apply", {
          selections: [
            { index: 2, decision: "complete" },
            { index: 12, decision: "complete" }
          ]
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete 2 and 12");

    assert.equal(reply.debug.mutationExecuted, false, "no selection may apply while any index is invalid");
    assert.match(reply.reply, /12/);
    assert.match(reply.reply, /shown list|only showed/i);

    const stillOpen = await prisma.actionItem.findUnique({ where: { id: secondAction.id } });
    assert.equal(stillOpen?.status, "open", "item 2 was valid but must NOT have been applied on its own");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E: action.hygiene_apply with all-valid indexes completes exactly those items", async () => {
  const server = buildServer();
  const userId = `action-id-boundary-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNumberedActions(userId, ["Renew passport", "Book dentist appointment", "Pay Endesa bill", "Review PR feedback"]);
    const second = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Book dentist appointment" } });
    const third = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Pay Endesa bill" } });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my actions");

    mockPlan({
      topic: "actions",
      intent: "hygiene_apply",
      operations: [
        op("action.hygiene_apply", {
          selections: [
            { index: 2, decision: "complete" },
            { index: 3, decision: "complete" }
          ]
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete 2 and 3");

    assert.equal(reply.debug.mutationExecuted, true);

    const updatedSecond = await prisma.actionItem.findUnique({ where: { id: second.id } });
    const updatedThird = await prisma.actionItem.findUnique({ where: { id: third.id } });
    assert.equal(updatedSecond?.status, "completed");
    assert.equal(updatedThird?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F: reminder companions never appear in the planner's backgroundOpenActions or in visibleEntities", async () => {
  const server = buildServer();
  const userId = `action-id-boundary-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    const parent = await createActionItem(userId, { source: "manual", title: "Brainstorm meeting", dueAt: new Date(Date.now() + 60 * 60 * 1000) });
    await createActionItem(userId, {
      source: "manual",
      title: "Reminder: Brainstorm meeting",
      actionType: "reminder",
      sourceId: `pre_due_reminder:${parent.id}:30`,
      dueAt: new Date(Date.now() + 30 * 60 * 1000)
    });
    // A legacy/malformed companion: denormalized "Reminder for X" title, but neither actionType
    // nor sourceId set — isReminderCompanionAction must still catch it by title pattern alone.
    await createActionItem(userId, { source: "manual", title: "Reminder for Brainstorm meeting" });

    // context.openActions itself stays UNFILTERED (validator.ts's outside-visible-page grounding
    // still needs the full pool — see the reminder-parent-resolution regression this branch fixed
    // by moving the filter here instead). The actual boundary this task closes is what reaches the
    // planner's own payload, via buildUserPayload's backgroundOpenActions projection.
    const context = await loadContext(userId, "telegram");
    assert.ok(
      context.openActions.some((action) => action.title.toLowerCase().includes("reminder")),
      "context.openActions itself must stay unfiltered, for validator.ts's own reminder-by-name grounding"
    );

    const payload = JSON.parse(buildUserPayload("show me my actions", context)) as { context: { backgroundOpenActions: Array<{ title: string }> } };
    const backgroundTitles = payload.context.backgroundOpenActions.map((action) => action.title.toLowerCase());
    assert.ok(!backgroundTitles.some((title) => title.includes("reminder")), `backgroundOpenActions must exclude reminder companions, got: ${backgroundTitles.join(", ")}`);
    assert.ok(backgroundTitles.includes("brainstorm meeting"), "the real parent task must still be present");

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(reply.reply, /you have 1 open action/i);
    // A reminder companion is deliberately never its own numbered list entry — it may still
    // annotate its real parent's own line (e.g. "Reminder set"), which is not the bug this
    // guards against; a SECOND numbered item would be.
    assert.doesNotMatch(reply.reply, /\n2\./, "a reminder companion must never become its own numbered list entry");

    const session = await getAgentSession(userId);
    const visibleEntities = (session?.visibleEntities as Array<{ label: string }>) ?? [];
    assert.ok(
      !visibleEntities.some((entity) => entity.label.toLowerCase().includes("reminder")),
      `session.visibleEntities must exclude reminder companions, got: ${visibleEntities.map((e) => e.label).join(", ")}`
    );
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
