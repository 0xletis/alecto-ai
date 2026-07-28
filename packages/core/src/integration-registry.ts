import { z } from "zod";
import { EventTypeSchema } from "./event-registry.js";

export const IntegrationDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(["available", "planned"]),
  authType: z.enum(["none", "api_key", "oauth", "manual"]),
  producesEventTypes: z.array(EventTypeSchema)
});

export const GithubPublicConnectionInputSchema = z.object({
  repos: z
    .array(
      z.object({
        owner: z.string().min(1),
        repo: z.string().min(1)
      })
    )
    .min(1),
  authorLogin: z.string().min(1).optional(),
  includeRepoActivity: z.boolean().optional()
});

export const EmailFetchStrategySchema = z.enum(["query", "all_recent", "sender_allowlist", "label"]);
export const EmailClassifierModeSchema = z.enum(["rules", "llm", "hybrid"]);

export const CreateEmailSignalRuleInputSchema = z.object({
  connectionId: z.string().min(1),
  goalId: z.string().min(1).optional(),
  adapterId: z.string().min(1),
  name: z.string().min(1),
  query: z.string().min(1).nullable().optional(),
  fetchStrategy: EmailFetchStrategySchema.default("query"),
  lookbackDays: z.number().int().positive().default(30),
  maxMessagesPerSync: z.number().int().positive().default(25),
  maxEventsPerSync: z.number().int().positive().default(10),
  classifierMode: EmailClassifierModeSchema.default("rules"),
  minAutoLogConfidence: z.number().min(0).max(1).default(0.9),
  minReviewConfidence: z.number().min(0).max(1).default(0.65),
  reviewBeforeLogging: z.boolean().default(false)
});

export const UpdateEmailSignalRuleInputSchema = z.object({
  status: z.enum(["active", "paused"]).optional(),
  fetchStrategy: EmailFetchStrategySchema.optional(),
  query: z.string().min(1).nullable().optional(),
  lookbackDays: z.number().int().positive().optional(),
  maxMessagesPerSync: z.number().int().positive().optional(),
  maxEventsPerSync: z.number().int().positive().optional(),
  classifierMode: EmailClassifierModeSchema.optional(),
  minAutoLogConfidence: z.number().min(0).max(1).optional(),
  minReviewConfidence: z.number().min(0).max(1).optional(),
  reviewBeforeLogging: z.boolean().optional()
});

export const UpdateIntegrationConnectionInputSchema = z.object({
  status: z.enum(["active", "paused"])
});

export type IntegrationDefinition = z.infer<typeof IntegrationDefinitionSchema>;
export type GithubPublicConnectionInput = z.infer<typeof GithubPublicConnectionInputSchema>;
export type EmailFetchStrategy = z.infer<typeof EmailFetchStrategySchema>;
export type EmailClassifierMode = z.infer<typeof EmailClassifierModeSchema>;
export type CreateEmailSignalRuleInput = z.infer<typeof CreateEmailSignalRuleInputSchema>;
export type UpdateEmailSignalRuleInput = z.infer<typeof UpdateEmailSignalRuleInputSchema>;
export type UpdateIntegrationConnectionInput = z.infer<typeof UpdateIntegrationConnectionInputSchema>;

export interface EmailAdapterDefinition {
  id: string;
  domain: string;
  description: string;
  status: "available" | "planned";
  defaultQuery?: string;
  targetAdapterId?: string;
}

export const emailAdapterRegistry: EmailAdapterDefinition[] = [
  {
    id: "job_search_email",
    domain: "career",
    description: "Detects recruiter replies, interviews, application confirmations, rejections, and offers.",
    status: "available",
    defaultQuery:
      'newer_than:30d interview OR "schedule an interview" OR "thanks for applying" OR recruiter OR "talent acquisition" OR unfortunately OR "job offer" OR "offer letter" OR "offer of employment" OR "employment agreement" OR application OR applying OR "security code" OR "verification code" OR "resubmit your application"',
    targetAdapterId: "job_search_text"
  },
  {
    id: "work_action_email",
    domain: "work",
    description: "Planned adapter for work/client action emails.",
    status: "planned"
  },
  {
    id: "finance_receipt_email",
    domain: "finance",
    description: "Planned adapter for finance and receipt emails.",
    status: "planned"
  },
  {
    id: "learning_deadline_email",
    domain: "learning",
    description: "Planned adapter for course and learning deadline emails.",
    status: "planned"
  },
  {
    id: "custom_goal_email",
    domain: "custom",
    description: "Planned adapter for custom goal email signals.",
    status: "planned"
  }
];

export function getEmailAdapterDefinition(adapterId: string): EmailAdapterDefinition | undefined {
  return emailAdapterRegistry.find((adapter) => adapter.id === adapterId);
}

export const integrationRegistry: IntegrationDefinition[] = [
  {
    id: "github_public",
    name: "GitHub Public Repo",
    description: "Fetches recent public commits from configured GitHub repositories.",
    status: "available",
    authType: "none",
    producesEventTypes: ["coding.commit_created", "coding.repo_activity_detected"]
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Generic Gmail email source for user-approved email signal rules.",
    status: "available",
    authType: "oauth",
    producesEventTypes: [
      "career.application_confirmation_received",
      "career.recruiter_reply_received",
      "career.interview_scheduled",
      "career.rejection_received",
      "career.offer_received"
    ]
  },
  {
    id: "wallet_public",
    name: "Wallet Public Address",
    description: "Planned manual public-address wallet signal integration.",
    status: "planned",
    authType: "manual",
    producesEventTypes: [
      "finance.wallet.balance_changed",
      "finance.wallet.transfer_received",
      "finance.wallet.transfer_sent",
      "finance.wallet.large_transfer_detected"
    ]
  }
];
