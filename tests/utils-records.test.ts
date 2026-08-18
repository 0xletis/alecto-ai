import assert from "node:assert/strict";
import test from "node:test";
import { isRecord } from "../apps/api/src/utils/records.ts";

test("isRecord: accepts plain objects, rejects arrays/null/primitives", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([1, 2, 3]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord("string"), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord(true), false);
});
