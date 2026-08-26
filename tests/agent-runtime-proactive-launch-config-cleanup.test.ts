import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma, selfHealDailyLoopEnabled, updateNotificationSettings } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";
import { runV3ProactiveMorningBriefs } from "../apps/worker/src/v3-proactive-delivery.ts";

/**
 * Launch-readiness cleanup for the two remaining proactive-delivery footguns found while
 * verifying the previous fix (fix/private-alpha-proactive-checkins-and-overdue-action-ux) end to
 * end (fix/private-alpha-proactive-launch-config-cleanup):
 *
 * 1. An EXISTING user who opted into morning/evening BEFORE that fix existed is still stuck with
 *    dailyLoopEnabled=false forever — the fix only auto-heals on a FRESH toggle, never retroactively.
 * 2. PROACTIVE_OPERATOR_DELIVERY_ENABLED being off makes settings say "on" while nothing sends —
 *    kept as a real, intentional rollout gate (never removed or defaulted on), but the status copy
 *    now clearly distinguishes "configured on" from "will actually deliver."
 */

async function seedMadridUser(userId: string, overrides: Partial<{ telegramUserId: string }> = {}): Promise<void> {
  await seedUser(userId);
  await updateNotificationSettings(userId, { timezone: "Europe/Madrid", ...overrides });
}

function injectApiGet(server: ReturnType<typeof buildServer>) {
  return async <T>(path: string): Promise<T> => {
    const response = await server.inject({ method: "GET", url: path });
    if (response.statusCode !== 200) {
      throw new Error(`GET ${path} failed with ${response.statusCode}: ${response.body}`);
    }
    return response.json() as T;
  };
}

// --- Task 1: dailyLoopEnabled self-heal --------------------------------------------------------

