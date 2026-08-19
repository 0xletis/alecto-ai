/**
 * Generic, dependency-free string-normalization helper extracted from
 * apps/api/src/server.ts, where it was defined once privately and called
 * ~59 times for unrelated comparisons (goals, reflections, next-week plans,
 * email rules, etc.). Moved here — rather than into the new
 * apps/api/src/gmail/gmail-rule-service.ts, which also needs it — so the
 * Gmail module's own exports stay focused on Gmail-rule concerns instead of
 * re-exporting an unrelated generic utility.
 */
export function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

/**
 * Generic title-casing helper extracted from apps/api/src/server.ts, where
 * it was used both for goal/suggestion titles and inside the legacy Gmail
 * conversation cluster (apps/api/src/legacy/gmail-conversation.ts) — moved
 * here so both call sites share one implementation instead of the Gmail
 * module reaching back into server.ts.
 */
export function sentenceLikeTitle(value: string): string {
  const title = value
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "";
}

/**
 * Generic "N email reviews are waiting" formatter extracted from
 * apps/api/src/server.ts, where it was called both by Gmail sync-result
 * formatting that stayed in server.ts and by the extracted legacy Gmail
 * conversation cluster — moved here so both share one implementation.
 */
export function pendingEmailReviewLine(count: number): string | undefined {
  return count > 0
    ? `${count} email review${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} waiting. Say "email reviews" to handle ${count === 1 ? "it" : "them"}.`
    : undefined;
}

/**
 * Generic yes/no message classifiers extracted from apps/api/src/server.ts,
 * where they were used across every kind of pending-decision confirmation
 * (not just Gmail rules) — moved here so the legacy Gmail conversation
 * cluster (apps/api/src/legacy/gmail-conversation.ts) can use them without
 * importing back from server.ts.
 */
export function isConfirmationMessage(message: string): boolean {
  return /^(yes|y|ok|okay|confirm|confirmo|sí|si|dale|do it)$/i.test(message.trim());
}

export function isRejectionMessage(message: string): boolean {
  return /^(no|cancel|cancelar|nope|stop|don't|dont)$/i.test(message.trim());
}

/**
 * Generic ASCII-only text comparison helper extracted from
 * apps/api/src/server.ts, where it was used across memory dedup, goal
 * matching, and email review selection — not specific to action hygiene,
 * which is why it lives here rather than in
 * apps/api/src/actions/pending-candidate.ts (which also needs it).
 */
export function normalizeComparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Generic "first/second/third..." (English/Spanish) ordinal-word parser
 * extracted from apps/api/src/server.ts alongside normalizeComparableText,
 * for the same reason.
 */
export function ordinalSelectionIndex(text: string): number | undefined {
  const normalized = normalizeComparableText(text);
  const map: Record<string, number> = {
    first: 0,
    "first one": 0,
    primero: 0,
    primera: 0,
    second: 1,
    "second one": 1,
    segundo: 1,
    segunda: 1,
    third: 2,
    "third one": 2,
    tercero: 2,
    tercera: 2,
    fourth: 3,
    "fourth one": 3,
    fourthone: 3,
    cuarto: 3,
    cuarta: 3,
    fifth: 4,
    "fifth one": 4,
    quinto: 4,
    quinta: 4
  };

  return map[normalized];
}

/**
 * Generic "do these two normalized strings share a meaningful (4+ char)
 * word" helper extracted from apps/api/server.ts, where it was used across
 * reflection matching, weekly-review draft safety checks, and next-week
 * planning dedupe — not specific to planning, which is why it lives here
 * rather than in apps/api/src/legacy/planning-conversation.ts (which also
 * needs it).
 */
export function sharesMeaningfulToken(left: string, right: string): boolean {
  const rightTokens = new Set(right.split(" ").filter((token) => token.length >= 4));
  return left.split(" ").some((token) => token.length >= 4 && rightTokens.has(token));
}

/**
 * Generic unsafe-language filter extracted from apps/api/src/server.ts,
 * where it was used both by the operator-reflection candidate builder
 * (stays in server.ts) and the legacy weekly-review cluster's LLM-draft
 * safety check (apps/api/src/legacy/weekly-review-conversation.ts), which
 * also needs it.
 */
export function containsUnsafeReflectionLanguage(text: string): boolean {
  return /\b(lazy|addict|addicted|undisciplined|diagnosis|disorder|pathological|hopeless|failure)\b/i.test(text);
}

/**
 * Generic plain-text truncation extracted from apps/api/src/server.ts,
 * where it was called ~29 times across email-review formatting, action
 * sanitization, and Gmail sync — not specific to any one domain, which is
 * why it lives here rather than in a domain-specific module.
 */
export function truncatePlainText(text: string, maxLength: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 3)}...` : clean;
}

/**
 * Generic error-to-loggable-string helper extracted from
 * apps/api/src/server.ts, where it was used both by the legacy semantic
 * router (stays in server.ts) and the legacy email-review conversation
 * cluster (apps/api/src/legacy/email-review-conversation.ts), which also
 * needs it.
 */
export function safeErrorForLog(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message.slice(0, 240);
  }

  return "Unknown error";
}
