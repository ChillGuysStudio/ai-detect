/** Upstream failure handling: classify network errors, explain them plainly,
 *  and decide what is worth retrying. */
import { PaywallError, RecaptchaError, ValidationError } from "./core.ts";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Transient transport failures (DNS blip, reset connection, hung body) that
 *  a fresh attempt may survive. Validation/recaptcha errors never retry:
 *  repeating the same input cannot fix them. */
export function isRetryableNetworkError(e: unknown): boolean {
  if (e instanceof ValidationError || e instanceof RecaptchaError || e instanceof PaywallError) {
    return false;
  }
  if (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") {
    return true;
  }
  return /eai_again|enotfound|econnreset|econnrefused|etimedout|econnaborted|eai_fail|fetch failed|network error|socket hang up|timed out|timeout|could not connect|unable to connect|connection refused|connection reset|connection closed/i.test(
    message(e),
  );
}

/** Turn transport errors into something a user can act on. */
export function upstreamMessage(e: unknown): string {
  const raw = message(e);
  const low = raw.toLowerCase();
  if (/eai_again|enotfound|getaddrinfo/.test(low)) {
    return (
      "cannot reach plagiarismcheck.org (DNS lookup failed - check your network, " +
      "VPN, or container DNS, e.g. docker run --dns=8.8.8.8)"
    );
  }
  if (
    (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") ||
    /the operation was aborted|timed out|timeout|socket hang up|fetch failed|could not connect|unable to connect|connection refused|connection reset|connection closed/i.test(low)
  ) {
    return `request to plagiarismcheck.org timed out (${raw.slice(0, 120)})`;
  }
  return raw.slice(0, 300);
}

/** Fail fast when the site is unreachable, before burning chunk attempts.
 *  Throws a human-readable error. Pass a custom URL in tests. */
export async function checkUpstream(
  url = "https://plagiarismcheck.org/csrf_tokens",
  timeoutMs = 8000,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
      return;
    } catch (e) {
      if (attempt === 1) throw new Error(upstreamMessage(e));
      await Bun.sleep(3000);
    } finally {
      clearTimeout(t);
    }
  }
}