test("1A: morningBriefEnabled true + dailyLoopEnabled false self-heals via the status command", async () => {
  const server = buildServer();
  const userId = `launchconfig-1a-${randomUUID()}`;
  const previous = process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = "true";
  try {
    await seedMadridUser(userId);
    // Simulates a PRE-FIX stale user: opted into morning brief before the tool that turns it on
    // also started setting dailyLoopEnabled.
    await updateNotificationSettings(userId, { morningBriefEnabled: true, dailyLoopEnabled: false });

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what proactive messages are on?");

    assert.doesNotMatch(reply.reply, /blocked — internal daily loop is off/i, "must have self-healed rather than still reporting blocked");
    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.dailyLoopEnabled, true, "dailyLoopEnabled must be repaired in the DB by simply asking, not just in the one reply");
  } finally {
    if (previous === undefined) delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
    else process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = previous;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1B: eveningCheckinEnabled true + dailyLoopEnabled false self-heals via the status command", async () => {
  const server = buildServer();
  const userId = `launchconfig-1b-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await updateNotificationSettings(userId, { eveningCheckinEnabled: true, dailyLoopEnabled: false });

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what proactive messages are on?");

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.dailyLoopEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1C: both morning/evening false + dailyLoopEnabled false remains false (nothing to heal)", async () => {
  const server = buildServer();
  const userId = `launchconfig-1c-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await updateNotificationSettings(userId, { morningBriefEnabled: false, eveningCheckinEnabled: false, dailyLoopEnabled: false });

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what proactive messages are on?");

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.dailyLoopEnabled, false, "nothing to self-heal when neither moment is opted in");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1D: self-heal never accidentally opts a user into morning/evening — only aligns dailyLoopEnabled", async () => {
  const userId = `launchconfig-1d-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await updateNotificationSettings(userId, { morningBriefEnabled: true, eveningCheckinEnabled: false, dailyLoopEnabled: false });
    const before = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.ok(before);

    const healed = await selfHealDailyLoopEnabled(before!);

    assert.equal(healed.dailyLoopEnabled, true);
    assert.equal(healed.morningBriefEnabled, true, "unchanged — was already true");
    assert.equal(healed.eveningCheckinEnabled, false, "self-heal must never turn evening check-in ON as a side effect");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1D2: turning morning/evening OFF never disables dailyLoopEnabled as a side effect", async () => {
  const server = buildServer();
  const userId = `launchconfig-1d2-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await updateNotificationSettings(userId, { morningBriefEnabled: true, dailyLoopEnabled: true });

    mockPlan({ topic: "settings", intent: "update", operations: [op("proactive.settings_propose_update", { morningBriefEnabled: false })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "turn off morning brief");
    mockPlan({ topic: "settings", intent: "confirm", operations: [op("proactive.settings_apply_update", { morningBriefEnabled: false })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "yes");

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.morningBriefEnabled, false);
    assert.equal(updated?.dailyLoopEnabled, true, "dailyLoopEnabled must survive turning morning brief off — the legacy daily loop may still depend on it independently");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1E: the worker actually delivers after self-heal, at the real scheduled tick", async () => {
  const server = buildServer();
  const userId = `launchconfig-1e-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:900001" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    // Same PRE-FIX stale state as 1A, but exercised through the worker's own send path rather
    // than the status command — the two self-heal call sites must agree.
    await updateNotificationSettings(userId, { morningBriefEnabled: true, dailyLoopEnabled: false, morningTimeMinutes: 540 });
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });

    const sent: Array<{ chatId: string; text: string }> = [];
    await runV3ProactiveMorningBriefs([settings as any], {
      now: new Date("2026-08-27T07:00:00Z"), // 09:00 Europe/Madrid
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text })
    });

    assert.equal(sent.length, 1, "the stale user must actually receive the morning brief now, not just get a repaired DB row with nothing delivered");
    assert.equal(sent[0]!.chatId, "telegram:900001");

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.dailyLoopEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 2: PROACTIVE_OPERATOR_DELIVERY_ENABLED behavior ---------------------------------------

test("2B: dev/test can still disable delivery safely — env unset means nothing sends, unchanged", async () => {
  const server = buildServer();
  const userId = `launchconfig-2b-${randomUUID()}`;
  const previous = process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:900002" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await updateNotificationSettings(userId, { morningBriefEnabled: true, dailyLoopEnabled: true, morningTimeMinutes: 540 });
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });

    const sent: Array<{ chatId: string; text: string }> = [];
    await runV3ProactiveMorningBriefs([settings as any], {
      now: new Date("2026-08-27T07:00:00Z"),
      // Deliberately NOT passing deliveryEnabled: true — relies on the real env, which is unset.
      apiGet: injectApiGet(server),
      sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text })
    });

    assert.equal(sent.length, 0, "the env gate must still genuinely block delivery when unset — this task keeps it, never removes or defaults it on");
  } finally {
    if (previous === undefined) delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
    else process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = previous;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C/4A/4B: status distinguishes 'configured on' from 'will actually deliver' — never a bare misleading 'on'", async () => {
  const server = buildServer();
  const userId = `launchconfig-2c-${randomUUID()}`;
  const previous = process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  try {
    await seedMadridUser(userId);
    await updateNotificationSettings(userId, { morningBriefEnabled: true, dailyLoopEnabled: true });

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what proactive messages are on?");

    assert.match(reply.reply, /morning brief: configured on, but delivery is disabled on this server/i);
    // Task 4B: never the old, misleading "on, around HH:MM" alongside a blocked reason — "on"
    // alone implies it will actually happen.
    assert.doesNotMatch(reply.reply, /morning brief: on, around/i);
  } finally {
    if (previous === undefined) delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
    else process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = previous;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D/4C: worker and API agree on eligibility — status shows eligible exactly when the worker would actually send", async () => {
  const server = buildServer();
  const userId = `launchconfig-2d-${randomUUID()}`;
  const previous = process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = "true";
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:900003" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await updateNotificationSettings(userId, { morningBriefEnabled: true, dailyLoopEnabled: true, morningTimeMinutes: 540 });

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const statusReply = await sendAgentMessage(server, userId, "what proactive messages are on?");
    assert.match(statusReply.reply, /morning brief: on, around 09:00 — next due: (today|tomorrow) 09:00/i, "status reports eligible with a real next-due time");

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    const sent: Array<{ chatId: string; text: string }> = [];
    await runV3ProactiveMorningBriefs([settings as any], {
      now: new Date("2026-08-27T07:00:00Z"),
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text })
    });
    assert.equal(sent.length, 1, "the worker must actually send when the status independently reported it as eligible");
  } finally {
    if (previous === undefined) delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
    else process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = previous;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: confirmation flow audit (proactive.settings_*) --------------------------------------

test("3A/3B: a setting-change request creates a pending operation only — no DB mutation before yes", async () => {
  const server = buildServer();
  const userId = `launchconfig-3ab-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({ topic: "settings", intent: "update", operations: [op("proactive.settings_propose_update", { morningBriefEnabled: true, eveningCheckinEnabled: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "turn off morning brief and evening check-in");

    assert.equal(reply.debug.mutationExecuted, false, "a proposal must never mutate anything on its own turn");
    assert.equal(reply.debug.pendingOperation, true);
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, false, "still the default — nothing applied yet");
    assert.equal(settings?.eveningCheckinEnabled, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: cancel applies nothing", async () => {
  const server = buildServer();
  const userId = `launchconfig-3d-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({ topic: "settings", intent: "update", operations: [op("proactive.settings_propose_update", { morningBriefEnabled: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "turn on morning brief");

    const reply = await sendAgentMessage(server, userId, "cancel");
    assert.match(reply.reply, /cancelled/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, false, "cancel must apply nothing");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3E: a second 'yes' after a completed proactive settings change says no pending confirmation, not a duplicate success", async () => {
  const server = buildServer();
  const userId = `launchconfig-3e-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({ topic: "settings", intent: "update", operations: [op("proactive.settings_propose_update", { morningBriefEnabled: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "turn on morning brief");

    const firstYes = await sendAgentMessage(server, userId, "yes");
    assert.equal(firstYes.debug.mutationExecuted, true);
    assert.match(firstYes.reply, /done — the morning brief is now on/i);

    // No mockPlan needed: an exact "yes" with nothing pending is handled deterministically,
    // before the planner ever runs — see runtime.ts's CONFIRM_WHITELIST handling.
    const secondYes = await sendAgentMessage(server, userId, "yes");
    assert.equal(secondYes.debug.mutationExecuted, false, "a second 'yes' must never re-apply or silently succeed again");
    assert.doesNotMatch(secondYes.reply, /done —/i, "must not read like a fresh success");

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true, "still on from the first apply — the second 'yes' changed nothing further");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3-ordering: 'yes' only ever applies a change that was ALREADY pending BEFORE that same request arrived — a mutation can never be visible ahead of the confirming message", async () => {
  // Audits the reported "Alecto appeared to say 'Done' before the user's 'yes'" concern at the
  // code level: /agent/message is a plain synchronous HTTP request/response — there is no
  // fire-and-forget or out-of-order code path that could compute or send a "Done" reply before
  // the request containing "yes" has actually been received and processed. This test proves the
  // mutation itself is causally gated on the confirming call, not merely on timing: the DB write
  // literally does not exist until AFTER the "yes" request completes.
  const server = buildServer();
  const userId = `launchconfig-ordering-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({ topic: "settings", intent: "update", operations: [op("proactive.settings_propose_update", { morningBriefEnabled: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "turn on morning brief");

    const beforeYes = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(beforeYes?.morningBriefEnabled, false, "unmutated right up until the confirming request is sent");

    const yesReply = await sendAgentMessage(server, userId, "yes");

    const afterYes = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(afterYes?.morningBriefEnabled, true, "mutated only once the 'yes' request has fully completed");
    assert.match(yesReply.reply, /done —/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
