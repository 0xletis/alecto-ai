/**
 * Per-user mutex for Agent Runtime v3. Session state (apps/api/src/agent-runtime/
 * conversation-session.ts) is a plain in-memory Map with no concurrency control of
 * its own — two /agent/message calls for the SAME userId arriving close together
 * (real Telegram can deliver messages in quick succession, and curl/API callers
 * can race too) would otherwise interleave: both could read the same
 * pendingOperation before either clears it, both could execute a mutation the
 * user only confirmed once, etc.
 *
 * runExclusive serializes all calls for a given userId into a strict queue —
 * message 2 only starts once message 1 has fully settled (success OR failure) —
 * while different userIds remain fully concurrent with each other.
 */
const userQueueTails = new Map<string, Promise<void>>();

export function runExclusive<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previousTail = userQueueTails.get(userId) ?? Promise.resolve();
  const result = previousTail.then(fn, fn);

  // The queue tail must always resolve (never reject), or every later message for
  // this user would be permanently stuck behind one failed call.
  const nextTail = result.then(
    () => undefined,
    () => undefined
  );
  userQueueTails.set(userId, nextTail);

  return result;
}

/** Test-only: clears all queue state between test runs. */
export function resetAllUserLocks(): void {
  userQueueTails.clear();
}
