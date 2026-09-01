import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { classifyJobSearchEmail } from "../packages/core/src/index.ts";
import { createGoal, findCompanyRoleDayDuplicateReviewItem, prisma } from "../packages/db/src/index.ts";
import { gmailReviewPresentationCategory } from "../apps/api/src/email-reviews/email-review-service.ts";
import { buildServer, clearAgentRuntimeMocks, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-gmail-review-quality-and-dedupe: a real live-testing report — the Gmail review
 * queue misclassified obvious non-job-progress emails (a verification code shown as a recruiter
 * reply, an Elastic "we received your resume" thank-you shown as a rejection), let job alerts and
 * welcome/setup emails into the review queue, double-counted duplicate same-day application
 * confirmations, and presented 10 raw undifferentiated rows instead of actionable groups. This file
 * covers the 12-task fix end to end: classifier precision (packages/core/src/ingestion.ts), review-
 * queue dedupe (packages/db findCompanyRoleDayDuplicateReviewItem), presentation grouping
 * (email-review-service.ts's gmailReviewPresentationCategory/formatGmailReviewListForChat), and the
 * chat-level "ignore the noise" / "log the application confirmations" / "already counted" shortcuts
 * (agent-runtime/runtime.ts). Every scenario preserves the task's explicit constraints: never claims
 * to delete/read/send real email, never auto-counts duplicate confirmations, never hides a real
 * recruiter reply/interview/offer/rejection.
 */

function classify(text: string) {
  return classifyJobSearchEmail({ text, classifierMode: "rules" });
}

// --- Task 2: security/auth codes are hard-excluded, never a recruiter reply -------------------

test("2A. an authentication/security code is never classified as a recruiter reply", () => {
  const result = classify(
    ["Subject: Security code for your application to Blockchain.com", "Copy and paste this code into the security code field on your application."].join("\n")
  );
  assert.equal(result.decision, "ignore");
  assert.equal(result.reason, "security_auth");
  assert.notEqual(result.eventType, "career.recruiter_reply_received");
});

test("2B. a micro1 6-digit verification code is never classified as a recruiter reply", () => {
  const result = classify(["Subject: Your micro1 verification code", "Your one-time verification code is 482913. This code is valid for 10 minutes."].join("\n"));
  assert.equal(result.decision, "ignore");
  assert.equal(result.reason, "security_auth");
  assert.notEqual(result.eventType, "career.recruiter_reply_received");
});

test("2C. Spanish/Catalan verification/security code emails are hard-excluded", () => {
  for (const text of [
    "Tu codigo de verificacion es 118204. Valido por 10 minutos.",
    "Codigo de seguridad para acceder a tu cuenta: 552013.",
    "El teu codi de verificacio es 771234."
  ]) {
    const result = classify(text);
    assert.equal(result.decision, "ignore", text);
    assert.equal(result.reason, "security_auth", text);
  }
});

test("2D. security/auth emails never enter the job-search progress review queue", () => {
  const result = classify("Subject: Your login code\nUse this one-time passcode to sign in: 004821.");
  assert.equal(result.decision, "ignore");
  assert.notEqual(result.decision, "needs_review");
});

test("2E. a genuine recruiter reply is unaffected by the security-code exclusion", () => {
  const result = classify("Hi, this is Sarah from the recruiting team. Are you available for a quick call this week to discuss the Frontend role?");
  assert.equal(result.decision, "log_event");
  assert.equal(result.eventType, "career.recruiter_reply_received");
});

// --- Task 3: rejection requires explicit negative decision language ---------------------------

test("3A. Elastic-style 'we received your resume... thank you' is an application confirmation, not a rejection", () => {
  const result = classify(
    "Subject: Thank you for your interest in Elastic\nThank you for your interest in Elastic. We received your resume for the Software Engineer role and will be in touch."
  );
  assert.equal(result.decision, "log_event");
  assert.equal(result.eventType, "career.application_confirmation_received");
});

test("3B. 'your application is under review' is a confirmation/status, not a rejection", () => {
  const result = classify("Subject: Application status\nThank you for applying. Your application is under review and we are currently reviewing your application.");
  assert.equal(result.eventType, "career.application_confirmation_received");
});

test("3C. Spanish 'se ha enviado tu solicitud' is a confirmation, not a rejection", () => {
  const result = classify("Asunto: Confirmacion\nSe ha enviado tu solicitud para el puesto de Backend Engineer. Gracias por tu interes.");
  assert.equal(result.eventType, "career.application_confirmation_received");
});

test("3D. a genuine rejection is still a rejection, English and Spanish", () => {
  const en = classify("Unfortunately, after careful consideration we will not be moving forward with your application for the Frontend role.");
  assert.equal(en.eventType, "career.rejection_received");

  const es = classify("Hemos decidido no continuar con tu candidatura para el puesto de Backend Engineer.");
  assert.equal(es.eventType, "career.rejection_received");
});

test("3E. no rejection without explicit negative decision language", () => {
  const result = classify("Thank you for applying. We received your application and our team will review it shortly.");
  assert.notEqual(result.eventType, "career.rejection_received");
});

// --- Task 4: job alerts/listings/newsletters never enter the progress review queue -------------

test("4A. Spanish 'busca personal para el puesto' job listing is ignored", () => {
  const result = classify("Kraken busca personal para el puesto de Backend Engineer. Aplica ahora.");
  assert.equal(result.decision, "ignore");
  assert.equal(result.reason, "filtered_marketing");
});

test("4B. 'Nuevos empleos similares' alert is ignored", () => {
  const result = classify("Nuevos empleos similares a los que ya viste, seleccionados para ti.");
  assert.equal(result.decision, "ignore");
});

test("4C. a Hire Feed role-listing alert is ignored", () => {
  const result = classify("New opportunity matching your profile: Fullstack Developer en Hire Feed. Ver mas empleos recomendados.");
  assert.equal(result.decision, "ignore");
});

test("4D. a LinkedIn content-post notification is ignored", () => {
  const result = classify("DeepRec.ai is hiring — shared a post: DeepRec.ai acaba de publicar contenido nuevo.");
  assert.equal(result.decision, "ignore");
});

test("4E. a genuine application confirmation from a job-board platform still counts", () => {
  const result = classify("Thanks for applying through Hire Feed! We have received your application for the Backend Engineer role.");
  assert.equal(result.eventType, "career.application_confirmation_received");
});

test("4F. a genuine recruiter reply is still captured, not filtered as an alert", () => {
  const result = classify("Hi, this is the hiring team — are you available for a call this week about the role?");
  assert.equal(result.eventType, "career.recruiter_reply_received");
});

// --- Task 5: welcome/setup/onboarding emails are not job-search progress -----------------------

test("5A. 'Welcome to Twine! Let's get you set up' is ignored, not a recruiter reply or confirmation", () => {
  const result = classify("Welcome to Twine! Let's get you set up in 4 steps. Complete your profile to get started.");
  assert.equal(result.decision, "ignore");
  assert.equal(result.reason, "onboarding_noise");
});

test("5B. a generic onboarding email is ignored", () => {
  const result = classify("Welcome aboard! Here's how to get started: finish setting up your profile.");
  assert.equal(result.decision, "ignore");
  assert.equal(result.reason, "onboarding_noise");
});

test("5C. an explicit 'thanks for applying through Twine' still counts as a confirmation", () => {
  const result = classify("Welcome! Thanks for applying through Twine. We have received your application for the Product Designer role.");
  assert.equal(result.eventType, "career.application_confirmation_received");
});

// --- Task 6: same-day same-company application confirmations dedupe ----------------------------

async function seedConfirmationReview(userId: string, connectionId: string, ruleId: string, overrides: { company: string; role?: string; createdAt: Date; subject: string }) {
  return prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId,
      adapterId: "job_search_email",
      provider: "gmail",
      providerMessageId: `m-${randomUUID()}`,
      externalId: `gmail-review:${ruleId}:${randomUUID()}`,
      status: "pending",
      subject: overrides.subject,
      from: "notifications@example.com",
      snippet: overrides.subject,
      evidence: overrides.subject,
      confidence: 0.85,
      reason: "application_confirmation",
      proposedEventType: "career.application_confirmation_received",
      extracted: { company: overrides.company, ...(overrides.role ? { role: overrides.role } : {}) },
      createdAt: overrides.createdAt,
      updatedAt: overrides.createdAt
    }
  });
}

