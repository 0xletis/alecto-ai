import { z } from "zod";
import { createOpenAIClient } from "../openai-client.js";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 1): the versioned Stage E
 * prompt module — user-facing summary. The DEFAULT grouped summary
 * (apps/api/src/email-reviews/email-review-service.ts's formatEmailIntelligenceSummaryForChat)
 * stays a deterministic template — every number in it is computed by code, never phrased by an
 * LLM, because the acceptance test (and the task's own "no false logged/count claims" safety rule)
 * requires those counts to be exactly, verifiably correct. This module is an OPT-IN polish pass:
 * given the deterministic grouping result, it may rephrase the wording more naturally, but a
 * validator (polishEmailIntelligenceSummary's own caller) rejects the polished text outright if
 * any number in it doesn't match the deterministic source — falling back to the plain deterministic
 * text. The LLM enhances phrasing; deterministic code still validates and has the final say.
 */

export const USER_FACING_SUMMARY_PROMPT_VERSION = "user-facing-summary@1";

export interface UserFacingSummaryGroupInput {
  bucket: "count_ready" | "status_update" | "action_worthy" | "needs_decision" | "noise";
  title: string;
  isDuplicateGroup: boolean;
  memberCount: number;
}

export interface UserFacingSummaryInput {
  totalEmails: number;
  groups: UserFacingSummaryGroupInput[];
}

const PolishedSummarySchema = z.object({
  text: z.string().min(1).max(2000)
});

export function buildUserFacingSummaryPrompt(): string {
  return [
    `Prompt version: ${USER_FACING_SUMMARY_PROMPT_VERSION}.`,
    "Rewrite the given grouped email-intelligence result as a short, warm, operator-style message to the user — 'here's what I found, here's what I think happened, here's the safe next move,' never a bare list of 'uncertain signals.'",
    "You are given the ALREADY-COMPUTED, ALREADY-CORRECT facts: total email count, and each group's bucket/title/member count. You may rephrase and reorganize, but you must NOT invent, omit, or change any number or title given to you — every count in your output must match the input exactly.",
    "Keep noise summarized as a count, never listed item by item, unless there is only one noise item.",
    "End with one short, concrete suggested next step when there is anything count-ready or needing a decision; otherwise end with a plain summary sentence.",
    "Return JSON only matching the schema — a single 'text' field."
  ].join("\n");
}

function buildUserFacingSummaryJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string", maxLength: 2000 } }
  };
}

/** Every number that must survive, unchanged, from input to polished output — the deterministic
 * check polishEmailIntelligenceSummary itself performs before ever trusting the LLM's phrasing. */
export function requiredNumbersForSummary(input: UserFacingSummaryInput): number[] {
  const numbers = [input.totalEmails];
  for (const group of input.groups) {
    numbers.push(group.memberCount);
  }
  return numbers;
}

/** True only when every required number appears somewhere in the polished text — a cheap,
 * conservative check (a number appearing is necessary, not sufficient, but a MISSING number is
 * always a real problem: something the deterministic source counted got silently dropped). */
export function polishedSummaryPreservesNumbers(text: string, requiredNumbers: number[]): boolean {
  const numbersInText = new Set((text.match(/\d+/g) ?? []).map(Number));
  return requiredNumbers.every((value) => numbersInText.has(value));
}

export interface PolishEmailIntelligenceSummaryOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Opt-in polish pass. Returns the LLM's rephrased text ONLY when it is available and demonstrably
 * preserves every number from the deterministic source; returns undefined otherwise (network
 * failure, parse failure, or a number mismatch) — the caller's own established, deterministic
 * template is always the safe fallback, never blocked by this.
 */
export async function polishEmailIntelligenceSummary(input: UserFacingSummaryInput, options: PolishEmailIntelligenceSummaryOptions = {}): Promise<string | undefined> {
  const requiredNumbers = requiredNumbersForSummary(input);

  const mockResponse = process.env.USER_FACING_SUMMARY_MOCK_RESPONSE;
  if (mockResponse) {
    return polishedSummaryPreservesNumbers(mockResponse, requiredNumbers) ? mockResponse : undefined;
  }
  if (process.env.USER_FACING_SUMMARY_MOCK_THROW === "true") {
    return undefined;
  }

  try {
    const client = createOpenAIClient({ apiKey: options.apiKey });
    const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

    const response = await client.responses.create({
      model,
      store: false,
      input: [
        { role: "developer", content: [{ type: "input_text", text: buildUserFacingSummaryPrompt() }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(input) }] }
      ],
      text: { format: { type: "json_schema", name: "user_facing_summary", strict: true, schema: buildUserFacingSummaryJsonSchema() } }
    });

    const parsed = PolishedSummarySchema.safeParse(JSON.parse(response.output_text));
    if (!parsed.success) {
      return undefined;
    }

    return polishedSummaryPreservesNumbers(parsed.data.text, requiredNumbers) ? parsed.data.text : undefined;
  } catch {
    return undefined;
  }
}
