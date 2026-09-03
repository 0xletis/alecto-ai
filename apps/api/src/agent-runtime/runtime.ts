import { createMemory, getActionItem, getMostRecentlyRemindedActionItem, getOrCreateNotificationSettings, rejectPendingAction, type EmailReviewItem, type PendingAction } from "@operator-agent/db";
import { loadContext } from "./context-loader.js";
import { addDaysToLocalDateString, formatDateInTimezone } from "../utils/datetime.js";
import { parseGmailAutonomyPreference, type GmailAutonomyPreferenceRequest } from "../legacy/gmail-conversation.js";
import {
  appendMessage,
  clearAllVisibleEntities,
  createPendingOperationRecord,
  mostRecentVisibleSurfaceType,
  recordDeferredCapabilityProposal,
  recordMutation,
  removeVisibleEntities,
  saveSession,
  setPendingOperation,
  setTopic,
  setVisibleEntities
} from "./conversation-session.js";
import { composeGmailGoalUsageStatusReply, executeOperation, parentActionIdFromReminderSourceId, resolveCurrentFocusGoal } from "./executor.js";
import { checkGoalGuardrail, type GuardrailResult } from "./goal-guardrails.js";
import {
  buildVisibleReviewSummaries,
  composeGmailReviewInstructionReply,
  parseGmailReviewInstructionWithLLM,
  validateGmailReviewInstructionOperations
} from "./gmail-review-instruction-parser.js";
import { gmailReviewPresentationCategory, isHighPriorityGmailReview } from "../email-reviews/email-review-service.js";
import { planMessage } from "./planner.js";
import { composeReply, isGroundTruthOnlyTool, summarizePendingOperations } from "./response-composer.js";
import {
  COACH_CONVERSATION_RE,
  EXPLICIT_MUTATION_VERB_RE,
  RESPONSE_MODE_GATED_GMAIL_TOOLS,
  RESPONSE_MODE_GATED_MUTATION_TOOLS,
  isCoachFirstMessage,
  isGreetingWithoutGmailIntent
} from "./response-mode.js";
import { getToolDefinition } from "./tool-catalog.js";
import { runExclusive } from "./user-lock.js";
import { getUserTimezone } from "../utils/user-timezone.js";
import { ACTION_CLARIFICATION_ELIGIBLE_TOOLS, revalidateForExecution, validateOperations } from "./validator.js";
import type {
  AgentDebugInfo,
  AgentEntity,
  AgentMessageRequest,
  AgentMessageResponse,
  AgentMutationRecord,
  AgentPendingOperation,
  AgentSessionState,
  ContextBundle,
  ExecutedOperation,
  PlannedOperation,
  PlanningTraceEntry,
  ValidatedOperation
} from "./types.js";

const META_TOOLS = new Set(["confirmation.confirm", "confirmation.cancel", "clarification.ask"]);

// Exact, whitelisted, whole-message-only confirm/cancel vocabulary. Anything that doesn't
// match exactly (after trimming/lowercasing/dropping a single trailing "."/"!") is NOT treated
// as a confirmation or cancellation — it falls through to the pending-operation firewall below
// or to the planner. This is deliberately much stricter than free-form affirmation detection:
// a false "yes" that executes an unapproved mutation is a far worse failure than asking the
// user to reply with an exact word.
const CONFIRM_WHITELIST = new Set([
  "yes",
  "y",
  "yep",
  "confirm",
  "do it",
  "ok",
  "okay",
  "sure",
  "vale",
  "va",
  "sí",
  "si",
  "perfecto",
  "perfect",
  "looks good",
  "save this review",
  "save the review",
  "save it",
  // feat/private-alpha-capability-proposal-queue: a multi-proposal capability queue (e.g. daily
  // coaching + Gmail support offered together) is confirmed in full the same way any other
  // pending operation is — finalizeDeterministicConfirmation already executes every operation in
  // pending.operations — so "both"/"enable both" (and the Spanish/Catalan equivalents) are just
  // more ways of saying the same whole-message "yes" every other entry here already means.
  "both",
  "enable both",
  "both please",
  "ambos",
  "los dos",
  "las dos",
  "tots dos",
  "totes dues"
]);
const CANCEL_WHITELIST = new Set([
  "no",
  "cancel",
  "stop",
  "never mind",
  "forget it",
  "cancelar",
  "cancela",
  // feat/private-alpha-capability-proposal-queue: "not now" and its Spanish/Catalan equivalents
  // are a natural, unambiguous decline for a capability-proposal offer ("Want me to enable
  // both?" / "not now") — safe as a universal cancel synonym for any pending operation, the same
  // way "never mind"/"forget it" already are.
  "not now",
  "no ahora",
  "ahora no",
  "ara no",
  "no per ara",
  "cancel·la"
]);

