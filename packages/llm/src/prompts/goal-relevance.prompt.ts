import { z } from "zod";
import { createOpenAIClient } from "../openai-client.js";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 1): the versioned Stage C
 * prompt module — goal/action relevance. Answers, given an already-understood email (Stage B's
 * output) and the user's own active goals/open actions, "does this matter to one of your goals or
 * actions, and if so which one and why" — a genuinely separate question from Stage B's own
 * `goalRelevance` field (which only ever compares against the SINGLE rule-linked goal, if any).
 *
 * This module PROPOSES only — deterministic code (Stage D/callers) decides whether and how to act
 * on the proposal, and nothing here ever writes any DB state, matching this task's own core
 * principle: "The LLM should understand and reason. Deterministic code should validate, group,
 * dedupe, write, verify, and protect state."
 */

export const GOAL_RELEVANCE_PROMPT_VERSION = "goal-relevance@1";

export const GOAL_RELEVANCE_VERDICTS = ["direct", "indirect", "unrelated", "unclear"] as const;
export type GoalRelevanceVerdict = (typeof GOAL_RELEVANCE_VERDICTS)[number];

const GoalRelevanceResponseSchema = z.object({
  /** The id of the best-matching goal, or null when none of the candidates are a real match. */
  bestGoalId: z.string().nullable(),
  verdict: z.enum(GOAL_RELEVANCE_VERDICTS),
  /** One short, specific sentence — never a bare "unclear." */
  reason: z.string().min(1).max(220),
  /** Whether the user should be asked to confirm this link before anything is attached to it —
   * true whenever verdict is "indirect" or "unclear", or the model itself is not confident. */
  requiresConfirmation: z.boolean()
});

export type GoalRelevanceResponse = z.infer<typeof GoalRelevanceResponseSchema>;

export interface GoalRelevanceCandidateGoal {
  id: string;
  title: string;
  category?: string;
  description?: string;
}

export interface GoalRelevanceInput {
  realWorldEvent: string;
  summary: string;
  emailKind: string;
  candidateGoals: GoalRelevanceCandidateGoal[];
  /** Titles of the user's currently open actions — extra context for judging relevance without a
   * second full action list round-trip. */
  openActionTitles?: string[];
}

export function buildGoalRelevancePrompt(): string {
  return [
    `Prompt version: ${GOAL_RELEVANCE_PROMPT_VERSION}.`,
    "You decide whether an already-understood email matters to ANY of the user's current goals or open actions — never job-search-only, this applies to any goal domain (fitness, finance, travel, career, ...).",
    "Return JSON only matching the schema.",
    "bestGoalId: the id of the SINGLE best-matching goal from the candidates given, or null if none genuinely relate.",
    "verdict: 'direct' when the email is clearly evidence for or against that goal's own tracked activity; 'indirect' when related but not a direct match (e.g. networking email for a job-search goal, not an application itself); 'unrelated' when the email is about something else entirely; 'unclear' when you cannot confidently tell.",
    "reason: one short, SPECIFIC sentence explaining the verdict — never a bare 'unclear' or 'not sure.' Name what you do and don't know.",
    "requiresConfirmation: true whenever verdict is 'indirect' or 'unclear', or you are not confident even for a 'direct' verdict — false only when the match is obvious and safe to act on without asking.",
    "Never invent a goal that is not in the candidate list. Never guess a goal from vague thematic similarity alone — a fitness-goal email should never match a career goal just because both are 'self-improvement.'"
  ].join("\n");
}

function buildGoalRelevanceJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["bestGoalId", "verdict", "reason", "requiresConfirmation"],
    properties: {
      bestGoalId: { anyOf: [{ type: "string" }, { type: "null" }] },
      verdict: { type: "string", enum: [...GOAL_RELEVANCE_VERDICTS] },
      reason: { type: "string", maxLength: 220 },
      requiresConfirmation: { type: "boolean" }
    }
  };
}

export interface AssessGoalRelevanceOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Real, standalone LLM call — kept separate from understandEmail's own single round-trip so it can
 * be invoked only when genuinely needed (multiple candidate goals, or the main understanding call's
 * own goalRelevance came back unclear), rather than doubling the cost/latency of every single email
 * understanding call. Falls back to a safe "unclear, needs confirmation" result on any failure
 * (network, parse, missing key) — never throws into the caller, matching this codebase's established
 * graceful-degradation convention for every other LLM call site.
 */
export async function assessGoalRelevance(input: GoalRelevanceInput, options: AssessGoalRelevanceOptions = {}): Promise<GoalRelevanceResponse> {
  const mockResponse = process.env.GOAL_RELEVANCE_MOCK_RESPONSE;
  if (mockResponse) {
    return GoalRelevanceResponseSchema.parse(JSON.parse(mockResponse));
  }
  if (process.env.GOAL_RELEVANCE_MOCK_THROW === "true") {
    throw new Error("Mock goal relevance failure.");
  }

  if (input.candidateGoals.length === 0) {
    return { bestGoalId: null, verdict: "unclear", reason: "No active goals to compare against.", requiresConfirmation: true };
  }

  const client = createOpenAIClient({ apiKey: options.apiKey });
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  const response = await client.responses.create({
    model,
    store: false,
    input: [
      { role: "developer", content: [{ type: "input_text", text: buildGoalRelevancePrompt() }] },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              realWorldEvent: input.realWorldEvent.slice(0, 200),
              summary: input.summary.slice(0, 400),
              emailKind: input.emailKind,
              candidateGoals: input.candidateGoals.map((goal) => ({
                id: goal.id,
                title: goal.title.slice(0, 160),
                category: goal.category ?? null,
                description: goal.description?.slice(0, 300) ?? null
              })),
              openActionTitles: (input.openActionTitles ?? []).slice(0, 20).map((title) => title.slice(0, 160))
            })
          }
        ]
      }
    ],
    text: { format: { type: "json_schema", name: "goal_relevance", strict: true, schema: buildGoalRelevanceJsonSchema() } }
  });

  const parsed = GoalRelevanceResponseSchema.safeParse(JSON.parse(response.output_text));
  if (!parsed.success) {
    return { bestGoalId: null, verdict: "unclear", reason: "The relevance result used an unsupported shape.", requiresConfirmation: true };
  }

  // Validator boundary: an invented goal id (not among the candidates given) is never trusted.
  const validGoalIds = new Set(input.candidateGoals.map((goal) => goal.id));
  if (parsed.data.bestGoalId && !validGoalIds.has(parsed.data.bestGoalId)) {
    return { bestGoalId: null, verdict: "unclear", reason: "The relevance result named a goal that wasn't offered as a candidate.", requiresConfirmation: true };
  }

  return parsed.data;
}
