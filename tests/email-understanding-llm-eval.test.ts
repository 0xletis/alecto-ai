import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { understandEmail, validateEmailUnderstanding, type EmailKind, type SignalBucket } from "../packages/llm/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";
import { llmEvalOptions } from "./helpers/llm-eval-helpers.ts";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gates 6/7): broad, REAL-LLM
 * classification coverage for packages/llm/src/prompts/email-understanding.prompt.ts — every
 * domain the task's brief lists, in English and Spanish (Catalan where the product's real usage
 * pattern makes it relevant — job-search confirmations). Calls understandEmail() DIRECTLY (a
 * single real OpenAI call per fixture) rather than a full agent-runtime turn, since classification
 * accuracy is the thing under test here, not tool routing — agent-runtime-llm-eval.test.ts already
 * covers the full-turn product journeys.
 *
 * Gated exactly like every other real-LLM eval in this repo: `pnpm test:llm`
 * (RUN_LLM_EVALS=true + a real OPENAI_API_KEY) actually calls OpenAI; a plain `pnpm test` run
 * reports every scenario here as "skipped," never "passed" or "failed."
 */

const EVAL_TAGS = ["email-understanding"];

interface Fixture {
  name: string;
  subject: string;
  bodyExcerpt: string;
  senderDomain: string;
  expectedKind: EmailKind;
  expectedBucket?: SignalBucket;
}

