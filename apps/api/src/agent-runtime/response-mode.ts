/**
 * fix/private-alpha-coach-first-response-routing: shared message-shape classification for
 * deciding whether a turn is allowed to mutate an action at all, used by BOTH runtime.ts's
 * pre-validation op-stripping reconciler (the primary path, for LLM-planner-sourced operations —
 * strips the mutation so the planner's own real coaching/planning replyDraft is exactly what's
 * shown, never replaced with a canned line) and validator.ts's own safety-net downgrade (for
 * deterministic-shortcut-sourced operations, which never have an LLM replyDraft to fall back to
 * in the first place, so a clarification-shaped reply genuinely is the honest, necessary option
 * there). Kept in its own dependency-free module — not merged into either file — so both call
 * sites share the exact same regexes without a circular import (runtime.ts already imports
 * validateOperations etc. FROM validator.ts, so the reverse import isn't available).
 *
 * Real live-transcript bug this closes: a user in an active coaching conversation ("I rested this
 * weekend with friends, is that okay?" -> real coaching answer) followed up with "I'll try to
 * send CVs tonight and more this week" — a soft, hedged intention, not a command — and got
 * "Action rescheduled: Send 3 CVs due: 31/08/2026, 20:00" instead of a coaching answer that
 * anchors the already-due action without touching it. The word "tonight" alone made the OLD
 * guard (CONCRETE_DAY_OR_TIME_RE, since removed) treat the message as concrete enough to let the
 * mutation through — but mentioning a time is not the same as commanding a change; only an
 * explicit, unambiguous instruction verb (EXPLICIT_MUTATION_VERB_RE) is.
 */

// Reflective/reassurance/judgment questions — "is that okay?", "was that okay?", Spanish "¿está
// bien?", Catalan "està bé?". Trailing \b right after an accented "é" never matches in a plain
// (non-unicode) JS regex — é isn't a \w character, so there's no word/non-word transition between
// "é" and, say, a "," or "?" right after it (both already read as non-word) — worked around with
// a negative lookahead instead, the same fix validator.ts's EXPLICIT_WHEN_SCOPE_RE already uses
// for the identical problem with Catalan "demà".
export const COACH_CONVERSATION_RE =
  /\bis (it|that|this) (okay|ok)\b|\bwas (it|that|this) (okay|ok)\b|\b¿?est[aá] bien\b|\b¿?est[aà] b[ée](?![a-zA-Z])/i;

// A soft, uncommitted intention — never itself a scheduling instruction, even when it happens to
// also mention a day/time word ("tonight," "this week") alongside the hedge. "Mentioning a time
// is not enough to mutate": this is deliberately NOT narrowed by any "but a concrete day/time
// makes it real" escape valve (an earlier version of this guard had one; it's exactly what let
// the real reported bug through, since "tonight" read as concrete enough on its own).
// Trailing \b right after an accented "é" never matches in a plain (non-unicode) JS regex — é
// isn't a \w character, so there's no word/non-word transition between "é" and, say, a "," or
// space right after it (both already read as non-word) — worked around with a negative lookahead
// instead ("intentaré[space]" — without this fix, "intentaré enviar CVs esta noche" never matched
// at all). Same fix used elsewhere in this codebase for the identical problem with Catalan "demà".
export const SOFT_INTENTION_RE =
  /\b(i'?ll try|i will try|will try|i want to|i wanna)\b|\bhopefully\b|\bmaybe\b|\bwhen i get there\b|\block(?:ing)? in\b|\b(later this week|later in the week|this week)\b|\btonight maybe\b|\bmaybe tonight\b|\bintentar[eé](?![a-zA-Z])|\bcuando llegue\b|\bquan hi arribi\b|\bquiero\b|\bvull\b|\bmas adelante esta semana\b|\bmes endavant aquesta setmana\b/i;

// An explicit, unambiguous instruction to change something — always wins over coach_conversation/
// soft_intention above, regardless of what else the same message also says. Deliberately
// duplicated (not re-composed from runtime.ts's own ACTION_SNOOZE_PATTERN/etc, which exist for a
// different purpose — triggering an immediate deterministic shortcut, not gating mutation
// eligibility) so this module stays a single, dependency-free source of truth for exactly this
// classification.
export const EXPLICIT_MUTATION_VERB_RE =
  /\bsnooze\b|\bmove (it|this|that)\b|\bbring (it|this|that) back\b|\bpark (it|this|that)\b|\bpush (it|this|that)\b|\bdefer\b|\bremind me\b|\bmuevelo\b|\bpasalo\b|\brecuerdamelo\b|\bmou-ho\b|\bpassa-ho\b|\brecorda-m['’]ho\b|\barchive\b|\bdismiss\b|\b(complete(d)?|finish(ed)?|mark(ed)? (?:it |that )?(?:as )?(?:done|complete))\b|^(done|finished|hecho|terminado|listo|fet|llest)\b|\bja\s+(esta|ho he)\s+fet\b|\breschedule\b|\bpostpone\b|\bcreate (a|an) (task|action|reminder)\b|\badd (a|an) (task|action|reminder)\b|\bschedule\b|\bset it (for|to)\b/i;

/** The five tools a coach-first turn is never allowed to silently run. */
export const RESPONSE_MODE_GATED_MUTATION_TOOLS = new Set(["action.reschedule", "action.snooze", "action.complete", "action.archive", "action.create"]);

/** True when THIS message alone reads as coach_conversation or soft_intention — never true when
 * an explicit mutation verb is also present, which always wins regardless of anything else said. */
export function isCoachFirstMessage(message: string): boolean {
  return (COACH_CONVERSATION_RE.test(message) || SOFT_INTENTION_RE.test(message)) && !EXPLICIT_MUTATION_VERB_RE.test(message);
}
