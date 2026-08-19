import {
  buildCustomGoalConfig,
  detectConversationControlIntent,
  evaluateGoalGuardrails,
  eventRegistry,
  getGoalTemplate,
  isConversationalMutationIntent,
  processMessage,
  processMessageFromAnalysis,
  routeIntent,
  type MemoryEntry,
  type MessageIntent,
  type ProcessMessageInput,
  type ProcessMessageResult,
  type SemanticRouterResult,
  type StoredEvent,
  type UpdateUserOperatingProfileInput
} from "@operator-agent/core";
import {
  completeActionItem,
  confirmPendingAction,
  createEvent,
  createEventsFromExtracted,
  createMemory,
  createPendingAction,
  ensureUser,
  expireOldPendingActions,
  getActionItem,
  getActionItems,
  getActiveGoals,
  getActiveMemories,
  getEmailSignalRules,
  getEventsSince,
  getGoals,
  getLatestPendingAction,
  getOrCreateNotificationSettings,
  getOrCreateUserOperatingProfile,
  getRecentEvents,
  rejectPendingAction,
  replacePendingAction,
  rescheduleActionItem,
  snoozeActionItem,
  type PendingAction,
  type PendingActionType
} from "@operator-agent/db";
import { analyzeMessageWithOpenAI, routeSemanticMessageWithLLM, type OpenAIMessageAnalysis } from "@operator-agent/llm";
import { formatActionCreatedReply, maybeCreateManualActionFromText } from "../actions/manual-action.js";
import { createCustomGoalProgressEvent, createGoalProgressFromCompletedAction } from "../actions/goal-progress.js";
import { readPendingActionCandidates, selectPendingActionCandidate, toPendingActionCandidate } from "../actions/pending-candidate.js";
import { applyPendingAction } from "../routes/pending-actions.js";
import { composeFinalAgentResponse, withMemoryContextReply } from "../conversation/final-response.js";
import { isRecord } from "../utils/records.js";
import { formatLocalDateTime, parseOptionalNow, pendingDecisionExpiry, tomorrow } from "../utils/datetime.js";
import { hasPendingMemoryCreate, hasSimilarActiveMemory } from "../utils/pending-memory.js";
import { sortGoalsForDisplay } from "../utils/goal-priority.js";
import { shouldUseOpenAIAnalysis } from "../utils/env.js";
import { isConfirmationMessage, isRejectionMessage, normalizeComparableText, normalizeForComparison, safeErrorForLog } from "../utils/text.js";
import { getUserTimezone } from "../utils/user-timezone.js";
import {
  buildOnboardingState,
  buildConversationDailyReview,
  composeOnboardingReply,
  formatConversationDailyReview,
  handleNaturalDailyLoopSettings
} from "./daily-conversation.js";
import {
  buildOperatorAttentionState,
  buildStartDayMessage,
  formatConversationTodayReply,
  formatEmailAttentionForConversation,
  formatOperatorAttentionForConversation,
  formatOperatorNextMoveForConversation,
  generateDailyOperatorBrief
} from "../operator/attention.js";
import {
  appendWeeklyPlanningNextStep,
  buildWeeklyReviewContext,
  formatWeeklyReview,
  generateAndSaveWeeklyReview,
  getLatestWeeklyReview,
  getWeeklyReviewForWeek,
  toWeeklyReviewMemory
} from "./weekly-review-conversation.js";
import {
  buildNextWeekPlanContext,
  detectPlanningRequestKind,
  formatNextWeekPlanMessage,
  formatPendingNextWeekPlan,
  generateNextWeekPlanSuggestions,
  parseNextWeekPlanReply,
  readPendingNextWeekPlanSuggestions,
  replacePendingPlan,
  resolveNextWeekPlanReply,
  type PlanningRequestKind
} from "./planning-conversation.js";
import { createActionHygieneSession, formatActionHygieneReport, looksLikeUnresolvedHygieneReply, maybeRememberRecentActionMutationStatusFromReply, parseActionHygieneReply, resolveActionHygieneReply } from "./action-hygiene-conversation.js";
import { buildEmailReviewInboxResponse } from "../email-reviews/email-review-service.js";
import {
  extractEmailReviewReference,
  isPendingEmailReviewContext,
  looksLikeEmailReviewContextAction,
  looksLikeEmailReviewInboxRequest,
  resolveEmailReviewContextReply
} from "./email-review-conversation.js";
import {
  answerGmailRuleQuestionForConversation,
  editActiveCustomGmailRuleForConversation,
  editPendingCustomGmailRule,
  enableEmailRuleForConversation,
  extractGmailRuleQuestionTarget,
  extractPendingCustomRuleGoalCorrection,
  extractPendingCustomRuleRemovedKeywords,
  extractPendingCustomRuleReplacementKeywords,
  formatGmailCapabilityGuidance,
  formatGmailCustomRuleGuidance,
  formatGmailNotificationTimingForConversation,
  formatGmailSetupForConversation,
  formatEmailRulesForConversation,
  handleGmailAutonomyPreferenceForConversation,
  isPendingCustomGmailRuleContext,
  isPendingCustomGmailRuleCreate,
  isUnsupportedGmailAutonomyPreference,
  looksLikeContextualDeleteAllEmailRules,
  looksLikeCustomGmailTrackingRequest,
  looksLikeGmailAutonomyPreference,
  looksLikeGmailNotificationTimingQuestion,
  looksLikeGmailRuleQuestion,
  manageCustomGmailRuleForConversation,
  parseGmailAutonomyPreference,
  proposeCustomGmailRuleForConversation,
  resolvePendingCustomEmailRuleReply,
  shouldReleasePendingGmailAutonomyFocus
} from "./gmail-conversation.js";

/**
 * Legacy /messages/process handler and its dispatcher cluster, extracted
 * from apps/api/src/server.ts as part of the `/messages/process` Third
 * Extraction Readiness Audit. This is the full legacy conversational
 * pipeline behind the `/messages/process` HTTP route: pending-decision
 * resolution, the deterministic conversation-surface dispatcher, the legacy
 * semantic router (deterministic + optional LLM), manual-action/structural-
 * proposal detection, and final-response composition.
 *
 * Two functions in this cluster — `handleConversationSurfaceIntent` and
 * `handleSemanticRouterIntent` — have `gmail_sync`/`integration_sync`
 * branches that call `syncGmailConnection`, server.ts's own ~140-line Gmail
 * OAuth/token/sync orchestrator, which also backs a dedicated Gmail-sync
 * HTTP route and stays in server.ts per this audit's explicit Gmail-OAuth/
 * sync boundary (matching every prior extraction pass in this series).
 * Rather than importing that orchestrator back from server.ts — a circular
 * import — or leaving these two dispatchers (and therefore the whole
 * handler that calls them) in server.ts, this module takes the two
 * conversation-surface sync triggers (`syncGmailForConversation`,
 * `syncIntegrationsForConversation`) as constructor dependencies via
 * `createMessagesProcessHandler`, mirroring the existing
 * `defaultAgentRouteHandlers()` factory pattern already used for
 * `registerAgentRoutes` in server.ts. server.ts wires the concrete
 * implementations in at route-registration time; zero Gmail OAuth/sync code
 * moved or changed. See docs/09-architecture-inventory.md's
 * "`/messages/process` Third Extraction Readiness Audit" for the full
 * dependency map and the planning-cluster prerequisite move this pass also
 * required (buildNextWeekPlanContext/resolveNextWeekPlanReply moved into
 * apps/api/src/legacy/planning-conversation.ts, since both are also needed
 * by dedicated next-week-plan HTTP routes that stay in server.ts).
 */

export interface MessagesProcessSyncDeps {
  syncGmailForConversation: (userId: string) => Promise<string>;
  syncIntegrationsForConversation: (userId: string) => Promise<string>;
}

type ProcessRouteDebug = NonNullable<ProcessMessageResult["routeDebug"]>;

interface RoutedProcessReply {
  reply: string;
  routeDebug: ProcessRouteDebug;
}

type ConversationSurfaceIntent =
  | "capability_help"
  | "setup_state"
  | "quickstart"
  | "configure_goals"
  | "configure_actions"
  | "configure_daily_loop"
  | "configure_integrations"
  | "operator_attention_query"
  | "operator_next_move_query"
  | "daily_operator"
  | "start_day"
  | "daily_review"
  | "weekly_review"
  | "next_week_plan"
  | "current_week_plan"
  | "ambiguous_plan"
  | "action_hygiene"
  | "show_goals"
  | "show_actions"
  | "show_memory"
  | "email_attention_query"
  | "email_review_inbox"
  | "email_review_action"
  | "email_review_summary"
  | "goal_signal_query"
  | "email_rules_list"
  | "gmail_sync"
  | "integration_sync"
  | "gmail_sync_guidance"
  | "gmail_setup"
  | "gmail_autonomy_preference"
  | "gmail_capability_guidance"
  | "gmail_custom_rule_guidance"
  | "gmail_custom_rule_request"
  | "gmail_custom_rule_manage"
  | "gmail_rule_question"
  | "gmail_custom_rule_edit_guidance"
  | "enable_job_search_email_rule"
  | "enable_work_action_email_rule"
  | "integration_guidance"
  | "daily_loop_settings";

function analyzeMessage(
  input: {
    userId: string;
    message: string;
    recentEvents: StoredEvent[];
    userOperatingProfile: Awaited<ReturnType<typeof getOrCreateUserOperatingProfile>>;
  },
  openAIAnalysis: OpenAIMessageAnalysis | undefined
): ProcessMessageResult {
  if (!openAIAnalysis) {
    return processMessage(input);
  }

  return processMessageFromAnalysis(input, {
    intent: openAIAnalysis.intent,
    mode: openAIAnalysis.mode,
    extractedEvents: openAIAnalysis.extractedEvents
  });
}

function looksLikeEmailAttentionQuery(message: string): boolean {
  const text = normalizeForComparison(message);

  if (!/\b(email|emails|gmail|mail|mails|inbox|correo|correos|correu|correus)\b/.test(text)) {
    return false;
  }

  return (
    /\b(need action|needs action|need my action|should handle|i should handle|important|came in|come in|anything from|reply|respond|pending|pendiente|pendientes|pendent|pendents|importante|importantes|importants?|accion|acción|accio|acció)\b/.test(text) ||
    /\b(do i need to reply|do i need to respond|did any important emails|what emails need action|what came in from gmail|anything from gmail|que correos tengo pendientes|qué correos tengo pendientes|hi ha correus importants)\b/.test(text)
  );
}

