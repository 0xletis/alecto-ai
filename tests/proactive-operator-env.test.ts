import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProactiveAllowlistId,
  proactiveOperatorAllowlistActiveFromEnv,
  proactiveOperatorAllowlistFromEnv,
  proactiveOperatorDeliveryEnabledFromEnv
} from "../packages/core/src/proactive-operator-env.ts";

/**
 * Pure unit tests for the two proactive-delivery rollout controls
 * (packages/core/src/proactive-operator-env.ts) — no server, no DB. Product decision
 * (docs/10-v3-readiness-audit.md §19): for the current solo/dev phase with no real users yet,
 * PROACTIVE_OPERATOR_DELIVERY_ENABLED stays the required global kill switch, per-user opt-in
 * stays required product consent, and PROACTIVE_OPERATOR_ALLOWLIST becomes an OPTIONAL rollout
 * limiter — unset/empty must never block delivery, and both a bare Telegram numeric id and the
 * full "telegram:<id>" form must be accepted so a developer doesn't have to know the internal
 * userId format just to configure this.
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

test("normalizeProactiveAllowlistId prefixes a bare numeric id with telegram:", () => {
  assert.equal(normalizeProactiveAllowlistId("520894688"), "telegram:520894688");
});

test("normalizeProactiveAllowlistId leaves an already-prefixed id unchanged", () => {
  assert.equal(normalizeProactiveAllowlistId("telegram:520894688"), "telegram:520894688");
});

test("normalizeProactiveAllowlistId trims whitespace before normalizing", () => {
  assert.equal(normalizeProactiveAllowlistId("  520894688  "), "telegram:520894688");
});

test("normalizeProactiveAllowlistId passes through a non-numeric, non-telegram id unchanged", () => {
  assert.equal(normalizeProactiveAllowlistId("web:some-uuid"), "web:some-uuid");
});

test("proactiveOperatorDeliveryEnabledFromEnv is true only for the literal string \"true\"", () => {
  withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true" }, () => {
    assert.equal(proactiveOperatorDeliveryEnabledFromEnv(), true);
  });
  withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "1" }, () => {
    assert.equal(proactiveOperatorDeliveryEnabledFromEnv(), false);
  });
  withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: undefined }, () => {
    assert.equal(proactiveOperatorDeliveryEnabledFromEnv(), false);
  });
});

test("proactiveOperatorAllowlistActiveFromEnv is false when unset, empty, or whitespace-only", () => {
  withEnv({ PROACTIVE_OPERATOR_ALLOWLIST: undefined }, () => {
    assert.equal(proactiveOperatorAllowlistActiveFromEnv(), false);
  });
  withEnv({ PROACTIVE_OPERATOR_ALLOWLIST: "" }, () => {
    assert.equal(proactiveOperatorAllowlistActiveFromEnv(), false);
  });
  withEnv({ PROACTIVE_OPERATOR_ALLOWLIST: "   " }, () => {
    assert.equal(proactiveOperatorAllowlistActiveFromEnv(), false);
  });
  withEnv({ PROACTIVE_OPERATOR_ALLOWLIST: "telegram:520894688" }, () => {
    assert.equal(proactiveOperatorAllowlistActiveFromEnv(), true);
  });
});

test("proactiveOperatorAllowlistFromEnv allows everyone when unset/empty — optional, not a required blocker", () => {
  withEnv({ PROACTIVE_OPERATOR_ALLOWLIST: undefined }, () => {
    const isAllowed = proactiveOperatorAllowlistFromEnv();
    assert.equal(isAllowed("telegram:1"), true);
    assert.equal(isAllowed("anyone"), true);
  });
});

test("proactiveOperatorAllowlistFromEnv matches the full telegram:<id> form", () => {
  withEnv({ PROACTIVE_OPERATOR_ALLOWLIST: "telegram:520894688" }, () => {
    const isAllowed = proactiveOperatorAllowlistFromEnv();
    assert.equal(isAllowed("telegram:520894688"), true);
    assert.equal(isAllowed("telegram:999999999"), false);
  });
});

test("proactiveOperatorAllowlistFromEnv matches a bare numeric id normalized to telegram:<id>", () => {
  withEnv({ PROACTIVE_OPERATOR_ALLOWLIST: "520894688" }, () => {
    const isAllowed = proactiveOperatorAllowlistFromEnv();
    assert.equal(isAllowed("telegram:520894688"), true, "a bare numeric id must be normalized and match the full userId form");
  });
});

test("proactiveOperatorAllowlistFromEnv supports comma-separated values with mixed formats and whitespace", () => {
  withEnv({ PROACTIVE_OPERATOR_ALLOWLIST: " 520894688 , telegram:111111111,  222222222 " }, () => {
    const isAllowed = proactiveOperatorAllowlistFromEnv();
    assert.equal(isAllowed("telegram:520894688"), true);
    assert.equal(isAllowed("telegram:111111111"), true);
    assert.equal(isAllowed("telegram:222222222"), true);
    assert.equal(isAllowed("telegram:333333333"), false);
  });
});
