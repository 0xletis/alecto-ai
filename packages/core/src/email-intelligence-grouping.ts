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
   * value; unrecognized values fall into "needs_decision", never silently treated as noise. */
  reason: string;
  proposedEventType?: string;
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

function bucketForReason(reason: string): EmailIntelligenceBucket {
  return KIND_TO_BUCKET[reason] ?? "needs_decision";
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
 * The Stage D entry point. Only "count_ready" items are ever deduplicated into a multi-member
 * group — every other bucket keeps items as individual singleton groups, since collapsing a
 * recruiter reply or an admin notice into a "duplicate" would hide something the user needs to see
 * individually. Sorted within each bucket by occurredAt (oldest first) so numbering stays stable
 * and predictable for the caller's own presentation layer.
 */
export function groupEmailIntelligenceItems(items: EmailIntelligenceSourceItem[], timezone: string): EmailIntelligenceGroup[] {
  const singletons: EmailIntelligenceGroup[] = [];
  const dedupeClusters = new Map<string, EmailIntelligenceSourceItem[]>();

  for (const item of items) {
    const bucket = bucketForReason(item.reason);
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
        isDuplicateGroup: false
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

  return [...singletons, ...dedupeGroups].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}