const FIXTURES: Fixture[] = [
  {
    name: "application confirmation (EN)",
    subject: "Thanks for applying to Cohere",
    bodyExcerpt: "Thank you for applying to the Software Engineer role at Cohere. We have received your application and our team will review it shortly.",
    senderDomain: "cohere.example",
    expectedKind: "application_confirmation",
    expectedBucket: "new"
  },
  {
    name: "application confirmation (ES)",
    subject: "Se ha enviado tu solicitud a Iqana",
    bodyExcerpt: "Gracias por aplicar. Hemos recibido tu solicitud para el puesto de Software Engineer en Iqana. Este es un mensaje automático de confirmación.",
    senderDomain: "iqana.example",
    expectedKind: "application_confirmation",
    expectedBucket: "new"
  },
  {
    name: "application viewed (EN)",
    subject: "Your application was viewed",
    bodyExcerpt: "Good news — a recruiter at Okify viewed your application for the Backend Engineer role. No action is needed from you right now.",
    senderDomain: "okify.example",
    expectedKind: "application_viewed",
    expectedBucket: "status_update"
  },
  {
    name: "application viewed (ES)",
    subject: "Okify ha visto tu solicitud",
    bodyExcerpt: "Okify ha visto tu solicitud para el puesto de Backend Engineer. Esto es solo una actualizacion informativa, no se requiere ninguna accion.",
    senderDomain: "okify.example",
    expectedKind: "application_viewed",
    expectedBucket: "status_update"
  },
  {
    name: "recruiter reply (EN)",
    subject: "Following up on your application",
    bodyExcerpt: "Hi, this is Sarah from the talent team at Example Labs. I read through your application and would like to set up a quick call this week to discuss the Product Engineer role.",
    senderDomain: "examplelabs.example",
    expectedKind: "recruiter_reply",
    expectedBucket: "action_worthy"
  },
  {
    name: "interview request (EN)",
    subject: "Interview invitation - Backend Engineer",
    bodyExcerpt: "We would like to schedule an interview with you for the Backend Engineer position. Please let us know your availability next week for a 45 minute video call.",
    senderDomain: "hiring.example",
    expectedKind: "interview",
    expectedBucket: "action_worthy"
  },
  {
    name: "rejection (EN)",
    subject: "Update on your application",
    bodyExcerpt: "Thank you for taking the time to interview with us. Unfortunately, we have decided to move forward with other candidates for the Software Engineer role at this time.",
    senderDomain: "hiring.example",
    expectedKind: "rejection"
  },
  {
    name: "job alert (EN)",
    subject: "5 new jobs matching your search",
    bodyExcerpt: "New jobs similar to ones you have applied to: Frontend Developer at Acme, Backend Engineer at Widgets Inc, and 3 more. View all matches on LinkedIn.",
    senderDomain: "linkedin.example",
    expectedKind: "job_alert",
    expectedBucket: "noise"
  },
  {
    name: "job alert (ES)",
    subject: "3 nuevas ofertas de empleo para ti",
    bodyExcerpt: "Explora empleos similares a los que has solicitado: Ingeniero de Software en TechCorp, Analista de Datos en DataCo. Ve todas las coincidencias en LinkedIn.",
    senderDomain: "linkedin.example",
    expectedKind: "job_alert",
    expectedBucket: "noise"
  },
  {
    name: "profile status / open-to-work (EN)",
    subject: "You are no longer showing recruiters you're open to work",
    bodyExcerpt: "Your Open to Work preference has changed. Recruiters on LinkedIn can no longer see that you are open to new opportunities. You can update this anytime in your settings.",
    senderDomain: "linkedin.example",
    expectedBucket: "noise",
    expectedKind: "marketing"
  },
  {
    name: "connection suggestion (EN)",
    subject: "Add Dario Lo Buglio to your network",
    bodyExcerpt: "Miquel, we think you may know Dario Lo Buglio. Dario works as a Software Engineer at TechCorp. Would you like to connect?",
    senderDomain: "linkedin.example",
    expectedKind: "personal_message",
    expectedBucket: "noise"
  },
  {
    name: "invoice / payment due (EN)",
    subject: "Invoice #4471 from Endesa",
    bodyExcerpt: "Your invoice #4471 for 84.20 EUR is now ready. Payment is due by September 15. You can pay online or via direct debit.",
    senderDomain: "endesa.example",
    expectedKind: "invoice",
    expectedBucket: "action_worthy"
  },
  {
    name: "receipt (EN)",
    subject: "Your payment receipt",
    bodyExcerpt: "Thank you for your payment of 12.99 USD to Acme Streaming. This receipt confirms your payment was successfully processed on September 1.",
    senderDomain: "acmestreaming.example",
    expectedKind: "receipt"
  },
  {
    name: "travel booking (EN)",
    subject: "Your booking is confirmed",
    bodyExcerpt: "Your reservation at Hotel Example in Barcelona is confirmed for September 10 to September 12. Confirmation number: HTL-88213.",
    senderDomain: "hotelexample.example",
    expectedKind: "travel_booking",
    expectedBucket: "new"
  },
  {
    name: "flight update (EN)",
    subject: "Flight AB123 schedule change",
    bodyExcerpt: "Your flight AB123 from Barcelona to London departing September 10 has a new departure time of 14:20, changed from 12:00. Please check in online.",
    senderDomain: "airline.example",
    expectedKind: "flight_update",
    expectedBucket: "action_worthy"
  },
  {
    name: "subscription notice (EN)",
    subject: "Your subscription renews soon",
    bodyExcerpt: "Your Acme Streaming subscription will automatically renew on October 1 for 12.99 USD. You can manage or cancel your subscription anytime before then.",
    senderDomain: "acmestreaming.example",
    expectedKind: "subscription"
  },
  {
    name: "personal message (EN)",
    subject: "Quick question about Saturday",
    bodyExcerpt: "Hey, are we still on for Saturday at 6pm? Let me know if that still works for you or if we should move it. Talk soon!",
    senderDomain: "gmail.example",
    expectedKind: "personal_message"
  },
  {
    name: "marketing / noise (EN)",
    subject: "50% off everything this weekend only!",
    bodyExcerpt: "Don't miss out! Our biggest sale of the year starts now. Shop the entire store at 50% off, this weekend only. Unsubscribe anytime.",
    senderDomain: "shop.example",
    expectedKind: "marketing",
    expectedBucket: "noise"
  },
  {
    name: "security / auth (EN)",
    subject: "Your verification code",
    bodyExcerpt: "Your one-time verification code is 481923. This code will expire in 10 minutes. If you did not request this code, you can ignore this email.",
    senderDomain: "example.example",
    expectedKind: "security_auth",
    expectedBucket: "noise"
  }
];