// fix/private-alpha-goal-guardrail-followup-keep-active: a real Telegram transcript found "im
// kiding keep it" — a false-alarm follow-up right after the goal-avoidance guardrail intervened
// on "quiero dejar este objetivo" — planned as a fresh goal.archive_propose(operation: "pause")
// by the real LLM planner. Neither CONFIRM_WHITELIST/CANCEL_WHITELIST above nor
// EXTENDED_CONFIRM_PHRASE_RE recognize "keep it" at all (it's neither a yes nor a no), and no
// pending operation existed for the planner's own pending-operation firewall to protect against
// in the first place — the guardrail's early-return never opens one. The planner was simply
// asked to interpret an ambiguous "keep it" against recent conversation history that happened to
// contain the word "paused" (the guardrail's own coaching reply, "I'd rather you paused here —
// what's driving this right now?", meant "let's pause and reflect," never "pause the goal") and
// picked the wrong reading. Recognized deterministically instead, in both of the two real shapes
// this can take: (1) right after a guardrail intervention (session.topic === "guardrail" on the
// immediately preceding turn, checked in processAgentMessageInner, no pending operation involved
// at all), and (2) as new cancel vocabulary for an ALREADY-open real pending pause/archive
// confirmation (pending.topic === "goal_lifecycle"). Neither path ever calls the planner for a
// message that matches, so this class of misreading can't recur no matter how the model's own
// judgment on an ambiguous continuation happens to land.
const KEEP_GOAL_ACTIVE_EN_RE = /\bkeep (it|the goal|this goal)\b|\bdon'?t (pause|archive) it\b/;
const KEEP_GOAL_ACTIVE_ES_RE = /\bseguir con el objetivo\b|\bmantenerlo\b|\bmantenlo\b/;
const KEEP_GOAL_ACTIVE_CA_RE = /\bconserva l['’]?objectiu\b|\bmanten-lo\b/;
// The exact same multilingual affirmative-opener vocabulary EXTENDED_CONFIRM_PHRASE_RE already
// uses, reused here only to detect the one genuinely CONTRADICTORY shape ("yes keep it") — an
// opener that would otherwise read as a real confirmation, paired with keep-language that means
// the opposite. Never treated as a plain confirm OR a plain cancel; always asks instead.
const GOAL_LIFECYCLE_AFFIRMATIVE_OPENER_RE = /^(yes|yep|yeah|y|si|vale|confirm[a]?|d['’]?acord|ok|okay)\b/;

type KeepGoalActiveLanguage = "en" | "es" | "ca";

function detectKeepGoalActiveLanguage(normalizedText: string): KeepGoalActiveLanguage | undefined {
  if (KEEP_GOAL_ACTIVE_CA_RE.test(normalizedText)) return "ca";
  if (KEEP_GOAL_ACTIVE_ES_RE.test(normalizedText)) return "es";
  if (KEEP_GOAL_ACTIVE_EN_RE.test(normalizedText)) return "en";
  return undefined;
}

const KEEP_GOAL_ACTIVE_REPLY: Record<KeepGoalActiveLanguage, string> = {
  en: "Got it — keeping the goal active. No changes made.",
  es: "De acuerdo — mantengo el objetivo activo. No he cambiado nada.",
  ca: "D'acord — mantinc l'objectiu actiu. No he canviat res."
};

const GOAL_LIFECYCLE_CONTRADICTION_CLARIFICATION =
  "That sounds contradictory — do you want me to actually pause/archive it, or keep the goal active? Reply \"yes\" for the first, \"keep it\" for the second.";

// fix/private-alpha-conversation-kernel-context-routing (Part 4): "cancel, I mean X"/"no, actually
// X"/"cancel, X" — a leading cancel word followed by a real correction, as opposed to CANCEL_
// WHITELIST above (which only ever matches the cancel word ALONE, nothing else in the message).
// The connector ("i mean"/"actually"/"instead") is deliberately optional — a bare "cancel, X" is
// just as clear a correction as "cancel, I mean X."
const CANCEL_WITH_CORRECTION_RE = /^(?:cancel|no|nevermind|never mind|forget it|stop)\b[\s,.:;-]*(?:i mean|actually|instead)?[\s,.:;-]*/i;

// A real Telegram smoke test found "yes create it" rejected — only the bare CONFIRM_WHITELIST
// phrases above matched, so a clear, unambiguous affirmative got no special handling and fell
// through to the LLM planner instead of confirming deterministically. This covers the natural
// "yes/sí/vale + short affirming tail" shape WITHOUT widening what counts as a confirmation: it
// requires the whole (trimmed, lowercased) message to be JUST an affirmative opener optionally
// followed by one of a small fixed set of affirming continuations — anything else after the
// opener (a hedge, a change request, an unlisted continuation) fails the match, since the pattern
// is anchored end-to-end with $. "yes but change the target," "yes not that," "maybe create it,"
// and "create something else" all correctly fail to match this.
// No \b after the opener group: JS regex's default (non-unicode) \b is defined against \w
// ([A-Za-z0-9_]), which does NOT include accented letters like "í" — a \b right after "sí" (a
// non-word char followed by another non-word char, the space) would never actually match, silently
// breaking every accented opener. The end-to-end ^...$ anchor plus the explicit [\s,]* separator
// already fully constrain the match, so \b here would only add a real bug, not real safety.
// Extended again for "yes create this" / "yes create the goal" — live traffic showed a pending
// GOAL creation specifically prompts "create this"/"create the goal" phrasing more than the
// generic "create it" this pattern already covered, and that exact new phrasing was rejected.
//
// Extended again for the "proceed" family — "okay proceed"/"ok proceed" add "okay"/"ok" as new
// openers, and "proceed"/"go ahead"/"adelante"/"endavant" are also recognized fully standalone
// (no opener needed at all), since a real Telegram smoke test found a bare "Okay proceed" got the
// whole proposal repeated back instead of confirming. Still end-to-end anchored either way, so
// "okay proceed but change the target," "proceed with another goal," and "maybe proceed" all
// correctly fail to match and fall through to the planner instead.
//
// feat/private-alpha-capability-proposal-queue: a real LLM eval run found "sí, ambos" — a natural
// Spanish reply to a two-proposal capability queue — fell through to the planner instead of
// confirming (the bare CONFIRM_WHITELIST "ambos" entry only matches a message that's JUST that
// word, and "sí, ambos" isn't one of EXTENDED_CONFIRM_PHRASE_RE's own listed continuations
// either). Added "both"/"ambos"/"los dos"/"las dos"/"tots dos"/"totes dues" as continuations here
// too, so "sí, ambos"/"yes both"/"vale, los dos" all confirm deterministically the same way
// "yes create it" already does.
const EXTENDED_CONFIRM_PHRASE_RE =
  /^(yes|yep|yeah|y|s[ií]|vale|confirm[a]?|d['’]?acord|ok|okay)[\s,]*(create it|create this|create the goal|do it|go ahead|make it|make this|confirm this|proceed|cr[eé]alo|h[aá]zlo|crea-?ho|crea esto|crea aquest|crea aix[oò]|procede|endavant|both|enable both|ambos|los dos|las dos|tots dos|totes dues)?$|^(proceed|go ahead|adelante|endavant)$/i;

function looksLikeExtendedConfirmPhrase(normalized: string): boolean {
  return EXTENDED_CONFIRM_PHRASE_RE.test(normalized);
}

const NO_PENDING_REPLY = "I don't have anything pending to confirm.";
const ALREADY_DONE_REPLY = "Already done.";

/**
 * Whether the assistant's own IMMEDIATELY PRECEDING turn really was reporting a mutation that
 * just executed — the ground truth task fix/private-alpha-action-temporal-coaching's "ok do it"
 * acknowledgement relies on, so a bare confirm phrase with nothing pending doesn't read as if
 * the previous, already-successful action never happened. Every fully-processed turn appends
 * EXACTLY one user message (processAgentMessageInner, right at the start) then EXACTLY one
 * assistant message (finalize, at the end) — so messages strictly alternates
 * [...,assistantN-1, userN, ...]. By the time this runs, THIS turn's own user message ("ok do
 * it") is already the last entry, so the previous turn's reply is deterministically the
 * second-to-last entry.
 *
 * Correlated against recentMutations by EXACT TEXT, not by timestamp proximity — an earlier
 * version compared `at` timestamps and was wrong: two turns processed back-to-back in a fast
 * test run (or just a fast exchange) land within the same few-hundred-ms window regardless of
 * whether the second one mutated anything, so an unrelated READ-ONLY turn right after a real
 * mutation could still "pass" a loose time-gap check. For any turn whose reply is a single
 * ground-truth-only mutation summary (composeReply's own groundTruthOnly branch, action.
 * complete/snooze/archive's own case — see response-composer.ts), the assistant's reply text IS
 * exactly that op's own `summary`, the same string recordMutation stored — so an exact match is
 * real proof, and a genuinely different reply (a list, a question, a different tool's summary)
 * can never accidentally match. A multi-op turn's joined reply won't exact-match any single
 * mutation's summary either, so this simply declines for that rarer shape rather than guessing.
 */
function mostRecentTurnWasAMutation(session: AgentSessionState): AgentMutationRecord | undefined {
  const mutation = session.recentMutations[0];
  const previousAssistantMessage = session.messages[session.messages.length - 2];
  if (!mutation || !previousAssistantMessage || previousAssistantMessage.role !== "assistant") {
    return undefined;
  }
  return previousAssistantMessage.text === mutation.summary ? mutation : undefined;
}

// feat/private-alpha-capability-proposal-queue: topic used by goal.create_apply's combined
// post-goal capability offer (e.g. "1. Daily coaching: ... / 2. Gmail support: ..."). A bare
// "yes"/"both" (CONFIRM_WHITELIST above) or "not now"/"cancel" (CANCEL_WHITELIST above) resolve the
// WHOLE queue; a selective reply ("only Gmail", "just daily coaching", "solo Gmail", "només
// coaching", or an index like "only 2") resolves to a named subset via
// matchCapabilityProposalSelection below. This topic is handled ENTIRELY within its own dispatch
// block (see processAgentMessageInner) rather than falling through to the generic whitelist/planner
// firewall for anything unrecognized — fix/private-alpha-launch-hardening-flakes-and-pending-
// clarity: an ambiguous reply used to reach the generic "You still have a pending confirmation…"
// firewall (or, worse, the planner) instead of a clear, queue-specific clarification that names the
// actual allowed replies.
const CAPABILITY_PROPOSALS_TOPIC = "capability_proposals";
// Matches "only 2"/"just 1" or a bare "2" — deliberately generic (no per-capability keyword table
// here at all): matching against a NAME is driven entirely by each pending operation's own
// proposalAliases (see types.ts), and matching against a POSITION by its own proposalIndex — both
// set once, per proposal, in executor.ts's proposal-building code. Adding a third capability later
// needs a new aliases list there, never a change to this file.
const CAPABILITY_PROPOSAL_INDEX_RE = /\b(?:only|just)\s+(\d+)\b|^\s*(\d+)\s*$/i;

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolves a reply against an open capability-proposal queue to the subset of proposalIds it
 * clearly names — by index ("only 2") or by alias ("only Gmail", "solo coaching"). Returns an
 * empty array for "nothing recognized" and an array with 2+ entries for "more than one named at
 * once" — both are treated as ambiguous by the caller (finalizeCapabilityProposalClarification),
 * never guessed. An index outside the queue's actual range (e.g. "only 5" with only two proposals)
 * also returns empty, so it clarifies rather than silently doing nothing.
 */
function matchCapabilityProposalSelection(pending: AgentPendingOperation, message: string): string[] {
  const normalized = message.trim().toLowerCase();
  const proposalOps = pending.operations.filter((op) => op.proposalId);

  const indexMatch = CAPABILITY_PROPOSAL_INDEX_RE.exec(normalized);
  if (indexMatch) {
    const requestedIndex = Number(indexMatch[1] ?? indexMatch[2]);
    const byIndex = proposalOps.find((op) => op.proposalIndex === requestedIndex);
    return byIndex?.proposalId ? [byIndex.proposalId] : [];
  }

  const matchedIds = new Set<string>();
  for (const op of proposalOps) {
    if (!op.proposalId) {
      continue;
    }
    const aliases = op.proposalAliases ?? [];
    if (aliases.some((alias) => new RegExp(`\\b${escapeRegExpLiteral(alias)}\\b`, "i").test(normalized))) {
      matchedIds.add(op.proposalId);
    }
  }
  return [...matchedIds];
}

/** Dynamically built from the queue's own proposal labels, so a third capability's clarification/
 * cancel copy never needs a hardcoded update here — see finalizeCapabilityProposalClarification and
 * the cancellation path below. */
function capabilityProposalLabels(pending: AgentPendingOperation): string[] {
  return pending.operations.filter((op) => op.proposalLabel).map((op) => op.proposalLabel as string);
}

// fix/private-alpha-goal-restore-ambiguity-resolution: topic used by goal.restore_propose's
// disambiguation offer when several archived goals match one restore request (see executor.ts's
// buildGoalRestoreDisambiguation). Each pending op carries proposalIndex (numbered position) and
// candidateCreatedAt/candidateArchivedAt (ISO strings) — matchGoalRestoreDisambiguation below
// resolves a reply against those three signals (index, exact title, or recency) without a second
// DB round-trip. Resolving to exactly one candidate never restores it directly — it installs a
// fresh "goal_restore" single-goal confirmation (see finalizeGoalRestoreDisambiguationSelection),
// the SAME final "reply yes to confirm" step the direct, unambiguous match path already uses.
const RESTORE_GOAL_DISAMBIGUATION_TOPIC = "restore_goal_disambiguation";
const RESTORE_DISAMBIGUATION_NONE_RE = /^(none|ninguno|ninguna|cap)\.?$/i;
const RESTORE_DISAMBIGUATION_ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  primero: 1,
  primer: 1,
  segundo: 2,
  segon: 2,
  tercero: 3,
  tercer: 3,
  cuarto: 4,
  quart: 4,
  quinto: 5,
  cinque: 5
};
const RESTORE_DISAMBIGUATION_ORDINAL_RE = new RegExp(`\\b(${Object.keys(RESTORE_DISAMBIGUATION_ORDINAL_WORDS).join("|")})\\b`, "i");
// Deliberately broad natural-language recency words (English/Spanish/Catalan) — "el último," "l'últim,"
// "más reciente," "més recent" all mean "the latest" without necessarily also saying "archived"/
// "created," so a bare recency word defaults to sorting by archivedAt (the more natural default for
// a RESTORE flow specifically — "the latest one" most naturally means "the one I archived last").
const RESTORE_DISAMBIGUATION_LATEST_RE = /\b(latest|newest|most recent\w*|more recent\w*|ultimo|último|ultim|últim|mas reciente|más reciente|mes recent|més recent)\b/i;
const RESTORE_DISAMBIGUATION_ARCHIVED_WORD_RE = /\b(archiv\w*|arxiv\w*)\b/i;
const RESTORE_DISAMBIGUATION_CREATED_WORD_RE = /\b(creat\w*|creada?s?)\b/i;
const RESTORE_DISAMBIGUATION_TODAY_RE = /\b(today|hoy|avui)\b/i;

interface RestoreDisambiguationCandidate {
  goalId: string;
  goalTitle: string;
  index?: number;
  createdAt?: string;
  archivedAt?: string | null;
}

function restoreDisambiguationCandidates(pending: AgentPendingOperation): RestoreDisambiguationCandidate[] {
  return pending.operations
    .filter((op) => typeof op.args.goalId === "string")
    .map((op) => ({
      goalId: op.args.goalId as string,
      goalTitle: (op.args.goalTitle as string | undefined) ?? "",
      index: op.proposalIndex,
      createdAt: op.candidateCreatedAt,
      archivedAt: op.candidateArchivedAt
    }));
}

function normalizeGoalTitleForExactMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type RestoreDisambiguationResolution =
  | { status: "resolved"; candidate: RestoreDisambiguationCandidate }
  | { status: "cancel" }
  | { status: "unresolved" };

/**
 * Resolves a reply to an open restore-disambiguation clarification: by 1-based index/ordinal
 * ("1," "the first one"), by a normalized exact title match that's unique among the candidates, or
 * by recency ("latest archived," "latest created," "the one archived today," a combination of
 * both). Never guesses when more than one candidate remains after every signal is applied — the
 * caller re-asks instead. "none"/"cancel" (English/Spanish/Catalan) clear the clarification
 * entirely, matching the product rule that a restore disambiguation is a real answerable question,
 * not a dead end the user can only escape by starting over.
 */
function matchGoalRestoreDisambiguation(pending: AgentPendingOperation, message: string, timezone: string): RestoreDisambiguationResolution {
  const normalizedExact = normalizeExactMessage(message);
  const text = normalizeIntentText(message);

  if (CANCEL_WHITELIST.has(normalizedExact) || RESTORE_DISAMBIGUATION_NONE_RE.test(message.trim())) {
    return { status: "cancel" };
  }

  const candidates = restoreDisambiguationCandidates(pending);
  if (candidates.length === 0) {
    return { status: "unresolved" };
  }

  const numberMatch = text.match(/\b(\d+)\b/);
  let index: number | undefined = numberMatch ? Number(numberMatch[1]) : undefined;
  if (index === undefined) {
    const ordinalMatch = RESTORE_DISAMBIGUATION_ORDINAL_RE.exec(text);
    if (ordinalMatch) {
      index = RESTORE_DISAMBIGUATION_ORDINAL_WORDS[ordinalMatch[1].toLowerCase()];
    }
  }
  if (index !== undefined) {
    const byIndex = candidates.find((c) => c.index === index);
    if (byIndex) {
      return { status: "resolved", candidate: byIndex };
    }
  }

  const normalizedRef = normalizeGoalTitleForExactMatch(text);
  if (normalizedRef.length > 0) {
    const titleMatches = candidates.filter((c) => normalizeGoalTitleForExactMatch(c.goalTitle) === normalizedRef);
    if (titleMatches.length === 1) {
      return { status: "resolved", candidate: titleMatches[0] };
    }
  }

  const hasArchivedWord = RESTORE_DISAMBIGUATION_ARCHIVED_WORD_RE.test(text);
  const hasCreatedWord = RESTORE_DISAMBIGUATION_CREATED_WORD_RE.test(text);
  const hasToday = RESTORE_DISAMBIGUATION_TODAY_RE.test(text);
  const hasLatest = RESTORE_DISAMBIGUATION_LATEST_RE.test(text);

  let pool = candidates;

  if (hasToday) {
    const field: "createdAt" | "archivedAt" = hasCreatedWord && !hasArchivedWord ? "createdAt" : "archivedAt";
    const todayLocal = formatDateInTimezone(new Date(), timezone);
    const filtered = pool.filter((c) => c[field] && formatDateInTimezone(new Date(c[field] as string), timezone) === todayLocal);
    if (filtered.length > 0) {
      pool = filtered;
    }
  }

  if (hasLatest || hasCreatedWord || hasArchivedWord) {
    const field: "createdAt" | "archivedAt" = hasCreatedWord && !hasArchivedWord ? "createdAt" : "archivedAt";
    const withField = pool.filter((c) => c[field]);
    if (withField.length > 0) {
      const latest = withField.reduce((a, b) => (new Date(a[field] as string).getTime() >= new Date(b[field] as string).getTime() ? a : b));
      return { status: "resolved", candidate: latest };
    }
  }

  if (pool.length === 1) {
    return { status: "resolved", candidate: pool[0] };
  }

  return { status: "unresolved" };
}

// Marks session.pendingOperation as "an ambiguous action-completion clarification is open" —
// there is nothing here to actually confirm, so the mutation firewall below (which exempts this
// exact topic) never treats it like a real yes/no confirmation and blocks an unrelated later
// request the way a genuine pending mutation should.
const ACTION_CLARIFICATION_TOPIC = "action_clarification";
const ACTION_CLARIFICATION_CANCEL_REPLY = "Okay — I won't complete anything.";

// Topic used by action.list's own duplicate-cleanup pendingOperationUpdate (executor.ts) — "keep
// the first, archive the duplicate?" always resolves to exactly ONE already-fully-resolved
// action.archive operation, so a fairly wide natural vocabulary is safe here in a way it wouldn't
// be for an arbitrary pending mutation. Deliberately includes a bare "yes" too — CONFIRM_WHITELIST
// already covers that case on its own, but keeping this pattern self-contained (rather than
// relying on two separate checks agreeing) makes it easier to reason about in isolation.
const ACTION_DUPLICATE_CLEANUP_TOPIC = "action_duplicate_cleanup";
const ACTION_DUPLICATE_CLEANUP_CONFIRM_RE = /\byes\b|\bmerge (them|it)\b|\barchive (the duplicate|one|it|2|two)\b|\bkeep (the )?(first|1|one)\b|\bremove (2|two)\b/i;
const ACTION_DUPLICATE_CLEANUP_CANCEL_RE = /\bshow both\b|\bkeep both\b|\bdon['’]?t (merge|archive)\b/i;

// See the "fix/private-alpha-live-action-and-coaching-regressions (Task 4)" call site below for
// the real transcript this closes. Deliberately wider than EXTENDED_CONFIRM_PHRASE_RE (which only
// ever matches a short, whole-message confirm opener) — a pending action.create's own natural
// confirm vocabulary reasonably includes trailing text ("yes do so and show me my actions"), and
// unlike an arbitrary pending mutation, a pending action.create is always exactly ONE already-
// resolved operation, so a wide match here is safe the same way ACTION_DUPLICATE_CLEANUP_CONFIRM_RE
// above is.
const ACTION_CREATION_CONFIRM_RE =
  /\b(yes|yep|yeah|y|s[ií]|vale|va|confirm(ed)?|do it|do so|go ahead|create it|create this|make it|sure|ok|okay|perfect|perfecto|d['’]?acord|endavant)\b/i;
const ACTION_CREATION_TRAILING_LIST_RE =
  /\b(show|list|see|check)\b[\s\S]{0,20}\b(me )?(my )?actions?\b|\b(ver|mu[eé]strame|ense[ñn]ame)\b[\s\S]{0,20}\bmis acciones\b|\b(veure|mostra['’]?m)\b[\s\S]{0,20}\bmeves accions\b/i;

/**
 * "none," "no action," "nothing," "never mind," "cancel," "i mean NO ACTION" — a direct answer
 * to Alecto's own "Which action do you mean?" clarification that means "don't do anything,"
 * never a fresh, unrelated request. A real Telegram smoke test found this fell through to the
 * real planner with no way to know a clarification was just asked, and got misread as an
 * action-cleanup request ("Here are the actions worth cleaning up..."). Only ever checked when
 * session.pendingOperation.topic is ACTION_CLARIFICATION_TOPIC (see call site), so this never
 * touches an unrelated "none"/"nothing" said at some other point in the conversation.
 */
function looksLikeActionClarificationCancelReply(message: string): boolean {
  const normalized = normalizeExactMessage(message);
  if (["none", "no action", "nothing", "never mind", "nevermind", "cancel", "forget it"].includes(normalized)) {
    return true;
  }
  const text = normalizeIntentText(message);
  return /\bno\s+action\b|\bnone\b|\bnothing\b|\bnever\s*mind\b|\bforget it\b|\bcancel\b/.test(text);
}

/** Only ever needed for action.complete/archive/snooze/reschedule's own reference-ambiguity
 * clarification (validator.ts's ACTION_CLARIFICATION_ELIGIBLE_TOOLS) — a goal-shaped or Gmail-
 * review-shaped clarification question is answered differently (a real confirm/cancel flow, or
 * just re-asking) and must not be mistaken for "waiting on which action the user meant." */
function markActionClarificationPendingIfNeeded(
  session: AgentSessionState,
  validatedOps: ValidatedOperation[],
  clarificationQuestion: string | undefined
): void {
  if (!clarificationQuestion) {
    return;
  }
  const referenceAmbiguityOp = validatedOps.find((op) => op.status === "needs_clarification" && ACTION_CLARIFICATION_ELIGIBLE_TOOLS.has(op.tool));
  if (referenceAmbiguityOp) {
    // A single specific candidate was rejected for weak (generic-only) grounding rather than a
    // genuine multi-way ambiguity — validator.ts attaches the real tool+args so a bare "yes"
    // here actually runs it (see the mutation firewall's pendingHasRealMutation check below,
    // which protects this the same way a real pending confirmation is protected). Otherwise, a
    // non-empty but inert clarification.ask stub — asPendingOperation (session-store.ts) treats
    // an empty operations array as corrupted data and discards it on the very next load, which
    // would silently drop this marker before the cancel-phrase check ever saw it; clarification
    // .ask itself is never executed, it exists purely so the record round-trips through
    // persistence intact.
    const operations = referenceAmbiguityOp.suggestedConfirmOperation
      ? [{ tool: referenceAmbiguityOp.suggestedConfirmOperation.tool, args: referenceAmbiguityOp.suggestedConfirmOperation.args, status: "valid" as const, requiresConfirmation: false }]
      : [{ tool: "clarification.ask", args: { question: clarificationQuestion }, status: "valid" as const, requiresConfirmation: false }];
    setPendingOperation(session, createPendingOperationRecord(ACTION_CLARIFICATION_TOPIC, clarificationQuestion, operations));
  }
}

// Deliberately narrow, hardcoded-safe pattern: Gmail send/reply/forward/delete
// has no tool in the catalog at all, so this is enforced deterministically
// rather than left to the planner's judgment — it must never depend on
// whether the LLM correctly refuses in a given turn. Runs unconditionally,
// including while a pending operation is open, and never touches pendingOperation.
//
// The reply/respond/answer branch requires an AGENT-DIRECTED shape (a "to"
// object, an explicit "for me"/"on my behalf", or "can/could/would you
// reply") rather than mere proximity to email/mail/gmail — a real private-
// alpha Telegram transcript found the old, looser proximity match ("reply"
// within 40 chars of "mail") false-triggering on "let me know when some of
// them Reply as my mail get flooded with automatic responses," a passive
// notification request, not a request for Alecto to send/reply to anything.
// `\breply\b`/`\brespond\b` intentionally don't match "replies"/"responses"
// (no word boundary between "y"/"d" and the following "ies"/"ses"), so
// passive plural phrasing ("recruiter replies," "automatic responses")
// never reaches this branch either.
const UNSUPPORTED_GMAIL_ACTION_RE =
  /\b(reply|respond|answer)\s+to\b|\b(reply|respond|answer)\b[\s\S]{0,20}\b(for me|on my behalf|myself)\b|\b(can|could|would)\s+you\s+(reply|respond|answer)\b|\bsend\b[\s\S]{0,20}\b(email|mail|reply)\b|\bforward\b[\s\S]{0,20}\b(email|mail)\b|\b(delete|remove|archive|label)\b[\s\S]{0,20}\b(email|mail)\b[\s\S]{0,20}\b(gmail|inbox)\b|\b(delete|remove|archive|label)\s+(this|that|the)\s+(email|gmail)\b/i;

const UNSUPPORTED_GMAIL_ACTION_REPLY =
  "I can't reply to Gmail messages or send emails yet. I can only read matching emails through active rules and create review items.";

// Defense-in-depth, checked ONLY alongside UNSUPPORTED_GMAIL_ACTION_RE above: even a precise
// agent-directed match ("for me", "you reply") should not hijack a pending, not-yet-confirmed
// goal proposal that the user is actively refining with ordinary goal-editing language (targets,
// cadence, integrations, tracking preferences) — that message should reach the planner so it can
// revise the proposal instead. Does not soften the shortcut for a genuinely unsupported request
// with no such language (e.g. "reply to the recruiter for me" on its own still blocks).
const GOAL_EDIT_LANGUAGE_RE =
  /\b(target|goal|track(ing)?|cadence|check-?in|integration|prefer|instead|aggressive|no (fixed |hard )?(target|number)|daily|weekly|motivation)\b/i;

// Covers "let me know when I receive one/it arrives", "notify me when I get one", "just let
// me know", "I wanna know", "about those emails", "when they arrive", and close paraphrases.
// Only ever checked while the pending operation is specifically a gmail.rule.create — a narrow
// enough gate that a broader phrase match here is safe.
const GMAIL_PENDING_NOTIFICATION_FOLLOWUP_RE =
  /\b(let me know|notify me|keep me posted|tell me)\b|\bi wanna know\b|\bi want to know\b|\bwhen (i receive|i get|it arrives|they arrive)\b|\babout (those|these|that) emails?\b/i;

// Deliberately narrow (allowlist, not blocklist): only genuinely broad, no-specific-capability
// operator/help/orientation questions — never a specific capability request (Gmail, planning,
// weekly review, action CRUD, goal.list's own phrases, etc.), which must always reach the
// planner unchanged. See goal-anchor-nudge below.
const BROAD_OPERATOR_QUESTION_RE =
  /^(so )?what should i do( today)?\??$|^what can you help( me)?( with)?\??$|^help me get (organized|started)\??$|^so what('s| is)? today\??$|^how do i (start|get started|begin)\??$|^where do i start\??$|^what now\??$|^what'?s next\??$/i;

// Deliberately narrow (allowlist): an explicit request to be walked through setup/onboarding,
// not a general capability question (those already go through BROAD_OPERATOR_QUESTION_RE/the
// goal-anchor nudge, or straight to the planner). Checked regardless of whether the user already
// has goals — a returning user asking to redo setup is a real, if less common, case too.
const ONBOARDING_SETUP_REQUEST_RE =
  /\bset me up\b|\b(help|get) me set up\b|\bset up alecto\b|\bonboard(ing)? me\b|\bhow do i set (this|you|alecto) up\b/i;

// Deliberately deterministic, not left to the planner — a fixed, numbered 5-question setup
// checklist so it's identical every time and never silently balloons into a longer wizard. Each
// question maps to a real, existing storage primitive (operator_profile.propose_update for style,
// proactive.settings_propose_update for cadence, the existing Gmail OAuth flow for the
// integration) — answers are collected in plain language over the following turns and only ever
// stored once the user explicitly confirms each proposed change.
export const ONBOARDING_SETUP_REPLY = [
  "Happy to set this up properly. A few quick questions — answer in your own words, one at a time or all at once:",
  "",
  "1. What do you want help with? (a job search, fitness, spending, a habit, admin/bills — anything)",
  "2. How should I talk to you — gentle, balanced, or blunt?",
  "3. Want daily check-ins? I have a morning brief and an evening check-in — either, both, or neither.",
  "4. Any guardrails I should watch for — spending, gambling, avoidance, sleep, job search burnout, or something else?",
  "5. Want to connect Gmail so I can watch for relevant emails (read-only — I can never send or reply)?",
  "",
  "Nothing is saved until you confirm each change. Skip any question you'd rather not answer."
].join("\n");

const GOAL_ANCHOR_NUDGE_MARKER = "one real goal or guardrail";

// Exported so apps/operator/proactive.ts's morning-brief decision can reuse the exact same
// empty-user text (task explicitly asks for "goal-anchor nudge style") instead of duplicating it.
//
// This text used to say "Goal creation through chat isn't wired yet, so use /create_goal for
// now" — stale since Adaptive Goal Creation (goal.create_propose/apply) shipped, and it directly
// contradicted the same system prompt's own "never recommend a slash command, describe the
// natural-language equivalent instead" rule (planner.ts's buildSystemPrompt). This is the FIRST
// thing a genuinely new, goal-less user sees, so telling them to go run a command instead of just
// describing what they want — which already works — was actively bad onboarding, not neutral.
export const GOAL_ANCHOR_NUDGE_REPLY = [
  `I can help, but I work best with ${GOAL_ANCHOR_NUDGE_MARKER} to anchor to — right now you don't have one set.`,
  "",
  "A few examples:",
  "1. Find a new developer job",
  "2. Train 3x/week",
  "3. Avoid impulsive spending",
  "4. Build a project",
  "",
  "Tell me what you want to work on in your own words — e.g. \"I want to find a new developer job\" — and I'll set it up with you.",
  "",
  "Prefer a quick guided setup instead? Just say \"set me up\" and I'll ask a few questions about how you want to work together."
].join("\n");

/**
 * True only for a genuinely empty user (no active goals, no configured knownTriggers/
 * knownFailureModes — so the goal-aligned guardrail engine, goal-guardrails.ts, has nothing to
 * work with either) asking a broad, capability-agnostic operator/help question, and only when
 * the nudge wasn't the very last thing shown (checked against session.messages — no new schema,
 * see wasGoalAnchorNudgeShownLast). This is deliberately conservative: any active goal, any
 * configured trigger/failure mode, a pending operation, or a specific capability request all
 * skip it, so it can never interrupt or repeat a real flow.
 */
function shouldShowGoalAnchorNudge(context: ContextBundle, message: string): boolean {
  if (context.session.pendingOperation) {
    return false;
  }
  if (context.activeGoals.length > 0) {
    return false;
  }
  const profile = context.operatingProfile;
  if ((profile.knownTriggers?.length ?? 0) > 0 || (profile.knownFailureModes?.length ?? 0) > 0) {
    return false;
  }
  if (!BROAD_OPERATOR_QUESTION_RE.test(message.trim())) {
    return false;
  }
  return !wasGoalAnchorNudgeShownLast(context.session);
}

function wasGoalAnchorNudgeShownLast(session: AgentSessionState): boolean {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const entry = session.messages[i];
    if (entry.role === "assistant") {
      return entry.text.includes(GOAL_ANCHOR_NUDGE_MARKER);
    }
  }
  return false;
}

// --- Dev/test-only planning trace (never active in production unless explicitly opted in) ---

// Read fresh on every call, not cached at module load — tests toggle this per-turn via
// process.env, and a module-level constant would freeze whatever value was set at import time.
function isPlanningTraceEnabled(): boolean {
  return process.env.AGENT_RUNTIME_PLANNING_TRACE === "true";
}

function isPlanningTool(tool: string | undefined | null): boolean {
  return Boolean(tool && tool.startsWith("planning."));
}

function logAgentRuntimeDiagnostics(input: {
  phase: string;
  userId: string;
  plannerOps?: PlannedOperation[];
  explicitReviewIntentMap?: ExplicitGmailReviewIntentEntry[];
  finalOps?: PlannedOperation[];
  validatedOps?: ValidatedOperation[];
  mutationTools?: string[];
  /** Free-form context for a phase that isn't well captured by the structured fields above — e.g.
   * for "complete it"/"done", whether it resolved to a real ActionItem (and via which source:
   * the worker's own recent notification log, or a plain visible session entity) or fell through
   * to the normal planner entirely (meaning it could still end up targeting a Gmail review). */
  note?: string;
}): void {
  if (process.env.AGENT_RUNTIME_DIAGNOSTICS !== "true") {
    return;
  }

  console.log(
    "[agent-runtime-diagnostics]",
    JSON.stringify({
      phase: input.phase,
      userId: input.userId,
      runtimeSelected: "agent_v3",
      plannerOps: input.plannerOps?.map(safeDiagnosticOperation) ?? [],
      explicitReviewIntentMap:
        input.explicitReviewIntentMap?.map((entry) => ({ index: entry.index, intent: entry.intent, position: entry.position })) ?? [],
      finalOps: input.finalOps?.map(safeDiagnosticOperation) ?? [],
      validatedOps: input.validatedOps?.map((op) => ({ tool: op.tool, status: op.status })) ?? [],
      mutationTools: input.mutationTools ?? [],
      ...(input.note ? { note: input.note } : {})
    })
  );
}

function safeDiagnosticOperation(op: PlannedOperation): { tool: string; args: Record<string, unknown> } {
  const safeArgs: Record<string, unknown> = {};
  for (const key of ["index", "ref", "dueText", "reminderLeadMinutes", "leadMinutes", "status", "limit"]) {
    if (op.args[key] !== undefined) {
      safeArgs[key] = op.args[key];
    }
  }
  return { tool: op.tool, args: safeArgs };
}

/**
 * Compound-turn visibility, gated behind AGENT_RUNTIME_DIAGNOSTICS=true like every other
 * diagnostics call in this file — a "compound turn" here just means more than one operation was
 * ultimately planned for the message, regardless of whether that came from a deterministic
 * shortcut or the real LLM planner. Answers exactly the questions a compound-handling bug is
 * hardest to debug without: how many operations survived to the final plan, which of them
 * actually mutated something, whether a pending confirmation was opened alongside them, and —
 * the main thing this hardening pass cares about — whether every executed operation's own
 * summary actually made it into the composed reply, or got silently dropped.
 */
function logCompoundTurnDiagnostics(
  userId: string,
  finalOperations: PlannedOperation[],
  executedOps: ExecutedOperation[],
  pendingOperationOpen: boolean,
  reply: string
): void {
  if (finalOperations.length <= 1) {
    return;
  }

  const summarizedOps = executedOps.filter((op) => op.status === "executed" || op.status === "skipped");
  const allSummariesIncluded = summarizedOps.every((op) => reply.includes(op.summary));

  logAgentRuntimeDiagnostics({
    phase: "compound_turn_detected",
    userId,
    finalOps: finalOperations,
    mutationTools: executedOps.filter((op) => op.status === "executed" && getToolDefinition(op.tool)?.mutates).map((op) => op.tool),
    note: `operationCount=${finalOperations.length} pendingConfirmationOpened=${pendingOperationOpen} allToolSummariesIncluded=${allSummariesIncluded}`
  });
}

interface PlanningTraceInputs {
  message: string;
  plannedOp: PlannedOperation | undefined;
  validatedOp: ValidatedOperation | undefined;
  executedOp: ExecutedOperation | undefined;
  pendingOperationBefore: AgentPendingOperation | null;
  visibleEntitiesBefore: AgentEntity[];
  composerSource: string;
}

/**
 * Builds and logs a full-pipeline trace for one planning.* turn — gated behind
 * AGENT_RUNTIME_PLANNING_TRACE=true (unset/false in every real deployment) and only produced
 * for turns that actually touch a planning tool or a planning pendingOperation, so it never
 * adds overhead or log volume to normal traffic. Logs only the acting user's own message/plan
 * for their own turn — never cross-user data — but stays behind the explicit opt-in anyway,
 * matching "do not leak sensitive data in production logs."
 */
function recordPlanningTrace(inputs: PlanningTraceInputs, session: AgentSessionState): PlanningTraceEntry | undefined {
  const involvesPlanning =
    isPlanningTool(inputs.plannedOp?.tool) ||
    isPlanningTool(inputs.pendingOperationBefore?.operations[0]?.tool) ||
    isPlanningTool(session.pendingOperation?.operations[0]?.tool);

  if (!isPlanningTraceEnabled() || !involvesPlanning) {
    return undefined;
  }

  const entry: PlanningTraceEntry = {
    message: inputs.message,
    plannedTool: inputs.plannedOp?.tool ?? null,
    plannedArgs: inputs.plannedOp?.args ?? null,
    validationStatus: inputs.validatedOp?.status ?? null,
    validationError: inputs.validatedOp?.error ?? inputs.validatedOp?.clarificationQuestion ?? null,
    resolvedArgs: inputs.validatedOp?.args ?? null,
    executorStatus: inputs.executedOp?.status ?? null,
    executorSummary: inputs.executedOp?.summary ?? null,
    pendingOperationBefore: inputs.pendingOperationBefore,
    pendingOperationAfter: session.pendingOperation,
    visibleEntitiesBefore: inputs.visibleEntitiesBefore,
    visibleEntitiesAfter: session.visibleEntities,
    composerSource: inputs.composerSource
  };

  console.log(`[planning-trace] user=${session.userId}`, JSON.stringify(entry));
  return entry;
}

/** Classifies which composeReply branch produced a reply, for tracing only — mirrors composeReply's own priority order without duplicating its logic. */
function inferComposerSource(input: {
  clarificationQuestion?: string;
  pendingConfirmationOps: ValidatedOperation[];
  executedOps: ExecutedOperation[];
  problemOps: ValidatedOperation[];
  replyDraft: string;
}): string {
  if (input.clarificationQuestion) return "clarification_question";
  if (input.pendingConfirmationOps.length > 0) return "pending_confirmation";
  if (input.problemOps.length > 0 || input.executedOps.some((op) => op.status === "failed")) return "problem_correction";
  if (input.executedOps.some((op) => (op.status === "executed" || op.status === "skipped") && isGroundTruthOnlyTool(op.tool))) {
    return "ground_truth_only";
  }
  if (input.executedOps.some((op) => (op.status === "executed" || op.status === "skipped") && getToolDefinition(op.tool)?.mutates === false)) {
    return "informational_summary";
  }
  if (input.replyDraft) return "reply_draft";
  if (input.executedOps.some((op) => (op.status === "executed" || op.status === "skipped") && getToolDefinition(op.tool)?.mutates === true)) {
    return "mutation_summary";
  }
  return "fallback_no_action";
}

export async function handleAgentMessage(request: AgentMessageRequest): Promise<AgentMessageResponse> {
  return runExclusive(request.userId, () => processAgentMessage(request));
}

const GENERIC_ERROR_REPLY = "I hit an unexpected problem there — please try again.";

/**
 * Last-resort safety net: ANY uncaught error anywhere in a turn (a DB hiccup, a malformed
 * timezone, an unexpected shape from a dependency) must still produce a normal response with
 * an honest reply, never crash the request and surface the Telegram layer's generic dev-safe
 * "Agent v3 hit an error" text for what could be a perfectly ordinary turn — e.g. a
 * transient failure on a brand-new user's very first message. Per-operation failures are
 * already caught inside executeOperation and reported as a grounded "failed" result; this
 * only catches what's truly unexpected, so it never masks or replaces that existing,
 * more specific error reporting. Nothing about the turn is persisted when this fires (no
 * saveSession call happened), so a crash here can never leave a half-written session.
 */
async function processAgentMessage(request: AgentMessageRequest): Promise<AgentMessageResponse> {
  try {
    if (process.env.AGENT_RUNTIME_FORCE_ERROR === "true") {
      throw new Error("AGENT_RUNTIME_FORCE_ERROR: forced failure for testing the top-level safety net.");
    }
    return await processAgentMessageInner(request);
  } catch (error) {
    console.error(`[agent-runtime] unexpected error handling user=${request.userId}`, error);
    return {
      reply: GENERIC_ERROR_REPLY,
      operationsPlanned: [],
      operationsExecuted: [],
      needsConfirmation: false,
      debug: {
        runtime: "agent_v3",
        plannerUsed: "none",
        llmPlannerAttempted: false,
        llmPlannerUsed: false,
        toolValidationPassed: false,
        mutationExecuted: false,
        conversationTopic: null,
        pendingOperation: false,
        legacyPendingActionDetected: false
      }
    };
  }
}

async function processAgentMessageInner(request: AgentMessageRequest): Promise<AgentMessageResponse> {
  const { userId, message, channel } = request;
  const context = await loadContext(userId, channel);
  appendMessage(context.session, "user", message);

  // Captured before anything in this turn can mutate them — setPendingOperation/
  // setVisibleEntities always reassign context.session.X to a new value rather than mutating
  // the existing object in place, so these references safely keep representing "before" for
  // the rest of the turn, including inside recordPlanningTrace's "after" comparison later.
  const pendingOperationBefore = context.session.pendingOperation;
  const visibleEntitiesBefore = context.session.visibleEntities;

  const pending = context.session.pendingOperation;
  const normalized = normalizeExactMessage(message);

  // Checked before the general confirm/cancel whitelist below so all six supported cancel
  // phrases ("none," "no action," "nothing," "never mind," "cancel," "i mean NO ACTION") get the
  // SAME specific reply here, rather than "cancel"/"never mind" alone falling through to the
  // generic "Cancelled — I won't do that." from finalizeDeterministicCancellation.
  if (pending?.topic === ACTION_CLARIFICATION_TOPIC && looksLikeActionClarificationCancelReply(message)) {
    setPendingOperation(context.session, null);
    // Same reasoning as finalizeDeterministicCancellation's own ACTION_CLARIFICATION_TOPIC
    // exemption: the numbered list the user was actually shown is the source of truth for a
    // later numbered reference and must survive cancelling an unrelated ambiguity/suggestion
    // question about it — a real Telegram smoke test found "complete action 10 and 9 now" right
    // after cancelling this way silently resolving against a completely different ordering once
    // visibleEntities had been wiped.
    return finalize(context, {
      reply: ACTION_CLARIFICATION_CANCEL_REPLY,
      operationsPlanned: [],
      executedOps: [{ tool: "confirmation.cancel", status: "executed", summary: ACTION_CLARIFICATION_CANCEL_REPLY }],
      plannerUsed: "none",
      llmPlannerAttempted: false,
      toolValidationPassed: true,
      topic: ACTION_CLARIFICATION_TOPIC
    });
  }

  // fix/private-alpha-deferred-action-dedupe-and-today-coaching: a real Telegram transcript found
  // "merge them yes" — a real, natural confirmation of the duplicate-cleanup proposal below —
  // fell straight through to the general planner instead of confirming, since the general
  // CONFIRM_WHITELIST/EXTENDED_CONFIRM_PHRASE_RE only ever recognize an affirmative OPENER
  // ("yes ...", never "... yes"). Rather than widen that shared, safety-sensitive pattern for
  // every pending operation in the product, this is scoped to exactly the one topic it's about —
  // the duplicate-cleanup proposal (action.list's own "keep the first, archive the duplicate?")
  // has an unusually large natural vocabulary for "yes" ("merge them", "archive the duplicate",
  // "keep the first", "keep 1", "remove 2" are all just different ways of confirming the SAME
  // single already-resolved operation), so it gets its own small, topic-scoped recognizer instead.
  if (pending?.topic === ACTION_DUPLICATE_CLEANUP_TOPIC) {
    if (ACTION_DUPLICATE_CLEANUP_CANCEL_RE.test(message)) {
      return finalizeDeterministicCancellation(context, message);
    }
    if (ACTION_DUPLICATE_CLEANUP_CONFIRM_RE.test(message)) {
      return finalizeDeterministicConfirmation(context, message);
    }
  }

  // fix/private-alpha-live-action-and-coaching-regressions (Task 4): a real Telegram transcript
  // found "Yes do so and show me my actions so i can verify" — a natural confirm PLUS a trailing
  // list request in the SAME message, right after "schedule sending 3 CVs today" opened a pending
  // action.create confirmation — landed on the general LLM planner instead of the deterministic
  // confirm path below, since it matches neither the exact CONFIRM_WHITELIST nor
  // EXTENDED_CONFIRM_PHRASE_RE (both only ever recognize a bare/short confirm OPENER, never a
  // compound sentence). The planner then re-planned a brand-new action.create for the same title
  // — reading "yes" as an instruction to create, not as confirming the one already pending —
  // producing two duplicate "Send 3 CVs" actions. Mirrors the ACTION_DUPLICATE_CLEANUP_TOPIC
  // recognizer above: a pending action.create gets its own topic-scoped, wider confirm
  // vocabulary, and — since the real transcript's own confirm was itself compound — also runs a
  // trailing action.list request in the same turn, applying the pending create exactly once
  // either way.
  if (pending?.topic === "action_creation" && ACTION_CREATION_CONFIRM_RE.test(message)) {
    return finalizeActionCreationConfirmation(context, message);
  }

  // fix/private-alpha-launch-hardening-flakes-and-pending-clarity: an open capability-proposal
  // queue is handled ENTIRELY here, self-contained — a whole-queue confirm/cancel, a selective
  // reply naming exactly one proposal (by alias or index), or a queue-specific clarification for
  // anything else. Never falls through to the generic whitelist/planner/firewall below: an
  // ambiguous reply used to reach that generic "You still have a pending confirmation…" text (or
  // worse, the planner), rather than a clear list of the actual allowed replies. Checked before the
  // generic CONFIRM_WHITELIST below only so the whole-queue confirm/cancel below reuses the exact
  // same finalizers those generic paths already use — not a behavior difference, just keeping this
  // topic's whole flow in one place.
  if (pending?.topic === CAPABILITY_PROPOSALS_TOPIC) {
    const normalizedForCapabilityProposal = normalizeExactMessage(message);
    if (CONFIRM_WHITELIST.has(normalizedForCapabilityProposal) || looksLikeExtendedConfirmPhrase(normalizedForCapabilityProposal)) {
      return finalizeDeterministicConfirmation(context, message);
    }
    if (CANCEL_WHITELIST.has(normalizedForCapabilityProposal)) {
      return finalizeCapabilityProposalCancellation(context, message);
    }
    const matchingProposalIds = matchCapabilityProposalSelection(pending, message);
    if (matchingProposalIds.length === 1) {
      return finalizeCapabilityProposalSelection(context, message, matchingProposalIds);
    }
    // Ambiguous (nothing recognized, or more than one proposal named at once), or an out-of-range
    // index — never applies anything, never calls the planner to guess, and never clears the
    // queue: the next clear reply ("both"/"only Gmail"/"not now") still works exactly as it would
    // have on the very first turn.
    return finalizeCapabilityProposalClarification(context, pending);
  }

  // fix/private-alpha-goal-restore-ambiguity-resolution: an open restore-disambiguation ("several
  // archived goals match") is handled entirely here, self-contained — index/ordinal, exact title,
  // recency ("latest archived"/"the one archived today"), or "none"/"cancel". Never falls through
  // to the planner: a real live-trust bug found "the one archived today" and "none" both landing
  // on the generic firewall or a bare "nothing pending" reply, since the ambiguity question was
  // never actually stored as a real pending operation at all.
  if (pending?.topic === RESTORE_GOAL_DISAMBIGUATION_TOPIC) {
    const timezone = await getUserTimezone(context.session.userId);
    const resolution = matchGoalRestoreDisambiguation(pending, message, timezone);
    if (resolution.status === "cancel") {
      return finalizeDeterministicCancellation(context, message);
    }
    if (resolution.status === "resolved") {
      return finalizeGoalRestoreDisambiguationSelection(context, message, resolution.candidate, timezone);
    }
    // Unresolved — never guesses, never clears the clarification. The user already saw the full
    // numbered list once; a short reminder of the allowed replies is enough, not a full re-list.
    return finalizeGoalRestoreDisambiguationClarification(context, pending);
  }

  // fix/private-alpha-goal-guardrail-followup-keep-active: a real, open goal.archive_propose
  // confirmation (pause or archive) gets its own "keep it" cancel vocabulary — see
  // KEEP_GOAL_ACTIVE_EN_RE's own doc comment above for the real reported bug this closes.
  // "yes keep it" is a genuine contradiction (an affirmative opener paired with keep-language
  // that means the opposite) and must never be silently read as either — it always asks instead,
  // checked before the plain keep-language case so the contradiction can't accidentally match
  // that broader pattern first.
  if (pending?.topic === "goal_lifecycle") {
    const normalizedForGoalLifecycle = normalizeIntentText(message);
    const keepLanguage = detectKeepGoalActiveLanguage(normalizedForGoalLifecycle);
    if (keepLanguage && GOAL_LIFECYCLE_AFFIRMATIVE_OPENER_RE.test(normalizedForGoalLifecycle)) {
      return finalize(context, {
        reply: GOAL_LIFECYCLE_CONTRADICTION_CLARIFICATION,
        operationsPlanned: [],
        executedOps: [],
        plannerUsed: "none",
        llmPlannerAttempted: false,
        toolValidationPassed: true,
        topic: "goal_lifecycle"
      });
    }
    if (keepLanguage) {
      setPendingOperation(context.session, null);
      const reply = KEEP_GOAL_ACTIVE_REPLY[keepLanguage];
      return finalize(context, {
        reply,
        operationsPlanned: [],
        executedOps: [{ tool: "confirmation.cancel", status: "executed", summary: reply }],
        plannerUsed: "none",
        llmPlannerAttempted: false,
        toolValidationPassed: true,
        topic: "goal_lifecycle"
      });
    }
  }

  // fix/private-alpha-goal-guardrail-followup-keep-active: the OTHER real shape of the same bug —
  // no pending operation exists at all (the guardrail's own early-return never opens one), but the
  // guardrail intervened on the IMMEDIATELY PRECEDING turn (session.topic, overwritten by
  // finalize()'s setTopic on every turn, so this can only ever mean the turn right before this
  // one — same "immediately preceding" guarantee mostRecentTurnWasAMutation already relies on).
  // A false-alarm reply here must never reach the real planner at all — that's exactly how "im
  // kidding keep it" got misread as continuing a pause in the first place.
  if (!pending && context.session.topic === "guardrail") {
    const keepLanguage = detectKeepGoalActiveLanguage(normalizeIntentText(message));
    if (keepLanguage) {
      const reply = KEEP_GOAL_ACTIVE_REPLY[keepLanguage];
      return finalize(context, {
        reply,
        operationsPlanned: [],
        executedOps: [],
        plannerUsed: "none",
        llmPlannerAttempted: false,
        toolValidationPassed: true,
        topic: "goal_lifecycle"
      });
    }
  }

  // Exact confirm/cancel is checked FIRST and ALWAYS — regardless of whether a pending
  // operation exists — so a bare "yes"/"no" with nothing pending gets the deterministic
  // "nothing pending" reply instead of falling through to the LLM planner, which has been
  // observed to invent an unrelated action (e.g. listing Gmail rules) for a lone "yes".
  if (CONFIRM_WHITELIST.has(normalized) || looksLikeExtendedConfirmPhrase(normalized)) {
    if (pending) {
      return finalizeDeterministicConfirmation(context, message);
    }
    if (context.legacyPendingAction) {
      return finalizeLegacyPendingActionConfirm(context);
    }
    // A real Telegram transcript found "ok do it" right after a real mutation (e.g. moving an
    // action to tomorrow) got "I don't have anything pending to confirm." — technically true
    // (there was never a CONFIRMATION pending for that already-deterministic move) but reads as
    // if nothing happened at all. mostRecentTurnWasAMutation only fires when the assistant's own
    // immediately preceding reply really was reporting a mutation that just executed — never for
    // an older one, and never invents or re-runs anything.
    const recentMutation = mostRecentTurnWasAMutation(context.session);
    if (recentMutation) {
      return finalize(context, {
        reply: ALREADY_DONE_REPLY,
        operationsPlanned: [],
        executedOps: [{ tool: "confirmation.confirm", status: "skipped", summary: ALREADY_DONE_REPLY }],
        plannerUsed: "none",
        llmPlannerAttempted: false,
        toolValidationPassed: true,
        topic: context.session.topic ?? "actions"
      });
    }
    return finalizeNoPendingReply(context, "confirmation.confirm");
  }
  if (CANCEL_WHITELIST.has(normalized)) {
    if (pending) {
      return finalizeDeterministicCancellation(context, message);
    }
    if (context.legacyPendingAction) {
      return finalizeLegacyPendingActionCancel(context, context.legacyPendingAction);
    }
    // No v3 pendingOperation and no legacy PendingAction to cancel — but a "cancel" here still
    // safely resets any visible-entity context (e.g. a numbered action-hygiene list), so a
    // stray later "complete 1" can't resolve against stale state. action.hygiene_apply never
    // requires confirmation, so there is nothing to reject, only this defensive reset.
    clearAllVisibleEntities(context.session);
    return finalizeNoPendingReply(context, "confirmation.cancel");
  }

  // fix/private-alpha-conversation-kernel-context-routing (Part 4): "cancel, I mean X"/"no,
  // actually X" must cancel the pending operation AND route X in the SAME turn — a real reported
  // bug had this trapped behind "You still have a pending confirmation…" because only an EXACT
  // "cancel"/"no" (the whitelist check just above) is recognized at all; anything with trailing
  // text past the cancel word falls straight through to the pending-operation firewall further
  // down, which can only ever confirm/cancel/re-explain the SAME stale pending operation, never
  // reinterpret the message as something new. Persists the cancellation before recursing — the
  // recursive call reloads context fresh from DB, so the corrected request is never blocked by
  // the very pending operation this turn just cleared.
  if (pending) {
    const correctionMatch = message.trim().match(CANCEL_WITH_CORRECTION_RE);
    const remainder = correctionMatch ? message.trim().slice(correctionMatch[0].length).trim() : "";
    if (correctionMatch && remainder.length > 0) {
      setPendingOperation(context.session, null);
      await saveSession(context.session);
      return processAgentMessageInner({ ...request, message: remainder });
    }
  }

  const pendingGoalProposalBeingRefined =
    pending?.topic === "goal_creation" && GOAL_EDIT_LANGUAGE_RE.test(message.trim());
  if (UNSUPPORTED_GMAIL_ACTION_RE.test(message.trim()) && !pendingGoalProposalBeingRefined) {
    // Deliberately does not touch pendingOperation: an unrelated, unsupported
    // request must not silently cancel or continue an unrelated pending flow.
    return finalize(context, {
      reply: UNSUPPORTED_GMAIL_ACTION_REPLY,
      operationsPlanned: [],
      executedOps: [],
      plannerUsed: "none",
      llmPlannerAttempted: false,
      toolValidationPassed: true,
      topic: "gmail_unsupported_action"
    });
  }

  // Checked before EVERY Gmail-domain shortcut below (see this function's own doc comment for the
  // real reported bug) — a pending action.create proposal's own refinement always wins; Gmail
  // help is folded into the SAME reply when relevant, never left to hijack the whole turn.
  const pendingActionRefinement = await pendingActionRefinementResponse(context, message);
  if (pendingActionRefinement) {
    return pendingActionRefinement;
  }

  const gmailGoalUsageStatus = await gmailGoalUsageStatusResponse(context, message);
  if (gmailGoalUsageStatus) {
    return gmailGoalUsageStatus;
  }

  // fix/private-alpha-conversation-kernel-context-routing: checked BEFORE every other Gmail/action
  // shortcut below — a real reported bug had "remove all as I already counted them" (Gmail reviews
  // the ONLY thing just shown) route to action.archive_all_propose instead (bulkActionCleanupShort
  // cutOperation's own `hasVisibleActions` check only asks "does ANY action entity exist somewhere
  // in visibleEntities," never "is that actually the surface being talked about" — a stale action
  // entity from much earlier in the conversation was enough to win), and a follow-up "remove all
  // mail reviews" route to gmail.disconnect_propose instead (GMAIL_DISCONNECT_RE matches
  // "remove...mail" with no idea "mail reviews" means the review QUEUE, not the account). Checked
  // here, gated on !pending same as the other confirmation-relevant shortcuts, so a genuinely
  // Gmail-review-scoped bulk instruction always wins the race over both.
  const gmailReviewBulkTriageResponse = !pending ? await gmailReviewBulkTriageShortcut(message, context) : undefined;
  if (gmailReviewBulkTriageResponse) {
    return gmailReviewBulkTriageResponse;
  }

  // fix/private-alpha-gmail-review-quality-and-dedupe (Task 7): checked right after the plain
  // "remove all reviews" bulk shortcut above — a category-scoped bulk command ("ignore the noise",
  // "log the application confirmations") only ever touches the ONE category the user named, never
  // every visible review, so it needs its own narrower match on top of formatGmailReviewListForChat's
  // own confirmation/needs_review/noise grouping (email-review-service.ts's
  // gmailReviewPresentationCategory) rather than the blanket bulk-reject path above.
  const gmailReviewCategoryBulkResponse = !pending ? await gmailReviewCategoryBulkShortcut(message, context) : undefined;
  if (gmailReviewCategoryBulkResponse) {
    return gmailReviewCategoryBulkResponse;
  }

  // fix/private-alpha-gmail-review-llm-instruction-routing: checked BEFORE gmail.sync — a real
  // reported bug had "I wanna disconnect my mail and connect a new one" (unambiguous
  // disconnect/switch intent) matched by gmailSyncShortcutOperation's own bare "mail...new"
  // disjunct instead, running a full sync when the user never asked for one. Account-lifecycle
  // intent (disconnect/switch) always outranks a plain sync/check request — a message can only
  // mean one or the other, and "disconnect"/"switch accounts" is the far more specific, far less
  // reversible-sounding of the two. Gated on !pending, same reasoning as the other confirmation-
  // opening shortcuts below. Switch is checked BEFORE plain disconnect: "disconnect my mail and
  // connect a new one" satisfies GMAIL_DISCONNECT_RE too (it does say "disconnect... mail"), but
  // it also explicitly asks to reconnect a new one — strictly more specific than a bare
  // disconnect, so it must win the race, not get truncated into "disconnect and stop" alone.
  const gmailSwitchAccountShortcut = !pending ? gmailSwitchAccountShortcutOperation(message) : undefined;
  if (gmailSwitchAccountShortcut) {
    return finalizeDeterministicOperation(context, message, gmailSwitchAccountShortcut, "gmail_switch_account");
  }

  const gmailDisconnectShortcut = !pending ? gmailDisconnectShortcutOperation(message) : undefined;
  if (gmailDisconnectShortcut) {
    return finalizeDeterministicOperation(context, message, gmailDisconnectShortcut, "gmail_disconnect");
  }

  const gmailSyncDebugShortcut = gmailSyncDebugShortcutOperation(message);
  if (gmailSyncDebugShortcut) {
    return finalizeDeterministicOperation(context, message, gmailSyncDebugShortcut, "gmail_sync_debug");
  }

  // refactor/private-alpha-general-email-intelligence-workflow: "sync mail and review" (this
  // branch's own acceptance-test phrasing) — a real sync followed immediately by the grouped
  // summary in the SAME turn, rather than requiring a separate follow-up "show email reviews".
  // Checked ahead of the plain sync shortcut below, which explicitly bails out on any message
  // containing "review(s)" (deferring to the review-queue shortcuts instead) — that guard exists
  // for "refresh email reviews" (queue-only, no real sync), not for a genuine "sync AND review"
  // compound request, which needs its own explicit handling here.
  const gmailSyncAndReviewShortcut = gmailSyncAndReviewShortcutOperation(message);
  if (gmailSyncAndReviewShortcut) {
    return finalizeDeterministicOperations(context, message, gmailSyncAndReviewShortcut, "gmail_reviews");
  }

  const gmailSyncShortcut = gmailSyncShortcutOperation(message);
  if (gmailSyncShortcut) {
    return finalizeDeterministicOperation(context, message, gmailSyncShortcut, "gmail_sync");
  }

  const gmailBuiltInRuleShortcut = gmailBuiltInRuleEnableShortcutOperation(message, context);
  if (gmailBuiltInRuleShortcut) {
    return finalizeDeterministicOperation(context, message, gmailBuiltInRuleShortcut, "gmail_rule_management");
  }

  const gmailReviewListAndStatusCompound = gmailReviewListAndAutonomyStatusCompoundShortcutOperations(message, context);
  if (gmailReviewListAndStatusCompound.length > 0) {
    return finalizeDeterministicOperations(context, message, gmailReviewListAndStatusCompound, "gmail_reviews");
  }

  const gmailReviewListShortcut = gmailReviewListShortcutOperation(message, context);
  if (gmailReviewListShortcut) {
    return finalizeDeterministicOperation(context, message, gmailReviewListShortcut, "gmail_reviews");
  }

  const gmailReviewInspectShortcut = gmailReviewInspectShortcutOperation(message, context);
  if (gmailReviewInspectShortcut) {
    return finalizeDeterministicOperation(context, message, gmailReviewInspectShortcut, "gmail_reviews");
  }

  const reminderListShortcut = actionReminderListShortcutOperation(message);
  if (reminderListShortcut) {
    return finalizeDeterministicOperation(context, message, reminderListShortcut, "actions");
  }

  const meetingListShortcut = actionMeetingListShortcutOperation(message);
  if (meetingListShortcut) {
    return finalizeDeterministicOperation(context, message, meetingListShortcut, "actions");
  }

  // Deterministic, not left to the planner's judgment — a real Telegram smoke test found "delete
  // all my actions" and "archive all of them" BOTH treated as a literal action TITLE to search
  // for ("I don't see an open action called 'Delete all my actions'"), three turns in a row. This
  // never touches the actual archive; it only recognizes the INTENT and opens the same
  // action.archive_all_propose confirmation flow a direct planner call would.
  const bulkActionCleanupShortcut = !pending ? bulkActionCleanupShortcutOperation(message, context) : undefined;
  if (bulkActionCleanupShortcut) {
    return finalizeDeterministicOperation(context, message, bulkActionCleanupShortcut, "actions");
  }

  const gmailConnectionShortcut = gmailConnectionShortcutOperation(message, context);
  if (gmailConnectionShortcut) {
    return finalizeDeterministicOperation(context, message, gmailConnectionShortcut, "gmail_status");
  }

  const gmailAutonomyStatusShortcut = gmailAutonomyStatusShortcutOperation(message);
  if (gmailAutonomyStatusShortcut) {
    return finalizeDeterministicOperation(context, message, gmailAutonomyStatusShortcut, "gmail_autonomy");
  }

  const gmailNudgeSettingsShortcut = !pending ? gmailNudgeSettingsShortcutOperation(message) : undefined;
  if (gmailNudgeSettingsShortcut) {
    return finalizeDeterministicOperation(context, message, gmailNudgeSettingsShortcut, "proactive_settings");
  }

  // Checked deterministically, BEFORE the goal-avoidance guardrail below — a real Telegram smoke
  // test found "pause my Meditations goal" and "remove the meditations goal" both intercepted as
  // avoidance/lapse of that very goal, since the guardrail ran on every message before goal
  // lifecycle tools (goal.archive_propose) ever got a chance to run through the LLM planner.
  // "Pause/archive/remove/delete THIS GOAL" is an operational goal-MANAGEMENT command, not an
  // avoidance event about the goal's underlying activity — exactly the same class of fix as the
  // Gmail domain shortcuts above (see the comment ahead of the guardrail check below).
  const goalLifecycleShortcut = await goalLifecycleShortcutOperation(message, context);
  if (goalLifecycleShortcut) {
    return finalizeDeterministicOperation(context, message, goalLifecycleShortcut, "goal_lifecycle");
  }

  // fix/private-alpha-action-archive-targeting: a real live-trust bug found "restore the goal
  // 'X'" — asked right after that exact goal had been mistakenly archived — routed through the
  // real LLM planner to goal.create_propose, offering to create a brand-new goal instead of
  // recognizing "restore" as recovering the one that already existed (goal.create_apply's own
  // duplicate check only ever looks at ACTIVE goals, so an archived one is genuinely invisible to
  // it — nothing downstream could have caught this). Checked deterministically, BEFORE the planner
  // ever runs, for the same reason goalLifecycleShortcut above is: restore/unarchive/reactivate
  // intent must never be left to the planner's own judgment call between "manage an existing goal"
  // and "describe a new one."
  const goalRestoreShortcut = goalRestoreShortcutOperation(message);
  if (goalRestoreShortcut) {
    return finalizeDeterministicOperation(context, message, goalRestoreShortcut, "goal_restore");
  }

  // fix/private-alpha-email-progress-count-and-review-ux (Task 4): a real reported bug — "how many
  // CVs did I send today?" and "show today goal progress" answered weekly-only, or (worse, caught
  // via real-planner reproduction while investigating) sometimes got planned as goal.log_evidence,
  // a MUTATING tool, purely because the message mentions a count and "today" — the planner reading
  // a QUESTION about today's count as a STATEMENT that progress just happened. Routed
  // deterministically to the read-only goal.status(scope: "today") BEFORE the planner ever sees it,
  // exactly the same reasoning as goalLifecycleShortcut/goalRestoreShortcut above. Never matches a
  // genuine logging statement ("I sent 3 CVs today") — every branch requires an actual question
  // shape (how many / today progress / cuántos.../quants...), not just the word "today".
  const goalTodayProgressShortcut = goalTodayProgressShortcutOperation(message);
  if (goalTodayProgressShortcut) {
    return finalizeDeterministicOperation(context, message, goalTodayProgressShortcut, "goal_status");
  }

  if (!pending) {
    // Checked before actionCompletionShortcutOperation below: "move it later this week"/"bring it
    // back later this week"-shaped messages have a real deferral verb but NO actual day named, so
    // extractNaturalDueTextFromMessage can't produce an untilText for them — the concrete-date
    // shortcut below would just decline and let the message fall all the way through to the
    // goal-avoidance guardrail (the exact reported bug: "snooze it for later this week" read as
    // avoidance). Asking which day, deterministically, keeps this out of the guardrail entirely
    // AND out of the LLM planner (which has no reliable way to guess a specific day either).
    const actionDeferralWeekClarification = await actionDeferralAmbiguousWeekClarification(message, context);
    if (actionDeferralWeekClarification) {
      return finalize(context, {
        reply: actionDeferralWeekClarification,
        operationsPlanned: [],
        executedOps: [],
        plannerUsed: "none",
        llmPlannerAttempted: false,
        toolValidationPassed: true,
        topic: "actions"
      });
    }

    // Checked FIRST, ahead of every Gmail-review shortcut: a bare "complete it"/"done"/"archive
    // it"/"snooze it tomorrow" right after the worker sends a due-action notification is a real,
    // reported failure mode otherwise — the real LLM planner has nothing but session.visibleEntities
    // to go on, and that can be stuck pointing at an already-decided Gmail review (rejecting a
    // review with an empty "remaining" list never clears it — see applyExecutionSideEffects — so
    // the LAST thing shown stays "visible" even after the user acted on it), producing exactly the
    // observed bug: "complete it" tried to re-decide an already-rejected email review instead of
    // completing the task the worker had just reminded them about. This resolves deterministically
    // BEFORE the planner ever sees the message, so that stale context can never cause a wrong tool
    // choice for this specific, unambiguous, high-value pattern. Only ever targets a real
    // ActionItem — see actionCompletionShortcutOperation's own explicit "no email/review wording"
    // guard for why a Gmail review is never in scope here at all.
    const actionCompletionShortcut = await actionCompletionShortcutOperation(message, context);
    if (actionCompletionShortcut) {
      return finalizeDeterministicOperation(context, message, actionCompletionShortcut, "actions");
    }

    // Checked ahead of the pure-review-only shortcuts below: only ever produces operations when
    // the message ALSO contains a Gmail sync-frequency request ("check email sync every 1h") —
    // a message with none returns [] immediately and falls through unchanged. Handles the
    // reported compound transcript ("delete it nothing important, and can u check email sync
    // every 1h?") as ONE turn: the visible review really gets rejected AND the sync-schedule
    // proposal really opens, rather than one silently overwriting or dropping the other.
    const gmailAutonomyCompoundShortcuts = gmailAutonomyCompoundShortcutOperations(message, context);
    if (gmailAutonomyCompoundShortcuts.length > 0) {
      return finalizeDeterministicOperations(context, message, gmailAutonomyCompoundShortcuts, "gmail_autonomy");
    }

    // fix/private-alpha-gmail-review-llm-instruction-routing (Task 2): computed ONCE, before
    // either deterministic review-triage extractor below — a real reported bug had "1 is a real
    // recruiter reply, reject 2" silently DROP the "1 is a recruiter reply" half entirely: the old
    // extractor found a partial match ("reject 2") and both call sites below claimed victory on
    // ANY non-empty result, never checking whether it covered every number the message actually
    // mentioned. Now computed up front — when any mentioned review number has no confident
    // deterministic entry, BOTH narrow extractors below are skipped entirely and the LLM-backed
    // parser (which sees the whole message at once) handles it instead, rather than one silently
    // acting on half a message.
    const gmailReviewVisibleEntities = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");
    const gmailReviewNeedsLLMInstruction = gmailReviewInstructionNeedsLLMParsing(message, gmailReviewVisibleEntities);

    // fix/private-alpha-email-review-detail-and-general-mail-understanding (Part 2/8): checked
    // ahead of every triage shortcut below — "details for 3"/"why is 3 noise" is never a reject/
    // keep/approve instruction, and a bare "ignore this"/"approve this" right after a detail view
    // must resolve to the review just detailed, not fall through to the generic numbered-ref
    // extractors below (which have no number/named-subject to match against a bare pronoun anyway).
    // A detail-shaped message with NO review list currently visible asks the user to list reviews
    // first, rather than falling through to the real planner with nothing grounded to act on.
    if (gmailReviewVisibleEntities.length === 0 && GMAIL_REVIEW_DETAIL_TRIGGER_RE.test(normalizeIntentText(message))) {
      return finalize(context, {
        reply: 'I don\'t have any Gmail reviews in view right now. Say "show me my email reviews" first, then I can show details for one.',
        operationsPlanned: [],
        executedOps: [],
        plannerUsed: "none",
        llmPlannerAttempted: false,
        toolValidationPassed: true,
        topic: "gmail_reviews"
      });
    }

    // refactor/private-alpha-canonical-progress-command-engine (Task 4): a real reported bug —
    // "details for an application confirmation from today" fell all the way through to the
    // last-focused-review fallback below (no number, no strong label-token match) and silently
    // opened a STALE, unrelated review instead of respecting the classification/date filter the
    // user actually named. Checked BEFORE the plain label/number/focus resolution below — only ever
    // engages when the message both looks like a detail request AND names a recognizable
    // classification/date filter; a plain "details for 3" or "show the Okify application" never
    // matches here and falls through unchanged.
    const semanticSelection = await gmailReviewSemanticReferenceOperation(message, context);
    if (semanticSelection) {
      if (semanticSelection.reply) {
        return finalize(context, {
          reply: semanticSelection.reply,
          operationsPlanned: [],
          executedOps: [],
          plannerUsed: "none",
          llmPlannerAttempted: false,
          toolValidationPassed: true,
          topic: "gmail_reviews"
        });
      }
      if (semanticSelection.operations.length > 0) {
        return finalizeDeterministicOperations(context, message, semanticSelection.operations, "gmail_reviews");
      }
    }

    const gmailReviewDetailShortcuts = gmailReviewDetailShortcutOperation(message, context);
    if (gmailReviewDetailShortcuts.length > 0) {
      return finalizeDeterministicOperations(context, message, gmailReviewDetailShortcuts, "gmail_reviews");
    }

    // fix/private-alpha-email-review-resolution-and-stale-classification (Task 2): checked ahead of
    // gmailReviewThisFollowupShortcutOperation below — "count this as a CV sent"/"mark 2 as a CV
    // sent" would otherwise either match that function's much looser approve/count/log regex (and
    // silently log whatever the review's OWN stale classification says instead of what the user just
    // explicitly stated) or, for "mark ...", not match anything there at all and fall through to the
    // real planner with no review-linking tool available (the exact live-reported bug: progress got
    // logged via event.log_job_applications while the review it came from stayed pending forever).
    // refactor/private-alpha-general-email-intelligence-workflow (Task 5): bulk count commands —
    // checked ahead of the single-review mark-progress shortcut below, since "count all
    // applications"/"1,2,3,4,6 are cvs i sent" name MULTIPLE items at once, which that shortcut's
    // single-index resolution was never designed for.
    const gmailReviewBulkCountShortcut = gmailReviewBulkCountShortcutOperation(message, context);
    if (gmailReviewBulkCountShortcut) {
      return finalizeDeterministicOperations(context, message, [gmailReviewBulkCountShortcut], "gmail_reviews");
    }

    const gmailReviewMarkProgressShortcuts = gmailReviewMarkProgressShortcutOperation(message, context);
    if (gmailReviewMarkProgressShortcuts.length > 0) {
      return finalizeDeterministicOperations(context, message, gmailReviewMarkProgressShortcuts, "gmail_reviews");
    }

    if (GMAIL_REVIEW_REFRESH_RE.test(normalizeIntentText(message))) {
      return finalizeDeterministicOperations(
        context,
        message,
        [{ tool: "gmail.review.refresh", args: {}, rationale: "user asked to refresh/recheck stale email review classifications" }],
        "gmail_reviews"
      );
    }

    const gmailReviewThisFollowupShortcuts = gmailReviewThisFollowupShortcutOperation(message, context);
    if (gmailReviewThisFollowupShortcuts.length > 0) {
      return finalizeDeterministicOperations(context, message, gmailReviewThisFollowupShortcuts, "gmail_reviews");
    }

    if (!gmailReviewNeedsLLMInstruction) {
      const gmailReviewTriageShortcuts = gmailReviewExplicitTriageShortcutOperations(message, context);
      if (gmailReviewTriageShortcuts.length > 0) {
        return finalizeDeterministicOperations(context, message, gmailReviewTriageShortcuts, "gmail_reviews");
      }

      const gmailReviewToActionShortcuts = gmailReviewToActionShortcutOperations(message, context);
      if (gmailReviewToActionShortcuts.length > 0) {
        return finalizeDeterministicOperations(context, message, gmailReviewToActionShortcuts, "gmail_reviews");
      }
    }

    // Checked after every cheap, fully-confident deterministic review-triage shortcut above has
    // had first chance to resolve the message on its own — this only ever fires for the messages
    // those couldn't already handle cleanly (a real network+LLM call, so it's deliberately not
    // tried first).
    const gmailReviewInstructionLLMResponse = gmailReviewNeedsLLMInstruction
      ? await gmailReviewInstructionLLMShortcut(message, context, gmailReviewVisibleEntities)
      : undefined;
    if (gmailReviewInstructionLLMResponse) {
      return gmailReviewInstructionLLMResponse;
    }

    const gmailReviewVagueClarification = gmailReviewVagueMutationClarification(message, context);
    if (gmailReviewVagueClarification) {
      logAgentRuntimeDiagnostics({
        phase: "ambiguous_mutation_blocked",
        userId,
        note: "vague Gmail-review instruction with no specific intent — clarification asked instead of guessing"
      });
      return finalize(context, {
        reply: gmailReviewVagueClarification,
        operationsPlanned: [],
        executedOps: [],
        plannerUsed: "none",
        llmPlannerAttempted: false,
        toolValidationPassed: true,
        topic: "gmail_reviews"
      });
    }

    const actionTimeCorrectionShortcut = actionTimeCorrectionShortcutOperation(message, context);
    if (actionTimeCorrectionShortcut) {
      return finalizeDeterministicOperation(context, message, actionTimeCorrectionShortcut, "actions");
    }

    const preDueReminderShortcut = preDueReminderShortcutOperation(message, context);
    if (preDueReminderShortcut) {
      return finalizeDeterministicOperation(context, message, preDueReminderShortcut, "actions");
    }
  }

  // A legacy PendingAction (from a slash-command flow like /action_hygiene or a Gmail rule
  // proposal) still lives entirely in server.ts's legacy resolver — v3 has no tool that can
  // safely execute it (applyPendingAction is entangled with Gmail-rule/action-hygiene helpers
  // that aren't safely importable here). v3's own pendingOperation always takes precedence
  // (handled above); only once that's empty do we check for a legacy one. Explicit Gmail
  // connect/reconnect/alert requests above are safe read-only/proposal flows and must not be
  // swallowed by stale legacy pending state; everything else deflects before the planner.
  if (!pending && context.legacyPendingAction) {
    return finalizeLegacyPendingActionAmbiguous(context, context.legacyPendingAction);
  }

  if (pending) {
    const pendingGmailRule = pending.operations.find((op) => op.tool === "gmail.rule.create");
    if (pendingGmailRule && GMAIL_PENDING_NOTIFICATION_FOLLOWUP_RE.test(message.trim())) {
      const label = String(pendingGmailRule.args.label ?? "this");
      return finalize(context, {
        reply: `I can notify you when a manual or scheduled Gmail check creates a review for ${label}. This is not instant email arrival tracking. Matches go to email reviews first. Confirm creating this rule?`,
        operationsPlanned: [],
        executedOps: [],
        plannerUsed: "none",
        llmPlannerAttempted: false,
        toolValidationPassed: true,
        topic: pending.topic
      });
    }
  }

  // Checked before the goal-anchor nudge and gated on !pending, same reasoning as the other
  // deterministic shortcuts above: an explicit setup request is a clear, unambiguous instruction
  // that must not be swallowed by an unrelated open confirmation, but also must not fight one.
  if (!pending && ONBOARDING_SETUP_REQUEST_RE.test(message.trim())) {
    return finalize(context, {
      reply: ONBOARDING_SETUP_REPLY,
      operationsPlanned: [],
      executedOps: [],
      plannerUsed: "none",
      llmPlannerAttempted: false,
      toolValidationPassed: true,
      topic: "operator_onboarding"
    });
  }

  if (shouldShowGoalAnchorNudge(context, message)) {
    return finalize(context, {
      reply: GOAL_ANCHOR_NUDGE_REPLY,
      operationsPlanned: [],
      executedOps: [],
      plannerUsed: "none",
      llmPlannerAttempted: false,
      toolValidationPassed: true,
      topic: "goal_anchor_nudge"
    });
  }

  // Checked here — AFTER every deterministic domain shortcut above (Gmail sync/autonomy/status/
  // alerts/reviews, action completion/snooze/archive, reminders, proactive settings) — rather
  // than as the very first thing in the turn. A real smoke test found "check gmail every hour"
  // classified as "avoidance" of an unrelated active reading goal, purely because the guardrail's
  // LLM tier ran on literally every message before anything else got a chance to recognize it as
  // a plain operational command. Goal-avoidance is only a meaningful question for a message that
  // ISN'T already a clear, unambiguous domain action — exactly the set of messages that reach
  // this point without an earlier shortcut having already handled them. This never widens what
  // the guardrail blocks, only narrows which messages are even offered to it.
  // fix/private-alpha-goal-avoidance-action-bypass: explicit action-management language ("move it,"
  // "muévela," "canvia-la") is never itself a signal of goal avoidance — see
  // isExplicitActionMutationGuardrailBypass's own doc comment for the real reported bug this
  // closes. Skips ONLY the guardrail LLM call; the real planner, validator, and execution pipeline
  // below run exactly as they would for any other allowed message, so this can never let an LLM
  // mutate state directly, and any goal-abandonment wording in the same message unconditionally
  // disqualifies the bypass.
  const actionMutationBypassesGuardrail = isExplicitActionMutationGuardrailBypass(message, context);
  logAgentRuntimeDiagnostics({
    phase: "guardrail_check",
    userId,
    note: actionMutationBypassesGuardrail
      ? "explicit action-mutation command with a resolvable action target — goal-avoidance guardrail bypassed"
      : "no domain shortcut matched; message reaches goal-avoidance guardrail"
  });
  const guardrail = actionMutationBypassesGuardrail ? ACTION_MUTATION_GUARDRAIL_BYPASS_RESULT : await checkGoalGuardrail(message, context);
  if (guardrail.decision !== "allow") {
    // hard_block/soft_warn are real, detected conflicts worth a durable trace (feeds existing
    // insight/daily-review pipelines that already read risk_pattern memories); ask_clarification
    // is not — nothing was actually confirmed yet, so nothing is logged.
    const executedOps: ExecutedOperation[] =
      guardrail.decision === "hard_block" || guardrail.decision === "soft_warn" ? [await logGuardrailIncident(userId, message, guardrail)] : [];
    applyExecutionSideEffects(context.session, executedOps);
    return finalize(context, {
      reply: guardrail.reply ?? "Let's pause here for a moment.",
      operationsPlanned: [],
      executedOps,
      plannerUsed: "none",
      llmPlannerAttempted: guardrail.llmAttempted,
      toolValidationPassed: true,
      topic: "guardrail"
    });
  }

  const { plan, plannerUsed } = await planMessage(message, context);
  const gmailReconciledOperations = reconcileExplicitGmailReviewIntentOperations(message, context, plan.operations);
  const reconciledOperations = applyCoachFirstResponseRouting(message, context, gmailReconciledOperations);

  const validatedOps = validateOperations(reconciledOperations, context, message);
  const toolValidationPassed = validatedOps.every((op) => op.status !== "invalid" && op.status !== "unsupported");
  const explicitReviewIntentPlan = buildExplicitGmailReviewIntentPlan(message, context);
  logAgentRuntimeDiagnostics({
    phase: "validated_operations",
    userId,
    plannerOps: plan.operations,
    explicitReviewIntentMap: explicitReviewIntentPlan?.entries,
    finalOps: reconciledOperations,
    validatedOps,
    mutationTools: validatedOps.filter((op) => op.status === "valid" && getToolDefinition(op.tool)?.mutates).map((op) => op.tool)
  });

  // Pending-operation firewall: while a mutation is awaiting confirmation, no OTHER mutation
  // may run — not even a fresh, unrelated one, and not even a re-ask of the same one. This is
  // checked on the raw validated ops (any status), so it also blocks a plan that tries to
  // re-propose gmail.rule.create instead of emitting a genuine confirmation. Excludes a plain
  // ACTION_CLARIFICATION_TOPIC marker whose own stored operations are just the inert
  // clarification.ask stub — nothing there to actually confirm, so it must never block an
  // unrelated request the way a real yes/no confirmation does. Does NOT exclude one carrying a
  // real suggestedConfirmOperation ("Did you mean X? Reply yes...") — that DOES have something
  // real to protect (a bare "yes" must still complete/archive/snooze the suggested candidate) —
  // EXCEPT an explicit numbered action command ("complete action 10 and 9 now") right on top of
  // it, which a real Telegram smoke test found getting stuck blocked behind a stale suggestion
  // indefinitely. An explicit number is a clear, unambiguous instruction of its own — it always
  // supersedes/replaces a pending action-reference question rather than needing an explicit
  // "cancel" first; validateOperations's own explicit-index check (which runs regardless of any
  // pending operation) still decides on its own merits whether those numbers actually resolve.
  const pendingHasRealMutation = pending?.operations.some((op) => getToolDefinition(op.tool)?.mutates === true) ?? false;
  const explicitNumberedCommandSupersedesPending =
    pending?.topic === ACTION_CLARIFICATION_TOPIC && /\d/.test(message) && reconciledOperations.some((op) => ACTION_CLARIFICATION_ELIGIBLE_TOOLS.has(op.tool));
  if (explicitNumberedCommandSupersedesPending) {
    setPendingOperation(context.session, null);
  }
  if (
    !explicitNumberedCommandSupersedesPending &&
    pending &&
    (pending.topic !== ACTION_CLARIFICATION_TOPIC || pendingHasRealMutation) &&
    validatedOps.some((op) => getToolDefinition(op.tool)?.mutates === true)
  ) {
    return finalize(context, {
      reply: `You still have a pending confirmation for ${pending.summary}. Confirm, cancel, or tell me a new request.`,
      operationsPlanned: reconciledOperations,
      executedOps: [],
      plannerUsed,
      llmPlannerAttempted: true,
      toolValidationPassed,
      topic: pending.topic
    });
  }

  const metaOps = validatedOps.filter((op) => META_TOOLS.has(op.tool) && op.status === "valid");
  const referenceClarifications = validatedOps.filter((op) => op.status === "needs_clarification");
  const pendingConfirmationOps = validatedOps.filter((op) => op.status === "needs_confirmation");
  const problemOps = validatedOps.filter((op) => op.status === "invalid" || op.status === "unsupported");
  let executableOps = validatedOps.filter((op) => op.status === "valid" && !META_TOOLS.has(op.tool));

  // Multi-action archive guard: a real Telegram smoke test found "archive 1 and 2" replying
  // "Archiving the actions X and Y" (the planner's own optimistic replyDraft) while both actions
  // stayed open afterward — a single action.archive still runs immediately (unconfirmed, matching
  // existing UX for the common case), but TWO OR MORE in the same turn — whether from explicit
  // numbers ("archive 1 and 2", already resolved to real ids by resolveExplicitActionIndexReferences
  // above) or the bulk-cleanup shortcut below — are collapsed into a single action.archive_all_propose
  // op instead, which shows the real numbered list and requires an explicit confirmation before
  // anything is archived. This also sidesteps the overclaim risk structurally: action.archive_all_
  // propose/apply are both GROUND_TRUTH_ONLY_TOOLS, so their reply always reflects real execution.
  const validArchiveOps = executableOps.filter((op) => op.tool === "action.archive");
  if (validArchiveOps.length > 1) {
    const actionIds = validArchiveOps.map((op) => String(op.args.actionId));
    executableOps = [
      ...executableOps.filter((op) => op.tool !== "action.archive"),
      { tool: "action.archive_all_propose", args: { actionIds }, status: "valid", requiresConfirmation: false }
    ];
    logAgentRuntimeDiagnostics({
      phase: "multi_archive_collapsed_to_confirmation",
      userId,
      note: `collapsed ${validArchiveOps.length} action.archive ops into action.archive_all_propose`
    });
  }

  // Compound-proposal guard: session.pendingOperation is a single field, so if the planner plans
  // TWO proposal-shaped tools in one turn (e.g. goal.create_propose alongside proactive.settings_
  // propose_update — a real Telegram smoke test found the planner doing exactly this for "I want
  // daily checking and motivation" arriving in the same message as a new goal), executing both
  // would silently overwrite the first's confirmability with the second's, while the reply still
  // shows both "Want me to...?" questions — a confusing double confirmation the runtime can't
  // actually honor. Only the first is executed; goal.create_propose wins when it's one of the
  // two, since creating the goal is the primary intent of a message shaped like this. The other
  // is dropped from THIS turn entirely (never executed, never shown as a pending confirmation)
  // and a short note is appended to the reply instead, so the user's second request is
  // acknowledged, not silently lost — see deferredProposalNote below.
  const proposalOps = executableOps.filter((op) => getToolDefinition(op.tool)?.opensPendingProposal === true);
  let deferredProposalNote: string | undefined;
  if (proposalOps.length > 1) {
    const kept = proposalOps.find((op) => op.tool === "goal.create_propose") ?? proposalOps[0];
    const dropped = proposalOps.filter((op) => op !== kept);
    executableOps = executableOps.filter((op) => !dropped.includes(op));
    deferredProposalNote = "I'll ask you about that next, once this is confirmed.";
    logAgentRuntimeDiagnostics({
      phase: "compound_proposal_deferred",
      userId,
      note: `kept ${kept.tool}, deferred ${dropped.map((op) => op.tool).join(", ")}`
    });
  }

  const topic = resolveTopic(reconciledOperations, plan.topic, context.session.topic);

  let executedOps: ExecutedOperation[] = [];
  let clarificationQuestion: string | undefined;

  const askMeta = metaOps.find((op) => op.tool === "clarification.ask");

  // Deliberately does NOT trust an LLM-emitted confirmation.confirm/cancel here — live
  // testing showed the model can over-eagerly treat an unrelated follow-up as a confirmation.
  // The exact whitelist check above is the ONLY path that can confirm/cancel.

  if (askMeta) {
    clarificationQuestion = String(askMeta.args.question ?? "Could you clarify what you mean?");
  } else {
    executedOps = await Promise.all(executableOps.map((op) => executeOperation(userId, op, context, message)));
    applyExecutionSideEffects(context.session, executedOps);
    logAgentRuntimeDiagnostics({
      phase: "executed_operations",
      userId,
      finalOps: reconciledOperations,
      validatedOps,
      mutationTools: executedOps.filter((op) => op.status === "executed" && getToolDefinition(op.tool)?.mutates).map((op) => op.tool)
    });

    // pendingConfirmationOps can only be non-empty here when `pending` was null (the firewall
    // above already returned for any mutation attempt while a pending operation exists).
    if (pendingConfirmationOps.length > 0) {
      const summary = summarizePendingOperations(pendingConfirmationOps);
      setPendingOperation(context.session, createPendingOperationRecord(topic, summary, pendingConfirmationOps));
    }

    if (referenceClarifications.length > 0) {
      clarificationQuestion = referenceClarifications[0]?.clarificationQuestion;
      markActionClarificationPendingIfNeeded(context.session, validatedOps, clarificationQuestion);
    }
  }

  // A real RC smoke run caught this: the planner sometimes plans ONLY an untrusted
  // confirmation.confirm/confirmation.cancel (e.g. for "no cancel that," which isn't an exact
  // CANCEL_WHITELIST phrase) with a replyDraft written as if it had already taken effect ("I've
  // canceled the creation of..."). Since that meta op is never actually executed (see the comment
  // above), executedOps stays empty and composeReply would otherwise show that false claim
  // verbatim while the real pending operation is still untouched — the honest "still pending"
  // reply already used by the firewall above is reused here instead, whatever replyDraft claimed.
  const untrustedConfirmOrCancelOnly =
    !askMeta &&
    executedOps.length === 0 &&
    !clarificationQuestion &&
    pending !== null &&
    metaOps.some((op) => op.tool === "confirmation.confirm" || op.tool === "confirmation.cancel");

  const reply = untrustedConfirmOrCancelOnly
    ? `That didn't match an exact yes/no, so nothing changed. You still have a pending confirmation for ${pending!.summary}. Reply with an exact "yes"/"cancel" to confirm or cancel it.`
    : [
        composeReply({
          replyDraft: plan.replyDraft,
          clarificationQuestion,
          pendingConfirmationOps,
          executedOps,
          problemOps
        }),
        deferredProposalNote
      ]
        .filter(Boolean)
        .join("\n\n");
  logCompoundTurnDiagnostics(userId, reconciledOperations, executedOps, context.session.pendingOperation !== null, reply);

  const plannedPlanningOp = reconciledOperations.find((op) => isPlanningTool(op.tool));
  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: plannedPlanningOp,
      validatedOp: validatedOps.find((op) => isPlanningTool(op.tool)),
      executedOp: executedOps.find((op) => isPlanningTool(op.tool)),
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: inferComposerSource({ clarificationQuestion, pendingConfirmationOps, executedOps, problemOps, replyDraft: plan.replyDraft })
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: reconciledOperations,
    executedOps,
    plannerUsed,
    llmPlannerAttempted: true,
    toolValidationPassed,
    topic,
    planningTrace
  });
}

function normalizeExactMessage(message: string): string {
  return message.trim().toLowerCase().replace(/[.!]+$/, "");
}

async function finalizeDeterministicOperation(
  context: ContextBundle,
  message: string,
  plannedOperation: PlannedOperation,
  topic: string
): Promise<AgentMessageResponse> {
  logAgentRuntimeDiagnostics({
    phase: "domain_shortcut_matched",
    userId: context.session.userId,
    finalOps: [plannedOperation],
    note: `domain shortcut matched: ${plannedOperation.tool}; guardrail skipped because operational command matched`
  });
  const pendingOperationBefore = context.session.pendingOperation;
  const visibleEntitiesBefore = context.session.visibleEntities;
  const validatedOps = validateOperations([plannedOperation], context, message, { deterministicSource: true });
  const toolValidationPassed = validatedOps.every((op) => op.status !== "invalid" && op.status !== "unsupported");
  const pendingConfirmationOps = validatedOps.filter((op) => op.status === "needs_confirmation");
  const problemOps = validatedOps.filter((op) => op.status === "invalid" || op.status === "unsupported");
  const executableOps = validatedOps.filter((op) => op.status === "valid" && !META_TOOLS.has(op.tool));
  const executedOps = await Promise.all(executableOps.map((op) => executeOperation(context.session.userId, op, context, message)));
  applyExecutionSideEffects(context.session, executedOps);

  if (pendingConfirmationOps.length > 0) {
    const summary = summarizePendingOperations(pendingConfirmationOps);
    setPendingOperation(context.session, createPendingOperationRecord(topic, summary, pendingConfirmationOps));
  }

  const clarification = validatedOps.find((op) => op.status === "needs_clarification")?.clarificationQuestion;
  markActionClarificationPendingIfNeeded(context.session, validatedOps, clarification);
  const reply = composeReply({
    replyDraft: "",
    clarificationQuestion: clarification,
    pendingConfirmationOps,
    executedOps,
    problemOps
  });

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: plannedOperation,
      validatedOp: validatedOps[0],
      executedOp: executedOps.find((op) => isPlanningTool(op.tool)),
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: inferComposerSource({ clarificationQuestion: clarification, pendingConfirmationOps, executedOps, problemOps, replyDraft: "" })
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: [plannedOperation],
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed,
    topic,
    planningTrace
  });
}

async function finalizeDeterministicOperations(
  context: ContextBundle,
  message: string,
  plannedOperations: PlannedOperation[],
  topic: string
): Promise<AgentMessageResponse> {
  logAgentRuntimeDiagnostics({
    phase: "domain_shortcut_matched",
    userId: context.session.userId,
    finalOps: plannedOperations,
    note: `domain shortcut matched: ${plannedOperations.map((op) => op.tool).join(", ")}; guardrail skipped because operational command matched`
  });
  const pendingOperationBefore = context.session.pendingOperation;
  const visibleEntitiesBefore = context.session.visibleEntities;
  const validatedOps = validateOperations(plannedOperations, context, message, { deterministicSource: true });
  const toolValidationPassed = validatedOps.every((op) => op.status !== "invalid" && op.status !== "unsupported");
  const pendingConfirmationOps = validatedOps.filter((op) => op.status === "needs_confirmation");
  const problemOps = validatedOps.filter((op) => op.status === "invalid" || op.status === "unsupported");
  const executableOps = validatedOps.filter((op) => op.status === "valid" && !META_TOOLS.has(op.tool));
  const executedOps: ExecutedOperation[] = [];

  for (const op of executableOps) {
    executedOps.push(await executeOperation(context.session.userId, op, context, message));
  }
  applyExecutionSideEffects(context.session, executedOps);
  logAgentRuntimeDiagnostics({
    phase: "deterministic_operations_executed",
    userId: context.session.userId,
    finalOps: plannedOperations,
    validatedOps,
    mutationTools: executedOps.filter((op) => op.status === "executed" && getToolDefinition(op.tool)?.mutates).map((op) => op.tool)
  });

  if (pendingConfirmationOps.length > 0) {
    const summary = summarizePendingOperations(pendingConfirmationOps);
    setPendingOperation(context.session, createPendingOperationRecord(topic, summary, pendingConfirmationOps));
  }

  const clarification = validatedOps.find((op) => op.status === "needs_clarification")?.clarificationQuestion;
  markActionClarificationPendingIfNeeded(context.session, validatedOps, clarification);
  const reply = composeReply({
    replyDraft: "",
    clarificationQuestion: clarification,
    pendingConfirmationOps,
    executedOps,
    problemOps
  });
  logCompoundTurnDiagnostics(context.session.userId, plannedOperations, executedOps, context.session.pendingOperation !== null, reply);

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: plannedOperations[0],
      validatedOp: validatedOps[0],
      executedOp: executedOps.find((op) => isPlanningTool(op.tool)),
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: inferComposerSource({ clarificationQuestion: clarification, pendingConfirmationOps, executedOps, problemOps, replyDraft: "" })
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: plannedOperations,
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed,
    topic,
    planningTrace
  });
}

// fix/private-alpha-email-progress-invariant-and-review-list-stability (Task 5): a real reported
// gap — "show email reviws" (a one-letter-dropped typo) fell all the way through to the real
// planner, which without a reliable model call available degrades to "I couldn't reason through
// the email request cleanly" instead of showing the list. Corrected to the real word before any of
// the phrase matching below runs, rather than trying to make every pattern typo-tolerant itself.
function correctCommonReviewTypos(text: string): string {
  return text.replace(/\breviws\b/g, "reviews");
}

function looksLikeGmailReviewListRequest(rawText: string, context?: ContextBundle): boolean {
  const text = correctCommonReviewTypos(rawText);
  return (
    // "mail reviews" (bare "mail," not just "email"/"gmail") — a real requested phrasing: "show
    // me mail reviews" means the review queue exactly like "show me email reviews" does.
    /\b(show|list|see|view|open|pending|waiting|need|needs|attention)\b[\s\S]{0,50}\b(mail reviews?|email reviews?|gmail reviews?|emails? to review|items? to review|the queue|raw queue|all emails|every review)\b/.test(text) ||
    /\b(mail reviews?|email reviews?|gmail reviews?|emails? to review|items? to review)\b[\s\S]{0,50}\b(show|list|see|view|open|pending|waiting|need|needs|attention)\b/.test(text) ||
    /^email reviews?$/.test(text) ||
    /\bwhat emails? need (my )?attention\b/.test(text) ||
    (/^show me (?:the )?reviews?$/.test(text) && Boolean(context && (context.gmailReviews.length > 0 || hasRecentGmailContext(context)))) ||
    // "any emails left to review?", "anything left to review?" — a natural follow-up after
    // triaging some of a list, only trusted once the conversation has actually touched Gmail
    // reviews recently (same contextual gate as "show me the reviews" above), since "anything
    // left" alone is too generic a phrase to trust unconditionally.
    (/\b(any|anything)\b[\s\S]{0,30}\bleft\b[\s\S]{0,20}\b(review|reviews|emails?)\b|\b(emails?|reviews?)\b[\s\S]{0,20}\bleft\b[\s\S]{0,20}\breview\b/.test(text) &&
      Boolean(context && (context.gmailReviews.length > 0 || hasRecentGmailContext(context))))
  );
}

// refactor/private-alpha-general-email-intelligence-workflow: the explicit escape hatch out of the
// new default grouped summary (Stage E) — "show raw email reviews," "show the queue," "show all
// emails," "show every review." Deliberately narrow (raw/queue/individually/one by one), never
// triggered by the plain "show email reviews" phrasing itself, which stays grouped by default.
const GMAIL_REVIEW_RAW_VIEW_RE = /\b(raw|queue|individually|one by one|every( single)? (review|email))\b/i;

function gmailReviewListShortcutOperation(message: string, context?: ContextBundle): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text || !looksLikeGmailReviewListRequest(text, context)) {
    return undefined;
  }

  const viewMode = GMAIL_REVIEW_RAW_VIEW_RE.test(text) ? "raw" : undefined;
  return { tool: "gmail.review.list", args: { status: "pending", ...(viewMode ? { viewMode } : {}) }, rationale: "user asked to see pending Gmail reviews" };
}

/**
 * "show me email reviews and when do you check Gmail?" — a compound turn asking for both the
 * review list AND the sync-schedule status in the same message. Without this, whichever
 * single-op shortcut is checked first in the cascade (gmailReviewListShortcutOperation runs
 * before gmailAutonomyStatusShortcutOperation) claims the message and returns immediately,
 * silently dropping the second half — exactly the "handles one part, ignores the rest" failure
 * mode this compound-hardening pass exists to close. Both tools here are read-only
 * (mutates: false), so there is no safety concern with answering both unconditionally.
 */
function gmailReviewListAndAutonomyStatusCompoundShortcutOperations(message: string, context: ContextBundle): PlannedOperation[] {
  const text = normalizeIntentText(message);
  if (!text) {
    return [];
  }

  const wantsReviewList = looksLikeGmailReviewListRequest(text, context);
  const wantsStatus = looksLikeGmailAutonomyStatusQuery(text);
  if (!wantsReviewList || !wantsStatus) {
    return [];
  }

  return [
    { tool: "gmail.review.list", args: { status: "pending" }, rationale: "user asked to see pending Gmail reviews, alongside a Gmail sync-schedule status question" },
    { tool: "gmail.autonomy.status", args: {}, rationale: "user asked how often Gmail is checked, alongside a request to see pending reviews" }
  ];
}

function gmailReviewInspectShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const visibleReviews = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");
  if (visibleReviews.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  if (
    !text ||
    /\b(turn|convert|make|create|add|reject|ignore|approve|task|action|remind|reminder)\b/.test(text) ||
    gmailReviewListShortcutOperation(message, context)
  ) {
    return undefined;
  }

  const asksQuestion = /\b(does|do|is|are|has|have|hay|tiene|mentions?|contains?|info|what|which|tell me about)\b/.test(text) || text.endsWith("?");
  const selected = selectVisibleEntityMention(text, visibleReviews);
  if (!asksQuestion || !selected) {
    return undefined;
  }

  return {
    tool: "gmail.review.inspect",
    args: { reviewId: selected.id, question: message.trim() },
    rationale: "user asked about one visible Gmail review"
  };
}

type ExplicitGmailReviewIntent = "ignore" | "task" | "keep";

interface ExplicitGmailReviewIntentEntry {
  index: number;
  intent: ExplicitGmailReviewIntent;
  position: number;
  order: number;
}

interface ExplicitGmailReviewIntentPlan {
  operations: PlannedOperation[];
  entries: ExplicitGmailReviewIntentEntry[];
  dueText?: string;
  reminderLeadMinutes?: number;
}

function gmailReviewExplicitTriageShortcutOperations(message: string, context: ContextBundle): PlannedOperation[] {
  const plan = buildExplicitGmailReviewIntentPlan(message, context);
  if (!plan) {
    return [];
  }
  logAgentRuntimeDiagnostics({
    phase: "deterministic_gmail_review_triage",
    userId: context.session.userId,
    plannerOps: [],
    explicitReviewIntentMap: plan.entries,
    finalOps: plan.operations,
    mutationTools: plan.operations.filter((op) => getToolDefinition(op.tool)?.mutates).map((op) => op.tool)
  });
  return plan.operations;
}

function gmailReviewToActionShortcutOperations(message: string, context: ContextBundle): PlannedOperation[] {
  const visibleReviews = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");
  if (visibleReviews.length === 0) {
    return [];
  }

  const text = normalizeIntentText(message);
  if (!/\b(turn|convert|make|create|add)\b/.test(text) || !/\b(tasks?|actions?|reminders?)\b/.test(text)) {
    return [];
  }

  const indexes = extractVisibleIndexesFromReviewActionMessage(text, visibleReviews);
  const targetRefs: Array<{ index?: number; reviewId?: string }> = indexes.map((index) => ({ index }));

  if (targetRefs.length === 0) {
    const selected = selectVisibleEntityMention(text, visibleReviews);
    if (selected) {
      targetRefs.push(visibleEntityToGmailReviewRef(selected));
    } else if (visibleReviews.length === 1 && isGenericSingleVisibleReviewTaskReference(text)) {
      targetRefs.push(visibleEntityToGmailReviewRef(visibleReviews[0]!));
    } else {
      return [];
    }
  }

  const reminderLeadMinutes = extractPreDueReminderLeadMinutes(text);
  const dueText = /\b(time (?:they|it|each|the email|mail) (?:say|says)|time in (?:each )?(?:email|mail)|at the time)\b/.test(text)
    ? undefined
    : extractNaturalDueTextFromMessage(text);

  return targetRefs.map((targetRef) => ({
    tool: "gmail.review.to_action",
    args: {
      ...targetRef,
      ...(dueText ? { dueText } : {}),
      ...(reminderLeadMinutes !== undefined ? { reminderLeadMinutes } : {})
    },
    rationale: "user asked to turn visible Gmail reviews into tasks"
  }));
}

// fix/private-alpha-email-review-detail-and-general-mail-understanding (Part 2): a deterministic
// pre-planner shortcut for "show me the real content and explain this review" — checked so this
// class of message never depends on the real LLM planner correctly picking gmail.review.detail
// over gmail.review.inspect/approve/reject, since those look similar to a planner ("does the second
// one mention X" vs "show review 2" vs "why is 2 noise"). English + Spanish + Catalan, matching the
// task's own exact phrasing list.
// fix/private-alpha-email-review-resolution-and-stale-classification (Task 4): a live reported bug
// — "why is 3 uncertain signal?" fell through to the real planner (which still had gmail.review.
// inspect as an option for "a question about one review") because the trigger only recognized "why
// is X noise", not the other stored-classification labels a review can carry. Broadened to the full
// label vocabulary (uncertain/signal, recruiter/reply, offer, rejection, confirmation, classified)
// plus a bare "what is N"/"show me more about N" shape, so every phrasing from the bug report routes
// deterministically to gmail.review.detail (gmail.review.inspect now just aliases it internally too
// — see executor.ts — so this is belt-and-braces, not the only safety net).
const GMAIL_REVIEW_DETAIL_TRIGGER_RE = new RegExp(
  [
    "\\bdetails?\\b[\\s\\S]{0,15}\\b(for|of|about)\\b",
    "\\bshow( me)?\\b[\\s\\S]{0,20}\\b(more about|full text for|important text for|review)\\b",
    // refactor/private-alpha-canonical-progress-command-engine (Task 4): "open the recruiter
    // reply," "show the Okify application" — task's own supported-phrase list; "open" alone was
    // never a recognized trigger verb before this branch.
    "\\bopen\\b[\\s\\S]{0,20}\\b(the|review|application|recruiter|offer|confirmation|reply)\\b",
    "\\bshow( me)?\\b[\\s\\S]{0,20}\\bthe\\b[\\s\\S]{0,20}\\bapplication\\b",
    "\\bwhat is email\\b",
    "\\bwhat is\\b[\\s\\S]{0,10}\\d",
    "\\bexplain review\\b",
    "\\bwhy did you classify\\b",
    "\\bwhy is\\b[\\s\\S]{0,20}\\b(noise|uncertain|signal|recruiter|reply|offer|rejection|confirmation|classified)\\b",
    "\\bqu[eé] es el email\\b",
    "\\bense[nñ]ame\\b[\\s\\S]{0,15}\\bdetalles\\b",
    "\\bdetalles del\\b",
    "\\bpor qu[eé]\\b[\\s\\S]{0,25}\\bclasificaste\\b",
    "\\bpor qu[eé]\\b[\\s\\S]{0,20}\\b(incierto|ruido|reclutador|rechazo|confirmaci[oó]n)\\b",
    "\\bexplica'?m\\b[\\s\\S]{0,15}\\bcorreu\\b",
    "\\bmostra'?m\\b[\\s\\S]{0,15}\\bdetalls\\b",
    "\\bdetalls del\\b",
    "\\bper qu[eè]\\b[\\s\\S]{0,25}\\bclassificat\\b",
    "\\bper qu[eè]\\b[\\s\\S]{0,20}\\b(incert|soroll|recluta|rebuig|confirmaci[oó])\\b"
  ].join("|"),
  "i"
);
const GMAIL_REVIEW_DETAIL_FULL_TEXT_RE = /\b(full text|show me everything|texto completo|tot el text|el text complet)\b/i;

// fix/private-alpha-email-review-resolution-and-stale-classification (Task 6): explicit "refresh
// email reviews" — the bounded, capped alternative to auto-refreshing on every gmail.review.list.
const GMAIL_REVIEW_REFRESH_RE =
  /\b(refresh|recheck|re-check|update)\b[\s\S]{0,20}\b(email|mail|gmail)\s*reviews?\b|\bactualiza(r)?\b[\s\S]{0,20}\brevisiones\b|\bactualitza(r)?\b[\s\S]{0,20}\brevisions\b/i;

// refactor/private-alpha-canonical-progress-command-engine (Task 4): recognizable classification/
// category words the task's own supported-phrase list names ("details for the application
// confirmation", "open the recruiter reply", "details for the noise item", "details for the high
// priority one"). "noise"/"high_priority" are PRESENTATION categories (gmailReviewPresentationCategory
// / isHighPriorityGmailReview), computed fresh from each review's own current data — never a guess
// — everything else matches the review's own stored `reason`, which (per
// emailReviewClassificationFromUnderstanding) already equals the EmailKind string directly for
// every kind that isn't folded into a noise reason.
const REVIEW_CLASSIFICATION_FILTER_PATTERNS: Array<{ key: string; pattern: RegExp }> = [
  { key: "application_confirmation", pattern: /\bapplication\s+confirmations?\b|\bconfirmaci[oó]n(es)?\s+de\s+solicitud\b/i },
  { key: "recruiter_reply", pattern: /\brecruiter'?s?\s+repl(y|ies)\b|\brespuestas?\s+del\s+reclutador\b/i },
  { key: "offer", pattern: /\bjob\s+offers?\b|\bthe\s+offers?\b|\bofertas?\s+de\s+trabajo\b/i },
  { key: "interview", pattern: /\binterviews?\b|\bentrevistas?\b/i },
  { key: "rejection", pattern: /\brejections?\b|\brechazos?\b/i },
  { key: "personal_message", pattern: /\bpersonal\s+(messages?|ones?)\b|\bnetworking\s+(suggestions?|ones?)\b/i },
  { key: "__noise__", pattern: /\bnoise(\s+items?|\s+ones?)?\b|\bruido\b/i },
  { key: "__high_priority__", pattern: /\bhigh[\s-]priority(\s+one)?\b|\balta\s+prioridad\b/i }
];
const REVIEW_TODAY_FILTER_RE = /\bfrom\s+today\b|\btoday\b|\bde\s+hoy\b|\bd'avui\b|\bavui\b/i;

function parseReviewSemanticFilter(text: string): { classificationKey?: string; requireToday: boolean } | undefined {
  const classificationKey = REVIEW_CLASSIFICATION_FILTER_PATTERNS.find(({ pattern }) => pattern.test(text))?.key;
  const requireToday = REVIEW_TODAY_FILTER_RE.test(text);
  if (!classificationKey && !requireToday) {
    return undefined;
  }
  return { classificationKey, requireToday };
}

// fix/private-alpha-email-review-router-cleanup: a real reported bug — "details for an application
// confirmation from today" said "none match" while the visibly-listed review 3 ("... — application
// confirmation — Gmail, 2026-09-02") was RIGHT THERE. review.reason is NOT reliably the clean
// EmailKind string this filter assumed: the sync-time classifier (classify-email.ts) stores reason
// as either the matched eventType itself or a free-form LLM sentence, never guaranteed to equal
// "application_confirmation" literally — only the ON-DEMAND refresh path
// (emailReviewClassificationFromUnderstanding) produces that clean string. proposedEventType is the
// schema-backed field the review's OWN displayed label (gmailReviewSignalTypeLabel) actually reads,
// so a classification match must check it too, not just reason.
const REVIEW_CLASSIFICATION_KEY_TO_EVENT_TYPE: Record<string, string> = {
  application_confirmation: "career.application_confirmation_received",
  recruiter_reply: "career.recruiter_reply_received",
  offer: "career.offer_received",
  interview: "career.interview_scheduled",
  rejection: "career.rejection_received"
};

function reviewMatchesSemanticFilter(
  review: EmailReviewItem,
  filter: { classificationKey?: string; requireToday: boolean },
  timezone: string,
  todayLocalDate: string
): boolean {
  if (filter.classificationKey === "__noise__" && gmailReviewPresentationCategory(review) !== "noise") {
    return false;
  }
  if (filter.classificationKey === "__high_priority__" && !isHighPriorityGmailReview(review)) {
    return false;
  }
  if (filter.classificationKey && filter.classificationKey !== "__noise__" && filter.classificationKey !== "__high_priority__") {
    const matchesReason = review.reason === filter.classificationKey;
    const matchesEventType = review.proposedEventType === REVIEW_CLASSIFICATION_KEY_TO_EVENT_TYPE[filter.classificationKey];
    if (!matchesReason && !matchesEventType) {
      return false;
    }
  }
  if (filter.requireToday && formatDateInTimezone(review.createdAt, timezone) !== todayLocalDate) {
    return false;
  }
  return true;
}

interface SemanticReviewSelection {
  operations: PlannedOperation[];
  reply?: string;
}

/**
 * The classification/date-filtered counterpart to gmailReviewDetailShortcutOperation's plain
 * number/label matching below — handles "details for an application confirmation from today,"
 * "open the recruiter reply," "details for the noise item," "details for the high priority one."
 * Returns undefined (never engages) unless the message BOTH looks like a detail request AND names
 * a recognizable classification/date filter — a plain "details for 3" or a company-name reference
 * ("show the Okify application") is left entirely to the existing label/number resolution.
 */
async function gmailReviewSemanticReferenceOperation(message: string, context: ContextBundle): Promise<SemanticReviewSelection | undefined> {
  const visibleReviews = context.session.visibleEntities.filter(
    (entity): entity is AgentEntity & { index: number } => entity.type === "gmail_review" && typeof entity.index === "number"
  );
  if (visibleReviews.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  if (!text || !GMAIL_REVIEW_DETAIL_TRIGGER_RE.test(text)) {
    return undefined;
  }

  // An explicit number ("why is 3 noise?", "details for 2") always wins and is left entirely to
  // the existing index-based resolution below — a real regression this exact guard fixes: "why is
  // 3 noise?" was being intercepted here, its classification filter ("noise") found zero matches
  // among the OTHER visible reviews, and it replied "none match" instead of opening review 3.
  const visibleIndexSet = new Set(visibleReviews.map((entity) => entity.index));
  if (extractIndexesFromText(text, visibleIndexSet).length > 0) {
    return undefined;
  }

  const filter = parseReviewSemanticFilter(text);
  if (!filter) {
    return undefined;
  }

  const reviewsById = new Map(context.gmailReviews.map((review) => [review.id, review] as const));
  const timezone = await getUserTimezone(context.session.userId);
  const todayLocalDate = formatDateInTimezone(new Date(), timezone);
  const fullText = GMAIL_REVIEW_DETAIL_FULL_TEXT_RE.test(text);

  const matches = visibleReviews.filter((entity) => {
    const review = reviewsById.get(entity.id);
    return review ? reviewMatchesSemanticFilter(review, filter, timezone, todayLocalDate) : false;
  });

  if (matches.length === 1) {
    return {
      operations: [{ tool: "gmail.review.detail", args: { index: matches[0]!.index, ...(fullText ? { fullText: true } : {}) }, rationale: "user asked for details on the one visible review matching the stated classification/date filter" }]
    };
  }

  if (matches.length > 1) {
    const named = matches.map((entity) => `${entity.index} ${entity.label}`).join(", ");
    return { operations: [], reply: `I found ${matches.length} matching reviews today: ${named}. Which one?` };
  }

  const closest = visibleReviews.slice(0, 3).map((entity) => `${entity.index} ${entity.label}`).join(", ");
  return {
    operations: [],
    reply: closest ? `None of the visible reviews match that — closest options: ${closest}.` : "None of the visible reviews match that."
  };
}

function gmailReviewDetailShortcutOperation(message: string, context: ContextBundle): PlannedOperation[] {
  const visibleReviews = context.session.visibleEntities.filter(
    (entity): entity is AgentEntity & { index: number } => entity.type === "gmail_review" && typeof entity.index === "number"
  );
  if (visibleReviews.length === 0) {
    return [];
  }

  const text = normalizeIntentText(message);
  if (!text || !GMAIL_REVIEW_DETAIL_TRIGGER_RE.test(text)) {
    return [];
  }

  const visibleIndexSet = new Set(visibleReviews.map((entity) => entity.index));
  const indexes = extractIndexesFromText(text, visibleIndexSet);
  const fullText = GMAIL_REVIEW_DETAIL_FULL_TEXT_RE.test(text);

  if (indexes.length > 0) {
    return [{ tool: "gmail.review.detail", args: { index: indexes[0], ...(fullText ? { fullText: true } : {}) }, rationale: "user asked for the real content/explanation of one visible Gmail review" }];
  }

  // A number WAS mentioned but didn't match any currently-visible index (e.g. "show review 99")
  // — that is a genuinely wrong reference, never silently reinterpreted as "the only one visible."
  // Falling through here lets it reach the normal index-based resolution below/in the validator,
  // which asks a real "I don't see a #99" clarification instead of guessing.
  const mentionedAnyNumber = /\d/.test(text);

  const selected = selectVisibleEntityMention(text, visibleReviews);
  if (selected) {
    return [{ tool: "gmail.review.detail", args: { ...visibleEntityToGmailReviewRef(selected), ...(fullText ? { fullText: true } : {}) }, rationale: "user asked for the real content/explanation of one visible Gmail review" }];
  }

  if (!mentionedAnyNumber && visibleReviews.length === 1) {
    return [{ tool: "gmail.review.detail", args: { index: visibleReviews[0]!.index, ...(fullText ? { fullText: true } : {}) }, rationale: "user asked for the real content/explanation of the only visible Gmail review" }];
  }

  // fix/private-alpha-email-review-resolution-and-stale-classification (Task 5): a real reported
  // bug — "why is 3 uncertain signal?" then "show full text for it" produced a hard error instead of
  // resolving "it" to review 3, because with MORE THAN ONE review visible (the realistic case — a
  // pending queue of 10) neither branch above fires: no number was mentioned and selectVisibleEntityMention
  // found no named match for a bare pronoun. The last-focused Gmail review (set by the previous
  // detail/inspect call, which now always returns entities — see executor.ts) is exactly what "it"
  // means here, same resolution gmailReviewThisFollowupShortcutOperation already relies on for
  // approve/ignore/action follow-ups.
  if (!mentionedAnyNumber) {
    const focused = context.session.focusedEntities?.gmail_review;
    const stillVisible = focused && context.session.visibleEntities.some((entity) => entity.type === "gmail_review" && entity.id === focused.id);
    if (stillVisible) {
      return [{ tool: "gmail.review.detail", args: { ref: "this", ...(fullText ? { fullText: true } : {}) }, rationale: "user asked for the real content/explanation of the last-focused Gmail review" }];
    }
  }

  if (mentionedAnyNumber) {
    const [rawNumber] = text.match(/\d+/) ?? [];
    return [{ tool: "gmail.review.detail", args: { index: rawNumber ? Number(rawNumber) : undefined }, rationale: "user referenced a Gmail review number for details that is not in the currently visible list" }];
  }

  return [];
}

// fix/private-alpha-email-review-detail-and-general-mail-understanding (Part 8): after "details for
// N", a bare pronoun follow-up ("approve this", "ignore this", "not relevant", "already counted",
// "count this", "turn this into an action", "remind me about this tomorrow") always means the review
// just detailed — resolved deterministically via resolveGmailReviewRef's new pronoun branch
// (validator.ts), never left to the real planner to guess a tool AND a target in one shot.
const GMAIL_REVIEW_THIS_IGNORE_RE = /\b(ignore|reject|dismiss|not relevant|no relevante|not related|already counted|ya lo cont[eé]|ja ho he comptat)\b[\s\S]{0,10}\b(this|it)\b|^\s*(not relevant|no relevante|already counted)\s*$/i;
const GMAIL_REVIEW_THIS_APPROVE_RE = /\b(approve|count|log)\b[\s\S]{0,10}\b(this|it)\b/i;
const GMAIL_REVIEW_THIS_ACTION_RE = /\b(turn|convert|make)\b[\s\S]{0,15}\b(this|it)\b[\s\S]{0,15}\b(action|task)\b|\bremind me about this\b|\bremind me\b[\s\S]{0,10}\bthis\b/i;

function gmailReviewThisFollowupShortcutOperation(message: string, context: ContextBundle): PlannedOperation[] {
  const focused = context.session.focusedEntities?.gmail_review;
  if (!focused) {
    return [];
  }
  const stillVisible = context.session.visibleEntities.some((entity) => entity.type === "gmail_review" && entity.id === focused.id);
  if (!stillVisible) {
    return [];
  }

  const text = normalizeIntentText(message);
  if (!text) {
    return [];
  }

  if (GMAIL_REVIEW_THIS_ACTION_RE.test(text)) {
    const dueText = extractNaturalDueTextFromMessage(text);
    return [{ tool: "gmail.review.to_action", args: { ref: "this", ...(dueText ? { dueText } : {}) }, rationale: "user asked to turn the last-detailed Gmail review into an action" }];
  }

  if (GMAIL_REVIEW_THIS_IGNORE_RE.test(text)) {
    return [{ tool: "gmail.review.reject", args: { ref: "this" }, rationale: "user asked to ignore/dismiss the last-detailed Gmail review" }];
  }

  if (GMAIL_REVIEW_THIS_APPROVE_RE.test(text)) {
    return [{ tool: "gmail.review.approve", args: { ref: "this" }, rationale: "user asked to approve/count/log the last-detailed Gmail review" }];
  }

  return [];
}

// fix/private-alpha-email-review-resolution-and-stale-classification (Task 2): the user's own
// explicitly stated outcome ("mark it/this/2 as a CV sent", "count this as an application sent")
// always routes to gmail.review.log_progress — never gmail.review.approve, which would instead log
// whatever the review's OWN (possibly unrelated) classification says. English + Spanish + Catalan.
// fix/private-alpha-email-review-router-cleanup: a real reported bug — "mask as CV sent" (a plain
// typo for "mark") never matched the strict "\bmark\b" literal, fell through to the real planner,
// which chose event.log_job_applications (manual logging — the count moved) instead of
// gmail.review.log_progress, leaving the focused, eligible review pending forever. VERB_RE tolerates
// the exact typo variants this task's own test list names (mask, marc, mak, makr) alongside the
// correctly-spelled verbs, so a typo never silently downgrades a review-linked command into an
// unlinked one.
const GMAIL_REVIEW_MARK_PROGRESS_VERB_RE = "(mark|mask|marc|makr|mak|count|log|flag)";
const GMAIL_REVIEW_MARK_PROGRESS_RE = new RegExp(
  [
    `\\b${GMAIL_REVIEW_MARK_PROGRESS_VERB_RE}\\b[\\s\\S]{0,20}\\b(this|it|\\d+)\\b[\\s\\S]{0,20}\\bas\\b[\\s\\S]{0,15}\\b(a\\s+)?(cv|application)s?\\s+sent\\b`,
    `\\b${GMAIL_REVIEW_MARK_PROGRESS_VERB_RE}\\b[\\s\\S]{0,20}\\b(this|it|\\d+)\\b[\\s\\S]{0,20}\\bas\\b[\\s\\S]{0,15}\\bsent\\b`,
    // refactor/private-alpha-canonical-progress-command-engine: the object-free form — "mark as cv
    // sent," "count as cv sent" — with no "it"/"this"/number at all, implicitly meaning the
    // currently focused/visible review. This is the EXACT phrasing the live transcript this branch
    // fixes used ("mark as cv sent"), which the two patterns above (both requiring an explicit
    // this/it/digit object) never matched, silently falling through to the real LLM planner instead
    // of resolving deterministically.
    `\\b${GMAIL_REVIEW_MARK_PROGRESS_VERB_RE}\\b[\\s\\S]{0,10}\\bas\\b[\\s\\S]{0,15}\\b(a\\s+)?(cv|application)s?\\s+sent\\b`,
    // fix/private-alpha-email-review-router-cleanup (Task 3): the bare "count it"/"count this"/"log
    // this application" shapes this task's own test list names — no "as ... sent" suffix at all,
    // relying entirely on there being a focused/visible review to mark. Only ever produces an
    // operation when gmailReviewMarkProgressShortcutOperation itself resolves a real target review
    // (index/name/focus) below — a bare "count it" with no review in context safely falls through.
    "\\b(count|log)\\b[\\s\\S]{0,5}\\b(this|it)\\b(?:[\\s\\S]{0,15}\\bapplication\\b)?\\s*[.!]?\\s*$",
    "\\bm[aá]rca(lo|la|ho)?\\b[\\s\\S]{0,20}\\bcv enviado\\b",
    "\\bmarca'?(ho|l|la)?\\b[\\s\\S]{0,20}\\bcv enviat\\b"
  ].join("|"),
  "i"
);

// refactor/private-alpha-canonical-progress-command-engine (Task 3): the eligibility guard's own
// override escape hatch ("yes, count it anyway as a CV sent") — the user re-confirming after
// already being told once why an email was refused. Deliberately narrow (anyway/regardless/
// override/"do it anyway") rather than trusting a bare repeat of the same mark-as-cv-sent phrasing,
// since a SECOND plain "mark it as cv sent" with no acknowledgement of the refusal is more likely a
// user who didn't read the refusal than a deliberate override.
const GMAIL_REVIEW_MARK_PROGRESS_OVERRIDE_RE = /\banyway\b|\bregardless\b|\boverride\b|\bdo it anyway\b|\bigual(mente)?\b|\bde totes maneres\b/i;

// fix/private-alpha-email-review-router-cleanup (Task 4): a JUSTIFICATION statement ("I sent a CV
// related to that mail so mark it as CV sent") is different from a bare re-confirmation ("count it
// anyway") — the user is claiming something happened OUTSIDE what the email itself shows, which is
// worth one confirming question before writing anything ("should I log 1 CV sent and ignore this
// review?"), never an immediate silent log. Only engages when the override-anyway phrasing above
// did NOT already match (that one still bypasses immediately, unchanged).
const GMAIL_REVIEW_OVERRIDE_JUSTIFICATION_RE =
  /\bi (already |also )?sent\b[\s\S]{0,25}\b(cv|resume|r[eé]sum[eé]|application)\b|\bi did send\b[\s\S]{0,20}\b(cv|resume|application)\b|\benvi[eé]\b[\s\S]{0,20}\b(mi\s+)?(cv|curr[ií]culum|solicitud)\b|\bhe enviado\b[\s\S]{0,20}\b(mi\s+)?(cv|curr[ií]culum)\b|\bhe enviat\b[\s\S]{0,20}\b(el meu\s+)?(cv|curr[ií]culum)\b/i;

// refactor/private-alpha-general-email-intelligence-workflow (Task 5): bulk count phrasing —
// "count all applications," "count the unique applications," "count 7" (a bare number with no
// list, matching the SUGGESTED unique count Stage E's own summary just offered — the number is
// confirmatory, not a selection), "1,2,3,4,6 are cvs i sent," "count all except Exoticca," "count
// GoMining only," "count 9 manually"/"I actually sent 9" (an explicit override number, always
// routed as a manual statement, never tied to specific reviews).
const GMAIL_REVIEW_BULK_COUNT_ALL_RE = /\bcount\b[\s\S]{0,15}\b(all|every|the unique|unique)\b[\s\S]{0,20}\b(applications?|cvs?|confirmations?)\b/i;
const GMAIL_REVIEW_BULK_COUNT_BARE_NUMBER_RE = /^count(ed)?\s+(the\s+)?(\d+)\.?\s*$/i;
const GMAIL_REVIEW_BULK_COUNT_EXCEPT_RE = /\bcount\b[\s\S]{0,25}\b(all|everything)\b[\s\S]{0,15}\bexcept\b[\s\S]{0,40}$/i;
const GMAIL_REVIEW_BULK_COUNT_ONLY_RE = /\bcount\b[\s\S]{0,60}\bonly\b|\bcount only\b[\s\S]{0,60}/i;
const GMAIL_REVIEW_BULK_COUNT_MANUAL_RE = /\bcount(ed)?\s+(\d+)\s+manually\b|\bi\s+(actually\s+)?sent\s+(\d+)\b|\bi\s+sent\s+(\d+)\s+(today|this week|manually)\b|\bhe\s+enviado\s+(\d+)\b|\bhe\s+enviat\s+(\d+)\b/i;
const GMAIL_REVIEW_BULK_COUNT_LIST_RE = /\b(\d+\s*,\s*)+\d+\b[\s\S]{0,40}\b(cvs?|applications?)\b[\s\S]{0,10}\b(sent|enviad[oa]s?|enviats?)\b|\bcount\b[\s\S]{0,10}\b(\d+\s*,\s*)+\d+\b/i;

function gmailReviewBulkCountShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text) return undefined;

  const visibleReviews = context.session.visibleEntities.filter(
    (entity): entity is AgentEntity & { index: number } => entity.type === "gmail_review" && typeof entity.index === "number"
  );
  if (visibleReviews.length === 0) {
    return undefined;
  }

  // Manual-override numbers are checked first — "I sent 10 today"/"count 9 manually" always means
  // a plain user statement, regardless of what's currently visible in the review list.
  const manualMatch = text.match(GMAIL_REVIEW_BULK_COUNT_MANUAL_RE);
  if (manualMatch) {
    const manualCount = Number(manualMatch[2] ?? manualMatch[3] ?? manualMatch[4] ?? manualMatch[5] ?? manualMatch[6]);
    if (manualCount > 0) {
      return { tool: "gmail.review.count_applications", args: { selection: "manual_count", manualCount }, rationale: "user explicitly stated a manual application-sent count, independent of specific emails" };
    }
  }

  if (GMAIL_REVIEW_BULK_COUNT_ALL_RE.test(text) || GMAIL_REVIEW_BULK_COUNT_BARE_NUMBER_RE.test(text)) {
    return { tool: "gmail.review.count_applications", args: { selection: "unique" }, rationale: "user asked to count all/the unique visible applications" };
  }

  if (GMAIL_REVIEW_BULK_COUNT_EXCEPT_RE.test(text)) {
    const exceptMatch = text.match(/\bexcept\b\s+(.+)$/i);
    const excludeRef = exceptMatch?.[1]?.trim();
    if (excludeRef) {
      return { tool: "gmail.review.count_applications", args: { selection: "all_except", excludeRef }, rationale: "user asked to count everything except one named item" };
    }
  }

  if (GMAIL_REVIEW_BULK_COUNT_LIST_RE.test(text)) {
    const visibleIndexSet = new Set(visibleReviews.map((entity) => entity.index));
    const indexes = extractIndexesFromText(text, visibleIndexSet);
    if (indexes.length > 0) {
      return { tool: "gmail.review.count_applications", args: { selection: "indexes", indexes }, rationale: "user named specific visible items to count as CVs sent" };
    }
  }

  if (GMAIL_REVIEW_BULK_COUNT_ONLY_RE.test(text)) {
    const selected = selectVisibleEntityMention(text, visibleReviews);
    if (selected) {
      return { tool: "gmail.review.count_applications", args: { selection: "indexes", indexes: [selected.index] }, rationale: "user asked to count only one named item" };
    }
  }

  return undefined;
}

function gmailReviewMarkProgressShortcutOperation(message: string, context: ContextBundle): PlannedOperation[] {
  const text = normalizeIntentText(message);
  if (!text || !GMAIL_REVIEW_MARK_PROGRESS_RE.test(text)) {
    return [];
  }

  const explicitOverride = GMAIL_REVIEW_MARK_PROGRESS_OVERRIDE_RE.test(text);
  const confirmOverrideJustification = !explicitOverride && GMAIL_REVIEW_OVERRIDE_JUSTIFICATION_RE.test(text);
  const overrideArgs = explicitOverride ? { explicitOverride: true } : confirmOverrideJustification ? { confirmOverrideJustification: true } : {};

  const visibleReviews = context.session.visibleEntities.filter(
    (entity): entity is AgentEntity & { index: number } => entity.type === "gmail_review" && typeof entity.index === "number"
  );

  if (visibleReviews.length > 0) {
    const visibleIndexSet = new Set(visibleReviews.map((entity) => entity.index));
    const indexes = extractIndexesFromText(text, visibleIndexSet);
    if (indexes.length > 0) {
      return [{ tool: "gmail.review.log_progress", args: { index: indexes[0], ...overrideArgs }, rationale: "user explicitly said this visible Gmail review is a CV/application sent" }];
    }

    const selected = selectVisibleEntityMention(text, visibleReviews);
    if (selected) {
      return [{ tool: "gmail.review.log_progress", args: { ...visibleEntityToGmailReviewRef(selected), ...overrideArgs }, rationale: "user explicitly said this visible Gmail review is a CV/application sent" }];
    }
  }

  const focused = context.session.focusedEntities?.gmail_review;
  if (focused) {
    const stillVisible = context.session.visibleEntities.some((entity) => entity.type === "gmail_review" && entity.id === focused.id);
    if (stillVisible) {
      return [{ tool: "gmail.review.log_progress", args: { ref: "this", ...overrideArgs }, rationale: "user explicitly said the last-detailed Gmail review is a CV/application sent" }];
    }
  }

  return [];
}

const VAGUE_GMAIL_REVIEW_MUTATION_PATTERNS = [
  /\bhandle\s+(it|them|these|those|this)\b/,
  /\btake care of\s+(it|them|these|those|this)\b/,
  /\bdeal with\s+(it|them|these|those|this)\b/,
  /\bdo something with\s+(it|them|these|those|this)\b/,
  /\bsort\s+(it|them|these|those|this)(\s+\w+)?\s+out\b/,
  /\bsort\s+out\s+(it|them|these|those|this)\b/,
  /\bclean\s+(it|them|these|those|this)(\s+\w+)?\s+up\b/,
  /\bclean\s+up\s+(it|them|these|those|this)\b/
];

// fix/private-alpha-conversation-kernel-context-routing (Part 5): explicit wording always wins
// regardless of which surface was last shown — "remove/reject/clear/delete all mail/gmail/email
// reviews" unambiguously means the review QUEUE, never the Gmail ACCOUNT (that requires actual
// account/connect/disconnect/switch/authorize wording — see gmailDisconnectShortcutOperation).
// fix/private-alpha-gmail-review-quality-and-dedupe (Task 9): Spanish/Catalan "already counted"
// dismissals ("ya los conté, ignora todas las reviews" / "ja ho he comptat, ignora totes les
// revisions") use "ignora" (not the pre-existing borra/elimina/rechaza/quita/esborra/rebutja verb
// list) and never pair "reviews" with a redundant correos/mail/email qualifier — "reviews"/
// "revisiones"/"revisions" is already an unambiguous review-specific noun on its own, so that
// trailing qualifier is now optional rather than required.
const GMAIL_REVIEW_BULK_EXPLICIT_RE =
  /\b(remove|reject|clear|delete|ignore)\b[\s\S]{0,15}\ball\b[\s\S]{0,25}\b(gmail|mail|email)\b[\s\S]{0,10}\breviews?\b|\b(borra|elimina|rechaza|quita|ignora)[a-z]*\b[\s\S]{0,15}\b(todas?|totes?)\b[\s\S]{0,20}\b(revisiones|revisions|reviews?)\b(?:[\s\S]{0,20}\b(correos?|correus?|mail|email)\b)?|\b(esborra|rebutja|ignora)[a-z]*\b[\s\S]{0,15}\btotes?\b[\s\S]{0,20}\b(revisions|reviews?)\b(?:[\s\S]{0,20}\b(correus?|mail|email)\b)?/i;
// A bare "remove all"/"reject all"/"clear all" with no explicit domain word — only means Gmail
// reviews when that's genuinely the surface the user was just looking at (see
// mostRecentVisibleSurfaceType's own call site below), and explicitly excludes "all
// actions/tasks" wording so it never steals a message actually meant for bulkActionCleanup.
const BARE_BULK_REMOVE_RE = /\b(remove|reject|clear|delete|ignore)\b[\s\S]{0,10}\ball\b(?![\s\S]{0,15}\b(actions?|tasks?)\b)/i;

function gmailReviewBulkTriageShortcutOperation(message: string, context: ContextBundle): PlannedOperation[] {
  const visibleReviews = context.session.visibleEntities.filter(
    (entity): entity is AgentEntity & { index: number } => entity.type === "gmail_review" && typeof entity.index === "number"
  );
  if (visibleReviews.length === 0) {
    return [];
  }

  const text = normalizeIntentText(message);
  if (!text) {
    return [];
  }

  const explicitReviewWording = GMAIL_REVIEW_BULK_EXPLICIT_RE.test(text);
  const bareBulkWording = BARE_BULK_REMOVE_RE.test(text);
  const gmailReviewsAreTheActiveSurface = mostRecentVisibleSurfaceType(context.session) === "gmail_review";

  if (!explicitReviewWording && !(bareBulkWording && gmailReviewsAreTheActiveSurface)) {
    return [];
  }

  return visibleReviews.map((entity) => ({
    tool: "gmail.review.reject",
    args: { index: entity.index },
    rationale: "user asked to remove/reject/clear all visible Gmail reviews — this only decides Alecto's own review queue, never the real mailbox"
  }));
}

/** True when the user's own wording explains WHY they're clearing the queue (e.g. "I already
 * counted them when I sent the update") — surfaced back in the reply so the response is specific
 * to what they actually said, not a generic receipt. */
function extractBulkReviewDismissalReason(message: string): string | undefined {
  const text = normalizeIntentText(message);
  if (
    /\balready (counted|logged|reported|sent|included|tracked)\b/.test(text) ||
    /\bya\b[\s\S]{0,15}\b(conte|contado|contados|contada|contadas)\b/.test(text) ||
    /\bja\b[\s\S]{0,15}\b(comptat|comptats|comptada|comptades)\b/.test(text)
  ) {
    return "Since you already counted/logged that separately, I won't count these again.";
  }
  return undefined;
}

async function gmailReviewBulkTriageShortcut(message: string, context: ContextBundle): Promise<AgentMessageResponse | undefined> {
  const operations = gmailReviewBulkTriageShortcutOperation(message, context);
  if (operations.length === 0) {
    return undefined;
  }

  const count = operations.length;
  const response = await finalizeDeterministicOperations(context, message, operations, "gmail_reviews");
  const allSucceeded = response.operationsExecuted.length > 0 && response.operationsExecuted.every((op) => op.status === "executed");
  if (!allSucceeded) {
    return response;
  }

  const reasonNote = extractBulkReviewDismissalReason(message);
  const reply = `Got it — ignored the ${count} visible Gmail review${count === 1 ? "" : "s"}.${reasonNote ? ` ${reasonNote}` : ""} I did not delete any emails.`;
  return { ...response, reply };
}

const GMAIL_REVIEW_NOISE_BULK_RE = /\b(ignore|reject|clear|remove|dismiss)\b[\s\S]{0,15}\b(the\s+)?noise\b/;
const GMAIL_REVIEW_CONFIRMATION_BULK_RE =
  /\b(log|approve|confirm)\b[\s\S]{0,20}\b(the\s+)?(application\s+)?confirmations?\b/;

/**
 * fix/private-alpha-gmail-review-quality-and-dedupe (Task 7): a real reported UX gap — the review
 * list is now grouped into "Likely application confirmations" / "Needs review" / "Likely noise"
 * (formatGmailReviewListForChat), but there was no way to act on a WHOLE group at once other than
 * naming every number by hand. "ignore the noise" rejects only the noise-category items; "log the
 * application confirmations" approves only the confirmation-category items — both computed fresh
 * from each visible review's OWN classification (gmailReviewPresentationCategory), never a guess.
 */
async function gmailReviewCategoryBulkShortcut(message: string, context: ContextBundle): Promise<AgentMessageResponse | undefined> {
  const visibleReviews = context.session.visibleEntities.filter(
    (entity): entity is AgentEntity & { index: number } => entity.type === "gmail_review" && typeof entity.index === "number"
  );
  if (visibleReviews.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  if (!text) {
    return undefined;
  }

  const wantsNoise = GMAIL_REVIEW_NOISE_BULK_RE.test(text);
  const wantsConfirmations = !wantsNoise && GMAIL_REVIEW_CONFIRMATION_BULK_RE.test(text);
  if (!wantsNoise && !wantsConfirmations) {
    return undefined;
  }

  const reviewsById = new Map(context.gmailReviews.map((review) => [review.id, review] as const));
  const targetCategory = wantsNoise ? "noise" : "confirmation";
  const matchingEntities = visibleReviews.filter((entity) => {
    const review = reviewsById.get(entity.id);
    return review ? gmailReviewPresentationCategory(review) === targetCategory : false;
  });

  if (matchingEntities.length === 0) {
    return finalize(context, {
      reply: wantsNoise ? "Nothing in the visible reviews looks like noise right now." : "Nothing in the visible reviews looks like an application confirmation right now.",
      operationsPlanned: [],
      executedOps: [],
      plannerUsed: "none",
      llmPlannerAttempted: false,
      toolValidationPassed: true,
      topic: "gmail_reviews"
    });
  }

  const operations: PlannedOperation[] = matchingEntities.map((entity) => ({
    tool: wantsNoise ? "gmail.review.reject" : "gmail.review.approve",
    args: { index: entity.index },
    rationale: wantsNoise ? "user asked to ignore the noise-category Gmail reviews" : "user asked to log the application-confirmation-category Gmail reviews"
  }));

  const response = await finalizeDeterministicOperations(context, message, operations, "gmail_reviews");
  const allSucceeded = response.operationsExecuted.length > 0 && response.operationsExecuted.every((op) => op.status === "executed");
  if (!allSucceeded) {
    return response;
  }

  const count = matchingEntities.length;
  const reply = wantsNoise
    ? `Ignored ${count} noise item${count === 1 ? "" : "s"} — nothing was changed in your actual mailbox, only Alecto's own review queue.`
    : `Logged ${count} application confirmation${count === 1 ? "" : "s"}.`;
  return { ...response, reply };
}

const GMAIL_REVIEW_CLARIFICATION_REPLY = "I can ignore them, turn them into tasks, keep them for later, or show more detail. Which should I do?";

/**
 * "Ambiguity + mutation = clarification first" — a real product-hardening pass found that a
 * genuinely vague instruction like "handle it," "take care of them," "sort these out," or "clean
 * this up," with one or more Gmail reviews visible, has no specific-enough intent (no ignore/
 * keep/task verb, no index, no ref) for ANY tool to safely resolve. Left alone, this class of
 * message would fall through every deterministic shortcut straight to the real LLM planner, which
 * has no reliable way to avoid guessing a destructive operation (reject/to_action) for a message
 * that never actually specified one. Checked LAST among the Gmail-review shortcuts — every more
 * specific one above it (explicit ignore/keep/task, plural "keep them", numbered refs) gets first
 * chance to resolve the message on its own merits; this is only the vague-instruction fallback.
 * Returns the clarification text directly rather than a PlannedOperation: nothing here is a real
 * tool call, so there is nothing for the executor/validator to run or reject.
 */
function gmailReviewVagueMutationClarification(message: string, context: ContextBundle): string | undefined {
  const visibleReviews = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");
  if (visibleReviews.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  if (!text || !VAGUE_GMAIL_REVIEW_MUTATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return undefined;
  }

  return GMAIL_REVIEW_CLARIFICATION_REPLY;
}

const GMAIL_REVIEW_INSTRUCTION_ACTION_TOOLS: Record<string, string> = {
  approve: "gmail.review.approve",
  reject: "gmail.review.reject",
  to_action: "gmail.review.to_action",
  keep: "gmail.review.keep"
};

/**
 * fix/private-alpha-gmail-review-llm-instruction-routing (Task 2): whenever the message names
 * specific visible review numbers in a way the narrow deterministic extractor above
 * (extractExplicitGmailReviewIntentEntries) can't fully and confidently resolve on its own — a
 * mixed message like "1 and 2 are CVs I sent today, 3 and 4 are nothing, delete them" is the
 * textbook case: the regex extractor has no "approve" intent at all, and (after the digit-guard
 * fix above) correctly declines to guess at ANY of the four numbers rather than blindly rejecting
 * every one of them. This checks whether every review number the message actually MENTIONS has a
 * confident deterministic entry; if any doesn't, the LLM-backed parser (gmail-review-instruction-
 * parser.ts) takes over instead. Never fires for a message that mentions no review number at all —
 * that's either the vague-pronoun clarification above, or genuinely unrelated to the reviews.
 */
// Requires either real DECLARATIVE content ("1 IS a recruiter reply", "these ARE CVs I sent" —
// the exact shape of the originally reported bug) or the word "approve" (the one intent the old
// regex extractor below never recognized at all, even alone — "approve 1, reject 2 and 3" used to
// silently drop the "approve 1" half exactly like the declarative case). Genuinely distinct from a
// plain multi-verb instruction like "delete 1 and keep 2"/"turn 2 into a task and reject 1" (no
// declarative content and no "approve" — see the pre-existing adversarial-validation.test.ts/v3-
// smoke-transcripts.test.ts coverage this must never regress: those deliberately keep falling
// through to the real planner, or get silently, safely left alone for whatever a partial
// deterministic match didn't cover, exactly as before this change). Combined with the >=2-numbers
// requirement below, "approve review 1" alone (a single number, already correctly handled by the
// real planner today) is still safely excluded — only a genuinely MIXED "approve X, ... Y" message
// reaches this gate at all. Spanish/Catalan review triage (no English words at all) never matches
// either branch, so it keeps falling through to the real planner exactly as before too.
const GMAIL_REVIEW_DECLARATIVE_CONTENT_RE = /\b(is|are|'s|approve)\b/;

function gmailReviewInstructionNeedsLLMParsing(message: string, visibleReviews: AgentEntity[]): boolean {
  if (visibleReviews.length === 0) {
    return false;
  }
  const text = normalizeIntentText(message);
  if (!text || !GMAIL_REVIEW_DECLARATIVE_CONTENT_RE.test(text)) {
    return false;
  }
  const visibleIndexSet = new Set(visibleReviews.map((entity) => entity.index).filter((index): index is number => typeof index === "number"));
  const mentionedNumbers = extractIndexesFromText(text, visibleIndexSet);
  // Needs at least two real, valid review numbers to be a genuinely "mixed" message — a single-
  // number declarative statement ("1 is a recruiter reply" alone, nothing else) has no OTHER
  // number that could get silently mishandled, so it's safe to leave exactly where it already
  // correctly falls through (the real planner).
  if (mentionedNumbers.length < 2) {
    return false;
  }
  const deterministicEntries = extractExplicitGmailReviewIntentEntries(text, visibleIndexSet);
  const covered = new Set(deterministicEntries.map((entry) => entry.index));
  return !mentionedNumbers.every((index) => covered.has(index));
}

async function gmailReviewInstructionLLMShortcut(
  message: string,
  context: ContextBundle,
  visibleReviews: AgentEntity[]
): Promise<AgentMessageResponse | undefined> {
  const reviewsById = new Map(context.gmailReviews.map((review) => [review.id, review] as const));
  const orderedReviews = visibleReviews
    .filter((entity): entity is AgentEntity & { index: number } => typeof entity.index === "number")
    .sort((a, b) => a.index - b.index)
    .map((entity) => reviewsById.get(entity.id))
    .filter((review): review is NonNullable<typeof review> => Boolean(review));

  if (orderedReviews.length === 0) {
    return undefined;
  }

  const summaries = buildVisibleReviewSummaries(orderedReviews, context.gmailRules, context.activeGoals);
  const askClarification = (question: string) =>
    finalize(context, {
      reply: question,
      operationsPlanned: [],
      executedOps: [],
      plannerUsed: "none",
      llmPlannerAttempted: true,
      toolValidationPassed: true,
      topic: "gmail_reviews"
    });

  let parsed;
  try {
    parsed = await parseGmailReviewInstructionWithLLM(message, summaries);
  } catch {
    // Task 2's own explicit rule: "if LLM fails, deterministic fallback should not over-reject;
    // ask clarification instead" — never silently fall back to the unsafe blanket-reject regex
    // path, and never pretend nothing happened either.
    return askClarification("I couldn't safely work out what you meant for those reviews — could you say what to do with each one, by number?");
  }

  const validation = validateGmailReviewInstructionOperations(parsed, summaries);
  if (validation.needsClarification) {
    return askClarification(validation.clarificationQuestion);
  }

  const operations: PlannedOperation[] = [];
  for (const op of validation.operations) {
    operations.push({ tool: GMAIL_REVIEW_INSTRUCTION_ACTION_TOOLS[op.action]!, args: { index: op.reviewNumber }, rationale: op.reason });
    if (op.alsoLogApplicationsSent) {
      operations.push({
        tool: "event.log_job_applications",
        args: { count: op.alsoLogApplicationsSent },
        rationale: "user's own message stated this many applications/CVs sent today, alongside approving the matching review(s)"
      });
    }
  }

  const response = await finalizeDeterministicOperations(context, message, operations, "gmail_reviews");
  const reviewOpsAllSucceeded = response.operationsExecuted
    .filter((op) => Object.values(GMAIL_REVIEW_INSTRUCTION_ACTION_TOOLS).includes(op.tool))
    .every((op) => op.status === "executed");

  // Only replace composeReply's default (a concatenation of each tool's own one-line receipt)
  // with the natural, grouped summary when every review operation genuinely succeeded — a
  // "review no longer exists" failure or an opened pending-confirmation needs its own honest,
  // specific wording, which composeReply already produces correctly.
  if (reviewOpsAllSucceeded && !response.needsConfirmation) {
    return { ...response, reply: composeGmailReviewInstructionReply(validation.operations, summaries) };
  }
  return response;
}

/**
 * fix/private-alpha-coach-first-response-routing: a real Telegram transcript had a full coaching
 * exchange work correctly ("I rested this weekend with friends, is that okay?" -> a genuine
 * coaching answer validating the rest), then the very next turn — "I'll try to send CVs tonight
 * and more this week," a soft, hedged intention continuing the SAME conversation, never a command
 * — got "Action rescheduled: Send 3 CVs due: 31/08/2026, 20:00" instead of a coaching reply that
 * anchors the already-due action without touching it. Two things are checked, either one enough
 * to treat the turn as coach-first: (1) the message ITSELF reads as a reflective/reassurance
 * question (COACH_CONVERSATION_RE) or a soft, uncommitted intention (SOFT_INTENTION_RE) — even
 * when it also mentions a day/time word ("tonight," "this week"), since mentioning a time is not
 * the same as commanding a change; or (2) the message doesn't read as either on its own, but the
 * most recent prior USER turn was itself a coaching/reassurance question — a bare "yeah, thanks"
 * or unlabeled follow-up right after "is that okay?" is still part of the same coaching thread.
 * An explicit mutation verb (EXPLICIT_MUTATION_VERB_RE) in THIS message always wins and lets a
 * mutation through regardless of context. When coach-first applies, any action.reschedule/
 * snooze/complete/archive/create the planner still emitted is dropped before validation ever
 * sees it — never replaced with a canned line, so the planner's own real coaching/planning
 * replyDraft (guided by planner.ts's own response-mode-routing prompt) is exactly what's shown,
 * same as any other read-only turn.
 *
 * fix/private-alpha-gm-greeting-vs-gmail-routing: a SEPARATE, independent gate on top of the
 * above — a bare greeting ("gm," "good morning," "morning") with no explicit Gmail/email language
 * of its own is never Gmail intent, no matter what the rest of the message goes on to say about
 * the user's goal (a real transcript found "Gm will send anything web3 dev that fits my style"
 * routed to gmail.goal_watcher.propose_enable's "already covered" reply — no deterministic regex
 * anywhere matched "gm" as Gmail; this was the real LLM planner free-associating the greeting with
 * Gmail, primed by its own "Gmail is goal-driven by default for a job-search goal" instruction).
 * Deliberately independent of the mutation-verb bypass above — an explicit ACTION command doesn't
 * imply explicit GMAIL intent, so it must never accidentally let a Gmail tool through too.
 */
function applyCoachFirstResponseRouting(message: string, context: ContextBundle, operations: PlannedOperation[]): PlannedOperation[] {
  const blockActionMutation = !EXPLICIT_MUTATION_VERB_RE.test(message) && (isCoachFirstMessage(message) || hasRecentCoachingContext(context));
  const blockGmail = isGreetingWithoutGmailIntent(message);

  if (!blockActionMutation && !blockGmail) {
    return operations;
  }

  const gatedTools = new Set<string>([
    ...(blockActionMutation ? RESPONSE_MODE_GATED_MUTATION_TOOLS : []),
    ...(blockGmail ? RESPONSE_MODE_GATED_GMAIL_TOOLS : [])
  ]);
  const filtered = operations.filter((op) => !gatedTools.has(op.tool));
  if (filtered.length === operations.length) {
    return operations;
  }
  const dropped = operations.filter((op) => gatedTools.has(op.tool)).map((op) => op.tool);
  logAgentRuntimeDiagnostics({
    phase: "coach_first_response_routing_mutation_dropped",
    userId: context.session.userId,
    note: `dropped ${dropped.join(", ")} for a ${blockGmail ? "greeting-without-gmail-intent" : "coach_conversation/soft_intention"} message`
  });
  return filtered;
}

/** The most recent prior USER turn (skipping this turn's own just-appended message and any
 * assistant reply in between) was itself a coaching/reassurance question — "recent coaching
 * context," so a bare, unlabeled follow-up right after "is that okay?" still reads as continuing
 * that same thread rather than a fresh, unrelated request. Scoped to the last few turns only
 * (never the whole conversation history), mirroring hasRecentGmailContext's own backward-scan
 * shape elsewhere in this file. */
function hasRecentCoachingContext(context: ContextBundle): boolean {
  const messages = context.session.messages;
  const searchFloor = Math.max(0, messages.length - 6);
  for (let i = messages.length - 2; i >= searchFloor; i -= 1) {
    const entry = messages[i];
    if (entry.role === "user") {
      return COACH_CONVERSATION_RE.test(entry.text);
    }
  }
  return false;
}

function reconcileExplicitGmailReviewIntentOperations(
  message: string,
  context: ContextBundle,
  operations: PlannedOperation[]
): PlannedOperation[] {
  const plan = buildExplicitGmailReviewIntentPlan(message, context);
  if (!plan) {
    return operations;
  }

  const reviewTools = new Set(["gmail.review.reject", "gmail.review.to_action", "gmail.review.keep", "gmail.review.approve"]);
  const nonReviewOps = operations.filter((op) => !reviewTools.has(op.tool));
  const finalOps = [...plan.operations, ...nonReviewOps];
  logAgentRuntimeDiagnostics({
    phase: "reconciled_gmail_review_triage",
    userId: context.session.userId,
    plannerOps: operations,
    explicitReviewIntentMap: plan.entries,
    finalOps,
    mutationTools: finalOps.filter((op) => getToolDefinition(op.tool)?.mutates).map((op) => op.tool)
  });
  return finalOps;
}

function buildExplicitGmailReviewIntentPlan(message: string, context: ContextBundle): ExplicitGmailReviewIntentPlan | undefined {
  const visibleReviews = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");
  if (visibleReviews.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  const visibleIndexSet = new Set(visibleReviews.map((entity) => entity.index).filter((index): index is number => typeof index === "number"));
  const entries = extractExplicitGmailReviewIntentEntries(text, visibleIndexSet);
  if (entries.length === 0) {
    return undefined;
  }

  const dueText = extractNaturalDueTextFromMessage(text);
  const reminderLeadMinutes = extractGmailReviewReminderLeadMinutes(text);
  const operations = entries.map<PlannedOperation>((entry) => {
    if (entry.intent === "ignore") {
      return {
        tool: "gmail.review.reject",
        args: { index: entry.index },
        rationale: "user explicitly asked to ignore a visible Gmail review"
      };
    }

    if (entry.intent === "keep") {
      return {
        tool: "gmail.review.keep",
        args: { index: entry.index },
        rationale: "user explicitly asked to keep a visible Gmail review pending"
      };
    }

    return {
      tool: "gmail.review.to_action",
      args: {
        index: entry.index,
        ...(dueText ? { dueText } : {}),
        ...(reminderLeadMinutes !== undefined ? { reminderLeadMinutes } : {})
      },
      rationale: "user explicitly asked to turn a visible Gmail review into a task"
    };
  });

  return { operations, entries, dueText, reminderLeadMinutes };
}

function extractExplicitGmailReviewIntentEntries(text: string, visibleIndexSet: Set<number>): ExplicitGmailReviewIntentEntry[] {
  const candidates: ExplicitGmailReviewIntentEntry[] = [];
  let order = 0;
  // fix/private-alpha-gmail-review-llm-instruction-routing: a real reported bug — "1 and 2 are
  // CVs I sent today, 3 and 4 are nothing u can delete them" got ALL FOUR reviews rejected,
  // because the plural "delete them" fallback below has no way to know "them" was only ever meant
  // to refer to 3 and 4, not every visible review. The existing negative lookbehind only blocks
  // the narrow "4 and 6 keep them" immediately-preceding-digit shape; it does nothing for a
  // pronoun appearing later in a longer, mixed message. Tightened here instead: none of the three
  // plural "them/these/those/both/all" fallbacks below may fire at all when the message mentions
  // ANY other digit anywhere — a genuinely simple "keep them there for now"/"delete them" (no
  // other numbers in the message) still works exactly as before, but a message that ALSO singles
  // out specific numbers for something else now correctly falls through empty-handed rather than
  // guessing wrong, so gmailReviewInstructionNeedsLLMParsing below routes it to the new
  // LLM-backed parser instead of silently mis-triaging it.
  const hasAnyDigit = /\d/.test(text);
  const addEntries = (intent: ExplicitGmailReviewIntent, position: number, rawIndexes: string) => {
    for (const index of extractIndexesFromText(rawIndexes, visibleIndexSet)) {
      candidates.push({ index, intent, position, order: order++ });
    }
  };
  // "keep them there for now", "keep both in review", "delete both" — a plural/all quantifier
  // with no explicit number at all means every currently visible review, not one specific,
  // ambiguous item. A real Telegram smoke test found "keep both in review for now" (with exactly
  // two visible reviews) sent to the LLM planner, which echoed one review's own subject text back
  // as a `ref` that then failed to resolve, producing a confusing "which one did you mean?" for a
  // message that was never actually ambiguous. This only ever fires when visibleReviews is
  // non-empty (buildExplicitGmailReviewIntentPlan's own early return), so it's already scoped to
  // an active Gmail-review-triage conversation.
  const addAllVisibleEntries = (intent: ExplicitGmailReviewIntent, position: number) => {
    for (const index of visibleIndexSet) {
      candidates.push({ index, intent, position, order: order++ });
    }
  };

  // Alecto never mutates the actual Gmail mailbox — "delete"/"remove"/"discard" a review is the
  // same real action as "ignore"/"reject" it (both just decide the EmailReviewItem, never the
  // email itself), so all of these verbs map to the identical "ignore" intent/gmail.review.reject
  // tool. A real Telegram smoke test's "u can delete 3 its nothing important" was silently missed
  // entirely because "delete" wasn't recognized as one of the ignore-intent verbs at all.
  for (const match of text.matchAll(/\b(?:ignore|ifnore|reject|skip|delete|remove|discard)\s+(?:number\s+)?((?:#?\d+\s*(?:,|\band\b|\by\b|&)?\s*)+)/g)) {
    if (match[1]) {
      addEntries("ignore", match.index ?? 0, match[1]);
    }
  }

  // The reversed phrasing — the index named first, then a dismissive judgment about it ("3 is
  // nothing important", "3 isn't relevant", "4 is junk/spam") — same intent, index-before-verb
  // word order instead of verb-before-index.
  for (const match of text.matchAll(
    /\b((?:#?\d+\s*(?:,|\band\b|\by\b|&)?\s*)+)\s+(?:is|are|isn't|is not|aren't|are not)\s+(?:nothing important|not important|not relevant|irrelevant|junk|spam)\b/g
  )) {
    if (match[1]) {
      addEntries("ignore", match.index ?? 0, match[1]);
    }
  }

  for (const match of text.matchAll(/\b(?:turn|convert|make|create|add)\s+((?:#?\d+\s*(?:,|\band\b|\by\b|&)?\s*)+)\s+(?:into|to|as)\s+(?:a\s+|an\s+)?(?:tasks?|actions?|reminders?)\b/g)) {
    if (match[1]) {
      addEntries("task", match.index ?? 0, match[1]);
    }
  }

  for (const match of text.matchAll(/\b(?:keep|leave)\s+((?:#?\d+\s*(?:,|\band\b|\by\b|&)?\s*)+)\s+(?:in\s+)?(?:review|reviews?|pending|for later)\b/g)) {
    if (match[1]) {
      addEntries("keep", match.index ?? 0, match[1]);
    }
  }

  for (const match of text.matchAll(/\b((?:#?\d+\s*(?:,|\band\b|\by\b|&)?\s*)+)\s+(?:keep|leave)\s+(?:them\s+|these\s+|those\s+)?(?:in\s+)?(?:review|reviews?|pending|for later)\b/g)) {
    if (match[1]) {
      addEntries("keep", match.index ?? 0, match[1]);
    }
  }

  // Plural/all quantifier, no explicit number — English "keep them"/"leave both"/"keep all of
  // them" (deliberately no trailing "review/pending" requirement here, unlike the numbered
  // pattern above: the reported transcript's exact phrase, "keep them there for now", has no
  // domain word at all, and this whole extraction only ever runs with real visible reviews). The
  // negative lookbehind excludes "them"/"these"/"those" immediately after a number ("4 and 6
  // keep them in review") — that's the INDEX-FIRST keep pattern below's own pass-through pronoun
  // referring back to the numbers just named, not a request to keep every visible review; without
  // this guard, a real mixed-triage message ("...4 and 6 keep them in review for later") had this
  // plural match incorrectly override the correctly-extracted numbered task/keep decisions for
  // OTHER, unrelated indexes elsewhere in the same message. "em"/"'em" is included as informal
  // slang for "them" ("keep em all for later") — a real Telegram smoke test found this exact
  // phrasing, sent as a direct answer to Alecto's own "which should I do?" clarification, fell
  // through every shortcut (no literal "them") all the way to the goal-avoidance guardrail. No
  // separate "pending clarification" state needed: once the slang is recognized, this same
  // deterministic-shortcut-first architecture that already protects "check gmail every hour"
  // from the guardrail protects this too.
  if (!hasAnyDigit) {
    const match = text.match(/(?<!\d\s)\b(?:keep|leave)\s+(?:them|these|those|both|all(?:\s+of\s+them)?|'?em)\b/);
    if (match) {
      addAllVisibleEntries("keep", match.index ?? 0);
    }
  }
  // Spanish: "deja los dos para luego", "mantén ambos en revisión", "deja estos para luego"
  // (accents already stripped by normalizeIntentText, so "mantén" arrives as "manten" and
  // "revisión" as "revision").
  if (!hasAnyDigit) {
    const match = text.match(
      /\b(?:deja|dejalo|dejalos|dejalas|manten|mantenlo|mantenlos|mantenlas|guarda|guardalo|guardalos|guardalas)\b[\s\S]{0,20}\b(?:los\s+dos|las\s+dos|ambos|ambas|todos|todas|estos|estas)\b/
    );
    if (match) {
      addAllVisibleEntries("keep", match.index ?? 0);
    }
  }
  // Catalan: "deixa'ls per després" — the pronoun is fused onto the verb ("-ls" = "them"), so
  // this alone already means "leave them," no separate quantifier word needed.
  if (!hasAnyDigit) {
    const match = text.match(/\bdeixa'?ls\b/);
    if (match) {
      addAllVisibleEntries("keep", match.index ?? 0);
    }
  }

  // Plural/all quantifier for ignore/task intents too, English only for now — mirrors the keep
  // case above so "ignore them"/"delete both"/"turn both into tasks" don't hit the same
  // ambiguous-ref bug the keep phrasing did.
  if (!hasAnyDigit) {
    const match = text.match(/(?<!\d\s)\b(?:ignore|ifnore|reject|skip|delete|remove|discard)\s+(?:them|these|those|both|all(?:\s+of\s+them)?|'?em)\b/);
    if (match) {
      addAllVisibleEntries("ignore", match.index ?? 0);
    }
  }
  if (!hasAnyDigit) {
    const match = text.match(/(?<!\d\s)\b(?:turn|convert|make|create|add)\s+(?:them|these|those|both|all(?:\s+of\s+them)?|'?em)\s+(?:into|to|as)\s+(?:a\s+|an\s+)?(?:tasks?|actions?|reminders?)\b/);
    if (match) {
      addAllVisibleEntries("task", match.index ?? 0);
    }
  }

  const byIndex = new Map<number, ExplicitGmailReviewIntentEntry>();
  for (const candidate of candidates) {
    const current = byIndex.get(candidate.index);
    if (!current || gmailReviewIntentPriority(candidate.intent) > gmailReviewIntentPriority(current.intent)) {
      byIndex.set(candidate.index, candidate);
    }
  }

  return [...byIndex.values()].sort((left, right) => left.position - right.position || left.order - right.order || left.index - right.index);
}

function extractIndexesFromText(text: string, visibleIndexSet: Set<number>): number[] {
  const indexes = [...text.matchAll(/\b\d+\b/g)]
    .map((match) => Number(match[0]))
    .filter((index) => visibleIndexSet.has(index));
  return [...new Set(indexes)];
}

function gmailReviewIntentPriority(intent: ExplicitGmailReviewIntent): number {
  if (intent === "ignore") return 3;
  if (intent === "keep") return 2;
  return 1;
}

function extractGmailReviewReminderLeadMinutes(text: string): number | undefined {
  if (/\bremind\b[\s\S]{0,80}\b(?:at that time|at the same time|same time|then)\b/.test(text)) {
    return 0;
  }
  return extractPreDueReminderLeadMinutes(text);
}

const EMAIL_REVIEW_REFERENCE_PATTERN = /\b(email|emails|gmail|inbox|mail|mails|review|reviews)\b/;
const ACTION_COMPLETION_PATTERN = /\b(complete(d)?|finish(ed)?|mark(ed)? (?:it |that )?(?:as )?(?:done|complete))\b/;
// "hecho" (Spanish "done") and Catalan "fet"/"ja està fet" ("done"/"it's already done" — the
// clitic phrasing doesn't start with "fet", so it needs its own unanchored alternative alongside
// the simple leading-word case).
const ACTION_DONE_PATTERN = /^(done|finished|hecho|terminado|listo|fet|llest)\b|\bja\s+(esta|ho he)\s+fet\b/;
const ACTION_ARCHIVE_PATTERN = /\b(archive|dismiss)\b/;
// Broadened for fix/private-alpha-action-temporal-coaching — a real Telegram transcript found
// "snooze it for later this week" hit the goal-avoidance guardrail purely because the OLD pattern
// (literal "snooze" only) is a small subset of how a coach would actually phrase task deferral;
// "move it," "bring it back," "park it," "push it," "defer," and "remind me" (+ Spanish/Catalan
// equivalents, matched post-accent-stripping via normalizeIntentText) are all real reported/
// expected phrasings for the exact same operation (now action.reschedule — see
// fix/private-alpha-remove-user-facing-action-snooze below). Deliberately does NOT include
// "postpone"/"reschedule": those two are action.reschedule's own established vocabulary
// (changing/correcting a due date while the action stays OPEN, the same effect this whole pattern
// now routes to anyway), and a bare "reschedule it to tomorrow" must still reach that tool through
// its own normal path, not get silently redirected here. Still just a keyword shortcut, not full
// NLP — a phrase this doesn't catch simply falls through to the real LLM planner (whose
// tool-catalog.ts guidance covers the same vocabulary) rather than silently failing; this only
// ever WIDENS what resolves deterministically before the guardrail.
//
// fix/private-alpha-remove-user-facing-action-snooze: "not now"/"not today" added after a real-LLM
// eval caught "not now, tomorrow" (no other deferral keyword) falling all the way through to the
// goal-avoidance guardrail's own LLM classifier, which sometimes misread an entirely ordinary task
// reschedule as "avoiding the goal" and blocked it outright — the exact operation (action.reschedule)
// never even ran. Matching this deterministically here, like every other deferral phrase already
// does, gives it the same guardrail-skip privilege ("domain shortcut matched" — see the call site
// below) instead of leaving it to a per-call, occasionally-wrong LLM judgment.
const ACTION_SNOOZE_PATTERN =
  /\bsnooze\b|\bmove (it|this|that)\b|\bbring (it|this|that) back\b|\bpark (it|this|that)\b|\bpush (it|this|that)\b|\bdefer\b|\bremind me\b|\bnot now\b|\bnot today\b|\bmuevelo\b|\bpasalo\b|\brecuerdamelo\b|\bmou-ho\b|\bpassa-ho\b|\brecorda-m['’]ho\b/;
/** Generic pronoun/bare-acknowledgement reference only — a message that names something by its
 * own specific words ("complete the Nietzsche book goal") should still go through the normal
 * planner/validator resolution path, not this shortcut, which exists only for the truly ambiguous
 * "it"/"that"/bare-word case a worker notification leaves the user replying to. */
const GENERIC_ACTION_REFERENCE_PATTERN = /\b(it|that one|that|this one|this)\b/;

// fix/private-alpha-coach-first-response-routing: the coaching/soft-intention mutation-gating
// regexes (formerly COACHING_JUDGMENT_QUESTION_RE/EXPLICIT_MUTATION_VERB_RE/
// COACHING_QUESTION_MUTATION_TOOLS, defined locally here) now live in the dependency-free
// response-mode.ts module — see applyCoachFirstResponseRouting's own doc comment (above, near the
// Gmail-review reconciler it's modeled on) for the current real transcript this closes.

// A deferral verb (ACTION_SNOOZE_PATTERN, defined below) paired with a genuinely vague "some day
// this week" phrase and NO actual day named — "later this week"/"this week"/"later in the week"
// (English), "mas adelante esta semana" (Spanish), "mes endavant aquesta setmana" (Catalan), all
// post-accent-stripping via normalizeIntentText.
const VAGUE_WEEK_PATTERN = /\b(later this week|later in the week|this week)\b|\bmas adelante esta semana\b|\bmes endavant aquesta setmana\b/;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The 1-2 weekdays worth naming back to the user for "later this week" — deliberately excludes
 * tomorrow itself ("later" reads as "not the very next day") and caps at two so the question
 * stays short, matching the real reported transcript's own phrasing ("Thursday or Friday?").
 * Treats the work week as ending Friday (stops at the weekend) — empty once today IS Friday or
 * later, since "later this week" genuinely has no good answer by then. */
function laterThisWeekCandidateDays(todayLocalDate: string): string[] {
  const remaining: string[] = [];
  for (let offset = 1; offset <= 6; offset++) {
    const dateStr = addDaysToLocalDateString(todayLocalDate, offset);
    const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) {
      break;
    }
    remaining.push(WEEKDAY_NAMES[dow]!);
  }
  const afterTomorrow = remaining.slice(1);
  const candidates = afterTomorrow.length > 0 ? afterTomorrow : remaining;
  return candidates.slice(-2);
}

/**
 * "snooze it for later this week" / "move it later this week" — a real deferral verb with no
 * concrete day at all. extractNaturalDueTextFromMessage can't build an untilText for this (by
 * design — it only ever recognizes real, concrete dates), so left alone this shape used to fall
 * all the way through actionCompletionShortcutOperation's decline straight to the goal-avoidance
 * guardrail, which had no way to know it was looking at ordinary task scheduling — the exact
 * reported bug. Only fires when a concrete day genuinely isn't already present (a message like
 * "later this week, actually thursday" already has a real answer and is left to the normal
 * concrete-date shortcut below), and only when exactly one action is currently resolvable, the
 * same single-target safety bar every other bare-reference shortcut in this file uses.
 */
async function actionDeferralAmbiguousWeekClarification(message: string, context: ContextBundle): Promise<string | undefined> {
  const text = normalizeIntentText(message);
  if (!text || /\d/.test(text) || !ACTION_SNOOZE_PATTERN.test(text) || !VAGUE_WEEK_PATTERN.test(text) || extractNaturalDueTextFromMessage(text)) {
    return undefined;
  }

  const resolved = await resolveMostRecentlyNotifiedOrVisibleActionId(context);
  if (!resolved) {
    return undefined;
  }

  const settings = await getOrCreateNotificationSettings(context.session.userId);
  const todayLocal = formatDateInTimezone(new Date(), settings.timezone);
  const candidates = laterThisWeekCandidateDays(todayLocal);

  if (candidates.length === 0) {
    return "Which day would you like to move it to?";
  }
  const dayPhrase = candidates.length === 1 ? candidates[0]! : `${candidates.slice(0, -1).join(", ")} or ${candidates[candidates.length - 1]}`;
  return `Which day later this week — ${dayPhrase}?`;
}

/**
 * Deterministic resolution for a generic "complete it"/"done"/"archive it"/"snooze it tomorrow"
 * reply — see the call site in processAgentMessageInner for why this exists and runs before the
 * planner. Never fires when the message itself references an email/Gmail review (requirement:
 * Alecto must only ever act on a Gmail review when the user explicitly says so), and only fires
 * for a generic pronoun-shaped reference, never a message that names something specific in its own
 * words (that's left to the normal planner + validator's resolveActionRef).
 */
async function actionCompletionShortcutOperation(message: string, context: ContextBundle): Promise<PlannedOperation | undefined> {
  const text = normalizeIntentText(message);
  // Any digit means the user named something by number ("complete 1, snooze 2, archive 3") —
  // that's an explicit numbered reference (or a multi-item batch) the normal planner + validator's
  // own numbered-list resolution already handles correctly; this shortcut exists only for the
  // genuinely ambiguous bare-pronoun case a worker notification leaves the user replying to.
  if (!text || EMAIL_REVIEW_REFERENCE_PATTERN.test(text) || /\d/.test(text)) {
    return undefined;
  }

  let tool: "action.complete" | "action.archive" | "action.reschedule" | undefined;
  let dueText: string | undefined;

  if (ACTION_SNOOZE_PATTERN.test(text)) {
    dueText = extractNaturalDueTextFromMessage(text);
    // "not now"/"not today" always extract their OWN literal word first ("now"/"today" appears
    // before any later date named in the same message — extractNaturalDueTextFromMessage's regex
    // finds the leftmost match) — the opposite of what they mean: "not now" means "later," not
    // "due this instant." Tomorrow is the natural default (matches tool-catalog.ts's own
    // established rule for the same phrasing when it reaches the real planner instead), UNLESS a
    // real later date follows in the same message ("not now, tomorrow"), which wins here exactly
    // because it's the more specific, user-stated target.
    if (dueText === "now" || dueText === "today") {
      const laterDate = text.match(
        /\bnot\s+(?:now|today)\b[\s,]*((?:tomorrow|tonight)(?:\s+(?:morning|afternoon|evening))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)\b/
      );
      dueText = laterDate?.[1]?.trim() ?? "tomorrow";
    }
    // The deterministic shortcut still needs a real due-date phrase to extract — without one,
    // fall through rather than plan an operation the validator can only reject.
    if (!dueText) {
      return undefined;
    }
    // fix/private-alpha-remove-user-facing-action-snooze: this used to build an action.snooze
    // operation, which set status "snoozed" — invisible to a plain "show me my actions" until it
    // came back due. A real Telegram transcript found exactly this: "move it to tomorrow 20:00"
    // made the action vanish from every normal list view even though nothing was completed or
    // archived. action.reschedule updates dueAt and keeps the action open, matching the product
    // rule that moving/postponing/reminding later must never hide a real, still-open commitment.
    // No more "today" carve-out needed either — action.reschedule already handles pulling a date
    // BACK to today correctly (previously only true of action.reschedule, never action.snooze).
    tool = "action.reschedule";
  } else if (ACTION_ARCHIVE_PATTERN.test(text)) {
    tool = "action.archive";
  } else if (ACTION_COMPLETION_PATTERN.test(text) || ACTION_DONE_PATTERN.test(text)) {
    tool = "action.complete";
  } else {
    return undefined;
  }

  if (tool !== "action.reschedule" && !GENERIC_ACTION_REFERENCE_PATTERN.test(text) && !ACTION_DONE_PATTERN.test(text)) {
    return undefined;
  }

  const resolved = await resolveMostRecentlyNotifiedOrVisibleActionId(context);
  logAgentRuntimeDiagnostics({
    phase: "action_completion_shortcut",
    userId: context.session.userId,
    note: resolved ? `resolved to ActionItem ${resolved.actionId} via ${resolved.source}, tool=${tool}` : "no ActionItem resolved — falling through to normal planner"
  });
  if (!resolved) {
    return undefined;
  }

  return {
    tool,
    args: { actionId: resolved.actionId, ...(dueText ? { dueText } : {}) },
    rationale: "user replied generically about the most recently notified/visible task, not a Gmail review"
  };
}

/**
 * Ground truth for "which task is 'it'" when the message itself gives no better clue: prefers
 * whichever real ActionItem the worker most recently actually notified the user about (via
 * sendDueActionReminders' own ActionItemReminderLog — see getMostRecentlyRemindedActionItem's doc
 * comment for why this exists at all: the worker has no way to update this chat session's own
 * visibleEntities, so relying on session state alone left "it" resolving to whatever was visible
 * from an unrelated EARLIER turn, e.g. a Gmail review the user had already rejected). Only trusts
 * a notification from the last 24 hours — an old, possibly-stale reminder from days ago is not a
 * safe silent target. Falls back to a plain visible "action" entity in session when no recent
 * notification exists at all (e.g. right after creating a task in the very same conversation,
 * before the worker has had any chance to notify about anything).
 */
async function resolveMostRecentlyNotifiedOrVisibleActionId(
  context: ContextBundle
): Promise<{ actionId: string; source: "reminded_by_worker" | "visible_session_entity" } | undefined> {
  const remindedAction = await getMostRecentlyRemindedActionItem(context.session.userId, {
    since: new Date(Date.now() - 24 * 60 * 60 * 1000)
  });
  if (remindedAction) {
    // A "remind me N minutes before" companion ActionItem (actionType "reminder") is a stub
    // about a real task, not the task itself — the worker's own ActionItemReminderLog points at
    // the STUB's own id when it fires one of these. A core-operator audit found that "complete
    // it" right after such a reminder was silently completing the stub while the real task
    // stayed open, untouched, and still due. Resolve back to the real parent task instead.
    const parentActionId = parentActionIdFromReminderSourceId(remindedAction.actionType, remindedAction.sourceId);
    if (parentActionId) {
      const parent = await getActionItem(context.session.userId, parentActionId);
      if (parent && parent.status !== "archived" && parent.status !== "completed") {
        return { actionId: parent.id, source: "reminded_by_worker" };
      }
    }
    return { actionId: remindedAction.id, source: "reminded_by_worker" };
  }

  // Only a SINGLE visible action is safe to resolve silently here. With no recent worker
  // reminder to disambiguate and more than one action item in view, `.find()` used to just grab
  // the first one — a real ambiguity-hardening pass found this meant "complete it"/"done" could
  // silently mutate the WRONG task whenever two or more were visible at once. Returning undefined
  // here makes the shortcut fall through to the normal planner + validator's own ambiguity check
  // (resolveSingleVisibleEntity in validator.ts), which already asks a real clarification
  // question instead of guessing.
  const visibleActions = context.session.visibleEntities.filter((entity) => entity.type === "action");
  return visibleActions.length === 1 ? { actionId: visibleActions[0]!.id, source: "visible_session_entity" } : undefined;
}

function actionTimeCorrectionShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const visibleActions = context.session.visibleEntities.filter((entity) => entity.type === "action");
  if (visibleActions.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  const times = [...text.matchAll(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/g)].map((match) => match[0]);
  if (times.length === 0 || !/\b(means|should be|not|change|correct)\b/.test(text)) {
    return undefined;
  }

  const timeText = times[times.length - 1];
  const rawRef = text.split(/\b(?:means|should be|change|correct)\b/)[0]?.trim() ?? "";
  const ref = rawRef.replace(/\b(the|that|this|task|action)\b/g, " ").replace(/\s+/g, " ").trim();

  return {
    tool: "action.reschedule",
    args: { ...(ref ? { ref } : {}), timeText },
    rationale: "user corrected the time for a visible scheduled task"
  };
}

function preDueReminderShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const visibleActions = context.session.visibleEntities.filter((entity) => entity.type === "action");
  if (visibleActions.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  const leadMinutes = extractPreDueReminderLeadMinutes(text);
  if (!leadMinutes || !/\b(remind|reminder|recorda|recuerdame|avisame)\b/.test(text) || !/\bbefore\b/.test(text)) {
    return undefined;
  }

  return {
    tool: "action.create_pre_due_reminders",
    args: { leadMinutes, ref: text },
    rationale: "user asked for reminders before visible scheduled tasks"
  };
}

function actionReminderListShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text) {
    return undefined;
  }

  const asksReminderList =
    /\b(do i have|have i got|any|what|which|show|list|see)\b[\s\S]{0,40}\breminders?\b/.test(text) ||
    /\breminders?\b[\s\S]{0,40}\b(on|set|scheduled|active|pending)\b/.test(text);

  return asksReminderList ? { tool: "action.reminder_list", args: {}, rationale: "user asked to see scheduled reminders" } : undefined;
}

function actionMeetingListShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!/\b(when|what time|show|list|see)\b[\s\S]{0,40}\b(meetings?|calls?|appointments?)\b/.test(text)) {
    return undefined;
  }
  return { tool: "action.meeting_list", args: {}, rationale: "user asked for scheduled meetings" };
}

// Matches an explicit verb ("delete"/"archive"/"clear"/"remove", or their Spanish/Catalan
// equivalents) combined with a bulk-scope phrase ("all my actions", "all of them", "these
// actions/tasks", "my actions", "my tasks", "todas", "totes") — deliberately requires BOTH a verb
// and a scope word so a message like "these" alone (ambiguous without a verb) doesn't match here;
// see BARE_BULK_ACTION_SCOPE_RE below for that case, gated on an actual visible action list. No
// bare "all of them" alternative here (deliberately, unlike the verb+scope phrases) — that phrase
// is ALSO used unrelated to actions (e.g. Gmail review triage's "keep all of them pending"), so
// matching it without a verb here previously mis-fired on exactly that kind of message; a bare
// "all of them" is only ever safe to treat as bulk-archive scope in BARE_BULK_ACTION_SCOPE_RE
// below, which requires the ENTIRE message to be just that phrase AND a visible action list.
// The scope portion just requires bare "all" within reach of the verb — a real Telegram smoke
// test found "archive all" (no trailing "of them"/"my actions") falling through both this regex
// and the bare-reply one below, since the original pattern required a qualifier word after "all."
// "all" alone, right after delete/archive/clear/remove, is already unambiguous bulk intent; "all of
// them"/"all my actions"/"these actions"/"these tasks" remain covered as substrings of the same
// widened match, not as separate required alternatives anymore.
//
// fix/private-alpha-action-state-consistency: "my actions"/"my tasks" (plural, no "all"/"these")
// added as their own accepted scope phrase — a real reported transcript used exactly "remove my
// actions", which this regex previously did NOT match (only "all"/"these actions/tasks" counted),
// so it fell through to the real LLM planner to infer bulk intent on its own every time, with no
// deterministic guarantee it always would. "my task"/"mi tarea" (singular) is deliberately NOT
// matched here — that reads as a specific, single item, not a bulk-scope request.
const BULK_ACTION_CLEANUP_VERB_SCOPE_RE =
  /\b(delete|archive|clear|remove)\b[\s\S]{0,20}\b(all|my (actions|tasks)|these (actions|tasks))\b|\bi mean all actions\b|\b(borra|archiva|elimina|limpia)\b[\s\S]{0,20}\b(todas|mis (acciones|tareas))\b|\blimpia mis acciones\b|\b(arxiva|elimina|esborra)\b[\s\S]{0,20}\b(totes|meves (accions|tasques))\b/;

// A bare, unqualified scope reply ("these", "all", "them", "all of them", "todas", "totes") with
// NO verb at all — only meaningful as a reply to Alecto's own numbered action list (or a failed
// title-match clarification about one), so this is checked separately and ONLY when the session
// actually has visible action entities right now; see the call site below.
const BARE_BULK_ACTION_SCOPE_RE = /^(these|all( of them)?|them|todas|totes)$/;

function bulkActionCleanupShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  const hasVisibleActions = context.session.visibleEntities.some((entity) => entity.type === "action");

  const matchesVerbScope = BULK_ACTION_CLEANUP_VERB_SCOPE_RE.test(text);
  const matchesBareScope = hasVisibleActions && BARE_BULK_ACTION_SCOPE_RE.test(text);
  if (!matchesVerbScope && !matchesBareScope) {
    return undefined;
  }

  return {
    tool: "action.archive_all_propose",
    args: { scope: hasVisibleActions ? "visible" : "all" },
    rationale: "user asked to archive/delete/clear multiple or all actions at once, never a literal action title"
  };
}

function extractVisibleIndexesFromReviewActionMessage(text: string, visibleReviews: AgentEntity[]): number[] {
  const beforeTask = text.split(/\b(?:into|to|as)\s+(?:a\s+|an\s+)?(?:tasks?|actions?|reminders?)\b/)[0] ?? text;
  const visibleIndexSet = new Set(visibleReviews.map((entity) => entity.index).filter((index): index is number => typeof index === "number"));
  const indexes = [...beforeTask.matchAll(/\b\d+\b/g)]
    .map((match) => Number(match[0]))
    .filter((index) => visibleIndexSet.has(index));

  const ordinalIndexes = [
    ["first", 1],
    ["second", 2],
    ["third", 3],
    ["fourth", 4],
    ["fifth", 5]
  ] as const;
  for (const [word, index] of ordinalIndexes) {
    if (beforeTask.includes(word) && visibleIndexSet.has(index)) {
      indexes.push(index);
    }
  }

  return [...new Set(indexes)];
}

function extractPreDueReminderLeadMinutes(text: string): number | undefined {
  const match = text.match(/\b(\d{1,3})\s*(?:minutes?|mins?|min)\s+before\b/);
  if (match?.[1]) {
    const minutes = Number(match[1]);
    return Number.isInteger(minutes) && minutes > 0 ? minutes : undefined;
  }
  return /\bremind\b[\s\S]{0,30}\bbefore\b/.test(text) ? 30 : undefined;
}

function extractNaturalDueTextFromMessage(text: string): string | undefined {
  const minuteRelative = text.match(/\b(?:in\s+\d{1,4}\s+(?:minutes?|mins?)|\d{1,4}\s+(?:minutes?|mins?)\s+from\s+now)\b/);
  if (minuteRelative?.[0]) {
    return minuteRelative[0].trim();
  }

  const relative = text.match(/\b((?:today|tomorrow|tonight|now)(?:\s+(?:morning|afternoon|evening|tonight))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)\b/);
  if (relative?.[1]) {
    return relative[1].trim();
  }

  const weekday = text.match(
    /\b((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening|tonight))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)\b/
  );
  return weekday?.[1]?.trim();
}

function messageReferencesVisibleEntity(text: string, entities: AgentEntity[]): boolean {
  return Boolean(selectVisibleEntityMention(text, entities));
}

function selectVisibleEntityMention(text: string, entities: AgentEntity[]): AgentEntity | undefined {
  const textTokens = visibleReferenceTokens(text);
  if (textTokens.length === 0) {
    return undefined;
  }

  const scored = entities
    .map((entity) => {
      const labelTokens = new Set(visibleReferenceTokens(entity.label));
      const overlap = textTokens.filter((token) => labelTokens.has(token));
      return { entity, overlap, score: overlap.length };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return undefined;
  }

  const [first, second] = scored;
  if (!first) {
    return undefined;
  }

  if (first.score >= 2 && first.score > (second?.score ?? 0)) {
    return first.entity;
  }

  if (first.score === 1 && !second) {
    const token = first.overlap[0] ?? "";
    if (token.length >= 5) {
      return first.entity;
    }
  }

  return undefined;
}

function visibleEntityToGmailReviewRef(entity: AgentEntity): { index?: number; reviewId?: string } {
  return typeof entity.index === "number" ? { index: entity.index } : { reviewId: entity.id };
}

function isGenericSingleVisibleReviewTaskReference(text: string): boolean {
  const beforeTask = text.split(/\b(?:into|to|as)\s+(?:a\s+|an\s+)?(?:tasks?|actions?|reminders?)\b/)[0] ?? text;
  const specificWords = visibleReferenceTokens(beforeTask).filter(
    (token) => !/^(turn|convert|make|create|add|can|could|would|please|pls|email|gmail|mail|review|item|one|it|this|that)$/.test(token)
  );
  return specificWords.length === 0;
}

function visibleReferenceTokens(value: string): string[] {
  return [
    ...new Set(
      normalizeIntentText(value)
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(
          (token) =>
            token.length >= 3 &&
            !/^(the|and|for|with|from|into|onto|does|have|has|any|info|about|what|which|tell|says|say|task|tasks|action|actions|reminder|reminders|email|emails|gmail|mail|mails|review|reviews|item|items|one|this|that|it|they|them|each|turn|convert|make|create|add|please|could|would|can|you|me|my|your|hay|tiene|sobre|para|con|una|uno|las|los|del)$/.test(
              token
            )
        )
    )
  ];
}

/**
 * V3 Gmail autonomy — HOW OFTEN Gmail itself is checked (manual-only, or a real scheduled
 * interval via the existing worker poll), distinct from gmail.rule.* (WHAT is tracked). A real
 * Telegram smoke test found "review my emails every 1h" misrouted to gmail.rule.propose_update,
 * pausing the user's "Work action emails" rule instead — V3 had no tool for this concept at all,
 * so the real LLM planner reached for the closest-sounding existing one. Reuses legacy/gmail-
 * conversation.ts's own parseGmailAutonomyPreference (already correctly scoped to NOT match a
 * named-rule request like "pause X" — it only recognizes manual/every-N-minutes/hours/daily/
 * notification phrasing) rather than re-implementing that parsing from scratch; this only READS
 * that function, never touches /messages/process's own routing.
 */
function parseGmailAutonomyPreferenceForAgentRuntime(message: string): GmailAutonomyPreferenceRequest | undefined {
  const text = normalizeIntentText(message);

  // parseGmailAutonomyPreference's own topic guard accepts a bare "review"/"reviews" alone
  // (Gmail review items are one of the things it configures), but that word is also used by
  // OTHER, unrelated V3 features (the daily loop's "daily review", weekly review, action
  // review). A real regression this caused: "turn off daily review" (the daily-loop setting)
  // was reinterpreted as "review daily" -> Gmail scheduled-every-day, because the legacy
  // parser's "daily" pattern matched alongside "review" satisfying its topic guard. Require an
  // unambiguous Gmail/email word here before trusting the parser's result at all. Spanish/
  // Catalan "correo(s)"/"correu(s)" are checked separately below, not folded into this same
  // English-only gate, since the legacy parser's OWN internal topic guard is English-only too
  // (gmail|email|...|review) and would reject a Spanish-only message before ever reaching its
  // "cada hora" pattern — calling it for those messages would be pointless.
  const hasEnglishMailWord = /\b(gmail|email|emails|mail|mails|inbox)\b/.test(text);
  const hasSpanishOrCatalanMailWord = /\b(correo|correos|correu|correus)\b/.test(text);
  if (!hasEnglishMailWord && !hasSpanishOrCatalanMailWord) {
    return undefined;
  }

  if (hasEnglishMailWord) {
    const direct = parseGmailAutonomyPreference(message);
    if (direct) {
      return direct;
    }
  }

  // Spanish "cada hora"/"cada N minutos"/"cada N horas" for a message that only uses
  // "correo(s)"/"correu(s)" — never reaches parseGmailAutonomyPreference above at all, since
  // that shared legacy parser's own topic guard requires an English mail word. Added here as a
  // V3-only supplement rather than widening the shared legacy parser itself.
  const everyMinutesEs = text.match(/\bcada\s+(\d+)\s+minutos?\b/);
  if (everyMinutesEs?.[1]) {
    const minutes = Number.parseInt(everyMinutesEs[1], 10);
    if (Number.isFinite(minutes) && minutes > 0) {
      return { kind: "scheduled", intervalMinutes: minutes };
    }
  }
  const everyHoursEs = text.match(/\bcada\s+(\d+)\s+horas?\b/);
  if (everyHoursEs?.[1]) {
    const hours = Number.parseInt(everyHoursEs[1], 10);
    if (Number.isFinite(hours) && hours > 0) {
      return { kind: "scheduled", intervalMinutes: hours * 60 };
    }
  }
  if (/\bcada\s+hora\b/.test(text)) {
    return { kind: "scheduled", intervalMinutes: 60 };
  }

  // parseGmailAutonomyPreference doesn't recognize bare "Nh" shorthand ("every 1h") — the exact
  // phrasing the reported transcript used. Added here, as a V3-only supplement, rather than
  // widening the shared legacy parser itself.
  const hoursShorthand = text.match(/\bevery\s+(\d+)\s*h\b/);
  if (hoursShorthand?.[1]) {
    const hours = Number.parseInt(hoursShorthand[1], 10);
    if (Number.isFinite(hours) && hours > 0) {
      return { kind: "scheduled", intervalMinutes: hours * 60 };
    }
  }

  return undefined;
}

function looksLikeGmailAutonomyStatusQuery(text: string): boolean {
  return (
    // "you" is spelled out here as an explicit alternative alongside the "u" texting shorthand
    // ("when do u check email?") rather than folded into normalizeIntentText, since that
    // normalizer is shared by every other shortcut in this file and blindly rewriting "u" ->
    // "you" everywhere risks corrupting unrelated messages that use "u" for something else.
    /\bwhen\b[\s\S]{0,20}\b(do|does)\b[\s\S]{0,10}\b(you|u|it|alecto)\b[\s\S]{0,20}\bcheck\b[\s\S]{0,20}\b(gmail|email|emails|mail|inbox)\b/.test(text) ||
    /\bis\b[\s\S]{0,20}\b(gmail|email)\b[\s\S]{0,20}\bsync\b[\s\S]{0,20}\bscheduled\b/.test(text) ||
    /\b(gmail|email)\b[\s\S]{0,20}\bsync\b[\s\S]{0,20}\b(settings|schedule)\b/.test(text) ||
    /\bhow often\b[\s\S]{0,30}\bcheck\b[\s\S]{0,20}\b(gmail|email|emails|mail)\b/.test(text) ||
    // "do you check my email automatically?" — no "when"/"how often" at all, so this needs its
    // own explicit schedule-shaped qualifier to avoid swallowing an unrelated bare "do you check
    // email" (which reads more like a sync request than a status question).
    /\b(do|does)\b[\s\S]{0,10}\b(you|u|it|alecto)\b[\s\S]{0,20}\bcheck\b[\s\S]{0,20}\b(gmail|email|emails|mail|inbox)\b[\s\S]{0,20}\b(automatically|auto|regularly|on (a|your) schedule)\b/.test(
      text
    ) ||
    // Spanish "cada cuánto miras mi email?" / Catalan "cada quant mires el meu email?" — "cada
    // cuánto"/"cada quant" ("how often") is the direct equivalent of the English "how often"
    // branch above; accents are already stripped by normalizeIntentText ("cuánto" -> "cuanto").
    /\bcada\s+(cuanto|quant)\b[\s\S]{0,30}\b(miras|mira|revisas|revisa|checas|checa|chequeas|chequea|mires|revises)\b[\s\S]{0,20}\b(email|correo|correos|correu|correus|gmail|mail)\b/.test(
      text
    )
  );
}

function gmailAutonomyStatusShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text) {
    return undefined;
  }

  return looksLikeGmailAutonomyStatusQuery(text)
    ? { tool: "gmail.autonomy.status", args: {}, rationale: "user asked how often Gmail is checked" }
    : undefined;
}

/**
 * Combines (a) an explicit Gmail sync-frequency change (manual-only or scheduled, via
 * parseGmailAutonomyPreferenceForAgentRuntime) with (b) any Gmail review the SAME message also
 * dismisses — either by explicit index (reusing buildExplicitGmailReviewIntentPlan) or, when
 * exactly one review is visible, by a bare pronoun ("delete it," "ignore it," "it's nothing
 * important" — no index at all, the exact shape the reported transcript used). Only ever fires
 * when an autonomy preference is genuinely present; a pure review-only message (no autonomy
 * language) returns nothing here and falls through unchanged to the existing review shortcuts.
 */
function gmailAutonomyCompoundShortcutOperations(message: string, context: ContextBundle): PlannedOperation[] {
  const preference = parseGmailAutonomyPreferenceForAgentRuntime(message);
  if (!preference || preference.kind === "review_notifications" || preference.kind === "daily_digest" || preference.kind === "work_hours") {
    return [];
  }

  const reviewPlan = buildExplicitGmailReviewIntentPlan(message, context);
  const reviewOps = reviewPlan ? [...reviewPlan.operations] : [];

  if (reviewOps.length === 0) {
    const visibleReviews = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");
    const text = normalizeIntentText(message);
    const dismissesReview = /\b(delete|remove|discard|ignore|ifnore|reject|skip)\b/.test(text) || /\bnothing important\b/.test(text);
    if (visibleReviews.length === 1 && dismissesReview) {
      reviewOps.push({
        tool: "gmail.review.reject",
        args: { reviewId: visibleReviews[0]!.id },
        rationale: "user dismissed the one visible Gmail review by pronoun, alongside a Gmail sync-frequency request"
      });
    }
  }

  const autonomyOp: PlannedOperation = {
    tool: "gmail.autonomy.propose_update",
    args:
      preference.kind === "manual_only"
        ? { syncMode: "manual_only" }
        : { syncMode: "scheduled", intervalMinutes: preference.intervalMinutes },
    rationale: "user asked to change Gmail's scheduled sync mode/interval"
  };

  return [...reviewOps, autonomyOp];
}

/**
 * Extracted out of gmailConnectionShortcutOperation (fix/private-alpha-pending-action-refinement-
 * and-gmail-rule-ux) so the SAME "does this message ask for Gmail connection/status help"
 * detection can also be reused by the pending-action-refinement mixed-intent handler below,
 * rather than a second, potentially drifting copy of the same regex set.
 */
function detectGmailConnectionIntent(message: string, context: ContextBundle): { includeLink: boolean } | undefined {
  const text = normalizeIntentText(message);
  if (!text || /\bsync\b/.test(text)) {
    return undefined;
  }
  if (looksLikeGmailAlertSettingsRequest(text)) {
    return undefined;
  }

  const mentionsGmailOrEmail = /\b(gmail|email|emails|mail|mails)\b/.test(text);
  const asksConnectionAction = /\b(connect|reconnect|integrate|setup|set up|authorize|reauthorize|fix)\b/.test(text);
  const asksForLink = /\blink\b|\boauth\b|\bauth url\b|\bauthori[sz]ation url\b/.test(text);
  const asksStatus = /\b(status|state|connected|connection|configured|setup)\b/.test(text);
  const mentionsAuthProblem = /\bgmail\b[\s\S]{0,50}\b(expired|unauthori[sz]ed|permission|scope|auth|authorization)\b|\b(expired|unauthori[sz]ed|permission|scope|auth|authorization)\b[\s\S]{0,50}\bgmail\b/.test(text);
  const contextualReconnectLink = asksForLink && /\b(connect|reconnect|authorize|reauthorize|fix|it)\b/.test(text) && hasRecentGmailContext(context);

  if ((mentionsGmailOrEmail && (asksConnectionAction || asksForLink || asksStatus)) || mentionsAuthProblem || contextualReconnectLink) {
    const includeLink = asksConnectionAction || asksForLink || mentionsAuthProblem || contextualReconnectLink;
    return { includeLink };
  }

  return undefined;
}

function gmailConnectionShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const detected = detectGmailConnectionIntent(message, context);
  return detected ? { tool: "gmail.status", args: { includeLink: detected.includeLink }, rationale: "user asked for Gmail connection or reconnect help" } : undefined;
}

// fix/private-alpha-gmail-account-switch-and-personalized-examples: disconnect is a real,
// consequential mutation (stops syncing, best-effort revokes the token at Google) — left entirely
// to the real LLM planner's own judgment, a message this unambiguous ("disconnect Gmail," "remove
// Gmail," "unlink Gmail," "stop using this Gmail account") deserves the same deterministic
// backstop every other consequential Gmail-domain intent in this file already gets, rather than
// depending on the model reliably picking gmail.disconnect_propose over, say, gmail.rule.propose_
// update every single time. Deliberately excludes any message also containing "for" — "stop using
// Gmail FOR my job search" names a specific goal/rule, not the whole account, and belongs to
// gmail.rule.propose_update instead; a real disconnect never names what it's "for."
const GMAIL_DISCONNECT_RE =
  /\b(disconnect|remove|unlink)\b[\s\S]{0,20}\b(gmail|mail|email)\b|\bstop using\b[\s\S]{0,15}\bgmail\b[\s\S]{0,15}\baccount\b/i;
const GMAIL_DISCONNECT_GOAL_SCOPED_RE = /\bfor\b/i;
// fix/private-alpha-conversation-kernel-context-routing: defense-in-depth only — the new
// gmailReviewBulkTriageShortcut above already claims "remove all mail reviews"-shaped messages
// before this function is ever reached, but this exclusion keeps this function itself honest
// (and safe on its own) in case something ever changes the dispatch order — "mail/email/gmail
// reviews" always means the review QUEUE, never the account.
const GMAIL_DISCONNECT_REVIEW_SCOPED_RE = /\breviews?\b/i;

function gmailDisconnectShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text || !GMAIL_DISCONNECT_RE.test(text) || GMAIL_DISCONNECT_GOAL_SCOPED_RE.test(text) || GMAIL_DISCONNECT_REVIEW_SCOPED_RE.test(text)) {
    return undefined;
  }
  return { tool: "gmail.disconnect_propose", args: {}, rationale: "user asked to disconnect/remove/unlink Gmail" };
}

// Only the crystal-clear, unambiguous "switch the whole account" phrasings — "use my job mail for
// this goal"/"connect my job email for job search"-shaped requests are inherently goal-driven and
// stay with the real planner (guided by gmail.switch_account_propose's own catalog description,
// which tells it explicitly to check whether Gmail is already connected to a plausibly different
// account before choosing between this and a fresh gmail.goal_watcher.propose_enable).
// fix/private-alpha-gmail-review-llm-instruction-routing: widened for two real reported gaps —
// (1) "change my MAIL account"/"switch my EMAIL account" (not literally "gmail") were missed
// entirely since the old first disjunct required the literal word "gmail"; (2) "I wanna
// disconnect my mail and connect a new one" is unambiguous switch intent (disconnect the old,
// connect a new one) but has neither "switch"/"change" nor "different account" wording — the
// 3rd/4th disjuncts below catch this compound "disconnect ... connect (a) new one" shape and the
// bare "connect (a) new gmail/mail/email" shape respectively. This function has no connection-
// state context to check, but that's fine: gmail.switch_account_propose's own executor already
// handles "nothing was connected yet" gracefully (a direct connect link, no confirmation needed —
// see the "switch when Gmail is not connected at all" test), so routing here is always safe
// regardless of current state.
const GMAIL_SWITCH_ACCOUNT_RE =
  /\b(change|switch)\b[\s\S]{0,15}\b(gmail|mail|email)\b[\s\S]{0,15}\baccount\b|\buse\b[\s\S]{0,10}\ba different\b[\s\S]{0,10}\bgmail\b[\s\S]{0,10}\baccount\b|\bdisconnect\b[\s\S]{0,15}\b(gmail|mail|email)\b[\s\S]{0,30}\bconnect\b[\s\S]{0,20}\b(a\s+)?(new|different|another)\s+one\b|\bconnect\b[\s\S]{0,10}\b(a\s+)?new\b[\s\S]{0,10}\b(gmail|mail|email)\b/i;

function gmailSwitchAccountShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text || !GMAIL_SWITCH_ACCOUNT_RE.test(text)) {
    return undefined;
  }
  return { tool: "gmail.switch_account_propose", args: {}, rationale: "user asked to change/switch their connected Gmail account" };
}

// fix/private-alpha-pending-action-refinement-and-gmail-rule-ux: a real Telegram transcript had a
// pending action.create proposal ("Research 5 new remote Web3 job postings today") completely
// ignored — "change it to send 5 CVs its more direct and i wanna connect my mail so u can use it
// for updates" only ever got a Gmail-connection reply, because gmailConnectionShortcutOperation
// (unlike its sibling shortcuts, e.g. bulkActionCleanupShortcutOperation/
// gmailNudgeSettingsShortcutOperation, both explicitly gated on `!pending`) runs unconditionally
// and hijacks the ENTIRE turn before the planner — which is the only place a "change it to X"
// revision could otherwise be understood — ever gets a chance to run. Action refinement must win
// first; see ACTION_REFINEMENT_TRIGGER_RE's own call site in processAgentMessageInner for the
// deterministic, non-LLM-dependent guarantee of that ordering.
const ACTION_REFINEMENT_TRIGGER_RE =
  /\b(?:change|update)\s+it\s+to\b\s*|\bmake\s+it\b\s*|\binstead\s+do\b\s*|\bdo\s+instead\b\s*|\bcanvia-?ho\s+a\b\s*|\bc[aá]mbialo\s+a\b\s*/i;

// Cuts the extracted tail before a justification/continuation clause the user tacked on — "its
// more direct and i wanna connect my mail..." is the REASON and a SEPARATE request, not part of
// the new action text itself. Deliberately narrow (not a general clause splitter): only the
// specific connector words a real reported message actually used, so a legitimately longer
// refinement ("change it to send 5 CVs and call 2 recruiters") is never truncated by accident —
// none of "and i"/"its"/"because"/"since" appear in that phrasing.
const REFINEMENT_TAIL_CUTOFF_RE = /\b(its|it's|because|since|and i\b|and I\b|so u\b|so you\b|ya que|porque|perque|perquè)\b/i;
const ORIGINAL_TITLE_TRAILING_TEMPORAL_RE = /\s+(today|tomorrow|tonight|this week)\.?\s*$/i;
const REFINED_TEXT_HAS_TEMPORAL_RE = /\b(today|tomorrow|tonight|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/** Returns the new title if `message` matches a refinement trigger, otherwise undefined. Carries
 * over the ORIGINAL proposed action's own temporal framing ("...today") when the user's new text
 * doesn't specify its own timing — refining WHAT to do shouldn't silently drop WHEN, matching the
 * real reported expectation ("change it to send 5 CVs" -> "Send 5 CVs today", not just "Send 5
 * CVs", carried over from "Research 5 new remote Web3 job postings today"). */
function extractRefinedActionTitle(message: string, originalTitle: string): string | undefined {
  const match = ACTION_REFINEMENT_TRIGGER_RE.exec(message.toLowerCase());
  if (!match) {
    return undefined;
  }

  let tail = message.slice(match.index + match[0].length);
  const boundary = REFINEMENT_TAIL_CUTOFF_RE.exec(tail);
  if (boundary) {
    tail = tail.slice(0, boundary.index);
  }
  tail = tail.trim().replace(/[.,;:!?]+$/, "").trim();
  if (!tail) {
    return undefined;
  }

  const capitalized = tail.charAt(0).toUpperCase() + tail.slice(1);
  if (REFINED_TEXT_HAS_TEMPORAL_RE.test(capitalized)) {
    return capitalized;
  }
  const temporalSuffix = ORIGINAL_TITLE_TRAILING_TEMPORAL_RE.exec(originalTitle)?.[0];
  return temporalSuffix ? `${capitalized}${temporalSuffix.replace(/\.$/, "")}` : capitalized;
}

const PENDING_ACTION_REMINDER_LINE = "You still have the proposed action pending. Reply yes to create it or cancel.";

/**
 * Runs BEFORE any Gmail-domain shortcut, exactly when session.pendingOperation is a not-yet-
 * confirmed action.create proposal (topic "action_creation"). Handles three cases, per the
 * product rule that action refinement always wins and Gmail help must never clear or replace the
 * pending action:
 *   1. Refinement text present (with or without Gmail mention) -> update the pending proposal's
 *      title in place, keep it pending, optionally append Gmail connect/status help.
 *   2. Gmail mention only, no refinement -> show Gmail help, remind the user the action proposal
 *      is still waiting, leave it completely untouched.
 *   3. Neither -> undefined, falls through to the existing planner/shortcut flow unchanged.
 */
async function pendingActionRefinementResponse(context: ContextBundle, message: string): Promise<AgentMessageResponse | undefined> {
  const pending = context.session.pendingOperation;
  if (pending?.topic !== "action_creation") {
    return undefined;
  }

  const originalOp = pending.operations.find((op) => op.tool === "action.create");
  const originalTitle = typeof originalOp?.args.title === "string" ? originalOp.args.title : undefined;
  const refinedTitle = originalTitle ? extractRefinedActionTitle(message, originalTitle) : undefined;
  const gmailIntent = detectGmailConnectionIntent(message, context);

  if (!refinedTitle && !gmailIntent) {
    return undefined;
  }

  // Computed BEFORE the pending operation is touched, so gmail.status's own pendingOperationUpdate
  // safety check (executor.ts's `canProposeRuleNow`) still sees the action proposal as the current
  // pending operation and correctly declines to install a second, competing one — see this
  // function's own doc comment and executor.ts's gmail.status case for the full reasoning.
  const gmailStatusOp: ValidatedOperation = { tool: "gmail.status", args: { includeLink: gmailIntent?.includeLink ?? false }, status: "valid", requiresConfirmation: false };
  const gmailExecuted = gmailIntent ? await executeOperation(context.session.userId, gmailStatusOp, context, message) : undefined;

  const replyLines: string[] = [];
  const executedOps: ExecutedOperation[] = [];

  if (refinedTitle) {
    const refinedOp: ValidatedOperation = { ...originalOp!, args: { ...originalOp!.args, title: refinedTitle } };
    setPendingOperation(
      context.session,
      createPendingOperationRecord("action_creation", `create the action "${refinedTitle}"`, [refinedOp])
    );
    replyLines.push(`Good — I'll change the proposed action to:\n\n${refinedTitle}.\n\nReply yes to create it or cancel.`);
    executedOps.push({ tool: "action.refine_pending", status: "executed", summary: `Refined pending action to "${refinedTitle}"` });
  } else {
    // Gmail mention only — the pending action is left completely untouched (setPendingOperation
    // is never called), so it survives byte-for-byte; only the reminder line makes that visible.
    replyLines.push(PENDING_ACTION_REMINDER_LINE);
  }

  if (gmailExecuted) {
    replyLines.push(gmailExecuted.summary);
    executedOps.push(gmailExecuted);
  }

  return finalize(context, {
    reply: replyLines.join("\n\n"),
    operationsPlanned: [],
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: "action_creation"
  });
}

// fix/private-alpha-pending-action-refinement-and-gmail-rule-ux: "do u use my mail now for my
// goal?" got the same generic connection/rule status text as any other Gmail question — see
// composeGmailGoalUsageStatusReply's own doc comment for the real reported gap this closes.
// Deliberately narrow: only a genuine "do you use/are you using Gmail/mail FOR [my] GOAL"
// question, in English/Spanish/Catalan, not a general "is Gmail connected?" (that stays
// gmailConnectionShortcutOperation's job, unchanged).
const GMAIL_GOAL_USAGE_QUESTION_RE =
  /\b(do|does|are)\b[\s\S]{0,15}\b(you|u)\b[\s\S]{0,20}\b(use|using|uses|update|updates|updating)\b[\s\S]{0,30}\b(gmail|mail|email)\b[\s\S]{0,30}\bgoal\b|\b(usas|usa|utilizas)\b[\s\S]{0,20}\b(mi|el)\s+(mail|correo|gmail)\b[\s\S]{0,20}\bobjetivo\b|\b(fas servir|uses)\b[\s\S]{0,20}\b(el meu|mail|correu|gmail)\b[\s\S]{0,20}\bobjectiu\b/i;

async function gmailGoalUsageStatusResponse(context: ContextBundle, message: string): Promise<AgentMessageResponse | undefined> {
  if (!GMAIL_GOAL_USAGE_QUESTION_RE.test(message)) {
    return undefined;
  }

  const { text, pendingOperationUpdate } = await composeGmailGoalUsageStatusReply(context.session.userId, context);
  // fix/private-alpha-local-date-focus-and-gmail-confirmation-state: this used to call
  // setPendingOperation unconditionally whenever a rule proposal was available — a real reported
  // bug had this silently REPLACE a still-open pendingOperation (e.g. a not-yet-confirmed pending
  // action.create) with the Gmail rule proposal, so a "yes" the user meant for the action instead
  // confirmed enabling the rule. A pure status QUESTION must never do that: it may only install
  // its own proposal when nothing else is already waiting on a "yes", or when re-asking refreshes
  // the SAME proposal that was already the active one — exactly the same guard executor.ts's own
  // gmail.status case already applies (`canProposeRuleNow`), just duplicated here since this path
  // composes its reply directly rather than going through executeOperation.
  const existingPending = context.session.pendingOperation;
  const canProposeRuleNow = !existingPending || existingPending.topic === "gmail_rule_proposal";
  if (pendingOperationUpdate && canProposeRuleNow) {
    setPendingOperation(context.session, createPendingOperationRecord(pendingOperationUpdate.topic, pendingOperationUpdate.summary, pendingOperationUpdate.operations));
  }
  const reply =
    pendingOperationUpdate && !canProposeRuleNow && existingPending
      ? `${text}\n\nYou still have a pending confirmation waiting. Reply yes or cancel for that first.`
      : text;

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps: [
      { tool: "gmail.status", status: "executed", summary: text, ...(pendingOperationUpdate && canProposeRuleNow ? { pendingOperationUpdate } : {}) }
    ],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: canProposeRuleNow ? "gmail_status" : context.session.topic ?? "gmail_status"
  });
}

// refactor/private-alpha-general-email-intelligence-workflow: "sync mail and review," "sync gmail
// and show me reviews," "check email and review it" — a genuine compound request, distinct from
// "refresh email reviews" (queue-reclassification only, no real sync — GMAIL_REVIEW_REFRESH_RE
// elsewhere already owns that). Requires an explicit sync verb AND an explicit review/list verb in
// the SAME message, not just the bare word "review" appearing incidentally.
const GMAIL_SYNC_AND_REVIEW_RE =
  /\b(sync|check|refresh|update)\b[\s\S]{0,20}\b(gmail|email|emails|mail|mails|correo|correos)\b[\s\S]{0,30}\b(and|then|y|i)\b[\s\S]{0,15}\b(review|reviews|revisa|revisar)\b/i;

function gmailSyncAndReviewShortcutOperation(message: string): PlannedOperation[] | undefined {
  const text = normalizeIntentText(message);
  if (!text || !GMAIL_SYNC_AND_REVIEW_RE.test(text)) {
    return undefined;
  }
  return [
    { tool: "gmail.sync", args: {}, rationale: "user explicitly asked to sync Gmail as part of a sync-and-review request" },
    { tool: "gmail.review.list", args: { status: "pending" }, rationale: "user explicitly asked to review after syncing, in the same request" }
  ];
}

function gmailSyncShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);

  if (!text || looksLikeGmailAlertSettingsRequest(text)) {
    return undefined;
  }

  // "check Gmail every hour"/"check email sync every 1h" and "when do you check Gmail?" all
  // otherwise satisfy the "check ... gmail" pattern below (its trailing now/new group is
  // optional) and were being misrouted into an immediate one-off gmail.sync instead of the
  // scheduled-sync preference or status query they're actually asking for. Both defer to
  // gmailAutonomyStatusShortcutOperation/gmailAutonomyCompoundShortcutOperations instead.
  if (looksLikeGmailAutonomyStatusQuery(text)) {
    return undefined;
  }

  // fix/private-alpha-email-review-resolution-and-stale-classification (Task 6): "refresh email
  // reviews"/"recheck my reviews" is unambiguously about the review QUEUE (gmail.review.refresh,
  // reclassifying stale rows), never a request to re-sync the mailbox — defers to
  // GMAIL_REVIEW_REFRESH_RE below rather than matching the much broader sync-word regex further down.
  if (/\breviews?\b/.test(text)) {
    return undefined;
  }
  const autonomyPreference = parseGmailAutonomyPreferenceForAgentRuntime(message);
  if (autonomyPreference && (autonomyPreference.kind === "scheduled" || autonomyPreference.kind === "manual_only")) {
    return undefined;
  }

  // fix/private-alpha-gmail-review-llm-instruction-routing: the last disjunct used to allow "new"/
  // "now"/"ahora" to appear ANYWHERE within 35 characters after a bare mail-word, with no check on
  // what "new" actually modified — "I wanna disconnect my mail and connect a NEW ONE" matched
  // purely because "mail" and "new" both appear in the sentence, even though "new" describes a new
  // ACCOUNT, not new mail. "new"/"nuevos" must now directly modify a mail-word (adjacent, "new
  // email"/"nuevos correos"), and "now"/"ahora" keep a much tighter gap — genuine urgency wording
  // ("check gmail now") is always close to the mail-word, unlike an unrelated noun elsewhere in a
  // longer sentence. Gated on the switch/disconnect shortcuts running first either way (see their
  // own call sites above), so this is deliberately belt-and-suspenders, not the only fix.
  const explicitSync =
    /\b(sync|refresh|update)\b[\s\S]{0,30}\b(gmail|email|emails|correo|correos|mail|mails)\b/.test(text) ||
    /\b(gmail|email|emails|correo|correos|mail|mails)\b[\s\S]{0,30}\b(sync|refresh|update)\b/.test(text) ||
    /\b(check|look for|buscar|busca|revisar|revisa)\b[\s\S]{0,35}\b(gmail|email|emails|correo|correos|mail|mails)\b[\s\S]{0,25}\b(now|new|nuevos?|ahora)?\b/.test(text) ||
    /\bnew\s+(gmail|emails?|correos?|mails?)\b|\bnuevos?\s+correos?\b/.test(text) ||
    /\b(gmail|email|emails|correo|correos|mail|mails)\b[\s\S]{0,10}\b(now|ahora)\b/.test(text) ||
    /\b(now|ahora)\b[\s\S]{0,10}\b(gmail|email|emails|correo|correos|mail|mails)\b/.test(text);

  if (!explicitSync) {
    return undefined;
  }

  return { tool: "gmail.sync", args: {}, rationale: "user explicitly asked to sync Gmail/email now" };
}

function gmailSyncDebugShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);

  if (!text) {
    return undefined;
  }

  const asksDebug =
    /\bwhy\b[\s\S]{0,60}\bgmail\b[\s\S]{0,60}\b(find nothing|found nothing|no results|0 new|zero new|nothing)\b/.test(text) ||
    /\bshow\b[\s\S]{0,30}\bgmail\b[\s\S]{0,30}\bsync\b[\s\S]{0,20}\bdebug\b/.test(text) ||
    /\bgmail\b[\s\S]{0,30}\bsync\b[\s\S]{0,20}\bdebug\b/.test(text) ||
    /\bsync\b[\s\S]{0,20}\bgmail\b[\s\S]{0,20}\bdebug\b/.test(text);

  if (!asksDebug) {
    return undefined;
  }

  return { tool: "gmail.sync.debug", args: {}, rationale: "user asked for the last Gmail sync diagnostic summary" };
}

function gmailBuiltInRuleEnableShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text) {
    return undefined;
  }

  const asksToEnable = /\b(enable|turn on|activate|start|set up|setup|create|activa|activar|enciende|encender|pon|poner)\b/.test(text);
  if (!asksToEnable) {
    return undefined;
  }

  const mentionsRuleSurface =
    /\b(gmail|email|emails|correo|correos|mail|mails|rule|rules|tracking|check|one)\b/.test(text) || hasRecentGmailContext(context);
  if (!mentionsRuleSurface) {
    return undefined;
  }

  const mentionsJobSearch = /\b(job search|job-search|recruiter|recruiters|application|applications|cv|cvs|resume|resumes)\b/.test(text);
  const mentionsWorkAction = /\b(work action|work actions|work-action|work email|work emails|work requests?|deadlines?|follow-ups?|feedback requests?|blockers?)\b/.test(text);

  if (mentionsJobSearch && !mentionsWorkAction) {
    return { tool: "gmail.rule.enable_builtin", args: { kind: "job_search" }, rationale: "user asked to enable job-search Gmail tracking" };
  }

  if (mentionsWorkAction && !mentionsJobSearch) {
    return { tool: "gmail.rule.enable_builtin", args: { kind: "work_action" }, rationale: "user asked to enable work-action Gmail tracking" };
  }

  return undefined;
}

function gmailNudgeSettingsShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!looksLikeGmailAlertSettingsRequest(text)) {
    return undefined;
  }

  if (/\b(turn|switch|shut)\s+off\b|\b(stop|disable|desactiva|desactivar|para|deja)\b|\b(no more|don't|do not|dont|no me avises|no m avises)\b/.test(text)) {
    return { tool: "proactive.settings_propose_update", args: { gmailNudgeEnabled: false }, rationale: "user asked to turn off Gmail alerts" };
  }

  if (
    /\b(turn|switch|enable|activate|start)\s+(on\s+)?\b/.test(text) ||
    /\b(activa|activar|enciende|avisame|avisa me|notificame|notifica me)\b/.test(text) ||
    /\b(notify me|let me know|tell me|send me)\b/.test(text)
  ) {
    return { tool: "proactive.settings_propose_update", args: { gmailNudgeEnabled: true }, rationale: "user asked to turn on Gmail alerts" };
  }

  return undefined;
}

const GOAL_LIFECYCLE_PAUSE_RE = /\b(pause|pausa|pausar)\b/;
const GOAL_LIFECYCLE_ARCHIVE_VERB_RE = /\b(archive|archivar|archiva|delete|remove|elimina|eliminar|borra|borrar)\b/;
const GOAL_LIFECYCLE_STOP_TRACKING_RE = /\bstop tracking\b/;
const GOAL_LIFECYCLE_STOP_FOLLOWING_RE = /\b(deixa de seguir|deja de seguir)\b/;
const GOAL_LIFECYCLE_NOT_IMPORTANT_RE = /\b(not important anymore|ya no es importante|ja no es important)\b/;
const GOAL_LIFECYCLE_DONT_WANT_ANYMORE_RE = /\b(don'?t|dont) (?:want|wanna)[\s\S]{0,25}anymore\b|\bya no quiero\b|\bja no vull\b/;
const GOAL_WORD_RE = /\b(goal|goals|objetivo|objetivos|meta|metas|objectiu|objectius)\b/;
const GOAL_LIFECYCLE_BARE_PRONOUN_COMMAND_RE =
  /^(?:okay|ok|vale|va)?[,.\s]*(pause|archive|delete|remove|pausa|pausar|archiva|archivar|elimina|eliminar|borra|borrar)\s+(it|that|this|lo|la|ho)\.?$/;

// fix/private-alpha-goal-avoidance-action-bypass: a real-LLM eval caught "muévela a mañana a las
// 20:00" (an ordinary explicit action reschedule, carrying a digit so it skips
// actionCompletionShortcutOperation's own bare-pronoun shortcut by design) reaching the
// goal-avoidance guardrail's separate LLM classifier and getting misread as "pulling you away from
// your goal" — consistently, for this Spanish phrasing specifically, across repeated real-model
// runs. English and Catalan equivalents mostly passed, but only because the classifier's own
// judgment happened to land correctly more often for them; nothing deterministic protected any of
// them. Explicit action maintenance ("move it," "reschedule it," "muévela," "canvia-la") is never
// itself a signal of abandoning the underlying goal — the guardrail's classification prompt has no
// way to know that distinction reliably in every language, so this is caught deterministically
// instead, the same way every other unambiguous operational command already skips the guardrail
// (see goalLifecycleShortcutOperation and the Gmail domain shortcuts above). Narrow on purpose:
// matches only explicit action-mutation vocabulary, requires either a real visible action to attach
// to or an explicit "the action"/"la acción"/"l'acció" reference, and is unconditionally disqualified
// by ANY goal-abandonment wording — so a message like "archive the goal" or "ya no quiero este
// objetivo" is never affected (those are already handled by goalLifecycleShortcutOperation above,
// or correctly still reach the real guardrail here). This only ever NARROWS what reaches the
// guardrail, exactly like every other domain shortcut in this file — never widens what it blocks.
const ACTION_MUTATION_GUARDRAIL_BYPASS_RESULT: GuardrailResult = {
  decision: "allow",
  reply: null,
  matchedGoalId: null,
  matchedGoalTitle: null,
  matchedTrigger: null,
  pattern: null,
  reason: "explicit_action_mutation_bypass",
  llmAttempted: false
};
const ACTION_MUTATION_LANGUAGE_RE =
  /\b(move|reschedule|postpone|remind)\b|\bset it\b|\bset (?:this|that)\b|\bchange (?:the )?due\b|\bcomplete (?:it|this|that|the action)\b|\barchive (?:it|this|that|the action)\b|\bremove (?:it|this|that|the action)\b|\bmuevela\b|\bmuevelo\b|\bmoverla\b|\bmoverlo\b|\breprograma(?:rla|rlo)?\b|\bcambia(?:rla|rlo)?\b|\bpon(?:la|lo|erla|erlo)\b|\bmou-l[ao]\b|\bmou-ho\b|\bcanvia-l[ao]\b|\bcanvia-ho\b|\bposa-l[ao]\b|\bposa-ho\b/;
const ACTION_TARGET_REFERENCE_RE = /\b(the action|this action|that action|la accion|esta accion|l'?accio|aquesta accio)\b/;

/**
 * Deterministic "this is explicit action maintenance, not goal avoidance" bypass, checked
 * immediately before the goal-avoidance guardrail call at the main call site below. Never resolves
 * an operation itself (unlike the other domain shortcuts in this file) — it only decides whether
 * the goal-avoidance LLM classifier gets a turn at all; the real planner + validator + execution
 * pipeline runs completely unchanged either way, so nothing here ever mutates state directly.
 */
function isExplicitActionMutationGuardrailBypass(message: string, context: ContextBundle): boolean {
  const text = normalizeIntentText(message);
  if (!text) {
    return false;
  }

  // Any goal-abandonment signal disqualifies the bypass unconditionally — explicit action
  // maintenance language is never allowed to override a real "I want to stop pursuing this."
  if (
    GOAL_WORD_RE.test(text) ||
    GOAL_LIFECYCLE_DONT_WANT_ANYMORE_RE.test(text) ||
    GOAL_LIFECYCLE_STOP_TRACKING_RE.test(text) ||
    GOAL_LIFECYCLE_STOP_FOLLOWING_RE.test(text) ||
    GOAL_LIFECYCLE_NOT_IMPORTANT_RE.test(text)
  ) {
    return false;
  }

  if (!ACTION_MUTATION_LANGUAGE_RE.test(text)) {
    return false;
  }

  const hasVisibleAction = context.session.visibleEntities.some((entity) => entity.type === "action");
  return hasVisibleAction || ACTION_TARGET_REFERENCE_RE.test(text);
}

/**
 * Deterministic goal-lifecycle intent shortcut — checked BEFORE the goal-avoidance guardrail (see
 * the call site's comment) so "pause/archive/remove/delete THIS GOAL" is always recognized as an
 * operational goal-management command rather than reaching the guardrail's avoidance/lapse
 * classification, which has no way to distinguish "I don't want to keep tracking this" from "I'm
 * avoiding the underlying activity." Deliberately narrow: fires only when the message names a
 * goal explicitly ("my Meditations goal," "stop tracking X") or uses a bare pronoun command
 * ("okay pause it") while a real goal is already the conversation's focus — never for a stray
 * "delete it"/"pause it" with no established goal context, which could just as easily mean an
 * email, a Gmail rule, or a task. goalRef is left undefined whenever no explicit name was
 * captured, which resolveGoalForLifecycleAction/resolveActiveGoalReference already treat exactly
 * like a pronoun reference (falls back to the conversation's current focus, or asks/declines if
 * there isn't one) — so a pronoun-shaped request never needs to be text-matched here at all.
 */
async function goalLifecycleShortcutOperation(message: string, context: ContextBundle): Promise<PlannedOperation | undefined> {
  if (context.activeGoals.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  if (!text) {
    return undefined;
  }

  const stopTracking = GOAL_LIFECYCLE_STOP_TRACKING_RE.test(text);
  const stopFollowing = GOAL_LIFECYCLE_STOP_FOLLOWING_RE.test(text);
  const notImportant = GOAL_LIFECYCLE_NOT_IMPORTANT_RE.test(text);
  const dontWantAnymore = GOAL_LIFECYCLE_DONT_WANT_ANYMORE_RE.test(text);
  const archiveVerb = GOAL_LIFECYCLE_ARCHIVE_VERB_RE.test(text);
  const pauseVerb = GOAL_LIFECYCLE_PAUSE_RE.test(text);

  const isArchive = archiveVerb || stopTracking || stopFollowing || notImportant || dontWantAnymore;
  const isPause = pauseVerb && !isArchive;

  if (!isArchive && !isPause) {
    return undefined;
  }

  const goalWordPresent = GOAL_WORD_RE.test(text);
  const bareCommandMatch = GOAL_LIFECYCLE_BARE_PRONOUN_COMMAND_RE.test(text);
  const focusedGoal = bareCommandMatch ? resolveCurrentFocusGoal(context) : undefined;

  if (!goalWordPresent && !stopTracking && !stopFollowing && !(bareCommandMatch && focusedGoal)) {
    return undefined;
  }

  // fix/private-alpha-action-archive-targeting: a real live-trust bug — "archive it" right after
  // an overdue ACTION reminder resolved here instead, via focusedGoal (session.focusedEntities.goal
  // is sticky across turns and survives the reminder untouched), and silently archived the WHOLE
  // GOAL plus its linked actions instead of the one visible action the user was actually replying
  // about. A bare pronoun command with NO explicit goal word ("archive it," never "archive my job
  // search goal") must never out-rank a more specific, currently-relevant ACTION target. Skipped
  // entirely when a GOAL is what's actually currently visible (e.g. right after "show my goals") —
  // an earlier same-day action reminder must not block an otherwise-unambiguous goal-lifecycle
  // command in that case (Task 3D: "archive the goal" explicitly, or after a goal list, still
  // resolves the goal). resolveMostRecentlyNotifiedOrVisibleActionId is the SAME ground-truth
  // resolver actionCompletionShortcutOperation below already uses for "archive it"/"done"/"move it
  // to tomorrow" — reusing it here (rather than a separate check) guarantees this gate and that
  // resolver always agree on what "it" means.
  if (bareCommandMatch && !goalWordPresent) {
    const visibleGoalEntity = context.session.visibleEntities.some((entity) => entity.type === "goal");
    if (!visibleGoalEntity) {
      const competingAction = await resolveMostRecentlyNotifiedOrVisibleActionId(context);
      if (competingAction) {
        return undefined;
      }
    }
  }

  let goalRef: string | undefined;
  const stopTrackingMatch = text.match(/\bstop tracking\s+(.+)$/);
  if (stopTrackingMatch) {
    goalRef = stopTrackingMatch[1].replace(/[.!?]+$/, "").trim();
  } else {
    const namedMatch = text.match(/\b(?:my|the)\s+(.+?)\s+goals?\b/);
    if (namedMatch) {
      goalRef = namedMatch[1].trim();
    } else {
      // Spanish/Catalan name the goal AFTER the word for "goal" ("objetivo/objectiu/meta de X"),
      // reversed from English's "my X goal" above — a real RC smoke run caught "vull pausar el
      // meu objectiu de lectura" ("I want to pause my reading goal") extracting no goalRef at all
      // under the English-only pattern, silently failing to resolve on a fresh session with no
      // established conversation focus to fall back on.
      const esCaMatch = text.match(/\b(?:objetivo|objectiu|meta)\s+(?:de|d')\s*(.+?)[.!?]*$/);
      if (esCaMatch) {
        goalRef = esCaMatch[1].trim();
      }
    }
  }

  return {
    tool: "goal.archive_propose",
    args: { goalRef, operation: isPause ? "pause" : "archive" },
    rationale: `deterministic goal lifecycle shortcut: ${isPause ? "pause" : "archive"}`
  };
}

const GOAL_RESTORE_VERB_RE = /\b(restore|unarchive|un-archive|reactivate|restaura|restaurar|reactiva|reactivar)\b/;

/**
 * fix/private-alpha-action-archive-targeting: deterministic restore/unarchive/reactivate intent —
 * always routes to goal.restore_propose, never leaves "restore my job search goal" to the LLM
 * planner's own judgment call (which, on the real reported transcript, chose goal.create_propose
 * instead — offering to CREATE a new goal rather than recognizing this as recovering an existing,
 * archived one). goalRef extraction is deliberately forgiving (strips a leading verb, "the
 * goal"/"my"/"the" filler, a trailing bare "goal", and surrounding quotes) since goal.restore_
 * propose's own resolveActiveGoalReference call does the real fuzzy title matching — this only
 * needs to hand it a reasonable candidate string, never an exact one.
 */
function goalRestoreShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text || !GOAL_RESTORE_VERB_RE.test(text)) {
    return undefined;
  }

  let rest = text.replace(GOAL_RESTORE_VERB_RE, " ").trim();
  rest = rest.replace(/^(?:the\s+goal|my\s+goal|the|my)\s+/, "").trim();
  rest = rest.replace(/\s+goal$/, "").trim();
  rest = rest.replace(/^['"“”‘’]+|['"“”‘’]+$/g, "").trim();
  rest = rest.replace(/[.!?]+$/, "").trim();

  return {
    tool: "goal.restore_propose",
    args: { goalRef: rest.length > 0 ? rest : undefined },
    rationale: "deterministic goal restore shortcut"
  };
}

// fix/private-alpha-email-progress-count-and-review-ux (Task 4): question-shaped only, in English,
// Spanish, and Catalan, plus tolerance for a doubled-letter typo ("progrress") — every branch
// requires an actual interrogative/status-check shape, never just the bare word "today", so a real
// logging statement like "I sent 3 CVs today" never matches any of these.
const GOAL_TODAY_PROGRESS_RE =
  /\btoday'?s?\b[\s\S]{0,15}\bprogr+ess\b|\bhow many\b[\s\S]{0,50}\btoday\b|\bcu[aá]ntos?\b[\s\S]{0,50}\bhoy\b|\bhoy\b[\s\S]{0,20}\bcu[aá]ntos?\b|\bquants?\b[\s\S]{0,50}\bavui\b|\bavui\b[\s\S]{0,20}\bquants?\b/i;

// fix/private-alpha-email-progress-invariant-and-review-list-stability: the "this must never rely
// on the real planner for a pure progress question" rule applies just as much to a WEEK-scoped
// question as a day-scoped one — the exact live replay this task fixes includes "show this week
// goal progress" as its own turn. Same question-shaped-only guard as GOAL_TODAY_PROGRESS_RE above.
const GOAL_WEEK_PROGRESS_RE =
  /\bthis\s+week'?s?\b[\s\S]{0,15}\bprogr+ess\b|\bhow many\b[\s\S]{0,50}\bthis\s+week\b|\bcu[aá]ntos?\b[\s\S]{0,50}\besta\s+semana\b|\besta\s+semana\b[\s\S]{0,20}\bcu[aá]ntos?\b|\bquants?\b[\s\S]{0,50}\baquesta\s+setmana\b|\baquesta\s+setmana\b[\s\S]{0,20}\bquants?\b/i;

function goalTodayProgressShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text) {
    return undefined;
  }

  if (GOAL_TODAY_PROGRESS_RE.test(text)) {
    return {
      tool: "goal.status",
      args: { scope: "today" },
      rationale: "user asked a read-only question about today's progress specifically"
    };
  }

  if (GOAL_WEEK_PROGRESS_RE.test(text)) {
    return {
      tool: "goal.status",
      args: {},
      rationale: "user asked a read-only question about this week's progress specifically"
    };
  }

  return undefined;
}

function looksLikeGmailAlertSettingsRequest(text: string): boolean {
  return (
    /\bgmail\b[\s\S]{0,50}\b(nudge|nudges|alert|alerts|notification|notifications|notify|avisos?|notificaciones?|avisa|avises|avisame|notifica)\b/.test(text) ||
    /\b(nudge|nudges|alert|alerts|notification|notifications|notify|avisos?|notificaciones?|avisa|avises|avisame|notifica)\b[\s\S]{0,50}\bgmail\b/.test(text) ||
    /\b(email|emails|correo|correos|mail|mails)\b[\s\S]{0,50}\b(alert|alerts|notification|notifications|notify|avisos?|notificaciones?|avisa|avises|avisame|notifica|important|importantes)\b/.test(text) ||
    /\b(alert|alerts|notification|notifications|notify|avisos?|notificaciones?|avisa|avises|avisame|notifica|important|importantes)\b[\s\S]{0,50}\b(email|emails|correo|correos|mail|mails)\b/.test(text) ||
    /\b(tell me|let me know|notify me|avisame|avisa me|no me avises|notificame|notifica me)\b[\s\S]{0,50}\b(email|emails|correo|correos|gmail)\b/.test(text) ||
    /\bgmail review\b[\s\S]{0,40}\b(notification|notifications|alert|alerts|nudge|nudges|aviso|avisos)\b/.test(text)
  );
}

function hasRecentGmailContext(context: ContextBundle): boolean {
  if (context.session.topic?.includes("gmail")) {
    return true;
  }
  if (context.session.pendingOperation?.summary.toLowerCase().includes("gmail")) {
    return true;
  }
  return context.session.messages.slice(-8).some((entry) => /\bgmail\b|\bemail rules?\b|\bemail reviews?\b/.test(entry.text.toLowerCase()));
}

function normalizeIntentText(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

async function finalizeNoPendingReply(context: ContextBundle, tool: string): Promise<AgentMessageResponse> {
  return finalize(context, {
    reply: NO_PENDING_REPLY,
    operationsPlanned: [],
    executedOps: [{ tool, status: "skipped", summary: NO_PENDING_REPLY }],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: context.session.topic
  });
}

async function finalizeDeterministicConfirmation(context: ContextBundle, message: string): Promise<AgentMessageResponse> {
  const { userId } = context.session;
  const pending = context.session.pendingOperation as AgentPendingOperation;
  const pendingOperationBefore = pending;
  const visibleEntitiesBefore = context.session.visibleEntities;

  const revalidated = pending.operations.map((op) => revalidateForExecution(op));
  const readyOps = revalidated.filter((op) => op.status === "valid");
  const brokenOps = revalidated.filter((op) => op.status !== "valid");

  const executedOps = await Promise.all(readyOps.map((op) => executeOperation(userId, op, context, `[confirmed] ${pending.summary}`)));
  // A real Telegram smoke test found the post-goal-creation daily-coaching follow-up asking a
  // confirmation-shaped question with nothing actually pending behind it — the CAUSE turned out to
  // be right here: applyExecutionSideEffects had already installed a genuine NEW pendingOperation
  // (goal.create_apply's own pendingOperationUpdate, proposing to turn on proactive settings next),
  // but the very next line unconditionally cleared it back to null regardless. Confirming one
  // operation is allowed to hand off to a real, new one of its own (goal creation -> proactive
  // settings) — only clear to null when nothing new was installed, exactly the prior behavior for
  // every other confirm flow (none of which install a pendingOperationUpdate on their own apply step).
  const installedNewPendingOperation = executedOps.some((op) => op.pendingOperationUpdate !== undefined && op.pendingOperationUpdate !== null);
  applyExecutionSideEffects(context.session, executedOps);
  if (!installedNewPendingOperation) {
    setPendingOperation(context.session, null);
  }

  const reply = composeReply({
    replyDraft: "",
    pendingConfirmationOps: [],
    executedOps,
    problemOps: brokenOps
  });

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: undefined,
      validatedOp: readyOps[0] ?? brokenOps[0],
      executedOp: executedOps.find((op) => isPlanningTool(op.tool)),
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: inferComposerSource({ pendingConfirmationOps: [], executedOps, problemOps: brokenOps, replyDraft: "" })
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: pending.operations.map((op) => ({ tool: op.tool, args: op.args })),
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: brokenOps.length === 0,
    topic: pending.topic,
    planningTrace
  });
}

/**
 * fix/private-alpha-live-action-and-coaching-regressions (Task 4): applies a pending
 * action.create exactly once — the same revalidate/execute/apply-side-effects shape as
 * finalizeDeterministicConfirmation — and, only when the SAME message also asks to see the
 * actions list (ACTION_CREATION_TRAILING_LIST_RE), runs one action.list right after in the same
 * turn and folds both results into a single reply. Never calls the real LLM planner for either
 * half, so there is no way for a second action.create to get re-planned for the same title the
 * way the real transcript's duplicate bug happened.
 */
async function finalizeActionCreationConfirmation(context: ContextBundle, message: string): Promise<AgentMessageResponse> {
  const { userId } = context.session;
  const pending = context.session.pendingOperation as AgentPendingOperation;
  const pendingOperationBefore = pending;
  const visibleEntitiesBefore = context.session.visibleEntities;

  const revalidated = pending.operations.map((op) => revalidateForExecution(op));
  const readyOps = revalidated.filter((op) => op.status === "valid");
  const brokenOps = revalidated.filter((op) => op.status !== "valid");

  const executedOps = await Promise.all(readyOps.map((op) => executeOperation(userId, op, context, `[confirmed] ${pending.summary}`)));
  const installedNewPendingOperation = executedOps.some((op) => op.pendingOperationUpdate !== undefined && op.pendingOperationUpdate !== null);
  applyExecutionSideEffects(context.session, executedOps);
  if (!installedNewPendingOperation) {
    setPendingOperation(context.session, null);
  }

  // Only chains a trailing list request when the create itself didn't hand off to a brand-new
  // pending operation of its own (e.g. a goal-link follow-up) — same reasoning as the pending-
  // clear guard just above: something else is now waiting on a "yes," so a list here would talk
  // past it.
  if (!installedNewPendingOperation && ACTION_CREATION_TRAILING_LIST_RE.test(message)) {
    const [listOp] = validateOperations([{ tool: "action.list", args: {} }], context, message);
    if (listOp?.status === "valid") {
      const executedListOp = await executeOperation(userId, listOp, context, message);
      applyExecutionSideEffects(context.session, [executedListOp]);
      executedOps.push(executedListOp);
    }
  }

  const reply = composeReply({
    replyDraft: "",
    pendingConfirmationOps: [],
    executedOps,
    problemOps: brokenOps
  });

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: undefined,
      validatedOp: readyOps[0] ?? brokenOps[0],
      executedOp: executedOps.find((op) => isPlanningTool(op.tool)),
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: inferComposerSource({ pendingConfirmationOps: [], executedOps, problemOps: brokenOps, replyDraft: "" })
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: pending.operations.map((op) => ({ tool: op.tool, args: op.args })),
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: brokenOps.length === 0,
    topic: pending.topic,
    planningTrace
  });
}

/**
 * feat/private-alpha-capability-proposal-queue: resolves a capability-proposal queue's SELECTIVE
 * reply ("only Gmail", "just daily coaching") — the same revalidate/execute/apply-side-effects
 * shape as finalizeDeterministicConfirmation, but scoped to just `selectedProposalIds` rather than
 * every operation in pending.operations. The unselected proposal(s) are never executed and never
 * re-offered (an explicit subset choice is a real answer, not a deferral) — named back to the user
 * instead ("Daily coaching stays off.") so "yes" always means what it was last clearly asked about
 * and nothing is silently dropped.
 */
async function finalizeCapabilityProposalSelection(
  context: ContextBundle,
  message: string,
  selectedProposalIds: string[]
): Promise<AgentMessageResponse> {
  const { userId } = context.session;
  const pending = context.session.pendingOperation as AgentPendingOperation;
  const pendingOperationBefore = pending;
  const visibleEntitiesBefore = context.session.visibleEntities;

  const toRun = pending.operations.filter((op) => op.proposalId && selectedProposalIds.includes(op.proposalId));
  const skipped = pending.operations.filter((op) => !(op.proposalId && selectedProposalIds.includes(op.proposalId)));

  const revalidated = toRun.map((op) => revalidateForExecution(op));
  const readyOps = revalidated.filter((op) => op.status === "valid");
  const brokenOps = revalidated.filter((op) => op.status !== "valid");

  const executedOps = await Promise.all(readyOps.map((op) => executeOperation(userId, op, context, `[confirmed] ${pending.summary}`)));
  applyExecutionSideEffects(context.session, executedOps);
  setPendingOperation(context.session, null);

  // fix/private-alpha-launch-hardening-flakes-and-pending-clarity (Task 4): an explicit subset
  // choice ("only Gmail") is a real answer for the unselected side too — record it as deferred
  // (never permanently rejected) so a future automatic re-offer for the SAME goal can skip asking
  // again this session, without blocking a later EXPLICIT direct request ("turn on daily
  // coaching"), which never consults this at all.
  for (const op of skipped) {
    if (op.proposalId && op.proposalGoalId) {
      recordDeferredCapabilityProposal(context.session, op.proposalId, op.proposalGoalId);
    }
  }

  const skippedNote = skipped.length > 0 ? skipped.map((op) => `${op.proposalLabel ?? op.tool} stays off for now.`).join(" ") : undefined;
  const baseReply = composeReply({
    replyDraft: "",
    pendingConfirmationOps: [],
    executedOps,
    problemOps: brokenOps
  });
  const reply = [baseReply, skippedNote].filter(Boolean).join(" ");

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: undefined,
      validatedOp: readyOps[0] ?? brokenOps[0],
      executedOp: executedOps.find((op) => isPlanningTool(op.tool)),
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: inferComposerSource({ pendingConfirmationOps: [], executedOps, problemOps: brokenOps, replyDraft: "" })
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: toRun.map((op) => ({ tool: op.tool, args: op.args })),
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: brokenOps.length === 0,
    topic: pending.topic,
    planningTrace
  });
}

/**
 * fix/private-alpha-launch-hardening-flakes-and-pending-clarity (Task 2): an ambiguous reply to an
 * open capability-proposal queue ("maybe", "do the useful one", "enable it") — never applies
 * anything, never touches session.pendingOperation (the queue stays exactly as it was, so the very
 * next clear reply — "both"/"only Gmail"/"not now" — still resolves it correctly), and never calls
 * the planner to guess a mutation. The reply names the queue's own real proposal labels rather than
 * a hardcoded "Gmail"/"daily coaching" pair, so a third capability's clarification stays accurate
 * without any change here.
 */
async function finalizeCapabilityProposalClarification(context: ContextBundle, pending: AgentPendingOperation): Promise<AgentMessageResponse> {
  const labels = capabilityProposalLabels(pending);
  const onlyExamples = labels.map((label) => `"only ${label}"`).join(", ");
  const reply = `I'm not sure which capability you want. Say "both", ${onlyExamples}, or "not now".`;

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps: [{ tool: "confirmation.confirm", status: "skipped", summary: reply }],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: CAPABILITY_PROPOSALS_TOPIC
  });
}

/**
 * fix/private-alpha-goal-restore-ambiguity-resolution: a reply to an open restore-disambiguation
 * resolved to exactly ONE archived goal (by index, exact title, or recency) — NEVER restores it
 * immediately. Installs a fresh single-goal "goal_restore" confirmation instead, the exact same
 * final "I found 'X' archived. Restore it?" step the direct, unambiguous-match path already uses
 * (buildGoalRestoreConfirmationSummary in executor.ts), so a genuine "yes" is always required
 * before anything is actually restored — disambiguating which goal is not the same as confirming
 * the mutation.
 */
async function finalizeGoalRestoreDisambiguationSelection(
  context: ContextBundle,
  message: string,
  candidate: RestoreDisambiguationCandidate,
  timezone: string
): Promise<AgentMessageResponse> {
  const pendingOperationBefore = context.session.pendingOperation;
  const visibleEntitiesBefore = context.session.visibleEntities;

  const recency =
    candidate.archivedAt && formatDateInTimezone(new Date(candidate.archivedAt), timezone) === formatDateInTimezone(new Date(), timezone) ? " from today" : "";
  const reply = `I found the archived goal "${candidate.goalTitle}"${recency}. Restore it? Reply yes to confirm or cancel.`;

  setPendingOperation(
    context.session,
    createPendingOperationRecord("goal_restore", `restore "${candidate.goalTitle}"`, [
      { tool: "goal.restore_apply", args: { goalId: candidate.goalId, goalTitle: candidate.goalTitle }, status: "valid", requiresConfirmation: false }
    ])
  );

  const executedOps: ExecutedOperation[] = [{ tool: "goal.restore_propose", status: "executed", summary: reply }];
  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: undefined,
      validatedOp: undefined,
      executedOp: undefined,
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: "deterministic_shortcut"
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: "goal_restore",
    planningTrace
  });
}

/**
 * fix/private-alpha-goal-restore-ambiguity-resolution: an unrecognized reply to an open restore-
 * disambiguation — never applies anything, never clears the clarification (the user already saw
 * the full numbered list once; the next clear reply — a number, an exact title, "latest archived,"
 * "none," "cancel" — still resolves it), and never calls the planner to guess which archived goal
 * was meant.
 */
async function finalizeGoalRestoreDisambiguationClarification(context: ContextBundle, pending: AgentPendingOperation): Promise<AgentMessageResponse> {
  const reply = 'I\'m not sure which archived goal you mean. Reply with a number, an exact title, "latest archived", "latest created", "archived today", or "cancel".';

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps: [{ tool: "confirmation.confirm", status: "skipped", summary: reply }],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: pending.topic
  });
}

