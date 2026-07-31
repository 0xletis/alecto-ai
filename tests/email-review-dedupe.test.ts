import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  findGmailSemanticDuplicateEvent,
  findGmailSemanticDuplicateReviewItem,
  prisma
} from "../packages/db/src/index.ts";
import {
  buildNormalizedInboundMessage,
  buildDeterministicDailyCoachResponse,
  deterministicDailyCoachWarning,
  classifyJobSearchEmail,
  classifyWorkActionEmail,
  explainNormalizedInboundRoute,
  classifyDueWindow,
  getLocalTodayRange,
  normalizeManualActionTitleKey,
  parseActionDueDate,
  routeNormalizedInboundMessage,
  segmentInboundMessage,
  splitPendingDecisionReplyWithCommands,
  sortDailyActionsByPriority,
  validateDailyCoachResponseAgainstContext
} from "../packages/core/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

const userId = `test-user-${randomUUID()}`;
const connectionId = randomUUID();
const ruleId = randomUUID();

test("normalized inbound messages parse channel-neutral slash commands", () => {
  const telegramMessage = buildNormalizedInboundMessage({
    channel: "telegram",
    userId: "telegram:123",
    externalUserId: "123",
    text: "/today",
    timestamp: new Date("2026-07-30T10:00:00.000Z")
  });
  const whatsappMessage = buildNormalizedInboundMessage({
    channel: "whatsapp",
    userId: "whatsapp:123",
    externalUserId: "123",
    text: "/today",
    timestamp: new Date("2026-07-30T10:00:00.000Z")
  });

  assert.equal(telegramMessage.command?.name, "today");
  assert.equal(whatsappMessage.command?.name, "today");
  assert.deepEqual(routeNormalizedInboundMessage(telegramMessage), {
    kind: "command",
    command: { name: "today", args: "", raw: "/today" }
  });
  assert.deepEqual(routeNormalizedInboundMessage(whatsappMessage), {
    kind: "command",
    command: { name: "today", args: "", raw: "/today" }
  });
});

test("inbound message segmentation detects command batches and references", () => {
  const single = segmentInboundMessage("/today");
  assert.equal(single.kind, "single_command");

  const batch = segmentInboundMessage(
    [
      "/archive_action c8d460ea-875b-40d7-b094-95565dfc43f9",
      "/archive_action cac5a63f-3211-4dfe-90f0-79cfa88b977e",
      "/archive_action 4bf37417-2a26-44af-8095-32dd8188a33c"
    ].join("\n")
  );
  assert.equal(batch.kind, "command_batch");
  assert.deepEqual(batch.kind === "command_batch" ? batch.commands : [], [
    "/archive_action c8d460ea-875b-40d7-b094-95565dfc43f9",
    "/archive_action cac5a63f-3211-4dfe-90f0-79cfa88b977e",
    "/archive_action 4bf37417-2a26-44af-8095-32dd8188a33c"
  ]);

  const readOnlyBatch = segmentInboundMessage("/actions\n/today");
  assert.equal(readOnlyBatch.kind, "command_batch");
  assert.deepEqual(readOnlyBatch.kind === "command_batch" ? readOnlyBatch.commands : [], ["/actions", "/today"]);

  const mixedCommand = segmentInboundMessage("/archive_action abc\nextra text");
  assert.equal(mixedCommand.kind, "reference_text");
  assert.equal(mixedCommand.reason, "command_plus_extra_text");

  const mixedNaturalAndCommand = segmentInboundMessage("move YouTube script to tomorrow afternoon\n/actions");
  assert.equal(mixedNaturalAndCommand.kind, "reference_text");
  assert.equal(mixedNaturalAndCommand.reason, "mixed_text_and_command");

  const telegramExport = segmentInboundMessage("[30/07/2026 04:56] letis: /archive_action abc");
  assert.equal(telegramExport.kind, "reference_text");

  const codeFence = segmentInboundMessage("```text\n/archive_action abc\n/archive_action def\n```");
  assert.equal(codeFence.kind, "reference_text");

  const codexPrompt = segmentInboundMessage(
    [
      "You are working in the alecto-ai repository.",
      "Requirements:",
      "- /archive_action abc should not run in this pasted prompt.",
      "Expected:",
      "No side effects."
    ].join("\n")
  );
  assert.equal(codexPrompt.kind, "reference_text");

  const debugDump = segmentInboundMessage(
    [
      "intentType: command",
      "handlerName: archive_action",
      "allowedSideEffects:",
      "- createAction: false"
    ].join("\n")
  );
  assert.equal(debugDump.kind, "reference_text");

  const unknownBatch = segmentInboundMessage("/unknown_one abc\n/unknown_two def");
  assert.equal(unknownBatch.kind, "command_batch");
  assert.deepEqual(unknownBatch.kind === "command_batch" ? unknownBatch.commands : [], ["/unknown_one abc", "/unknown_two def"]);

  const normalText = segmentInboundMessage("I sent 2 CVs and trained 30 min");
  assert.equal(normalText.kind, "normal_text");

  assert.deepEqual(splitPendingDecisionReplyWithCommands("no\n/actions"), {
    replyText: "no",
    commands: ["/actions"]
  });
  assert.deepEqual(splitPendingDecisionReplyWithCommands("yes\n/actions"), {
    replyText: "yes",
    commands: ["/actions"]
  });
  assert.deepEqual(splitPendingDecisionReplyWithCommands("1\n/actions"), {
    replyText: "1",
    commands: ["/actions"]
  });
  assert.equal(splitPendingDecisionReplyWithCommands("move YouTube to tomorrow\n/actions"), undefined);
});

test("normalized inbound router prioritizes memory and risk before check-in routing", () => {
  const memoryMessage = buildNormalizedInboundMessage({
    channel: "telegram",
    userId: "telegram:123",
    externalUserId: "123",
    text: "remember that when I talk about gambling I want you stricter"
  });
  const bettingMessage = buildNormalizedInboundMessage({
    channel: "whatsapp",
    userId: "whatsapp:123",
    externalUserId: "123",
    text: "quiero apostar 1000 porque esto es seguro"
  });
  const checkInMessage = buildNormalizedInboundMessage({
    channel: "web",
    userId: "web:123",
    externalUserId: "123",
    text: "slept 6h, energy 5, anxiety 7, sent 2 cvs, trained 40 min, no gambling impulse"
  });

  assert.equal(routeNormalizedInboundMessage(memoryMessage).kind, "process_message");
  assert.equal(routeNormalizedInboundMessage(bettingMessage).kind, "process_message");
  assert.equal(routeNormalizedInboundMessage(checkInMessage).kind, "daily_checkin");
});

test("normalized inbound route debug preserves normal free-text behavior", () => {
  const action = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "I need to call Alex tomorrow"
    })
  );
  const event = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "sent 2 CVs and trained 30 min"
    })
  );
  const risk = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "remind me to bet 500 tomorrow"
    })
  );

  assert.equal(action.intentType, "action_create");
  assert.equal(event.intentType, "event_log");
  assert.equal(risk.intentType, "goal_guardrail");
  assert.equal(risk.allowedSideEffects.createAction, false);
});

test("normalized inbound router sends pasted job-search emails to ingestion", () => {
  const message = buildNormalizedInboundMessage({
    channel: "telegram",
    userId: "telegram:123",
    externalUserId: "123",
    text: "Hi Miquel, we'd like to schedule an interview for the Backend Engineer role at Test Company. Are you available next Tuesday?"
  });

  assert.deepEqual(routeNormalizedInboundMessage(message), {
    kind: "ingest_text",
    source: "telegram",
    domainHint: "career"
  });
});

test("route debug explains commands and does not imply command execution", () => {
  const today = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "/today"
    })
  );
  const gmailDebug = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "/sync_gmail_debug"
    })
  );

  assert.equal(today.intentType, "command");
  assert.equal(today.handlerName, "today");
  assert.equal(today.allowedSideEffects.createEvent, false);
  assert.equal(today.allowedSideEffects.createAction, false);
  assert.equal(today.allowedSideEffects.createMemory, false);
  assert.equal(gmailDebug.intentType, "command");
  assert.equal(gmailDebug.handlerName, "sync_gmail_debug");
  assert.equal(gmailDebug.allowedSideEffects.sendNotification, false);
});

test("route debug explains action, event, goal guardrail, and standalone now routes", () => {
  const now = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "now"
    })
  );
  const action = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "web",
      userId: "web:123",
      externalUserId: "123",
      text: "I need to call Alex tomorrow"
    })
  );
  const event = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "api",
      userId: "api:123",
      externalUserId: "123",
      text: "sent 2 CVs and trained 30 min"
    })
  );
  const risk = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "whatsapp",
      userId: "whatsapp:123",
      externalUserId: "123",
      text: "remind me to bet 500 tomorrow"
    })
  );
  const actionRisk = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "/action bet 500 tomorrow"
    })
  );
  const reference = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "api",
      userId: "api:123",
      externalUserId: "123",
      text: "You are working in the repo. Tests: /action bet 500 tomorrow"
    })
  );
  const debugOutput = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "api",
      userId: "api:123",
      externalUserId: "123",
      text: "Observed debug output: intentType risk_guardrail for /action bet 500 tomorrow"
    })
  );

  assert.equal(now.intentType, "unknown");
  assert.equal(now.allowedSideEffects.createAction, false);
  assert.equal(now.allowedSideEffects.createEvent, false);
  assert.equal(action.intentType, "action_create");
  assert.equal(action.allowedSideEffects.createAction, true);
  assert.equal(event.intentType, "event_log");
  assert.equal(event.allowedSideEffects.createEvent, true);
  assert.equal(risk.intentType, "goal_guardrail");
  assert.equal(risk.handlerName, "goal_guardrail_engine");
  assert.equal(risk.goal, "Control impulsive betting");
  assert.equal(risk.severity, "hard");
  assert.equal(risk.allowedSideEffects.createAction, false);
  assert.equal(actionRisk.intentType, "command_with_guardrail");
  assert.equal(actionRisk.handlerName, "action");
  assert.equal(actionRisk.allowedSideEffects.createAction, false);
  assert.equal(reference.intentType, "generic_chat");
  assert.equal(reference.isReferenceOnly, true);
  assert.equal(reference.allowedSideEffects.createAction, false);
  assert.equal(reference.allowedSideEffects.createEvent, false);
  assert.equal(debugOutput.intentType, "generic_chat");
  assert.equal(debugOutput.isReferenceOnly, true);
});

