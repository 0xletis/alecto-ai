import { addDaysToLocalDate, formatLocalDate } from "./time.js";

/**
 * fix/private-alpha-proactive-checkins-and-overdue-action-ux: shared, timezone-aware due-date
 * label and open-action command-footer copy — used by BOTH apps/api's agent-runtime executor
 * (action.list, action.create, action.reschedule, ...) and apps/worker's overdue action reminder
 * delivery (action-reminders.ts). Those are two separate deployable packages that only share
 * @operator-agent/core/db — a real reported bug found the worker's own bundled overdue-reminder
 * message still using an OLD, separately-hardcoded "Reply: complete 1, snooze 2 tomorrow, or
 * archive 3." footer that always referenced indexes 1/2/3 regardless of how many actions were
 * actually shown, and a robotic "(due: DD/MM/YYYY, HH:mm)" due label — apps/api's own
 * action.list had already fixed the exact same footer bug (see buildOpenActionCommandFooter's own
 * doc comment below) in a prior task, but nothing kept the worker's copy in sync since it lived as
 * a second, independent implementation. Centralizing both pieces of copy here is the fix AND the
 * guard against this drifting apart again.
 */

/** "due today 14:30" / "due tomorrow 09:00" / a full date+time fallback further out — generic
 * relative-day phrasing, not specific to any one caller, so any due-date-bearing list (actions,
 * overdue queries) can read naturally instead of showing a raw timestamp. `now` defaults to the
 * real current time but is parameterizable for deterministic tests. */
export function formatDueLabelForChat(dueAt: Date, timezone: string, now: Date = new Date()): string {
  const todayLocal = formatLocalDate(now, timezone);
  const dueLocal = formatLocalDate(dueAt, timezone);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(dueAt);

  if (dueLocal === todayLocal) {
    return `due today ${time}`;
  }
  if (dueLocal === addDaysToLocalDate(todayLocal, 1)) {
    return `due tomorrow ${time}`;
  }
  return `due ${formatFullLocalDateTime(dueAt, timezone)}`;
}

/** "overdue since today 01:26" / "overdue since 20/08/2026, 09:00" — same relative-day shape as
 * formatDueLabelForChat, for an item whose due (or deferred-return) moment has already passed. */
export function formatOverdueSinceLabelForChat(dueAt: Date, timezone: string, now: Date = new Date()): string {
  return formatDueLabelForChat(dueAt, timezone, now).replace(/^due /, "overdue since ");
}

export function formatFullLocalDateTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

/**
 * Never references a numbered index that isn't actually open/shown — the whole reason this
 * exists. One open action gets purely natural phrasing (no number to get wrong); two or more use
 * the REAL indexes passed in, never a hardcoded 1/2/3 regardless of how many actions actually
 * exist. Says "move"/"bring back," never "snooze," in this user-facing copy — "snooze" reads as a
 * phone-alarm command, not something a coach says; it's still accepted as an input word
 * (tool-catalog.ts's action.snooze description), just never the word Alecto itself uses back to
 * the user.
 */
export function buildOpenActionCommandFooter(openIndexes: number[]): string | undefined {
  if (openIndexes.length === 0) {
    return undefined;
  }
  if (openIndexes.length === 1) {
    return "You can say: \"done\", \"move it to tomorrow\", or \"archive it\".";
  }
  if (openIndexes.length === 2) {
    const [first, second] = openIndexes;
    return `You can say: "complete ${first}", "move ${second} to tomorrow", or "archive ${first}".`;
  }
  const [first, second, third] = openIndexes;
  return `You can say: "complete ${first}", "move ${second} to tomorrow", or "archive ${third}".`;
}
