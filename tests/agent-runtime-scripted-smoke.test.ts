import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { completeActionItem, createActionItem, createEvent, createGoal, prisma } from "../packages/db/src/index.ts";
import { clearAgentRuntimeMocks, mockGuardrail, mockPlan, op, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";
import {
  assertNoFalseSuccessClaim,
  assertNoGenericError,
  assertNoMutationYet,
  assertPendingStateUnchanged,
  assertPlanningDraftInSync,
  buildServer,
  runScriptedScenario,
  type ScriptedScenario
} from "./helpers/agent-runtime-scripted-eval.ts";

/**
 * Lightweight scripted multi-turn conversation smoke/eval coverage for Agent Runtime v3 —
 * the small harness this file exercises lives in tests/helpers/agent-runtime-scripted-eval.ts
 * (+ tests/helpers/agent-runtime-test-helpers.ts for the generic send/mock/session pieces).
 * Not a general eval framework: fixed scripts, fixed assertions, run through the exact same
 * POST /agent/message route Telegram calls.
 *
 * Exists because the planning state-machine bugs fixed in the two preceding hardening passes
 * (docs/09-architecture-inventory.md's "Next-Week Planning Hotfix" and its follow-up) were
 * each individually well-covered by single-tool unit tests, yet real multi-turn Telegram
 * conversation still found bugs — state carried BETWEEN turns (a stale index, a
 * regenerated draft, a false success claim) is exactly what a turn-by-turn test can miss.
 * These scenarios replay the same multi-turn shapes automatically instead of requiring a
 * human to retest them by hand in Telegram after every change.
 *
 * Deterministic / CI-safe: every turn below sets an explicit mocked plan
 * (AGENT_RUNTIME_PLANNER_MOCK_RESPONSE), so nothing here depends on network access or
 * OPENAI_API_KEY. To also exercise the real planner locally (OPENAI_API_KEY set), write a
 * ScriptedTurn with no `plan` field — see agent-runtime-scripted-eval.ts's ScriptedTurn doc.
 */

function nextWeekStartPlan(): MockPlan {
  return { topic: "next_week_planning", intent: "start_next_week_plan", operations: [op("planning.next_week_start")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function nextWeekEditPlan(args: Record<string, unknown>): MockPlan {
  return { topic: "next_week_planning", intent: "edit_next_week_plan", operations: [op("planning.next_week_edit", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function nextWeekShowCurrentPlan(): MockPlan {
  return { topic: "next_week_planning", intent: "show_current_next_week_plan", operations: [op("planning.next_week_show_current")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function hygieneStartPlan(): MockPlan {
  return { topic: "action_cleanup", intent: "show_hygiene_candidates", operations: [op("action.hygiene_start")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function hygieneApplyPlan(selections: Array<Record<string, unknown>>): MockPlan {
  return { topic: "action_cleanup", intent: "apply_hygiene_decisions", operations: [op("action.hygiene_apply", { selections })], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

/**
 * Job + reading + car goals, same shape used by tests/agent-runtime-next-week-planning.test.ts
 * — three same-priority real suggestions avoids the "fewer than 3 -> pad with 3 fixed items"
 * fallback, so the draft is fully deterministic. The scripts below add one "remove reading"
 * turn ahead of the reported transcript's literal wording for the same reason: a real
 * Telegram draft's exact starting item count depends on the user's live goal data, which a
 * deterministic CI scenario has to pin down by seeding instead.
 */
async function seedJobReadingCarGoals(userId: string): Promise<void> {
  const goals = [
    { title: "Apply to developer jobs", category: "career" },
    { title: "Read more books this year", category: "learning" },
    { title: "Buy a cheap car", category: "lifestyle" }
  ];
  for (const goal of goals) {
    await createGoal(userId, { title: goal.title, category: goal.category, priority: "medium" });
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// --- Scenario 1: planning happy path (the real Telegram transcript that found the state-
// machine bugs, replayed end to end) --------------------------------------------------------

test("scripted smoke 1: plan next week -> remove car listings -> move jobs to Friday -> show plan -> yes -> so what today", async () => {
  const server = buildServer();
  const userId = `smoke-planning-happy-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobReadingCarGoals(userId);

    const scenario: ScriptedScenario = {
      name: "planning-happy-path",
      turns: [
        {
          message: "plan next week",
          plan: nextWeekStartPlan(),
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /draft plan for next week:/i);
            assert.ok(turn.pendingOperationAfter, "a draft must open a pending confirmation");
            assertPlanningDraftInSync(turn);
          }
        },
        {
          message: "remove reading",
          plan: nextWeekEditPlan({ removeRefs: ["reading"] }),
          assert: (turn) => {
            assertNoGenericError(turn);
            assertNoMutationYet(turn);
            assertPlanningDraftInSync(turn);
          }
        },
        {
          message: "remove the car listings one",
          plan: nextWeekEditPlan({ removeRefs: ["the car listings one"] }),
          assert: (turn) => {
            assertNoGenericError(turn);
            assertNoMutationYet(turn);
            assert.match(turn.reply, /developer jobs/i);
            assert.doesNotMatch(turn.reply, /car listings/i);
            assertPlanningDraftInSync(turn);
          }
        },
        {
          message: "move the jobs to Friday",
          plan: nextWeekEditPlan({ changes: [{ ref: "the jobs", dueText: "Friday" }] }),
          assert: (turn) => {
            assertNoGenericError(turn);
            assertNoFalseSuccessClaim(turn);
            assert.doesNotMatch(turn.reply, /plan is now empty/i, "the reported empty-plan regression must not reappear");
            assert.match(turn.reply, /friday/i);
            assert.match(turn.reply, /developer jobs/i);
            assertPlanningDraftInSync(turn);
          }
        },
        {
          message: "show me the week plan",
          plan: nextWeekShowCurrentPlan(),
          assert: (turn) => {
            assertNoGenericError(turn);
            assertNoMutationYet(turn);
            // Must show the CURRENT draft (Friday job only), not regenerate the original one.
            assert.match(turn.reply, /friday/i);
            assert.match(turn.reply, /developer jobs/i);
            assert.doesNotMatch(turn.reply, /car listings/i, "must not have regenerated the original 3-item draft");
            const draftLines = turn.reply.split("\n").filter((line) => /^\d+\./.test(line));
            assert.equal(draftLines.length, 1, "the current draft has exactly one item");
            assertPendingStateUnchanged(turn);
          }
        },
        {
          message: "yes",
          // No plan: "yes" is handled by the exact confirm whitelist before the planner runs.
          assert: async (turn) => {
            assertNoGenericError(turn);
            assert.equal(turn.mutationExecuted, true, "confirming the draft must create the action item");
            assert.match(turn.reply, /done\. i created/i);
            assert.equal(turn.pendingOperationAfter, null, "the pending draft clears once applied");

            const created = await prisma.actionItem.findMany({ where: { userId, sourceProvider: "weekly_plan" } });
            assert.equal(created.length, 1, "exactly one action: the surviving draft item");
            assert.match(created[0].title, /developer jobs/i);
            const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(created[0].dueAt!);
            assert.equal(weekday, "Friday");
          }
        },
        {
          message: "so what today",
          plan: { topic: "operator_summary", intent: "daily_summary", operations: [op("operator.today")], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /open task|goal/i);
          }
        }
      ],
      assertAll: (turns) => {
        assert.equal(turns[4].mutationExecuted, false, "'show plan' must not have created anything");
      }
    };

    await runScriptedScenario(server, userId, scenario);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 2: planning cancel path -------------------------------------------------------

test("scripted smoke 2: plan next week -> make it lighter -> cancel", async () => {
  const server = buildServer();
  const userId = `smoke-planning-cancel-${randomUUID()}`;

  try {
    await seedUser(userId);

    const scenario: ScriptedScenario = {
      name: "planning-cancel-path",
      turns: [
        {
          message: "plan next week",
          plan: nextWeekStartPlan(),
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.ok(turn.pendingOperationAfter);
          }
        },
        {
          message: "make it lighter",
          plan: nextWeekEditPlan({ lighter: true }),
          assert: (turn) => {
            assertNoGenericError(turn);
            assertNoMutationYet(turn);
            // Whether "lighter" found a confident reduction or asked for clarification, the
            // pending draft must still exist either way — never silently dropped.
            assert.ok(turn.pendingOperationAfter, "the pending plan draft must still exist after 'make it lighter'");
          }
        },
        {
          message: "cancel",
          // No plan: "cancel" is handled by the exact cancel whitelist before the planner runs.
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.equal(turn.pendingOperationAfter, null, "cancel must clear the pending plan");
            assert.deepEqual(turn.visibleEntitiesAfter, [], "cancel must clear visible plan entities");
          }
        }
      ]
    };

    await runScriptedScenario(server, userId, scenario);

    const created = await prisma.actionItem.count({ where: { userId, sourceProvider: "weekly_plan" } });
    assert.equal(created, 0, "cancelling must never create an action");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 3: no stale replyDraft on a rejected planning edit ---------------------------

test("scripted smoke 3: a rejected planning edit never lets the planner's replyDraft claim success", async () => {
  const server = buildServer();
  const userId = `smoke-no-stale-claim-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobReadingCarGoals(userId);

    const scenario: ScriptedScenario = {
      name: "no-stale-success-claim",
      turns: [
        { message: "plan next week", plan: nextWeekStartPlan() },
        { message: "remove reading", plan: nextWeekEditPlan({ removeRefs: ["reading"] }) },
        { message: "remove the car listings one", plan: nextWeekEditPlan({ removeRefs: ["the car listings one"] }) },
        {
          // Simulates the real transcript exactly: the planner's own replyDraft falsely claims
          // the move already happened, for a turn that will actually be rejected (removing the
          // only remaining item without an explicit removeAll).
          message: "remove the jobs",
          plan: {
            topic: "next_week_planning",
            intent: "edit_next_week_plan",
            operations: [op("planning.next_week_edit", { removeRefs: ["the jobs"] })],
            needsClarification: false,
            clarificationQuestion: null,
            replyDraft: "I've moved the job application to Friday. Your plan will now reflect that change."
          },
          assert: (turn) => {
            assertNoGenericError(turn);
            assertNoFalseSuccessClaim(turn);
            assert.doesNotMatch(turn.reply, /i've moved/i);
            assert.match(turn.reply, /remove everything/i, "must state the rejection reason, not a false success");
            assertPendingStateUnchanged(turn);
          }
        }
      ]
    };

    await runScriptedScenario(server, userId, scenario);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 4: action hygiene smoke -------------------------------------------------------
//
// Run with direct calls rather than runScriptedScenario: this is the one scenario whose own
// mocked args (the numbered index to snooze/archive) can only be known from the PRECEDING
// turn's reply — getActionItems sorts by dueAt, not creation order, so which seeded action
// lands at index 1 vs 2 isn't fixed up front. Everywhere else in this file, a scenario's plan
// is fully known ahead of time and goes through the shared harness.

test("scripted smoke 4: clean up my actions -> snooze the overdue gym one -> clean up again -> archive the stale car one", async () => {
  const server = buildServer();
  const userId = `smoke-hygiene-${randomUUID()}`;

  try {
    await seedUser(userId);
    const gymAction = await createActionItem(userId, { source: "manual", title: "Do 2 strength sessions", priority: "medium", dueAt: daysAgo(4) });
    const carAction = await createActionItem(userId, { source: "manual", title: "Check cheap car listings twice", priority: "medium", dueAt: daysAgo(3) });

    mockPlan(hygieneStartPlan());
    const startReply = await sendAgentMessage(server, userId, "clean up my actions");
    assertNoGenericErrorRaw(startReply.reply);
    assert.match(startReply.reply, /1\./);

    const startEntities = (await getVisibleEntities(userId)) as Array<{ id: string; index?: number }>;
    const gymIndex = startEntities.find((entity) => entity.id === gymAction.id)?.index ?? 0;
    assert.ok(gymIndex > 0, "the seeded gym action must be visible and numbered");

    mockPlan(hygieneApplyPlan([{ index: gymIndex, decision: "snooze", snoozeUntilText: "tomorrow" }]));
    const snoozeReply = await sendAgentMessage(server, userId, "snooze the overdue gym one to tomorrow");
    assertNoGenericErrorRaw(snoozeReply.reply);
    assert.equal(snoozeReply.debug.mutationExecuted, true);
    assert.match(snoozeReply.reply, /snoozed/i);

    mockPlan(hygieneStartPlan());
    const secondStartReply = await sendAgentMessage(server, userId, "clean up my actions");
    assertNoGenericErrorRaw(secondStartReply.reply);
    // The gym item is snoozed to tomorrow (not due yet) — only the car item remains.
    assert.doesNotMatch(secondStartReply.reply, /strength sessions/i);
    assert.match(secondStartReply.reply, /car listings/i);

    const secondEntities = (await getVisibleEntities(userId)) as Array<{ id: string; index?: number }>;
    assert.equal(secondEntities.length, 1, "only the still-open stale item should be listed again");
    const carIndex = secondEntities.find((entity) => entity.id === carAction.id)?.index ?? 0;
    assert.ok(carIndex > 0);

    mockPlan(hygieneApplyPlan([{ index: carIndex, decision: "archive" }]));
    const archiveReply = await sendAgentMessage(server, userId, "archive the stale car one");
    assertNoGenericErrorRaw(archiveReply.reply);
    assert.equal(archiveReply.debug.mutationExecuted, true);
    assert.match(archiveReply.reply, /archived/i);

    const gymAfter = await prisma.actionItem.findUnique({ where: { id: gymAction.id } });
    const carAfter = await prisma.actionItem.findUnique({ where: { id: carAction.id } });
    assert.equal(gymAfter?.status, "snoozed", "the gym item must only be snoozed, never archived");
    assert.equal(carAfter?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

function assertNoGenericErrorRaw(reply: string): void {
  assert.doesNotMatch(reply, /agent v3 hit an error/i);
}

async function getVisibleEntities(userId: string, channel = "telegram"): Promise<unknown[]> {
  const row = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel } } });
  return Array.isArray(row?.visibleEntities) ? (row.visibleEntities as unknown[]) : [];
}

// --- Scenario 5: basic V3 product smoke (memory / Gmail / today) ---------------------------

test("scripted smoke 5: remember a preference -> ask Gmail rules -> so what today", async () => {
  const server = buildServer();
  const userId = `smoke-memory-gmail-today-${randomUUID()}`;

  try {
    await seedUser(userId);

    const scenario: ScriptedScenario = {
      name: "memory-gmail-today-smoke",
      turns: [
        {
          message: "remember I prefer blunt feedback",
          plan: { topic: "memory", intent: "store_preference", operations: [op("memory.create", { summary: "Prefers blunt feedback", type: "preference" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /remember/i);
            assert.match(turn.reply, /blunt feedback/i);
          }
        },
        {
          message: "what email rules are active?",
          plan: { topic: "gmail_rules", intent: "list_active_rules", operations: [op("gmail.rule.list")], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /no active gmail rules/i);
            // Default V3 chat must never push the user toward slash-command setup — that's the
            // legacy-only surface.
            assert.doesNotMatch(turn.reply, /\/gmail|\/setup|\/connect/i, "must not show a legacy slash-command setup wall");
          }
        },
        {
          message: "so what today",
          plan: { topic: "operator_summary", intent: "daily_summary", operations: [op("operator.today")], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /open task|goal/i);
            assert.doesNotMatch(turn.reply, /\/action_hygiene|\/gmail_rules|\/sync_gmail/i, "must never recommend a slash command in normal v3 chat");
          }
        }
      ]
    };

    await runScriptedScenario(server, userId, scenario);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 6: weekly review smoke --------------------------------------------------------

test("scripted smoke 6: review my week -> what should I improve next week? -> save this review -> so what today", async () => {
  const server = buildServer();
  const userId = `smoke-weekly-review-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Apply to developer jobs", category: "career", priority: "medium" });
    const completed = await createActionItem(userId, { source: "manual", title: "Send CV to acme corp", priority: "medium" });
    await completeActionItem(userId, completed.id);
    await createEvent(userId, { type: "health.workout_completed", source: "manual", confidence: 1, data: { minutes: 45 } });

    const scenario: ScriptedScenario = {
      name: "weekly-review-smoke",
      turns: [
        {
          message: "review my week",
          plan: { topic: "weekly_review", intent: "start_weekly_review", operations: [op("weekly_review.start")], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /here's your weekly review:/i);
            // Grounded in the actually seeded data — not invented.
            assert.match(turn.reply, /completed 1 action/i);
            assert.match(turn.reply, /logged 1 workout/i);
            assertNoMutationYet(turn);
            assert.ok(turn.pendingOperationAfter, "showing the review opens a pending save state");
          }
        },
        {
          message: "what should I improve next week?",
          plan: { topic: "weekly_review", intent: "start_weekly_review", operations: [op("weekly_review.start")], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assertNoFalseSuccessClaim(turn);
            assert.match(turn.reply, /next move:/i);
            assertNoMutationYet(turn);
          }
        },
        {
          message: "save this review",
          // No plan: "save this review" is handled by the exact confirm whitelist, same
          // mechanism as "yes"/"looks good", before the planner runs.
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.equal(turn.mutationExecuted, true, "saving the review must actually persist it");
            assert.match(turn.reply, /saved your weekly review/i);
            assert.equal(turn.pendingOperationAfter, null, "the pending save state clears once saved");
          }
        },
        {
          message: "so what today",
          plan: { topic: "operator_summary", intent: "daily_summary", operations: [op("operator.today")], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /open task|goal/i);
            assert.doesNotMatch(turn.reply, /\/action_hygiene|\/gmail_rules|\/sync_gmail/i, "must never recommend a slash command in normal v3 chat");
          }
        }
      ]
    };

    await runScriptedScenario(server, userId, scenario);

    const saved = await prisma.memoryEntry.findMany({ where: { userId, status: "active" } });
    const reviewMemory = saved.find((memory) => (memory.data as Record<string, unknown> | null)?.kind === "weekly_review");
    assert.ok(reviewMemory, "a weekly_review memory must exist after 'save this review'");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 7: Gmail rule management smoke ------------------------------------------------

test("scripted smoke 7: what email rules are active? -> turn off Endesa -> yes -> what email rules are active?", async () => {
  const server = buildServer();
  const userId = `smoke-gmail-rules-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const endesa = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Endesa bills", status: "active", createdBy: "user" }
    });
    await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Naturgy invoices", status: "active", createdBy: "user" }
    });

    const scenario: ScriptedScenario = {
      name: "gmail-rule-management-smoke",
      turns: [
        {
          message: "what email rules are active?",
          plan: { topic: "gmail_rules", intent: "list_active_rules", operations: [op("gmail.rule.list")], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /endesa bills/i);
            assert.match(turn.reply, /naturgy invoices/i);
            assert.doesNotMatch(turn.reply, /\/gmail|\/setup|\/connect/i, "must not show a legacy slash-command setup wall");
            assertNoMutationYet(turn);
          }
        },
        {
          message: "turn off Endesa",
          plan: {
            topic: "gmail_rule_management",
            intent: "propose_gmail_rule_update",
            operations: [op("gmail.rule.propose_update", { ref: "Endesa", operation: "pause" })],
            needsClarification: false,
            clarificationQuestion: null,
            replyDraft: ""
          },
          assert: (turn) => {
            assertNoGenericError(turn);
            assertNoFalseSuccessClaim(turn);
            assert.match(turn.reply, /about to pause endesa bills/i);
            assertNoMutationYet(turn);
            assert.ok(turn.pendingOperationAfter, "proposing a change opens a pending confirmation");
          }
        },
        {
          message: "yes",
          // No plan: "yes" is handled by the exact confirm whitelist before the planner runs.
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.equal(turn.mutationExecuted, true, "Endesa's state must only change after 'yes'");
            assert.match(turn.reply, /done — endesa bills is now paused/i);
            assert.equal(turn.pendingOperationAfter, null);
          }
        },
        {
          message: "what email rules are active?",
          plan: { topic: "gmail_rules", intent: "list_active_rules", operations: [op("gmail.rule.list")], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            // gmail.rule.list only shows ACTIVE rules — Endesa, now paused, must be grounded
            // (i.e. actually absent), not just left stale from the first listing.
            assert.doesNotMatch(turn.reply, /endesa bills/i, "the now-paused rule must not still be listed as active");
            assert.match(turn.reply, /naturgy invoices/i, "the untouched rule must still be listed");
          }
        }
      ]
    };

    await runScriptedScenario(server, userId, scenario);

    const endesaAfter = await prisma.emailSignalRule.findUnique({ where: { id: endesa.id } });
    assert.equal(endesaAfter?.status, "paused");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 8: daily-loop settings smoke --------------------------------------------------

test("scripted smoke 8: what are my daily loop settings? -> turn off daily review -> cancel -> turn off daily review -> yes -> what are my daily loop settings?", async () => {
  const server = buildServer();
  const userId = `smoke-daily-loop-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true } });

    const showPlan: MockPlan = { topic: "daily_loop_settings", intent: "show_daily_loop_settings", operations: [op("daily_loop.settings_show")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
    const proposeOffPlan: MockPlan = {
      topic: "daily_loop_settings",
      intent: "propose_daily_loop_settings_update",
      operations: [op("daily_loop.settings_propose_update", { enabled: false })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    };

    const scenario: ScriptedScenario = {
      name: "daily-loop-settings-smoke",
      turns: [
        {
          message: "what are my daily loop settings?",
          plan: showPlan,
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /daily review: on/i);
            assertNoMutationYet(turn);
          }
        },
        {
          message: "turn off daily review",
          plan: proposeOffPlan,
          assert: (turn) => {
            assertNoGenericError(turn);
            assertNoFalseSuccessClaim(turn);
            assert.match(turn.reply, /about to turn off daily review reminders/i);
            assertNoMutationYet(turn);
            assert.ok(turn.pendingOperationAfter, "proposing a change opens a pending confirmation");
          }
        },
        {
          message: "cancel",
          // No plan: "cancel" is handled by the exact cancel whitelist before the planner runs.
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.equal(turn.pendingOperationAfter, null, "cancel must clear the pending change");
            assertNoMutationYet(turn);
          }
        },
        {
          message: "turn off daily review",
          plan: proposeOffPlan,
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /about to turn off daily review reminders/i);
            assertNoMutationYet(turn);
            assert.ok(turn.pendingOperationAfter, "proposing again after cancel must open a fresh pending confirmation");
          }
        },
        {
          message: "yes",
          // No plan: "yes" is handled by the exact confirm whitelist before the planner runs.
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.equal(turn.mutationExecuted, true, "the setting must only change after 'yes'");
            assert.match(turn.reply, /done — daily review reminders are now off/i);
            assert.equal(turn.pendingOperationAfter, null);
          }
        },
        {
          message: "what are my daily loop settings?",
          plan: showPlan,
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /daily review: off/i, "must reflect the real, now-updated DB state");
          }
        }
      ]
    };

    await runScriptedScenario(server, userId, scenario);

    const settingsAfter = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(settingsAfter?.dailyLoopEnabled, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 9: memory save + recall smoke -------------------------------------------------
//
// Part of the V3 global readiness audit (docs/10-v3-readiness-audit.md): confirms a saved
// memory is actually retrievable through a later, differently-worded question in the same
// conversation, not just that memory.create returns a success summary.

test("scripted smoke 9: remember I prefer blunt feedback -> what do you remember about my feedback style?", async () => {
  const server = buildServer();
  const userId = `smoke-memory-recall-${randomUUID()}`;

  try {
    await seedUser(userId);

    const scenario: ScriptedScenario = {
      name: "memory-recall-smoke",
      turns: [
        {
          message: "remember I prefer blunt feedback",
          plan: { topic: "memory", intent: "store_preference", operations: [op("memory.create", { summary: "Prefers blunt feedback", type: "communication_style" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /remember/i);
            assert.match(turn.reply, /blunt feedback/i);
            assert.equal(turn.mutationExecuted, true);
          }
        },
        {
          message: "what do you remember about my feedback style?",
          plan: { topic: "memory", intent: "search_memory", operations: [op("memory.search", { query: "feedback" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            // Grounded in the actually-saved memory, not the LLM re-describing the earlier turn.
            assert.match(turn.reply, /blunt feedback/i);
            assertNoMutationYet(turn);
          }
        }
      ]
    };

    await runScriptedScenario(server, userId, scenario);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 10: goals + progress smoke ------------------------------------------------------
//
// Part of the V3 global readiness audit. There is no dedicated goal.create/goal.list tool in
// tool-catalog.ts (confirmed by grep during the audit) — "I want to find a developer job" is
// realistically planned as a memory.create with type "goal_context" (that enum value exists
// specifically for this), and "what are my active goals?" is realistically answered by
// operator.today, whose summary reports only a COUNT of active goals, never their titles. This
// scenario intentionally documents that gap rather than asserting goal titles appear.

test("scripted smoke 10: I want to find a developer job -> I sent 3 CVs today -> what are my active goals?", async () => {
  const server = buildServer();
  const userId = `smoke-goals-progress-${randomUUID()}`;

  try {
    await seedUser(userId);
    // Seeds the goal directly (as e.g. /create_goal or onboarding already would), since V3 chat
    // itself has no way to create a queryable Goal record — see the gap noted above.
    await createGoal(userId, { title: "Apply to developer jobs", category: "career", priority: "medium" });

    const scenario: ScriptedScenario = {
      name: "goals-progress-smoke",
      turns: [
        {
          message: "I want to find a developer job",
          plan: { topic: "memory", intent: "store_goal_context", operations: [op("memory.create", { summary: "Wants to find a developer job", type: "goal_context" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.equal(turn.mutationExecuted, true);
          }
        },
        {
          message: "I sent 3 CVs today",
          plan: { topic: "progress_logging", intent: "log_job_applications", operations: [op("event.log_job_applications", { count: 3 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /3 job application/i);
            assert.equal(turn.mutationExecuted, true);
          }
        },
        {
          message: "what are my active goals?",
          plan: { topic: "operator_summary", intent: "daily_summary", operations: [op("operator.today")], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            // Real, grounded count — but only a count, never per-goal titles (the documented gap).
            assert.match(turn.reply, /1 active goal/i);
            assertNoMutationYet(turn);
          }
        }
      ]
    };

    await runScriptedScenario(server, userId, scenario);

    const loggedEvents = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
    assert.equal(loggedEvents, 3, "each logged CV must be its own event, grounded in real DB state");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 11: action CRUD smoke -----------------------------------------------------------
//
// Part of the V3 global readiness audit: exercises action.create/operator.today/action.complete
// directly (not via action.hygiene_*), including single-visible-entity resolution (referencing
// "it" with no explicit actionId, resolved against the one action just created).

test("scripted smoke 11: create a task to apply tomorrow -> what should I do today? -> mark it done", async () => {
  const server = buildServer();
  const userId = `smoke-action-crud-${randomUUID()}`;

  try {
    await seedUser(userId);

    const scenario: ScriptedScenario = {
      name: "action-crud-smoke",
      turns: [
        {
          message: "create a task to apply tomorrow",
          plan: { topic: "action_cleanup", intent: "create_action", operations: [op("action.create", { title: "Apply to jobs", dueText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /created task/i);
            assert.match(turn.reply, /apply to jobs/i);
            assert.equal(turn.mutationExecuted, true);
          }
        },
        {
          message: "what should I do today?",
          plan: { topic: "operator_summary", intent: "daily_summary", operations: [op("operator.today")], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /1 open task/i);
            assertNoMutationYet(turn);
          }
        },
        {
          message: "mark it done",
          // No actionId: resolved deterministically against the single visible action entity
          // left by the create turn (validator.ts's ACTION_REFERENCE_TOOLS resolution).
          plan: { topic: "action_cleanup", intent: "complete_action", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" },
          assert: (turn) => {
            assertNoGenericError(turn);
            assert.match(turn.reply, /completed "apply to jobs"/i);
            assert.equal(turn.mutationExecuted, true);
          }
        }
      ]
    };

    await runScriptedScenario(server, userId, scenario);

    const created = await prisma.actionItem.findMany({ where: { userId, source: "manual" } });
    assert.equal(created.length, 1);
    assert.equal(created[0].status, "completed", "final DB state must match the reply's claim");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 12: Gmail review triage smoke -----------------------------------------------------
//
// gmail.review.list/reject/to_action are now realistically reachable via normal chat:
// planner.ts has explicit guidance for all three (previously zero), gmail.review.list's summary
// is itemized (previously a bare count), and reject/to_action resolve natural references
// ("the recruiter one", "Endesa") deterministically against the visible gmail_review entities
// the list turn just stored — never a fresh DB lookup, never hidden LLM memory (see
// validator.ts's resolveGmailReviewRef). Two reviews are seeded so this also proves resolution
// picks the RIGHT one, not just "the only one."

test("scripted smoke 12: what emails need attention? -> turn the recruiter one into a task -> reject Endesa -> what emails need attention?", async () => {
  const server = buildServer();
  const userId = `smoke-gmail-review-triage-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const recruiterRule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" }
    });
    const endesaRule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Endesa bills", status: "active", createdBy: "user" }
    });
    const recruiterReview = await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: recruiterRule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: "recruiter-reply-1",
        externalId: `gmail-review:${recruiterRule.id}:recruiter-reply-1`,
        subject: "Recruiter reply from Example Labs",
        from: "Recruiter <recruiter@example.com>",
        snippet: "Thanks for applying. Can we talk tomorrow?",
        evidence: "Thanks for applying. Can we talk tomorrow?",
        confidence: 0.9,
        reason: "custom_rule_match",
        extracted: {},
        status: "pending"
      }
    });
    const endesaReview = await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: endesaRule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: "endesa-bill-1",
        externalId: `gmail-review:${endesaRule.id}:endesa-bill-1`,
        subject: "Endesa factura",
        from: "Endesa <noreply@endesa.com>",
        snippet: "Your bill is ready to view",
        evidence: "Your bill is ready to view",
        confidence: 0.7,
        reason: "custom_rule_match",
        extracted: {},
        status: "pending"
      }
    });

    mockPlan({ topic: "gmail_reviews", intent: "list_pending_reviews", operations: [op("gmail.review.list", { status: "pending" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const listReply = await sendAgentMessage(server, userId, "what emails need my attention?");
    assertNoGenericErrorRaw(listReply.reply);
    assert.match(listReply.reply, /pending gmail reviews:/i, "must be itemized, not a bare count");
    assert.match(listReply.reply, /recruiter reply from example labs/i);
    assert.match(listReply.reply, /endesa factura/i);
    assert.doesNotMatch(listReply.reply, /\/gmail|\/setup|\/connect/i, "must not show a legacy slash-command setup wall");
    assert.equal(listReply.debug.mutationExecuted, false);

    const entitiesAfterList = (await getVisibleEntities(userId)) as Array<{ type: string; id: string; index?: number }>;
    const reviewEntities = entitiesAfterList.filter((entity) => entity.type === "gmail_review");
    assert.equal(reviewEntities.length, 2, "both pending reviews must be stored as visible entities");
    assert.ok(reviewEntities.every((entity) => typeof entity.index === "number" && entity.index > 0));

    mockPlan({
      topic: "gmail_reviews",
      intent: "convert_review_to_action",
      operations: [op("gmail.review.to_action", { ref: "recruiter" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const convertReply = await sendAgentMessage(server, userId, "turn the recruiter one into a task");
    assertNoGenericErrorRaw(convertReply.reply);
    assert.match(convertReply.reply, /turned the email review into task/i);
    assert.equal(convertReply.debug.mutationExecuted, true);

    const recruiterAfterConvert = await prisma.emailReviewItem.findUnique({ where: { id: recruiterReview.id } });
    assert.equal(recruiterAfterConvert?.status, "approved");
    assert.ok(recruiterAfterConvert?.actionItemId, "the recruiter review must be linked to the action it created");
    const endesaUnchangedAfterConvert = await prisma.emailReviewItem.findUnique({ where: { id: endesaReview.id } });
    assert.equal(endesaUnchangedAfterConvert?.status, "pending", "only the targeted review may change");

    mockPlan({
      topic: "gmail_reviews",
      intent: "reject_review",
      operations: [op("gmail.review.reject", { ref: "Endesa" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const rejectReply = await sendAgentMessage(server, userId, "reject the Endesa one");
    assertNoGenericErrorRaw(rejectReply.reply);
    assert.match(rejectReply.reply, /rejected/i);
    assert.equal(rejectReply.debug.mutationExecuted, true);

    const endesaAfterReject = await prisma.emailReviewItem.findUnique({ where: { id: endesaReview.id } });
    assert.equal(endesaAfterReject?.status, "rejected");

    mockPlan({ topic: "gmail_reviews", intent: "list_pending_reviews", operations: [op("gmail.review.list", { status: "pending" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const finalListReply = await sendAgentMessage(server, userId, "what emails need my attention?");
    assertNoGenericErrorRaw(finalListReply.reply);
    assert.match(finalListReply.reply, /no email reviews are waiting/i, "both reviews are now decided, so the pending list must be honestly empty");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 13: goal-aligned guardrail smoke — cessation goal --------------------------------
//
// Part of the V3 global readiness audit's follow-up: V3 does NOT port legacy's hardcoded
// gambling/trading classifier. Instead, checkGoalGuardrail (apps/api/src/agent-runtime/
// goal-guardrails.ts) classifies a message against the user's OWN active goals — "Stop
// gambling" here is just a plain Goal row, no different from "Quit smoking" or "Train 3x/week";
// nothing in the guardrail module's code branches on what the goal is *about*. The LLM
// classification tier is mocked (AGENT_RUNTIME_GUARDRAIL_MOCK_RESPONSE) so this stays CI-safe
// without OPENAI_API_KEY, exactly like the existing planner mock. Proves both halves: an actual
// violation is hard-blocked (and logged as a risk_pattern memory, reusing existing memory
// infrastructure — no new schema), while a supportive, recovery-oriented message about the SAME
// goal is correctly let through, not blocked as if it were itself the violation.

test("scripted smoke 13: a message that violates the user's own 'stop gambling' goal is hard-blocked and logged; asking for help with it is not", async () => {
  const server = buildServer();
  const userId = `smoke-goal-guardrail-gambling-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Stop gambling", category: "wellbeing", priority: "high" });
    assert.equal(goalResult.duplicate, false);
    const goal = goalResult.goal;

    mockGuardrail({
      conflict: "hard_block",
      goalId: goal.id,
      pattern: "active_violation",
      clarifyingQuestion: null,
      reason: "explicit intent to gamble directly violates the stop-gambling goal"
    });
    const blockedReply = await sendAgentMessage(server, userId, "I want to bet 1000 because it's safe");
    assertNoGenericErrorRaw(blockedReply.reply);
    assert.match(blockedReply.reply, /conflicts with your goal to stop gambling/i);
    assert.deepEqual(blockedReply.operationsPlanned, [], "the tool planner must never be reached once the guardrail hard-blocks");
    assert.equal(blockedReply.debug.mutationExecuted, true, "the conflict itself is logged as a risk_pattern memory, not silently dropped");

    const loggedRisk = await prisma.memoryEntry.findMany({ where: { userId, type: "risk_pattern" } });
    assert.equal(loggedRisk.length, 1);
    assert.match(loggedRisk[0].summary, /stop gambling/i);

    mockGuardrail({
      conflict: "none",
      goalId: null,
      pattern: null,
      clarifyingQuestion: null,
      reason: "user is seeking support to control the urge, not describing intent to gamble"
    });
    mockPlan({ topic: "general", intent: "support", operations: [], needsClarification: false, clarificationQuestion: null, replyDraft: "Good — what's making the urge strong right now?" });
    const supportiveReply = await sendAgentMessage(server, userId, "I want to control my gambling impulses");
    assertNoGenericErrorRaw(supportiveReply.reply);
    assert.doesNotMatch(supportiveReply.reply, /conflicts with your goal|don'?t do it/i, "recovery/support language about the goal must not itself be treated as the violation");

    const riskAfterSupportiveTurn = await prisma.memoryEntry.count({ where: { userId, type: "risk_pattern" } });
    assert.equal(riskAfterSupportiveTurn, 1, "the supportive turn must not add a second risk_pattern entry");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 14: goal-aligned guardrail smoke — pursuit goal / avoidance ----------------------
//
// Same guardrail module, a completely different kind of goal (a pursuit goal, not a cessation
// one) — proving the design generalizes rather than being gambling-shaped underneath.

test("scripted smoke 14: avoiding a job-search goal for something else gets an accountability nudge tied to that goal", async () => {
  const server = buildServer();
  const userId = `smoke-goal-guardrail-job-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a new developer job", category: "career", priority: "high" });
    assert.equal(goalResult.duplicate, false);
    const goal = goalResult.goal;

    mockGuardrail({
      conflict: "soft_warn",
      goalId: goal.id,
      pattern: "avoidance",
      clarifyingQuestion: null,
      reason: "choosing an unrelated, lower-priority activity over the stated job-search goal"
    });
    const reply = await sendAgentMessage(server, userId, "I'm going to browse cars instead of applying");
    assertNoGenericErrorRaw(reply.reply);
    assert.match(reply.reply, /avoidance|pulling you away/i);
    assert.match(reply.reply, /find a new developer job/i);
    assert.deepEqual(reply.operationsPlanned, [], "the tool planner must never be reached once the guardrail intervenes");
    assert.equal(reply.debug.mutationExecuted, true, "the avoidance pattern is logged as a risk_pattern memory");

    const loggedRisk = await prisma.memoryEntry.findMany({ where: { userId, type: "risk_pattern" } });
    assert.equal(loggedRisk.length, 1);
    assert.match(loggedRisk[0].summary, /developer job/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Scenario 15: known-trigger guardrail still works with no goal at all ----------------------
//
// Keeps the pre-existing, user-configured knownTriggers/knownFailureModes mechanism working
// exactly as before this pass, for a user who hasn't (or hasn't yet) turned that trigger into a
// formal goal — the deterministic Tier 1 path, no LLM call involved at all.

test("scripted smoke 15: a configured knownTrigger still intervenes even with no matching goal", async () => {
  const server = buildServer();
  const userId = `smoke-guardrail-trigger-only-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.userOperatingProfile.create({ data: { userId, knownTriggers: ["sports betting"] } });

    // No mockGuardrail needed: a configured trigger is matched deterministically, before any
    // LLM tier would even be considered.
    const reply = await sendAgentMessage(server, userId, "I'm opening the betting app, sports betting always relaxes me");
    assertNoGenericErrorRaw(reply.reply);
    assert.equal(reply.debug.llmPlannerAttempted, false, "a literal trigger match never needs the LLM tier");
    assert.deepEqual(reply.operationsPlanned, []);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
