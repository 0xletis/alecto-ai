import { createOpenAIClient } from "@operator-agent/llm";
import type { EmailReviewItem, EmailSignalRule } from "@operator-agent/db";
import type { Goal } from "@operator-agent/core";
import { extractSafeSenderLabel, humanEmailReviewEventLabel } from "../email-reviews/email-review-service.js";
import { truncatePlainText } from "../utils/text.js";
import { withPlannerTimeout } from "./planner.js";

/**
 * fix/private-alpha-gmail-review-llm-instruction-routing (Task 2): a real reported bug — "1 and 2
 * are CVs I sent today, 3 and 4 are nothing u can delete them" got ALL FOUR visible reviews
 * rejected by the old purely-regex extractor (runtime.ts's extractExplicitGmailReviewIntentEntries),
 * which has no way to represent "approve" at all and had no way to know a trailing plural "delete
 * them" was only ever meant to cover 3 and 4. This module is the deterministic-validator-gated LLM
 * parser for exactly this class of free-form, mixed review instruction — never trusted to mutate
 * the DB directly (see validateGmailReviewInstructionOperations below): it only ever proposes a
 * structured list of {reviewNumber, action} pairs, which the caller then maps onto the SAME
 * existing gmail.review.approve/reject/to_action/keep tool calls every other review-triage path
 * already uses, unchanged. Never sees a raw email body — only the same safe, already-derived
 * subject/sender/signal-label/goal summary a human would see in "show me the reviews".
 */

export type GmailReviewInstructionAction = "approve" | "reject" | "to_action" | "keep";

const ALLOWED_ACTIONS: readonly GmailReviewInstructionAction[] = ["approve", "reject", "to_action", "keep"];

export interface GmailReviewInstructionSummary {
  number: number;
  subject: string;
  sender: string;
  signalLabel: string;
  linkedGoal?: string;
}

export interface GmailReviewInstructionOperation {
  reviewNumber: number;
  action: GmailReviewInstructionAction;
  /** Advisory only, never written to the DB directly — see the executor's own gmail.review.approve
   * case, which always follows the review's OWN stored classification. Only used, post-validation,
   * to decide whether to ALSO log a manual applications-sent count (Task 3). */
  signalType: string | null;
  alsoLogApplicationsSent: number | null;
  reason: string;
}

export interface GmailReviewInstructionParseResult {
  operations: GmailReviewInstructionOperation[];
  needsClarification: boolean;
  clarificationQuestion: string | null;
}

/** Safe, human-shaped summary of a visible review — no raw email body, only what "show me the
 * reviews" already displays. Mirrors gmailReviewChatLabel/humanEmailReviewEventLabel's own
 * derivations rather than redefining them, so a review reads identically here and in the review
 * list itself. */
export function buildVisibleReviewSummaries(reviews: EmailReviewItem[], rules: EmailSignalRule[], goals: Goal[]): GmailReviewInstructionSummary[] {
  return reviews.map((review, index) => {
    const rule = rules.find((item) => item.id === review.ruleId);
    const linkedGoal = rule?.goalId ? goals.find((goal) => goal.id === rule.goalId && goal.status === "active") : undefined;
    return {
      number: index + 1,
      subject: review.subject ? truncatePlainText(review.subject, 100) : "(no subject)",
      sender: review.from ? extractSafeSenderLabel(review.from) : "(unknown sender)",
      signalLabel: review.proposedEventType ? humanEmailReviewEventLabel(review.proposedEventType) : "uncertain signal",
      linkedGoal: linkedGoal?.title
    };
  });
}

function buildInstructionSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["operations", "needsClarification", "clarificationQuestion"],
    properties: {
      operations: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["reviewNumber", "action", "signalType", "alsoLogApplicationsSent", "reason"],
          properties: {
            reviewNumber: { type: "integer", minimum: 1 },
            action: { type: "string", enum: [...ALLOWED_ACTIONS] },
            signalType: { type: ["string", "null"], maxLength: 60 },
            alsoLogApplicationsSent: { type: ["integer", "null"], minimum: 0, maximum: 50 },
            reason: { type: "string", maxLength: 200 }
          }
        }
      },
      needsClarification: { type: "boolean" },
      clarificationQuestion: { type: ["string", "null"], maxLength: 300 }
    }
  };
}