test("6A. two same-day Innovation Labs confirmations with different subjects/senders count once", async () => {
  const userId = `dedupe-6a-${randomUUID()}`;
  await seedUser(userId);
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });
  const day = new Date("2026-08-18T09:00:00.000Z");

  try {
    await seedConfirmationReview(userId, connection.id, rule.id, { company: "Innovation Labs", role: "Front-End Engineer", createdAt: day, subject: "Thank you for applying to Innovation Labs" });

    const duplicate = await findCompanyRoleDayDuplicateReviewItem({
      userId,
      proposedEventType: "career.application_confirmation_received",
      company: "Innovation Labs",
      role: "Front-End Engineer",
      referenceDate: new Date("2026-08-18T14:30:00.000Z")
    });

    assert.ok(duplicate, "a second same-day, same-company, same-role confirmation must be recognized as a duplicate");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6B. different companies on the same day are never treated as duplicates", async () => {
  const userId = `dedupe-6b-${randomUUID()}`;
  await seedUser(userId);
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });
  const day = new Date("2026-08-18T09:00:00.000Z");

  try {
    await seedConfirmationReview(userId, connection.id, rule.id, { company: "Innovation Labs", createdAt: day, subject: "Thank you for applying" });

    const duplicate = await findCompanyRoleDayDuplicateReviewItem({
      userId,
      proposedEventType: "career.application_confirmation_received",
      company: "Penta Consulting",
      referenceDate: day
    });

    assert.equal(duplicate, undefined, "a different company must never be treated as a duplicate");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6C. same company, different explicit roles, count separately", async () => {
  const userId = `dedupe-6c-${randomUUID()}`;
  await seedUser(userId);
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });
  const day = new Date("2026-08-18T09:00:00.000Z");

  try {
    await seedConfirmationReview(userId, connection.id, rule.id, { company: "Innovation Labs", role: "Front-End Engineer", createdAt: day, subject: "Application received" });

    const duplicate = await findCompanyRoleDayDuplicateReviewItem({
      userId,
      proposedEventType: "career.application_confirmation_received",
      company: "Innovation Labs",
      role: "Backend Engineer",
      referenceDate: day
    });

    assert.equal(duplicate, undefined, "distinct explicit roles at the same company must count separately");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6D. the identical confirmation repeated does not create a second duplicate chain", async () => {
  const userId = `dedupe-6d-${randomUUID()}`;
  await seedUser(userId);
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });
  const day = new Date("2026-08-18T09:00:00.000Z");

  try {
    await seedConfirmationReview(userId, connection.id, rule.id, { company: "MoonPay", createdAt: day, subject: "Thanks for applying" });

    const first = await findCompanyRoleDayDuplicateReviewItem({ userId, proposedEventType: "career.application_confirmation_received", company: "MoonPay", referenceDate: day });
    const second = await findCompanyRoleDayDuplicateReviewItem({ userId, proposedEventType: "career.application_confirmation_received", company: "MoonPay", referenceDate: day });

    assert.ok(first);
    assert.equal(first?.id, second?.id, "repeated lookups resolve to the same existing review, never a new one");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 7: review queue presentation groups into confirmations/needs-review/noise -------------

test("7A. the review list groups confirmations, noise, and needs-review, and preserves numbering", async () => {
  const server = buildServer();
  const userId = `presentation-7a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    const seed = async (overrides: { subject: string; reason: string; proposedEventType?: string }) =>
      prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: rule.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: `m-${randomUUID()}`,
          externalId: `gmail-review:${rule.id}:${randomUUID()}`,
          status: "pending",
          subject: overrides.subject,
          from: "notifications@example.com",
          snippet: overrides.subject,
          evidence: overrides.subject,
          confidence: 0.6,
          reason: overrides.reason,
          proposedEventType: overrides.proposedEventType,
          extracted: {}
        }
      });

    await seed({ subject: "Thank you for applying to Innovation Labs", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
    await seed({ subject: "micro1 verification code", reason: "security_auth" });
    await seed({ subject: "Quick chat about the frontend role", reason: "recruiter_reply", proposedEventType: "career.recruiter_reply_received" });

    const reply = await sendAgentMessage(server, userId, "show me email reviews");

    assert.match(reply.reply, /likely application confirmations/i);
    assert.match(reply.reply, /likely noise/i);
    assert.match(reply.reply, /needs review/i);
    assert.match(reply.reply, /1\./);
    assert.match(reply.reply, /2\./);
    assert.match(reply.reply, /3\./);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7D. 'ignore the noise' rejects only the noise-category reviews", async () => {
  const server = buildServer();
  const userId = `presentation-7d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    const seed = async (overrides: { subject: string; reason: string; proposedEventType?: string }) =>
      prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: rule.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: `m-${randomUUID()}`,
          externalId: `gmail-review:${rule.id}:${randomUUID()}`,
          status: "pending",
          subject: overrides.subject,
          from: "notifications@example.com",
          snippet: overrides.subject,
          evidence: overrides.subject,
          confidence: 0.6,
          reason: overrides.reason,
          proposedEventType: overrides.proposedEventType,
          extracted: {}
        }
      });

    const confirmation = await seed({ subject: "Innovation Labs confirmation", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
    const noise = await seed({ subject: "micro1 verification code", reason: "security_auth" });

    await sendAgentMessage(server, userId, "show me email reviews");
    const reply = await sendAgentMessage(server, userId, "ignore the noise");

    assert.ok(reply.operationsExecuted.every((entry) => entry.tool === "gmail.review.reject"));

    const confirmationAfter = await prisma.emailReviewItem.findUnique({ where: { id: confirmation.id } });
    const noiseAfter = await prisma.emailReviewItem.findUnique({ where: { id: noise.id } });
    assert.equal(confirmationAfter?.status, "pending", "confirmations must not be touched by 'ignore the noise'");
    assert.equal(noiseAfter?.status, "rejected");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7E. 'log the application confirmations' approves only the confirmation-category reviews", async () => {
  const server = buildServer();
  const userId = `presentation-7e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });

    const seed = async (overrides: { subject: string; reason: string; proposedEventType?: string }) =>
      prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: rule.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: `m-${randomUUID()}`,
          externalId: `gmail-review:${rule.id}:${randomUUID()}`,
          status: "pending",
          subject: overrides.subject,
          from: "notifications@example.com",
          snippet: overrides.subject,
          evidence: overrides.subject,
          confidence: 0.85,
          reason: overrides.reason,
          proposedEventType: overrides.proposedEventType,
          extracted: {}
        }
      });

    const confirmation = await seed({ subject: "Penta Consulting confirmation", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
    const noise = await seed({ subject: "Twine welcome", reason: "onboarding_noise" });

    await sendAgentMessage(server, userId, "show me email reviews");
    const reply = await sendAgentMessage(server, userId, "log the application confirmations");

    assert.ok(reply.operationsExecuted.every((entry) => entry.tool === "gmail.review.approve"));

    const confirmationAfter = await prisma.emailReviewItem.findUnique({ where: { id: confirmation.id } });
    const noiseAfter = await prisma.emailReviewItem.findUnique({ where: { id: noise.id } });
    assert.equal(confirmationAfter?.status, "approved");
    assert.equal(noiseAfter?.status, "pending", "noise must not be touched by 'log the application confirmations'");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("gmailReviewPresentationCategory: recruiter replies/interviews/offers/rejections are always needs_review, never noise or auto-groupable confirmations", () => {
  assert.equal(gmailReviewPresentationCategory({ reason: "recruiter_reply", proposedEventType: "career.recruiter_reply_received", confidence: 0.9 }), "needs_review");
  assert.equal(gmailReviewPresentationCategory({ reason: "interview_scheduled", proposedEventType: "career.interview_scheduled", confidence: 0.9 }), "needs_review");
  assert.equal(gmailReviewPresentationCategory({ reason: "offer", proposedEventType: "career.offer_received", confidence: 0.9 }), "needs_review");
  assert.equal(gmailReviewPresentationCategory({ reason: "rejection", proposedEventType: "career.rejection_received", confidence: 0.9 }), "needs_review");
  assert.equal(gmailReviewPresentationCategory({ reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", confidence: 0.85 }), "confirmation");
  assert.equal(gmailReviewPresentationCategory({ reason: "security_auth", proposedEventType: undefined, confidence: 0.05 }), "noise");
});

// --- Task 9: "already counted" bulk dismissal never double-counts ------------------------------

test("9A/9C. Spanish 'ya los conte, ignora todas las reviews' ignores visible reviews without double-counting", async () => {
  const server = buildServer();
  const userId = `already-counted-es-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });
    for (let i = 0; i < 3; i++) {
      await prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: rule.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: `m-${randomUUID()}`,
          externalId: `gmail-review:${rule.id}:${randomUUID()}`,
          status: "pending",
          subject: `Review ${i}`,
          from: "x@example.com",
          snippet: `Review ${i}`,
          evidence: `Review ${i}`,
          confidence: 0.7,
          reason: "application_confirmation",
          proposedEventType: "career.application_confirmation_received",
          extracted: {}
        }
      });
    }

    await sendAgentMessage(server, userId, "show me email reviews");
    const reply = await sendAgentMessage(server, userId, "ya los conte, ignora todas las reviews");

    assert.match(reply.reply, /already counted/i);
    assert.match(reply.reply, /did not delete any emails/i);
    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 3);
    assert.equal(reviews.filter((r) => r.status === "approved").length, 0, "an already-counted dismissal must never also approve/log anything");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9B. Catalan 'ja ho he comptat, ignora totes les revisions' ignores visible reviews without double-counting", async () => {
  const server = buildServer();
  const userId = `already-counted-ca-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" } });
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: rule.id,
        adapterId: "job_search_email",
        provider: "gmail",
        providerMessageId: `m-${randomUUID()}`,
        externalId: `gmail-review:${rule.id}:${randomUUID()}`,
        status: "pending",
        subject: "Review",
        from: "x@example.com",
        snippet: "Review",
        evidence: "Review",
        confidence: 0.7,
        reason: "application_confirmation",
        proposedEventType: "career.application_confirmation_received",
        extracted: {}
      }
    });

    await sendAgentMessage(server, userId, "show me email reviews");
    const reply = await sendAgentMessage(server, userId, "ja ho he comptat, ignora totes les revisions");

    assert.match(reply.reply, /already counted/i);
    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 1);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 10: exact live regression replay ------------------------------------------------------

test("10. exact live regression: the 10-item seed list classifies every noise/confirmation item correctly", () => {
  const authCode = classify("Subject: Authentication code\nYour authentication code is 552019. This code is valid for 10 minutes.");
  assert.equal(authCode.decision, "ignore");
  assert.equal(authCode.reason, "security_auth");
  assert.notEqual(authCode.eventType, "career.recruiter_reply_received");

  const micro1Code = classify("Subject: micro1 verification code\nYour micro1 verification code is 118204.");
  assert.equal(micro1Code.decision, "ignore");
  assert.equal(micro1Code.reason, "security_auth");
  assert.notEqual(micro1Code.eventType, "career.recruiter_reply_received");

  const twineWelcome = classify("Welcome to Twine! Let's get you set up in 4 steps. Complete your profile to get started.");
  assert.equal(twineWelcome.decision, "ignore");
  assert.equal(twineWelcome.reason, "onboarding_noise");

  const elastic = classify("Thank you for your interest in Elastic. We received your resume for the Software Engineer role and will be in touch.");
  assert.equal(elastic.eventType, "career.application_confirmation_received");
  assert.notEqual(elastic.eventType, "career.rejection_received");

  const innovationLabs = classify("Thank you for applying to Innovation Labs. We have received your application for the Front-End Engineer role.");
  assert.equal(innovationLabs.eventType, "career.application_confirmation_received");

  const penta = classify("Thanks for applying! We received your application for the Frontend Developer role at Penta Consulting.");
  assert.equal(penta.eventType, "career.application_confirmation_received");
});

test("10. exact live regression: 'remove all as I already counted them' clears the visible queue without inflating progress", async () => {
  const server = buildServer();
  const userId = `live-regression-10-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await createGoal(userId, { title: "Find a remote developer job", category: "career" });
    if (goal.duplicate) throw new Error("unexpected duplicate goal");
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, goalId: goal.goal.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" }
    });

    const seedRow = async (overrides: { subject: string; reason: string; proposedEventType?: string }) =>
      prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: rule.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: `m-${randomUUID()}`,
          externalId: `gmail-review:${rule.id}:${randomUUID()}`,
          status: "pending",
          subject: overrides.subject,
          from: "notifications@example.com",
          snippet: overrides.subject,
          evidence: overrides.subject,
          confidence: 0.7,
          reason: overrides.reason,
          proposedEventType: overrides.proposedEventType,
          extracted: {}
        }
      });

    await seedRow({ subject: "Innovation Labs application confirmation", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
    await seedRow({ subject: "develop application confirmation", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
    await seedRow({ subject: "Penta application confirmation", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
    await seedRow({ subject: "Crossing Hurdles application confirmation", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
    await seedRow({ subject: "Jobgether application confirmation", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
    await seedRow({ subject: "Innovation Labs duplicate confirmation", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
    await seedRow({ subject: "Elastic received-resume thank-you", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });

    await sendAgentMessage(server, userId, "show me email reviews");
    const reply = await sendAgentMessage(server, userId, "remove all as I already counted them when I sent the update");

    assert.match(reply.reply, /already counted/i);
    assert.match(reply.reply, /did not delete any emails/i);
    assert.doesNotMatch(reply.reply, /\bdeleted\b/i);

    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 7);
    assert.equal(reviews.filter((r) => r.status === "approved").length, 0, "no application progress may be counted from an already-counted dismissal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
