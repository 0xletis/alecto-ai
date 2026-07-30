import { z } from "zod";
import { GoalCheckInQuestionSchema, GoalMetricSchema, GoalPrioritySchema } from "./goals.js";

export const GoalTemplateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  defaultPriority: GoalPrioritySchema,
  description: z.string().min(1),
  relevantEventTypes: z.array(z.string().min(1)),
  suggestedMetrics: z.array(GoalMetricSchema),
  checkInQuestions: z.array(GoalCheckInQuestionSchema),
  riskPatterns: z.array(z.string()).optional()
});

export type GoalTemplate = z.infer<typeof GoalTemplateSchema>;

export const goalTemplates = [
  {
    id: "career.job_search",
    title: "Job Search",
    category: "career",
    defaultPriority: "critical",
    description: "Track applications, recruiter replies, interviews, and career materials.",
    relevantEventTypes: [
      "career.application_sent",
      "career.recruiter_reply_received",
      "career.interview_scheduled",
      "career.cv_updated",
      "career.portfolio_updated"
    ],
    suggestedMetrics: [
      {
        key: "applications_sent_weekly",
        label: "Applications sent",
        eventType: "career.application_sent",
        aggregation: "count",
        window: "weekly"
      },
      {
        key: "recruiter_replies_weekly",
        label: "Recruiter replies",
        eventType: "career.recruiter_reply_received",
        aggregation: "count",
        window: "weekly"
      }
    ],
    checkInQuestions: [
      {
        key: "applied_today",
        question: "Did you apply to any jobs today?",
        answerType: "yes_no"
      },
      {
        key: "job_search_avoidance",
        question: "Did you avoid any job-search action today?",
        answerType: "yes_no"
      }
    ],
    riskPatterns: ["avoidance", "low evidence optimism"]
  },
  {
    id: "work.deep_work",
    title: "Deep Work",
    category: "work",
    defaultPriority: "high",
    description: "Track focused work sessions, tasks, blockers, and milestones.",
    relevantEventTypes: ["work.deep_work_session_completed", "work.task_completed", "work.blocker_reported"],
    suggestedMetrics: [
      {
        key: "deep_work_sessions_weekly",
        label: "Deep work sessions",
        eventType: "work.deep_work_session_completed",
        aggregation: "count",
        window: "weekly"
      }
    ],
    checkInQuestions: [
      {
        key: "deep_work_done",
        question: "Did you complete a focused work block today?",
        answerType: "yes_no"
      }
    ]
  },
  {
    id: "health.strength_energy",
    title: "Strength and Energy",
    category: "health",
    defaultPriority: "high",
    description: "Track training, steps, energy, meals, and recovery.",
    relevantEventTypes: [
      "health.workout_completed",
      "health.steps_logged",
      "health.meal_logged",
      "health.energy_logged",
      "health.rest_day_logged"
    ],
    suggestedMetrics: [
      {
        key: "training_minutes_weekly",
        label: "Training minutes",
        eventType: "health.workout_completed",
        aggregation: "sum",
        window: "weekly"
      },
      {
        key: "energy_daily",
        label: "Energy",
        eventType: "reflection.energy_logged",
        aggregation: "latest",
        window: "daily"
      }
    ],
    checkInQuestions: [
      {
        key: "energy",
        question: "How was your energy today?",
        answerType: "scale_1_10"
      },
      {
        key: "trained_today",
        question: "Did you train or move today?",
        answerType: "yes_no"
      }
    ]
  },
  {
    id: "health.sleep_better",
    title: "Sleep Better",
    category: "health",
    defaultPriority: "high",
    description: "Track sleep duration, energy, and recovery patterns.",
    relevantEventTypes: ["health.sleep_logged", "reflection.energy_logged", "health.rest_day_logged"],
    suggestedMetrics: [
      {
        key: "sleep_hours_daily",
        label: "Sleep hours",
        eventType: "health.sleep_logged",
        aggregation: "latest",
        window: "daily"
      }
    ],
    checkInQuestions: [
      {
        key: "sleep_quality",
        question: "How good was your sleep?",
        answerType: "scale_1_10"
      }
    ]
  },
  {
    id: "learning.reading_more",
    title: "Read More",
    category: "learning",
    defaultPriority: "low",
    description: "Track reading sessions, notes, and finished books.",
    relevantEventTypes: [
      "learning.reading_session_completed",
      "learning.note_created",
      "learning.book_started",
      "learning.book_finished"
    ],
    suggestedMetrics: [
      {
        key: "reading_minutes_weekly",
        label: "Reading minutes",
        eventType: "learning.reading_session_completed",
        aggregation: "sum",
        window: "weekly"
      }
    ],
    checkInQuestions: [
      {
        key: "read_today",
        question: "Did you read today?",
        answerType: "yes_no"
      }
    ]
  },
  {
    id: "learning.skill_learning",
    title: "Skill Learning",
    category: "learning",
    defaultPriority: "medium",
    description: "Track practice, course progress, notes, and mastered concepts.",
    relevantEventTypes: [
      "learning.practice_session_completed",
      "learning.course_progressed",
      "learning.note_created",
      "learning.concept_mastered"
    ],
    suggestedMetrics: [
      {
        key: "practice_sessions_weekly",
        label: "Practice sessions",
        eventType: "learning.practice_session_completed",
        aggregation: "count",
        window: "weekly"
      }
    ],
    checkInQuestions: [
      {
        key: "practice_done",
        question: "Did you practice the skill today?",
        answerType: "yes_no"
      }
    ]
  },
  {
    id: "finance.control_betting_trading",
    title: "Control Betting and Trading",
    category: "finance",
    defaultPriority: "critical",
    description: "Track betting/trading impulses, cooldowns, theses, losses, and risk patterns.",
    relevantEventTypes: [
      "finance.betting.cooldown_triggered",
      "finance.betting.revenge_pattern_detected",
      "finance.betting.large_bet_detected",
      "finance.trading.large_loss_detected",
      "reflection.impulse_logged"
    ],
    suggestedMetrics: [
      {
        key: "impulse_daily",
        label: "Financial impulse",
        eventType: "reflection.impulse_logged",
        aggregation: "latest",
        window: "daily"
      },
      {
        key: "cooldowns_weekly",
        label: "Cooldowns triggered",
        eventType: "finance.betting.cooldown_triggered",
        aggregation: "count",
        window: "weekly"
      }
    ],
    checkInQuestions: [
      {
        key: "gambling_impulse",
        question: "How strong was the gambling or trading impulse today?",
        answerType: "scale_1_10"
      }
    ],
    riskPatterns: ["certainty language", "revenge betting", "oversizing", "justifying impulsive trades"]
  },
  {
    id: "creative.build_project",
    title: "Build Project",
    category: "creative",
    defaultPriority: "medium",
    description: "Track creative or startup project momentum.",
    relevantEventTypes: ["work.deep_work_session_completed", "work.task_completed", "work.project_milestone_completed"],
    suggestedMetrics: [
      {
        key: "project_tasks_weekly",
        label: "Project tasks completed",
        eventType: "work.task_completed",
        aggregation: "count",
        window: "weekly"
      }
    ],
    checkInQuestions: [
      {
        key: "project_step_done",
        question: "Did you move the project forward today?",
        answerType: "yes_no"
      }
    ]
  },
  {
    id: "social.social_connection",
    title: "Social Connection",
    category: "social",
    defaultPriority: "medium",
    description: "Track meaningful conversations, friend/family contact, and loneliness signals.",
    relevantEventTypes: [
      "social.meaningful_conversation_logged",
      "social.friend_meetup_logged",
      "social.family_contact_logged",
      "social.loneliness_logged",
      "social.support_received"
    ],
    suggestedMetrics: [
      {
        key: "meaningful_connections_weekly",
        label: "Meaningful connections",
        eventType: "social.meaningful_conversation_logged",
        aggregation: "count",
        window: "weekly"
      }
    ],
    checkInQuestions: [
      {
        key: "connection_today",
        question: "Did you have meaningful contact with someone today?",
        answerType: "yes_no"
      }
    ]
  }
] satisfies GoalTemplate[];

export function getGoalTemplate(templateId: string): GoalTemplate | undefined {
  return goalTemplates.find((template) => template.id === templateId);
}