test("risky action command text routes to guardrail response without creating ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-risk-command-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const riskGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Control impulsive betting",
      category: "finance",
      templateId: "finance.control_betting_trading"
    }
  });

  const cases = [
    { command: "/action", text: "bet 500 tomorrow", intent: "betting_intent" },
    { command: "/todo", text: "open 20x long tomorrow", intent: "trading_intent" },
    { command: "/add_action", text: "place bet tonight", intent: "betting_intent" }
  ];

  try {
    for (const testCase of cases) {
      const debug = explainNormalizedInboundRoute(
        buildNormalizedInboundMessage({
          channel: "telegram",
          userId: actionUserId,
          externalUserId: "123",
          text: `${testCase.command} ${testCase.text}`
        })
      );
      assert.equal(debug.intentType, "command_with_guardrail");
      assert.equal(debug.allowedSideEffects.createAction, false);

      const response = await server.inject({
        method: "POST",
        url: "/messages/process",
        payload: { userId: actionUserId, message: testCase.text }
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().intent, testCase.intent);
      assert.notEqual(response.json().reply, "I could not turn that into a concrete action item.");
    }

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 0);
    const cooldowns = await prisma.event.findMany({
      where: { userId: actionUserId, type: "finance.betting.cooldown_triggered" },
      orderBy: { createdAt: "asc" }
    });
    assert.equal(cooldowns.length, 3);
    const guardrail = (cooldowns[0].data as { guardrail?: { goalId?: string; category?: string; severity?: string } }).guardrail;
    assert.equal(guardrail?.goalId, riskGoal.id);
    assert.equal(guardrail?.category, "impulse_control");
    assert.equal(guardrail?.severity, "hard");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("pasted prompt with risky examples does not trigger guardrail or cooldown", async () => {
  const server = buildServer();
  const actionUserId = `risk-reference-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: actionUserId,
        message: "You are working in the repo. Tests: /action bet 500 tomorrow. Expected: no ActionItem."
      }
    });
    assert.equal(response.statusCode, 200);
    assert.notEqual(response.json().intent, "betting_intent");
    assert.notEqual(response.json().riskState, "RED");

    const cooldowns = await prisma.event.findMany({
      where: { userId: actionUserId, type: "finance.betting.cooldown_triggered" }
    });
    assert.equal(cooldowns.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("manual actions infer links to active goals", async () => {
  const server = buildServer();
  const actionUserId = `action-goal-links-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });
  const healthGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build strength and energy",
      category: "health",
      templateId: "health.strength_energy"
    }
  });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative"
    }
  });
  const carGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a cheap car to buy",
      category: "custom"
    }
  });

  try {
    const cases = [
      { text: "send CV tonight", goalId: jobGoal.id, title: "Send CV" },
      { text: "apply to 2 jobs tomorrow", goalId: jobGoal.id },
      { text: "train legs tomorrow", goalId: healthGoal.id },
      { text: "write YouTube script tonight", goalId: youtubeGoal.id },
      { text: "check cheap car listings tomorrow", goalId: carGoal.id },
      { text: "pay electricity tomorrow", goalId: undefined }
    ];

    for (const testCase of cases) {
      const response = await server.inject({
        method: "POST",
        url: `/users/${actionUserId}/actions/manual`,
        payload: { text: testCase.text }
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().action.goalId, testCase.goalId);
      if (testCase.goalId) {
        assert.ok(response.json().action.goalTitleSnapshot);
      }
      if (testCase.title) {
        assert.equal(response.json().action.title, testCase.title);
      }
    }
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("conversational action control completes, reschedules, shows, and updates priorities", async () => {
  const server = buildServer();
  const actionUserId = `conversation-control-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: actionUserId,
      timezone: "Europe/Madrid",
      afternoonTimeMinutes: 990
    }
  });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "medium",
      importanceScore: 25
    }
  });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative",
      priority: "medium",
      importanceScore: 25
    }
  });
  const applyAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      status: "open",
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });
  const youtubeAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      status: "open",
      goalId: youtubeGoal.id,
      goalTitleSnapshot: youtubeGoal.title
    }
  });

  try {
    let response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "move YouTube script to tomorrow afternoon",
        now: "2026-07-31T03:01:00+02:00",
        dryRun: true
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().debug.intent, "reschedule_action");
    assert.equal(response.json().debug.targetText, "YouTube script");
    assert.equal(response.json().debug.timeText, "tomorrow afternoon");
    assert.equal(response.json().debug.resolvedAction.title, "Write YouTube script");
    assert.equal(response.json().debug.requiresConfirmation, false);
    assert.equal(response.json().debug.blockedByGuardrail, false);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: youtubeAction.id } })).dueAt, null);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with apply to 2 jobs" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.match(response.json().reply, /Action completed: Apply to 2 jobs/);
    assert.match(response.json().reply, /Goal progress logged: Find a new developer job/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: applyAction.id } })).status, "completed");
    assert.equal(
      await prisma.event.count({
        where: {
          userId: actionUserId,
          type: "custom.goal_progress_logged",
          provider: "action_completion",
          externalId: `action-completion:${applyAction.id}`
        }
      }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with apply to 2 jobs" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action already completed: Apply to 2 jobs/);
    assert.equal(
      await prisma.event.count({
        where: {
          userId: actionUserId,
          type: "custom.goal_progress_logged",
          provider: "action_completion",
          externalId: `action-completion:${applyAction.id}`
        }
      }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "move YouTube script to tomorrow afternoon",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action rescheduled: Write YouTube script/);
    const updatedYoutube = await prisma.actionItem.findUniqueOrThrow({ where: { id: youtubeAction.id } });
    assert.equal(updatedYoutube.status, "open");
    assert.ok(updatedYoutube.dueAt);
    assert.equal(localDate(updatedYoutube.dueAt), "2026-08-01");
    assert.equal(localMinutes(updatedYoutube.dueAt), 990);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Write YouTube script" } }), 1);

    const genericFallback = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: actionUserId,
        message: "move YouTube script to tomorrow afternoon"
      }
    });
    assert.equal(genericFallback.statusCode, 200);
    assert.equal(genericFallback.json().reply, "I could not complete that change. Use /actions to check the exact task.");
    assert.doesNotMatch(genericFallback.json().reply, /noted|logged|moved|rescheduled/i);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "move impossible nonexistent task to tomorrow afternoon",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.doesNotMatch(response.json().reply, /Action rescheduled|I.?ve logged|I moved/i);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Write YouTube script" } }), 1);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "what should I do now?",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.match(response.json().reply, /Write YouTube script/);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Today - 2026-07-31/);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "make job search critical" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "Goal priority updated: Find a new developer job -> critical");
    assert.equal((await prisma.goal.findUniqueOrThrow({ where: { id: jobGoal.id } })).priority, "critical");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("conversational action control asks before destructive or ambiguous mutations", async () => {
  const server = buildServer();
  const actionUserId = `conversation-control-safe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const carAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Check cheap car listings",
      priority: "medium",
      status: "open"
    }
  });
  const callMorning = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-07-31T07:00:00.000Z")
    }
  });
  const callAfternoon = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-07-31T13:00:00.000Z")
    }
  });

  try {
    let response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "delete the car task" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.match(response.json().reply, /Confirm archive action: Check cheap car listings/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: carAction.id } })).status, "open");
    assert.equal(await prisma.pendingAction.count({ where: { userId: actionUserId, type: "action_archive", status: "pending" } }), 1);
    const confirm = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "yes" }
    });
    assert.equal(confirm.statusCode, 200);
    assert.match(confirm.json().reply, /Action archived: Check cheap car listings/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: carAction.id } })).status, "archived");

    const removableAction = await prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Remove dashboard draft",
        priority: "medium",
        status: "open"
      }
    });
    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "delete dashboard draft task" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm archive action: Remove dashboard draft/);
    const reject = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "no" }
    });
    assert.equal(reject.statusCode, 200);
    assert.match(reject.json().reply, /Cancelled/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: removableAction.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with call Alex" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which action do you mean/);
    assert.match(response.json().reply, /1\. Call Alex/);
    assert.match(response.json().reply, /2\. Call Alex/);
    assert.equal(
      await prisma.pendingAction.count({ where: { userId: actionUserId, type: "action_target_clarification", status: "pending" } }),
      1
    );
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, status: "completed" } }), 0);

    const firstChoice = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "1" }
    });
    assert.equal(firstChoice.statusCode, 200);
    assert.match(firstChoice.json().reply, /Action completed: Call Alex/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: callMorning.id } })).status, "completed");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: callAfternoon.id } })).status, "open");

    const callSamMorning = await prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Call Sam",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T07:00:00.000Z")
      }
    });
    const callSamAfternoon = await prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Call Sam",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T13:00:00.000Z")
      }
    });

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with call Sam" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which action do you mean/);
    const secondChoice = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "second one" }
    });
    assert.equal(secondChoice.statusCode, 200);
    assert.match(secondChoice.json().reply, /Action completed: Call Sam/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: callSamMorning.id } })).status, "open");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: callSamAfternoon.id } })).status, "completed");

    await prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Call Pat",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T07:00:00.000Z")
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Call Pat",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T13:00:00.000Z")
      }
    });
    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with call Pat" }
    });
    assert.equal(response.statusCode, 200);
    const cancel = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "cancel" }
    });
    assert.equal(cancel.statusCode, 200);
    assert.match(cancel.json().reply, /Cancelled/);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Call Pat", status: "completed" } }), 0);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with call Pat" }
    });
    assert.equal(response.statusCode, 200);
    await prisma.pendingAction.updateMany({
      where: { userId: actionUserId, type: "action_target_clarification", status: "pending" },
      data: { expiresAt: new Date("2026-01-01T00:00:00.000Z") }
    });
    const expired = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "1" }
    });
    assert.equal(expired.statusCode, 200);
    assert.equal(expired.json().reply, "That pending decision expired. Please ask again.");
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Call Pat", status: "completed" } }), 0);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with impossible nonexistent task" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /could not confidently match/);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: { contains: "impossible" } } }), 0);

    const pendingList = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/pending-actions`
    });
    assert.equal(pendingList.statusCode, 200);
    assert.ok(Array.isArray(pendingList.json().pendingActions));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("conversation control guardrails and debug are side-effect free", async () => {
  const server = buildServer();
  const actionUserId = `conversation-control-debug-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      status: "open"
    }
  });

  try {
    let response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with apply to 2 jobs", dryRun: true }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().debug.intent, "complete_action");
    assert.equal(response.json().debug.resolvedAction.title, "Apply to 2 jobs");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: action.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "remind me to bet 500 tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, false);
    assert.equal(response.json().debug.blockedByGuardrail, true);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: { contains: "bet" } } }), 0);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "move my bet of 5000 usd to tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, false);
    assert.equal(response.json().debug.intent, "goal_guardrail");
    assert.equal(response.json().debug.blockedByGuardrail, true);

    for (const text of ["move my bet to tomorrow", "snooze my bet until tomorrow", "mark betting task done"]) {
      response = await server.inject({
        method: "POST",
        url: `/users/${actionUserId}/conversation/control`,
        payload: { text }
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().handled, false);
      assert.equal(response.json().debug.intent, "goal_guardrail");
      assert.equal(response.json().debug.blockedByGuardrail, true);
    }
    assert.equal(await prisma.pendingAction.count({ where: { userId: actionUserId, status: "pending" } }), 0);

    const process = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: actionUserId,
        message: "remind me to bet 500 tomorrow"
      }
    });
    assert.equal(process.statusCode, 200);
    assert.equal(process.json().mode, "guardian");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("multi-intent orchestrator logs events, mutates actions, and returns readouts safely", async () => {
  const server = buildServer();
  const actionUserId = `multi-intent-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      id: randomUUID(),
      userId: actionUserId,
      timezone: "Europe/Madrid",
      afternoonTimeMinutes: 990
    }
  });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative",
      status: "active",
      priority: "medium",
      importanceScore: 25
    }
  });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      status: "active",
      priority: "critical",
      importanceScore: 70
    }
  });
  const youtubeAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      status: "open",
      goalId: youtubeGoal.id,
      goalTitleSnapshot: youtubeGoal.title
    }
  });
  const applyAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      status: "open",
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });
  const carAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Check cheap car listings",
      priority: "medium",
      status: "open"
    }
  });

  try {
    let response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "I applied to 2 jobs, trained 30 min, and what should I do now?",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.match(response.json().reply, /Logged 2 job applications/);
    assert.match(response.json().reply, /Logged 30 min training/);
    assert.match(response.json().reply, /Next move:/);
    assert.equal(await prisma.event.count({ where: { userId: actionUserId, type: "career.application_sent" } }), 1);
    assert.equal(await prisma.event.count({ where: { userId: actionUserId, type: "health.workout_completed" } }), 1);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "move YouTube script to tomorrow afternoon and show actions",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action rescheduled: Write YouTube script/);
    assert.match(response.json().reply, /Open actions:/);
    const movedYoutube = await prisma.actionItem.findUniqueOrThrow({ where: { id: youtubeAction.id } });
    assert.ok(movedYoutube.dueAt);
    assert.equal(localDate(movedYoutube.dueAt), "2026-08-01");
    assert.equal(localMinutes(movedYoutube.dueAt), 990);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "done with apply to 2 jobs and show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action completed: Apply to 2 jobs/);
    assert.match(response.json().reply, /Today - 2026-07-31/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: applyAction.id } })).status, "completed");
    assert.equal(
      await prisma.event.count({
        where: {
          userId: actionUserId,
          type: "custom.goal_progress_logged",
          provider: "action_completion",
          externalId: `action-completion:${applyAction.id}`
        }
      }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: { text: "make YouTube high priority and show goal priorities" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Goal priority updated: Build a YouTube channel -> high/);
    assert.match(response.json().reply, /Goal priorities:/);
    assert.equal((await prisma.goal.findUniqueOrThrow({ where: { id: youtubeGoal.id } })).priority, "high");

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "delete car listings and show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Needs confirmation/);
    assert.match(response.json().reply, /Confirm archive action: Check cheap car listings/);
    assert.doesNotMatch(response.json().reply, /Today - 2026-07-31/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: carAction.id } })).status, "open");
    assert.equal(await prisma.pendingAction.count({ where: { userId: actionUserId, type: "action_archive", status: "pending" } }), 1);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: carAction.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "delete car and show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm archive action: Check cheap car listings/);
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action archived: Check cheap car listings/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: carAction.id } })).status, "archived");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("multi-intent orchestrator stops for ambiguity, guardrails, and dry-run debug has no side effects", async () => {
  const server = buildServer();
  const actionUserId = `multi-intent-safe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const youtubeAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      status: "open"
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-07-31T07:00:00.000Z")
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-07-31T13:00:00.000Z")
    }
  });

  try {
    let response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "done with call Alex and show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which action do you mean/);
    assert.doesNotMatch(response.json().reply, /Today - 2026-07-31/);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Call Alex", status: "completed" } }), 0);
    assert.equal(
      await prisma.pendingAction.count({ where: { userId: actionUserId, type: "action_target_clarification", status: "pending" } }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "cancel" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "delete call Alex and show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which action do you mean/);
    assert.doesNotMatch(response.json().reply, /Today - 2026-07-31/);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Call Alex", status: "archived" } }), 0);
    assert.equal(
      await prisma.pendingAction.count({ where: { userId: actionUserId, type: "action_target_clarification", status: "pending" } }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "cancel" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "I want to bet 500 tomorrow and move YouTube to Saturday",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.match(response.json().reply, /No|locked|cooldown|bet/i);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: youtubeAction.id } })).dueAt, null);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: { contains: "bet" } } }), 0);
    assert.equal(await prisma.event.count({ where: { userId: actionUserId, type: "finance.betting.cooldown_triggered" } }), 1);
    assert.equal(
      await prisma.pendingAction.count({ where: { userId: actionUserId, type: { in: ["action_archive", "action_target_clarification"] }, status: "pending" } }),
      0
    );

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "I applied to 3 jobs and show actions",
        dryRun: true
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, false);
    assert.equal(response.json().plan.isMultiIntent, true);
    assert.equal(response.json().debug[0].type, "event_log");
    assert.equal(response.json().debug[0].wouldExecute, true);
    assert.equal(await prisma.event.count({ where: { userId: actionUserId, type: "career.application_sent" } }), 0);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: { text: "flibbertigibbet and show actions" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Skipped/);
    assert.match(response.json().reply, /Open actions:/);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: { text: "delete unknown thing and show today", now: "2026-07-31T01:40:00+02:00" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Skipped/);
    assert.match(response.json().reply, /I could not confidently match/);
    assert.match(response.json().reply, /Today - 2026-07-31/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("unrelated manual action creates unlinked ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-unlinked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "buy milk tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().action.title, "Buy milk");
    assert.equal(response.json().action.goalId, undefined);
    assert.equal(response.json().action.goalTitleSnapshot, undefined);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("archived goals are ignored by action goal inference", async () => {
  const server = buildServer();
  const actionUserId = `action-archived-goal-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      status: "archived"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "send CV tonight" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().action.goalId, undefined);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("debug goal-link backfill leaves unrelated actions unlinked", async () => {
  const server = buildServer();
  const actionUserId = `action-backfill-goals-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });
  const milk = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Buy milk",
      priority: "medium"
    }
  });
  const cv = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Send CV",
      priority: "medium"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/debug-link-goals`,
      payload: {}
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().linked, 1);

    const [updatedMilk, updatedCv] = await Promise.all([
      prisma.actionItem.findUniqueOrThrow({ where: { id: milk.id } }),
      prisma.actionItem.findUniqueOrThrow({ where: { id: cv.id } })
    ]);
    assert.equal(updatedMilk.goalId, null);
    assert.equal(updatedCv.goalId, jobGoal.id);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today shows linked action under goal and skips generic progress prompt", async () => {
  const server = buildServer();
  const actionUserId = `today-linked-action-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });

  try {
    const actionResponse = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "send CV tonight" }
    });
    assert.equal(actionResponse.statusCode, 200);
    assert.equal(actionResponse.json().action.goalId, jobGoal.id);

    const today = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today`
    });
    assert.equal(today.statusCode, 200);
    const brief = today.json().brief;
    assert.equal(brief.openActions[0].goalTitle, "Find a new developer job");
    assert.match(brief.goalStatus[0].note, /open action: Send CV/);
    assert.ok(!brief.topPriorities.some((priority: string) => priority.includes("Log progress for Find a new developer job")));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("daily brief keeps risk-control goals out of normal progress priorities", async () => {
  const server = buildServer();
  const actionUserId = `today-risk-control-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Control impulsive betting",
      category: "finance",
      templateId: "finance.control_betting_trading",
      priority: "critical",
      importanceScore: 70
    }
  });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Read more",
      category: "learning",
      templateId: "learning.reading_more",
      priority: "low",
      importanceScore: 10
    }
  });

  try {
    const today = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today?now=${encodeURIComponent("2026-07-31T02:51:00+02:00")}`
    });
    assert.equal(today.statusCode, 200);
    const brief = today.json().brief;
    assert.ok(!brief.topPriorities.some((priority: string) => priority.includes("Log progress for Control impulsive betting")));
    assert.ok(!brief.suggestedNextStep.includes("Control impulsive betting"));
    assert.ok(brief.risks.some((risk: string) => risk.includes("Control impulsive betting")));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today top priorities contain real open actions only", async () => {
  const server = buildServer();
  const actionUserId = `today-real-priorities-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative",
      priority: "medium",
      importanceScore: 25
    }
  });
  const carGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a cheap car to buy",
      category: "custom",
      priority: "low",
      importanceScore: 10
    }
  });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Read more",
      category: "learning",
      templateId: "learning.reading_more",
      priority: "low",
      importanceScore: 10
    }
  });
  await prisma.actionItem.createMany({
    data: [
      {
        userId: actionUserId,
        source: "manual",
        title: "Write YouTube script",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T14:30:00.000Z"),
        goalId: youtubeGoal.id,
        goalTitleSnapshot: youtubeGoal.title
      },
      {
        userId: actionUserId,
        source: "manual",
        title: "Check cheap car listings",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T07:00:00.000Z"),
        goalId: carGoal.id,
        goalTitleSnapshot: carGoal.title
      }
    ]
  });

  try {
    const today = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today?now=${encodeURIComponent("2026-07-31T03:01:00+02:00")}`
    });
    assert.equal(today.statusCode, 200);
    const priorities = today.json().brief.topPriorities;
    assert.equal(priorities.length, 2);
    assert.ok(priorities.some((priority: string) => priority.includes("Write YouTube script")));
    assert.ok(priorities.some((priority: string) => priority.includes("Check cheap car listings")));
    assert.ok(!priorities.some((priority: string) => priority.includes("Log progress for Read more")));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test.before(async () => {
  await prisma.user.create({
    data: { id: userId }
  });
  await prisma.integrationConnection.create({
    data: {
      id: connectionId,
      userId,
      integrationId: "gmail",
      status: "active",
      config: { provider: "gmail" }
    }
  });
  await prisma.emailSignalRule.create({
    data: {
      id: ruleId,
      userId,
      connectionId,
      adapterId: "job_search_email",
      name: "Job search",
      status: "active",
      createdBy: "user"
    }
  });
});

test.after(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

test("archived review does not block recreation, rejected review still blocks", async () => {
  await createReview({
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    proposedEventType: "career.interview_scheduled",
    status: "archived",
    extracted: { company: "Test Labs", role: "Frontend Engineer" }
  });

  const archivedMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "job_search_email",
    provider: "gmail",
    proposedEventType: "career.interview_scheduled",
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    company: "Test Labs",
    role: "Frontend Engineer"
  });
  assert.equal(archivedMatch, undefined);

  await createReview({
    subject: "Security code for your application to Blockchain.com",
    from: "Blockchain.com <noreply@blockchain.com>",
    proposedEventType: "application_action_required",
    status: "rejected",
    extracted: { company: "Blockchain.com", actionRequired: true }
  });

  const rejectedMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "job_search_email",
    provider: "gmail",
    proposedEventType: "application_action_required",
    subject: "Security code for your application to Blockchain.com",
    from: "Blockchain.com <noreply@blockchain.com>",
    company: "Blockchain.com",
    actionRequired: true
  });
  assert.equal(rejectedMatch?.status, "rejected");
});

test("different interview subject and role do not collide", async () => {
  await createReview({
    subject: "interview ai programmer",
    from: "letis <letis.ether@gmail.com>",
    proposedEventType: "career.interview_scheduled",
    status: "pending",
    extracted: { role: "ai programmer" }
  });

  const testLabsMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "job_search_email",
    provider: "gmail",
    proposedEventType: "career.interview_scheduled",
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    company: "Test Labs",
    role: "Frontend Engineer"
  });
  assert.equal(testLabsMatch, undefined);

  await createReview({
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    proposedEventType: "career.interview_scheduled",
    status: "pending",
    extracted: { company: "Test Labs", role: "Frontend Engineer" }
  });

  const duplicateTestLabsMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "job_search_email",
    provider: "gmail",
    proposedEventType: "career.interview_scheduled",
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    company: "Test Labs",
    role: "Frontend Engineer"
  });
  assert.equal(duplicateTestLabsMatch?.status, "pending");

  const aiProgrammerMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "job_search_email",
    provider: "gmail",
    proposedEventType: "career.interview_scheduled",
    subject: "interview ai programmer",
    from: "letis <letis.ether@gmail.com>",
    role: "ai programmer"
  });
  assert.equal(aiProgrammerMatch?.status, "pending");
});

test("archived Gmail event does not block review creation, active event does", async () => {
  await prisma.event.create({
    data: {
      id: randomUUID(),
      userId,
      type: "career.interview_scheduled",
      timestamp: new Date(),
      source: "gmail",
      provider: "gmail",
      status: "archived",
      archiveReason: "cleanup gmail rule test events",
      confidence: 0.95,
      data: {
        ruleId,
        subject: "Interview for Frontend Engineer role",
        from: "letis <letis.ether@gmail.com>",
        company: "Test Labs",
        role: "Frontend Engineer"
      }
    }
  });

  const archivedEventMatch = await findGmailSemanticDuplicateEvent({
    userId,
    ruleId,
    eventType: "career.interview_scheduled",
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    company: "Test Labs",
    role: "Frontend Engineer"
  });
  assert.equal(archivedEventMatch, undefined);

  await prisma.event.create({
    data: {
      id: randomUUID(),
      userId,
      type: "career.interview_scheduled",
      timestamp: new Date(),
      source: "gmail",
      provider: "gmail",
      status: "active",
      confidence: 0.95,
      data: {
        ruleId,
        subject: "Interview for Frontend Engineer role",
        from: "letis <letis.ether@gmail.com>",
        company: "Test Labs",
        role: "Frontend Engineer"
      }
    }
  });

  const activeEventMatch = await findGmailSemanticDuplicateEvent({
    userId,
    ruleId,
    eventType: "career.interview_scheduled",
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    company: "Test Labs",
    role: "Frontend Engineer"
  });
  assert.equal(activeEventMatch?.status, "active");
});

test("Topper account email is ignored and application security code goes to review", () => {
  const topper = classifyJobSearchEmail({
    text: [
      "Subject: Update regarding your Topper account",
      "From: Topper <noreply@mail.topperpay.com>",
      "We are writing about a service disruption affecting your Topper account."
    ].join("\n"),
    classifierMode: "rules"
  });
  assert.equal(topper.decision, "ignore");

  const securityCode = classifyJobSearchEmail({
    text: [
      "Subject: Security code for your application to Blockchain.com",
      "Copy and paste this code into the security code field on your application.",
      "After you enter the code, resubmit your application."
    ].join("\n"),
    classifierMode: "rules"
  });
  assert.equal(securityCode.decision, "needs_review");
  assert.equal(securityCode.reason, "application_action_required");
});

test("work action email is review-worthy, newsletter and security code are ignored", () => {
  const action = classifyWorkActionEmail({
    text: [
      "Subject: Follow up on dashboard review",
      "From: manager@example.com",
      "Can you review the dashboard metrics by Friday and send me any issues you find?"
    ].join("\n"),
    classifierMode: "rules"
  });
  assert.equal(action.decision, "needs_review");
  assert.equal(action.eventType, "work_deadline_detected");
  assert.equal(action.extracted.actionRequired, true);

  for (const text of [
    "Subject: Confirm this login\nFrom: Moonshot Support <noreply@moonshot.com>\nPlease confirm this login attempt.",
    "Subject: We need to confirm your occupation\nFrom: Wise <noreply@wise.com>\nAction required: we need to confirm your occupation.",
    "Subject: We’re updating our Privacy Notices\nFrom: Wise <noreply@wise.com>\nWe are updating our privacy notices.",
    "Subject: Los más vendidos en las rebajas\nFrom: Coach España <marketing@coach.com>\nSale and best sellers.",
    "Subject: Boost your RevPoints balance\nFrom: Revolut <no-reply@revolut.com>\nGet more points and cashback.",
    "Subject: Get up to 100% off Stays with RevPoints\nFrom: Revolut <no-reply@revolut.com>\nPromotion for travel stays.",
    "Subject: Crypto deposit received\nFrom: Revolut <no-reply@revolut.com>\nYour crypto deposit notice.",
    "Subject: AWS re:Invent promo\nFrom: AWS <marketing@amazon.com>\nJoin our webinar and product announcement.",
    "Subject: Product update newsletter\nRead our latest release notes and unsubscribe here.",
    "Subject: Your login code\nUse this security code to sign in."
  ]) {
    const noisy = classifyWorkActionEmail({ text, classifierMode: "rules" });
    assert.equal(noisy.decision, "ignore", text);
  }
});

test("work action semantic key distinguishes project and deadline", async () => {
  await createReview({
    subject: "Follow up on project Atlas",
    from: "manager@example.com",
    proposedEventType: "work_deadline_detected",
    status: "pending",
    extracted: { project: "Atlas", deadline: "Friday", actionRequired: true },
    adapterId: "work_action_email"
  });

  const atlasMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "work_action_email",
    provider: "gmail",
    proposedEventType: "work_deadline_detected",
    subject: "Follow up on project Atlas",
    from: "manager@example.com",
    project: "Atlas",
    deadline: "Friday",
    actionRequired: true
  });
  assert.equal(atlasMatch?.status, "pending");

  const otherProjectMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "work_action_email",
    provider: "gmail",
    proposedEventType: "work_deadline_detected",
    subject: "Follow up on project Atlas",
    from: "manager@example.com",
    project: "Hermes",
    deadline: "Friday",
    actionRequired: true
  });
  assert.equal(otherProjectMatch, undefined);
});

test("approving work action review creates one ActionItem and no Event", async () => {
  const server = buildServer();
  const reviewId = await createReview({
    subject: "Follow up on dashboard review",
    from: "manager@example.com",
    proposedEventType: "work_deadline_detected",
    status: "pending",
    extracted: { project: "dashboard", deadline: "Friday", actionRequired: true },
    adapterId: "work_action_email",
    evidence: "Can you review the dashboard metrics by Friday and send me any issues you find?"
  });

  try {
    const first = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(first.statusCode, 200);
    const firstPayload = first.json();
    assert.equal(firstPayload.event, null);
    assert.equal(firstPayload.actionItem.title, "Review dashboard metrics");
    assert.equal(firstPayload.actionItem.status, "open");

    const second = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(second.statusCode, 200);
    const secondPayload = second.json();
    assert.equal(secondPayload.actionItem.id, firstPayload.actionItem.id);

    const actions = await server.inject({
      method: "GET",
      url: `/users/${userId}/actions`
    });
    assert.equal(actions.statusCode, 200);
    assert.equal(actions.json().actions.some((action: { id: string }) => action.id === firstPayload.actionItem.id), true);
  } finally {
    await server.close();
  }
});

test("work action approval title strips email headers and caps length", async () => {
  const server = buildServer();
  const reviewId = await createReview({
    subject: "Please review dashboard export",
    from: "Letis <letiskate@gmail.com>",
    proposedEventType: "work_action_required",
    status: "pending",
    extracted: { project: "dashboard", actionRequired: true },
    adapterId: "work_action_email",
    evidence: [
      "Subject: Please review dashboard export",
      "From: Letis <letiskate@gmail.com>",
      "Snippet: Can you review the dashboard export by Friday and send me any issues?",
      "Body: Can you review the dashboard export by Friday and send me any issues?"
    ].join("\n")
  });

  try {
    const first = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(first.statusCode, 200);
    const firstPayload = first.json();
    assert.equal(firstPayload.actionItem.title, "Review dashboard export");
    assert.equal(firstPayload.actionItem.title.includes("From:"), false);
    assert.equal(firstPayload.actionItem.title.includes("Subject:"), false);
    assert.equal(firstPayload.actionItem.title.includes("@"), false);
    assert.ok(firstPayload.actionItem.title.length <= 80);
    assert.equal(firstPayload.actionItem.description, "Send any issues found.");

    const second = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().actionItem.id, firstPayload.actionItem.id);
  } finally {
    await server.close();
  }
});

test("work action title prefers body action over follow-up subject", async () => {
  const server = buildServer();
  const reviewId = await createReview({
    subject: "Follow up on dashboard review",
    from: "manager@example.com",
    proposedEventType: "work_deadline_detected",
    status: "pending",
    extracted: { project: "dashboard", deadline: "Friday", actionRequired: true },
    adapterId: "work_action_email",
    evidence: [
      "Subject: Follow up on dashboard review",
      "From: manager@example.com",
      "Body: Can you review the dashboard metrics by Friday and send me any issues you find?"
    ].join("\n")
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().actionItem.title, "Review dashboard metrics");
  } finally {
    await server.close();
  }
});

test("action item lifecycle routes update status", async () => {
  const server = buildServer();
  const action = await prisma.actionItem.create({
    data: {
      userId,
      source: "manual",
      title: "Review launch checklist",
      priority: "medium"
    }
  });

  try {
    const snooze = await server.inject({
      method: "PATCH",
      url: `/users/${userId}/actions/${action.id}/snooze`,
      payload: { snoozedUntil: "2026-08-01T09:00:00.000Z" }
    });
    assert.equal(snooze.statusCode, 200);
    assert.equal(snooze.json().action.status, "snoozed");

    const complete = await server.inject({
      method: "PATCH",
      url: `/users/${userId}/actions/${action.id}/complete`
    });
    assert.equal(complete.statusCode, 200);
    assert.equal(complete.json().action.status, "completed");

    const archive = await server.inject({
      method: "PATCH",
      url: `/users/${userId}/actions/${action.id}/archive`
    });
    assert.equal(archive.statusCode, 200);
    assert.equal(archive.json().action.status, "archived");
  } finally {
    await server.close();
  }
});

test("completing linked action creates one generic goal progress event", async () => {
  const server = buildServer();
  const actionUserId = `action-complete-linked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const goal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Send CV",
      priority: "medium",
      goalId: goal.id,
      goalSlug: "career.job_search",
      goalTitleSnapshot: goal.title
    }
  });

  try {
    const first = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/complete`,
      payload: {}
    });
    assert.equal(first.statusCode, 200);
    assert.match(first.json().message, /Action completed: Send CV/);
    assert.match(first.json().message, /Goal progress logged: Find a new developer job/);

    const second = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/complete`,
      payload: {}
    });
    assert.equal(second.statusCode, 200);
    assert.match(second.json().message, /Action already completed: Send CV/);

    const events = await prisma.event.findMany({
      where: { userId: actionUserId, type: "custom.goal_progress_logged" }
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "manual");
    assert.equal(events[0].provider, "action_completion");
    assert.equal((events[0].data as { source?: string }).source, "action_completion");
    assert.equal((events[0].data as { goalId?: string }).goalId, goal.id);
    assert.equal((events[0].data as { actionItemId?: string }).actionItemId, action.id);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("completing unlinked action creates no goal progress event", async () => {
  const server = buildServer();
  const actionUserId = `action-complete-unlinked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Buy milk",
      priority: "medium"
    }
  });

  try {
    const response = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/complete`,
      payload: {}
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().message, "Action completed: Buy milk");

    const events = await prisma.event.findMany({
      where: { userId: actionUserId, type: "custom.goal_progress_logged" }
    });
    assert.equal(events.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today shows completed linked action as goal progress", async () => {
  const server = buildServer();
  const actionUserId = `today-completed-linked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const goal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative"
    }
  });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      goalId: goal.id,
      goalTitleSnapshot: goal.title
    }
  });

  try {
    const complete = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/complete`,
      payload: {}
    });
    assert.equal(complete.statusCode, 200);

    const today = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today`
    });
    assert.equal(today.statusCode, 200);
    const goalStatus = today.json().brief.goalStatus[0];
    assert.equal(goalStatus.status, "progress");
    assert.match(goalStatus.note, /completed action: Write YouTube script/);
    assert.ok(!goalStatus.note.includes("no progress logged today"));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("completing linked actions does not create fake domain events", async () => {
  const server = buildServer();
  const actionUserId = `action-complete-no-domain-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const [jobGoal, healthGoal] = await Promise.all([
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Find a new developer job",
        category: "career",
        templateId: "career.job_search"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Build strength and energy",
        category: "health",
        templateId: "health.strength_energy"
      }
    })
  ]);
  const [sendCv, trainLegs] = await Promise.all([
    prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Send CV",
        priority: "medium",
        goalId: jobGoal.id,
        goalTitleSnapshot: jobGoal.title
      }
    }),
    prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Train legs",
        priority: "medium",
        goalId: healthGoal.id,
        goalTitleSnapshot: healthGoal.title
      }
    })
  ]);

  try {
    for (const action of [sendCv, trainLegs]) {
      const response = await server.inject({
        method: "PATCH",
        url: `/users/${actionUserId}/actions/${action.id}/complete`,
        payload: {}
      });
      assert.equal(response.statusCode, 200);
    }

    const [progressEvents, applicationEvents, workoutEvents] = await Promise.all([
      prisma.event.findMany({ where: { userId: actionUserId, type: "custom.goal_progress_logged" } }),
      prisma.event.findMany({ where: { userId: actionUserId, type: "career.application_sent" } }),
      prisma.event.findMany({ where: { userId: actionUserId, type: "health.workout_completed" } })
    ]);
    assert.equal(progressEvents.length, 2);
    assert.equal(applicationEvents.length, 0);
    assert.equal(workoutEvents.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("approving core career review still creates Event", async () => {
  const server = buildServer();
  const reviewId = await createReview({
    subject: "Interview for Backend Engineer role",
    from: "recruiter@example.com",
    proposedEventType: "career.interview_scheduled",
    status: "pending",
    extracted: { company: "Example Co", role: "Backend Engineer" },
    evidence: "We would like to schedule an interview next week."
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.event.type, "career.interview_scheduled");
    assert.equal(payload.actionItem, undefined);
  } finally {
    await server.close();
  }
});

test("unsupported non-core review creates no Event or ActionItem", async () => {
  const server = buildServer();
  const reviewId = await createReview({
    subject: "Application action required",
    from: "jobs@example.com",
    proposedEventType: "application_action_required",
    status: "pending",
    extracted: { company: "Example Co", actionRequired: true },
    evidence: "Complete your application."
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.event, null);
    assert.match(payload.message, /does not map to an approved event type/);
  } finally {
    await server.close();
  }
});

test("/today returns safe empty brief", async () => {
  const server = buildServer();
  const briefUserId = `brief-empty-${randomUUID()}`;
  await prisma.user.create({ data: { id: briefUserId } });

  try {
    const response = await server.inject({
      method: "GET",
      url: `/users/${briefUserId}/today`
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.brief.openActions.length, 0);
    assert.equal(payload.brief.overdueActions.length, 0);
    assert.equal(payload.brief.suggestedNextStep, "Log one meaningful action.");
    assert.equal(JSON.stringify(payload).includes("accessToken"), false);
    assert.equal(JSON.stringify(payload).includes("refreshToken"), false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: briefUserId } });
  }
});

test("/today shows open, completed, overdue action items and picks overdue first", async () => {
  const server = buildServer();
  const briefUserId = `brief-actions-${randomUUID()}`;
  await prisma.user.create({ data: { id: briefUserId } });

  const overdue = await prisma.actionItem.create({
    data: {
      userId: briefUserId,
      source: "manual",
      title: "Send dashboard issues",
      priority: "high",
      dueAt: new Date(Date.now() - 60 * 60 * 1000)
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: briefUserId,
      source: "manual",
      title: "Review product notes",
      priority: "medium"
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: briefUserId,
      source: "manual",
      title: "Finished earlier task",
      status: "completed",
      priority: "medium",
      completedAt: new Date()
    }
  });

  try {
    const response = await server.inject({
      method: "GET",
      url: `/users/${briefUserId}/today`
    });
    assert.equal(response.statusCode, 200);
    const brief = response.json().brief;
    assert.equal(brief.overdueActions[0].id, overdue.id);
    assert.match(brief.topPriorities[0], /Overdue: Send dashboard issues/);
    assert.equal(brief.recentWins.includes("Completed action: Finished earlier task"), true);
    assert.equal(brief.suggestedNextStep, "Handle overdue action: Send dashboard issues.");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: briefUserId } });
  }
});

