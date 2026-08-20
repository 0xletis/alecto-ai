import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import {
  buildServer,
  clearAgentRuntimeMocks,
  getAgentSession,
  mockGuardrail,
  mockPlan,
  op,
  prisma,
  sendAgentMessage,
  seedUser,
  type MockGuardrailClassification,
  type MockPlan
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Goal Conversation Reliability pass — a second real Telegram smoke test, after two goals existed
 * (a just-created "Finish reading Meditations by Marcus Aurelius" and an older "Finish reading
 * Nietzsche book"), found: (1) after the bot correctly showed tracking for the Nietzsche goal, the
 * very next progress report ("i didnt finish it but i read 30min today") got intercepted by the
 * goal-aligned guardrail, misclassified as a "lapse" against MEDITATIONS — the wrong goal, since
 * the guardrail's own LLM tier has nothing telling it which goal the conversation is actually
 * about, and picked whichever goal it was handed; (2) a legitimate partial-progress report was
 * called "avoidance"/"lapse" at all, when it's ordinary evidence goal.log_evidence exists to
 * capture; (3) a completion-only signal on a freshly proposed book goal (only "Meditations
 * finished") gave nothing to log partial progress against in the first place.
 *
 * This suite proves: a new session.focusedEntities slot (see types.ts) makes "the goal we were
 * just talking about" — not merely "the newest goal that exists" — win pronoun/pattern
 * resolution and survive across turns; goal-guardrails.ts's new looksLikeProgressReport
 * pre-filter keeps quantified activity reports and explicit "log it" phrasing out of the LLM
 * classification tier entirely, so they can never be misclassified as avoidance/lapse (while a
 * genuinely non-progress message still reaches the guardrail as before); and
 * ensureBookGoalProgressSignal deterministically adds a progress signal to a completion-only
 * book/reading proposal.
 */

function meditationsGoalPlan(): MockPlan["operations"] {
  return [
    op("goal.create_propose", {
      title: "Finish reading Meditations by Marcus Aurelius",
      category: "reading",
      why: "I want to complete my current reading material",
      signals: [{ key: "meditations_finished", label: "Meditations finished", cadence: "weekly" }],
      checkIn: { cadence: "daily", question: "Did you read today?" },
      firstActions: ["Read for 20 minutes daily"]
    })
  ];
}

function nietzscheGoalPlan(): MockPlan["operations"] {
  return [
    op("goal.create_propose", {
      title: "Finish reading Nietzsche book",
      category: "reading",
      why: "I want to complete my current reading material",
      signals: [{ key: "book_nietzsche_finished", label: "Nietzsche book finished", cadence: "weekly" }],
      checkIn: { cadence: "weekly", question: "Did you finish reading your Nietzsche book?" }
    })
  ];
}

function classification(overrides: Partial<MockGuardrailClassification> & Pick<MockGuardrailClassification, "conflict">): MockGuardrailClassification {
  return { goalId: null, pattern: null, clarifyingQuestion: null, reason: "test", ...overrides };
}

test("1. the exact reported transcript: focus follows what was shown, not what was newest, and partial progress is logged and counted against it", async () => {
  const server = buildServer();
  const userId = `goal-conv-transcript-${randomUUID()}`;

  try {
    await seedUser(userId);

    // Meditations is created FIRST — it would be the newest goal by creation time.
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: meditationsGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to end meditations by marco aurelio book");
    const meditationsApply = await sendAgentMessage(server, userId, "yes");
    assert.match(meditationsApply.reply, /meditations finished/i);
    // The book-goal signal injection should have added a progress signal even though the proposal
    // only asked for a completion signal — proven again more directly in test 6 below.
    assert.match(meditationsApply.reply, /reading minutes/i);

    // Nietzsche is seeded SECOND directly (bypassing goal.create_propose/apply, which would now
    // correctly add a progress signal itself) so it stays completion-only — matching the real
    // pre-existing goal from the reported transcript, which predates this fix. It becomes the
    // newest goal by creation time, which is exactly what must NOT decide focus here.
    await seedCompletionOnlyGoal(userId, "Finish reading Nietzsche book", "reading", "book_nietzsche_finished");

    // The user then asks about Nietzsche specifically — this is what sets conversational focus.
    mockPlan({ topic: "goals", intent: "show_tracking", operations: [op("goal.tracking_show", { goalRef: "reading niezsche book" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const trackingReply = await sendAgentMessage(server, userId, "show tracking for reading niezsche book");
    assert.match(trackingReply.reply, /finish reading nietzsche book/i);

    const sessionAfterTracking = await getAgentSession(userId);
    const focusAfterTracking = sessionAfterTracking?.focusedEntities as Record<string, { label: string }> | null;
    assert.equal(focusAfterTracking?.goal?.label, "Finish reading Nietzsche book", "showing tracking for Nietzsche must set it as the current goal focus");

    // The Nietzsche goal only declares a completion signal — logging "30 minutes" against it has
    // no direct key match, so this proves the compatible-progress-signal fallback: since goalRef
    // is omitted, the executor must fall back to the CURRENT FOCUS (Nietzsche), not the newest
    // goal (Meditations), and Nietzsche has no progress signal of its own, so this should ask
    // rather than silently mislog — proving problems 1-4 are fixed together.
    mockPlan({
      topic: "goal_evidence",
      intent: "log_evidence",
      operations: [op("goal.log_evidence", { signalKey: "reading_minutes", count: 30 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Logged it."
    });
    const logAttempt = await sendAgentMessage(server, userId, "i didnt finish it but i read 30min today");
    assert.doesNotMatch(logAttempt.reply, /avoidance|lapse/i, "a partial progress report must never be described as avoidance or a lapse");
    assert.doesNotMatch(logAttempt.reply, /meditations/i, "the log attempt must never silently target the newest goal instead of the focused one");
    assert.match(logAttempt.reply, /nietzsche/i, "an honest response about the Nietzsche goal specifically — it has no progress signal, so this should ask rather than fabricate a log");
    assert.equal(logAttempt.debug.mutationExecuted, false, "nothing should be written when there is no compatible signal to log against");

    const meditationsEvents = await prisma.event.findMany({ where: { userId } });
    assert.ok(
      !meditationsEvents.some((event) => (event.data as { signalKey?: string } | null)?.signalKey === "meditations_finished"),
      "the Meditations goal must never receive evidence from a message that was never about it"
    );
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. once the focused goal actually has a progress signal, an omitted goalRef still logs against the focused goal, not the newest one", async () => {
  const server = buildServer();
  const userId = `goal-conv-focus-log-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: meditationsGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to end meditations by marco aurelio book");
    await sendAgentMessage(server, userId, "yes");

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: nietzscheGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to finish my Nietzsche book");
    await sendAgentMessage(server, userId, "yes");

    // Focus Meditations (its own goal, and it DOES have a progress signal from the injection).
    mockPlan({ topic: "goals", intent: "show_tracking", operations: [op("goal.tracking_show", { goalRef: "meditations" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show tracking for meditations");

    // Nietzsche was created MORE RECENTLY than this focus-setting turn, so a naive "newest goal"
    // fallback would wrongly pick Nietzsche here — focus must win.
    mockPlan({
      topic: "goal_evidence",
      intent: "log_evidence",
      operations: [op("goal.log_evidence", { signalKey: "reading_minutes", count: 20 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "read 20 minutes today");

    assert.match(reply.reply, /20 reading minutes/i);
    assert.match(reply.reply, /counts toward your "finish reading meditations by marcus aurelius" goal/i);
    assert.equal(reply.debug.mutationExecuted, true);

    const events = await prisma.event.findMany({ where: { userId, type: "custom.goal_progress_logged" } });
    assert.equal(events.length, 20, "one grounded event per minute counted, matching how other count-based logging already works");
    // The LLM's generic "reading_minutes" guess must have been remapped to the goal's OWN real
    // (title-derived, unique) key — never stored under the literal guessed key, which no goal
    // actually declares.
    assert.ok(events.every((event) => (event.data as { signalKey?: string }).signalKey?.endsWith("reading_minutes") && (event.data as { signalKey?: string }).signalKey !== "reading_minutes"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. a quantified progress report is never blocked by the guardrail, even when a bad classification against the wrong goal is mocked", async () => {
  const server = buildServer();
  const userId = `goal-conv-guardrail-exempt-${randomUUID()}`;

  try {
    await seedUser(userId);
    const meditations = await seedCompletionOnlyGoal(userId, "Finish reading Meditations by Marcus Aurelius", "reading", "meditations_finished");
    await createGoal(userId, {
      title: "Finish reading Nietzsche book",
      category: "reading",
      targetMetrics: [{ key: "book_nietzsche_finished", label: "Nietzsche book finished", signalKey: "book_nietzsche_finished", aggregation: "count", window: "weekly" }]
    });

    // Deliberately the exact wrong-goal misclassification the real smoke test hit — if the
    // exemption below didn't work, this mock would cause a hard block/soft warn against
    // Meditations, proving the guardrail's LLM tier was never even reached.
    mockGuardrail(classification({ conflict: "soft_warn", goalId: meditations.id, pattern: "lapse_admission" }));
    const reply = await sendAgentMessage(server, userId, "i didnt finish it but i read 30min today");

    assert.doesNotMatch(reply.reply, /lapse|avoidance|meditations/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. 'log it' is exempted from the guardrail the same way", async () => {
  const server = buildServer();
  const userId = `goal-conv-guardrail-logit-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedCompletionOnlyGoal(userId, "Finish reading Nietzsche book", "reading", "book_nietzsche_finished");

    mockGuardrail(classification({ conflict: "soft_warn", goalId: goal.id, pattern: "avoidance" }));
    mockPlan({ topic: "goal_evidence", intent: "log_evidence", operations: [], needsClarification: false, clarificationQuestion: null, replyDraft: "Got it." });
    const reply = await sendAgentMessage(server, userId, "log it");

    assert.doesNotMatch(reply.reply, /avoidance/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. a genuinely non-progress message still reaches the guardrail and can be blocked", async () => {
  const server = buildServer();
  const userId = `goal-conv-guardrail-still-fires-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedCompletionOnlyGoal(userId, "Stop gambling", "wellbeing", "gambling_free_days");

    mockGuardrail(classification({ conflict: "hard_block", goalId: goal.id, pattern: "active_violation" }));
    const reply = await sendAgentMessage(server, userId, "I want to bet 1000 because it's safe");

    assert.match(reply.reply, /conflicts with your goal to stop gambling/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. a completion-only book goal proposal gets a generic progress signal added, not only completion", async () => {
  const server = buildServer();
  const userId = `goal-conv-signal-injection-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: meditationsGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const proposeReply = await sendAgentMessage(server, userId, "I want to end meditations by marco aurelio book");
    assert.match(proposeReply.reply, /meditations finished/i);
    assert.match(proposeReply.reply, /reading minutes/i, "the proposal itself must show a progress signal, not only completion, even though only completion was asked for");

    await sendAgentMessage(server, userId, "yes");

    const goal = await prisma.goal.findFirst({ where: { userId, title: "Finish reading Meditations by Marcus Aurelius" } });
    const metrics = goal?.targetMetrics as Array<{ signalKey?: string }> | null;
    assert.ok(metrics?.some((metric) => metric.signalKey?.endsWith("reading_minutes")), "a generic progress signal must be stored on the goal itself");
    assert.ok(metrics?.some((metric) => metric.signalKey === "meditations_finished"), "the originally requested completion signal must still be kept");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. an ambiguous reference resolves to the current focus instead of asking, when the focus is one of the tied candidates", async () => {
  const server = buildServer();
  const userId = `goal-conv-ambiguous-focus-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Read more", category: "learning", templateId: "learning.reading_more" });
    await createGoal(userId, {
      title: "Read the Bible",
      category: "faith",
      targetMetrics: [{ key: "bible_chapters_weekly", label: "chapters read", signalKey: "bible_chapters", aggregation: "count", window: "weekly" }]
    });

    // Establish focus on "Read the Bible" specifically first.
    mockPlan({ topic: "goals", intent: "show_tracking", operations: [op("goal.tracking_show", { goalRef: "bible" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show tracking for the bible goal");

    // "read" alone is ambiguous between the two — but the focused goal should win without asking.
    mockPlan({ topic: "goals", intent: "show_tracking", operations: [op("goal.tracking_show", { goalRef: "read" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show tracking for read");

    assert.doesNotMatch(reply.reply, /do you mean/i);
    assert.match(reply.reply, /read the bible/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8. an existing completion-only goal with an incompatible progress report is offered a progress signal, never silently dropped", async () => {
  const server = buildServer();
  const userId = `goal-conv-ask-to-add-signal-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedCompletionOnlyGoal(userId, "Finish reading Nietzsche book", "reading", "book_nietzsche_finished");

    mockPlan({
      topic: "goal_evidence",
      intent: "log_evidence",
      operations: [op("goal.log_evidence", { signalKey: "reading_minutes", count: 30, goalRef: "nietzsche" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Logged 30 minutes toward your Nietzsche book."
    });
    const reply = await sendAgentMessage(server, userId, "i read 30 minutes of my nietzsche book");

    assert.doesNotMatch(reply.reply, /logged 30 minutes/i, "a failed log must never surface the planner's pre-execution replyDraft as a false success");
    assert.match(reply.reply, /finish reading nietzsche book/i);
    assert.match(reply.reply, /only tracks completion|add a progress signal/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

/** Seeds a goal with a completion-only signal directly via createGoal, bypassing
 * goal.create_propose/create_apply's own progress-signal injection — representing a goal that
 * predates this fix (like the real one in the reported transcript), not a freshly (and now
 * correctly) proposed one. `label` is caller-supplied and deliberately plain ("<title> done") so
 * it can never accidentally look progress-shaped itself. */
async function seedCompletionOnlyGoal(userId: string, title: string, category: string, signalKey: string, label = "marked done") {
  const result = await createGoal(userId, {
    title,
    category,
    targetMetrics: [{ key: signalKey, label, signalKey, aggregation: "count", window: "weekly" }]
  });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}