/**
 * fix/private-alpha-launch-hardening-flakes-and-pending-clarity (Task 5): "not now"/"cancel" on a
 * capability-proposal queue reads as a permanent "no" if it's answered with the generic
 * "Cancelled — I won't do that." — this topic-specific cancellation instead names what stays off
 * and how to ask for it later, and records every proposal in the queue as deferred (Task 4) the
 * same way a partial selection's unselected side already is.
 */
async function finalizeCapabilityProposalCancellation(context: ContextBundle, message: string): Promise<AgentMessageResponse> {
  const pending = context.session.pendingOperation as AgentPendingOperation;
  const pendingOperationBefore = pending;
  const visibleEntitiesBefore = context.session.visibleEntities;
  setPendingOperation(context.session, null);

  for (const op of pending.operations) {
    if (op.proposalId && op.proposalGoalId) {
      recordDeferredCapabilityProposal(context.session, op.proposalId, op.proposalGoalId);
    }
  }

  const labels = capabilityProposalLabels(pending);
  const laterSuggestions = labels.map((label) => `"turn on ${label.toLowerCase()}"`).join(" or ");
  const reply = `Okay — I won't enable ${labels.length > 1 ? "those" : "that"} now. You can say ${laterSuggestions} later.`;

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: undefined,
      validatedOp: undefined,
      executedOp: undefined,
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: "cancellation"
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps: [{ tool: "confirmation.cancel", status: "executed", summary: reply }],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: CAPABILITY_PROPOSALS_TOPIC,
    planningTrace
  });
}