test("/today shows goal progress and betting cooldown risk", async () => {
  const server = buildServer();
  const briefUserId = `brief-events-${randomUUID()}`;
  await prisma.user.create({ data: { id: briefUserId } });
  await prisma.goal.create({
    data: {
      userId: briefUserId,
      title: "Find a new job",
      category: "career",
      templateId: "career.job_search"
    }
  });
  await prisma.goal.create({
    data: {
      userId: briefUserId,
      title: "Control impulsive betting",
      category: "finance",
      templateId: "finance.control_betting_trading"
    }
  });
  await prisma.event.create({
    data: {
      userId: briefUserId,
      type: "career.application_sent",
      timestamp: new Date(),
      source: "manual",
      data: { count: 1 },
      confidence: 0.9
    }
  });
  await prisma.event.create({
    data: {
      userId: briefUserId,
      type: "finance.betting.cooldown_triggered",
      timestamp: new Date(),
      source: "manual",
      data: { reason: "red_risk_state" },
      confidence: 1
    }
  });

  try {
    const response = await server.inject({
      method: "GET",
      url: `/users/${briefUserId}/today`
    });
    assert.equal(response.statusCode, 200);
    const brief = response.json().brief;
    const jobStatus = brief.goalStatus.find((status: { title: string }) => status.title === "Find a new job");
    const riskStatus = brief.goalStatus.find((status: { title: string }) => status.title === "Control impulsive betting");
    assert.equal(jobStatus?.note, "1 application sent today");
    assert.equal(riskStatus?.note, "guardrail triggered today, no betting actions created");
    assert.equal(brief.risks.some((risk: string) => risk.includes("Betting impulse detected recently")), true);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: briefUserId } });
  }
});

