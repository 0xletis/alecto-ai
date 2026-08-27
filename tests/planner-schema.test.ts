import assert from "node:assert/strict";
import test from "node:test";
import { buildOperationVariantSchema } from "../apps/api/src/agent-runtime/planner.ts";
import { getToolDefinition, toolArgsPlannerJsonSchema, toolCatalog } from "../apps/api/src/agent-runtime/tool-catalog.ts";

/**
 * Planner structured-output schema regression suite (follow-up to fix/private-alpha-known-gaps).
 *
 * Root cause this locks in a fix for: the OLD `buildPlanJsonSchema` shape had `tool` (a bare
 * `enum` of every tool name) and `args` (a SEPARATE `anyOf` over every tool's own args schema) as
 * two independent SIBLING properties on the same operation object. OpenAI's structured-output
 * constrained decoding satisfies each property against its own schema independently — nothing in
 * that shape ties WHICH `args` anyOf branch was used to the actual string value generated for
 * `tool`. Confirmed via a real, live OpenAI call (not just theory): "turn on evening check-ins"
 * reproducibly (100% of attempts) produced `{tool: "proactive.settings_propose_update", args:
 * {signalKey, eventType, goalRef, count, notes}}` — goal.log_evidence's own args shape, paired
 * with a completely different tool's name.
 *
 * The fix: each anyOf branch is now a FULL `{tool: {enum: [name]}, args: <that tool's own
 * schema>, rationale}` object (buildOperationVariantSchema) — tool name and args shape are fixed
 * together inside the same branch, so a valid response for "this branch" can only ever pair one
 * tool name with that exact tool's own args. This is a schema-generation-only change: the JSON
 * *shape* emitted for a valid response ({tool, args, rationale}) is unchanged, so
 * normalizePlan/validateOperations/executeOperation need no changes and are not touched here.
 *
 * These tests validate the GENERATED SCHEMA's own structure directly — no live LLM call, no
 * mocked planner response — using a small, purpose-built JSON-Schema-subset matcher (below) that
 * understands exactly the subset toolArgsPlannerJsonSchema/buildOperationVariantSchema produce
 * (object/array/string/number/boolean/null, enum, additionalProperties:false, required, anyOf,
 * items/properties). Deliberately not a general-purpose JSON Schema validator, and deliberately
 * not a new runtime dependency — this is test-only code proving a structural property of the
 * schema, the same way a snapshot test would, just resilient to reordering.
 */

// --- minimal JSON-Schema-subset matcher, test-only --------------------------------------------

type JsonSchemaNode = Record<string, unknown>;

function matchesSchema(value: unknown, schema: JsonSchemaNode): boolean {
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as JsonSchemaNode[]).some((branch) => matchesSchema(value, branch));
  }
  if (Array.isArray(schema.enum)) {
    return (schema.enum as unknown[]).includes(value as never);
  }

  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const actualType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(actualType)) {
    return false;
  }

  if (actualType === "object") {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties as Record<string, JsonSchemaNode> | undefined) ?? {};
    const required = (schema.required as string[] | undefined) ?? [];

    for (const key of required) {
      if (!(key in obj)) {
        return false;
      }
    }
    for (const key of Object.keys(obj)) {
      if (schema.additionalProperties === false && !(key in properties)) {
        return false;
      }
      if (properties[key] && !matchesSchema(obj[key], properties[key])) {
        return false;
      }
    }
    return true;
  }

  if (actualType === "array") {
    const items = schema.items as JsonSchemaNode | undefined;
    return items ? (value as unknown[]).every((item) => matchesSchema(item, items)) : true;
  }

  return true;
}

/** The exact shape a valid Structured Outputs response would carry — nullable strict-mode fields
 * included explicitly as `null` (never simply omitted), matching what the real API actually emits
 * (confirmed via a live call during this fix's own development). */
function operation(tool: string, args: Record<string, unknown>): { tool: string; args: Record<string, unknown>; rationale: string | null } {
  return { tool, args, rationale: null };
}

const operationSchemas = toolCatalog.map((tool) => buildOperationVariantSchema(tool));

function matchesAnyTool(candidate: unknown): boolean {
  return operationSchemas.some((schema) => matchesSchema(candidate, schema));
}

// --- A: schema binds tool to args ---------------------------------------------------------------

test("A. the proactive.settings_propose_update branch rejects goal.log_evidence's own args shape", () => {
  const settingsTool = getToolDefinition("proactive.settings_propose_update")!;
  const settingsBranch = buildOperationVariantSchema(settingsTool);

  // The exact shape a real (buggy, pre-fix) API response reproduced 100% of the time for "turn on
  // evening check-ins" — this must never satisfy the settings tool's OWN branch schema.
  const badPairing = operation("proactive.settings_propose_update", {
    eventType: "learning.reading_session_completed",
    signalKey: "reading_minutes",
    goalRef: "Read more books",
    count: 20,
    notes: "Only did 20 minutes today."
  });

  assert.equal(matchesSchema(badPairing, settingsBranch), false, "goal.log_evidence's args must never satisfy proactive.settings_propose_update's own branch");
  assert.equal(matchesAnyTool(badPairing), false, "and must not satisfy ANY branch either, since it names proactive.settings_propose_update but carries the wrong args");
});

test("A2. every branch's tool enum has exactly one value, matching that branch's own tool name — no branch can claim to be more than one tool", () => {
  for (const tool of toolCatalog) {
    const branch = buildOperationVariantSchema(tool) as { properties: { tool: { enum: unknown[] } } };
    assert.deepEqual(branch.properties.tool.enum, [tool.name], `branch for "${tool.name}" must have a single-value enum matching its own name`);
  }
});

// --- B: goal.log_evidence branch still allows its own real args --------------------------------