for (const fixture of FIXTURES) {
  test(`email understanding: ${fixture.name}`, llmEvalOptions(EVAL_TAGS), async () => {
    const raw = await understandEmail({
      subject: fixture.subject,
      bodyExcerpt: fixture.bodyExcerpt,
      senderDomain: fixture.senderDomain
    });

    const validated = validateEmailUnderstanding(raw, `${fixture.subject} ${fixture.bodyExcerpt}`);
    const understanding = validated.understanding ?? raw;

    assert.equal(understanding.emailKind, fixture.expectedKind, `expected emailKind ${fixture.expectedKind}, got ${understanding.emailKind} (ambiguity: ${understanding.ambiguity ?? "none"})`);

    if (fixture.expectedBucket) {
      assert.equal(understanding.signalBucket, fixture.expectedBucket, `expected signalBucket ${fixture.expectedBucket}, got ${understanding.signalBucket}`);
    }

    // Gate 2: never a bare "uncertain signal" — a low-confidence result must carry a SPECIFIC
    // ambiguity sentence, not silence or a placeholder.
    if (understanding.confidence < 0.4 || understanding.signalBucket === "needs_decision") {
      assert.ok(understanding.ambiguity && understanding.ambiguity.length > 0, "a low-confidence/needs_decision result must explain the specific ambiguity");
      assert.doesNotMatch(understanding.ambiguity!, /^uncertain( signal)?$/i);
    }

    assert.ok(understanding.realWorldEvent.length > 0, "realWorldEvent must be populated");
  });
}

test("email understanding: Catalan job-search confirmation", llmEvalOptions(EVAL_TAGS), async () => {
  const raw = await understandEmail({
    subject: "S'ha enviat la teva sol·licitud",
    bodyExcerpt: "Gracies per aplicar. Hem rebut la teva sol·licitud per al lloc d'Enginyer de Software a TechCorp. Aquest es un missatge automatic de confirmacio.",
    senderDomain: "techcorp.example"
  });
  const validated = validateEmailUnderstanding(raw, "S'ha enviat la teva sol·licitud Gracies per aplicar TechCorp");
  const understanding = validated.understanding ?? raw;
  assert.equal(understanding.emailKind, "application_confirmation");
});

test("email understanding: a genuinely ambiguous email explains the specific ambiguity", llmEvalOptions(EVAL_TAGS), async () => {
  const raw = await understandEmail({
    subject: "Technical Solutions Blockchain",
    bodyExcerpt: "Technical Solutions Blockchain - solicita ya el empleo. No esperes mas, aplica hoy mismo a esta oportunidad.",
    senderDomain: "linkedin.example"
  });
  const validated = validateEmailUnderstanding(raw, "Technical Solutions Blockchain solicita ya el empleo aplica hoy");
  const understanding = validated.understanding ?? raw;

  // This is a PROMPT to apply, not a confirmation that an application was submitted — the model
  // should either classify it as job_alert/noise, or explicitly flag the ambiguity if unsure.
  assert.notEqual(understanding.emailKind, "application_confirmation");
  if (understanding.signalBucket === "needs_decision" || understanding.confidence < 0.4) {
    assert.ok(understanding.ambiguity, "must explain what is unsure rather than staying silent");
  }
});

// --- Gate 9: LLM-backed acceptance replay -----------------------------------------------------

interface SeededGmailMessage {
  id: string;
  subject: string;
  from: string;
  body: string;
}

