import { formatLocalDate } from "./time.js";

/**
 * refactor/private-alpha-general-email-intelligence-workflow — Stage D of the email intelligence
 * pipeline (docs in this branch's own final report): given a BATCH of already-classified emails
 * (Stage B's understanding, already stored on each review row), group them into the real-world
 * items a user actually thinks in — "one GoMining application" backed by two confirmation emails,
 * not two separate rows to triage one at a time. Deliberately pure and domain-agnostic: the bucket
 * assignment below is a plain lookup table over the SAME shared EmailKind-shaped vocabulary
 * `understand-email.ts` already returns for every domain (job search, finance, travel, admin, ...),
 * never a job-search-only branch of logic — a caller in any other domain gets exactly the same
 * mechanism, just with its own kind values landing in different buckets.
 *
 * Lives in packages/core (not apps/api) so it stays dependency-free of @operator-agent/db — the
 * input shape below is a MINIMAL local interface, never an import of the real EmailReviewItem type,
 * matching this package's existing convention (see goal-evidence.ts's own EvidenceEventLike).
 */

export type EmailIntelligenceBucket = "count_ready" | "status_update" | "action_worthy" | "needs_decision" | "noise";

export interface EmailIntelligenceSourceItem {
  /** The underlying review/item's own id — never re-derived, always the real database row id. */
  id: string;
  /** 1-based position in the most recently shown list — carried through untouched so a group's
   * member indexes stay individually addressable ("details for 5") even after grouping. */
  index: number;
  subject: string;
  from: string;
  /** The item's own stored classification — the EmailKind-shaped string OR a legacy/free-form
   * value; unrecognized values fall into "needs_decision", never silently treated as noise. Used
   * only when signalBucket (below) is unavailable. */
  reason: string;
  proposedEventType?: string;
  /** refactor/private-alpha-general-email-intelligence-workflow (gate 1): Stage B's OWN direct
   * bucket answer (packages/llm/src/prompts/email-understanding.prompt.ts's SignalBucket), when a
   * fresh understanding call produced one — preferred over the reason-string lookup table below
   * when present, since it's the LLM's own reasoned judgment rather than a static mapping. Absent
   * for a review whose classification is legacy/stale (no fresh understanding available), in which
   * case bucketForReason falls back to the reason-string table exactly as before. "new" and
   * "duplicate_evidence" both still land in count_ready here — Stage D's own dedupe key remains the
   * AUTHORITATIVE duplicate decision (this task's own core principle: deterministic code groups and
   * dedupes), the LLM's own duplicate opinion is informative only. */
  signalBucket?: "new" | "duplicate_evidence" | "status_update" | "action_worthy" | "noise" | "needs_decision";
  /** Stage B's specific ambiguity explanation, when signalBucket is "needs_decision" — replaces the
   * old lazy "uncertain signal" catch-all with what is ACTUALLY unsure about this one item. */
  ambiguity?: string | null;
  /** Structured facts already extracted at classification time — company/role for job search,
   * vendor/amount for finance, etc. Only `company`/`vendor`/`role`/`amount` are read here, by
   * whichever key is actually present; nothing about this function assumes job search specifically. */
  extracted: Record<string, unknown>;
  createdAt: Date;
  priority: "low" | "normal" | "high";
}

export interface EmailIntelligenceGroup {
  /** Stable within one grouping call — a normalized entity+secondary+day key for a duplicate
   * cluster, or the review's own id for a singleton. Never persisted; recomputed fresh every time. */
  key: string;
  bucket: EmailIntelligenceBucket;
  /** Real, ground-truth display title — never invented. "Jiga — Full Stack Product Engineer" when
   * both an entity and a secondary name are known; falls back to the review's own subject line. */
  title: string;
  entity?: string;
  secondary?: string;
  /** Every review folded into this group — length 1 for a normal single item, 2+ only when the
   * dedupe key genuinely matched more than one pending item. */
  memberReviewIds: string[];
  memberIndexes: number[];
  /** The one review used for progress-counting / "details for N" — the OLDEST member (the first
   * real evidence of this event), so a later duplicate is what attaches as evidence, not what
   * becomes the counted item. */
  primaryReviewId: string;
  occurredAt: Date;
  isDuplicateGroup: boolean;
  /** Gate 2 ("no lazy uncertain signal"): the primary member's own specific ambiguity explanation,
   * carried through for a "needs_decision" group so the presentation layer can show WHAT is unsure
   * instead of a bare label. Undefined/null for every other bucket. */
  ambiguity?: string | null;
}