function buildInstructionSystemPrompt(): string {
  return [
    "You parse a user's free-form reply about their PENDING Gmail review queue into structured operations. You never write to any database — a deterministic validator checks every field you return before anything happens.",
    'Allowed actions per review, EXACTLY one per review number the user actually referred to: "approve" (log it as real evidence / confirm it is what the review says), "reject" (ignore/dismiss it — this NEVER deletes the real email, only decides Alecto\'s own internal review item), "to_action" (turn it into a task/reminder), "keep" (leave it pending, decide later).',
    'CRITICAL: "delete"/"remove"/"discard"/"get rid of" a review always means "reject" — Alecto can never delete a real email, so these words only ever describe rejecting the internal review item.',
    "Only include an operation for a review number the user's message actually refers to — a review they never mentioned gets NO operation at all (it stays pending, untouched).",
    'If the user states or clearly implies WHAT a review actually is ("1 and 2 are CVs I sent today", "3 is a recruiter reply"), and that matches or plausibly relates to the review\'s own listed signal, treat it as "approve" and set signalType to your best short label for what they said (e.g. "application_confirmation"). If they dismiss it ("nothing", "junk", "not relevant", "spam", "delete it"), that is "reject", with no signalType.',
    'If the user says how many things they sent/applied for TODAY as direct evidence of real progress (e.g. "these are the 2 CVs I sent today"), and you are approving reviews that correspond to that, set alsoLogApplicationsSent to that count on ONE of the approved operations (never split across several) — otherwise leave it null. Only ever a count the user actually stated or that exactly matches the number of reviews they said were applications, never a guess.',
    "If the message is genuinely ambiguous (unclear which reviews it refers to, unclear what to do with one, or contradicts itself), set needsClarification true and clarificationQuestion to a short, specific question — do NOT guess an operation for the ambiguous part. It is always safer to ask than to guess wrong on a real review decision.",
    "Never invent a review number outside the ones listed below. Never reference or repeat any raw email body text — you were only given a subject/sender/signal summary, nothing else exists.",
    "reason is a short (under 20 words) internal note for why you chose this action — grounded only in what the user actually said."
  ].join("\n");
}

function buildInstructionUserPayload(message: string, visibleReviews: GmailReviewInstructionSummary[]): string {
  const reviewLines = visibleReviews
    .map((review) => `${review.number}. subject: "${review.subject}" | sender: ${review.sender} | signal: ${review.signalLabel}${review.linkedGoal ? ` | goal: ${review.linkedGoal}` : ""}`)
    .join("\n");
  return [`User message: ${JSON.stringify(message)}`, "", "Visible pending reviews:", reviewLines].join("\n");
}

function normalizeParseResult(raw: unknown): GmailReviewInstructionParseResult {
  const parsed = raw as Partial<GmailReviewInstructionParseResult> | undefined;
  const operations = Array.isArray(parsed?.operations) ? parsed!.operations : [];
  return {
    operations: operations
      .filter((op): op is GmailReviewInstructionOperation => Boolean(op) && typeof op === "object")
      .map((op) => ({
        reviewNumber: Number(op.reviewNumber),
        action: op.action,
        signalType: typeof op.signalType === "string" && op.signalType.trim() ? op.signalType.trim() : null,
        alsoLogApplicationsSent: typeof op.alsoLogApplicationsSent === "number" && Number.isFinite(op.alsoLogApplicationsSent) ? op.alsoLogApplicationsSent : null,
        reason: typeof op.reason === "string" && op.reason.trim() ? op.reason.trim() : "no reason given"
      })),
    needsClarification: Boolean(parsed?.needsClarification),
    clarificationQuestion: typeof parsed?.clarificationQuestion === "string" ? parsed.clarificationQuestion : null
  };
}

/**
 * The only network/LLM call in this module — everything downstream (validateGmailReviewInstruction
 * Operations) is pure and deterministic. Mirrors planner.ts's planWithLLM mock/timeout/error-
 * handling shape (same env-var-driven test mock pattern:
 * GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE / _MOCK_THROW) so this never needs a real
 * OPENAI_API_KEY in the deterministic test suite, and throws (rather than returning a fake empty
 * result) on any failure — the caller's job is to catch that and ask for clarification instead of
 * guessing, never to over-reject.
 */
export async function parseGmailReviewInstructionWithLLM(message: string, visibleReviews: GmailReviewInstructionSummary[]): Promise<GmailReviewInstructionParseResult> {
  const mockThrow = process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_THROW === "true";
  if (mockThrow) {
    throw new Error("Mock Gmail review instruction parser failure.");
  }

  const mockResponse = process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE;
  if (mockResponse) {
    return normalizeParseResult(JSON.parse(mockResponse));
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const client = createOpenAIClient();
  const model = process.env.AGENT_RUNTIME_PLANNER_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  const response = await withPlannerTimeout(
    client.responses.create({
      model,
      store: false,
      input: [
        { role: "developer", content: [{ type: "input_text", text: buildInstructionSystemPrompt() }] },
        { role: "user", content: [{ type: "input_text", text: buildInstructionUserPayload(message, visibleReviews) }] }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "gmail_review_instruction_parse",
          strict: true,
          schema: buildInstructionSchema()
        }
      }
    })
  );

  return normalizeParseResult(JSON.parse(response.output_text));
}

export interface ValidatedGmailReviewOperation {
  reviewNumber: number;
  action: GmailReviewInstructionAction;
  alsoLogApplicationsSent?: number;
  reason: string;
}

export interface GmailReviewInstructionValidation {
  operations: ValidatedGmailReviewOperation[];
  needsClarification: boolean;
  clarificationQuestion: string;
}