function installLlmEvalGmailFetchMock(messages: SeededGmailMessage[]): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlText);

    if (method !== "GET" || url.hostname !== "gmail.googleapis.com") {
      return new Response("mutation not allowed in readonly test", { status: 500 });
    }

    const messageId = url.pathname.split("/").pop() ?? "";
    const message = messages.find((candidate) => candidate.id === messageId);
    if (!message) {
      return new Response("not found", { status: 404 });
    }

    return new Response(
      JSON.stringify({
        id: message.id,
        threadId: `thread-${message.id}`,
        snippet: message.body.slice(0, 120),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: message.subject },
            { name: "From", value: message.from },
            { name: "Date", value: new Date().toUTCString() }
          ],
          body: { data: Buffer.from(message.body, "utf8").toString("base64url") }
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  return () => {
    globalThis.fetch = previousFetch;
  };
}

async function withGmailEncryptionKey<T>(fn: () => Promise<T>): Promise<T> {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    return await fn();
  } finally {
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
}

async function seedGmailConnectionWithToken(userId: string) {
  return prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "gmail",
      status: "active",
      config: {
        provider: "gmail",
        scope: "gmail.readonly",
        email: "letis@example.com",
        token: encryptSecretJson({
          accessToken: `llm-eval-access-${randomUUID()}`,
          refreshToken: `llm-eval-refresh-${randomUUID()}`,
          expiresAt: Date.now() + 3_600_000,
          tokenType: "Bearer",
          scope: "gmail.readonly"
        }),
        tokenStorage: "encrypted",
        hasRefreshToken: true
      }
    }
  });
}

const ACCEPTANCE_BATCH: SeededGmailMessage[] = [
  { id: "builtin-digest", subject: "Built In: New job matches for you", from: "jobs@builtin.example", body: "New job matches for you this week: Frontend Developer, Backend Engineer, and more. Unsubscribe anytime." },
  { id: "jiga-1", subject: "Thanks for applying to Jiga", from: "no-reply@jiga.example", body: "Thank you for applying to the Full Stack Product Engineer role at Jiga. We have received your application." },
  { id: "cohere-1", subject: "Thanks for applying to Cohere", from: "no-reply@cohere.example", body: "Thank you for applying to the Software Engineer role at Cohere. Your application has been received." },
  { id: "lightdash-1", subject: "Your application has been received", from: "no-reply@lightdash.example", body: "Your application for the Product Engineer role at Lightdash has been received. We will be in touch." },
  { id: "gomining-workable-1", subject: "Thanks for applying to GoMining", from: "no-reply@workable.example", body: "Thank you for applying to the Backend Engineer role at GoMining via Workable. Your application was received." },
  { id: "gomining-li-1", subject: "GoMining - solicitud enviada", from: "jobs-noreply@linkedin.example", body: "Se ha enviado tu solicitud a GoMining para el puesto de Backend Engineer." },
  { id: "exoticca-workable-1", subject: "Thanks for applying to Exoticca", from: "no-reply@workable.example", body: "Thank you for applying to the Product Manager role at Exoticca via Workable. Your application was received." },
  { id: "exoticca-li-1", subject: "Exoticca - solicitud enviada", from: "jobs-noreply@linkedin.example", body: "Se ha enviado tu solicitud a Exoticca para el puesto de Product Manager." },
  { id: "cander-li-1", subject: "cander - solicitud enviada", from: "jobs-noreply@linkedin.example", body: "Se ha enviado tu solicitud a cander para el puesto de Software Engineer." },
  { id: "conquer-li-1", subject: "Conquer AI - solicitud enviada", from: "jobs-noreply@linkedin.example", body: "Se ha enviado tu solicitud a Conquer AI para el puesto de Software Engineer." },
  { id: "tsb-apply-prompt", subject: "Technical Solutions Blockchain - solicita ya el empleo", from: "jobs-noreply@linkedin.example", body: "Technical Solutions Blockchain busca candidatos. Solicita ya el empleo, no esperes mas." },
  { id: "similar-jobs-alert", subject: "Jobs similar to ones you've applied to", from: "jobs-noreply@linkedin.example", body: "Jobs similar to ones you've applied to: 3 new matches this week. View all on LinkedIn." }
];

