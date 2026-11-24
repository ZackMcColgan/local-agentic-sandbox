export type DryRunUrlValidationResult = { ok: true; url: string } | { ok: false; error: string };

const ALLOWED_EXACT_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "kind-gateway"]);

function isAllowedClusterHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  if (ALLOWED_EXACT_HOSTS.has(lower)) {
    return true;
  }
  return lower.endsWith(".svc") || lower.endsWith(".svc.cluster.local");
}

function matchesDeployUrlOrigin(parsed: URL, envDeployUrl?: string): boolean {
  const trimmed = envDeployUrl?.trim();
  if (!trimmed) return false;
  try {
    const allowed = new URL(trimmed);
    return parsed.origin.toLowerCase() === allowed.origin.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Pure allowlist validator for POST /api/deploy deployBuild dryRunUrl.
 * Permits only cluster-internal hostnames (localhost, 127.0.0.1, *.svc,
 * *.svc.cluster.local, kind-gateway) or the configured DEPLOY_URL origin.
 */
export function validateDeployDryRunUrl(
  rawUrl: unknown,
  envDeployUrl?: string
): DryRunUrlValidationResult {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return { ok: false, error: "Invalid dryRunUrl: must be a non-empty http(s) URL" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: `Invalid dryRunUrl: malformed URL '${rawUrl}'` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `Invalid dryRunUrl: protocol '${parsed.protocol}' is not permitted`,
    };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "Invalid dryRunUrl: embedded credentials are not permitted" };
  }

  if (!isAllowedClusterHostname(parsed.hostname) && !matchesDeployUrlOrigin(parsed, envDeployUrl)) {
    return {
      ok: false,
      error: `Invalid dryRunUrl: host '${parsed.hostname}' is not in the cluster-internal allowlist`,
    };
  }

  return { ok: true, url: parsed.toString() };
}
