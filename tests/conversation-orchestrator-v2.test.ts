import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

const now = "2026-08-13T10:00:00+02:00";

test("conversation orchestrator v2 stores the exact one-item hygiene list it renders", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-visible-invariant-${randomUUID()}`;

  try {
    const action = await createProtectedOneDayOverdueAction(userId);

    const response = await withV2Enabled(() => processV2(server, userId, "clean up my tasks"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /1\. Do 2 strength sessions/);
    assert.doesNotMatch(response.json().reply, /archive 1|archive 2/);
    assert.equal(response.json().routeDebug.routerSource, "conversation_orchestrator_v2");
    assert.equal(response.json().routeDebug.visibleContextType, "action_hygiene_list");
    assert.equal(response.json().routeDebug.visibleEntityCount, 1);
    assert.equal(response.json().routeDebug.contextCreatedBy, "conversation_orchestrator_v2");

    const pending = await prisma.pendingAction.findFirstOrThrow({ where: { userId, status: "pending" } });
    const candidateActions = pending.payload.candidateActions as Array<{
      id: string;
      title: string;
      recommendedOptions: string[];
    }>;
    assert.equal(candidateActions.length, 1);
    assert.equal(candidateActions[0].id, action.id);
    assert.equal(candidateActions[0].title, "Do 2 strength sessions");
    assert.deepEqual(candidateActions[0].recommendedOptions, ["complete", "snooze", "keep"]);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 resolves numbered and pronoun replies after one-item hygiene list", async () => {
  const server = buildServer();

  try {
    const numberedUserId = `orchestrator-v2-numbered-snooze-${randomUUID()}`;
    await createProtectedOneDayOverdueAction(numberedUserId);
    await withV2Enabled(() => processV2(server, numberedUserId, "clean up my tasks"));

    let response = await withV2Enabled(() => processV2(server, numberedUserId, "snooze 1 tomorrow"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Do 2 strength sessions/);
    assert.doesNotMatch(response.json().reply, /That hygiene session no longer has any options|could not confidently match/i);
    assert.equal(response.json().routeDebug.intent, "action_hygiene_reply");
    assert.equal(response.json().routeDebug.mutationExecuted, true);
    assert.equal(await prisma.actionItem.count({ where: { userId: numberedUserId, status: "snoozed" } }), 1);

    const pronounUserId = `orchestrator-v2-pronoun-snooze-${randomUUID()}`;
    await createProtectedOneDayOverdueAction(pronounUserId);
    await withV2Enabled(() => processV2(server, pronounUserId, "clean up my tasks"));

    response = await withV2Enabled(() => processV2(server, pronounUserId, "snooze it to tomorrow"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Do 2 strength sessions/);
    assert.doesNotMatch(response.json().reply, /That hygiene session no longer has any options|could not confidently match/i);
    assert.equal(response.json().routeDebug.intent, "action_hygiene_reply");
    assert.equal(response.json().routeDebug.mutationExecuted, true);
    assert.equal(await prisma.actionItem.count({ where: { userId: pronounUserId, status: "snoozed" } }), 1);

    const completeUserId = `orchestrator-v2-pronoun-complete-${randomUUID()}`;
    await createProtectedOneDayOverdueAction(completeUserId);
    await withV2Enabled(() => processV2(server, completeUserId, "clean up my tasks"));

    response = await withV2Enabled(() => processV2(server, completeUserId, "complete it"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action completed: Do 2 strength sessions/);
    assert.equal(response.json().routeDebug.mutationExecuted, true);

    const keepUserId = `orchestrator-v2-pronoun-keep-${randomUUID()}`;
    await createProtectedOneDayOverdueAction(keepUserId);
    await withV2Enabled(() => processV2(server, keepUserId, "clean up my tasks"));

    response = await withV2Enabled(() => processV2(server, keepUserId, "keep it"));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "Kept for now: Do 2 strength sessions");
    assert.equal(response.json().routeDebug.mutationExecuted, false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: { contains: "orchestrator-v2-numbered-snooze-" } } });
    await prisma.user.deleteMany({ where: { id: { contains: "orchestrator-v2-pronoun-snooze-" } } });
    await prisma.user.deleteMany({ where: { id: { contains: "orchestrator-v2-pronoun-complete-" } } });
    await prisma.user.deleteMany({ where: { id: { contains: "orchestrator-v2-pronoun-keep-" } } });
  }
});

test("conversation orchestrator v2 reports unavailable archive all as no-op", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-archive-unavailable-${randomUUID()}`;

  try {
    await createProtectedOneDayOverdueAction(userId);
    await withV2Enabled(() => processV2(server, userId, "clean up my tasks"));

    const response = await withV2Enabled(() => processV2(server, userId, "archive all"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I can complete, snooze, or keep Do 2 strength sessions, but archive is not available for this item\./);
    assert.doesNotMatch(response.json().reply, /That hygiene session no longer has any options|could not confidently match/i);
    assert.equal(response.json().routeDebug.mutationExecuted, false);
    assert.equal(await prisma.actionItem.count({ where: { userId, status: "archived" } }), 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 gives friendly no-visible-item reply after clean hygiene list", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-clean-hygiene-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);

    let response = await withV2Enabled(() => processMessage(server, userId, "clean up my tasks"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action list is clean enough/);
    assert.equal(response.json().routeDebug.visibleEntityCount, 0);

    response = await withV2Enabled(() => processMessage(server, userId, "snooze it to tomorrow"));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "I don't have a visible cleanup item right now. Your action list is clean enough.");
    assert.doesNotMatch(response.json().reply, /That hygiene session no longer has any options|\/action_hygiene/i);
    assert.equal(response.json().routeDebug.mutationExecuted, false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 gives friendly no-visible-item reply without hygiene context", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-missing-hygiene-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);

    const response = await withV2Enabled(() => processMessage(server, userId, "snooze it to tomorrow"));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "I don't have a visible cleanup item right now. Say 'clean up my tasks' first.");
    assert.doesNotMatch(response.json().reply, /That hygiene session no longer has any options|\/action_hygiene/i);
    assert.equal(response.json().routeDebug.mutationExecuted, false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 owns action hygiene list creation and numbered replies", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-hygiene-owner-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);
    await createOverdueActions(userId, [
      "Review homepage",
      "Write YouTube script"
    ]);

    let response = await withV2Enabled(() => processV2(server, userId, "clean up my tasks"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action hygiene:/);
    assert.equal(response.json().routeDebug.routerSource, "conversation_orchestrator_v2");
    assert.equal(response.json().routeDebug.intent, "action_hygiene");
    assert.equal(response.json().routeDebug.handledBy, "v2");
    assert.equal(response.json().routeDebug.plannerUsed, "deterministic");
    assert.equal(response.json().routeDebug.llmPlannerAttempted, false);
    assert.equal(response.json().routeDebug.llmPlannerUsed, false);
    assert.equal(response.json().routeDebug.visibleContextType, "action_hygiene_list");
    assert.equal(response.json().routeDebug.contextCreatedBy, "conversation_orchestrator_v2");
    assert.ok(response.json().routeDebug.visibleEntityCount >= 1);

    const pending = await prisma.pendingAction.findFirstOrThrow({ where: { userId, status: "pending" } });
    assert.equal(pending.type, "action_hygiene");
    assert.equal(pending.payload.createdBy, "conversation_orchestrator_v2");

    response = await withV2Enabled(() => processV2(server, userId, "snooze 1 tomorrow"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action snoozed until|Done:/);
    assert.doesNotMatch(response.json().reply, /session no longer has any options/i);
    assert.equal(response.json().routeDebug.intent, "action_hygiene_reply");
    assert.equal(response.json().routeDebug.plannerUsed, "deterministic");
    assert.equal((await actionStatus((pending.payload.candidateActions as Array<{ id: string }>)[0].id)), "snoozed");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("normal process route uses v2 for action hygiene when enabled", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-process-route-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);
    await createOverdueActions(userId, ["Review homepage"]);

    let response = await withV2Enabled(() => processMessage(server, userId, "clean up my tasks"));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().routeDebug.routerSource, "conversation_orchestrator_v2");
    assert.equal(response.json().routeDebug.intent, "action_hygiene");
    assert.equal(response.json().routeDebug.contextCreatedBy, "conversation_orchestrator_v2");
    assert.equal(response.json().routeDebug.visibleEntityCount, 1);

    response = await withV2Enabled(() => processMessage(server, userId, "snooze it to tomorrow"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action snoozed until/);
    assert.equal(response.json().routeDebug.routerSource, "conversation_orchestrator_v2");
    assert.equal(response.json().routeDebug.intent, "action_hygiene_reply");
    assert.equal(await prisma.actionItem.count({ where: { userId, status: "snoozed" } }), 1);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 asks confirmation for archive all from visible hygiene context", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-archive-all-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);
    await createOverdueActions(userId, ["Review homepage"]);

    await withV2Enabled(() => processMessage(server, userId, "clean up my tasks"));
    const response = await withV2Enabled(() => processMessage(server, userId, "archive all"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I will:/);
    assert.match(response.json().reply, /archive Review homepage/);
    assert.equal(response.json().routeDebug.pendingConfirmation, true);
    assert.equal(response.json().routeDebug.mutationExecuted, false);
    assert.equal(await prisma.actionItem.count({ where: { userId, status: "archived" } }), 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 respects hygiene operations unavailable on protected actions", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-protected-hygiene-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);
    const goal = await prisma.goal.create({
      data: {
        userId,
        title: "Find a new developer job",
        category: "career",
        templateId: "career.job_search",
        priority: "critical",
        importanceScore: 70
      }
    });
    await prisma.actionItem.create({
      data: {
        userId,
        source: "manual",
        title: "Apply to 3 developer jobs",
        priority: "medium",
        status: "open",
        goalId: goal.id,
        goalTitleSnapshot: goal.title,
        dueAt: new Date("2026-08-01T07:00:00.000Z")
      }
    });

    await withV2Enabled(() => processV2(server, userId, "clean up my tasks"));
    const response = await withV2Enabled(() => processV2(server, userId, "archive 1"));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /archive is not available/);
    assert.equal(await prisma.actionItem.count({ where: { userId, status: "archived" } }), 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 risk hard-stop wins on normal process route", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-process-risk-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);
    await prisma.goal.create({
      data: {
        userId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting_trading",
        priority: "critical",
        importanceScore: 70
      }
    });

    const response = await withV2Enabled(() => processMessage(server, userId, "what should I do today to win a bet?"));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().riskState, "RED");
    assert.match(response.json().reply, /Hard stop/);
    assert.equal(response.json().routeDebug.handledBy, "risk_guardrail");
    assert.equal(await prisma.actionItem.count({ where: { userId } }), 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 handles visible action hygiene batch with confirmation", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-batch-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);
    await createOverdueActions(userId, [
      "Review homepage",
      "Write 5 bullets",
      "Read 20 minutes",
      "Do strength sessions"
    ]);

    const candidates = await loadHygieneCandidates(server, userId);

    let response = await processV2(server, userId, "archive 1, snooze 2 tomorrow, archive 3 and 4");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I will:/);
    assert.match(response.json().reply, /archive Review homepage/);
    assert.match(response.json().reply, /snooze Write 5 bullets/);
    assert.match(response.json().reply, /archive Read 20 minutes/);
    assert.match(response.json().reply, /archive Do strength sessions/);
    assert.equal((await actionStatus(candidates[0].actionId)), "open");

    response = await processV2(server, userId, "yes");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Done:/);
    assert.equal((await actionStatus(candidates[0].actionId)), "archived");
    assert.equal((await actionStatus(candidates[1].actionId)), "snoozed");
    assert.equal((await actionStatus(candidates[2].actionId)), "archived");
    assert.equal((await actionStatus(candidates[3].actionId)), "archived");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 handles all-except hygiene language and recent mutation questions", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-except-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);
    await createOverdueActions(userId, [
      "Review homepage",
      "Read 20 minutes on 3 days",
      "Apply to 3 developer jobs"
    ]);
    const candidates = await loadHygieneCandidates(server, userId);

    let response = await processV2(server, userId, "archive all except the read 20 minutes, snooze that to tomorrow");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I will:/);
    assert.match(response.json().reply, /archive Review homepage/);
    assert.match(response.json().reply, /snooze Read 20 minutes on 3 days/);

    response = await processV2(server, userId, "do it");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Done:/);
    assert.equal((await actionStatus(candidates[0].actionId)), "archived");
    assert.equal((await actionStatus(candidates[1].actionId)), "snoozed");
    assert.equal((await actionStatus(candidates[2].actionId)), "archived");

    response = await processV2(server, userId, "did u archive the rest?");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Last action changes:/);
    assert.match(response.json().reply, /Archived Review homepage/);
    assert.match(response.json().reply, /Snoozed Read 20 minutes on 3 days/);
    assert.doesNotMatch(response.json().reply, /Gmail|email rule/i);

    response = await processV2(server, userId, "qué has cambiado?");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Last action changes:/);

    response = await processV2(server, userId, "què has canviat?");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Last action changes:/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 handles Spanish and Catalan hygiene references", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-language-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);
    await createOverdueActions(userId, [
      "Review homepage",
      "Read 20 minutes on 3 days",
      "Write YouTube script"
    ]);
    let candidates = await loadHygieneCandidates(server, userId);

    let response = await processV2(server, userId, "arxiva tots menys el de llegir");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I will:/);
    assert.match(response.json().reply, /archive Review homepage/);
    assert.match(response.json().reply, /archive Write YouTube script/);

    response = await processV2(server, userId, "sí");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Done:/);
    assert.equal((await actionStatus(candidates[0].actionId)), "archived");
    assert.equal((await actionStatus(candidates[1].actionId)), "open");
    assert.equal((await actionStatus(candidates[2].actionId)), "archived");

    await prisma.pendingAction.deleteMany({ where: { userId } });
    candidates = await loadHygieneCandidates(server, userId);
    response = await processV2(server, userId, "snooze el de leer hasta mañana");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action snoozed until/);
    assert.equal((await actionStatus(candidates[0].actionId)), "snoozed");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 protects cross-domain visible context", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-cross-domain-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: { provider: "gmail", scope: "gmail.readonly" }
      }
    });
    const workRule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "work_action_email",
        name: "Work action emails",
        query: "please review",
        status: "active",
        createdBy: "user"
      }
    });
    await prisma.pendingAction.create({
      data: {
        userId,
        type: "custom_email_rule",
        status: "pending",
        summary: "Gmail rule context: Work action emails",
        payload: {
          operation: "rule_context",
          focusedRuleId: workRule.id,
          visibleRules: [{ id: workRule.id, name: workRule.name, status: workRule.status }]
        },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      }
    });

    const response = await processV2(server, userId, "ignore the Endesa ones");
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I don't see visible Endesa reviews or an active Endesa rule/i);
    assert.doesNotMatch(response.json().reply, /Work action emails/);
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: workRule.id } })).status, "active");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 keeps risk precedence over daily/operator wording", async () => {
  const server = buildServer();
  const userId = `orchestrator-v2-risk-${randomUUID()}`;

  try {
    await createUserWithTimezone(userId);
    await prisma.goal.create({
      data: {
        userId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting_trading",
        priority: "critical",
        importanceScore: 70
      }
    });

    const response = await processV2(server, userId, "what should I do today to win a bet?");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().riskState, "RED");
    assert.match(response.json().reply, /Hard stop/);
    assert.doesNotMatch(response.json().reply, /Today -/);
    assert.equal(await prisma.actionItem.count({ where: { userId } }), 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("conversation orchestrator v2 accepts natural confirmation variants only in pending scope", async () => {
  const variants = ["yes", "yep", "do it", "ok archive them", "sure"];

  for (const variant of variants) {
    const server = buildServer();
    const userId = `orchestrator-v2-confirm-${variant.replace(/\s+/g, "-")}-${randomUUID()}`;

    try {
      await createUserWithTimezone(userId);
      const action = await prisma.actionItem.create({
        data: {
          userId,
          source: "manual",
          title: `Review homepage ${variant}`,
          priority: "medium",
          status: "open"
        }
      });
      await prisma.pendingAction.create({
        data: {
          userId,
          type: "action_archive",
          status: "pending",
          summary: `Archive action: ${action.title}`,
          payload: {
            actionId: action.id,
            candidateActions: [{ id: action.id, title: action.title, status: action.status }]
          },
          expiresAt: new Date(Date.now() + 60 * 60 * 1000)
        }
      });

      const response = await processV2(server, userId, variant);
      assert.equal(response.statusCode, 200);
      assert.match(response.json().reply, /Action archived:/);
      assert.equal((await actionStatus(action.id)), "archived");
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }

  const server = buildServer();
  const userId = `orchestrator-v2-stale-confirm-${randomUUID()}`;
  try {
    await createUserWithTimezone(userId);
    await prisma.pendingAction.create({
      data: {
        userId,
        type: "action_hygiene",
        status: "pending",
        summary: "Recent action changes",
        payload: {
          operation: "recent_mutation_status",
          summary: "Recent action changes",
          reply: "Done:\n- Archived Review homepage"
        },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      }
    });

    const response = await processV2(server, userId, "sure");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "No pending change is waiting right now.");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

async function createUserWithTimezone(userId: string): Promise<void> {
  await prisma.user.create({ data: { id: userId } });
  await prisma.notificationSettings.create({
    data: {
      userId,
      timezone: "Europe/Madrid",
      telegramUserId: "12345"
    }
  });
}

async function createProtectedOneDayOverdueAction(userId: string) {
  await createUserWithTimezone(userId);
  const goal = await prisma.goal.create({
    data: {
      userId,
      title: "Improve strength and energy",
      category: "health",
      templateId: "health.strength_energy",
      priority: "high",
      importanceScore: 45
    }
  });

  return prisma.actionItem.create({
    data: {
      userId,
      source: "manual",
      title: "Do 2 strength sessions",
      priority: "medium",
      status: "open",
      goalId: goal.id,
      goalTitleSnapshot: goal.title,
      dueAt: new Date("2026-08-12T07:00:00.000Z")
    }
  });
}

async function createOverdueActions(userId: string, titles: string[]): Promise<void> {
  for (let index = 0; index < titles.length; index += 1) {
    await prisma.actionItem.create({
      data: {
        userId,
        source: "manual",
        title: titles[index],
        priority: "medium",
        status: "open",
        dueAt: new Date(`2026-08-0${index + 1}T07:00:00.000Z`)
      }
    });
  }
}

async function loadHygieneCandidates(server: ReturnType<typeof buildServer>, userId: string) {
  const response = await server.inject({
    method: "GET",
    url: `/users/${userId}/actions/hygiene?now=${encodeURIComponent(now)}`
  });
  assert.equal(response.statusCode, 200);
  const candidates = response.json().report.suggestedCleanupCandidates as Array<{ actionId: string; title: string }>;
  assert.ok(candidates.length > 0);
  return candidates;
}

async function processV2(server: ReturnType<typeof buildServer>, userId: string, message: string) {
  return server.inject({
    method: "POST",
    url: "/messages/process_v2",
    payload: { userId, message }
  });
}

async function processMessage(server: ReturnType<typeof buildServer>, userId: string, message: string) {
  return server.inject({
    method: "POST",
    url: "/messages/process",
    payload: { userId, message }
  });
}

async function withV2Enabled<T>(callback: () => Promise<T>): Promise<T> {
  const previous = process.env.CONVERSATION_ORCHESTRATOR_V2_ENABLED;
  process.env.CONVERSATION_ORCHESTRATOR_V2_ENABLED = "true";
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.CONVERSATION_ORCHESTRATOR_V2_ENABLED;
    } else {
      process.env.CONVERSATION_ORCHESTRATOR_V2_ENABLED = previous;
    }
  }
}

async function actionStatus(actionId: string): Promise<string> {
  return (await prisma.actionItem.findUniqueOrThrow({ where: { id: actionId } })).status;
}
