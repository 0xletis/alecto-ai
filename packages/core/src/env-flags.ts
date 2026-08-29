/**
 * fix/private-alpha-launch-config-sanity: shared, dependency-free "production-defaulted feature
 * flag" resolution — the exact ambiguity that caused real incidents this alpha (a tester's morning
 * brief never sent because PROACTIVE_OPERATOR_DELIVERY_ENABLED was unset on the worker's Railway
 * service; personalized briefs silently stayed deterministic-only for the same reason). An explicit
 * "true"/"false" ALWAYS wins, on every environment — this never overrides an operator's deliberate
 * choice. Only when the var is genuinely UNSET does environment matter: in production, core
 * private-alpha behavior defaults ON rather than silently disappearing because one Railway service
 * forgot a flag; everywhere else (local dev, tests, CI) the flag keeps defaulting OFF exactly as it
 * always has, so "Do not break local development" and "Do not send proactive messages in test/local
 * unintentionally" both hold without any test or .env changes — NODE_ENV is never set to
 * "production" in any dev/test invocation in this repo.
 */

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * `envValue` is the raw value of the flag's own env var (e.g. `process.env.
 * PROACTIVE_OPERATOR_DELIVERY_ENABLED`). `productionDefault` is what an UNSET flag should resolve
 * to specifically when `NODE_ENV=production` — outside production, unset always resolves to
 * `false`, matching this codebase's pre-existing behavior everywhere these flags were already
 * checked as `=== "true"`.
 */
export function resolveProductionDefaultedFlag(envValue: string | undefined, productionDefault: boolean): boolean {
  if (envValue === "true") {
    return true;
  }
  if (envValue === "false") {
    return false;
  }
  return isProductionEnv() && productionDefault;
}