function detectConversationSurfaceIntent(message: string): ConversationSurfaceIntent | undefined {
  const text = normalizeForComparison(message);

  if (!text) {
    return undefined;
  }

  if (/^(help|what can you do|how do you work|how do i use this|how to use this|what do you help with)$/.test(text)) {
    return "capability_help";
  }

  if (/^(how do i start|how should i start|where do i start|start using alecto)$/.test(text)) {
    return "quickstart";
  }

  if (/^(help me set up|what should i configure|what is missing|setup|show setup|set me up)$/.test(text)) {
    return "setup_state";
  }

  if (/\b(set up goals|setup goals|help me choose goals|i want to set a goal|configure goals)\b/.test(text)) {
    return "configure_goals";
  }

  if (/\b(set up actions|setup actions|how do reminders work|how do tasks work|create my first task|set up tasks|setup tasks|configure actions|configure tasks)\b/.test(text)) {
    return "configure_actions";
  }

  if (/\b(set up daily loop|setup daily loop|configure daily loop|set up reminders|configure reminders)\b/.test(text)) {
    return "configure_daily_loop";
  }

  if (/\b(turn on|enable|set)\b.*\b(morning brief|evening review|daily loop|morning|evening)\b/.test(text) || /\bremind me every morning\b/.test(text)) {
    return "daily_loop_settings";
  }

  if (/\b(start my day|morning brief)\b/.test(text)) {
    return "start_day";
  }

  if (
    /\b(anything important|what needs my attention|what should i handle|what should i focus on|what changed since yesterday|what is important|que tengo pendiente|qué tengo pendiente|que tinc pendent|què tinc pendent|hi ha alguna cosa important)\b/.test(text)
  ) {
    return /\b(first|primero|primer|handle first|do first|next move)\b/.test(text)
      ? "operator_next_move_query"
      : "operator_attention_query";
  }

  if (/\b(what should i do today|what should i do now|show today|show my day|today plan|what is my plan today)\b/.test(text)) {
    return "daily_operator";
  }

  if (/\b(review my day|what happened today|how did today go|daily review)\b/.test(text)) {
    return "daily_review";
  }

  if (/\b(review my week|how did this week go|weekly review)\b/.test(text)) {
    return "weekly_review";
  }

  const planningRequest = detectPlanningRequestKind(message);
  if (planningRequest === "next_week") {
    return "next_week_plan";
  }

  if (planningRequest === "current_week") {
    return "current_week_plan";
  }

  if (planningRequest === "ambiguous") {
    return "ambiguous_plan";
  }

  if (/\b(clean up my tasks|clean up tasks|what tasks are stale|help me clean actions|clean up my actions|stale tasks)\b/.test(text)) {
    return "action_hygiene";
  }

  if (/\b(show my goals|show goals|list my goals|list goals)\b/.test(text)) {
    return "show_goals";
  }

  if (/\b(show my tasks|show tasks|show my actions|show actions|list tasks|list actions)\b/.test(text)) {
    return "show_actions";
  }

  if (/\b(show my memories|show memories|show my memory|list memories|what do you remember)\b/.test(text)) {
    return "show_memory";
  }

  if (looksLikeEmailReviewInboxRequest(message)) {
    return "email_review_inbox";
  }

  if (looksLikeEmailReviewContextAction(message)) {
    return "email_review_action";
  }

  if (looksLikeEmailAttentionQuery(message)) {
    return /\b(summary|resumen|resum)\b/.test(text) ? "email_review_summary" : "email_attention_query";
  }

  if (/\b(sync integrations|sync my integrations|update integrations|update my integrations|sync all integrations)\b/.test(text)) {
    return "integration_sync";
  }

  if (
    /\b(enable|turn on|activate|set up|setup|create)\b.*\b(job search|job|recruiter|application)\b.*\b(email rule|gmail rule|rule|gmail|email)\b/.test(text) ||
    /\b(enable|turn on|activate|set up|setup|create)\b.*\b(email rule|gmail rule|rule|gmail|email)\b.*\b(job search|job|recruiter|application)\b/.test(text)
  ) {
    return "enable_job_search_email_rule";
  }

  if (
    /\b(enable|turn on|activate|set up|setup|create)\b.*\b(work action|work actions|work email|work emails)\b.*\b(email rule|gmail rule|rule|gmail|email)\b/.test(text) ||
    /\b(enable|turn on|activate|set up|setup|create)\b.*\b(email rule|gmail rule|rule|gmail|email)\b.*\b(work action|work actions|work email|work emails)\b/.test(text)
  ) {
    return "enable_work_action_email_rule";
  }

  if (looksLikeGmailAutonomyPreference(message)) {
    return "gmail_autonomy_preference";
  }

  if (
    /^(connect gmail|set up gmail|setup gmail|gmail setup|show gmail setup|gmail status|show gmail status|configure gmail|gmail settings)$/.test(text) ||
    /\b(gmail|email)\b.*\b(setup|set up|status|settings|configure|configured|watching)\b/.test(text) ||
    /\b(how does gmail work|should gmail help with my goals|what gmail tracking is on)\b/.test(text)
  ) {
    return "gmail_setup";
  }

  if (
    /\b(sync gmail|sync my gmail|sync email|sync my email|check gmail now|check my gmail now|update gmail signals|update my gmail signals)\b/.test(text)
  ) {
    return "gmail_sync";
  }

  if (looksLikeGmailNotificationTimingQuestion(message)) {
    return "gmail_sync_guidance";
  }

  if (/\b(check my messages|check messages|check inbox|check my inbox|any emails|any email)\b/.test(text)) {
    return "gmail_sync_guidance";
  }

  if (
    /\b(show|list)\b.*\b(gmail|email)\b.*\brules?\b/.test(text) ||
    /\b(what|which|que|qué|quines?)\b.*\b(gmail|email)\b.*\b(rules?|checks?|tracking)\b/.test(text) ||
    /\b(gmail|email)\b.*\b(rules?|checks?|tracking)\b.*\b(have|tenemos|configured|on|active|enabled|running)\b/.test(text) ||
    /\b(what|which)\b.*\b(gmail|email)\b.*\brules?\b.*\b(on|active|enabled|configured|have|running)\b/.test(text) ||
    /\b(what|which)\b.*\brules?\b.*\b(gmail|email)\b.*\b(on|active|enabled|configured|have|running)\b/.test(text)
  ) {
    return "email_rules_list";
  }

  if (
    /\b(pause|resume|remove|delete|elimina|eliminar|borra|borrar|pausa|pausar|reanuda|reanudar|activa|activar)\b.*\b(gmail|email|mail|rule|rules|regla|reglas|tracking|emails|correos)\b/.test(text) ||
    /\b(reset|delete|remove|clear|archive)\b.*\b(all|every)\b.*\b(gmail|email|mail)\b.*\b(rules?|tracking|checks?)\b/.test(text) ||
    /\b(elimina|eliminar|borra|borrar|pausa|pausar|reanuda|reanudar|activa|activar)\b.*\b(endesa|aigues|aigües|barcelona)\b/.test(text)
  ) {
    return "gmail_custom_rule_manage";
  }

  if (/\b(what can gmail|how does gmail|gmail work|email tracking|gmail tracking|gmail rules|email rules)\b/.test(text)) {
    return "gmail_capability_guidance";
  }

  if (looksLikeGmailRuleQuestion(message)) {
    return "gmail_rule_question";
  }

  if (/\b(add|remove|change|edit)\s+(?:a\s+)?keyword\b/.test(text) && /\b(gmail|email|rule|tracking)\b/.test(text)) {
    return "gmail_custom_rule_edit_guidance";
  }

  if (looksLikeCustomGmailTrackingRequest(message)) {
    return "gmail_custom_rule_request";
  }

  if (/\b(endesa|receipt|receipts|bill|bills|invoice|invoices|custom gmail|custom email|keyword|keywords|filter|filters)\b/.test(text) && /\b(gmail|email|mail|inbox)\b/.test(text)) {
    return "gmail_custom_rule_guidance";
  }

  if (/\b(set up integrations|setup integrations|connect integrations)\b/.test(text)) {
    return "configure_integrations";
  }

  if (/\b(connect gmail|connect email|set up gmail|setup gmail|set up email|setup email|connect github|set up github|setup github)\b/.test(text)) {
    return "integration_guidance";
  }

  return undefined;
}

async function handleConversationSurfaceIntent(userId: string, message: string, deps: MessagesProcessSyncDeps): Promise<string | undefined> {
  const intent = detectConversationSurfaceIntent(message);

  if (!intent) {
    return undefined;
  }

  if (intent === "capability_help") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "explain_capabilities");
  }

  if (intent === "setup_state") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "setup_overview");
  }

  if (intent === "quickstart") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "quickstart");
  }

  if (intent === "configure_goals") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_goals");
  }

  if (intent === "configure_actions") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_actions");
  }

  if (intent === "configure_daily_loop") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_daily_loop");
  }

  if (intent === "configure_integrations") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_integrations");
  }

  if (intent === "operator_attention_query") {
    return formatOperatorAttentionForConversation(await buildOperatorAttentionState(userId));
  }

  if (intent === "operator_next_move_query") {
    const state = await buildOperatorAttentionState(userId);
    return formatOperatorNextMoveForConversation(state);
  }

  if (intent === "daily_operator") {
    return formatConversationTodayReply(await generateDailyOperatorBrief(userId));
  }

  if (intent === "start_day") {
    return buildStartDayMessage(userId, new Date());
  }

  if (intent === "daily_review") {
    return formatConversationDailyReview(await buildConversationDailyReview(userId));
  }

  if (intent === "weekly_review") {
    const timezone = await getUserTimezone(userId);
    const now = new Date();
    const context = await buildWeeklyReviewContext(userId, undefined, timezone, now);
    const existing = await getWeeklyReviewForWeek(userId, context.weekStartLocalDate);
    const existingReview = existing ? toWeeklyReviewMemory(existing) : undefined;
    const shouldRegenerate =
      !existingReview ||
      !existingReview.reviewedEndLocalDate ||
      existingReview.reviewedEndLocalDate < context.reviewedEndLocalDate;
    const review = shouldRegenerate ? await generateAndSaveWeeklyReview(userId, context) : existingReview;
    return appendWeeklyPlanningNextStep(formatWeeklyReview(review));
  }

  if (intent === "next_week_plan") {
    return createPlanForConversation(userId, message, "next_week");
  }

  if (intent === "current_week_plan") {
    return createPlanForConversation(userId, message, "current_week");
  }

  if (intent === "ambiguous_plan") {
    return createPlanForConversation(userId, message, "ambiguous");
  }

  if (intent === "action_hygiene") {
    const now = new Date();
    const { report } = await createActionHygieneSession(userId, message, now, "legacy_conversation_surface");
    return formatActionHygieneReport(report);
  }

  if (intent === "show_goals") {
    return formatGoalsForConversation(await getGoals(userId));
  }

  if (intent === "show_actions") {
    return formatActionsForConversation(await getActionItems(userId, { status: "open", limit: 10 }));
  }

  if (intent === "show_memory") {
    return formatMemoriesForConversation(await getActiveMemories(userId));
  }

  if (intent === "email_attention_query" || intent === "email_review_summary" || intent === "goal_signal_query") {
    return formatEmailAttentionForConversation(await buildOperatorAttentionState(userId));
  }

  if (intent === "email_review_inbox") {
    return (await buildEmailReviewInboxResponse(userId, { storeContext: true })).message;
  }

  if (intent === "email_review_action") {
    return "Run \"email reviews\" first so I can number the visible items safely.";
  }

  if (intent === "email_rules_list") {
    return formatEmailRulesForConversation(userId, message);
  }

  if (intent === "gmail_sync") {
    return deps.syncGmailForConversation(userId);
  }

  if (intent === "integration_sync") {
    return deps.syncIntegrationsForConversation(userId);
  }

  if (intent === "gmail_sync_guidance") {
    return looksLikeGmailNotificationTimingQuestion(message)
      ? formatGmailNotificationTimingForConversation(userId, message)
      : "For Gmail, say 'sync Gmail' after connecting Gmail and enabling a rule.";
  }

  if (intent === "gmail_setup") {
    return formatGmailSetupForConversation(userId);
  }

  if (intent === "gmail_autonomy_preference") {
    return handleGmailAutonomyPreferenceForConversation(userId, message);
  }

  if (intent === "gmail_capability_guidance") {
    return formatGmailCapabilityGuidance(userId);
  }

  if (intent === "gmail_custom_rule_guidance") {
    return formatGmailCustomRuleGuidance();
  }

  if (intent === "gmail_custom_rule_request") {
    return proposeCustomGmailRuleForConversation(userId, message);
  }

  if (intent === "gmail_custom_rule_manage") {
    return manageCustomGmailRuleForConversation(userId, message);
  }

  if (intent === "gmail_rule_question") {
    return answerGmailRuleQuestionForConversation(userId, message);
  }

  if (intent === "gmail_custom_rule_edit_guidance") {
    return "Keyword edits for custom Gmail rules are not ready yet. For now, remove the rule and create a new one with the filters you want.";
  }

  if (intent === "enable_job_search_email_rule") {
    return enableEmailRuleForConversation(userId, "job_search");
  }

  if (intent === "enable_work_action_email_rule") {
    return enableEmailRuleForConversation(userId, "work_action");
  }

  if (intent === "integration_guidance") {
    return formatIntegrationGuidance(message);
  }

  if (intent === "daily_loop_settings") {
    return handleNaturalDailyLoopSettings(userId, message);
  }

  return undefined;
}