test("B. the goal.log_evidence branch still allows its own real args shape", () => {
  const validCall = operation("goal.log_evidence", {
    eventType: null,
    signalKey: "reading_minutes",
    goalRef: "Read more books",
    count: 20,
    notes: "20 minutes of reading today."
  });

  const branch = buildOperationVariantSchema(getToolDefinition("goal.log_evidence")!);
  assert.equal(matchesSchema(validCall, branch), true);
  assert.equal(matchesAnyTool(validCall), true);
});

// --- C: gmail.rule.create branch still allows its own real args, including the signal-mapping fields -

test("C. the gmail.rule.create branch still allows goalRef/signalKey/eventType from the signal-mapping work", () => {
  const validCall = operation("gmail.rule.create", {
    label: "Endesa bills",
    description: null,
    domain: null,
    matchHint: null,
    goalRef: "my Endesa goal",
    signalKey: "endesa_bill_received",
    eventType: null
  });

  const branch = buildOperationVariantSchema(getToolDefinition("gmail.rule.create")!);
  assert.equal(matchesSchema(validCall, branch), true);
  assert.equal(matchesAnyTool(validCall), true);
});

// --- D: internal apply/internal-only tools are still present (not accidentally dropped) and still

test("D. internal apply tools remain valid schema branches (never silently dropped by the restructuring), each still bound only to its own name", () => {
  const internalToolNames = [
    "goal.create_apply",
    "goal.archive_apply",
    "action.hygiene_apply",
    "proactive.settings_apply_update",
    "daily_loop.settings_apply_update",
    "gmail.rule.apply_update",
    "planning.next_week_apply",
    "weekly_review.save"
  ];

  for (const name of internalToolNames) {
    const tool = getToolDefinition(name);
    assert.ok(tool, `${name} must still exist in the tool catalog — this fix must not remove any tool`);
    const branch = buildOperationVariantSchema(tool!) as { properties: { tool: { enum: unknown[] } } };
    assert.deepEqual(branch.properties.tool.enum, [name], `${name}'s branch must still bind only to its own name, not become callable under a different one`);
  }

  // Structural presence in the schema is orthogonal to whether the RUNTIME actually executes a
  // direct planner call to one of these — that protection is the pending-operation firewall in
  // runtime.ts (unchanged by this fix, still covered by each tool's own existing adversarial test,
  // e.g. tests/agent-runtime-goal-creation.test.ts's "goal.create_apply can never be planned by
  // the LLM directly"). This test only proves the schema restructuring itself didn't weaken or
  // remove that surface.
});

// --- E: a mismatched planner output is rejected/normalized, never silently treated as valid ----

test("E. an object naming a real tool but carrying a completely different tool's args satisfies no branch in the full operation schema", () => {
  const mismatched = operation("gmail.rule.create", {
    // goal.create_propose's own shape, not gmail.rule.create's
    title: "Read more books",
    category: "learning",
    why: null,
    successCriteria: null,
    signals: [{ key: "reading_minutes", label: "reading minutes", unit: null, cadence: null }],
    checkIn: null,
    integrationHint: null,
    firstActions: null
  });

  assert.equal(matchesAnyTool(mismatched), false, "a tool name paired with a foreign args shape must satisfy no branch at all");
});

test("E2. an unknown tool name satisfies no branch", () => {
  const unknownTool = operation("goal.delete_forever", { goalId: "abc" });
  assert.equal(matchesAnyTool(unknownTool), false);
});

// --- F: existing valid planner outputs for real, common tools still validate -------------------

const validOperationsByTool: Record<string, Record<string, unknown>> = {
  "action.create": { title: "Apply to jobs", notes: null, priority: "high", dueText: "tomorrow", goalId: null },
  "action.complete": { actionId: null },
  "goal.create_propose": {
    title: "Drink more tea",
    category: "health",
    why: null,
    successCriteria: null,
    signals: [{ key: "tea_cups_drunk", label: "cups of tea drunk", labelSingular: null, unit: null, cadence: null }],
    checkIn: null,
    integrationHint: null,
    firstActions: null,
    dailyCoachingInterest: null
  },
  "goal.log_evidence": { eventType: "career.recruiter_reply_received", signalKey: null, goalRef: null, count: 2, notes: null },
  "gmail.review.approve": { reviewId: null, index: 1, ref: null },
  "gmail.rule.create": { label: "Endesa bills", description: null, domain: null, matchHint: null, goalRef: null, signalKey: null, eventType: null },
  "proactive.settings_propose_update": {
    morningBriefEnabled: null,
    eveningCheckinEnabled: true,
    gmailNudgeEnabled: null,
    morningTimeText: null,
    eveningTimeText: null
  }
};

for (const [toolName, args] of Object.entries(validOperationsByTool)) {
  test(`F. a realistic valid ${toolName} operation still validates against the new schema`, () => {
    const tool = getToolDefinition(toolName);
    assert.ok(tool, `${toolName} must exist in the tool catalog`);

    const candidate = operation(toolName, args);
    const branch = buildOperationVariantSchema(tool!);
    assert.equal(matchesSchema(candidate, branch), true, `expected a realistic ${toolName} call to satisfy its own branch`);
    assert.equal(matchesAnyTool(candidate), true, `expected a realistic ${toolName} call to satisfy the full operation schema`);
  });
}

// --- structural sanity: goal.create_propose's own args schema is unaffected by the restructuring

test("toolArgsPlannerJsonSchema output is embedded as-is inside its own branch (args schema itself is untouched by this fix)", () => {
  const tool = getToolDefinition("goal.log_evidence")!;
  const branch = buildOperationVariantSchema(tool) as { properties: { args: unknown } };
  assert.deepEqual(branch.properties.args, toolArgsPlannerJsonSchema(tool));
});
