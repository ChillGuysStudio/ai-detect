/** Persistent Chromium for token minting: one browser, fresh context per token.
 * Much faster than launch-per-check (~1-2s vs ~8s) and steadier on RAM.
 */
import { chromium, type Browser } from "playwright-core";
import { AI_PAGE, RECAPTCHA_ACTION, SITEKEY, RecaptchaError } from "./core.ts";
import type { BrowserProfile } from "./token.ts";
import { getRecaptchaToken as oneShotToken } from "./token.ts";

let browser: Browser | null = null;
let starting: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!starting) {
    starting = (async () => {
      const opts = {
        headless: true,
        args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
      };
      try {
        browser = await chromium.launch(
          process.env.CHROME_EXECUTABLE ? opts : { ...opts, channel: "chrome" },
        );
      } catch {
        browser = await chromium.launch(opts);
      }
      return browser;
    })().finally(() => {
      starting = null;
    });
  }
  return starting;
}

export async function mintToken(profile: BrowserProfile = "server"): Promise<{ token: string; ms: number }> {
  const t0 = Date.now();
  const b = await getBrowser();
  const context =
    profile === "client"
      ? await b.newContext({
          userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
          viewport: { width: 1536, height: 960 },
          locale: "en-US",
          timezoneId: "Europe/Berlin",
        })
      : await b.newContext();
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    const page = await context.newPage();
    await page.goto(AI_PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3500);
    if (profile === "client") {
      await page.mouse.move(400, 300);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(1200);
    }
    const token = (await Promise.race([
      page.evaluate(
        async (pair: string[]) => {
          const [key, act] = pair;
          const w = window as unknown as {
            grecaptcha: { execute(k: string, o: { action: string }): Promise<string> };
          };
          return await w.grecaptcha.execute(key, { action: act });
        },
        [SITEKEY, RECAPTCHA_ACTION],
      ),
      Bun.sleep(25000).then(() => {
        throw new RecaptchaError(`grecaptcha.execute() timed out [${profile}]`);
      }),
    ])) as unknown;
    if (typeof token !== "string" || token.length < 100) {
      throw new RecaptchaError(`bad ${profile} token: ${String(token).slice(0, 100)}`);
    }
    return { token, ms: Date.now() - t0 };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Fallback used when the persistent browser is unavailable (e.g. no Chrome). */
export async function mintTokenWithFallback(
  profile: BrowserProfile,
  capsolverKey?: string,
): Promise<string> {
  if (capsolverKey) {
    const { solveCapsolver } = await import("./token.ts");
    return solveCapsolver(capsolverKey);
  }
  try {
    return (await mintToken(profile)).token;
  } catch (e) {
    // persistent browser broken? try one-shot launch once
    console.error(`persistent browser failed (${(e as Error).message}), trying one-shot`);
    browser = null;
    return (await oneShotToken(profile)).token;
  }
}

export async function closeBrowser() {
  await browser?.close().catch(() => {});
  browser = null;
}
