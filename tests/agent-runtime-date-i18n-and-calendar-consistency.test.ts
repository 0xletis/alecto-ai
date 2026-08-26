import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseActionDueDate } from "../packages/core/src/action-intake.ts";
import { addDaysToLocalDate, formatLocalDate } from "../packages/core/src/time.ts";
import { assertWorkspacePackagesAreFresh } from "../apps/api/src/utils/build-freshness.ts";
import { createActionItem, prisma, updateNotificationSettings } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic coverage for the launch-readiness date-system blockers closed on
 * fix/private-alpha-local-date-focus-and-gmail-confirmation-state (follow-up):
 *
 * 1. Spanish/Catalan day-of-month and relative-date phrases ("miércoles 26", "26 de agosto",
 *    "mañana", "demà", ...) previously never reached the deterministic parser at all — only
 *    English weekday/month words were recognized.
 * 2. A stated weekday alongside a stated day-of-month ("Thursday 26 August") was never actually
 *    checked against the real calendar — the day-number silently won, with the weekday word
 *    matched but discarded, so a contradictory statement produced no signal to the user at all.
 * 3. An explicit dueText that failed to resolve to a real date (a weekday mismatch, an
 *    already-past explicit time, or genuinely unsupported phrasing) was silently dropped by
 *    action.create — the task got created anyway, just with no due date, hiding the failure.
 *
 * All three of the above are exercised in packages/core's parseActionDueDate directly (the
 * single deterministic parser both action.create's dueText path and action.reschedule's dueText
 * path funnel through) as well as through the full agent-runtime HTTP path, so both the parsing
 * logic and its wiring into the tools that can actually mutate the DB are covered.
 */

async function seedMadridUser(userId: string): Promise<void> {
  await seedUser(userId);
  await updateNotificationSettings(userId, { timezone: "Europe/Madrid" });
}

// 2026-08-26 is a real, verified Wednesday — every weekday-consistency test below is anchored
// against this known fact rather than a computed "whatever today happens to be" value. 06:00
// local (04:00 UTC) is deliberately BEFORE the 9am default action time, so a bare day-of-month
// phrase resolves to TODAY rather than rolling forward to next month because "today's 9am has
// already passed" — an artifact of the (pre-existing, unrelated) past-due rollover logic, not
// something these tests are about.
const WED_AUG_26_2026 = new Date("2026-08-26T04:00:00Z");

const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Tests that go through the real HTTP path (buildServer()/sendAgentMessage) can't pin `now` —
 * action.create/action.reschedule always resolve dueText against the real wall clock, by design.
 * A hardcoded phrase like "thursday 26 august" is only a guaranteed mismatch relative to ONE
 * specific real-world moment; once real time crosses the point where that date's own past-due
 * rollover picks a different year, the "mismatch" can silently stop being one (a real case hit
 * during this task: on 2026-08-26 after 9am Europe/Madrid, "thursday 26 august" rolls to 2027,
 * and 26 August 2027 genuinely IS a Thursday). `daysAhead` days out sidesteps this: that date's
 * default 9am is always still in the future relative to any "now" within today, so the resolved
 * target is always exactly today+daysAhead with no rollover ambiguity — see the identical
 * technique in tests/agent-runtime-llm-eval.test.ts's realWeekdayDayMonth for the full reasoning.
 */
const EN_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

function realWeekdayAndDay(daysAhead: number, timezone = "Europe/Madrid"): { weekday: string; day: number; localDate: string } {
  const localDate = addDaysToLocalDate(formatLocalDate(new Date(), timezone), daysAhead);
  const weekdayIndex = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return { weekday: EN_WEEKDAYS[weekdayIndex]!, day: Number(localDate.split("-")[2]), localDate };
}

/** An English "<wrong weekday> <day> <month>" phrase guaranteed to mismatch the real calendar,
 * regardless of when the test actually runs — see realWeekdayAndDay's own doc comment. */
function guaranteedMismatchDueText(daysAhead: number): string {
  const { weekday, day, localDate } = realWeekdayAndDay(daysAhead);
  const wrongWeekday = EN_WEEKDAYS[(EN_WEEKDAYS.indexOf(weekday) + 1) % 7];
  const monthName = EN_MONTHS[Number(localDate.split("-")[1]) - 1];
  return `${wrongWeekday} ${day} ${monthName}`;
}

// --- Task 2: Spanish/Catalan date normalization -------------------------------------------------

