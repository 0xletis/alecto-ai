import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * fix/private-alpha-local-date-focus-and-gmail-confirmation-state (follow-up): a real, repeatedly-
 * hit footgun this session — packages/core/db/llm each resolve their "import" export condition to
 * their own dist/index.js, never live src/, so apps/api (and every test that calls buildServer())
 * silently runs whatever was LAST COMPILED, even after a source edit. pnpm typecheck stays clean
 * the whole time (it reads the "types" condition, which DOES point at src/), so a real, verified
 * source fix can look complete and still not actually run — exactly what happened mid-task on the
 * previous branch, caught only by chance during a manual end-to-end probe.
 *
 * This is deliberately a RUNTIME check, not a docs note or a package.json convention change:
 * called once at server.ts's own module load (both the real production entrypoint, apps/api/src/
 * index.ts, and every test's buildServer() import it), so it's structurally impossible to bypass
 * by running tsx directly instead of the "pnpm test" script — the exact way this was missed
 * before. Fails loudly and immediately rather than letting stale behavior silently pass.
 */

const WORKSPACE_ROOT_MARKER = "pnpm-workspace.yaml";
const CHECKED_PACKAGES = ["core", "db", "llm"];

function findWorkspaceRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, WORKSPACE_ROOT_MARKER))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

function latestMtimeMs(dir: string): number {
  if (!existsSync(dir)) {
    return -1;
  }
  let latest = -1;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, latestMtimeMs(full));
    } else if (entry.isFile()) {
      latest = Math.max(latest, statSync(full).mtimeMs);
    }
  }
  return latest;
}

/**
 * Throws immediately if any of apps/api's own @operator-agent/* workspace dependencies have
 * source newer than their compiled dist/ output. Set SKIP_BUILD_FRESHNESS_CHECK=true to bypass —
 * intended for a slim production image that ships dist/ without src/ at all, where "newer" can
 * never be determined and isn't a real risk anyway (there's no source to have drifted from).
 */
export function assertWorkspacePackagesAreFresh(currentFileUrl: string): void {
  if (process.env.SKIP_BUILD_FRESHNESS_CHECK === "true") {
    return;
  }

  const root = findWorkspaceRoot(path.dirname(fileURLToPath(currentFileUrl)));
  if (!root) {
    // No workspace root found (e.g. a packaged/vendored deployment with a different layout) —
    // nothing reliable to compare against, so this check simply doesn't apply rather than
    // guessing or failing a shape it was never designed for.
    return;
  }

  const stale: string[] = [];
  for (const pkg of CHECKED_PACKAGES) {
    const srcDir = path.join(root, "packages", pkg, "src");
    const distDir = path.join(root, "packages", pkg, "dist");
    if (!existsSync(srcDir)) {
      continue;
    }
    const srcMtime = latestMtimeMs(srcDir);
    const distMtime = latestMtimeMs(distDir);
    if (distMtime < srcMtime) {
      stale.push(pkg);
    }
  }

  if (stale.length > 0) {
    throw new Error(
      `Stale build detected for workspace package(s): ${stale.map((pkg) => `@operator-agent/${pkg}`).join(", ")}. ` +
        "Source files are newer than their compiled dist/ output — apps/api resolves these packages' " +
        "\"import\" condition to dist/ at runtime, not source, so it would silently run OLD code even " +
        "though the source has changed. Run `pnpm build` (or `pnpm --filter @operator-agent/<name> build` " +
        "for just the affected package) before starting the server or running tests. Set " +
        "SKIP_BUILD_FRESHNESS_CHECK=true to bypass this check in an environment where source isn't " +
        "available (e.g. a slim production image shipping only dist/)."
    );
  }
}