async function finalizeDeterministicCancellation(context: ContextBundle, message: string): Promise<AgentMessageResponse> {
  const pending = context.session.pendingOperation as AgentPendingOperation;
  const pendingOperationBefore = pending;
  const visibleEntitiesBefore = context.session.visibleEntities;
  setPendingOperation(context.session, null);
  // Real Telegram smoke test: cancelling a "did you mean X?" action-reference suggestion used to
  // wipe visibleEntities unconditionally — so a NUMBERED follow-up right after ("complete action
  // 10 and 9 now") had nothing real to resolve against and fell back to context.openActions's own
  // DB ordering instead, silently completing the wrong tasks. The numbered list the user was
  // actually shown is the source of truth for a numbered reference and must survive cancelling an
  // unrelated ambiguity question about it — only cleared here for every OTHER kind of pending
  // operation (a Gmail rule proposal, a goal archive, a next-week plan draft, ...), where the
  // visible entities really were specific to that now-cancelled flow.
  const clearedVisibleEntities = pending.topic !== ACTION_CLARIFICATION_TOPIC;
  if (clearedVisibleEntities) {
    clearAllVisibleEntities(context.session);
  }
  logAgentRuntimeDiagnostics({
    phase: "cancellation",
    userId: context.session.userId,
    note: `cancelled pending topic="${pending.topic}"; visibleEntities ${clearedVisibleEntities ? "cleared" : "preserved"} (${visibleEntitiesBefore.length} entities)`
  });

  const reply = "Cancelled — I won't do that.";
  const executedOps: ExecutedOperation[] = [{ tool: "confirmation.cancel", status: "executed", summary: reply }];

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: undefined,
      validatedOp: undefined,
      executedOp: undefined,
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: "cancellation"
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: pending.topic,
    planningTrace
  });
}

