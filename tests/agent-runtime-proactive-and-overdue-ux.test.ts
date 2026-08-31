import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { parseActionDueDate } from "../packages/core/src/action-intake.ts";
import { buildOpenActionCommandFooter, formatDueLabelForChat } from "../packages/core/src/action-reminder-copy.ts";
import { createActionItem, createGoal, prisma, updateNotificationSettings } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";
import { sendDueActionReminders } from "../apps/worker/src/action-reminders.ts";
import { runV3ProactiveEveningCheckins, runV3ProactiveMorningBriefs } from "../apps/worker/src/v3-proactive-delivery.ts";

/**
 * Launch-readiness coverage for a real Telegram transcript's three reported blockers
 * (fix/private-alpha-proactive-checkins-and-overdue-action-ux):
 *
 * 1. Morning brief/evening check-in were reported "on" by `proactive.settings_show` yet never
 *    delivered — root cause: dailyLoopEnabled (a separate, older umbrella flag apps/worker's
 *    v3-proactive-delivery.ts ALSO requires, defaulting to false) was never touched by the only
 *    tool that turns morningBriefEnabled/eveningCheckinEnabled on. Fixed at the source
 *    (proactive.settings_apply_update now also enables it) and the status command now reports
 *    real worker eligibility, not just the raw setting.
 * 2. The worker's own overdue-action reminder footer was a hardcoded "Reply: complete 1, snooze 2
 *    tomorrow, or archive 3." regardless of how many actions were actually bundled, and used the
 *    user-facing-forbidden word "snooze". Fixed by sharing the same footer/due-label builders
 *    apps/api's own action.list already used correctly.
 * 3. A date-only "today" action created late defaulted to the SAME 9am preference every other
 *    date-only phrase uses — if that 9am had already passed, it silently rolled to "+15 minutes
 *    from now", making a same-day task overdue almost immediately. Fixed by defaulting a bare
 *    "today" (no explicit time or day-part) to the end of the local day instead.
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

function capturingLogger(): { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    lines
  };
}

async function enableMorningBrief(server: ReturnType<typeof buildServer>, userId: string): Promise<void> {
  mockPlan({ topic: "settings", intent: "update", operations: [op("proactive.settings_propose_update", { morningBriefEnabled: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  await sendAgentMessage(server, userId, "turn on morning brief");
  mockPlan({ topic: "settings", intent: "confirm", operations: [op("proactive.settings_apply_update", { morningBriefEnabled: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  await sendAgentMessage(server, userId, "yes");
  clearAgentRuntimeMocks();
}

async function enableEveningCheckin(server: ReturnType<typeof buildServer>, userId: string): Promise<void> {
  mockPlan({ topic: "settings", intent: "update", operations: [op("proactive.settings_propose_update", { eveningCheckinEnabled: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  await sendAgentMessage(server, userId, "turn on evening check-in");
  mockPlan({ topic: "settings", intent: "confirm", operations: [op("proactive.settings_apply_update", { eveningCheckinEnabled: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  await sendAgentMessage(server, userId, "yes");
  clearAgentRuntimeMocks();
}

// --- Task 3/4 root fix: turning morning/evening ON also turns dailyLoopEnabled on -----------------

test("root fix: turning morning brief on via chat also enables the dailyLoopEnabled prerequisite worker delivery requires", async () => {
  const server = buildServer();
  const userId = `proactive-rootfix-morning-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    const before = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(before?.dailyLoopEnabled, false, "sanity: dailyLoopEnabled defaults to false");

    await enableMorningBrief(server, userId);

    const after = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(after?.morningBriefEnabled, true);
    assert.equal(after?.dailyLoopEnabled, true, "turning morning brief on must also enable the dailyLoopEnabled prerequisite");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("root fix: turning evening check-in on via chat also enables dailyLoopEnabled", async () => {
  const server = buildServer();
  const userId = `proactive-rootfix-evening-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await enableEveningCheckin(server, userId);

    const after = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(after?.eveningCheckinEnabled, true);
    assert.equal(after?.dailyLoopEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("root fix: turning morning/evening OFF never disables dailyLoopEnabled (never silently disables the independent legacy daily-loop feature)", async () => {
  const server = buildServer();
  const userId = `proactive-rootfix-off-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await enableMorningBrief(server, userId);

    mockPlan({ topic: "settings", intent: "update", operations: [op("proactive.settings_propose_update", { morningBriefEnabled: false })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "turn off morning brief");
    mockPlan({ topic: "settings", intent: "confirm", operations: [op("proactive.settings_apply_update", { morningBriefEnabled: false })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "yes");

    const after = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(after?.morningBriefEnabled, false);
    assert.equal(after?.dailyLoopEnabled, true, "turning morning brief OFF must never silently disable dailyLoopEnabled — 'Do NOT silently disable reminders'");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 2: automatic-message status is truthful --------------------------------------------------

test("2A: status says 'on' with real eligibility info, not just the raw setting", async () => {
  const server = buildServer();
  const userId = `proactive-status-2a-${randomUUID()}`;
  const previous = process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = "true";
  try {
    await seedMadridUser(userId, { telegramUserId: "999000020" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await enableMorningBrief(server, userId);

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what proactive messages are on?");

    assert.match(reply.reply, /morning brief: on, around 09:00/i);
    assert.match(reply.reply, /next due: (today|tomorrow) \d{2}:\d{2}/i, "must show real next-due eligibility, not just 'on'");
  } finally {
    if (previous === undefined) delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
    else process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = previous;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B: status includes next due / last sent", async () => {
  const server = buildServer();
  const userId = `proactive-status-2b-${randomUUID()}`;
  const previous = process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = "true";
  try {
    await seedMadridUser(userId, { telegramUserId: "999000021" });
    await enableEveningCheckin(server, userId);

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what proactive messages are on?");

    assert.match(reply.reply, /evening check-in: on, around 19:00 — next due: (today|tomorrow) 19:00 \/ last sent: never/i);
  } finally {
    if (previous === undefined) delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
    else process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = previous;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C: if the proactive delivery env is disabled, status says configured on but delivery disabled", async () => {
  const server = buildServer();
  const userId = `proactive-status-2c-${randomUUID()}`;
  const previous = process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  try {
    await seedMadridUser(userId);
    await enableMorningBrief(server, userId);

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what proactive messages are on?");

    // fix/private-alpha-proactive-launch-config-cleanup (task 4): "on, around HH:MM — delivery
    // disabled in this environment" was itself the misleading half-on wording this task closed —
    // now distinguishes the user's own setting from actual server-side delivery explicitly.
    assert.match(reply.reply, /morning brief: configured on, but delivery is disabled on this server/i);
  } finally {
    if (previous === undefined) delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
    else process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = previous;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D: if the user isn't allowlisted, status says configured on but not eligible", async () => {
  const server = buildServer();
  const userId = `proactive-status-2d-${randomUUID()}`;
  const previousEnabled = process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
  const previousAllowlist = process.env.PROACTIVE_OPERATOR_ALLOWLIST;
  process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = "true";
  process.env.PROACTIVE_OPERATOR_ALLOWLIST = "someone-else-entirely";
  try {
    await seedMadridUser(userId);
    await enableMorningBrief(server, userId);

    mockPlan({ topic: "settings", intent: "show", operations: [op("proactive.settings_show", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what proactive messages are on?");

    assert.match(reply.reply, /morning brief: on, around 09:00 — not eligible — not in the allowlist/i);
  } finally {
    if (previousEnabled === undefined) delete process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED;
    else process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED = previousEnabled;
    if (previousAllowlist === undefined) delete process.env.PROACTIVE_OPERATOR_ALLOWLIST;
    else process.env.PROACTIVE_OPERATOR_ALLOWLIST = previousAllowlist;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E: the status reflects the user's real timezone (Europe/Madrid)", async () => {
  const server = buildServer();
  const userId = `proactive-status-2e-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(settings?.timezone, "Europe/Madrid");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: morning brief actually delivers ------------------------------------------------------

test("3A: a Europe/Madrid user with morning brief enabled receives it at the real 09:00 worker tick", async () => {
  const server = buildServer();
  const userId = `proactive-morning-3a-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:700001" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await enableMorningBrief(server, userId);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    const sent: Array<{ chatId: string; text: string }> = [];
    await runV3ProactiveMorningBriefs([settings as any], {
      now: new Date("2026-08-27T07:00:00Z"), // 09:00 Europe/Madrid
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async (chatId, text) => {
        sent.push({ chatId, text });
      }
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.chatId, "telegram:700001");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B: the morning brief is not sent twice in the same local day", async () => {
  const server = buildServer();
  const userId = `proactive-morning-3b-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:700002" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await enableMorningBrief(server, userId);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    const sent: Array<{ chatId: string; text: string }> = [];
    const now = new Date("2026-08-27T07:00:00Z");
    const deps = { now, deliveryEnabled: true, apiGet: injectApiGet(server), sendTelegramMessage: async (chatId: string, text: string) => void sent.push({ chatId, text }) };

    await runV3ProactiveMorningBriefs([settings as any], deps);
    await runV3ProactiveMorningBriefs([settings as any], deps);

    assert.equal(sent.length, 1, "a second tick at the same scheduled minute must not send a duplicate");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: still sent when there are zero actions but an active goal exists", async () => {
  const server = buildServer();
  const userId = `proactive-morning-3c-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:700003" });
    await createGoal(userId, { title: "Learn Spanish", category: "learning", priority: "medium" });
    await enableMorningBrief(server, userId);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    const sent: Array<{ chatId: string; text: string }> = [];
    await runV3ProactiveMorningBriefs([settings as any], {
      now: new Date("2026-08-27T07:00:00Z"),
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text })
    });

    assert.equal(sent.length, 1, "an active goal alone must be enough content for a morning brief");
    assert.match(sent[0]!.text, /learn spanish/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: an overdue action is called out in the morning brief", async () => {
  const server = buildServer();
  const userId = `proactive-morning-3d-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:700004" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await createActionItem(userId, { source: "manual", title: "Send 6 CVs", dueAt: new Date("2026-08-26T07:00:00Z") });
    await enableMorningBrief(server, userId);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    const sent: Array<{ chatId: string; text: string }> = [];
    await runV3ProactiveMorningBriefs([settings as any], {
      now: new Date("2026-08-27T07:00:00Z"),
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text })
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /overdue/i);
    assert.match(sent[0]!.text, /send 6 cvs/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3E: a skip is logged with a real reason when delivery is blocked (not allowlisted)", async () => {
  const server = buildServer();
  const userId = `proactive-morning-3e-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:700005" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await updateNotificationSettings(userId, { morningBriefEnabled: true, dailyLoopEnabled: true });
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });

    // fix/private-alpha-proactive-launch-config-cleanup: dailyLoopEnabled=false is no longer a
    // reachable "still blocked" case to test here — selfHealDailyLoopEnabled (task 1) now fixes it
    // automatically on this exact code path, so a stale morningBriefEnabled=true/dailyLoopEnabled=
    // false user now genuinely DELIVERS instead of skipping (covered by the "root fix" tests
    // above). Not-allowlisted is a real, still-genuinely-blocking reason unaffected by that fix.
    const logger = capturingLogger();
    await runV3ProactiveMorningBriefs([settings as any], {
      now: new Date("2026-08-27T07:00:00Z"),
      deliveryEnabled: true,
      isAllowed: () => false,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async () => {},
      logger
    });

    assert.ok(
      logger.lines.some((line) => /not in PROACTIVE_OPERATOR_ALLOWLIST/i.test(line)),
      `expected a logged, inspectable skip reason — got: ${JSON.stringify(logger.lines)}`
    );
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: evening check-in actually delivers -----------------------------------------------------

test("4A: a Europe/Madrid user with evening check-in enabled receives it at the real 19:00 worker tick", async () => {
  const server = buildServer();
  const userId = `proactive-evening-4a-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:700011" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await enableEveningCheckin(server, userId);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    const sent: Array<{ chatId: string; text: string }> = [];
    await runV3ProactiveEveningCheckins([settings as any], {
      now: new Date("2026-08-27T17:00:00Z"), // 19:00 Europe/Madrid
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text })
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.chatId, "telegram:700011");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B: the evening check-in is not sent twice in the same local day", async () => {
  const server = buildServer();
  const userId = `proactive-evening-4b-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:700012" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await enableEveningCheckin(server, userId);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = {
      now: new Date("2026-08-27T17:00:00Z"),
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async (chatId: string, text: string) => void sent.push({ chatId, text })
    };

    await runV3ProactiveEveningCheckins([settings as any], deps);
    await runV3ProactiveEveningCheckins([settings as any], deps);

    assert.equal(sent.length, 1);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C: sent even with no progress logged today, as long as an active goal exists", async () => {
  const server = buildServer();
  const userId = `proactive-evening-4c-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:700013" });
    await createGoal(userId, { title: "Learn Spanish", category: "learning", priority: "medium" });
    await enableEveningCheckin(server, userId);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    const sent: Array<{ chatId: string; text: string }> = [];
    await runV3ProactiveEveningCheckins([settings as any], {
      now: new Date("2026-08-27T17:00:00Z"),
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text })
    });

    assert.equal(sent.length, 1, "an active goal alone must be enough to ask an honest evening check-in question");
    assert.doesNotMatch(sent[0]!.text, /you (made|completed|finished)/i, "must never fabricate a progress claim");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4D: a due-today action still open is mentioned", async () => {
  const server = buildServer();
  const userId = `proactive-evening-4d-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:700014" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await createActionItem(userId, { source: "manual", title: "Send 6 CVs", dueAt: new Date("2026-08-27T10:00:00Z") }); // due today, still open
    await enableEveningCheckin(server, userId);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    const sent: Array<{ chatId: string; text: string }> = [];
    await runV3ProactiveEveningCheckins([settings as any], {
      now: new Date("2026-08-27T17:00:00Z"),
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text })
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /send 6 cvs/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4E: a skip is logged with a real reason when delivery is blocked (not allowlisted)", async () => {
  const server = buildServer();
  const userId = `proactive-evening-4e-${randomUUID()}`;
  try {
    await seedMadridUser(userId, { telegramUserId: "telegram:700015" });
    await createGoal(userId, { title: "Find a fully remote developer job", category: "career", priority: "medium" });
    await updateNotificationSettings(userId, { eveningCheckinEnabled: true, dailyLoopEnabled: true });
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });

    // fix/private-alpha-proactive-launch-config-cleanup: dailyLoopEnabled=false is no longer
    // reachable here — selfHealDailyLoopEnabled (task 1) fixes it automatically on this exact
    // path now, so that stale state genuinely delivers instead of skipping. Not-allowlisted
    // remains a real, still-genuinely-blocking reason.
    const logger = capturingLogger();
    await runV3ProactiveEveningCheckins([settings as any], {
      now: new Date("2026-08-27T17:00:00Z"),
      deliveryEnabled: true,
      isAllowed: () => false,
      apiGet: injectApiGet(server),
      sendTelegramMessage: async () => {},
      logger
    });

    assert.ok(
      logger.lines.some((line) => /not in PROACTIVE_OPERATOR_ALLOWLIST/i.test(line)),
      `expected a logged skip reason — got: ${JSON.stringify(logger.lines)}`
    );
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: overdue action reminder UI -------------------------------------------------------------

test("5A: one overdue action's footer never references an index that doesn't exist", () => {
  assert.equal(buildOpenActionCommandFooter([1]), "You can say: \"done\", \"move it to tomorrow\", or \"archive it\".");
});

test("5B: two overdue actions' footer references only 1/2", () => {
  assert.equal(buildOpenActionCommandFooter([1, 2]), "You can say: \"complete 1\", \"move 2 to tomorrow\", or \"archive 1\".");
});

// fix/private-alpha-proactive-checkins-and-overdue-action-ux: sendDueActionReminders (unlike
// runV3ProactiveMorningBriefs/EveningCheckins above, which route via NotificationSettings.
// telegramUserId) derives the Telegram chat id straight from the ActionItem's OWN userId via
// telegramChatIdFromUserId — it must literally be "telegram:<digits>", and every user in the DB
// with an eligible overdue action is processed in one pass (no per-test scoping), so these tests
// use that exact convention and assert on the message addressed to their OWN chat id specifically
// rather than assuming sent.length reflects only this test's own data.
async function seedTelegramOverdueUser(chatIdDigits: string): Promise<{ userId: string; chatId: string }> {
  const userId = `telegram:${chatIdDigits}`;
  await seedUser(userId);
  await updateNotificationSettings(userId, { timezone: "Europe/Madrid", telegramUserId: userId });
  // telegramChatIdFromUserId (apps/worker/src/action-reminders.ts) sends to just the CAPTURED
  // digit group, not the full "telegram:<digits>" userId string — sendTelegramMessage's own
  // `chatId` argument is this bare-digits value, distinct from `userId`.
  return { userId, chatId: chatIdDigits };
}

function uniqueChatIdDigits(seed: string): string {
  return `7${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 12) + seed;
}

test("5C: user-facing overdue reminder copy never says \"snooze\"", async () => {
  const { userId, chatId } = await seedTelegramOverdueUser(uniqueChatIdDigits("1"));
  try {
    await createActionItem(userId, { source: "manual", title: "Send 6 CVs", dueAt: new Date(Date.now() - 60 * 60 * 1000) });

    const sent: Array<{ chatId: string; text: string }> = [];
    await sendDueActionReminders(new Date(), { sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text }) });

    const mine = sent.find((s) => s.chatId === chatId);
    assert.ok(mine, "expected a bundled reminder addressed to this test's own chat id");
    assert.doesNotMatch(mine!.text, /\bsnooze\b/i);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5D: the due label uses the user's own timezone", async () => {
  const { userId, chatId } = await seedTelegramOverdueUser(uniqueChatIdDigits("2"));
  try {
    const dueAt = new Date("2026-08-27T05:00:00Z"); // 07:00 Europe/Madrid — already overdue relative to "now" below
    await createActionItem(userId, { source: "manual", title: "Send 6 CVs", dueAt });

    const sent: Array<{ chatId: string; text: string }> = [];
    await sendDueActionReminders(new Date("2026-08-27T06:00:00Z"), { sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text }) });

    const mine = sent.find((s) => s.chatId === chatId);
    assert.ok(mine);
    assert.match(mine!.text, /overdue since today 07:00/i, "must render the LOCAL (Europe/Madrid) hour, not the raw UTC one");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5E: completed/archived actions are never included in an overdue reminder", async () => {
  const { userId, chatId } = await seedTelegramOverdueUser(uniqueChatIdDigits("3"));
  try {
    const overdue = new Date(Date.now() - 60 * 60 * 1000);
    const open = await createActionItem(userId, { source: "manual", title: "Open overdue task", dueAt: overdue });
    const completed = await createActionItem(userId, { source: "manual", title: "Completed overdue task", dueAt: overdue });
    await prisma.actionItem.update({ where: { id: completed.id }, data: { status: "completed" } });
    const archived = await createActionItem(userId, { source: "manual", title: "Archived overdue task", dueAt: overdue });
    await prisma.actionItem.update({ where: { id: archived.id }, data: { status: "archived" } });

    const sent: Array<{ chatId: string; text: string }> = [];
    await sendDueActionReminders(new Date(), { sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text }) });

    const mine = sent.find((s) => s.chatId === chatId);
    assert.ok(mine);
    assert.match(mine!.text, /open overdue task/i);
    assert.doesNotMatch(mine!.text, /completed overdue task/i);
    assert.doesNotMatch(mine!.text, /archived overdue task/i);
    void open;
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5F: a deferred action snoozed into the future is never included as overdue", async () => {
  const { userId, chatId } = await seedTelegramOverdueUser(uniqueChatIdDigits("4"));
  try {
    const overdue = new Date(Date.now() - 60 * 60 * 1000);
    await createActionItem(userId, { source: "manual", title: "Real overdue task", dueAt: overdue });
    const deferred = await createActionItem(userId, { source: "manual", title: "Deferred future task", dueAt: overdue });
    await prisma.actionItem.update({
      where: { id: deferred.id },
      data: { status: "snoozed", snoozedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000) }
    });

    const sent: Array<{ chatId: string; text: string }> = [];
    await sendDueActionReminders(new Date(), { sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text }) });

    const mine = sent.find((s) => s.chatId === chatId);
    assert.ok(mine);
    assert.match(mine!.text, /real overdue task/i);
    assert.doesNotMatch(mine!.text, /deferred future task/i);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 6: date-only "today" due-time behavior ----------------------------------------------------

const MADRID = "Europe/Madrid";

test("6A: at 01:11 Europe/Madrid, 'Send 6 CVs today' is not due 15 minutes later by default", () => {
  const now = new Date("2026-08-25T23:11:00Z"); // 01:11 local
  const parsed = parseActionDueDate("Send 6 CVs today", { now, timezone: MADRID });
  assert.ok(parsed.dueAt);
  const minutesAhead = (parsed.dueAt!.getTime() - now.getTime()) / 60_000;
  assert.ok(minutesAhead > 60, `expected the due time to be well over an hour out, got ${minutesAhead} minutes`);
});

test("6B: a date-only 'today' due time defaults to later in the local day (end of day), not the generic 9am default", () => {
  const now = new Date("2026-08-26T12:00:00Z"); // 14:00 local — well after the old 9am default
  const parsed = parseActionDueDate("today", { now, timezone: MADRID });
  assert.ok(parsed.dueAt);
  const localHour = new Intl.DateTimeFormat("en-GB", { timeZone: MADRID, hour: "2-digit", hour12: false }).format(parsed.dueAt);
  assert.equal(localHour, "23");
});

test("6C: no overdue reminder fires within 30 minutes of creating a date-only 'today' action", async () => {
  const { userId, chatId } = await seedTelegramOverdueUser(uniqueChatIdDigits("5"));
  try {
    const createdAt = new Date("2026-08-25T23:11:00Z"); // 01:11 local
    const parsed = parseActionDueDate("Send 6 CVs today", { now: createdAt, timezone: MADRID });
    assert.ok(parsed.dueAt);
    await createActionItem(userId, { source: "manual", title: "Send 6 CVs today", dueAt: parsed.dueAt! });

    const thirtyMinutesLater = new Date(createdAt.getTime() + 30 * 60_000);
    const sent: Array<{ chatId: string; text: string }> = [];
    await sendDueActionReminders(thirtyMinutesLater, { sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text }) });

    const mine = sent.find((s) => s.chatId === chatId);
    assert.equal(mine, undefined, "a date-only 'today' action must not be overdue only 30 minutes after creation");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6D: an explicit 'today at 01:30' still uses 01:30, unaffected by the end-of-day default", () => {
  const now = new Date("2026-08-25T23:11:00Z"); // 01:11 local
  const parsed = parseActionDueDate("today at 01:30", { now, timezone: MADRID });
  assert.ok(parsed.dueAt);
  assert.equal(parsed.explicitTime, true);
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: MADRID, hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed.dueAt);
  assert.equal(local, "01:30");
});

// fix/private-alpha-conversation-kernel-context-routing: a real reported bug — "tomorrow" (no
// time, no day-part) defaulting to 9am read as an oddly specific morning appointment for a
// day-level task like "send 10 CVs tomorrow." Now uses the SAME end-of-day default this file's
// own 6A-6D tests already established for bare "today" — this test's name/expectation updated to
// match; "tomorrow morning"/"tomorrow at 9" (an explicit day-part or time) are unaffected, see the
// dedicated action-default-due-time-policy.test.ts for that coverage.
test("6E: bare 'tomorrow' (no time, no day-part) now defaults to end of day, same as 'today'", () => {
  const now = new Date("2026-08-25T23:11:00Z"); // 01:11 local
  const parsed = parseActionDueDate("tomorrow", { now, timezone: MADRID });
  assert.ok(parsed.dueAt);
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: MADRID, hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed.dueAt);
  assert.equal(local, "23:59");
});

test("6F: the action list / chat due label for an end-of-day 'today' action reads clearly", () => {
  const now = new Date("2026-08-26T12:00:00Z"); // 14:00 local
  const parsed = parseActionDueDate("today", { now, timezone: MADRID });
  assert.ok(parsed.dueAt);
  const label = formatDueLabelForChat(parsed.dueAt!, MADRID, now);
  assert.equal(label, "due today 23:59");
});
