import assert from "node:assert/strict";
import test from "node:test";
import { resetAllUserLocks, runExclusive } from "../apps/api/src/agent-runtime/user-lock.ts";

test("runExclusive serializes calls for the same key in order, even when fired without awaiting", async () => {
  resetAllUserLocks();
  const events: string[] = [];

  const callA = runExclusive("user-1", async () => {
    events.push("A:start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    events.push("A:end");
    return "A";
  });

  // Fired immediately, without awaiting callA — this is what proves real queuing
  // rather than just the test's own await ordering.
  const callB = runExclusive("user-1", async () => {
    events.push("B:start");
    return "B";
  });

  const [resultA, resultB] = await Promise.all([callA, callB]);

  assert.deepEqual(events, ["A:start", "A:end", "B:start"], "B must not start until A has fully settled");
  assert.equal(resultA, "A");
  assert.equal(resultB, "B");
});

test("runExclusive lets different keys run fully concurrently", async () => {
  resetAllUserLocks();
  const events: string[] = [];

  const callA = runExclusive("user-a", async () => {
    events.push("A:start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    events.push("A:end");
  });

  const callB = runExclusive("user-b", async () => {
    events.push("B:start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push("B:end");
  });

  await Promise.all([callA, callB]);

  // B has the shorter delay and finishes before A — only possible if they ran concurrently,
  // not queued behind each other the way same-key calls are.
  assert.deepEqual(events, ["A:start", "B:start", "B:end", "A:end"]);
});

test("runExclusive: a rejected call does not block later calls for the same key", async () => {
  resetAllUserLocks();

  const callA = runExclusive("user-2", async () => {
    throw new Error("boom");
  });

  await assert.rejects(callA, /boom/);

  const callB = runExclusive("user-2", async () => "still works");
  assert.equal(await callB, "still works");
});
