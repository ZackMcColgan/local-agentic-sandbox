#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { convertDrawioToSvg, sanitizeSvg, isDrawioXml } from "../web-ui/lib/svgUtils";

export function convertDrawioFileToSvg(inputPath: string, outputPath: string): { bytesWritten: number; durationMs: number } {
  const startTime = Date.now();

  const resolvedInput = path.resolve(process.cwd(), inputPath);
  const resolvedOutput = path.resolve(process.cwd(), outputPath);

  if (!fs.existsSync(resolvedInput)) {
    throw new Error(`Input file not found: ${resolvedInput}`);
  }

  const rawXml = fs.readFileSync(resolvedInput, "utf8");
  if (!isDrawioXml(rawXml)) {
    throw new Error(`File is not recognized as valid Draw.io XML: ${resolvedInput}`);
  }

  // Convert Draw.io XML to raw SVG
  const rawSvg = convertDrawioToSvg(rawXml);
  if (!rawSvg || rawSvg.length === 0) {
    throw new Error(`Failed to convert Draw.io XML to SVG for: ${resolvedInput}`);
  }

  // Sanitize SVG (removes scripts, enforces security rules, validates viewBox)
  const cleanSvg = sanitizeSvg(rawSvg);
  if (!cleanSvg || !cleanSvg.includes("<svg")) {
    throw new Error(`Sanitization produced invalid SVG output`);
  }

  // Ensure output directory exists
  const outDir = path.dirname(resolvedOutput);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Write output SVG
  fs.writeFileSync(resolvedOutput, cleanSvg, "utf8");
  const durationMs = Date.now() - startTime;
  const bytesWritten = Buffer.byteLength(cleanSvg, "utf8");

  return { bytesWritten, durationMs };
}

// CLI execution entrypoint
if (require.main === module || process.argv[1]?.includes("drawio-to-svg")) {
  const args = process.argv.slice(2);
  const inputArg = args[0] || "docs/architecture.drawio";
  const outputArg = args[1] || "docs/architecture.svg";

  try {
    console.log(`[drawio-to-svg] Compiling ${inputArg} -> ${outputArg}...`);
    const { bytesWritten, durationMs } = convertDrawioFileToSvg(inputArg, outputArg);
    console.log(`[drawio-to-svg] SUCCESS: Generated ${outputArg} (${bytesWritten} bytes) in ${durationMs}ms`);
  } catch (err: any) {
    console.error(`[drawio-to-svg] ERROR: ${err.message}`);
    process.exit(1);
  }
}