const LEGACY_PENDING_ACTION_CONFIRM_REPLY =
  "I can't safely apply that kind of pending action from here yet. Reply with /confirm to complete it, or /cancel to drop it.";

async function finalizeLegacyPendingActionConfirm(context: ContextBundle): Promise<AgentMessageResponse> {
  // Deliberately does NOT call the legacy confirmPendingAction/applyPendingAction here: the
  // actual mutation logic (applyPendingAction) lives in server.ts, entangled with Gmail-rule and
  // action-hygiene helpers that aren't safely importable into agent-runtime without a circular
  // import back into server.ts. Marking it "confirmed" without running that logic would silently
  // skip the mutation the user is expecting — worse than doing nothing. The row is left untouched.
  return finalize(context, {
    reply: LEGACY_PENDING_ACTION_CONFIRM_REPLY,
    operationsPlanned: [],
    executedOps: [{ tool: "confirmation.confirm", status: "skipped", summary: LEGACY_PENDING_ACTION_CONFIRM_REPLY }],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: context.session.topic
  });
}

async function finalizeLegacyPendingActionCancel(
  context: ContextBundle,
  legacyPendingAction: PendingAction
): Promise<AgentMessageResponse> {
  // Safe to execute directly: rejecting a pending action only ever marks the row
  // status="rejected" — it never runs applyPendingAction's type-specific mutation logic, so
  // there's no entangled Gmail/action-hygiene behavior to reproduce here.
  await rejectPendingAction(context.session.userId, legacyPendingAction.id);
  const reply = "Cancelled. I did not change anything.";

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps: [{ tool: "confirmation.cancel", status: "executed", summary: reply }],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: context.session.topic
  });
}