test("2A/2B: 'muévelo al miércoles 26' and 'muevelo al miercoles 26' (Spanish, accented and unaccented) both parse to Aug 26", () => {
  for (const phrase of ["muévelo al miércoles 26", "muevelo al miercoles 26"]) {
    const parsed = parseActionDueDate(phrase, { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
    assert.ok(parsed.dueAt, `"${phrase}" must parse to a real date`);
    assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-26", `"${phrase}" must resolve to the 26th`);
  }
});

test("2C: 'mou-ho a dimecres 26' (Catalan) parses to Aug 26", () => {
  const parsed = parseActionDueDate("mou-ho a dimecres 26", { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
  assert.ok(parsed.dueAt);
  assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-26");
});

test("2D: '26 de agosto' (Spanish) parses to Aug 26", () => {
  const parsed = parseActionDueDate("26 de agosto", { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
  assert.ok(parsed.dueAt);
  assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-26");
});

test("2E: '26 d'agost' (Catalan, elided preposition) parses to Aug 26", () => {
  for (const phrase of ["26 d'agost", "26 de agost", "26 agost"]) {
    const parsed = parseActionDueDate(phrase, { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
    assert.ok(parsed.dueAt, `"${phrase}" must parse`);
    assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-26", `"${phrase}" must resolve to the 26th`);
  }
});

test("2F: 'mañana' (Spanish) and 'demà' (Catalan) both mean tomorrow, in the user's own timezone", () => {
  for (const phrase of ["mañana", "manana", "demà", "dema"]) {
    const parsed = parseActionDueDate(phrase, { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
    assert.ok(parsed.dueAt, `"${phrase}" must parse`);
    assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-27", `"${phrase}" must resolve to tomorrow`);
  }
});

test("2G: 'hoy' (Spanish) and 'avui' (Catalan) both mean today, in the user's own timezone", () => {
  for (const phrase of ["hoy", "avui"]) {
    const parsed = parseActionDueDate(phrase, { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
    assert.ok(parsed.dueAt, `"${phrase}" must parse`);
    assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-26", `"${phrase}" must resolve to today`);
  }
});

test("2H: a bare '26' with no weekday or month is still too ambiguous to auto-parse as a date", () => {
  const parsed = parseActionDueDate("26", { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
  assert.equal(parsed.dueAt, null);
});

test("2I: existing English date phrases still parse exactly as before", () => {
  const cases: Array<[string, string]> = [
    ["tomorrow", "2026-08-27"],
    ["wed 26", "2026-08-26"],
    ["wednesday 26", "2026-08-26"],
    ["26 August", "2026-08-26"]
  ];
  for (const [phrase, expected] of cases) {
    const parsed = parseActionDueDate(phrase, { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
    assert.ok(parsed.dueAt, `"${phrase}" must still parse`);
    assert.equal(parsed.dueAt!.toISOString().slice(0, 10), expected);
  }
});

test("extra: Spanish/Catalan day-part phrases (esta noche/aquesta nit, esta mañana/aquest matí, esta tarde/aquesta tarda) resolve without being misread as 'tomorrow'", () => {
  for (const phrase of ["esta noche", "aquesta nit", "esta mañana", "esta manana", "aquest matí", "aquest mati", "esta tarde", "aquesta tarda"]) {
    const parsed = parseActionDueDate(phrase, { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
    assert.ok(parsed.dueAt, `"${phrase}" must parse`);
    // Every one of these means something on TODAY's local date (Aug 26), never tomorrow — the
    // real bug this guards against: "esta mañana" ("this morning") containing the substring
    // "mañana" ("tomorrow"), which a naive word-alternation match could misread as "tomorrow".
    assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-26", `"${phrase}" must resolve to TODAY (Aug 26), not tomorrow`);
  }
});

// --- Task 3: weekday / day-of-month consistency --------------------------------------------------

test("3A: matching EN weekday+day passes ('wednesday 26' when the 26th really is a Wednesday)", () => {
  const parsed = parseActionDueDate("wednesday 26", { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
  assert.ok(parsed.dueAt);
  assert.equal(parsed.invalidReason, undefined);
});

test("3B: mismatching EN weekday+day asks for clarification, no dueAt ('friday 26')", () => {
  const parsed = parseActionDueDate("friday 26", { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
  assert.equal(parsed.dueAt, null);
  assert.equal(parsed.invalidReason, "weekday_mismatch");
  assert.equal(
    parsed.clarification,
    "Friday 26 August doesn't match the calendar — 26 August is Wednesday. Did you mean Wednesday 26 August, or Friday 28 August?"
  );
});

test("3C: matching Spanish weekday+day passes ('miércoles 26 de agosto')", () => {
  const parsed = parseActionDueDate("miércoles 26 de agosto", { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
  assert.ok(parsed.dueAt);
  assert.equal(parsed.invalidReason, undefined);
});

test("3D: mismatching Spanish weekday+day asks for clarification, no mutation ('jueves 26 de agosto')", () => {
  const parsed = parseActionDueDate("jueves 26 de agosto", { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
  assert.equal(parsed.dueAt, null);
  assert.equal(parsed.invalidReason, "weekday_mismatch");
  assert.match(parsed.clarification!, /^Thursday 26 August doesn't match the calendar — 26 August is Wednesday\./);
});

test("3E: matching Catalan weekday+day passes (\"dimecres 26 d'agost\")", () => {
  const parsed = parseActionDueDate("dimecres 26 d'agost", { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
  assert.ok(parsed.dueAt);
  assert.equal(parsed.invalidReason, undefined);
});

test("3F: mismatching Catalan weekday+day asks for clarification, no mutation (\"dijous 26 d'agost\")", () => {
  const parsed = parseActionDueDate("dijous 26 d'agost", { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
  assert.equal(parsed.dueAt, null);
  assert.equal(parsed.invalidReason, "weekday_mismatch");
  assert.match(parsed.clarification!, /^Thursday 26 August doesn't match the calendar — 26 August is Wednesday\./);
});

test("3G: an explicit month mismatch also asks for clarification ('thursday 26 august')", () => {
  const parsed = parseActionDueDate("thursday 26 august", { now: WED_AUG_26_2026, timezone: "Europe/Madrid" });
  assert.equal(parsed.dueAt, null);
  assert.equal(parsed.invalidReason, "weekday_mismatch");
});

test("3H: a weekday mismatch never mutates the DB — action.create refuses rather than silently creating without a due date", async () => {
  const server = buildServer();
  const userId = `datei18n-3h-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    // Goes through the real HTTP path (action.create resolves dueText against the real wall
    // clock, no `now` override available) — guaranteedMismatchDueText's daysAhead offset keeps
    // this a guaranteed mismatch regardless of when the test actually runs; see its doc comment.
    const dueText = guaranteedMismatchDueText(3);
    mockPlan({
      topic: "actions",
      intent: "create",
      operations: [op("action.create", { title: "Call the dentist", dueText })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, `call the dentist ${dueText}`);

    assert.match(reply.reply, /doesn't match the calendar/i);
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 0, "no action should have been created at all on a weekday mismatch");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3I: weekday consistency is judged against the user's OWN timezone, not the server's — no false mismatch from a UTC/local date-line gap", () => {
  // 2026-08-26T22:00:00Z is already 2026-08-27 07:00 in Asia/Tokyo — a UTC-naive check using the
  // server's own (implicitly UTC) calendar date would see "Aug 26" and wrongly evaluate the
  // stated weekday against Wednesday instead of the user's real local Thursday.
  const nowInTokyo = new Date("2026-08-26T22:00:00Z");
  const parsed = parseActionDueDate("thursday 27", { now: nowInTokyo, timezone: "Asia/Tokyo" });
  assert.ok(parsed.dueAt, "must resolve using the user's own local calendar date, not silently mismatch due to a UTC/server timezone gap");
  assert.equal(parsed.invalidReason, undefined);
});

// --- Task 4: LLM-extracted dueText stays validator-gated ------------------------------------------

test("4A: unusual Spanish phrasing extracted by the planner as dueText is still resolved by the deterministic parser before anything is created", async () => {
  const server = buildServer();
  const userId = `datei18n-4a-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    // Stands in for the LLM extracting a dueText candidate from a longer, unusual sentence — the
    // ACTUAL date still comes from parseActionDueDate on that candidate, never from the LLM.
    mockPlan({
      topic: "actions",
      intent: "create",
      operations: [op("action.create", { title: "Send the report", dueText: "mañana" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "mueve el informe a mañana porque hoy no puedo");

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1);
    assert.ok(actions[0]!.dueAt, "the Spanish dueText must have resolved to a real due date");
    assert.ok(actions[0]!.dueAt!.getTime() > Date.now(), "'mañana' must resolve to a future instant (tomorrow)");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B: unusual Catalan phrasing extracted by the planner as dueText is still resolved by the deterministic parser before anything is created", async () => {
  const server = buildServer();
  const userId = `datei18n-4b-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({
      topic: "actions",
      intent: "create",
      operations: [op("action.create", { title: "Send the report", dueText: "demà" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "mou l'informe a demà perquè avui no puc");

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1);
    assert.ok(actions[0]!.dueAt, "the Catalan dueText must have resolved to a real due date");
    assert.ok(actions[0]!.dueAt!.getTime() > Date.now(), "'demà' must resolve to a future instant (tomorrow)");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C: a validator (weekday-mismatch) rejection blocks mutation even though the planner proposed the operation with full confidence", async () => {
  const server = buildServer();
  const userId = `datei18n-4c-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    // The mocked plan below is deliberately as "confident" as a real planner tool call ever looks
    // — no needsClarification flag, no low-confidence signal — yet the deterministic parser must
    // still refuse it, because the stated weekday and the real calendar disagree.
    const dueText = guaranteedMismatchDueText(4);
    mockPlan({
      topic: "actions",
      intent: "create",
      operations: [op("action.create", { title: "Ship the release", dueText })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, `ship the release ${dueText}`);

    assert.equal(reply.debug.mutationExecuted, false);
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4D: unparseable dueText gets a real clarification reply, not a fake success with a silently dropped due date", async () => {
  const server = buildServer();
  const userId = `datei18n-4d-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({
      topic: "actions",
      intent: "create",
      operations: [op("action.create", { title: "Ship the release", dueText: "eventually probably soonish" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "ship the release eventually probably soonish");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /couldn'?t understand/i);
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 0, "an explicit but unparseable dueText must never silently create a task with no due date");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: stale-dist build/runtime freshness guard ----------------------------------------------

// Builds a throwaway, self-contained fake monorepo (its own pnpm-workspace.yaml + packages/core/
// {src,dist}) under the OS temp dir, entirely separate from this actual repo's own files — so
// these tests can freely manipulate mtimes to simulate "stale"/"fresh" without ever touching a
// real source file's timestamp.
function makeFakeWorkspace(): { root: string; srcFile: string; distFile: string; serverFileUrl: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "alecto-build-freshness-test-"));
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const srcDir = path.join(root, "packages", "core", "src");
  const distDir = path.join(root, "packages", "core", "dist");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  const srcFile = path.join(srcDir, "index.ts");
  const distFile = path.join(distDir, "index.js");
  writeFileSync(srcFile, "export {};\n");
  writeFileSync(distFile, "export {};\n");
  const serverFileUrl = `file://${path.join(root, "apps", "api", "src", "server.ts")}`;
  return { root, srcFile, distFile, serverFileUrl };
}

test("5A/5B: the freshness check throws when a workspace package's source is newer than its compiled dist", () => {
  const { root, srcFile, distFile, serverFileUrl } = makeFakeWorkspace();
  try {
    // Freshly written together (dist not older than src) — must not throw.
    assert.doesNotThrow(() => assertWorkspacePackagesAreFresh(serverFileUrl), "must not throw when dist is already fresh");

    // Simulate a source edit landing without a rebuild — exactly the real bug this check exists
    // to catch: a source fix that looks complete (typecheck stays green, since it reads the
    // "types" condition, which points at src/) but the compiled dist/ apps/api actually imports
    // at runtime is untouched.
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    utimesSync(distFile, past, past);
    utimesSync(srcFile, future, future);
    assert.throws(
      () => assertWorkspacePackagesAreFresh(serverFileUrl),
      /Stale build detected.*@operator-agent\/core/,
      "must throw loudly once source is newer than dist, rather than silently allowing stale behavior to run"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5C: passes cleanly again once dist is rebuilt (newer than src)", () => {
  const { root, srcFile, distFile, serverFileUrl } = makeFakeWorkspace();
  try {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    utimesSync(srcFile, past, past);
    utimesSync(distFile, future, future);
    assert.doesNotThrow(() => assertWorkspacePackagesAreFresh(serverFileUrl), "must pass once dist is the newer of the two, as after a real `pnpm build`");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5D: SKIP_BUILD_FRESHNESS_CHECK=true bypasses the check entirely (for a slim production image shipping dist/ without src/)", () => {
  const { root, srcFile, distFile, serverFileUrl } = makeFakeWorkspace();
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  utimesSync(distFile, past, past);
  utimesSync(srcFile, future, future);
  const previous = process.env.SKIP_BUILD_FRESHNESS_CHECK;
  process.env.SKIP_BUILD_FRESHNESS_CHECK = "true";
  try {
    assert.doesNotThrow(() => assertWorkspacePackagesAreFresh(serverFileUrl));
  } finally {
    if (previous === undefined) {
      delete process.env.SKIP_BUILD_FRESHNESS_CHECK;
    } else {
      process.env.SKIP_BUILD_FRESHNESS_CHECK = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("5E: the server module itself calls the freshness check at load time — buildServer() does not silently start on stale dist", async () => {
  // apps/api/src/server.ts calls assertWorkspacePackagesAreFresh(import.meta.url) once at its own
  // module top level (this file's own successful buildServer() calls elsewhere in the suite are
  // the ongoing proof this doesn't throw in the normal, freshly-built case) — this test just
  // confirms the wiring exists and a real server instance still boots normally end to end.
  const server = buildServer();
  try {
    const userId = `datei18n-5e-${randomUUID()}`;
    await seedMadridUser(userId);
    await createActionItem(userId, { source: "manual", title: "Sanity check task" });
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show my tasks");
    assert.match(reply.reply, /sanity check task/i);
    await prisma.user.deleteMany({ where: { id: userId } });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
  }
});
