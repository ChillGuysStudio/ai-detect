#!/usr/bin/env bun
/** CLI: bun run src/cli.ts --file sample.txt --out result.json */

import { parseArgs } from "node:util";
import { checkWithAutoReset } from "./jobs.ts";
import { summarize, PaywallError, RecaptchaError, ValidationError } from "./core.ts";

async function readInput(file?: string, uploadOriginal?: boolean): Promise<{
  text: string;
  filename?: string;
  fileBytes?: Uint8Array;
}> {
  if (!file) return { text: "" };
  if (file.endsWith(".pdf")) {
    const text = await extractPdfText(file);
    if (uploadOriginal) return { text, filename: file.split("/").pop(), fileBytes: new Uint8Array(await Bun.file(file).arrayBuffer()) };
    return { text };
  }
  const raw = new Uint8Array(await Bun.file(file).arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  if (uploadOriginal) return { text, filename: file.split("/").pop(), fileBytes: raw };
  return { text };
}

async function extractPdfText(path: string): Promise<string> {
  // Bun has no built-in PDF parser; try pdfjs-dist if installed, else fail loudly.
  try {
    // @ts-ignore - optional dependency
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await Bun.file(path).arrayBuffer());
    const doc = await pdfjs.getDocument({ data }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      parts.push(tc.items.map((it: unknown) => (it as { str?: string }).str ?? "").join(" "));
    }
    return parts.join("\n");
  } catch {
    throw new Error("PDF needs `bun add pdfjs-dist`, or convert to .txt first.");
  }
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    text: { type: "string" },
    file: { type: "string" },
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

if (!values.text && !values.file) {
  console.error("need --text or --file");
  process.exit(1);
}

const text = values.text ?? (await readInput(values.file, values["upload-original"])).text;
const input = values.text ? { text } : await readInput(values.file, values["upload-original"]);
const words = input.text.split(/\s+/).filter(Boolean).length;
if (words < 100) {
  console.error(`WARNING: only ${words} words (site requires >=100, best 200-550). It will likely reject.`);
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
    verbose: !values.quiet,
  });
  console.log(summarize(result));
  if (values.out) {
    await Bun.write(values.out, JSON.stringify(result, null, 2));
    console.log(`wrote ${values.out}`);
  } else {
    const { id, status, words: w, pages, processed_percent, strong_percent, likely_percent, conclusion, conclusion_type, chunks } = result;
    console.log(JSON.stringify({ id, status, words: w, pages, processed_percent, strong_percent, likely_percent, conclusion, conclusion_type, chunks }, null, 2));
  }
} catch (e) {
  if (e instanceof RecaptchaError) {
    console.error(`RECAPTCHA FAILED: ${e.message}`);
    process.exit(2);
  }
  if (e instanceof PaywallError) {
    console.error(`PAYWALL/LIMIT (even after reset): ${e.message}`);
    process.exit(3);
  }
  if (e instanceof ValidationError) {
    console.error(`REJECTED (no retry): ${e.message}`);
    process.exit(4);
  }
  console.error(`ERROR: ${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
}