async function handleSemanticRouterIntent(
  userId: string,
  message: string,
  pendingAction: PendingAction | undefined,
  deps: MessagesProcessSyncDeps
): Promise<RoutedProcessReply | undefined> {
  const deterministicRoute = detectDeterministicSemanticRouterIntent(message, pendingAction);
  const semanticRouterAttempted = shouldUseSemanticRouterLLM();
  const llmRoute = semanticRouterAttempted ? await maybeRouteSemanticMessageWithLLM(userId, message, pendingAction) : undefined;
  const route = selectSemanticRouterRoute(deterministicRoute, llmRoute, pendingAction);
  const routerSource = route && llmRoute && route === llmRoute ? "llm_semantic" : "deterministic_semantic";

  if (!route || route.intent === "unknown" || route.confidence < 0.68) {
    return undefined;
  }

  let reply: string | undefined;
  let handlerName = "handleSemanticRouterIntent";
  let mutation = false;

  if (route.intent === "capability_help") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "explain_capabilities");
  }

  if (route.intent === "quickstart") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "quickstart");
  }

  if (route.intent === "setup_state") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "setup_overview");
  }

  if (route.intent === "configure_goals") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_goals");
  }

  if (route.intent === "configure_actions") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_actions");
  }

  if (route.intent === "configure_daily_loop") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_daily_loop");
  }

  if (route.intent === "configure_integrations") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_integrations");
  }

  if (route.intent === "operator_attention_query") {
    handlerName = "buildOperatorAttentionState";
    reply = formatOperatorAttentionForConversation(await buildOperatorAttentionState(userId));
  }

  if (route.intent === "operator_next_move_query") {
    handlerName = "buildOperatorAttentionState";
    reply = formatOperatorNextMoveForConversation(await buildOperatorAttentionState(userId));
  }

  if (route.intent === "daily_operator") {
    handlerName = "generateDailyOperatorBrief";
    reply = formatConversationTodayReply(await generateDailyOperatorBrief(userId));
  }

  if (route.intent === "start_day") {
    handlerName = "buildStartDayMessage";
    reply = await buildStartDayMessage(userId, new Date());
  }

  if (route.intent === "daily_review") {
    handlerName = "buildConversationDailyReview";
    reply = formatConversationDailyReview(await buildConversationDailyReview(userId, new Date()));
  }

  if (route.intent === "weekly_review") {
    handlerName = "generateAndSaveWeeklyReview";
    const timezone = await getUserTimezone(userId);
    const now = new Date();
    const context = await buildWeeklyReviewContext(userId, undefined, timezone, now);
    const existing = await getWeeklyReviewForWeek(userId, context.weekStartLocalDate);
    const existingReview = existing ? toWeeklyReviewMemory(existing) : undefined;
    const shouldRegenerate =
      !existingReview ||
      !existingReview.reviewedEndLocalDate ||
      existingReview.reviewedEndLocalDate < context.reviewedEndLocalDate;
    const review = shouldRegenerate ? await generateAndSaveWeeklyReview(userId, context) : existingReview;
    reply = appendWeeklyPlanningNextStep(formatWeeklyReview(review));
    mutation = shouldRegenerate;
  }

  if (route.intent === "current_week_plan" || route.intent === "next_week_plan" || route.intent === "ambiguous_plan") {
    handlerName = "createPlanForConversation";
    reply = await createPlanForConversation(
      userId,
      message,
      route.intent === "current_week_plan" ? "current_week" : route.intent === "next_week_plan" ? "next_week" : "ambiguous"
    );
    mutation = true;
  }

  if (route.intent === "action_hygiene") {
    handlerName = "analyzeActionHygiene";
    const now = new Date();
    const { report } = await createActionHygieneSession(userId, message, now, "legacy_semantic_surface");
    reply = formatActionHygieneReport(report);
    mutation = true;
  }

  if (route.intent === "show_goals") {
    handlerName = "formatGoalsForConversation";
    reply = formatGoalsForConversation(await getGoals(userId));
  }

  if (route.intent === "show_actions") {
    handlerName = "formatActionsForConversation";
    reply = formatActionsForConversation(await getActionItems(userId, { status: "open", limit: 10 }));
  }

  if (route.intent === "show_memory") {
    handlerName = "formatMemoriesForConversation";
    reply = formatMemoriesForConversation(await getActiveMemories(userId));
  }

  if (route.intent === "email_attention_query" || route.intent === "email_review_summary" || route.intent === "goal_signal_query") {
    handlerName = "buildOperatorAttentionState";
    reply = formatEmailAttentionForConversation(await buildOperatorAttentionState(userId));
  }

  if (route.intent === "email_review_inbox") {
    handlerName = "buildEmailReviewInboxResponse";
    reply = (await buildEmailReviewInboxResponse(userId, { storeContext: true })).message;
    mutation = true;
  }

  if (route.intent === "email_review_action") {
    handlerName = "resolveEmailReviewContextReply";
    const emailReviewContext = isPendingEmailReviewContext(pendingAction) ? pendingAction : undefined;
    reply = emailReviewContext
      ? await resolveEmailReviewContextReply(userId, emailReviewContext, message)
      : "Run \"email reviews\" first so I can number the visible items safely.";
    mutation = Boolean(reply && !/^Run "email reviews"/.test(reply));
  }

  if (route.intent === "email_rules_list") {
    handlerName = "formatEmailRulesForConversation";
    reply = await formatEmailRulesForConversation(userId, message);
  }

  if (route.intent === "integration_guidance") {
    handlerName = "formatIntegrationGuidance";
    reply = formatIntegrationGuidance(message);
  }

  if (route.intent === "integration_sync") {
    handlerName = "syncIntegrationsForConversation";
    reply = await deps.syncIntegrationsForConversation(userId);
    mutation = true;
  }

  if (route.intent === "daily_loop_settings") {
    handlerName = "handleNaturalDailyLoopSettings";
    reply = await handleNaturalDailyLoopSettings(userId, message);
    mutation = reply.startsWith("Daily loop updated.");
  }

  if (route.intent === "gmail_capability_guidance") {
    handlerName = "formatGmailCapabilityGuidance";
    reply = await formatGmailCapabilityGuidance(userId);
  }

  if (route.intent === "gmail_setup") {
    handlerName = "formatGmailSetupForConversation";
    reply = await formatGmailSetupForConversation(userId);
  }

  if (route.intent === "gmail_autonomy_preference") {
    handlerName = "handleGmailAutonomyPreferenceForConversation";
    reply = await handleGmailAutonomyPreferenceForConversation(userId, message, route);
    mutation = reply.startsWith("I can set Gmail") || reply.startsWith("I can turn") || reply.startsWith("I can make Gmail");
  }

  if (route.intent === "gmail_sync") {
    handlerName = "syncGmailForConversation";
    reply = await deps.syncGmailForConversation(userId);
    mutation = true;
  }

  if (route.intent === "gmail_sync_guidance") {
    handlerName = "formatGmailNotificationTimingForConversation";
    reply = looksLikeGmailNotificationTimingQuestion(message)
      ? await formatGmailNotificationTimingForConversation(userId, message, pendingAction, route)
      : "For Gmail, say 'sync Gmail' after connecting Gmail and enabling a rule.";
  }

  if (route.intent === "enable_job_search_email_rule") {
    handlerName = "enableEmailRuleForConversation";
    reply = await enableEmailRuleForConversation(userId, "job_search");
    mutation = reply.includes(" is on.");
  }

  if (route.intent === "enable_work_action_email_rule") {
    handlerName = "enableEmailRuleForConversation";
    reply = await enableEmailRuleForConversation(userId, "work_action");
    mutation = reply.includes(" is on.");
  }

  if (route.intent === "gmail_custom_rule_request") {
    if (route.confidence < 0.65) {
      handlerName = "proposeCustomGmailRuleForConversation";
      reply = "That is too broad. Give me a sender, company, project, or 2-3 keywords.";
    } else {
      handlerName = "proposeCustomGmailRuleForConversation";
      reply = await proposeCustomGmailRuleForConversation(userId, message, route);
      mutation = true;
    }
  }

  if (route.intent === "gmail_custom_rule_edit_pending") {
    if (isPendingCustomGmailRuleCreate(pendingAction)) {
      handlerName = "editPendingCustomGmailRule";
      reply = await editPendingCustomGmailRule(userId, pendingAction, route);
      mutation = reply.startsWith("Updated the pending Gmail rule.");
    } else {
      handlerName = "editActiveCustomGmailRuleForConversation";
      reply = await editActiveCustomGmailRuleForConversation(userId, message, route, pendingAction);
      mutation = reply.startsWith("Updated Gmail rule:");
    }
  }

  if (route.intent === "gmail_custom_rule_edit") {
    handlerName = "editActiveCustomGmailRuleForConversation";
    reply = await editActiveCustomGmailRuleForConversation(userId, message, route, pendingAction);
    mutation = reply.startsWith("Updated Gmail rule:");
  }

  if (route.intent === "gmail_custom_rule_manage") {
    handlerName = "manageCustomGmailRuleForConversation";
    reply = await manageCustomGmailRuleForConversation(userId, message, route, pendingAction);
    mutation =
      reply.startsWith("Gmail rule active:") ||
      reply.startsWith("Gmail rule paused:") ||
      reply.startsWith("Confirm remove Gmail rule:") ||
      reply.startsWith("Confirm remove ") && reply.includes("Gmail email rule");
  }

  if (route.intent === "gmail_rule_question") {
    handlerName = "answerGmailRuleQuestionForConversation";
    reply = await answerGmailRuleQuestionForConversation(userId, message, pendingAction, route);
  }

  if (route.intent === "conversation_repair") {
    handlerName = "formatConversationRepairReply";
    reply = formatConversationRepairReply(pendingAction, route);
  }

  if (!reply) {
    return undefined;
  }

  return {
    reply,
    routeDebug: {
      routerSource,
      intent: route.intent,
      handlerName,
      orchestrator: "legacy",
      handledBy: "legacy_semantic",
      plannerUsed: "legacy",
      semanticRouterAttempted,
      semanticRouterUsed: true,
      legacySemanticAttempted: true,
      legacySemanticUsed: true,
      operationPlanValidated: false,
      policyPrecheckResult: "passed",
      mutation,
      mutationExecuted: mutation,
      confidence: route.confidence,
      language: route.language,
      sideEffectRisk: route.sideEffectRisk,
      requiresConfirmation: route.requiresConfirmation,
      reason: route.reason
    }
  };
}

