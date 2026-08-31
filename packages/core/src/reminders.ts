import type { Goal } from "./goals.js";
import type { StoredEvent } from "./events.js";
import { progressExampleCategoryForGoal, type ProgressExampleCategory } from "./progress-examples.js";
import type { UserOperatingProfile } from "./user-operating-profile.js";

export interface BuildDailyCheckinPromptInput {
  activeGoals: Goal[];
  userOperatingProfile?: UserOperatingProfile;
  recentEvents?: StoredEvent[];
}

export function buildDailyCheckinPrompt(input: BuildDailyCheckinPromptInput): string {
  const sections = new Set<string>();
  const customSections: string[] = [];
  const exampleCategories = new Set<ProgressExampleCategory>();

  for (const goal of input.activeGoals) {
    const category = progressExampleCategoryForGoal(goal);
    if (category) {
      exampleCategories.add(category);
    }

    if (!goal.templateId && goal.checkInConfig?.[0]) {
      customSections.push(`${goal.title}: ${goal.checkInConfig[0].question}`);
      continue;
    }

    for (const section of sectionsForGoal(goal)) {
      sections.add(section);
    }
  }

  const goalLines = [...sections, ...customSections.slice(0, 2)].map((section) => `- ${section}`);

  if (goalLines.length === 0) {
    goalLines.push("- Custom goals: did you make any concrete progress?");
  }

  const opener = isDirectProfile(input.userOperatingProfile)
    ? "Daily check-in. Give me the real state, not the polished version."
    : "Quick daily check-in.";

  return [
    opener,
    "",
    "Core:",
    "- sleep, energy, anxiety, focus",
    "",
    "Today's goals:",
    ...goalLines,
    "",
    "Reply naturally, for example:",
    exampleForSections(sections, exampleCategories),
    "",
    "Or use structured format:",
    "/checkin energy=6 anxiety=4 focus=7 gambling=2 applications=2 workout=45 reading=30 sleep=7 notes=Felt okay today"
  ].join("\n");
}

export const dailyCheckinReminderText = buildDailyCheckinPrompt({
  activeGoals: []
});

function sectionsForGoal(goal: Goal): string[] {
  const templateId = goal.templateId ?? "";
  const category = goal.category.toLowerCase();
  const sections: string[] = [];

  if (templateId === "career.job_search" || category.includes("career")) {
    sections.push("Job search: applications, replies, interviews, CV/portfolio?");
  }

  if (templateId === "health.strength_energy") {
    sections.push("Health: workout minutes, steps, energy?");
  }

  if (templateId === "health.sleep_better") {
    sections.push("Sleep: sleep hours and sleep quality?");
  }

  if (templateId === "learning.reading_more") {
    sections.push("Reading: reading minutes and notes?");
  }

  if (templateId === "learning.skill_learning") {
    sections.push("Learning: study/practice minutes and topic?");
  }

  if (templateId === "finance.control_betting_trading" || category.includes("finance")) {
    sections.push("Risk: gambling/trading impulse, bets/trades, thesis before risk?");
  }

  if (templateId === "creative.build_project") {
    sections.push("Build: deep work/building minutes, commits/tasks/milestones?");
  }

  if (templateId === "social.social_connection") {
    sections.push("Social: meaningful conversations/social contact?");
  }

  if (sections.length === 0) {
    sections.push("Custom goals: did you make any concrete progress?");
  }

  return sections;
}

function isDirectProfile(profile?: UserOperatingProfile): boolean {
  return Boolean(profile && (profile.directness >= 5 || profile.motivationalStyle === "tough_love"));
}

/**
 * fix/private-alpha-gmail-account-switch-and-personalized-examples (Part B): a real reported gap —
 * this used to show "sent 2 CVs"/"trained 40 min" for EVERY user with a matching section, even one
 * with only a finance/travel/meaning goal and nothing to do with a gym or a job search. Examples
 * now come from progress-examples.ts's deterministic goal-category classification (exampleCategories,
 * computed once per active goal in buildDailyCheckinPrompt) instead of being hardcoded here, so a
 * goal category only ever contributes an example that's actually plausible for it.
 */
function exampleForSections(sections: Set<string>, exampleCategories: Set<ProgressExampleCategory>): string {
  const examples = ["slept 6h", "energy 5", "anxiety 7"];

  if (exampleCategories.has("job_search")) {
    examples.push("sent 2 CVs");
  }

  if (exampleCategories.has("fitness")) {
    examples.push("45 min gym");
  }

  if (hasSection(sections, "Reading")) {
    examples.push("read 20 min");
  }

  if (hasSection(sections, "Risk")) {
    examples.push("gambling impulse 2");
  }

  if (exampleCategories.has("life_meaning")) {
    examples.push("journaled 10 minutes");
  }

  if (exampleCategories.has("finance_admin")) {
    examples.push("paid one bill");
  }

  if (exampleCategories.has("travel")) {
    examples.push("checked flight update");
  }

  if (examples.length === 3) {
    examples.push("made progress on my main goal");
  }

  return examples.join(", ");
}

function hasSection(sections: Set<string>, prefix: string): boolean {
  return [...sections].some((section) => section.startsWith(`${prefix}:`));
}
