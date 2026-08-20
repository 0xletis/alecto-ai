import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, sendAgentMessage, seedUser, prisma, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Goal Reference Fix pass — a real Telegram smoke test found that once a user has more than one
 * active goal, follow-ups naming a SPECIFIC goal ("show tracking for reading niezsche book", "how
 * is my nitzche book goal going") kept resolving to an older, generic, same-category goal ("Read
 * more") instead — because goal.status/goal.tracking_show's reference matching reused
 * goal-linking.ts's inferGoalLinkForAction, a coarse category-bucket matcher built for a different
 * job (deciding which goal's general DOMAIN a newly logged ACTION belongs to), which has no typo
 * tolerance and lets a generic category match outscore a specific, exactly-named goal. This suite
 * proves the fix: a new, separate resolver (goal-reference.ts's resolveActiveGoalReference) that
 * prefers specific/distinctive matches over generic ones, tolerates common misspellings of a
 * proper noun generically (not a hardcoded "Nietzsche" branch), asks for clarification instead of
 * guessing when genuinely ambiguous, and is wired into goal.status/goal.tracking_show/
 * goal.log_evidence uniformly. It also proves evidence logged right after creating a goal is
 * counted by goal.status for THAT goal, not silently lost or attributed elsewhere.
 */

async function seedGenericReadingGoal(userId: string) {
  const result = await createGoal(userId, { title: "Read more", category: "learning", templateId: "learning.reading_more" });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

function nietzscheBookGoalPlan(): MockPlan["operations"] {
  return [
    op("goal.create_propose", {
      title: "Finish reading Nietzsche book",
      category: "learning",
      signals: [
        { key: "reading_minutes", label: "reading minutes", unit: "minutes", cadence: "daily" },
        { key: "book_finished", label: "Nietzsche book finished", cadence: "weekly" }
      ],
      checkIn: { cadence: "weekly", question: "Did you finish reading your Nietzsche book?" },
      firstActions: ["Set aside time each day to read"]
    })
  ];
}

test("1. new specific book goal beats an older generic reading goal, typos and all, and its own evidence is counted by status", async () => {
  const server = buildServer();
  const userId = `goal-ref-nietzsche-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGenericReadingGoal(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: nietzscheBookGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to end my Nietsche book");
    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.match(confirmReply.reply, /finish reading nietzsche book/i);

    const nietzscheGoal = await prisma.goal.findFirst({ where: { userId, title: "Finish reading Nietzsche book" } });
    assert.ok(nietzscheGoal, "the new book goal must be a real Goal row");

    // "niezsche" (transposed) is a typo of "Nietzsche" — must resolve to the specific book goal,
    // never the older, unrelated-by-name "Read more" goal, despite both being "learning" category.
    mockPlan({ topic: "goals", intent: "show_tracking", operations: [op("goal.tracking_show", { goalRef: "reading niezsche book" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const trackingReply = await sendAgentMessage(server, userId, "show tracking for reading niezsche book");
    assert.match(trackingReply.reply, /finish reading nietzsche book/i);
    assert.doesNotMatch(trackingReply.reply, /^"read more"/i);
    assert.match(trackingReply.reply, /reading_minutes|reading minutes/i);

    mockPlan({ topic: "goal_evidence", intent: "log_evidence", operations: [op("goal.log_evidence", { signalKey: "reading_minutes", count: 5 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const logReply = await sendAgentMessage(server, userId, "read 5 minutes");
    assert.match(logReply.reply, /5 reading minutes/i);
    assert.match(logReply.reply, /counts toward your "finish reading nietzsche book" goal/i);

    const events = await prisma.event.findMany({ where: { userId, type: "custom.goal_progress_logged" } });
    assert.equal(events.length, 5);
    assert.ok(events.every((event) => (event.data as { signalKey?: string })?.signalKey === "reading_minutes"));

    // "nitzche" (missing letter) is a second, different typo of "Nietzsche" — must still resolve
    // to the same specific goal, and the 5 minutes just logged must show up as real progress.
    mockPlan({ topic: "goal_evidence", intent: "goal_status", operations: [op("goal.status", { goalRef: "my nitzche book goal" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const statusReply = await sendAgentMessage(server, userId, "how is my nitzche book goal goin");
    assert.match(statusReply.reply, /finish reading nietzsche book/i);
    assert.match(statusReply.reply, /5 reading minutes/i);
    assert.doesNotMatch(statusReply.reply, /no logged progress/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. a third misspelling of the same proper noun still resolves unambiguously", async () => {
  const server = buildServer();
  const userId = `goal-ref-typo-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGenericReadingGoal(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: nietzscheBookGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to finish my Nietzsche book");
    await sendAgentMessage(server, userId, "yes");

    mockPlan({ topic: "goals", intent: "show_tracking", operations: [op("goal.tracking_show", { goalRef: "my Nietsche book" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show tracking for my Nietsche book");

    assert.match(reply.reply, /finish reading nietzsche book/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. an ambiguous reference asks which goal instead of picking one", async () => {
  const server = buildServer();
  const userId = `goal-ref-ambiguous-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGenericReadingGoal(userId);
    const bibleResult = await createGoal(userId, {
      title: "Read the Bible",
      category: "faith",
      targetMetrics: [{ key: "bible_chapters_weekly", label: "chapters read", signalKey: "bible_chapters", aggregation: "count", window: "weekly" }]
    });
    if (bibleResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({ topic: "goals", intent: "show_tracking", operations: [op("goal.tracking_show", { goalRef: "read" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show tracking for read");

    assert.match(reply.reply, /do you mean/i);
    assert.match(reply.reply, /read more/i);
    assert.match(reply.reply, /read the bible/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. a newly created goal is immediately visible for a pronoun follow-up, even with an older goal active", async () => {
  const server = buildServer();
  const userId = `goal-ref-visible-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGenericReadingGoal(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: nietzscheBookGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to finish my Nietzsche book");
    const applyReply = await sendAgentMessage(server, userId, "yes");

    const session = await getAgentSession(userId);
    const visibleEntities = session?.visibleEntities as Array<{ type: string; label: string }> | null;
    assert.ok(visibleEntities?.some((entity) => entity.type === "goal" && entity.label === "Finish reading Nietzsche book"), "the new goal must be added to session visible entities right after creation");
    assert.equal(applyReply.debug.mutationExecuted, true);

    mockPlan({ topic: "goals", intent: "show_tracking", operations: [op("goal.tracking_show", { goalRef: "it" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show tracking for it");

    assert.match(reply.reply, /finish reading nietzsche book/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. a nonexistent event type is refused honestly, never claimed as logged", async () => {
  const server = buildServer();
  const userId = `goal-ref-invalid-event-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGenericReadingGoal(userId);

    mockPlan({ topic: "goal_evidence", intent: "log_evidence", operations: [op("goal.log_evidence", { eventType: "learning.made_up_thing_that_does_not_exist" })], needsClarification: false, clarificationQuestion: null, replyDraft: "I've logged that." });
    const reply = await sendAgentMessage(server, userId, "read for a while");

    assert.doesNotMatch(reply.reply, /i've logged/i, "a failed tool call must never surface the planner's pre-execution replyDraft as if it succeeded");
    assert.match(reply.reply, /isn't a real event type/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. an adaptive book-goal plan can carry both an ongoing progress signal and a completion signal, and status reports both", async () => {
  const server = buildServer();
  const userId = `goal-ref-book-plan-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: nietzscheBookGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const proposeReply = await sendAgentMessage(server, userId, "I want to end my Nietsche book");
    assert.match(proposeReply.reply, /reading minutes/i);
    assert.match(proposeReply.reply, /nietzsche book finished/i);

    await sendAgentMessage(server, userId, "yes");

    const goal = await prisma.goal.findFirst({ where: { userId, title: "Finish reading Nietzsche book" } });
    const metrics = goal?.targetMetrics as Array<{ signalKey?: string }> | null;
    assert.ok(metrics?.some((metric) => metric.signalKey === "reading_minutes"), "an ongoing progress signal must be stored, not only a completion signal");
    assert.ok(metrics?.some((metric) => metric.signalKey === "book_finished"), "the completion signal must also be stored");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