/**
 * Deliberately a flat lookup table, not branching logic — extending this for a new EmailKind (in
 * ANY domain) is a one-line addition here, never a new `if` chain. A kind absent from this map
 * lands in "needs_decision" (fails closed — never silently treated as noise or count-ready).
 */
const KIND_TO_BUCKET: Record<string, EmailIntelligenceBucket> = {
  application_confirmation: "count_ready",
  application_viewed: "status_update",
  recruiter_reply: "action_worthy",
  interview: "action_worthy",
  offer: "action_worthy",
  rejection: "action_worthy",
  job_alert: "noise",
  profile_status: "noise",
  connection_suggestion: "noise",
  security_auth: "noise",
  onboarding: "noise",
  marketing: "noise",
  personal_message: "action_worthy",
  receipt: "noise",
  invoice: "action_worthy",
  payment_due: "action_worthy",
  travel_booking: "action_worthy",
  flight_update: "action_worthy",
  insurance: "action_worthy",
  admin_notice: "action_worthy",
  appointment: "action_worthy",
  subscription: "action_worthy",
  // Legacy/noise-folded reason strings this codebase's sync-time classifier has historically
  // written (see email-review-service.ts's emailReviewClassificationFromUnderstanding) — mapped
  // here too so an OLDER stored row groups exactly the same way a freshly classified one would.
  filtered_marketing: "noise",
  security_auth_noise: "noise",
  onboarding_noise: "noise",
  filtered_non_action_email: "noise",
  // The deterministic job-search text classifier (packages/core/src/ingestion.ts) writes its own
  // reason strings independently of the LLM understanding layer above and uses "interview_scheduled"
  // (not "interview") and "application_action_required" — both real, currently-written values, so
  // both need their own entries rather than relying on the "interview"/"needs_decision" fallback.
  interview_scheduled: "action_worthy",
  application_action_required: "action_worthy"
};

const SIGNAL_BUCKET_TO_GROUP_BUCKET: Record<string, EmailIntelligenceBucket> = {
  new: "count_ready",
  duplicate_evidence: "count_ready",
  status_update: "status_update",
  action_worthy: "action_worthy",
  noise: "noise",
  needs_decision: "needs_decision"
};

function bucketForItem(item: EmailIntelligenceSourceItem): EmailIntelligenceBucket {
  if (item.signalBucket) {
    return SIGNAL_BUCKET_TO_GROUP_BUCKET[item.signalBucket] ?? "needs_decision";
  }
  return KIND_TO_BUCKET[item.reason] ?? "needs_decision";
}

