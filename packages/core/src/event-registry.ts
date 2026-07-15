import { z } from "zod";

export const eventDomains = [
  "career",
  "work",
  "coding",
  "health",
  "finance.wallet",
  "finance.trading",
  "finance.betting",
  "learning",
  "reflection",
  "social",
  "system",
  "custom"
] as const;

export const eventRegistry = [
  { type: "career.application_sent", domain: "career" },
  { type: "career.application_confirmation_received", domain: "career" },
  { type: "career.recruiter_reply_received", domain: "career" },
  { type: "career.interview_scheduled", domain: "career" },
  { type: "career.interview_completed", domain: "career" },
  { type: "career.rejection_received", domain: "career" },
  { type: "career.offer_received", domain: "career" },
  { type: "career.cv_updated", domain: "career" },
  { type: "career.portfolio_updated", domain: "career" },
  { type: "career.networking_message_sent", domain: "career" },

  { type: "work.deep_work_session_completed", domain: "work" },
  { type: "work.task_completed", domain: "work" },
  { type: "work.feedback_received", domain: "work" },
  { type: "work.blocker_reported", domain: "work" },
  { type: "work.project_milestone_completed", domain: "work" },

  { type: "coding.commit_created", domain: "coding" },
  { type: "coding.pull_request_opened", domain: "coding" },
  { type: "coding.pull_request_merged", domain: "coding" },
  { type: "coding.issue_closed", domain: "coding" },
  { type: "coding.repo_activity_detected", domain: "coding" },

  { type: "health.workout_completed", domain: "health" },
  { type: "health.steps_logged", domain: "health" },
  { type: "health.sleep_logged", domain: "health" },
  { type: "health.meal_logged", domain: "health" },
  { type: "health.weight_logged", domain: "health" },
  { type: "health.energy_logged", domain: "health" },
  { type: "health.injury_reported", domain: "health" },
  { type: "health.rest_day_logged", domain: "health" },

  { type: "finance.wallet.balance_changed", domain: "finance.wallet" },
  { type: "finance.wallet.transfer_received", domain: "finance.wallet" },
  { type: "finance.wallet.transfer_sent", domain: "finance.wallet" },
  { type: "finance.wallet.large_transfer_detected", domain: "finance.wallet" },
  { type: "finance.wallet.net_worth_snapshot_created", domain: "finance.wallet" },

  { type: "finance.trading.position_opened", domain: "finance.trading" },
  { type: "finance.trading.position_closed", domain: "finance.trading" },
  { type: "finance.trading.pnl_realized", domain: "finance.trading" },
  { type: "finance.trading.large_loss_detected", domain: "finance.trading" },
  { type: "finance.trading.thesis_logged", domain: "finance.trading" },

  { type: "finance.betting.bet_opened", domain: "finance.betting" },
  { type: "finance.betting.bet_closed", domain: "finance.betting" },
  { type: "finance.betting.pnl_realized", domain: "finance.betting" },
  { type: "finance.betting.large_bet_detected", domain: "finance.betting" },
  { type: "finance.betting.bet_thesis_logged", domain: "finance.betting" },
  { type: "finance.betting.cooldown_triggered", domain: "finance.betting" },
  { type: "finance.betting.revenge_pattern_detected", domain: "finance.betting" },

  { type: "learning.reading_session_completed", domain: "learning" },
  { type: "learning.note_created", domain: "learning" },
  { type: "learning.book_started", domain: "learning" },
  { type: "learning.book_finished", domain: "learning" },
  { type: "learning.course_progressed", domain: "learning" },
  { type: "learning.practice_session_completed", domain: "learning" },
  { type: "learning.concept_mastered", domain: "learning" },

  { type: "reflection.daily_checkin_completed", domain: "reflection" },
  { type: "reflection.journal_entry_created", domain: "reflection" },
  { type: "reflection.mood_logged", domain: "reflection" },
  { type: "reflection.energy_logged", domain: "reflection" },
  { type: "reflection.anxiety_logged", domain: "reflection" },
  { type: "reflection.focus_logged", domain: "reflection" },
  { type: "reflection.impulse_logged", domain: "reflection" },
  { type: "reflection.goal_changed", domain: "reflection" },
  { type: "reflection.decision_logged", domain: "reflection" },
  { type: "reflection.regret_logged", domain: "reflection" },
  { type: "reflection.win_logged", domain: "reflection" },

  { type: "social.meaningful_conversation_logged", domain: "social" },
  { type: "social.friend_meetup_logged", domain: "social" },
  { type: "social.family_contact_logged", domain: "social" },
  { type: "social.loneliness_logged", domain: "social" },
  { type: "social.conflict_logged", domain: "social" },
  { type: "social.support_received", domain: "social" },

  { type: "system.integration_connected", domain: "system" },
  { type: "system.integration_failed", domain: "system" },
  { type: "system.goal_created", domain: "system" },
  { type: "system.goal_archived", domain: "system" },
  { type: "system.metric_changed", domain: "system" },
  { type: "system.review_generated", domain: "system" },
  { type: "system.alert_sent", domain: "system" },
  { type: "system.user_confirmed_change", domain: "system" },
  { type: "system.user_rejected_change", domain: "system" },

  { type: "custom.goal_progress_logged", domain: "custom" }
] as const;

export const EventDomainSchema = z.enum(eventDomains);
export const EventTypeSchema = z.enum(eventRegistry.map((event) => event.type) as [EventTypeId, ...EventTypeId[]]);
export const EventTypeDefinitionSchema = z.object({
  type: EventTypeSchema,
  domain: EventDomainSchema
});

export type EventDomain = (typeof eventDomains)[number];
export type EventTypeId = (typeof eventRegistry)[number]["type"];
export type EventTypeDefinition = z.infer<typeof EventTypeDefinitionSchema>;
