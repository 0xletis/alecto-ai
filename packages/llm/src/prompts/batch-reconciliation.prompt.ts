import { z } from "zod";
import { createOpenAIClient } from "../openai-client.js";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 1): the versioned Stage D
 * prompt module — batch reconciliation. This task's own core principle says deterministic code
 * groups/dedupes; this module does NOT override that — packages/core/src/email-intelligence-
 * grouping.ts's exact entity+secondary+day dedupe key remains the AUTHORITATIVE grouping decision.
 * What this module adds is narrower and strictly advisory: for a pair of items the deterministic
 * key did NOT merge (different day, or a slightly different company spelling) but that share
 * enough surface signal to be worth asking about, it answers one focused question — "are these two
 * emails evidence of the SAME real-world event, or different ones?" — and the caller (Stage D)
 * only ever merges a pair when this says so AND the pair already passed a cheap deterministic
 * pre-filter (same bucket, same normalized entity substring or a small day gap). The LLM never
 * invents a merge for a pair it wasn't asked about.
 */

export const BATCH_RECONCILIATION_PROMPT_VERSION = "batch-reconciliation@1";

export const RECONCILIATION_VERDICTS = ["same_event", "different_events", "unclear"] as const;
export type ReconciliationVerdict = (typeof RECONCILIATION_VERDICTS)[number];

export interface ReconciliationCandidateItem {
  /** Caller's own id for this item (e.g. an EmailReviewItem id) — echoed back, never re-derived. */
  id: string;
  title: string;
  entity?: string;
  secondary?: string;
  occurredAt: string;
  evidenceSnippet?: string;
}

export interface ReconciliationCandidatePair {
  /** Caller's own id for this candidate pair — echoed back so results can be matched to requests
   * without relying on array order. */
  pairId: string;
  a: ReconciliationCandidateItem;
  b: ReconciliationCandidateItem;
}

const ReconciliationResultSchema = z.object({
  pairId: z.string(),
  verdict: z.enum(RECONCILIATION_VERDICTS),
  reason: z.string().min(1).max(200)
});

const ReconciliationResponseSchema = z.object({
  results: z.array(ReconciliationResultSchema).max(50)
});

export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;

export function buildBatchReconciliationPrompt(): string {
  return [
    `Prompt version: ${BATCH_RECONCILIATION_PROMPT_VERSION}.`,
    "For EACH candidate pair of items given, decide whether they are evidence of the SAME real-world event (e.g. two confirmation emails for one job application, sent through two different platforms a day apart) or two DIFFERENT events that happen to share a similar name.",
    "Return JSON only matching the schema — one result per pairId given, in any order.",
    "'same_event': the entity (company/vendor) and secondary (role/amount/item) are the same real thing, even if worded slightly differently, and the dates are close enough to be the same real submission/booking/purchase.",
    "'different_events': the entity or secondary clearly differ (a different role at the same company, a different company with a similar name), or the dates are too far apart to plausibly be one event.",
    "'unclear': you cannot confidently tell from the given titles/snippets alone.",
    "reason: one short, specific sentence.",
    "Never merge two items just because they are close in time — the entity and secondary must genuinely match. A 'GoMining — Backend Engineer' and a 'GoMining — Frontend Engineer' are DIFFERENT events even on the same day."
  ].join("\n");
}

function buildBatchReconciliationJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["pairId", "verdict", "reason"],
          properties: {
            pairId: { type: "string" },
            verdict: { type: "string", enum: [...RECONCILIATION_VERDICTS] },
            reason: { type: "string", maxLength: 200 }
          }
        }
      }
    }
  };
}

export interface ReconcileEmailBatchOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Real, standalone LLM call for the near-duplicate candidates Stage D's own exact dedupe key left
 * unmerged. Never called for the common case (nothing to disambiguate) — only when the caller has
 * already found candidate pairs worth asking about. Falls back to "unclear" for every pair on any
 * failure, which the caller treats as "do not merge" (fails closed — a missed compression is safe,
 * a wrong merge is not).
 */
export async function reconcileEmailBatch(pairs: ReconciliationCandidatePair[], options: ReconcileEmailBatchOptions = {}): Promise<ReconciliationResult[]> {
  if (pairs.length === 0) {
    return [];
  }

  const fallback = pairs.map((pair) => ({ pairId: pair.pairId, verdict: "unclear" as const, reason: "Reconciliation was not available." }));

  const mockResponse = process.env.BATCH_RECONCILIATION_MOCK_RESPONSE;
  if (mockResponse) {
    const parsed = ReconciliationResponseSchema.safeParse(JSON.parse(mockResponse));
    if (!parsed.success) {
      return fallback;
    }
    // Test ergonomics: a mock fixture cannot know the real (dynamically generated) pairId ahead of
    // time, so a mock result's OWN pairId is never trusted here — each is matched to the actual
    // requested pairs by position instead, always echoing the REAL pairId back. The real (non-mock)
    // API path below is unaffected and still validates every pairId for real.
    return pairs.map((pair, index) => {
      const mockResult = parsed.data.results[index] ?? parsed.data.results[0];
      return mockResult ? { pairId: pair.pairId, verdict: mockResult.verdict, reason: mockResult.reason } : { pairId: pair.pairId, verdict: "unclear" as const, reason: "No mock result provided." };
    });
  }
  if (process.env.BATCH_RECONCILIATION_MOCK_THROW === "true") {
    return fallback;
  }

  try {
    const client = createOpenAIClient({ apiKey: options.apiKey });
    const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

    const response = await client.responses.create({
      model,
      store: false,
      input: [
        { role: "developer", content: [{ type: "input_text", text: buildBatchReconciliationPrompt() }] },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(
                pairs.slice(0, 50).map((pair) => ({
                  pairId: pair.pairId,
                  a: { title: pair.a.title.slice(0, 160), entity: pair.a.entity ?? null, secondary: pair.a.secondary ?? null, occurredAt: pair.a.occurredAt, evidenceSnippet: pair.a.evidenceSnippet?.slice(0, 200) ?? null },
                  b: { title: pair.b.title.slice(0, 160), entity: pair.b.entity ?? null, secondary: pair.b.secondary ?? null, occurredAt: pair.b.occurredAt, evidenceSnippet: pair.b.evidenceSnippet?.slice(0, 200) ?? null }
                }))
              )
            }
          ]
        }
      ],
      text: { format: { type: "json_schema", name: "batch_reconciliation", strict: true, schema: buildBatchReconciliationJsonSchema() } }
    });

    const parsed = ReconciliationResponseSchema.safeParse(JSON.parse(response.output_text));
    if (!parsed.success) {
      return fallback;
    }

    // Validator boundary: only ever return a verdict for a pairId that was actually asked about —
    // an invented pairId is dropped, and any pair the model silently skipped falls back to unclear.
    const requestedIds = new Set(pairs.map((pair) => pair.pairId));
    const byId = new Map(parsed.data.results.filter((result) => requestedIds.has(result.pairId)).map((result) => [result.pairId, result] as const));
    return pairs.map((pair) => byId.get(pair.pairId) ?? { pairId: pair.pairId, verdict: "unclear" as const, reason: "No result returned for this pair." });
  } catch {
    return fallback;
  }
}