function readStringFact(extracted: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = extracted[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

const VALID_SIGNAL_BUCKETS = new Set(["new", "duplicate_evidence", "status_update", "action_worthy", "noise", "needs_decision"]);

/** Reads back the signalBucket/ambiguity this task's own Stage B extension stashes into a review's
 * existing `extracted` JSON blob on refresh (see executor.ts's refreshEmailReviewClassification
 * call sites) — callers building an EmailIntelligenceSourceItem from a stored review use this
 * rather than reading `extracted` ad hoc, so an invalid/legacy value never silently produces a
 * wrong bucket (falls back to undefined, which bucketForItem then resolves via the reason table). */
export function signalBucketFromExtracted(extracted: Record<string, unknown>): EmailIntelligenceSourceItem["signalBucket"] {
  const value = extracted.signalBucket;
  return typeof value === "string" && VALID_SIGNAL_BUCKETS.has(value) ? (value as EmailIntelligenceSourceItem["signalBucket"]) : undefined;
}

export function ambiguityFromExtracted(extracted: Record<string, unknown>): string | null | undefined {
  const value = extracted.ambiguity;
  return typeof value === "string" ? value : value === null ? null : undefined;
}

function normalizeForKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The dedupe key Stage D groups on — entity (company/vendor) + secondary (role/amount) + the
 * calendar day the item occurred, in the caller's own timezone. Two items with a DIFFERENT
 * secondary (same company, different role) or a different entity (same role, different company)
 * always get different keys — never over-merged, matching this task's own explicit test cases.
 * Falls back to the review's own id (never merges) when no entity fact was extracted at all, since
 * a subject-only match is too weak a signal to safely treat as the same real-world item.
 */
function dedupeKeyFor(item: EmailIntelligenceSourceItem, timezone: string): string | undefined {
  const entity = readStringFact(item.extracted, "company", "vendor", "sender", "merchant");
  if (!entity) {
    return undefined;
  }
  const secondary = readStringFact(item.extracted, "role", "amount", "item", "product") ?? "";
  const day = formatLocalDate(item.createdAt, timezone);
  return `${normalizeForKey(entity)}|${normalizeForKey(secondary)}|${day}`;
}

function titleFor(item: EmailIntelligenceSourceItem): { title: string; entity?: string; secondary?: string } {
  const entity = readStringFact(item.extracted, "company", "vendor", "sender", "merchant");
  const secondary = readStringFact(item.extracted, "role", "amount", "item", "product");
  if (entity && secondary) {
    return { title: `${entity} — ${secondary}`, entity, secondary };
  }
  if (entity) {
    return { title: entity, entity };
  }
  return { title: item.subject || item.from || "Email" };
}

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 2 hardening): a real, minimal,
 * LOCAL shape for the Stage D advisory-reconciliation callback — deliberately NOT importing
 * packages/llm/src/prompts/batch-reconciliation.prompt.ts's own types here, since packages/core has
 * no dependency on packages/llm (only apps/api does). The real caller (executor.ts) adapts
 * reconcileEmailBatch's actual shape to this one when it passes a `reconcile` option in.
 */
export interface BatchReconciliationCandidatePair {
  pairId: string;
  a: { title: string; entity?: string; secondary?: string; occurredAt: string };
  b: { title: string; entity?: string; secondary?: string; occurredAt: string };
}
export interface BatchReconciliationOutcome {
  pairId: string;
  verdict: "same_event" | "different_events" | "unclear";
  reason: string;
}
export type BatchReconciler = (pairs: BatchReconciliationCandidatePair[]) => Promise<BatchReconciliationOutcome[]>;

const NEAR_DUPLICATE_MAX_DAY_GAP = 3;

/** Cheap, deterministic pre-filter for which pairs are even worth ASKING the LLM about — never the
 * merge decision itself. Requires the SAME normalized entity (this task's own rule: "no merge if
 * company differs confidently" — a different company is never even offered as a candidate) and a
 * secondary that's either identical (only the day differs — the case the exact dedupe key
 * structurally cannot catch, since the day is baked into the key) or shares at least one real
 * (4+ char) word (the "slightly different role title" case), within a small day window. */
function isNearDuplicateCandidate(a: EmailIntelligenceGroup, b: EmailIntelligenceGroup): boolean {
  if (!a.entity || !b.entity) return false;
  if (normalizeForKey(a.entity) !== normalizeForKey(b.entity)) return false;

  const daysApart = Math.abs(a.occurredAt.getTime() - b.occurredAt.getTime()) / (24 * 60 * 60 * 1000);
  if (daysApart > NEAR_DUPLICATE_MAX_DAY_GAP) return false;

  const secondaryA = normalizeForKey(a.secondary ?? "");
  const secondaryB = normalizeForKey(b.secondary ?? "");
  if (secondaryA === secondaryB) return true;

  const wordsA = new Set(secondaryA.split(" ").filter((word) => word.length >= 4));
  const wordsB = secondaryB.split(" ").filter((word) => word.length >= 4);
  return wordsB.some((word) => wordsA.has(word));
}

function toReconciliationCandidateItem(group: EmailIntelligenceGroup): BatchReconciliationCandidatePair["a"] {
  return { title: group.title, entity: group.entity, secondary: group.secondary, occurredAt: group.occurredAt.toISOString() };
}

/**
 * Merges every pair the reconciler confidently called "same_event" into one group — union-by-
 * adjacency (a pair is enough to chain A-B-C into one group even without every pair being asked
 * about), but ONLY ever between groups the deterministic pre-filter already approved as candidates
 * (isNearDuplicateCandidate) — an LLM verdict for a pairId that doesn't match a real candidate pair
 * is ignored outright (this task's own "invalid LLM merge ignored" rule), never trusted at face
 * value. The resulting merged group is marked isDuplicateGroup, exactly like an exact-key match —
 * the presentation layer and bulk-count executor treat both identically.
 */
function applyReconciliationOutcomes(
  countReadyGroups: EmailIntelligenceGroup[],
  candidatePairs: Array<{ pairId: string; groupA: EmailIntelligenceGroup; groupB: EmailIntelligenceGroup }>,
  outcomes: BatchReconciliationOutcome[]
): EmailIntelligenceGroup[] {
  const outcomeByPairId = new Map(outcomes.map((outcome) => [outcome.pairId, outcome] as const));
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let current = key;
    while (parent.has(current) && parent.get(current) !== current) current = parent.get(current)!;
    return current;
  };
  const union = (keyA: string, keyB: string) => {
    const rootA = find(keyA);
    const rootB = find(keyB);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const group of countReadyGroups) parent.set(group.key, group.key);

  for (const { pairId, groupA, groupB } of candidatePairs) {
    const outcome = outcomeByPairId.get(pairId);
    // Defense in depth: only a same_event verdict for a pair the deterministic pre-filter itself
    // proposed is ever trusted — an outcome for an unrecognized pairId can't reach here at all
    // (candidatePairs is the source of truth for which pairIds exist), and different_events/unclear
    // always leaves the groups exactly as they were.
    if (outcome?.verdict === "same_event") {
      union(groupA.key, groupB.key);
    }
  }

  const clusters = new Map<string, EmailIntelligenceGroup[]>();
  for (const group of countReadyGroups) {
    const root = find(group.key);
    const cluster = clusters.get(root);
    if (cluster) cluster.push(group);
    else clusters.set(root, [group]);
  }

  return [...clusters.values()].map((cluster) => {
    if (cluster.length === 1) return cluster[0]!;
    const sorted = [...cluster].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const primary = sorted[0]!;
    return {
      ...primary,
      memberReviewIds: sorted.flatMap((group) => group.memberReviewIds),
      memberIndexes: sorted.flatMap((group) => group.memberIndexes),
      isDuplicateGroup: true
    };
  });
}