test("manual action API creates titled action with due parsing", async () => {
  const server = buildServer();
  const actionUserId = `action-api-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "review homepage copy tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.action.title, "Review homepage copy");
    assert.equal(payload.extraction.dueText, "tomorrow");
    assert.ok(payload.action.dueAt);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("natural action due parser supports day parts and explicit times", () => {
  const now = new Date("2026-07-30T01:00:00");
  const preferences = {
    timezone: "Europe/Madrid",
    defaultActionTimeMinutes: 540,
    morningTimeMinutes: 510,
    afternoonTimeMinutes: 900,
    eveningTimeMinutes: 1140,
    tonightTimeMinutes: 1260
  };

  assert.equal(localMinutes(parseActionDueDate("call Alex tomorrow", { now, preferences }).dueAt), 540);
  assert.equal(localMinutes(parseActionDueDate("call Alex tomorrow afternoon", { now, preferences }).dueAt), 900);
  assert.equal(localMinutes(parseActionDueDate("call Alex tomorrow evening", { now, preferences }).dueAt), 1140);
  assert.equal(localMinutes(parseActionDueDate("send CV tonight", { now, preferences }).dueAt), 1260);
  assert.equal(localMinutes(parseActionDueDate("review homepage tomorrow at 6pm", { now, preferences }).dueAt), 1080);
  assert.equal(localMinutes(parseActionDueDate("pay rent Friday morning", { now, preferences }).dueAt), 510);
  assert.equal(localMinutes(parseActionDueDate("follow up in 2 days", { now, preferences }).dueAt), 540);
});

test("natural action due parser avoids vague past times and rejects explicit past", () => {
  const now = new Date("2026-07-30T11:00:00+02:00");
  const lateNow = new Date("2026-07-30T22:00:00+02:00");
  const preferences = {
    timezone: "Europe/Madrid",
    defaultActionTimeMinutes: 540,
    morningTimeMinutes: 540,
    afternoonTimeMinutes: 900,
    eveningTimeMinutes: 1140,
    tonightTimeMinutes: 1200
  };

  const today = parseActionDueDate("call Alex today", { now, preferences });
  assert.ok(today.dueAt && today.dueAt > now);
  assert.equal(minutesBetween(now, today.dueAt), 15);

  const todayMorning = parseActionDueDate("call Alex today morning", { now, preferences });
  assert.ok(todayMorning.dueAt && todayMorning.dueAt > now);
  assert.equal(minutesBetween(now, todayMorning.dueAt), 15);

  const thisMorning = parseActionDueDate("call Alex this morning", { now, preferences });
  assert.ok(thisMorning.dueAt && thisMorning.dueAt > now);
  assert.equal(minutesBetween(now, thisMorning.dueAt), 15);

  const todayAfternoon = parseActionDueDate("call Alex today afternoon", { now, preferences });
  assert.ok(todayAfternoon.dueAt && todayAfternoon.dueAt > now);
  assert.equal(localMinutes(todayAfternoon.dueAt), 900);

  const tonight = parseActionDueDate("call Alex tonight", { now, preferences });
  assert.ok(tonight.dueAt && tonight.dueAt > now);
  assert.equal(localMinutes(tonight.dueAt), 1200);

  const lateTonight = parseActionDueDate("call Alex tonight", { now: lateNow, preferences });
  assert.ok(lateTonight.dueAt && lateTonight.dueAt > lateNow);
  assert.equal(localMinutes(lateTonight.dueAt), 1200);
  assert.equal(localDate(lateTonight.dueAt), "2026-07-31");

  const explicitPast = parseActionDueDate("call Alex today at 9am", { now, preferences });
  assert.equal(explicitPast.dueAt, null);
  assert.equal(explicitPast.invalidReason, "past_explicit_time");

  const dmyExplicitPast = parseActionDueDate("call Alex 30/07/2026 at 09:00", { now, preferences });
  assert.equal(dmyExplicitPast.dueAt, null);
  assert.equal(dmyExplicitPast.invalidReason, "past_explicit_time");

  const ymdExplicitPast = parseActionDueDate("call Alex 2026-07-30 09:00", { now, preferences });
  assert.equal(ymdExplicitPast.dueAt, null);
  assert.equal(ymdExplicitPast.invalidReason, "past_explicit_time");

  const nowDue = parseActionDueDate("call Alex now", { now, preferences });
  assert.ok(nowDue.dueAt && nowDue.dueAt.getTime() === now.getTime());

  const atNowDue = parseActionDueDate("call Alex at now", { now, preferences });
  assert.ok(atNowDue.dueAt && atNowDue.dueAt.getTime() === now.getTime());
});

test("manual action uses reminder preferences and strips natural time from title", async () => {
  const server = buildServer();
  const actionUserId = `action-prefs-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: actionUserId,
      defaultActionTimeMinutes: 600,
      afternoonTimeMinutes: 960,
      timezone: "Europe/Madrid"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "review homepage tomorrow afternoon" }
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.action.title, "Review homepage");
    assert.equal(payload.extraction.dueText, "tomorrow afternoon");
    assert.equal(localMinutes(new Date(payload.action.dueAt)), 960);
    assert.doesNotMatch(payload.message, /T\d{2}:\d{2}:\d{2}/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("notification settings accept valid reminder time minutes and reject invalid values", async () => {
  const server = buildServer();
  const actionUserId = `action-settings-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const valid = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/notification-settings`,
      payload: { morningTimeMinutes: 480 }
    });
    assert.equal(valid.statusCode, 200);
    assert.equal(valid.json().notificationSettings.morningTimeMinutes, 480);

    const invalid = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/notification-settings`,
      payload: { morningTimeMinutes: 1500 }
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("manual action route rejects explicit past time and accepts now", async () => {
  const server = buildServer();
  const actionUserId = `action-past-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const past = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: `review homepage ${yesterdayLocalDate()} at 09:00` }
    });
    assert.equal(past.statusCode, 400);
    assert.equal(past.json().error, "That time has already passed. Use a future time, or say 'now'.");

    const nowAction = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "test at now" }
    });
    assert.equal(nowAction.statusCode, 200);
    assert.equal(nowAction.json().action.title, "Test");
    assert.ok(new Date(nowAction.json().action.dueAt) > new Date(Date.now() - 60_000));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("standalone now gets neutral scheduling prompt", async () => {
  const server = buildServer();
  const actionUserId = `action-now-standalone-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "now" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "What should I schedule now? Example: /action call Alex now");

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("snooze route avoids vague past times and rejects explicit past time", async () => {
  const server = buildServer();
  const actionUserId = `action-snooze-past-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: actionUserId,
      morningTimeMinutes: 1,
      timezone: "Europe/Madrid"
    }
  });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium"
    }
  });

  try {
    const vaguePast = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/snooze`,
      payload: { snoozeText: "today morning" }
    });
    assert.equal(vaguePast.statusCode, 200);
    assert.ok(new Date(vaguePast.json().action.snoozedUntil) > new Date());

    const explicitPast = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/snooze`,
      payload: { snoozeText: `${yesterdayLocalDate()} at 09:00` }
    });
    assert.equal(explicitPast.statusCode, 400);
    assert.equal(explicitPast.json().error, "That snooze time has already passed.");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("snooze route accepts now and makes action remindable", async () => {
  const server = buildServer();
  const actionUserId = `action-snooze-now-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium"
    }
  });

  try {
    const snoozed = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/snooze`,
      payload: { snoozeText: "now" }
    });
    assert.equal(snoozed.statusCode, 200);

    const reminder = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/reminders/trigger`
    });
    assert.equal(reminder.statusCode, 200);
    assert.equal(reminder.json().sent, 1);
    assert.match(reminder.json().message, /Snoozed action is back:/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("todo text creates action and strips tonight from title", async () => {
  const server = buildServer();
  const actionUserId = `action-todo-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "todo: apply to 2 jobs tonight" }
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.action.title, "Apply to 2 jobs");
    assert.equal(payload.extraction.dueText, "tonight");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("natural concrete action message creates ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-natural-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "I need to review homepage copy tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action created/);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Review homepage copy");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("unrelated natural action message creates unlinked ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-natural-unlinked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "I need to buy milk tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action created/);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Buy milk");
    assert.equal(actions[0].goalId, null);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("manual action command and natural text with article dedupe to one open action", async () => {
  const server = buildServer();
  const actionUserId = `action-article-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const command = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "review homepage copy tomorrow" }
    });
    assert.equal(command.statusCode, 200);
    assert.equal(command.json().action.title, "Review homepage copy");

    const natural = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "I need to review the homepage copy tomorrow" }
    });
    assert.equal(natural.statusCode, 200);
    assert.match(natural.json().reply, /Action already exists: Review homepage copy/);

    const actions = await prisma.actionItem.findMany({
      where: { userId: actionUserId, status: { in: ["open", "snoozed"] } }
    });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Review homepage copy");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("manual action title key treats optional articles as same task", () => {
  assert.equal(normalizeManualActionTitleKey("Review homepage copy"), normalizeManualActionTitleKey("Review the homepage copy"));
});

test("same manual task dedupes by local due date and time", async () => {
  const server = buildServer();
  const actionUserId = `action-day-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Review homepage copy",
      priority: "medium",
      dueAt: new Date("2026-08-03T07:00:00.000Z")
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "I need to review the homepage copy 2026-08-03" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().duplicate, true);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 1);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("same manual task does not dedupe across different due time buckets", async () => {
  const server = buildServer();
  const actionUserId = `action-time-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const morning = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "call Alex tomorrow morning" }
    });
    assert.equal(morning.statusCode, 200);

    const evening = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "call Alex tomorrow evening" }
    });
    assert.equal(evening.statusCode, 200);
    assert.equal(evening.json().duplicate, false);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 2);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today does not duplicate due-soon action in top priorities", async () => {
  const server = buildServer();
  const actionUserId = `today-priority-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Review homepage copy",
      priority: "medium",
      dueAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  });

  try {
    const response = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today`
    });
    assert.equal(response.statusCode, 200);
    const priorities = response.json().brief.topPriorities as string[];
    assert.equal(priorities.filter((priority) => priority.includes("Review homepage copy")).length, 1);
    assert.equal(priorities[0], "Due soon: Review homepage copy");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("daily priority scorer ranks goal-linked action above unlinked chore with same due window", () => {
  const now = new Date(2026, 6, 30, 4, 30);
  const dueAt = new Date(2026, 6, 31, 9, 0);
  const goal = {
    id: "goal-job",
    userId: "score-user",
    title: "Find a new developer job",
    category: "career",
    status: "active" as const,
    templateId: "career.job_search",
    createdAt: now,
    updatedAt: now
  };
  const ranked = sortDailyActionsByPriority(
    [
      {
        id: "milk",
        userId: "score-user",
        source: "manual",
        title: "Buy milk",
        status: "open",
        priority: "medium",
        dueAt,
        createdAt: now,
        updatedAt: now
      },
      {
        id: "jobs",
        userId: "score-user",
        source: "manual",
        title: "Apply to 2 jobs",
        status: "open",
        priority: "medium",
        dueAt,
        goalId: goal.id,
        goalTitleSnapshot: goal.title,
        createdAt: now,
        updatedAt: now
      }
    ],
    {
      goals: [goal],
      goalStatuses: [{ goalId: goal.id, hasProgressToday: false, hasCompletedActionToday: false, hasOpenAction: true }],
      recentEvents: [],
      now
    }
  );

  assert.equal(ranked[0].action.id, "jobs");
  assert.ok(ranked[0].score.score > ranked[1].score.score);
  assert.match(ranked[0].score.rankReason, /goal-linked/);
});

test("daily priority scorer keeps true urgency and manual high priority", () => {
  const now = new Date(2026, 6, 30, 4, 30);
  const goal = {
    id: "goal-job",
    userId: "score-user",
    title: "Find a new developer job",
    category: "career",
    status: "active" as const,
    templateId: "career.job_search",
    createdAt: now,
    updatedAt: now
  };
  const overdueChore = {
    id: "milk",
    userId: "score-user",
    source: "manual" as const,
    title: "Buy milk",
    status: "open" as const,
    priority: "medium" as const,
    dueAt: new Date(2026, 6, 29, 9, 0),
    createdAt: now,
    updatedAt: now
  };
  const tomorrowGoalAction = {
    id: "jobs",
    userId: "score-user",
    source: "manual" as const,
    title: "Apply to 2 jobs",
    status: "open" as const,
    priority: "medium" as const,
    dueAt: new Date(2026, 6, 31, 9, 0),
    goalId: goal.id,
    goalTitleSnapshot: goal.title,
    createdAt: now,
    updatedAt: now
  };
  const highPriorityChore = {
    ...overdueChore,
    id: "urgent-admin",
    title: "Pay rent",
    priority: "high" as const,
    dueAt: new Date(2026, 6, 31, 9, 0)
  };

  const overdueRanked = sortDailyActionsByPriority([tomorrowGoalAction, overdueChore], {
    goals: [goal],
    goalStatuses: [{ goalId: goal.id, hasProgressToday: false, hasCompletedActionToday: false, hasOpenAction: true }],
    recentEvents: [],
    now
  });
  assert.equal(overdueRanked[0].action.id, "milk");

  const lowGoal = {
    ...goal,
    id: "goal-low",
    title: "Find a cheap car to buy",
    category: "custom",
    templateId: undefined,
    priority: "low" as const,
    importanceScore: 10
  };
  const lowGoalAction = {
    ...tomorrowGoalAction,
    id: "car",
    title: "Check cheap car listings",
    goalId: lowGoal.id,
    goalTitleSnapshot: lowGoal.title
  };
  const highPriorityRanked = sortDailyActionsByPriority([lowGoalAction, highPriorityChore], {
    goals: [lowGoal],
    goalStatuses: [{ goalId: lowGoal.id, hasProgressToday: false, hasCompletedActionToday: false, hasOpenAction: true }],
    recentEvents: [],
    now
  });
  assert.equal(highPriorityRanked[0].action.id, "urgent-admin");
});

test("daily priority scorer reduces job-search boost after progress and ignores completed actions", () => {
  const now = new Date(2026, 6, 30, 4, 30);
  const dueAt = new Date(2026, 6, 31, 9, 0);
  const goal = {
    id: "goal-job",
    userId: "score-user",
    title: "Find a new developer job",
    category: "career",
    status: "active" as const,
    templateId: "career.job_search",
    createdAt: now,
    updatedAt: now
  };
  const openAction = {
    id: "jobs",
    userId: "score-user",
    source: "manual" as const,
    title: "Apply to 2 jobs",
    status: "open" as const,
    priority: "medium" as const,
    dueAt,
    goalId: goal.id,
    goalTitleSnapshot: goal.title,
    createdAt: now,
    updatedAt: now
  };
  const completedAction = {
    ...openAction,
    id: "completed-jobs",
    title: "Send CV",
    status: "completed" as const,
    completedAt: now
  };

  const noProgressScore = sortDailyActionsByPriority([openAction], {
    goals: [goal],
    goalStatuses: [{ goalId: goal.id, hasProgressToday: false, hasCompletedActionToday: false, hasOpenAction: true }],
    recentEvents: [],
    now
  })[0].score.score;
  const withProgressScore = sortDailyActionsByPriority([openAction], {
    goals: [goal],
    goalStatuses: [{ goalId: goal.id, hasProgressToday: true, hasCompletedActionToday: true, hasOpenAction: true }],
    recentEvents: [],
    now
  })[0].score.score;

  assert.ok(noProgressScore > withProgressScore);
  assert.equal(
    sortDailyActionsByPriority([completedAction], {
      goals: [goal],
      goalStatuses: [{ goalId: goal.id, hasProgressToday: true, hasCompletedActionToday: true, hasOpenAction: false }],
      recentEvents: [],
      now
    })[0].score.score,
    -1000
  );
});

test("/today ranks goal-linked priorities above same-window chores and exposes debug scores", async () => {
  const server = buildServer();
  const actionUserId = `today-scored-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000);
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Buy milk",
      priority: "medium",
      dueAt
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      dueAt,
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });
  await prisma.event.create({
    data: {
      userId: actionUserId,
      type: "finance.betting.cooldown_triggered",
      timestamp: new Date(),
      source: "manual",
      data: {},
      confidence: 1
    }
  });

  try {
    const response = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today`
    });
    assert.equal(response.statusCode, 200);
    const brief = response.json().brief;
    assert.equal(brief.openActions[0].title, "Apply to 2 jobs");
    assert.match(brief.topPriorities[0], /Apply to 2 jobs/);
    assert.equal(brief.suggestedNextStep, "Handle due action: Apply to 2 jobs.");
    assert.ok(brief.risks.some((risk: string) => risk.includes("Betting impulse detected")));

    const debug = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today/debug-priorities`
    });
    assert.equal(debug.statusCode, 200);
    const priorities = debug.json().priorities;
    assert.equal(priorities[0].title, "Apply to 2 jobs");
    assert.match(priorities[0].rankReason, /goal-linked/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today uses user timezone for local day and due-window priority reasons", async () => {
  const server = buildServer();
  const actionUserId = `today-timezone-${randomUUID()}`;
  const now = new Date("2026-07-30T23:40:00.000Z");
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: actionUserId,
      timezone: "Europe/Madrid"
    }
  });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "critical",
      importanceScore: 70
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      dueAt: new Date("2026-07-31T07:00:00.000Z"),
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      dueAt: new Date("2026-07-31T14:30:00.000Z")
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Send CV",
      status: "completed",
      priority: "medium",
      completedAt: new Date("2026-07-30T23:20:00.000Z"),
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });
  await prisma.event.createMany({
    data: [
      {
        userId: actionUserId,
        type: "career.application_sent",
        timestamp: new Date("2026-07-30T23:30:00.000Z"),
        source: "manual",
        data: { count: 1 },
        confidence: 1
      },
      {
        userId: actionUserId,
        type: "health.workout_completed",
        timestamp: new Date("2026-07-30T21:30:00.000Z"),
        source: "manual",
        data: { duration_minutes: 30 },
        confidence: 1
      }
    ]
  });

  try {
    const range = getLocalTodayRange(now, "Europe/Madrid");
    assert.equal(range.date, "2026-07-31");
    assert.equal(range.start.toISOString(), "2026-07-30T22:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-07-31T22:00:00.000Z");
    assert.equal(classifyDueWindow(new Date("2026-07-31T07:00:00.000Z"), now, "Europe/Madrid"), "due today morning");
    assert.equal(classifyDueWindow(new Date("2026-07-31T14:30:00.000Z"), now, "Europe/Madrid"), "due today afternoon");

    const response = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today?now=${encodeURIComponent(now.toISOString())}`
    });
    assert.equal(response.statusCode, 200);
    const brief = response.json().brief;
    assert.equal(brief.date, "2026-07-31");
    assert.match(brief.summary, /1 event logged today/);
    assert.equal(brief.coach.nextMove, brief.suggestedNextStep);
    assert.match(brief.coach.diagnosis, /Apply to 2 jobs/);
    assert.ok(brief.goalStatus.some((goal: { title: string; note: string }) => goal.title === "Find a new developer job" && goal.note.includes("1 application sent today")));
    assert.ok(brief.goalStatus.some((goal: { title: string; note: string }) => goal.title === "Find a new developer job" && goal.note.includes("completed action: Send CV")));
    assert.ok(brief.recentWins.some((win: string) => win.includes("Completed action: Send CV")));
    assert.ok(!brief.recentWins.some((win: string) => win.includes("Training logged")));

    const debug = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today/debug-priorities?now=${encodeURIComponent(now.toISOString())}`
    });
    assert.equal(debug.statusCode, 200);
    const reasons = debug.json().priorities.map((priority: { rankReason: string }) => priority.rankReason).join("\n");
    assert.match(reasons, /due today morning/);
    assert.match(reasons, /due today afternoon/);
    assert.doesNotMatch(reasons, /due tomorrow/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("daily coach fallback and validation stay locked to verified brief context", () => {
  const context = {
    date: "2026-07-31",
    timezone: "Europe/Madrid",
    activeGoals: [
      {
        id: "goal-job",
        title: "Find a new developer job",
        priority: "critical" as const,
        importanceScore: 70,
        statusToday: "no progress logged today",
        openLinkedActions: ["Apply to 2 jobs"],
        completedLinkedActionsToday: [],
        guardrailActivityToday: []
      }
    ],
    scoredPriorities: [
      {
        actionId: "action-job",
        title: "Apply to 2 jobs",
        dueAt: "2026-07-31T07:00:00.000Z",
        dueLabel: "due today morning",
        score: 125,
        rankReason: "due today morning, goal-linked, critical goal",
        linkedGoalTitle: "Find a new developer job",
        linkedGoalPriority: "critical" as const
      }
    ],
    recentWins: [],
    risksOrWatchouts: ["Betting impulse detected recently. Do not open a bet today without cooldown."],
    nextMove: "Handle due action: Apply to 2 jobs.",
    userOperatingProfile: {
      directness: 5,
      warmth: 3,
      confrontation: 5,
      verbosity: 3,
      preferredStyle: "tough_love"
    }
  };

  const fallback = buildDeterministicDailyCoachResponse(context);
  assert.equal(fallback.nextMove, context.nextMove);
  assert.match(fallback.diagnosis, /Apply to 2 jobs/);
  assert.equal(fallback.warning, "Keep the betting/trading guardrail locked today.");

  const valid = validateDailyCoachResponseAgainstContext(
    {
      diagnosis: "Apply to 2 jobs is the first move because it supports Find a new developer job today with a clear, bounded action and no extra tracks. Keep the output factual, then stop adding complexity.",
      nextMove: "Apply to 2 jobs first.",
      warning: "Keep the betting/trading guardrail locked today.",
      encouragement: null
    },
    context
  );
  assert.equal(valid.nextMove, "Apply to 2 jobs first.");
  assert.ok(JSON.stringify(valid).length > 270);

  assert.throws(
    () =>
      validateDailyCoachResponseAgainstContext(
        {
          diagnosis: "You've completed two job applications recently.",
          nextMove: "Apply to 2 jobs first.",
          warning: null,
          encouragement: null
        },
        {
          ...context,
          recentWins: ["Completed action: Apply to 2 jobs"],
          activeGoals: context.activeGoals.map((goal) => ({
            ...goal,
            statusToday: "completed action: Apply to 2 jobs",
            completedLinkedActionsToday: ["Apply to 2 jobs"]
          }))
        }
      ),
    /Daily coach response failed validation/
  );

  assert.equal(
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "Two applications were sent today.",
        nextMove: "Apply to 2 jobs first.",
        warning: null,
        encouragement: null
      },
      {
        ...context,
        recentWins: ["2 applications sent"],
        activeGoals: context.activeGoals.map((goal) => ({ ...goal, statusToday: "2 applications sent today" }))
      }
    ).diagnosis,
    "Two applications were sent today."
  );

  assert.equal(deterministicDailyCoachWarning(context), "Keep the betting/trading guardrail locked today.");

  assert.equal(
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "Apply to 2 jobs is the first move.",
        nextMove: "Apply to 2 jobs first.",
        warning: "Do not bet today.",
        encouragement: null
      },
      context
    ).warning,
    "Do not bet today."
  );

  assert.throws(() =>
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "Call investor first.",
        nextMove: "Handle due action: Apply to 2 jobs.",
        warning: null,
        encouragement: null
      },
      context
    )
  );

  assert.throws(() =>
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "The day is clear.",
        nextMove: "Write YouTube script.",
        warning: null,
        encouragement: null
      },
      context
    )
  );

  assert.throws(() =>
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "The day is clear.",
        nextMove: "Handle due action: Apply to 2 jobs.",
        warning: "Only bet if your thesis is strong.",
        encouragement: null
      },
      context
    )
  );

  assert.throws(() =>
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "The day is clear.",
        nextMove: "Handle due action: Apply to 2 jobs.",
        warning: "Trade small with a stop loss.",
        encouragement: null
      },
      context
    )
  );
});