async function finalizeLegacyPendingActionAmbiguous(
  context: ContextBundle,
  legacyPendingAction: PendingAction
): Promise<AgentMessageResponse> {
  const reply = `You have a pending action from the previous flow: ${legacyPendingAction.summary}. Confirm, cancel, or continue with a new request.`;

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps: [],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: context.session.topic
  });
}

interface FinalizeInput {
  reply: string;
  operationsPlanned: PlannedOperation[];
  executedOps: ExecutedOperation[];
  plannerUsed: AgentDebugInfo["plannerUsed"];
  llmPlannerAttempted: boolean;
  toolValidationPassed: boolean;
  topic: string | null;
  planningTrace?: PlanningTraceEntry;
}

async function finalize(context: ContextBundle, input: FinalizeInput): Promise<AgentMessageResponse> {
  const { session } = context;
  setTopic(session, input.topic);
  appendMessage(session, "assistant", input.reply);
  const needsConfirmation = Boolean(session.pendingOperation);

  await saveSession(session);

  return {
    reply: input.reply,
    operationsPlanned: input.operationsPlanned,
    operationsExecuted: input.executedOps,
    needsConfirmation,
    debug: {
      runtime: "agent_v3",
      plannerUsed: input.plannerUsed,
      llmPlannerAttempted: input.llmPlannerAttempted,
      llmPlannerUsed: input.plannerUsed === "llm",
      toolValidationPassed: input.toolValidationPassed,
      mutationExecuted: input.executedOps.some((op) => op.status === "executed" && getToolDefinition(op.tool)?.mutates),
      conversationTopic: input.topic,
      pendingOperation: needsConfirmation,
      legacyPendingActionDetected: Boolean(context.legacyPendingAction),
      ...(input.planningTrace ? { planningTrace: input.planningTrace } : {})
    }
  };
}