test(
  "gate 9: LLM-backed 12-email acceptance replay — real classifications group into a coherent unique-application count",
  { ...llmEvalOptions(["general-email-intelligence", "gmail"]), timeout: 180_000 },
  async () => {
    const server = buildServer();
    const userId = `llm-acceptance-${randomUUID()}`;
    let restoreFetch: (() => void) | undefined;

    try {
      await withGmailEncryptionKey(async () => {
        await seedUser(userId);
        const connection = await seedGmailConnectionWithToken(userId);
        const rule = await prisma.emailSignalRule.create({
          data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search", status: "active", createdBy: "user" }
        });

        for (const message of ACCEPTANCE_BATCH) {
          await prisma.emailReviewItem.create({
            data: {
              userId,
              connectionId: connection.id,
              ruleId: rule.id,
              adapterId: "job_search_email",
              provider: "gmail",
              providerMessageId: message.id,
              externalId: `gmail-review:${rule.id}:${message.id}`,
              subject: message.subject,
              from: message.from,
              snippet: message.body.slice(0, 120),
              evidence: message.body.slice(0, 120),
              confidence: 0.5,
              reason: "unknown",
              extracted: {},
              status: "pending",
              priority: "normal"
            }
          });
        }

        restoreFetch = installLlmEvalGmailFetchMock(ACCEPTANCE_BATCH);

        // Real classification, 8 then the remaining 4 — GMAIL_REVIEW_REFRESH_MAX_ITEMS caps one
        // "refresh email reviews" call at 8 (executor.ts).
        await sendAgentMessage(server, userId, "refresh email reviews");
        await sendAgentMessage(server, userId, "refresh email reviews");

        const listReply = await sendAgentMessage(server, userId, "show email reviews");

        assert.match(listReply.reply, /Gmail found 12 relevant emails\./i);
        assert.doesNotMatch(listReply.reply, /uncertain signal/i);

        // Structural coherence, not a brittle exact-text snapshot: real model output can legitimately
        // vary on the borderline "solicita ya" prompt-to-apply item, but the batch must still reduce
        // to a small, coherent count-ready group — never all 12 raw, never wildly over/under. Per
        // this gate's own literal requirement, a real-world rate-limited/degraded classification
        // pass that fails closed into "needs decision" for the whole batch (never a WRONG count,
        // never silence) is an explicitly acceptable outcome too — "grouped result should still be
        // 7 unique applications, or explicitly explain ambiguity."
        const suggestedMatch = listReply.reply.match(/Count (\d+) (?:unique )?application/i);
        if (suggestedMatch) {
          const suggestedCount = Number(suggestedMatch[1]);
          assert.ok(suggestedCount >= 5 && suggestedCount <= 9, `expected 5-9 unique applications (GoMining and Exoticca each collapse to 1), got ${suggestedCount}. Full reply:\n${listReply.reply}`);

          const countReply = await sendAgentMessage(server, userId, "count all applications");
          assert.match(countReply.reply, /Counted \d+ application/i);

          const events = await prisma.event.count({ where: { userId, type: "career.application_sent", status: "active" } });
          assert.equal(events, suggestedCount, "the actual written event count must match exactly what the grouped summary promised — no silent over/under-count");

          const stillPending = await prisma.emailReviewItem.count({ where: { userId, status: "pending" } });
          assert.ok(stillPending >= 1 && stillPending <= 5, `noise items (Built In digest, similar-jobs alert, and possibly the ambiguous 'solicita ya' prompt) should remain pending, got ${stillPending}`);
        } else {
          assert.match(listReply.reply, /Needs decision:/i, `expected either a count-ready suggestion or an explicit "Needs decision" explanation, got:\n${listReply.reply}`);
          assert.doesNotMatch(listReply.reply, /uncertain signal/i);
          const events = await prisma.event.count({ where: { userId, type: "career.application_sent", status: "active" } });
          assert.equal(events, 0, "a needs-decision batch must never silently count anything");
        }
      });
    } finally {
      restoreFetch?.();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);