test("daily coach debug reports disabled, llm, invalid, error, and timeout sources", async () => {
  const originalEnv = {
    DAILY_COACH_LLM_ENABLED: process.env.DAILY_COACH_LLM_ENABLED,
    DAILY_COACH_LLM_MOCK_RESPONSE: process.env.DAILY_COACH_LLM_MOCK_RESPONSE,
    DAILY_COACH_LLM_MOCK_THROW: process.env.DAILY_COACH_LLM_MOCK_THROW,
    DAILY_COACH_LLM_MOCK_DELAY_MS: process.env.DAILY_COACH_LLM_MOCK_DELAY_MS,
    DAILY_COACH_LLM_TIMEOUT_MS: process.env.DAILY_COACH_LLM_TIMEOUT_MS,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };
  const server = buildServer();
  const actionUserId = `daily-coach-debug-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: actionUserId,
      timezone: "Europe/Madrid"
    }
  });
  const goal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "critical",
      importanceScore: 70
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      dueAt: new Date("2026-07-31T07:00:00.000Z"),
      goalId: goal.id,
      goalTitleSnapshot: goal.title
    }
  });
  const path = `/users/${actionUserId}/today/debug-daily-coach?now=${encodeURIComponent("2026-07-30T23:40:00.000Z")}`;

  const clearMockEnv = () => {
    delete process.env.DAILY_COACH_LLM_MOCK_RESPONSE;
    delete process.env.DAILY_COACH_LLM_MOCK_THROW;
    delete process.env.DAILY_COACH_LLM_MOCK_DELAY_MS;
    delete process.env.DAILY_COACH_LLM_TIMEOUT_MS;
  };

  try {
    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "false";
    process.env.OPENAI_API_KEY = "test-key";
    let response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_disabled");
    assert.equal(response.json().schemaValidationPassed, true);

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "Apply to 2 jobs is the first move because it supports Find a new developer job.",
      nextMove: "Apply to 2 jobs first.",
      warning: null,
      encouragement: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "llm");
    assert.equal(response.json().llmEnabled, true);
    assert.equal(response.json().llmAttempted, true);
    assert.equal(response.json().validationStatus, "passed");
    assert.deepEqual(response.json().validationFailureCodes, []);
    assert.equal(response.json().schemaValidationPassed, true);
    assert.equal(response.json().selectedNextMove, "Handle due action: Apply to 2 jobs.");
    assert.equal(response.json().selectedActionTitle, "Apply to 2 jobs");
    assert.equal(response.json().topPriorities[0].title, "Apply to 2 jobs");
    assert.equal(
      response.json().topPriorities[0].rankReason.split(", ").filter((factor: string) => factor === "no job-search progress").length,
      1
    );

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = "This is prose, not JSON.";
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_invalid");
    assert.equal(response.json().validationStatus, "failed");
    assert.deepEqual(response.json().validationFailureCodes, ["invalid_json"]);
    assert.equal(response.json().schemaValidationPassed, false);
    assert.equal(response.json().validationFailureSummary, "invalid_json");
    assert.equal(response.json().rawResponseType, "text");

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "Apply to 2 jobs is the first move.",
      nextMove: "Apply to 2 jobs first.",
      warning: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_invalid");
    assert.deepEqual(response.json().validationFailureCodes, ["schema_missing_field"]);
    assert.deepEqual(response.json().parsedFieldsPresent, ["diagnosis", "nextMove", "warning"]);
    assert.equal(typeof response.json().diagnosisLength, "number");
    assert.equal(typeof response.json().nextMoveLength, "number");

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "The day is clear.",
      nextMove: "Start with the YouTube script.",
      warning: null,
      encouragement: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_invalid");
    assert.ok(response.json().validationFailureCodes.includes("next_move_mismatch"));

    const todayAfterInvalid = await server.inject({ method: "GET", url: `/users/${actionUserId}/today?now=${encodeURIComponent("2026-07-30T23:40:00.000Z")}` });
    assert.equal(todayAfterInvalid.statusCode, 200);
    assert.equal(todayAfterInvalid.json().brief.coachDebug.source, "fallback_invalid");
    assert.equal(todayAfterInvalid.json().brief.coach.nextMove, "Handle due action: Apply to 2 jobs.");

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "The day is clear.",
      nextMove: "Apply to 2 jobs first.",
      warning: "Open a trade with small size.",
      encouragement: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_invalid");
    assert.ok(response.json().validationFailureCodes.includes("unsafe_guardrail_advice"));

    const riskGoal = await prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting_trading",
        priority: "critical",
        importanceScore: 70
      }
    });
    await prisma.event.create({
      data: {
        userId: actionUserId,
        type: "finance.betting.cooldown_triggered",
        timestamp: new Date("2026-07-30T23:30:00.000Z"),
        source: "manual",
        data: { goalId: riskGoal.id },
        confidence: 1
      }
    });
    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "Apply to 2 jobs is still the first move.",
      nextMove: "Apply to 2 jobs first.",
      warning: "Only bet if your thesis is strong.",
      encouragement: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "llm");
    assert.deepEqual(response.json().validationFailureCodes, []);
    const riskToday = await server.inject({ method: "GET", url: `/users/${actionUserId}/today?now=${encodeURIComponent("2026-07-30T23:40:00.000Z")}` });
    assert.equal(riskToday.statusCode, 200);
    assert.equal(riskToday.json().brief.coach.warning, "Keep the Control impulsive betting guardrail locked today.");

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_THROW = "true";
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_error");
    assert.equal(response.json().schemaValidationPassed, false);

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_TIMEOUT_MS = "1";
    process.env.DAILY_COACH_LLM_MOCK_DELAY_MS = "20";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "Apply to 2 jobs is the first move because it supports Find a new developer job.",
      nextMove: "Handle due action: Apply to 2 jobs.",
      warning: null,
      encouragement: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_timeout");
    assert.equal(response.json().schemaValidationPassed, false);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("goal priority weights rank critical over medium and medium over low with same due window", () => {
  const now = new Date(2026, 6, 30, 4, 30);
  const dueAt = new Date(2026, 6, 31, 9, 0);
  const criticalGoal = {
    id: "goal-critical",
    userId: "score-user",
    title: "Find a new developer job",
    category: "career",
    status: "active" as const,
    templateId: "career.job_search",
    priority: "critical" as const,
    importanceScore: 70,
    createdAt: now,
    updatedAt: now
  };
  const mediumGoal = {
    id: "goal-medium",
    userId: "score-user",
    title: "Build a YouTube channel",
    category: "creative",
    status: "active" as const,
    priority: "medium" as const,
    importanceScore: 25,
    createdAt: now,
    updatedAt: now
  };
  const lowGoal = {
    id: "goal-low",
    userId: "score-user",
    title: "Find a cheap car to buy",
    category: "custom",
    status: "active" as const,
    priority: "low" as const,
    importanceScore: 10,
    createdAt: now,
    updatedAt: now
  };
  const action = (id: string, title: string, goal: typeof criticalGoal | typeof mediumGoal | typeof lowGoal) => ({
    id,
    userId: "score-user",
    source: "manual" as const,
    title,
    status: "open" as const,
    priority: "medium" as const,
    dueAt,
    goalId: goal.id,
    goalTitleSnapshot: goal.title,
    createdAt: now,
    updatedAt: now
  });
  const goals = [lowGoal, mediumGoal, criticalGoal];
  const ranked = sortDailyActionsByPriority(
    [
      action("car", "Check cheap car listings", lowGoal),
      action("youtube", "Write YouTube script", mediumGoal),
      action("jobs", "Apply to 2 jobs", criticalGoal)
    ],
    {
      goals,
      goalStatuses: goals.map((goal) => ({
        goalId: goal.id,
        hasProgressToday: false,
        hasCompletedActionToday: false,
        hasOpenAction: true
      })),
      recentEvents: [],
      now
    }
  );

  assert.deepEqual(ranked.map((item) => item.action.id), ["jobs", "youtube", "car"]);
  assert.match(ranked[0].score.rankReason, /critical goal/);
  assert.match(ranked[1].score.rankReason, /medium goal/);
  assert.match(ranked[2].score.rankReason, /low goal/);
});

test("/goal priorities routes list, update, backfill, and /today uses weighted scorer", async () => {
  const server = buildServer();
  const actionUserId = `goal-priority-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "medium",
      importanceScore: 25
    }
  });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative",
      priority: "medium",
      importanceScore: 25
    }
  });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000);
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      dueAt,
      goalId: youtubeGoal.id,
      goalTitleSnapshot: youtubeGoal.title
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      dueAt,
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });

  try {
    const update = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/goals/priority`,
      payload: { goal: jobGoal.id, priority: "critical" }
    });
    assert.equal(update.statusCode, 200);
    assert.equal(update.json().goal.priority, "critical");

    const list = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/goals/priorities`
    });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().goals.some((goal: { title: string; priority: string }) => goal.title === "Find a new developer job" && goal.priority === "critical"));

    const today = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today`
    });
    assert.equal(today.statusCode, 200);
    assert.equal(today.json().brief.openActions[0].title, "Apply to 2 jobs");
    assert.equal(today.json().brief.suggestedNextStep, "Handle due action: Apply to 2 jobs.");

    const debug = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today/debug-priorities`
    });
    assert.equal(debug.statusCode, 200);
    assert.match(debug.json().priorities[0].rankReason, /critical goal/);

    await prisma.goal.update({
      where: { id: youtubeGoal.id },
      data: { importanceScore: null }
    });
    const backfill = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/goals/priorities/backfill`
    });
    assert.equal(backfill.statusCode, 200);
    assert.ok(backfill.json().updated >= 1);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("goal priority backfill corrects broken default medium priorities and preserves manual choices", async () => {
  const server = buildServer();
  const actionUserId = `goal-priority-backfill-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const goals = await Promise.all([
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Find a new developer job",
        category: "career",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Control impulsive betting",
        category: "finance",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Improve strength and energy",
        category: "health",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Build a YouTube channel",
        category: "creative",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Find a cheap car to buy",
        category: "custom",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Read more",
        category: "learning",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    })
  ]);

  try {
    const backfill = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/goals/priorities/backfill`,
      payload: {}
    });
    assert.equal(backfill.statusCode, 200);
    assert.match(backfill.json().message, /Find a new developer job: medium -> critical/);
    assert.match(backfill.json().message, /Control impulsive betting: medium -> critical/);
    assert.match(backfill.json().message, /Improve strength and energy: medium -> high/);
    assert.match(backfill.json().message, /Find a cheap car to buy: medium -> low/);
    assert.match(backfill.json().message, /Read more: medium -> low/);

    const updatedGoals = await prisma.goal.findMany({ where: { userId: actionUserId } });
    const priorities = new Map(updatedGoals.map((goal) => [goal.title, goal.priority]));
    const scores = new Map(updatedGoals.map((goal) => [goal.title, goal.importanceScore]));
    assert.equal(priorities.get("Find a new developer job"), "critical");
    assert.equal(scores.get("Find a new developer job"), 70);
    assert.equal(priorities.get("Control impulsive betting"), "critical");
    assert.equal(scores.get("Control impulsive betting"), 70);
    assert.equal(priorities.get("Improve strength and energy"), "high");
    assert.equal(scores.get("Improve strength and energy"), 45);
    assert.equal(priorities.get("Build a YouTube channel"), "medium");
    assert.equal(scores.get("Build a YouTube channel"), 25);
    assert.equal(priorities.get("Find a cheap car to buy"), "low");
    assert.equal(scores.get("Find a cheap car to buy"), 10);
    assert.equal(priorities.get("Read more"), "low");
    assert.equal(scores.get("Read more"), 10);

    const manualCarGoal = goals.find((goal) => goal.title === "Find a cheap car to buy");
    assert.ok(manualCarGoal);
    const manualUpdate = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/goals/priority`,
      payload: { goal: manualCarGoal.id, priority: "critical" }
    });
    assert.equal(manualUpdate.statusCode, 200);

    const normalBackfill = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/goals/priorities/backfill`,
      payload: {}
    });
    assert.match(normalBackfill.json().message, /Skipped manual priorities:/);
    const preservedManual = await prisma.goal.findUniqueOrThrow({ where: { id: manualCarGoal.id } });
    assert.equal(preservedManual.priority, "critical");

    const forceBackfill = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/goals/priorities/backfill`,
      payload: { force: true }
    });
    assert.equal(forceBackfill.statusCode, 200);
    const forcedManual = await prisma.goal.findUniqueOrThrow({ where: { id: manualCarGoal.id } });
    assert.equal(forcedManual.priority, "low");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("explicit memory concrete task saves memory and creates ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-memory-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "remember that I need to review homepage copy tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Saved to memory/);
    assert.match(response.json().reply, /Action created/);

    const [memories, actions] = await Promise.all([
      prisma.memoryEntry.findMany({ where: { userId: actionUserId } }),
      prisma.actionItem.findMany({ where: { userId: actionUserId } })
    ]);
    assert.equal(memories.length, 1);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Review homepage copy");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("explicit memory unrelated concrete task creates unlinked ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-memory-unlinked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "remember that I need to buy milk tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Saved to memory/);
    assert.match(response.json().reply, /Action created/);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Buy milk");
    assert.equal(actions[0].goalId, null);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("remember task uses manual action dedupe behavior", async () => {
  const server = buildServer();
  const actionUserId = `action-memory-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const command = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "review homepage copy tomorrow" }
    });
    assert.equal(command.statusCode, 200);

    const memory = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "remember that I need to review the homepage copy tomorrow" }
    });
    assert.equal(memory.statusCode, 200);
    assert.match(memory.json().reply, /Saved to memory/);
    assert.match(memory.json().reply, /Action already exists: Review homepage copy/);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 1);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("vague action language and betting reminders do not create ActionItems", async () => {
  const server = buildServer();
  const actionUserId = `action-safe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const vague = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "I need to be better" }
    });
    assert.equal(vague.statusCode, 200);

    const betting = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "remind me to bet tomorrow" }
    });
    assert.equal(betting.statusCode, 200);
    assert.equal(betting.json().intent, "betting_intent");

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("duplicate open manual action is reused but completed old action does not block", async () => {
  const server = buildServer();
  const actionUserId = `action-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const first = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "remind me to call Alex Friday" }
    });
    assert.equal(first.statusCode, 200);
    const firstAction = first.json().action;
    assert.equal(firstAction.title, "Call Alex");

    const duplicate = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "remind me to call Alex Friday" }
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().duplicate, true);
    assert.equal(duplicate.json().action.id, firstAction.id);

    await prisma.actionItem.update({
      where: { id: firstAction.id },
      data: { status: "completed", completedAt: new Date() }
    });

    const newAction = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "remind me to call Alex Friday" }
    });
    assert.equal(newAction.statusCode, 200);
    assert.equal(newAction.json().duplicate, false);
    assert.notEqual(newAction.json().action.id, firstAction.id);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("action reminder trigger sends open due action and includes commands", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Review homepage copy",
      priority: "medium",
      dueAt: new Date(Date.now() - 60_000)
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.sent, 1);
    assert.match(payload.message, /Action overdue:/);
    assert.match(payload.message, new RegExp(`/complete_action ${action.id}`));
    assert.match(payload.message, new RegExp(`/snooze_action ${action.id} tomorrow`));
    assert.match(payload.message, new RegExp(`/archive_action ${action.id}`));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("now action triggers reminder immediately and does not duplicate", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });

  try {
    const created = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/manual`,
      payload: { text: "test now" }
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().action.title, "Test");

    const first = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().sent, 1);
    assert.match(first.json().message, /Action overdue:/);

    const second = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("action reminder trigger skips future, completed, and archived actions", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  await prisma.actionItem.createMany({
    data: [
      {
        userId: reminderUserId,
        source: "manual",
        title: "Future action",
        priority: "medium",
        dueAt: new Date(Date.now() + 60 * 60_000)
      },
      {
        userId: reminderUserId,
        source: "manual",
        title: "Completed action",
        status: "completed",
        priority: "medium",
        dueAt: new Date(Date.now() - 60_000)
      },
      {
        userId: reminderUserId,
        source: "manual",
        title: "Archived action",
        status: "archived",
        priority: "medium",
        dueAt: new Date(Date.now() - 60_000)
      }
    ]
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("snoozed due action sends reminder and becomes open", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Call Alex",
      status: "snoozed",
      priority: "medium",
      dueAt: new Date(Date.now() - 24 * 60 * 60_000),
      snoozedUntil: new Date(Date.now() - 60_000)
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sent, 1);
    assert.match(response.json().message, /Snoozed action is back:/);

    const updated = await prisma.actionItem.findUniqueOrThrow({ where: { id: action.id } });
    assert.equal(updated.status, "open");
    assert.equal(updated.snoozedUntil, null);

    const second = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("snoozed future action does not send reminder", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Call Alex",
      status: "snoozed",
      priority: "medium",
      snoozedUntil: new Date(Date.now() + 60 * 60_000)
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("duplicate action reminder within 12 hours is skipped", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Send the CV",
      priority: "medium",
      dueAt: new Date(Date.now() - 60_000)
    }
  });

  try {
    const first = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().sent, 1);

    const second = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("debug force due action makes future action remind once", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Review homepage copy",
      priority: "medium",
      dueAt: new Date(Date.now() + 24 * 60 * 60_000)
    }
  });

  try {
    const forced = await server.inject({
      method: "PATCH",
      url: `/users/${reminderUserId}/actions/${action.id}/debug-force-due`
    });
    assert.equal(forced.statusCode, 200);
    assert.equal(forced.json().message, "Action forced due: Review homepage copy");

    const first = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().sent, 1);
    assert.match(first.json().message, /Action overdue:/);

    const second = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("debug force snoozed due action makes snoozed action remind once", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Call Alex",
      status: "open",
      priority: "medium"
    }
  });

  try {
    const forced = await server.inject({
      method: "PATCH",
      url: `/users/${reminderUserId}/actions/${action.id}/debug-force-snoozed-due`
    });
    assert.equal(forced.statusCode, 200);
    assert.equal(forced.json().message, "Action forced snoozed due: Call Alex");

    const first = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().sent, 1);
    assert.match(first.json().message, /Snoozed action is back:/);

    const updated = await prisma.actionItem.findUniqueOrThrow({ where: { id: action.id } });
    assert.equal(updated.status, "open");
    assert.equal(updated.snoozedUntil, null);

    const second = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

async function createReview(input: {
  subject: string;
  from: string;
  proposedEventType: string;
  status: "pending" | "approved" | "rejected" | "archived";
  extracted: Record<string, unknown>;
  adapterId?: string;
  evidence?: string;
}) {
  const item = await prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId,
      adapterId: input.adapterId ?? "job_search_email",
      provider: "gmail",
      providerMessageId: randomUUID(),
      externalId: `gmail-review:${ruleId}:${randomUUID()}`,
      subject: input.subject,
      from: input.from,
      proposedEventType: input.proposedEventType,
      confidence: 0.95,
      reason: input.proposedEventType,
      evidence: input.evidence ?? input.subject,
      extracted: input.extracted,
      status: input.status
    }
  });

  return item.id;
}

function localMinutes(date: Date | null): number | undefined {
  if (!date) {
    return undefined;
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");

  return hour * 60 + minute;
}

function localDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

function yesterdayLocalDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return localDate(date);
}
