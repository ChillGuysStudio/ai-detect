import {
  createGuest,
  getCsrf,
  newJar,
  pollResult,
  submitAiCheck,
  validateText,
  type CheckResult,
  PaywallError,
  RecaptchaError,
} from "./core.ts";
import { getRecaptchaToken, solveCapsolver, type BrowserProfile } from "./token.ts";

export interface CheckOptions {
  recaptchaToken?: string;
  capsolverKey?: string;
  /** false when a manual/capsolver token is supplied */
  usePlaywright?: boolean;
  /** which browser profile mints the token (server vs client simulation) */
  tokenProfile?: BrowserProfile;
  filename?: string;
  fileBytes?: Uint8Array;
  pollIntervalMs?: number;
  verbose?: boolean;
  /** internal: auto-reset already retried once */
  _retried?: boolean;
}

export async function checkOnce(text: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const {
    recaptchaToken,
    capsolverKey,
    usePlaywright = true,
    tokenProfile = "server",
    filename,
    fileBytes,
    pollIntervalMs = 5000,
    verbose = true,
  } = opts;
  const jar = newJar();
  const csrf = await getCsrf(jar);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      await fetch("https://plagiarismcheck.org/login_json", {
        headers: { Referer: "https://plagiarismcheck.org/ai-detector/" },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch {
    /* analytics-adjacent, ignore */
  }
  let token: string;
  if (recaptchaToken) token = recaptchaToken;
  else if (capsolverKey) {
    if (verbose) console.log("solving reCAPTCHA via capsolver...");
    token = await solveCapsolver(capsolverKey);
  } else if (usePlaywright) {
    if (verbose) console.log(`fetching reCAPTCHA v3 token via local Chrome [${tokenProfile}]...`);
    token = (await getRecaptchaToken(tokenProfile)).token;
  } else {
    throw new RecaptchaError("no token source: pass recaptchaToken, capsolverKey, or allow playwright");
  }
  const apiToken = await createGuest(jar, csrf.guest_csrf, token);
  if (verbose) console.log(`guest api_token: ${apiToken.slice(0, 8)}...`);
  const info = await validateText(jar, apiToken, text);
  if (verbose) console.log(`validate: ${info.words} words, ${info.pages} pages`);
  const submitted = await submitAiCheck(jar, apiToken, text, filename, fileBytes);
  if (verbose) console.log(`submitted id=${submitted.id} status=${submitted.status}, polling...`);
  const result = await pollResult(jar, apiToken, submitted.id, pollIntervalMs, 600000, verbose);
  result._api_token = apiToken;
  result._check_id = submitted.id;
  return result;
}

/** One retry with a brand-new guest session (== clear cookies + Shift+Alt+R). */
export async function checkWithAutoReset(text: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const verbose = opts.verbose ?? true;
  try {
    return await checkOnce(text, opts);
  } catch (e) {
    if (!(e instanceof PaywallError)) throw e;
    if (opts._retried) throw e;
    if (verbose) console.log(`limit/paywall hit (${String(e).slice(0, 150)}), resetting guest and retrying once...`);
    await Bun.sleep(2000);
    return await checkOnce(text, { ...opts, _retried: true });
  }
}
