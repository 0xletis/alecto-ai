import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, getProactiveBriefPreferences, prisma } from "../packages/db/src/index.ts";
import { resolveProactiveBriefPreference } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";
import { pickBriefGoal } from "../apps/api/src/operator/proactive-brief-llm.ts";

/**
 * fix/private-alpha-proactive-brief-llm-personalization (Tasks 2, 3, 8, 9): durable capture and
 * retrieval of what KIND of morning/evening brief content a user asked for — "send me
 * motivational quotes every morning" must actually be remembered somewhere, not just acted on for
 * one message and forgotten. Stored as a MemoryEntry (type "proactive_brief_preference") via
 * proactive.brief_preference_apply_update; read back via getProactiveBriefPreferences +
 * resolveProactiveBriefPreference/pickBriefGoal, the exact same functions the real brief
 * personalization path (proactive-brief-llm.ts) and status (proactive.settings_show) both use.
 */

function preferencePlan(args: Record<string, unknown>) {
  return { topic: "proactive_brief_preference", intent: "update", operations: [op("proactive.brief_preference_apply_update", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("A. motivational quotes for a focused goal are stored durably, linked to that goal", async () => {
  const server = buildServer();
  const userId = `pref-motivational-goal-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");

    mockPlan(preferencePlan({ style: "motivational", contentRequest: "motivational quotes" }));
    const reply = await sendAgentMessage(server, userId, "can you send me motivational quotes every morning to help with this?");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /motivat/i);

    const preferences = await getProactiveBriefPreferences(userId);
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0]!.scope, "goal");
    assert.equal(preferences[0]!.goalId, goalResult.goal.id);
    assert.equal(preferences[0]!.style, "motivational");
    assert.equal(preferences[0]!.briefType, "morning");
    assert.equal(preferences[0]!.contentRequest, "motivational quotes");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. a reflection-prompt preference is stored", async () => {
  const server = buildServer();
  const userId = `pref-reflection-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Read more books", category: "habit" });

    mockPlan(preferencePlan({ style: "reflection", contentRequest: "a reflection prompt" }));
    await sendAgentMessage(server, userId, "give me a reflection prompt every morning");

    const preferences = await getProactiveBriefPreferences(userId);
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0]!.style, "reflection");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. a tough-love morning preference is stored", async () => {
  const server = buildServer();
  const userId = `pref-tough-love-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Apply to remote jobs", category: "career" });

    mockPlan(preferencePlan({ style: "tough_love", contentRequest: "tough love" }));
    await sendAgentMessage(server, userId, "I want tough love every morning");

    const preferences = await getProactiveBriefPreferences(userId);
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0]!.style, "tough_love");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. with no focused/nameable goal, preference is stored globally rather than silently dropped or misattached", async () => {
  const server = buildServer();
  const userId = `pref-global-${randomUUID()}`;

  try {
    await seedUser(userId);
    // Zero active goals — nothing a preference could attach to yet.

    mockPlan(preferencePlan({ style: "motivational", contentRequest: "motivational quotes" }));
    await sendAgentMessage(server, userId, "send me motivational quotes every morning");

    const preferences = await getProactiveBriefPreferences(userId);
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0]!.scope, "global");
    assert.equal(preferences[0]!.goalId, undefined);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D2. two or more active goals with no clear target asks which goal, rather than guessing", async () => {
  const server = buildServer();
  const userId = `pref-ambiguous-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
    await createGoal(userId, { title: "Apply to remote jobs", category: "career" });

    mockPlan(preferencePlan({ style: "motivational", contentRequest: "motivational quotes" }));
    const reply = await sendAgentMessage(server, userId, "send me motivational quotes every morning");

    assert.match(reply.reply, /which goal|generally/i);
    const preferences = await getProactiveBriefPreferences(userId);
    assert.equal(preferences.length, 0, "must never guess and silently attach to one of several goals");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. no action item is created from a content-preference request", async () => {
  const server = buildServer();
  const userId = `pref-no-fake-action-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");

    mockPlan(preferencePlan({ style: "motivational", contentRequest: "motivational quotes" }));
    await sendAgentMessage(server, userId, "can you send me motivational quotes every morning?");

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 0, "storing a content preference must never fabricate an action item");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. the preference survives a brand-new session and a real worker-tick-style read", async () => {
  const server = buildServer();
  const userId = `pref-survives-session-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");

    mockPlan(preferencePlan({ style: "motivational", contentRequest: "motivational quotes" }));
    await sendAgentMessage(server, userId, "send me motivational quotes every morning");
    clearAgentRuntimeMocks();
    await server.close();

    // A completely fresh server/process-equivalent read, exactly like a later worker tick would do.
    const freshPreferences = await getProactiveBriefPreferences(userId);
    assert.equal(freshPreferences.length, 1);
    assert.equal(freshPreferences[0]!.style, "motivational");

    const goal = pickBriefGoal(freshPreferences, [goalResult.goal], "morning");
    assert.equal(goal?.id, goalResult.goal.id);
    const resolved = resolveProactiveBriefPreference(freshPreferences, goal?.id, "morning");
    assert.equal(resolved?.style, "motivational");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G (3D). an unrelated goal's preference never leaks into a different goal's brief", async () => {
  const userId = `pref-leak-check-${randomUUID()}`;

  try {
    await seedUser(userId);
    const lifeGoal = await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
    const jobGoal = await createGoal(userId, { title: "Apply to remote jobs", category: "career" });
    if (lifeGoal.duplicate || jobGoal.duplicate) throw new Error("unexpected duplicate goal in eval setup");

    const server = buildServer();
    try {
      mockPlan({
        topic: "proactive_brief_preference",
        intent: "update",
        operations: [op("proactive.brief_preference_apply_update", { goalRef: "meaning", style: "motivational", contentRequest: "motivational quotes" })],
        needsClarification: false,
        clarificationQuestion: null,
        replyDraft: ""
      });
      await sendAgentMessage(server, userId, "send me motivational quotes for my life-meaning goal every morning");
    } finally {
      clearAgentRuntimeMocks();
      await server.close();
    }

    const preferences = await getProactiveBriefPreferences(userId);
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0]!.goalId, lifeGoal.goal.id);

    const pickedForJobGoal = resolveProactiveBriefPreference(preferences, jobGoal.goal.id, "morning");
    assert.equal(pickedForJobGoal, undefined, "the life-meaning goal's preference must never resolve for the job-search goal");

    const pickedForLifeGoal = resolveProactiveBriefPreference(preferences, lifeGoal.goal.id, "morning");
    assert.equal(pickedForLifeGoal?.style, "motivational");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("H (8). switching style replaces the earlier preference — no duplicate active rows for the same scope", async () => {
  const server = buildServer();
  const userId = `pref-switch-style-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");

    mockPlan(preferencePlan({ style: "motivational", contentRequest: "motivational quotes" }));
    await sendAgentMessage(server, userId, "send me motivational quotes every morning");

    mockPlan(preferencePlan({ style: "tough_love", contentRequest: "tough love" }));
    await sendAgentMessage(server, userId, "actually, give me tough love in the morning instead");

    const preferences = await getProactiveBriefPreferences(userId);
    assert.equal(preferences.length, 1, "must replace, never stack, a preference for the same goal/scope");
    assert.equal(preferences[0]!.style, "tough_love");

    const allMemories = await prisma.memoryEntry.findMany({ where: { userId, type: "proactive_brief_preference" } });
    assert.equal(allMemories.length, 2, "the old one is archived, not deleted — a real history stays inspectable");
    assert.ok(allMemories.some((memory) => memory.status === "archived"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("H2 (8A). 'stop the quotes' switches to a practical, quote-free style", async () => {
  const server = buildServer();
  const userId = `pref-stop-quotes-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");

    mockPlan(preferencePlan({ style: "motivational", contentRequest: "motivational quotes" }));
    await sendAgentMessage(server, userId, "send me motivational quotes every morning");

    mockPlan(preferencePlan({ style: "practical", contentRequest: "no quotes, keep it practical" }));
    await sendAgentMessage(server, userId, "stop the quotes");

    const preferences = await getProactiveBriefPreferences(userId);
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0]!.style, "practical");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("H3 (8D). 'make it gentler' switches to the gentle style", async () => {
  const server = buildServer();
  const userId = `pref-gentle-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");

    mockPlan(preferencePlan({ style: "tough_love", contentRequest: "tough love" }));
    await sendAgentMessage(server, userId, "give me tough love every morning");

    mockPlan(preferencePlan({ style: "gentle", contentRequest: "gentler encouragement" }));
    await sendAgentMessage(server, userId, "make it gentler");

    const preferences = await getProactiveBriefPreferences(userId);
    assert.equal(preferences.length, 1);
    assert.equal(preferences[0]!.style, "gentle");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("I (9). status shows the real content preference honestly", async () => {
  const server = buildServer();
  const userId = `pref-status-shows-${randomUUID()}`;
  const previousDelivery = process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = "true";

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");

    mockPlan(preferencePlan({ style: "motivational", contentRequest: "motivational quotes" }));
    await sendAgentMessage(server, userId, "send me motivational quotes every morning");

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "do I have morning brief on?");

    assert.match(reply.reply, /morning brief: on/i);
    assert.match(reply.reply, /style: motivational/i);
    assert.match(reply.reply, /find meaning and purpose in life/i);
  } finally {
    if (previousDelivery === undefined) delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
    else process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = previousDelivery;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("J (9B). status honestly shows no style line when no preference exists", async () => {
  const server = buildServer();
  const userId = `pref-status-none-${randomUUID()}`;
  const previousDelivery = process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = "true";

  try {
    await seedUser(userId);
    mockPlan({ topic: "settings", intent: "update", operations: [op("proactive.settings_propose_update", { morningBriefEnabled: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "turn on morning brief");
    mockPlan({ topic: "settings", intent: "confirm", operations: [op("proactive.settings_apply_update", { morningBriefEnabled: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "yes");

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what proactive messages are on?");

    assert.match(reply.reply, /morning brief: on/i);
    assert.doesNotMatch(reply.reply, /style:/i, "no preference exists yet — status must never fabricate one");
  } finally {
    if (previousDelivery === undefined) delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
    else process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = previousDelivery;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