/**
 * The Stage D entry point. Only "count_ready" items are ever deduplicated into a multi-member
 * group — every other bucket keeps items as individual singleton groups, since collapsing a
 * recruiter reply or an admin notice into a "duplicate" would hide something the user needs to see
 * individually. Sorted within each bucket by occurredAt (oldest first) so numbering stays stable
 * and predictable for the caller's own presentation layer.
 *
 * refactor/private-alpha-general-email-intelligence-workflow (gate 2 hardening): `options.reconcile`
 * is an OPTIONAL advisory pass for near-duplicate candidates the exact dedupe key structurally
 * cannot catch (a one-day-apart confirmation, a slightly reworded role title) — omitted entirely
 * (the default), this function's behavior is byte-for-byte identical to the pure synchronous
 * version it replaces. The exact-key pass above remains fully authoritative and always runs first;
 * the LLM only ever gets a say over pairs that pass do a real deterministic pre-filter
 * (isNearDuplicateCandidate) and its own "same_event" verdicts are still never trusted for a pair it
 * wasn't asked about. Nothing here writes anything — a merged group still requires the user's own
 * explicit "count N" before any progress event is written, exactly like an exact-key duplicate.
 */
export async function groupEmailIntelligenceItems(
  items: EmailIntelligenceSourceItem[],
  timezone: string,
  options: { reconcile?: BatchReconciler } = {}
): Promise<EmailIntelligenceGroup[]> {
  const singletons: EmailIntelligenceGroup[] = [];
  const dedupeClusters = new Map<string, EmailIntelligenceSourceItem[]>();

  for (const item of items) {
    const bucket = bucketForItem(item);
    if (bucket !== "count_ready") {
      const { title, entity, secondary } = titleFor(item);
      singletons.push({
        key: item.id,
        bucket,
        title,
        entity,
        secondary,
        memberReviewIds: [item.id],
        memberIndexes: [item.index],
        primaryReviewId: item.id,
        occurredAt: item.createdAt,
        isDuplicateGroup: false,
        ambiguity: bucket === "needs_decision" ? item.ambiguity : undefined
      });
      continue;
    }

    const dedupeKey = dedupeKeyFor(item, timezone);
    if (!dedupeKey) {
      const { title, entity, secondary } = titleFor(item);
      singletons.push({
        key: item.id,
        bucket: "count_ready",
        title,
        entity,
        secondary,
        memberReviewIds: [item.id],
        memberIndexes: [item.index],
        primaryReviewId: item.id,
        occurredAt: item.createdAt,
        isDuplicateGroup: false
      });
      continue;
    }

    const existing = dedupeClusters.get(dedupeKey);
    if (existing) {
      existing.push(item);
    } else {
      dedupeClusters.set(dedupeKey, [item]);
    }
  }

  const dedupeGroups: EmailIntelligenceGroup[] = [...dedupeClusters.entries()].map(([key, members]) => {
    const sorted = [...members].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const primary = sorted[0]!;
    const { title, entity, secondary } = titleFor(primary);
    return {
      key,
      bucket: "count_ready",
      title,
      entity,
      secondary,
      memberReviewIds: sorted.map((member) => member.id),
      memberIndexes: sorted.map((member) => member.index),
      primaryReviewId: primary.id,
      occurredAt: primary.createdAt,
      isDuplicateGroup: sorted.length > 1
    };
  });

  let countReadyGroups = dedupeGroups;
  if (options.reconcile && countReadyGroups.length >= 2) {
    const candidatePairs: Array<{ pairId: string; groupA: EmailIntelligenceGroup; groupB: EmailIntelligenceGroup }> = [];
    for (let i = 0; i < countReadyGroups.length; i += 1) {
      for (let j = i + 1; j < countReadyGroups.length; j += 1) {
        const groupA = countReadyGroups[i]!;
        const groupB = countReadyGroups[j]!;
        if (isNearDuplicateCandidate(groupA, groupB)) {
          candidatePairs.push({ pairId: `${groupA.key}::${groupB.key}`, groupA, groupB });
        }
      }
    }

    if (candidatePairs.length > 0) {
      try {
        const outcomes = await options.reconcile(
          candidatePairs.map(({ pairId, groupA, groupB }) => ({ pairId, a: toReconciliationCandidateItem(groupA), b: toReconciliationCandidateItem(groupB) }))
        );
        countReadyGroups = applyReconciliationOutcomes(countReadyGroups, candidatePairs, outcomes);
      } catch {
        // Fails closed to the exact-key result only — never lets an advisory-pass failure change
        // anything about the authoritative deterministic grouping above.
      }
    }
  }

  return [...singletons, ...countReadyGroups].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}