/**
 * Topic is derived primarily from which tools actually ran this turn — ground
 * truth, immune to the live LLM repeating a stale topic label. Turns with no
 * operations (e.g. "let me know when I receive one") keep the prior topic
 * rather than trusting a freeform LLM string, since that's almost always a
 * continuation of the same flow, not a new one.
 */
function resolveTopic(operations: PlannedOperation[], planTopic: string, sessionTopic: string | null): string {
  const inferred = inferTopicFromOperations(operations);
  if (inferred) {
    return inferred;
  }
  if (operations.length === 0 && sessionTopic) {
    return sessionTopic;
  }
  return planTopic || sessionTopic || "general";
}

function inferTopicFromOperations(operations: PlannedOperation[]): string | null {
  for (const op of operations) {
    if (op.tool === "gmail.rule.create") return "gmail_rule_creation";
    if (op.tool === "gmail.rule.list" || op.tool === "gmail.rule.explain") return "gmail_rules";
    if (op.tool.startsWith("gmail.rule.")) return "gmail_rule_management";
    if (op.tool.startsWith("gmail.review")) return "gmail_reviews";
    if (op.tool === "gmail.sync") return "gmail_sync";
    if (op.tool === "gmail.sync.debug") return "gmail_sync_debug";
    if (op.tool === "gmail.status") return "gmail_status";
    if (op.tool.startsWith("memory.")) return "memory";
    if (op.tool.startsWith("event.")) return "progress_logging";
    if (op.tool.startsWith("action.")) return "action_cleanup";
    if (op.tool.startsWith("planning.")) return "next_week_planning";
    if (op.tool.startsWith("weekly_review.")) return "weekly_review";
    if (op.tool.startsWith("daily_loop.")) return "daily_loop_settings";
    if (op.tool.startsWith("goal.")) return "goals";
    if (op.tool.startsWith("proactive.")) return "proactive_settings";
    if (op.tool.startsWith("operator.")) return "operator_summary";
  }
  return null;
}

