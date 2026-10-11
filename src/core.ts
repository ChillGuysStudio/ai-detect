export const BASE = "https://plagiarismcheck.org";
export const AI_PAGE = `${BASE}/ai-detector/`;
export const SITEKEY = "6Lf0E6UUAAAAADeWask-eQPkGGnp6KNVN2BlCvNu";
export const RECAPTCHA_ACTION = "guest";
export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

export class PaywallError extends Error {}
export class ValidationError extends Error {}
export class RecaptchaError extends Error {}

export interface CheckResult {
  id: number;
  status: number;
  words?: number;
  pages?: number;
  processed_percent?: string;
  strong_percent?: string;
  likely_percent?: string;
  chunks?: Array<{ position: [number, number]; reliability: number }>;
  conclusion?: string;
  conclusion_type?: number;
  [k: string]: unknown;
  _api_token?: string;
  _check_id?: number;
}

/** Minimal cookie jar: fetch() doesn't persist cookies like requests.Session. */
export class Jar {
  private store = new Map<string, string>();
  get header(): string | undefined {
    if (this.store.size === 0) return undefined;
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  ingest(setCookies: string[] | null | undefined) {
    if (!setCookies) return;
    for (const sc of setCookies) {
      const pair = sc.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}

function getSetCookies(res: Response): string[] {
  // Bun/Node undici: getSetCookie() exists on Headers in newer runtimes
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    try {
      return h.getSetCookie();
    } catch {
      return [];
    }
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

async function req(
  jar: Jar,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", UA);
  if (!headers.has("Referer")) headers.set("Referer", AI_PAGE);
  const cookie = jar.header;
  if (cookie) headers.set("Cookie", cookie);
  const { timeoutMs = 30000, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, headers, signal: ctrl.signal });
    jar.ingest(getSetCookies(res));
    return res;
  } finally {
    clearTimeout(t);
  }
}

/** res.json() with its own timeout: headers may arrive while the body stalls. */
export async function resJson(res: Response, timeoutMs = 30000): Promise<unknown> {
  const text = await Promise.race([
    res.text(),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`response body timeout after ${timeoutMs}ms (HTTP ${res.status})`);
    }),
  ]);
  return JSON.parse(text as string);
}

export function newJar(): Jar {
  return new Jar();
}

export async function getCsrf(jar: Jar): Promise<{
  token: string;
  login_token: string;
  guest_csrf: string;
}> {
  const res = await req(jar, `${BASE}/csrf_tokens`, { timeoutMs: 20000 });
  if (!res.ok) throw new Error(`csrf_tokens HTTP ${res.status}`);
  return (await resJson(res, 20000)) as { token: string; login_token: string; guest_csrf: string };
}

export async function createGuest(
  jar: Jar,
  guestCsrf: string,
  recaptchaToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    _csrf_token: guestCsrf,
    "guest-security-token": recaptchaToken,
  });
  const res = await req(jar, `${BASE}/guest/registration/`, {
    method: "POST",
    body,
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeoutMs: 30000,
  });
  let data: unknown;
  try {
    data = await resJson(res);
  } catch {
    throw new Error(`guest/registration non-JSON HTTP ${res.status}`);
  }
  const d = data as { success?: boolean; data?: { user?: { api_token?: string } } };
  if (!d?.success) {
    const msg = JSON.stringify(data).slice(0, 400);
    if (/recaptcha/i.test(msg)) throw new RecaptchaError(msg);
    throw new PaywallError(msg);
  }
  const api = d.data?.user?.api_token;
  if (!api) throw new Error(`guest/registration missing api_token: ${JSON.stringify(data).slice(0, 300)}`);
  return api;
}

const VALIDATION_NO_RETRY = [
  "less then",
  "minimum",
  "character",
  "100 words",
  "english",
  "spanish",
  "language",
];

export async function validateText(
  jar: Jar,
  apiToken: string,
  text: string,
): Promise<{ words: number; pages: number }> {
  const body = new URLSearchParams({ text, skip_orders_validation: "1" });
  const res = await req(jar, `${BASE}/api/v1/chat-gpt/validate/`, {
    method: "POST",
    body,
    headers: {
      "X-API-TOKEN": apiToken,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    timeoutMs: 30000,
  });
  const data = (await resJson(res)) as { success?: boolean; data?: { words: number; pages: number } };
  if (!data?.success) {
    const msg = JSON.stringify(data).slice(0, 500);
    if (VALIDATION_NO_RETRY.some((k) => msg.toLowerCase().includes(k))) {
      throw new ValidationError(`validate failed: ${msg}`);
    }
    throw new PaywallError(`validate failed: ${msg}`);
  }
  return data.data!;
}

export async function submitAiCheck(
  jar: Jar,
  apiToken: string,
  text: string,
  filename?: string,
  fileBytes?: Uint8Array,
): Promise<{ id: number; status: number | null }> {
  const form = new FormData();
  if (fileBytes) {
    form.append("file", new Blob([fileBytes as unknown as BlobPart]), filename ?? "doc.txt");
  } else {
    form.append("text", text);
  }
  const res = await req(jar, `${BASE}/api/v1/chat-gpt/`, {
    method: "POST",
    body: form,
    headers: { "X-API-TOKEN": apiToken },
    timeoutMs: 60000,
  });
  const payload = (await resJson(res, 60000)) as {
    success?: boolean;
    data?: { id: number; status: number | null };
  };
  if (!payload?.success) {
    throw new PaywallError(`submit failed: ${JSON.stringify(payload).slice(0, 600)}`);
  }
  return payload.data!;
}

export async function pollResult(
  jar: Jar,
  apiToken: string,
  checkId: number,
  intervalMs = 5000,
  timeoutMs = 600000,
  verbose = true,
): Promise<CheckResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await req(jar, `${BASE}/api/v1/chat-gpt/${checkId}/`, {
      headers: { "X-API-TOKEN": apiToken },
      timeoutMs: 30000,
    });
    const payload = (await resJson(res)) as { success?: boolean; data?: CheckResult };
    if (!payload?.success) {
      throw new PaywallError(`poll failed: ${JSON.stringify(payload).slice(0, 500)}`);
    }
    const d = payload.data!;
    if (d.status !== 1 && d.status !== 2 && d.status !== null && d.status !== undefined) {
      return d;
    }
    if (verbose) console.log(`  ...status=${d.status} processing, waiting ${intervalMs / 1000}s`);
    if (Date.now() > deadline) throw new Error(`poll timeout for id=${checkId}`);
    await Bun.sleep(intervalMs);
  }
}

export function summarize(r: CheckResult): string {
  return [
    `check id: ${r.id}  status: ${r.status}`,
    `words: ${r.words}  pages: ${r.pages}`,
    `AI highly-likely: ${r.strong_percent}%  likely: ${r.likely_percent}%  processed: ${r.processed_percent}%`,
    `conclusion: ${r.conclusion} (type ${r.conclusion_type})`,
    `flagged chunks: ${(r.chunks ?? []).length}`,
  ].join("\n");
}
