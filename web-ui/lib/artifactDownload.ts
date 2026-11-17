import { inferAttachmentMimeType } from "./attachmentMime";

// Known artifact extensions that download paths should preserve verbatim
// rather than blindly appending ".svg".
const KNOWN_ARTIFACT_EXTENSIONS = [".svg", ".drawio", ".xml", ".html"];

/**
 * Resolve the download filename + MIME for an SvgViewer artifact.
 * - If the cleaned title already ends with a known artifact extension, keep it
 *   and derive the MIME from that extension (so weather-card.html downloads as
 *   weather-card.html + text/html, chart.drawio as chart.drawio + application/xml).
 * - Otherwise append ".svg" (or ".drawio" for Draw.io XML) as today.
 */
export function resolveArtifactDownload(
  title: string,
  rawSvg: string,
  isDrawioXml: boolean
): { filename: string; mime: string } {
  const cleanTitle = title.replace(/[^a-zA-Z0-9_.-]/g, "_").toLowerCase();
  const known = KNOWN_ARTIFACT_EXTENSIONS.find((ext) => cleanTitle.endsWith(ext));

  if (known) {
    return { filename: cleanTitle, mime: inferAttachmentMimeType(cleanTitle) };
  }

  // No known extension in the title: fall back to the legacy behavior.
  const ext = isDrawioXml && !rawSvg.startsWith("<svg") ? ".drawio" : ".svg";
  return {
    filename: `${cleanTitle}${ext}`,
    mime: inferAttachmentMimeType(`artifact${ext}`),
  };
}
