import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createEmailSignalRule, prisma } from "../packages/db/src/index.ts";
import {
  formatGmailEmailRuleSelectionLines,
  getVisibleGmailEmailRules,
  groupEmailRulesForHumanDisplay,
  isBuiltInEmailAdapter
} from "../apps/api/src/gmail/gmail-rule-service.ts";

/**
 * Pure Gmail rule-management helpers extracted from apps/api/src/server.ts
 * (see docs/09-architecture-inventory.md's Gmail rule service extraction
 * entry). Previously only covered indirectly through the much larger
 * tests/email-review-dedupe.test.ts conversation-flow tests.
 */

const customRuleInput = {
  connectionId: "conn-1",
  adapterId: "custom_email_review" as const,
  fetchStrategy: "query" as const,
  lookbackDays: 30,
  maxMessagesPerSync: 25,
  maxEventsPerSync: 5,
  classifierMode: "rules" as const,
  minAutoLogConfidence: 1,
  minReviewConfidence: 0.65,
  reviewBeforeLogging: true,
  createdBy: "user" as const
};

test("isBuiltInEmailAdapter: only job_search_email and work_action_email are built-in", () => {
  assert.equal(isBuiltInEmailAdapter("job_search_email"), true);
  assert.equal(isBuiltInEmailAdapter("work_action_email"), true);
  assert.equal(isBuiltInEmailAdapter("custom_email_review"), false);
  assert.equal(isBuiltInEmailAdapter("something_else"), false);
});

function makeRule(overrides: Partial<{
  id: string; connectionId: string; adapterId: string; name: string; status: "active" | "paused" | "archived" | "error";
  query: string; createdBy: "system" | "user";
}>) {
  return {
    id: overrides.id ?? randomUUID(),
    userId: "u",
    connectionId: overrides.connectionId ?? "conn-1",
    adapterId: overrides.adapterId ?? "job_search_email",
    name: overrides.name ?? "Job search",
    status: overrides.status ?? ("active" as const),
    query: overrides.query ?? "is:unread",
    fetchStrategy: "query" as const,
    lookbackDays: 30,
    maxMessagesPerSync: 25,
    maxEventsPerSync: 5,
    classifierMode: "rules" as const,
    minAutoLogConfidence: 1,
    minReviewConfidence: 0.65,
    reviewBeforeLogging: true,
    createdBy: overrides.createdBy ?? ("system" as const),
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

test("groupEmailRulesForHumanDisplay: dedupes built-in adapter rules on the same connection/status/query, keeps custom rules distinct", () => {
  const rules = [
    makeRule({ id: "r1", connectionId: "conn-1", adapterId: "job_search_email", name: "Job search" }),
    makeRule({ id: "r2", connectionId: "conn-1", adapterId: "job_search_email", name: "Job search dup" }),
    makeRule({ id: "r3", connectionId: "conn-1", adapterId: "custom_email_review", name: "Endesa bills", query: "from:endesa.com", createdBy: "user" })
  ];

  const groups = groupEmailRulesForHumanDisplay(rules);
  assert.equal(groups.length, 2, "the two identical built-in rules on the same connection must collapse into one group");

  const builtInGroup = groups.find((group) => group.primary.adapterId === "job_search_email");
  assert.ok(builtInGroup);
  assert.equal(builtInGroup.rules.length, 2);

  const customGroup = groups.find((group) => group.primary.adapterId === "custom_email_review");
  assert.ok(customGroup);
  assert.equal(customGroup.rules.length, 1);
});

test("groupEmailRulesForHumanDisplay: built-in rules on different connections stay separate (no cross-account merging)", () => {
  const rules = [
    makeRule({ id: "r1", connectionId: "conn-1", adapterId: "job_search_email" }),
    makeRule({ id: "r2", connectionId: "conn-2", adapterId: "job_search_email" })
  ];

  assert.equal(groupEmailRulesForHumanDisplay(rules).length, 2);
});

test("formatGmailEmailRuleSelectionLines: reports duplicate counts, and status only for non-active groups when requested", () => {
  const activeDuplicates = [
    makeRule({ id: "r1", connectionId: "conn-1", adapterId: "job_search_email", name: "Job search" }),
    makeRule({ id: "r2", connectionId: "conn-1", adapterId: "job_search_email", name: "Job search dup" })
  ];

  const withoutStatus = formatGmailEmailRuleSelectionLines(activeDuplicates);
  assert.equal(withoutStatus.length, 1);
  assert.match(withoutStatus[0], /Job search/);
  assert.match(withoutStatus[0], /2 duplicate rules/);

  const pausedRule = [makeRule({ id: "r3", connectionId: "conn-2", adapterId: "custom_email_review", name: "Old tracking", status: "paused", createdBy: "user" })];

  const withoutStatusFlag = formatGmailEmailRuleSelectionLines(pausedRule);
  assert.doesNotMatch(withoutStatusFlag[0], /paused/);

  const withStatusFlag = formatGmailEmailRuleSelectionLines(pausedRule, { showStatus: true });
  assert.match(withStatusFlag[0], /paused/);
});

test("getVisibleGmailEmailRules: active connection detection, no duplicate rule creation, paused rules stay visible", async () => {
  const userId = `gmail-rule-service-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const connection = await prisma.integrationConnection.create({
      data: { userId, integrationId: "gmail", status: "active", config: {} }
    });

    // no rules yet
    assert.deepEqual(await getVisibleGmailEmailRules(userId), []);

    const rule = await createEmailSignalRule(userId, {
      ...customRuleInput,
      connectionId: connection.id,
      name: "Endesa bills",
      query: "from:endesa.com"
    });

    const visible = await getVisibleGmailEmailRules(userId);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, rule.id);

    // Existing-rule check mirrors applyPendingAction's create_rule duplicate guard: same connection,
    // adapter, and normalized query must be found before creating a second rule.
    const duplicateExists = visible.some(
      (existing) =>
        existing.status === "active" &&
        existing.connectionId === connection.id &&
        existing.adapterId === "custom_email_review" &&
        existing.query === "from:endesa.com"
    );
    assert.equal(duplicateExists, true);

    // paused rules remain visible (not archived), only archived rules disappear
    await prisma.emailSignalRule.update({ where: { id: rule.id }, data: { status: "paused" } });
    const afterPause = await getVisibleGmailEmailRules(userId);
    assert.equal(afterPause.length, 1);
    assert.equal(afterPause[0].status, "paused");

    await prisma.emailSignalRule.update({ where: { id: rule.id }, data: { status: "archived" } });
    const afterArchive = await getVisibleGmailEmailRules(userId);
    assert.equal(afterArchive.length, 0);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("getVisibleGmailEmailRules: rules on an archived Gmail connection are not visible", async () => {
  const userId = `gmail-rule-service-archived-conn-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const connection = await prisma.integrationConnection.create({
      data: { userId, integrationId: "gmail", status: "archived", config: {} }
    });
    await createEmailSignalRule(userId, {
      ...customRuleInput,
      connectionId: connection.id,
      name: "Stale rule",
      query: "from:old.com"
    });

    assert.deepEqual(await getVisibleGmailEmailRules(userId), []);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