/**
 * Deterministic, not LLM-driven: the guardrail module only ever returns a classification, never
 * touches the DB itself (see goal-guardrails.ts's doc comment) — this is the one place that
 * turns a detected conflict into a durable record, reusing the existing memory.create/
 * risk_pattern mechanism already read by insights/daily-review, rather than inventing new schema.
 */
async function logGuardrailIncident(userId: string, message: string, guardrail: GuardrailResult): Promise<ExecutedOperation> {
  const target = guardrail.matchedGoalTitle ? `goal "${guardrail.matchedGoalTitle}"` : guardrail.matchedTrigger ? `configured trigger "${guardrail.matchedTrigger}"` : "a guardrail";
  const created = await createMemory(userId, {
    type: "risk_pattern",
    summary: `Guardrail (${guardrail.decision}): "${message}" conflicted with ${target}.`,
    source: "system_inferred",
    confidence: 1,
    evidence: { message, decision: guardrail.decision, pattern: guardrail.pattern, matchedGoalId: guardrail.matchedGoalId, matchedTrigger: guardrail.matchedTrigger }
  });
  return { tool: "memory.create", status: "executed", summary: `Remembered: ${created.summary}`, result: created };
}

function applyExecutionSideEffects(session: AgentSessionState, executedOps: ExecutedOperation[]): void {
  const entities: AgentEntity[] = [];
  const removedEntityIds: string[] = [];

  for (const op of executedOps) {
    // Only tools that actually mutate belong in recentMutations. Recording read-only
    // executions here (e.g. operator.recent_changes itself) makes a "what changed?"
    // answer recurse into and duplicate its own prior answer on the next call.
    if (op.status === "executed" && getToolDefinition(op.tool)?.mutates === true) {
      recordMutation(session, op.summary);
    }
    if (op.entities) {
      entities.push(...op.entities);
    }
    if (op.removedEntityIds) {
      removedEntityIds.push(...op.removedEntityIds);
    }
    // See ExecutedOperation.pendingOperationUpdate — a multi-turn propose/edit/confirm tool
    // (e.g. planning.next_week_start/_edit) installs or replaces the session's pending
    // operation this way, decoupled from the requiresConfirmation-driven path below it.
    if (op.pendingOperationUpdate !== undefined) {
      setPendingOperation(
        session,
        op.pendingOperationUpdate === null
          ? null
          : createPendingOperationRecord(op.pendingOperationUpdate.topic, op.pendingOperationUpdate.summary, op.pendingOperationUpdate.operations)
      );
    }
  }

  if (entities.length > 0) {
    setVisibleEntities(session, dedupeEntities(entities));
    updateFocusedEntities(session, entities);
  }
  // Applied AFTER the wholesale replace above, on whatever visibleEntities ends up being this
  // turn — a turn could in principle both surface fresh entities (e.g. a duplicate-cleanup
  // action.list) and separately archive something else; pruning last means removedEntityIds
  // always wins for the specific ids it names, regardless of ordering within this turn's ops.
  if (removedEntityIds.length > 0) {
    removeVisibleEntities(session, removedEntityIds);
  }
}

/**
 * Merges this turn's entities into session.focusedEntities, one slot per entity type, last one
 * this turn wins. Deliberately separate from setVisibleEntities above: visibleEntities is
 * replaced wholesale every turn that returns any entity (right for a numbered list, which really
 * is gone once a new one is shown), but a "current goal" (or any other focused entity) must stay
 * put across turns whose own operations don't touch that type at all — see
 * types.ts's AgentFocusedEntities doc comment for why this fixed a real multi-turn goal bug.
 */
function updateFocusedEntities(session: AgentSessionState, entities: AgentEntity[]): void {
  const next = { ...session.focusedEntities };
  for (const entity of entities) {
    next[entity.type] = entity;
  }
  session.focusedEntities = next;
}

function dedupeEntities(entities: AgentEntity[]): AgentEntity[] {
  const seen = new Map<string, AgentEntity>();
  for (const entity of entities) {
    seen.set(`${entity.type}:${entity.id}`, entity);
  }
  return [...seen.values()];
}
