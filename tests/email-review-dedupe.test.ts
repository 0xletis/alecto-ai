import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  findGmailSemanticDuplicateEvent,
  findGmailSemanticDuplicateReviewItem,
  prisma
} from "../packages/db/src/index.ts";
import { classifyJobSearchEmail, classifyWorkActionEmail, normalizeManualActionTitleKey } from "../packages/core/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

const userId = `test-user-${randomUUID()}`;
const connectionId = randomUUID();
const ruleId = randomUUID();

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
    assert.equal(brief.goalStatus[0].note, "1 application sent today");
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

test("same manual task dedupes by due day even when timestamps differ", async () => {
  const server = buildServer();
  const actionUserId = `action-day-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Review homepage copy",
      priority: "medium",
      dueAt: new Date("2026-07-30T18:00:00.000Z")
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "I need to review the homepage copy 2026-07-30" }
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
    assert.match(payload.message, /Action due:/);
    assert.match(payload.message, new RegExp(`/complete_action ${action.id}`));
    assert.match(payload.message, new RegExp(`/snooze_action ${action.id} tomorrow`));
    assert.match(payload.message, new RegExp(`/archive_action ${action.id}`));
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
    assert.match(first.json().message, /Action due:/);

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
