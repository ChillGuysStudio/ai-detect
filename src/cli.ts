#!/usr/bin/env bun
/** CLI: single AI check (text or PDF pages) with LLM-friendly JSON output.
 *
 *  bun run src/cli.ts --file essay.txt --out result.json
 *  bun run src/cli.ts --file doc.pdf --pages 1-3 --json   # stdout = pure result JSON
 *  bun run src/cli.ts --file doc.pdf --list-pages         # page inventory for picking --pages
 */
import { parseArgs } from "node:util";
import { checkWithAutoReset } from "./jobs.ts";
import { summarize, PaywallError, RecaptchaError, ValidationError } from "./core.ts";
import { excludePages, formatPages, parsePages } from "./pages.ts";
import { extractPdf, pdfPageInfo } from "./pdf.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    text: { type: "string" },
    file: { type: "string" },
    pages: { type: "string" },
    "exclude-pages": { type: "string" },
    "list-pages": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "upload-original": { type: "boolean", default: false },
    out: { type: "string" },
    "recaptcha-token": { type: "string" },
    "capsolver-key": { type: "string" },
    "no-playwright": { type: "boolean", default: false },
    "token-profile": { type: "string", default: "server" },
    "poll-interval": { type: "string", default: "5" },
    quiet: { type: "boolean", default: false },
  },
  strict: true,
});

const asJson = Boolean(values.json);
const log = (...a: unknown[]) => (asJson ? console.error(...a) : console.log(...a));
const fail = (code: number, error: string) => {
  if (asJson) console.log(JSON.stringify({ error, exitCode: code }));
  else console.error(error);
  process.exit(code);
};

if (!values.text && !values.file) fail(1, "need --text or --file");

async function readInput(): Promise<{ text: string; filename?: string; fileBytes?: Uint8Array; meta: Record<string, unknown> }> {
  if (values.text) return { text: values.text, meta: {} };
  const path = values.file!;
  const raw = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (/\.pdf$/i.test(path)) {
    if (values["list-pages"]) {
      const { pages, info } = await pdfPageInfo(raw);
      console.log(JSON.stringify({ file: path, pages, info }, null, 2));
      process.exit(0);
    }
    const { pages: total } = await pdfPageInfo(raw);
    const idx = excludePages(parsePages(values.pages, total), values["exclude-pages"], total);
    const ex = await extractPdf(raw, { pages: idx });
    const meta = { file: path, pages: formatPages(idx), ofTotal: total, method: ex.method };
    if (values["upload-original"]) {
      return { text: ex.text, filename: path.split("/").pop(), fileBytes: raw, meta };
    }
    return { text: ex.text, meta };
  }
  if (values["list-pages"] || values.pages || values["exclude-pages"]) {
    fail(1, "--pages/--exclude-pages/--list-pages only apply to PDFs");
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  if (values["upload-original"]) return { text, filename: path.split("/").pop(), fileBytes: raw, meta: { file: path } };
  return { text, meta: { file: path } };
}

const input = await readInput();
const words = input.text.split(/\s+/).filter(Boolean).length;
if (words < 100) {
  console.error(`WARNING: only ${words} words (site requires >=100, best 200-550). It will likely reject.`);
}
if (words > 600 && !input.fileBytes) {
  console.error(`WARNING: ${words} words in one check (free quota ~2 pages). Prefer --pages to select fewer pages, or use the web queue for whole documents.`);
}

try {
  const result = await checkWithAutoReset(input.text, {
    recaptchaToken: values["recaptcha-token"],
    capsolverKey: values["capsolver-key"] ?? process.env.CAPSOLVER_KEY,
    usePlaywright: !values["no-playwright"],
    tokenProfile: values["token-profile"] === "client" ? "client" : "server",
    filename: input.filename,
    fileBytes: input.fileBytes,
    pollIntervalMs: Number(values["poll-interval"]) * 1000,
    verbose: !values.quiet && !asJson,
  });
  const payload = { ...result, _meta: input.meta };
  if (asJson) {
    console.log(JSON.stringify(payload));
  } else {
    log(summarize(result));
    if (values.out) {
      await Bun.write(values.out, JSON.stringify(payload, null, 2));
      log(`wrote ${values.out}`);
    } else {
      const { id, status, words: w, pages, processed_percent, strong_percent, likely_percent, conclusion, conclusion_type, chunks } = result;
      log(JSON.stringify({ id, status, words: w, pages, processed_percent, strong_percent, likely_percent, conclusion, conclusion_type, chunks }, null, 2));
    }
  }
  if (values.out && asJson) await Bun.write(values.out, JSON.stringify(payload, null, 2));
} catch (e) {
  if (e instanceof RecaptchaError) fail(2, `RECAPTCHA FAILED: ${e.message}`);
  if (e instanceof PaywallError) fail(3, `PAYWALL/LIMIT (even after reset): ${e.message}`);
  if (e instanceof ValidationError) fail(4, `REJECTED (no retry): ${e.message}`);
  fail(1, `ERROR: ${(e as Error).name}: ${(e as Error).message}`);
}
