// Pure, fs-free MIME inference shared by server (threadOutputs) and client
// (SvgViewer / ArtifactRenderers) download paths. Keeping this module free of
// Node-only imports (fs/path) lets it be bundled into "use client" components.
export function inferAttachmentMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  switch (ext) {
    case "html":
      return "text/html";
    case "svg":
      return "image/svg+xml";
    case "drawio":
    case "xml":
      return "application/xml";
    case "md":
      return "text/markdown";
    case "txt":
    case "log":
      return "text/plain";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "py":
      return "text/x-python";
    case "js":
    case "ts":
    case "tsx":
    case "jsx":
    case "mjs":
    case "cjs":
      return "application/javascript";
    case "css":
      return "text/css";
    case "yaml":
    case "yml":
      return "text/yaml";
    default:
      return "application/octet-stream";
  }
}