const DEFAULT_CLARIFICATION = "I can approve, ignore, turn into a task, or keep each review pending — which should I do with each one?";

/**
 * The real DB-mutation safety boundary — the LLM's output is NEVER trusted directly (per the
 * task's own explicit rule). Every review number must exist in the CURRENT visible set, every
 * action must be one of the four real tools, at most one alsoLogApplicationsSent count survives
 * (never double-counted across several operations), and anything that fails any of this — or that
 * the parser itself flagged as ambiguous — becomes a clarification question instead of a guess.
 */
export function validateGmailReviewInstructionOperations(
  parsed: GmailReviewInstructionParseResult,
  visibleReviews: GmailReviewInstructionSummary[]
): GmailReviewInstructionValidation {
  if (parsed.needsClarification) {
    return { operations: [], needsClarification: true, clarificationQuestion: parsed.clarificationQuestion?.trim() || DEFAULT_CLARIFICATION };
  }

  const validNumbers = new Set(visibleReviews.map((review) => review.number));
  const seen = new Set<number>();
  const operations: ValidatedGmailReviewOperation[] = [];
  let applicationsSentAlreadyAssigned = false;

  for (const op of parsed.operations) {
    if (!Number.isInteger(op.reviewNumber) || !validNumbers.has(op.reviewNumber)) {
      return {
        operations: [],
        needsClarification: true,
        clarificationQuestion: `I don't see review ${Number.isFinite(op.reviewNumber) ? op.reviewNumber : "?"} in the current list — could you point to a number from what I just showed?`
      };
    }
    if (!ALLOWED_ACTIONS.includes(op.action)) {
      return { operations: [], needsClarification: true, clarificationQuestion: DEFAULT_CLARIFICATION };
    }
    if (seen.has(op.reviewNumber)) {
      continue;
    }
    seen.add(op.reviewNumber);

    const wantsApplicationsSentLog = op.action === "approve" && !applicationsSentAlreadyAssigned && typeof op.alsoLogApplicationsSent === "number" && op.alsoLogApplicationsSent > 0;
    if (wantsApplicationsSentLog) {
      applicationsSentAlreadyAssigned = true;
    }

    operations.push({
      reviewNumber: op.reviewNumber,
      action: op.action,
      alsoLogApplicationsSent: wantsApplicationsSentLog ? Math.min(op.alsoLogApplicationsSent!, visibleReviews.length) : undefined,
      reason: op.reason
    });
  }

  if (operations.length === 0) {
    return { operations: [], needsClarification: true, clarificationQuestion: DEFAULT_CLARIFICATION };
  }

  return { operations, needsClarification: false, clarificationQuestion: "" };
}

function joinNaturally(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Task 6 — a real, specific summary paragraph rather than a bare concatenation of each tool's own
 * one-line receipt. Deterministic, not a second LLM call in the same turn (composeReply's normal
 * path already avoids that for cost/latency/flakiness reasons) — grounded ONLY in the validated
 * operations and the review summaries already shown to the user, never inventing a fact beyond
 * what was actually decided. Applications-sent logging (if any) is mentioned separately since it's
 * a distinct real DB write the user should be able to see happened.
 */
export function composeGmailReviewInstructionReply(operations: ValidatedGmailReviewOperation[], visibleReviews: GmailReviewInstructionSummary[]): string {
  const byNumber = new Map(visibleReviews.map((review) => [review.number, review]));
  const approved = operations.filter((op) => op.action === "approve");
  const rejected = operations.filter((op) => op.action === "reject");
  const tasked = operations.filter((op) => op.action === "to_action");
  const kept = operations.filter((op) => op.action === "keep");
  const applicationsSentLogged = operations.find((op) => typeof op.alsoLogApplicationsSent === "number")?.alsoLogApplicationsSent;

  const sentences: string[] = ["Got it."];

  if (approved.length > 0) {
    const numbers = joinNaturally(approved.map((op) => String(op.reviewNumber)));
    const labels = [...new Set(approved.map((op) => byNumber.get(op.reviewNumber)?.signalLabel ?? "reviewed"))].join(" / ");
    sentences.push(`Approved ${numbers} as ${labels}.`);
  }
  if (rejected.length > 0) {
    const numbers = joinNaturally(rejected.map((op) => String(op.reviewNumber)));
    sentences.push(`Ignored ${numbers} — nothing was changed in your actual mailbox, only Alecto's own review queue.`);
  }
  if (tasked.length > 0) {
    sentences.push(`Turned ${joinNaturally(tasked.map((op) => String(op.reviewNumber)))} into a task.`);
  }
  if (kept.length > 0) {
    sentences.push(`Kept ${joinNaturally(kept.map((op) => String(op.reviewNumber)))} pending for later.`);
  }
  if (typeof applicationsSentLogged === "number") {
    sentences.push(`Also logged ${applicationsSentLogged} application${applicationsSentLogged === 1 ? "" : "s"} sent today toward your job-search goal.`);
  }

  return sentences.join(" ");
}