function selectSemanticRouterRoute(
  deterministicRoute: SemanticRouterResult | undefined,
  llmRoute: SemanticRouterResult | undefined,
  pendingAction?: PendingAction
): SemanticRouterResult | undefined {
  const usableLlmRoute = llmRoute && llmRoute.intent !== "unknown" && llmRoute.confidence >= 0.68 ? llmRoute : undefined;

  if (deterministicRoute?.intent === "conversation_repair") {
    return deterministicRoute;
  }

  if (deterministicRoute?.sideEffectRisk === "destructive") {
    return deterministicRoute;
  }

  if (usableLlmRoute && (isPendingCustomGmailRuleCreate(pendingAction) || isPendingCustomGmailRuleContext(pendingAction))) {
    return usableLlmRoute;
  }

  return deterministicRoute ?? usableLlmRoute;
}

function detectDeterministicSemanticRouterIntent(message: string, pendingAction?: PendingAction): SemanticRouterResult | undefined {
  const text = normalizeForComparison(message);
  const hasPendingCustomRule = isPendingCustomGmailRuleCreate(pendingAction);

  if (isPendingCustomGmailRuleContext(pendingAction)) {
    if (looksLikeContextualDeleteAllEmailRules(message)) {
      return {
        intent: "gmail_custom_rule_manage",
        operation: "remove",
        confidence: 0.92,
        reason: "User asks to delete/reset all email rules in the current Gmail rule context.",
        language: "unknown",
        sideEffectRisk: "destructive",
        requiresConfirmation: true,
        target: "all email rules",
        keywordFilters: [],
        senderFilters: [],
        removeKeywordFilters: [],
        goalHint: null,
        shouldUnlinkGoal: false,
        userFacingIssue: null
      };
    }
  }

  if (hasPendingCustomRule) {
    const replacementKeywords = extractPendingCustomRuleReplacementKeywords(message);
    const removeKeywordFilters = extractPendingCustomRuleRemovedKeywords(message);
    const goalCorrection = extractPendingCustomRuleGoalCorrection(message);

    if (replacementKeywords.length > 0 || removeKeywordFilters.length > 0 || goalCorrection) {
      return {
        intent: "gmail_custom_rule_edit_pending",
        operation: "edit_pending",
        confidence: 0.92,
        reason: "User is editing the pending Gmail custom rule proposal.",
        language: "unknown",
        sideEffectRisk: "write",
        requiresConfirmation: true,
        target: null,
        keywordFilters: replacementKeywords,
        senderFilters: [],
        removeKeywordFilters,
        goalHint: goalCorrection?.goalHint ?? null,
        shouldUnlinkGoal: goalCorrection?.shouldUnlinkGoal ?? false,
        userFacingIssue: null
      };
    }

    if (looksLikeGmailRuleQuestion(message)) {
      return {
        intent: "gmail_rule_question",
        operation: "answer",
        confidence: 0.9,
        reason: "User is asking about the pending Gmail rule proposal.",
        language: "unknown",
        sideEffectRisk: "read",
        requiresConfirmation: false,
        target: null,
        keywordFilters: [],
        senderFilters: [],
        removeKeywordFilters: [],
        goalHint: null,
        shouldUnlinkGoal: false,
        userFacingIssue: null
      };
    }
  }

  if (looksLikeGmailAutonomyPreference(message)) {
    const preference = parseGmailAutonomyPreference(message);
    return {
      intent: "gmail_autonomy_preference",
      operation: "edit",
      confidence: 0.94,
      reason: "User asks to change Gmail checking or notification preferences.",
      language: "unknown",
      sideEffectRisk: "write",
      requiresConfirmation: !isUnsupportedGmailAutonomyPreference(preference),
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (/\b(wtf|what are you doing|bro what|that's wrong|this is wrong|not good|you misunderstood|wrong goal|wrong rule)\b/.test(text)) {
    return {
      intent: "conversation_repair",
      operation: "repair",
      confidence: 0.86,
      reason: "User is complaining about a misunderstanding.",
      language: "unknown",
      sideEffectRisk: "none",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (
    /\b(anything important|what needs my attention|what should i handle|what should i focus on|what changed since yesterday|que tengo pendiente|qué tengo pendiente|que tinc pendent|què tinc pendent|hi ha alguna cosa important)\b/.test(text)
  ) {
    return {
      intent: /\b(first|primero|primer|handle first|do first|next move)\b/.test(text) ? "operator_next_move_query" : "operator_attention_query",
      operation: "review",
      confidence: 0.9,
      reason: "User asks for the current operator attention state.",
      language: "unknown",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (looksLikeEmailReviewInboxRequest(message)) {
    return {
      intent: "email_review_inbox",
      operation: "review",
      confidence: 0.94,
      reason: "User asks to show pending email review items.",
      language: "unknown",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (looksLikeEmailAttentionQuery(message)) {
    return {
      intent: "email_attention_query",
      operation: "review",
      confidence: 0.9,
      reason: "User asks whether Gmail/email items need action.",
      language: "unknown",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (isPendingEmailReviewContext(pendingAction) && looksLikeEmailReviewContextAction(message)) {
    return {
      intent: "email_review_action",
      operation: "review",
      confidence: 0.92,
      reason: "User is responding to visible email review context.",
      language: "unknown",
      sideEffectRisk: /reject|clear|dismiss|rechaza|descarta|borra|approve|accept|yes|aprueba|acepta|turn|make|create|task|action|remind|haz|crea|tarea/i.test(message)
        ? "write"
        : "read",
      requiresConfirmation: false,
      target: extractEmailReviewReference(message) ?? null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (looksLikeGmailNotificationTimingQuestion(message)) {
    return {
      intent: "gmail_sync_guidance",
      operation: "timing",
      confidence: 0.96,
      reason: "User asks when or how Gmail/email checks and notifications happen.",
      language: "unknown",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: extractGmailRuleQuestionTarget(message) ?? null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  return undefined;
}

async function maybeRouteSemanticMessageWithLLM(
  userId: string,
  message: string,
  pendingAction?: PendingAction
): Promise<SemanticRouterResult | undefined> {
  if (!shouldUseSemanticRouterLLM()) {
    return undefined;
  }

  try {
    const [activeGoals, emailRules, goals] = await Promise.all([
      getActiveGoals(userId),
      getEmailSignalRules(userId),
      getGoals(userId)
    ]);
    const goalById = new Map(goals.map((goal) => [goal.id, goal.title]));

    return await routeSemanticMessageWithLLM({
      userId,
      message,
      activeGoals: activeGoals.map((goal) => ({
        id: goal.id,
        title: goal.title,
        category: goal.category,
        templateId: goal.templateId,
        status: goal.status
      })),
      activeEmailRules: emailRules
        .filter((rule) => rule.status !== "archived")
        .map((rule) => ({
          id: rule.id,
          adapterId: rule.adapterId,
          name: rule.name,
          query: rule.query,
          status: rule.status,
          goalTitle: rule.goalId ? goalById.get(rule.goalId) ?? null : null
        })),
      pendingAction: pendingAction
        ? {
            type: pendingAction.type,
            summary: pendingAction.summary,
            payload: sanitizePendingActionForSemanticRouter(pendingAction)
          }
        : null
    });
  } catch (error) {
    console.warn("Semantic router LLM failed; continuing deterministic routing.", safeErrorForLog(error));
    return undefined;
  }
}

function shouldUseSemanticRouterLLM(): boolean {
  return process.env.LLM_ROUTER_ENABLED === "true" && (Boolean(process.env.OPENAI_API_KEY) || Boolean(process.env.LLM_ROUTER_MOCK_RESPONSE));
}

function sanitizePendingActionForSemanticRouter(pendingAction: PendingAction): Record<string, unknown> {
  if (pendingAction.type !== "custom_email_rule" || !isRecord(pendingAction.payload)) {
    return {
      type: pendingAction.type,
      summary: pendingAction.summary
    };
  }

  return {
    operation: pendingAction.payload.operation,
    displayName: pendingAction.payload.displayName,
    keywordFilters: pendingAction.payload.keywordFilters,
    senderFilters: pendingAction.payload.senderFilters,
    goalTitle: pendingAction.payload.goalTitle,
    queryPreview: pendingAction.payload.queryPreview,
    focusedRuleId: pendingAction.payload.focusedRuleId,
    rules: pendingAction.payload.rules
  };
}

function formatConversationRepairReply(pendingAction: PendingAction | undefined, route: SemanticRouterResult): string {
  if (isPendingCustomGmailRuleCreate(pendingAction)) {
    return [
      "You are right to call that out.",
      "I was handling a pending Gmail rule. I should edit that rule or ask a clear question, not invent progress.",
      route.userFacingIssue ? `Issue: ${route.userFacingIssue}` : undefined,
      "Tell me the exact change, for example: \"make the Gmail rule look only for Endesa\" or \"remove the linked goal\"."
    ].filter(Boolean).join("\n");
  }

  return [
    "You are right to call that out.",
    "I should not pretend I changed something unless the database update actually happened.",
    "Tell me the exact change you wanted, or use /actions, /my_email_rules, or /today to check the current state."
  ].join("\n");
}

async function createGuardianGuardrailReply(
  userId: string,
  message: string,
  guardrail: ReturnType<typeof evaluateGoalGuardrails>
): Promise<ProcessMessageResult> {
  const intent = routeIntent(message);
  await createEvent(userId, {
    type: "finance.betting.cooldown_triggered",
    timestamp: new Date(),
    source: "manual",
    data: {
      intent,
      reason: "goal_guardrail",
      guardrail: {
        goalId: guardrail.goalId,
        goalTitle: guardrail.goalTitle,
        category: guardrail.guardrailCategory,
        severity: guardrail.severity,
        responseMode: guardrail.responseMode,
        blockedActionCreation: guardrail.blockedActionCreation,
        cooldownRequired: guardrail.cooldownRequired,
        reason: guardrail.reason
      }
    },
    evidence: [message],
    confidence: guardrail.confidence
  });

  return {
    userId,
    message,
    intent: isFinancialRiskIntent(intent) ? intent : "financial_impulse",
    mode: "guardian",
    riskState: "RED",
    extractedEvents: [],
    reply: "No. Hard stop. I am not helping you turn this into permission. Cooldown now. If it still matters later, bring a written thesis, exact size, invalidation point, and emotional state.",
    routeDebug: {
      routerSource: "deterministic_guardrail",
      intent: "goal_guardrail",
      handlerName: "createGuardianGuardrailReply",
      semanticRouterAttempted: false,
      semanticRouterUsed: false,
      mutation: true,
      policyPrecheckResult: "blocked_by_guardrail",
      reason: guardrail.reason
    }
  };
}

async function createPlanForConversation(userId: string, originalText: string, requestKind: PlanningRequestKind): Promise<string> {
  if (requestKind === "ambiguous") {
    const pending = await getLatestPendingAction(userId);

    if (pending?.type === "next_week_plan") {
      const timezone = typeof pending.payload.timezone === "string" ? pending.payload.timezone : await getUserTimezone(userId);
      return formatPendingNextWeekPlan(timezone, pending.payload, readPendingNextWeekPlanSuggestions(pending.payload.suggestions));
    }

    const recentWeeklyReview = await getLatestWeeklyReview(userId);

    if (!recentWeeklyReview) {
      return "Do you mean this week or next week?";
    }

    requestKind = "next_week";
  }

  const timezone = await getUserTimezone(userId);
  const now = new Date();
  const context = await buildNextWeekPlanContext(userId, now, timezone, requestKind === "current_week" ? "current_week" : "next_week");
  const suggestions = await generateNextWeekPlanSuggestions(context);
  await replacePendingPlan(userId, context, suggestions, originalText);

  return formatNextWeekPlanMessage(context, suggestions);
}

function formatGoalsForConversation(goals: Awaited<ReturnType<typeof getGoals>>): string {
  const active = sortGoalsForDisplay(goals).filter((goal) => goal.status === "active");
  if (active.length === 0) {
    return "No active goals.";
  }

  return ["Active goals:", ...active.slice(0, 10).map((goal, index) => `${index + 1}. ${goal.title} - ${goal.priority ?? "medium"}`)].join("\n");
}

function formatActionsForConversation(actions: Awaited<ReturnType<typeof getActionItems>>): string {
  if (actions.length === 0) {
    return "No open action items.";
  }

  return [
    "Open actions:",
    ...actions.slice(0, 10).map((action) =>
      `- ${action.title}${action.dueAt ? ` - due ${formatLocalDateTime(action.dueAt)}` : ""}${action.goalTitleSnapshot ? ` - goal: ${action.goalTitleSnapshot}` : ""}`
    )
  ].join("\n");
}

function formatMemoriesForConversation(memories: MemoryEntry[]): string {
  const visibleMemories = uniqueConversationMemories(memories);

  if (visibleMemories.length === 0) {
    return "No active memories.";
  }

  return ["Active memories:", ...visibleMemories.slice(0, 10).map((memory) => `- ${memory.summary}`)].join("\n");
}

function uniqueConversationMemories(memories: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  const visible: MemoryEntry[] = [];

  for (const memory of memories) {
    if (isRecord(memory.data) && memory.data.kind === "weekly_review") {
      continue;
    }

    const key = normalizeComparableText(memory.summary);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    visible.push(memory);
  }

  return visible;
}

function formatIntegrationGuidance(message: string): string {
  const text = normalizeForComparison(message);

  if (/\bgmail\b/.test(text)) {
    return [
      "Gmail setup is explicit and readonly.",
      "1. Connect Gmail with readonly access.",
      "2. Choose what Alecto should watch for.",
      "",
      "Ready today:",
      "- Job search: recruiter replies, interviews, rejections, offers, application confirmations.",
      "- Work actions: requests, deadlines, follow-ups, feedback, blockers. These go to review first.",
      "- Custom tracking: sender and keyword rules. These go to review first and never auto-log.",
      "",
      "Alecto will not scan Gmail until a rule is enabled.",
      "",
      "Say:",
      '- "enable job search rule for Gmail"',
      '- "enable work action rule for Gmail"',
      '- "track Endesa bills from Gmail"',
      "",
      "Shortcut: /connect_gmail"
    ].join("\n");
  }

  if (/\bgithub\b/.test(text)) {
    return [
      "GitHub setup is for public repos only.",
      "Use author=LOGIN when you want matching commits to count as personal progress. Without it, repo activity is only context.",
      "",
      "Example: /connect_github OWNER/REPO author=LOGIN."
    ].join("\n");
  }

  return [
    "Integrations are explicit and opt-in.",
    "- Gmail: readonly, rule-based scanning only after approval.",
    "- GitHub: public repos only; author=LOGIN is needed for personal commit progress.",
    "Optional shortcuts: /connect_gmail, /connect_github OWNER/REPO author=LOGIN, /my_integrations."
  ].join("\n");
}

function isStandaloneNowMessage(message: string): boolean {
  return /^now$/i.test(message.trim());
}

function isFinancialRiskIntent(intent: MessageIntent): boolean {
  return intent === "betting_intent" || intent === "trading_intent";
}

function extractExplicitMemory(message: string): { type: MemoryEntry["type"]; summary: string } | undefined {
  const match = message.match(
    /\b(?:remember that|remember this|note that|acu[eé]rdate de que|recuerda que|guard[ae] que)\s+(.+)/i
  );
  const rawText = match?.[1]?.trim().replace(/[.!?]+$/g, "");

  if (!rawText) {
    return undefined;
  }

  const type = inferMemoryType(rawText);

  return {
    type,
    summary: normalizeMemorySummary(rawText)
  };
}

function inferMemoryType(text: string): MemoryEntry["type"] {
  if (/\b(prefiero|prefer|hate|odio|generic motivation|hablas? directo|directo|communication)\b/i.test(text)) {
    if (/\b(hablas? directo|directo|tone|communication|me hables|talk to me)\b/i.test(text)) {
      return "communication_style";
    }

    return "preference";
  }

  if (/\b(risk|apuesta|apostar|gambling|trading|betting)\b/i.test(text)) {
    return "risk_pattern";
  }

  if (/\b(goal|objetivo|context|porque|why)\b/i.test(text)) {
    return "goal_context";
  }

  return "note";
}

function normalizeMemorySummary(text: string): string {
  const trimmed = text.trim();
  const first = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return first.endsWith(".") ? first : `${first}.`;
}

async function maybeAnalyzeWithOpenAI(
  input: {
    userId: string;
    message: string;
    recentEvents: StoredEvent[];
    userOperatingProfile: Awaited<ReturnType<typeof getOrCreateUserOperatingProfile>>;
  },
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>,
  userOperatingProfile: Awaited<ReturnType<typeof getOrCreateUserOperatingProfile>>,
  activeMemories: MemoryEntry[]
): Promise<OpenAIMessageAnalysis | undefined> {
  if (!shouldUseOpenAIAnalysis()) {
    return undefined;
  }

  try {
    return await analyzeMessageWithOpenAI({
      userId: input.userId,
      message: input.message,
      activeGoals,
      recentEvents: input.recentEvents,
      activeMemories,
      eventRegistry: [...eventRegistry],
      userOperatingProfile
    });
  } catch (error) {
    console.warn("OpenAI analysis failed; falling back to rule-based pipeline.", error);
    return undefined;
  }
}

async function maybeCreateRepeatedCooldownPendingMemory(
  userId: string,
  cooldownEvent: StoredEvent
): Promise<string | undefined> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cooldownEvents = (await getEventsSince(userId, since)).filter(
    (event) => event.type === "finance.betting.cooldown_triggered"
  );

  if (cooldownEvents.length < 2) {
    return undefined;
  }

  const summary = "User has repeated betting/trading cooldown events in the last 7 days.";

  if (await hasSimilarActiveMemory(userId, summary)) {
    return undefined;
  }

  if (await hasPendingMemoryCreate(userId, summary)) {
    return undefined;
  }

  await createPendingAction(userId, {
    type: "memory_create",
    summary,
    payload: {
      type: "risk_pattern",
      summary,
      source: "system_inferred",
      confidence: 0.85,
      evidence: {
        cooldownCount: cooldownEvents.length,
        recentEventIds: cooldownEvents.map((event) => event.id),
        latestEventId: cooldownEvent.id
      }
    },
    expiresAt: tomorrow()
  });

  return "I also noticed a repeated risk pattern. Reply yes to save it to memory or no to ignore.";
}

interface StructuralProposal {
  type: PendingActionType;
  summary: string;
  payload: Record<string, unknown>;
  reply: string;
  createPending?: boolean;
}

const hardGuardianPatch = {
  directness: 5,
  warmth: 3,
  confrontation: 5,
  profanityAllowed: true,
  motivationalStyle: "tough_love",
  accountabilityStrictness: 5,
  escalationStyle: "brutal_when_needed",
  gamblingGuardrails: "hard_guardian",
  selfDeceptionSensitivity: 5,
  cooldownPreference: "hard_no",
  vulnerableMode: "soften",
  avoidingMode: "confront",
  impulsiveMode: "guardian_mode"
} satisfies UpdateUserOperatingProfileInput;

const softProfilePatch = {
  directness: 3,
  warmth: 4,
  confrontation: 2,
  profanityAllowed: false,
  motivationalStyle: "gentle",
  accountabilityStrictness: 3,
  escalationStyle: "soft",
  gamblingGuardrails: "strict",
  selfDeceptionSensitivity: 4,
  cooldownPreference: "require_confirmation",
  vulnerableMode: "soften",
  avoidingMode: "nudge",
  impulsiveMode: "slow_down"
} satisfies UpdateUserOperatingProfileInput;

function detectStructuralProposal(
  message: string,
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>
): StructuralProposal | undefined {
  const normalized = message.toLowerCase();

  if (/\b(undo last event|undo last log|borra el ultimo evento|borra el último evento|deshaz el ultimo evento|deshaz el último evento)\b/i.test(message)) {
    return {
      type: "event_undo_last",
      summary: "Archive the last logged event/group",
      payload: {
        scope: "group",
        reason: "user requested undo"
      },
      reply: "Confirm undo last logged action? Reply yes to confirm or no to cancel."
    };
  }

  if (
    /\b(be stricter with me|be harder on me|don't let me justify bets|dont let me justify bets)\b/i.test(message) ||
    /(\bno me dejes justificar apuestas\b|\bs[eé] m[aá]s duro conmigo\b)/i.test(message)
  ) {
    return {
      type: "profile_update",
      summary: "Update profile to hard guardian mode",
      payload: { profilePatch: hardGuardianPatch },
      reply:
        "I can update your style to hard guardian: more direct, stricter on gambling/trading, and less validating of excuses. Reply yes to confirm or no to cancel."
    };
  }

  if (/\b(be softer|don't be so harsh|dont be so harsh|be more supportive)\b/i.test(message)) {
    return {
      type: "profile_update",
      summary: "Update profile to a softer support style",
      payload: { profilePatch: softProfilePatch },
      reply:
        "I can update your style to softer support: warmer, less confrontational, and more supportive. Reply yes to confirm or no to cancel."
    };
  }

  const archiveProposal = detectGoalArchiveProposal(message, activeGoals);

  if (archiveProposal) {
    return archiveProposal;
  }

  const progressProposal = detectCustomProgressProposal(message, activeGoals);

  if (progressProposal) {
    return progressProposal;
  }

  if (
    /\b(i want to focus on|create a goal to|my new focus is|i want to find|i want to get|i want to read|i want to stop|i want to build|i want to write|i want to create|i want to|quiero centrarme en|quiero mejorar|quiero buscar|quiero dormir|quiero|me gustar[ií]a)\b/i.test(
      message
    )
  ) {
    if (/\b(i want to bet|i want to trade|quiero apostar|quiero tradear)\b/i.test(message)) {
      return undefined;
    }

    const goalIntent = parseGoalCreationIntent(message);
    const classificationText = goalIntent?.goalText.toLowerCase() ?? normalized;
    const templateId = inferGoalTemplateId(classificationText);
    const template = templateId ? getGoalTemplate(templateId) : undefined;
    const category = template?.category ?? inferGoalCategory(classificationText);
    const title = templateId
      ? inferGoalTitle(goalIntent?.goalText ?? message, category, templateId)
      : goalIntent?.goalText ?? inferGoalTitle(message, category, templateId);
    const why = goalIntent?.why;
    const customConfig = templateId ? undefined : buildCustomGoalConfig({ title, category, why });

    return {
      type: "goal_create",
      summary: `Create goal: ${title}`,
      payload: {
        title,
        category: customConfig?.category ?? category,
        ...(why ? { why } : {}),
        ...(customConfig
          ? {
              targetMetrics: customConfig.targetMetrics,
              checkInConfig: customConfig.checkInConfig
            }
          : {}),
        ...(templateId ? { templateId } : {})
      },
      reply: customConfig
        ? formatCustomGoalCreateProposal(title, customConfig)
        : `I can create this goal: ${title} (${category}). Reply yes to confirm or no to cancel.`
    };
  }

  return undefined;
}

function parseGoalCreationIntent(message: string): { goalText: string; why?: string } | undefined {
  const withoutBoilerplate = message
    .replace(
      /^\s*(i want to focus on|create a goal to|my new focus is|i want to|i want|quiero centrarme en|quiero mejorar|quiero buscar|quiero|me gustar[ií]a)\s+/i,
      ""
    )
    .trim()
    .replace(/[.!?]+$/g, "");

  if (!withoutBoilerplate) {
    return undefined;
  }

  const whyMatch = withoutBoilerplate.match(
    /^(.+?)\s+(?:to create career leverage|to build discipline|for better mood|to feel better|to make more money|for more money|para crear palanca profesional|para tener m[aá]s disciplina)$/i
  );

  if (whyMatch?.[1]) {
    return {
      goalText: titleCaseGoal(whyMatch[1].trim()),
      why: withoutBoilerplate.slice(whyMatch[1].length).trim()
    };
  }

  return {
    goalText: titleCaseGoal(withoutBoilerplate)
  };
}

function detectCustomProgressProposal(
  message: string,
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>
): StructuralProposal | undefined {
  const match = message.match(
    /\b(?:log progress for|i made progress on|avance en)\s+(.+?)\s*:\s*(.+)$/i
  );

  if (!match) {
    return undefined;
  }

  const goalText = match[1]?.trim();
  const progressText = match[2]?.trim();

  if (!goalText || !progressText) {
    return undefined;
  }

  const goal = findGoalByTitleFragment(activeGoals, goalText);

  if (!goal) {
    return {
      type: "goal_progress_log",
      summary: "Goal progress needs a matching goal",
      payload: {},
      reply: "I am not sure which goal this belongs to. Run /goals, then use /log_progress <goalId> | <progress>.",
      createPending: false
    };
  }

  const progress = inferProgressInputFromText(progressText);

  return {
    type: "goal_progress_log",
    summary: `Log progress for ${goal.title}`,
    payload: {
      goalId: goal.id,
      ...progress
    },
    reply: `I can log progress for ${goal.title}: ${progress.note ?? progressText}. Reply yes to confirm or no to cancel.`
  };
}

function detectNaturalCustomProgress(
  message: string,
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>
): { goal: Awaited<ReturnType<typeof getActiveGoals>>[number]; minutes: number } | undefined {
  const match = message.match(
    /\b(?:worked|spent|hice)\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|minutos?)\s+(?:on|en)\s+(?:my\s+)?(.+)$/i
  );

  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const minutes = Number(match[1]);

  if (!Number.isFinite(minutes)) {
    return undefined;
  }

  const goal = findMatchingCustomGoal(activeGoals, match[2]);

  return goal ? { goal, minutes } : undefined;
}

function findMatchingCustomGoal(
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>,
  text: string
) {
  const customGoals = activeGoals.filter((goal) => !goal.templateId && goal.status === "active");
  const normalizedText = normalizeComparableText(text);

  return customGoals.find((goal) => customGoalMatchesText(goal, normalizedText));
}

function customGoalMatchesText(goal: Awaited<ReturnType<typeof getActiveGoals>>[number], normalizedText: string): boolean {
  const goalTitle = normalizeComparableText(goal.title);

  if (goalTitle.includes(normalizedText) || normalizedText.includes(goalTitle)) {
    return true;
  }

  const goalWords = goalTitle.split(" ").filter((word) => word.length > 3);
  const hasSharedGoalWord = goalWords.some((word) => normalizedText.includes(word));

  if (hasSharedGoalWord) {
    return true;
  }

  if (
    /youtube|channel|script|video|content/.test(normalizedText) &&
    /youtube|channel|content|video/.test(goalTitle)
  ) {
    return true;
  }

  if (/car|dealership|seller|coche|carro/.test(normalizedText) && /car|coche|buy|cheap/.test(goalTitle)) {
    return true;
  }

  return false;
}

function findGoalByTitleFragment(
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>,
  goalText: string
) {
  const normalizedGoalText = normalizeComparableText(goalText);
  const matches = activeGoals.filter((goal) => {
    const normalizedTitle = normalizeComparableText(goal.title);
    return normalizedTitle === normalizedGoalText || normalizedTitle.includes(normalizedGoalText) || normalizedGoalText.includes(normalizedTitle);
  });

  return matches.length === 1 ? matches[0] : undefined;
}

function inferProgressInputFromText(text: string) {
  const minutesMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|minutos?)\b/i);

  if (minutesMatch) {
    return {
      metricKey: "focused_minutes",
      value: Number(minutesMatch[1]),
      unit: "minutes",
      note: text
    };
  }

  return {
    metricKey: "progress_actions",
    value: 1,
    note: text
  };
}

function detectGoalArchiveProposal(
  message: string,
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>
): StructuralProposal | undefined {
  if (!/\b(archive|stop tracking|found a job|archiva|encontr[eé] trabajo)\b/i.test(message)) {
    return undefined;
  }

  const normalized = message.toLowerCase();
  const matchingGoals = activeGoals.filter((goal) => {
    const goalText = `${goal.title} ${goal.category}`.toLowerCase();

    if (normalized.includes("job") || normalized.includes("trabajo")) {
      return goal.category === "career" || goalText.includes("job");
    }

    return goal.title
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3)
      .some((word) => normalized.includes(word));
  });

  if (matchingGoals.length !== 1) {
    return {
      type: "goal_archive",
      summary: "Goal archive needs an explicit goal id",
      payload: {},
      reply: "I am not sure which goal to archive. Run /goals and then /archive_goal <goalId>.",
      createPending: false
    };
  }

  const goal = matchingGoals[0];

  return {
    type: "goal_archive",
    summary: `Archive goal: ${goal.title}`,
    payload: { goalId: goal.id },
    reply: `I can archive this goal: ${goal.title} (${goal.category}). Reply yes to confirm or no to cancel.`
  };
}

function inferGoalCategory(message: string): string {
  if (/\b(job|cv|recruiter|interview|career|trabajo)\b/.test(message)) {
    return "career";
  }

  if (/\b(gym|strength|sleep|health|diet|steps|sueñ|salud)\b/.test(message)) {
    return "health";
  }

  if (/\b(read|study|course|learn|rust|leer|aprender|estudiar)\b/.test(message)) {
    return "learning";
  }

  if (/\b(startup|project|build|product)\b/.test(message)) {
    return "work";
  }

  if (/\b(betting|trading|gambling|bet|trade|apuesta|apostar)\b/.test(message)) {
    return "finance";
  }

  return "custom";
}

function inferGoalTemplateId(message: string): string | undefined {
  if (/\b(find a new job|find.*job|buscar trabajo|job search|cv|recruiter|interview)\b/.test(message)) {
    return "career.job_search";
  }

  if (/\b(get stronger|strength|gym|train|entrenar|fuerte)\b/.test(message)) {
    return "health.strength_energy";
  }

  if (/\b(sleep better|dormir mejor|sleep)\b/.test(message)) {
    return "health.sleep_better";
  }

  if (/\b(read more|leer m[aá]s|reading)\b/.test(message)) {
    return "learning.reading_more";
  }

  if (/\b(learn|study|course|rust|aprender|estudiar)\b/.test(message)) {
    return "learning.skill_learning";
  }

  if (/\b(stop betting|betting impulsively|control betting|control trading|apostar|apuestas|trading)\b/.test(message)) {
    return "finance.control_betting_trading";
  }

  if (/\b(build a startup|build.*project|startup|project|product)\b/.test(message)) {
    return "creative.build_project";
  }

  return undefined;
}

function inferGoalTitle(message: string, category: string, templateId?: string): string {
  const customTitle = inferSpecificGoalTitle(message);

  if (customTitle) {
    return customTitle;
  }

  const normalized = message.toLowerCase();

  if (templateId === "career.job_search") {
    return "Find a new job";
  }

  if (templateId === "health.strength_energy") {
    return "Improve strength and energy";
  }

  if (templateId === "health.sleep_better") {
    return "Sleep better";
  }

  if (templateId === "learning.reading_more") {
    return "Read more";
  }

  if (templateId === "finance.control_betting_trading") {
    return "Control betting and trading";
  }

  if (templateId === "creative.build_project") {
    return "Build project momentum";
  }

  if (category === "career") {
    return "Find a new job";
  }

  if (category === "health" && /\b(sleep|sueñ)/.test(normalized)) {
    return "Improve sleep";
  }

  if (category === "health") {
    return "Improve strength and energy";
  }

  if (category === "learning" && /\brust\b/i.test(message)) {
    return "Learn Rust";
  }

  if (category === "learning" && /\b(read|leer)\b/.test(normalized)) {
    return "Read more";
  }

  if (category === "learning") {
    return "Improve learning";
  }

  if (category === "work") {
    return "Build project momentum";
  }

  if (category === "finance") {
    return "Improve finance discipline";
  }

  return inferGenericGoalTitle(message) ?? "Clarify new focus";
}

function inferSpecificGoalTitle(message: string): string | undefined {
  const cleaned = message
    .replace(/^\s*(i want to focus on|create a goal to|my new focus is|i want to|quiero centrarme en|quiero mejorar|quiero buscar|quiero)\s+/i, "")
    .trim()
    .replace(/[.!?]+$/g, "");

  if (!cleaned || cleaned.length < 8) {
    return undefined;
  }

  if (/\b(read more|study|learn|leer m[aá]s|estudiar|aprender)\b/i.test(cleaned)) {
    return titleCaseGoal(
      cleaned
        .replace(/^read more and study consistently\s+(.+)$/i, "read more and study $1 consistently")
        .replace(/^leer m[aá]s y estudiar consistentemente\s+/i, "leer más y estudiar ")
    );
  }

  return undefined;
}

function titleCaseGoal(title: string): string {
  const trimmed = title.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : title;
}

function inferGenericGoalTitle(message: string): string | undefined {
  const cleaned = message
    .replace(/^\s*(i want to focus on|create a goal to|my new focus is|i want to|quiero centrarme en|quiero mejorar|quiero buscar|quiero)\s+/i, "")
    .trim()
    .replace(/[.!?]+$/g, "");

  return cleaned.length >= 8 && cleaned.length <= 90 ? titleCaseGoal(cleaned) : undefined;
}

function formatCustomGoalCreateProposal(title: string, config: ReturnType<typeof buildCustomGoalConfig>): string {
  const metrics = config.targetMetrics.map((metric) => metric.key).join(", ");
  const questions = config.checkInConfig.map((question) => question.question).slice(0, 3).join(" / ");

  return [
    `I can create this custom goal: ${title}.`,
    `Metrics: ${metrics}.`,
    `Check-ins: ${questions}.`,
    "Reply yes to confirm or no to cancel."
  ].join(" ");
}

function detectOpenAIStructuralProposal(analysis: OpenAIMessageAnalysis | undefined): StructuralProposal | undefined {
  const proposedAction = analysis?.proposedAction;

  if (!proposedAction || proposedAction.type === "none" || proposedAction.confidence < 0.7) {
    return undefined;
  }

  if (proposedAction.type === "profile_update" && isRecord(proposedAction.payload.profilePatch)) {
    return {
      type: "profile_update",
      summary: proposedAction.summary,
      payload: { profilePatch: proposedAction.payload.profilePatch },
      reply: `I can update your profile: ${proposedAction.summary}. Reply yes to confirm or no to cancel.`
    };
  }

  if (
    proposedAction.type === "goal_create" &&
    typeof proposedAction.payload.title === "string" &&
    typeof proposedAction.payload.category === "string"
  ) {
    const customConfig = buildCustomGoalConfig({
      title: proposedAction.payload.title,
      category: proposedAction.payload.category,
      why: typeof proposedAction.payload.why === "string" ? proposedAction.payload.why : undefined
    });

    return {
      type: "goal_create",
      summary: proposedAction.summary,
      payload: {
        title: proposedAction.payload.title,
        category: proposedAction.payload.category,
        why: typeof proposedAction.payload.why === "string" ? proposedAction.payload.why : undefined,
        targetMetrics: customConfig.targetMetrics,
        checkInConfig: customConfig.checkInConfig
      },
      reply: formatCustomGoalCreateProposal(proposedAction.payload.title, customConfig)
    };
  }

  if (proposedAction.type === "goal_archive" && typeof proposedAction.payload.goalId === "string") {
    return {
      type: "goal_archive",
      summary: proposedAction.summary,
      payload: { goalId: proposedAction.payload.goalId },
      reply: `I can archive this goal. Reply yes to confirm or no to cancel.`
    };
  }

  return undefined;
}

async function resolvePendingDecisionReply(
  userId: string,
  pendingAction: PendingAction,
  message: string
): Promise<string | undefined> {
  if (isPendingEmailReviewContext(pendingAction)) {
    return resolveEmailReviewContextReply(userId, pendingAction, message);
  }

  if (isPendingCustomGmailRuleContext(pendingAction)) {
    return undefined;
  }

  if (isRecentActionMutationContext(pendingAction)) {
    if (looksLikeRecentMutationStatusQuestion(message)) {
      return formatRecentActionMutationStatus(pendingAction);
    }

    if (isConfirmationMessage(message) || isRejectionMessage(message)) {
      await rejectPendingAction(userId, pendingAction.id);
      return "No pending change is waiting right now.";
    }

    return undefined;
  }

  if (isRejectionMessage(message)) {
    await rejectPendingAction(userId, pendingAction.id);
    return "Cancelled. I did not change anything.";
  }

  const customEmailRuleReply = await resolvePendingCustomEmailRuleReply(userId, pendingAction, message);

  if (customEmailRuleReply) {
    return customEmailRuleReply;
  }

  if (pendingAction.type === "action_target_clarification") {
    const candidates = readPendingActionCandidates(pendingAction.payload.candidateActions);
    const selected = selectPendingActionCandidate(message, candidates);

    if (!selected) {
      return candidates.length > 0
        ? `Reply with 1-${candidates.length}, the action title, or cancel.`
        : "That pending decision no longer has any options. Please ask again.";
    }

    const operation = typeof pendingAction.payload.intendedOperation === "string"
      ? pendingAction.payload.intendedOperation
      : "";
    const action = await getActionItem(userId, selected.id);

    if (!action) {
      await rejectPendingAction(userId, pendingAction.id);
      return "I could not find that action anymore. Use /actions to check the exact task.";
    }

    if (operation === "complete_action") {
      if (action.status === "completed") {
        await confirmPendingAction(userId, pendingAction.id);
        return `Action already completed: ${action.title}`;
      }

      const completed = await completeActionItem(userId, action.id);

      if (!completed) {
        await rejectPendingAction(userId, pendingAction.id);
        return "I could not find that open action.";
      }

      const progressEvent = await createGoalProgressFromCompletedAction(userId, completed);
      await confirmPendingAction(userId, pendingAction.id);

      return [
        `Action completed: ${completed.title}`,
        progressEvent?.created ? `Goal progress logged: ${progressEvent.goalTitle}` : undefined
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (operation === "archive_action") {
      await replacePendingAction(userId, {
        type: "action_archive",
        summary: `Archive action: ${action.title}`,
        payload: {
          originalText: pendingAction.payload.originalText,
          intendedOperation: "archive_action",
          actionId: action.id,
          candidateActions: [toPendingActionCandidate(action)]
        },
        expiresAt: pendingDecisionExpiry()
      });

      return `Confirm archive action: ${action.title}? Reply yes to confirm or no to cancel.`;
    }

    if (operation === "snooze_action" || operation === "reschedule_action") {
      const settings = await getOrCreateNotificationSettings(userId);
      const dueAtText = typeof pendingAction.payload.parsedDueAt === "string" ? pendingAction.payload.parsedDueAt : "";
      const dueAt = dueAtText ? new Date(dueAtText) : undefined;

      if (!dueAt || Number.isNaN(dueAt.getTime())) {
        await rejectPendingAction(userId, pendingAction.id);
        return "I could not parse the new time. Try: tomorrow afternoon, 6pm, or Monday morning.";
      }

      const updated =
        operation === "snooze_action"
          ? await snoozeActionItem(userId, action.id, dueAt)
          : await rescheduleActionItem(userId, action.id, dueAt);

      if (!updated) {
        await rejectPendingAction(userId, pendingAction.id);
        return "I could not update that action.";
      }

      await confirmPendingAction(userId, pendingAction.id);

      return operation === "snooze_action"
        ? `Action snoozed until ${formatLocalDateTime(updated.snoozedUntil, settings.timezone)}: ${updated.title}`
        : [`Action rescheduled: ${updated.title}`, `due: ${formatLocalDateTime(updated.dueAt, settings.timezone)}`].join("\n");
    }

    return "I could not complete that pending decision. Please ask again.";
  }

  if (pendingAction.type === "action_hygiene" && typeof pendingAction.payload.operation !== "string") {
    const sessionNow =
      typeof pendingAction.payload.now === "string" ? parseOptionalNow(pendingAction.payload.now) ?? undefined : undefined;
    return resolveActionHygieneReply(userId, pendingAction, message, sessionNow);
  }

  if (pendingAction.type === "next_week_plan") {
    return resolveNextWeekPlanReply(userId, pendingAction, message);
  }

  if (isConfirmationMessage(message)) {
    const applied = await applyPendingAction(userId, pendingAction);
    await confirmPendingAction(userId, pendingAction.id);
    await maybeRememberRecentActionMutationStatus(userId, pendingAction, applied.reply);
    return applied.reply;
  }

  return undefined;
}

function looksLikePendingDecisionReply(message: string): boolean {
  const trimmed = message.trim();
  const hygieneReply = parseActionHygieneReply(trimmed);
  const hygieneTarget = hygieneReply?.target ?? "";
  const isNumberedHygieneReply = Boolean(
    hygieneReply &&
      (/^#?\d+$/.test(hygieneTarget) ||
        /^(first|second|third|fourth|fifth)(\s+one)?$/i.test(hygieneTarget) ||
        /^(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta)$/i.test(hygieneTarget))
  );

  return (
    isConfirmationMessage(trimmed) ||
    isRejectionMessage(trimmed) ||
    isNumberedHygieneReply ||
    Boolean(parseNextWeekPlanReply(trimmed)) ||
    /^#?\d+$/.test(trimmed) ||
    /^(the\s+)?(first|second|third|fourth|fifth)(\s+one)?$/i.test(trimmed) ||
    /^(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta)$/i.test(trimmed)
  );
}

function looksLikeExpiredPendingDecisionReply(message: string): boolean {
  const trimmed = message.trim();

  if (
    isConfirmationMessage(trimmed) ||
    isRejectionMessage(trimmed) ||
    /^#?\d+$/.test(trimmed) ||
    /^(the\s+)?(first|second|third|fourth|fifth)(\s+one)?$/i.test(trimmed) ||
    /^(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta)$/i.test(trimmed)
  ) {
    return true;
  }

  return (
    /^(skip|cancel|show\s+plan)$/i.test(trimmed) ||
    /^create\s+(?:all(?:\s+new)?|(?:#?\d+\s*(?:,|\band\b)?\s*)+)$/i.test(trimmed) ||
    /^edit\s+#?\d+\s+to\s+.+$/i.test(trimmed) ||
    /^remove\s+#?\d+$/i.test(trimmed) ||
    looksLikeEmailReviewContextAction(trimmed)
  );
}

function isRecentActionMutationContext(pendingAction: PendingAction): boolean {
  return (
    pendingAction.type === "action_hygiene" &&
    isRecord(pendingAction.payload) &&
    pendingAction.payload.operation === "recent_mutation_status"
  );
}

function looksLikeRecentMutationStatusQuestion(message: string): boolean {
  const text = normalizeForComparison(message);
  return (
    /\b(did|do|done|changed|change|archive|archived|snooze|snoozed|complete|completed|happened|previous|last)\b/.test(text) &&
    /\b(you|u|it|all|them|those|that|command|stuff|do|did|changed)\b/.test(text)
  ) || /\b(que has cambiado|que hiciste|què has canviat|ho has fet|did you do it)\b/.test(text);
}

function formatRecentActionMutationStatus(pendingAction: PendingAction): string {
  const recentReply = typeof pendingAction.payload.reply === "string" ? pendingAction.payload.reply : "";
  const summary = typeof pendingAction.payload.summary === "string" ? pendingAction.payload.summary : "";

  if (recentReply) {
    return ["Last action changes:", recentReply].join("\n");
  }

  return summary ? `Last action changes: ${summary}` : "I do not have a recent action change recorded.";
}

async function maybeRememberRecentActionMutationStatus(
  userId: string,
  pendingAction: PendingAction,
  reply: string
): Promise<void> {
  if (pendingAction.type !== "action_hygiene" && pendingAction.type !== "action_archive" && pendingAction.type !== "action_target_clarification") {
    return;
  }

  await maybeRememberRecentActionMutationStatusFromReply(userId, reply);
}

function surfaceReplyIncludesMutation(reply: string): boolean {
  return (
    reply.startsWith("Daily loop updated.") ||
    reply.startsWith("Email rule enabled:") ||
    reply.startsWith("I can set up a review-first Gmail rule.") ||
    reply.startsWith("Gmail rule active:") ||
    reply.startsWith("Gmail rule paused:") ||
    reply.startsWith("I can make Gmail") ||
    reply.startsWith("I can set Gmail") ||
    reply.startsWith("I can turn Gmail review notifications") ||
    reply.startsWith("Confirm remove Gmail rule:") ||
    (reply.startsWith("Confirm remove ") && reply.includes("Gmail email rule")) ||
    reply.startsWith("Action hygiene:") ||
    reply.startsWith("Plan ") ||
    reply.startsWith("Weekly plan")
  );
}

function replyOnly(
  userId: string,
  message: string,
  response: string,
  routeDebug?: ProcessRouteDebug
): ProcessMessageResult {
  return {
    userId,
    message,
    intent: "general_chat",
    mode: "mirror",
    riskState: "GREEN",
    extractedEvents: [],
    reply: response,
    routeDebug
  };
}

export function createMessagesProcessHandler(deps: MessagesProcessSyncDeps) {
  return async function process(input: ProcessMessageInput): Promise<ProcessMessageResult> {
    const parsed = { data: input };
    await ensureUser(parsed.data.userId);
    await expireOldPendingActions(parsed.data.userId);

    if (isStandaloneNowMessage(parsed.data.message)) {
      return replyOnly(parsed.data.userId, parsed.data.message, "What should I schedule now? Example: /action call Alex now");
    }

    const earlyGuardrailGoals = await getActiveGoals(parsed.data.userId);
    const earlyGuardrail = evaluateGoalGuardrails({
      text: parsed.data.message,
      activeGoals: earlyGuardrailGoals
    });

    if (earlyGuardrail.triggered && !earlyGuardrail.isReferenceOnly) {
      return createGuardianGuardrailReply(parsed.data.userId, parsed.data.message, earlyGuardrail);
    }

    let latestPendingAction = await getLatestPendingAction(parsed.data.userId);

    if (latestPendingAction) {
      if (shouldReleasePendingGmailAutonomyFocus(latestPendingAction, parsed.data.message)) {
        await rejectPendingAction(parsed.data.userId, latestPendingAction.id);
        latestPendingAction = undefined;
      } else {
        const pendingReply = await resolvePendingDecisionReply(parsed.data.userId, latestPendingAction, parsed.data.message);

        if (pendingReply) {
          return replyOnly(parsed.data.userId, parsed.data.message, pendingReply, {
            routerSource: "pending_decision",
            intent: latestPendingAction.type,
            handlerName: "resolvePendingDecisionReply",
            mutation:
              isConfirmationMessage(parsed.data.message) ||
              isRejectionMessage(parsed.data.message) ||
              (latestPendingAction.type === "email_review_context" && looksLikeEmailReviewContextAction(parsed.data.message)),
            reason: "Resolved existing pending decision before normal routing."
          });
        }
      }
    } else if (looksLikeExpiredPendingDecisionReply(parsed.data.message)) {
      return replyOnly(parsed.data.userId, parsed.data.message, "That pending decision expired. Please ask again.");
    }

    if (isPendingCustomGmailRuleCreate(latestPendingAction)) {
      const pendingGmailRoute = await handleSemanticRouterIntent(parsed.data.userId, parsed.data.message, latestPendingAction, deps);

      if (pendingGmailRoute) {
        return replyOnly(parsed.data.userId, parsed.data.message, pendingGmailRoute.reply, pendingGmailRoute.routeDebug);
      }
    }

    if (looksLikeUnresolvedHygieneReply(parsed.data.message)) {
      return replyOnly(
        parsed.data.userId,
        parsed.data.message,
        "I don't have a visible cleanup item right now. Say 'clean up my tasks' first."
      );
    }

    const planningRequest = detectPlanningRequestKind(parsed.data.message);
    if (planningRequest) {
      return replyOnly(parsed.data.userId, parsed.data.message, await createPlanForConversation(parsed.data.userId, parsed.data.message, planningRequest));
    }

    const explicitMemory = extractExplicitMemory(parsed.data.message);

    if (explicitMemory) {
      await createMemory(parsed.data.userId, {
        ...explicitMemory,
        source: "explicit_user_request",
        confidence: 1,
        evidence: {
          message: parsed.data.message
        }
      });

      const actionResult = await maybeCreateManualActionFromText(parsed.data.userId, explicitMemory.summary);
      const replyText = actionResult.extraction.shouldCreateAction
        ? ["Saved to memory.", formatActionCreatedReply(actionResult)].join("\n")
        : actionResult.extraction.reason === "past_explicit_time"
          ? "Saved to memory.\nThat time has already passed. Use a future time, or say 'now'."
        : "Saved to memory.";

      return replyOnly(parsed.data.userId, parsed.data.message, replyText);
    }

    const activeGoalsForGuardrail = earlyGuardrailGoals;
    const surfaceGuardrail = evaluateGoalGuardrails({
      text: parsed.data.message,
      activeGoals: activeGoalsForGuardrail
    });

    if (surfaceGuardrail.triggered && !surfaceGuardrail.isReferenceOnly) {
      return createGuardianGuardrailReply(parsed.data.userId, parsed.data.message, surfaceGuardrail);
    }

    const directIntentBeforeSurface = routeIntent(parsed.data.message);

    if ((!surfaceGuardrail.triggered || surfaceGuardrail.isReferenceOnly) && !isFinancialRiskIntent(directIntentBeforeSurface)) {
      const surfaceReply = await handleConversationSurfaceIntent(parsed.data.userId, parsed.data.message, deps);

      if (surfaceReply) {
        return replyOnly(parsed.data.userId, parsed.data.message, surfaceReply, {
          routerSource: "deterministic_surface",
          intent: detectConversationSurfaceIntent(parsed.data.message) ?? "unknown",
          handlerName: "handleConversationSurfaceIntent",
          mutation: surfaceReplyIncludesMutation(surfaceReply),
          reason: "Matched deterministic conversation surface intent."
        });
      }
    }

    const semanticRouterReply = await handleSemanticRouterIntent(parsed.data.userId, parsed.data.message, latestPendingAction, deps);

    if (semanticRouterReply) {
      return replyOnly(parsed.data.userId, parsed.data.message, semanticRouterReply.reply, semanticRouterReply.routeDebug);
    }

    const recentEvents = await getRecentEvents(parsed.data.userId, 50);
    const activeGoals = activeGoalsForGuardrail;
    const activeMemories = await getActiveMemories(parsed.data.userId);
    const userOperatingProfile = await getOrCreateUserOperatingProfile(parsed.data.userId);
    const processInput = {
      ...parsed.data,
      recentEvents,
      userOperatingProfile
    };
    const manualActionResult = await maybeCreateManualActionFromText(parsed.data.userId, parsed.data.message);

    if (manualActionResult.extraction.shouldCreateAction) {
      return replyOnly(parsed.data.userId, parsed.data.message, formatActionCreatedReply(manualActionResult));
    }

    if (manualActionResult.extraction.reason === "past_explicit_time") {
      return replyOnly(parsed.data.userId, parsed.data.message, "That time has already passed. Use a future time, or say 'now'.");
    }

    const unhandledControlIntent = detectConversationControlIntent(parsed.data.message);

    if (isConversationalMutationIntent(unhandledControlIntent.intent)) {
      return replyOnly(
        parsed.data.userId,
        parsed.data.message,
        "I could not complete that change. Use /actions to check the exact task."
      );
    }

    const naturalCustomProgress = detectNaturalCustomProgress(parsed.data.message, activeGoals);

    if (naturalCustomProgress) {
      const event = await createCustomGoalProgressEvent(parsed.data.userId, naturalCustomProgress.goal, {
        metricKey: "focused_minutes",
        value: naturalCustomProgress.minutes,
        unit: "minutes",
        note: parsed.data.message
      });

      return {
        userId: parsed.data.userId,
        message: parsed.data.message,
        intent: "event_logging",
        mode: "fiscal",
        riskState: "GREEN",
        extractedEvents: [],
        reply: `Logged for ${naturalCustomProgress.goal.title}: ${naturalCustomProgress.minutes} focused minutes.`
      } satisfies ProcessMessageResult;
    }

    const ruleBasedStructuralProposal = detectStructuralProposal(parsed.data.message, activeGoals);

    if (ruleBasedStructuralProposal) {
      if (ruleBasedStructuralProposal.createPending !== false) {
        await createPendingAction(parsed.data.userId, {
          type: ruleBasedStructuralProposal.type,
          summary: ruleBasedStructuralProposal.summary,
          payload: ruleBasedStructuralProposal.payload,
          expiresAt: tomorrow()
        });
      }

      return replyOnly(parsed.data.userId, parsed.data.message, ruleBasedStructuralProposal.reply);
    }

    const openAIAnalysis = await maybeAnalyzeWithOpenAI(processInput, activeGoals, userOperatingProfile, activeMemories);
    const structuralProposal = detectOpenAIStructuralProposal(openAIAnalysis);

    if (structuralProposal) {
      if (structuralProposal.createPending !== false) {
        await createPendingAction(parsed.data.userId, {
          type: structuralProposal.type,
          summary: structuralProposal.summary,
          payload: structuralProposal.payload,
          expiresAt: tomorrow()
        });
      }

      return replyOnly(parsed.data.userId, parsed.data.message, structuralProposal.reply);
    }

    const result = withMemoryContextReply(analyzeMessage(processInput, openAIAnalysis), activeMemories);
    const savedEvents = await createEventsFromExtracted(result.userId, result.extractedEvents);
    const isRedFinancialRisk = isFinancialRiskIntent(result.intent) && result.riskState === "RED";
    const guardrail = evaluateGoalGuardrails({ text: result.message, activeGoals });

    if (isRedFinancialRisk) {
      const cooldownEvent = await createEvent(result.userId, {
        type: "finance.betting.cooldown_triggered",
        timestamp: new Date(),
        source: "manual",
        data: {
          intent: result.intent,
          reason: "red_risk_state",
          guardrail: guardrail.triggered
            ? {
                goalId: guardrail.goalId,
                goalTitle: guardrail.goalTitle,
                category: guardrail.guardrailCategory,
                severity: guardrail.severity,
                responseMode: guardrail.responseMode,
                blockedActionCreation: guardrail.blockedActionCreation,
                cooldownRequired: guardrail.cooldownRequired,
                reason: guardrail.reason
              }
            : undefined
        },
        confidence: 1,
        evidence: [result.message]
      });

      await maybeCreateRepeatedCooldownPendingMemory(result.userId, cooldownEvent);
      const composed = await composeFinalAgentResponse(result, {
        extractedEvents: [cooldownEvent]
      });

      return {
        ...result,
        reply: composed.reply
      };
    }

    const composed = await composeFinalAgentResponse(result, {
      extractedEvents: savedEvents.length > 0 ? savedEvents : undefined
    });

    return {
      ...result,
      reply: composed.reply
    } satisfies ProcessMessageResult;
  };
}
