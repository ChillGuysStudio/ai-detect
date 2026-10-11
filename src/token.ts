import { chromium } from "playwright-core";
import { AI_PAGE, RECAPTCHA_ACTION, SITEKEY, RecaptchaError, resJson } from "./core.ts";

export type BrowserProfile = "server" | "client";

/**
 * Free reCAPTCHA v3 token via local Chrome.
 * - "server": headless, default fingerprint (what a hosted backend would do).
 * - "client": headless with a realistic desktop fingerprint + real page
 *   interaction (scroll, delay) before executing, approximating a genuine
 *   user browser that later hands its token to the server.
 */
export async function getRecaptchaToken(
  profile: BrowserProfile = "server",
  sitekey = SITEKEY,
  pageUrl = AI_PAGE,
  action = RECAPTCHA_ACTION,
): Promise<{ token: string; ms: number }> {
  const t0 = Date.now();
  const launchOpts: Parameters<typeof chromium.launch>[0] = {
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    // Docker/self-host: CHROME_EXECUTABLE=/usr/bin/chromium
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
  };
  // Prefer installed google-chrome (no download needed); fall back to bundled chromium.
  let browser;
  try {
    browser = await chromium.launch(
      process.env.CHROME_EXECUTABLE ? launchOpts : { ...launchOpts, channel: "chrome" },
    );
  } catch {
    browser = await chromium.launch(launchOpts);
  }
  try {
    const context =
      profile === "client"
        ? await browser.newContext({
            userAgent:
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
            viewport: { width: 1536, height: 960 },
            locale: "en-US",
            timezoneId: "Europe/Berlin",
            deviceScaleFactor: 1,
          })
        : await browser.newContext();
    // Hide the webdriver flag like a hardening-conscious client would.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);
    if (profile === "client") {
      await page.mouse.move(400, 300);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(1500);
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
        [sitekey, action],
      ),
      Bun.sleep(25000).then(() => {
        throw new RecaptchaError(`grecaptcha.execute() timed out after 25s [${profile}] (quota/network?)`);
      }),
    ])) as unknown;
    if (typeof token !== "string" || token.length < 100) {
      throw new RecaptchaError(`bad ${profile} token: ${String(token).slice(0, 100)}`);
    }
    return { token, ms: Date.now() - t0 };
  } finally {
    await browser.close();
  }
}

/** CapSolver ReCaptchaV3TaskProxyLess (paid). Kept for parity with ai_detect.py. */
export async function solveCapsolver(apiKey: string): Promise<string> {
  const create = (await resJson(
    await fetch("https://api.capsolver.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: "ReCaptchaV3TaskProxyLess",
          websiteURL: AI_PAGE,
          websiteKey: SITEKEY,
          pageAction: RECAPTCHA_ACTION,
          isEnterprise: true,
        },
      }),
    }),
  )) as { taskId?: string };
  if (!create.taskId) throw new RecaptchaError(`capsolver createTask failed: ${JSON.stringify(create)}`);
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(5000);
    const res = (await resJson(
      await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId: create.taskId }),
      }),
    )) as { status?: string; solution?: { gRecaptchaResponse?: string } };
    if (res.status === "ready") {
      const tok = res.solution?.gRecaptchaResponse ?? "";
      if (tok) return tok;
      throw new RecaptchaError(`capsolver empty solution: ${JSON.stringify(res)}`);
    }
    if (res.status !== "processing" && res.status !== "idle") {
      throw new RecaptchaError(`capsolver error: ${JSON.stringify(res)}`);
    }
  }
  throw new RecaptchaError("capsolver timeout waiting for token");
}
