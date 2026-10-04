import DOMPurify from "dompurify";

let domPurifyInstance: any = null;
let lastWindow: any = null;

function patchHappyDomNode(targetWin: any) {
  try {
    const winNode = targetWin?.Node;
    if (winNode && winNode.prototype) {
      const origNodeName = Object.getOwnPropertyDescriptor(winNode.prototype, "nodeName")?.get;
      Object.defineProperty(winNode.prototype, "nodeName", {
        get() {
          if ((this as any).tagName) return (this as any).tagName;
          const name = origNodeName ? origNodeName.call(this) : "";
          if (name) return name;
          if (this.nodeType === 3) return "#text";
          if (this.nodeType === 8) return "#comment";
          if (this.nodeType === 11) return "#document-fragment";
          if (this.nodeType === 9) return "#document";
          return "#unknown";
        },
        configurable: true
      });
    }
  } catch {}
}

function getPurifier() {
  if (typeof window !== "undefined") {
    // If the window instance changed (e.g. across tests), recreate purifier instance
    if (domPurifyInstance && lastWindow === window) {
      return domPurifyInstance;
    }
    lastWindow = window;
    patchHappyDomNode(window);
    if (typeof (DOMPurify as any) === "function") {
      domPurifyInstance = (DOMPurify as any)(window);
    } else {
      domPurifyInstance = DOMPurify;
    }
    return domPurifyInstance;
  }

  // Node / SSR / Test environment without global window
  if (domPurifyInstance && lastWindow === null) {
    return domPurifyInstance;
  }

  try {
    if (typeof window === "undefined") {
      // Dynamic require avoids Webpack client-side static bundling of happy-dom
      const req = (globalThis as any).__non_webpack_require__ || Function("return require")();
      const { GlobalWindow } = req("happy-dom");
      const win = new GlobalWindow();
      patchHappyDomNode(win);
      domPurifyInstance = (DOMPurify as any)(win);
      lastWindow = null;
    }
  } catch {
    // Environment without happy-dom, fallback will be used
  }
  return domPurifyInstance;
}

export function isDrawioXml(code: string): boolean {
  if (!code || typeof code !== "string") return false;
  const trimmed = code.trim();
  return (
    /<mxfile\b/i.test(trimmed) ||
    /<mxGraphModel\b/i.test(trimmed) ||
    /<diagram\b/i.test(trimmed)
  );
}

function parseStyle(styleStr?: string): Record<string, string | boolean> {
  const style: Record<string, string | boolean> = {};
  if (!styleStr) return style;
  const parts = styleStr.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx !== -1) {
      const k = part.substring(0, idx).trim();
      const v = part.substring(idx + 1).trim();
      if (k) style[k] = v;
    } else {
      const k = part.trim();
      if (k) style[k] = true;
    }
  }
  return style;
}

function escapeXml(unsafe?: string): string {
  if (!unsafe) return "";
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeEntities(str: string): string {
  if (!str) return "";
  let res = str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#xa;/gi, "\n")
    .replace(/&amp;/g, "&");

  if (res.includes("&amp;") || res.includes("&lt;") || res.includes("&gt;")) {
    res = res
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'")
      .replace(/&#xa;/gi, "\n")
      .replace(/&amp;/g, "&");
  }
  return res;
}

/**
 * Converts Draw.io XML (<mxfile>, <mxGraphModel>) into a valid, standalone SVG graphic.
 */
export function convertDrawioToSvg(xml: string): string {
  if (!xml || typeof xml !== "string") return "";

  try {
    let cleanXml = xml;
    // If the XML is encoded inside an HTML block
    if (
      cleanXml.includes("&lt;mxfile") ||
      cleanXml.includes("&lt;mxGraphModel") ||
      cleanXml.includes("&lt;mxCell") ||
      cleanXml.includes("&lt;diagram")
    ) {
      cleanXml = unescapeEntities(cleanXml);
    }

  // Parse mxCell elements
  const cells: Array<{
    id: string;
    parent?: string;
    value?: string;
    style?: string;
    vertex?: string;
    edge?: string;
    source?: string;
    target?: string;
    geometry?: Record<string, string>;
    points?: Array<{ x: number; y: number }>;
  }> = [];

  const cellRegex = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/gi;
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(cleanXml)) !== null) {
    const attrsStr = match[1];
    const inner = match[2] || "";

    const attrs: any = {};
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2] !== undefined ? attrMatch[2] : attrMatch[3];
    }

    // Geometry
    const geoMatch = /<mxGeometry\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxGeometry>)/i.exec(inner);
    if (geoMatch) {
      const geoAttrs: Record<string, string> = {};
      let gMatch: RegExpExecArray | null;
      while ((gMatch = attrRegex.exec(geoMatch[1])) !== null) {
        geoAttrs[gMatch[1]] = gMatch[2] !== undefined ? gMatch[2] : gMatch[3];
      }
      attrs.geometry = geoAttrs;

      // Waypoints inside mxGeometry
      if (geoMatch[2]) {
        const points: Array<{ x: number; y: number }> = [];
        const ptRegex = /<mxPoint\b([^>]*?)\/?>/gi;
        let ptMatch: RegExpExecArray | null;
        while ((ptMatch = ptRegex.exec(geoMatch[2])) !== null) {
          const ptAttrs: Record<string, string> = {};
          let pAttr: RegExpExecArray | null;
          while ((pAttr = attrRegex.exec(ptMatch[1])) !== null) {
            ptAttrs[pAttr[1]] = pAttr[2] !== undefined ? pAttr[2] : pAttr[3];
          }
          if (ptAttrs.x !== undefined && ptAttrs.y !== undefined) {
            points.push({ x: parseFloat(ptAttrs.x), y: parseFloat(ptAttrs.y) });
          }
        }
        if (points.length > 0) attrs.points = points;
      }
    }

    if (attrs.id && attrs.id !== "0" && attrs.id !== "1") {
      cells.push(attrs);
    }
  }

  const vertices = cells.filter((c) => c.vertex === "1" && c.geometry);
  const edges = cells.filter((c) => c.edge === "1");

  if (vertices.length === 0 && edges.length === 0) {
    return "";
  }

  // Build vertex map
  const vertexMap = new Map<string, any>();
  for (const v of vertices) {
    const g = v.geometry || {};
    const x = parseFloat(g.x || "0");
    const y = parseFloat(g.y || "0");
    const width = parseFloat(g.width || "120");
    const height = parseFloat(g.height || "60");
    vertexMap.set(v.id, {
      ...v,
      parsedStyle: parseStyle(v.style),
      x,
      y,
      width,
      height,
      absX: x,
      absY: y
    });
  }

  // Calculate absolute positions taking parent hierarchy into account
  for (const v of vertexMap.values()) {
    let parentId = v.parent;
    let depth = 0;
    while (parentId && vertexMap.has(parentId) && depth < 10) {
      const parent = vertexMap.get(parentId);
      v.absX += parent.x;
      v.absY += parent.y;
      parentId = parent.parent;
      depth++;
    }
  }

  // Compute overall bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of vertexMap.values()) {
    minX = Math.min(minX, v.absX);
    minY = Math.min(minY, v.absY);
    maxX = Math.max(maxX, v.absX + v.width);
    maxY = Math.max(maxY, v.absY + v.height);
  }

  if (!isFinite(minX)) minX = 0;
  if (!isFinite(minY)) minY = 0;
  if (!isFinite(maxX) || maxX <= minX) maxX = minX + 800;
  if (!isFinite(maxY) || maxY <= minY) maxY = minY + 600;

  const padding = 40;
  const viewBoxX = minX - padding;
  const viewBoxY = minY - padding;
  const viewBoxW = (maxX - minX) + padding * 2;
  const viewBoxH = (maxY - minY) + padding * 2;

  // Sort vertices: containers (larger area) drawn in background first, smaller nodes on top
  const sortedVertices = Array.from(vertexMap.values()).sort((a, b) => {
    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    return areaB - areaA;
  });

  const svgParts: string[] = [];
  svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" class="drawio-svg" viewBox="${viewBoxX} ${viewBoxY} ${viewBoxW} ${viewBoxH}" width="100%" height="100%" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: transparent;">`);

  // Definitions
  svgParts.push(`  <defs>`);
  svgParts.push(`    <filter id="drawio-shadow" x="-10%" y="-10%" width="125%" height="125%">`);
  svgParts.push(`      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.08"/>`);
  svgParts.push(`    </filter>`);
  svgParts.push(`    <marker id="drawio-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`);
  svgParts.push(`      <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#3b82f6" />`);
  svgParts.push(`    </marker>`);
  svgParts.push(`    <marker id="drawio-arrow-emerald" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`);
  svgParts.push(`      <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#10b981" />`);
  svgParts.push(`    </marker>`);
  svgParts.push(`    <marker id="drawio-arrow-slate" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">`);
  svgParts.push(`      <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#64748b" />`);
  svgParts.push(`    </marker>`);
  svgParts.push(`  </defs>`);

  // Render Vertices
  for (const v of sortedVertices) {
    const s = v.parsedStyle || {};
    const isContainer = (v.width * v.height > 80000) || (s.rounded === "1" && v.width > 300);
    const stroke = (s.strokeColor as string) || (isContainer ? "#cbd5e1" : "#64748b");
    const strokeWidth = s.strokeWidth ? parseFloat(s.strokeWidth as string) : (isContainer ? 2 : 1.5);
    const fill = (s.fillColor as string) || (isContainer ? "rgba(248, 250, 252, 0.4)" : "#ffffff");
    const fillOpacity = isContainer ? "0.35" : ((s["fill-opacity"] as string) || "1");
    const isDashed = s.dashed === "1";
    const rx = s.rounded === "1" ? 8 : (s.rounded ? 12 : 4);
    const dashAttr = isDashed ? 'stroke-dasharray="6 3"' : "";

    svgParts.push(`  <!-- Node: ${escapeXml(v.id)} -->`);
    svgParts.push(`  <g id="node-${escapeXml(v.id)}" class="drawio-node">`);

    if (s.shape === "cylinder") {
      const topH = Math.min(18, v.height * 0.25);
      svgParts.push(`    <path d="M ${v.absX} ${v.absY + topH} L ${v.absX} ${v.absY + v.height - topH} A ${v.width / 2} ${topH} 0 0 0 ${v.absX + v.width} ${v.absY + v.height - topH} L ${v.absX + v.width} ${v.absY + topH} Z" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-width="${strokeWidth}" ${dashAttr} filter="url(#drawio-shadow)"/>`);
      svgParts.push(`    <ellipse cx="${v.absX + v.width / 2}" cy="${v.absY + topH}" rx="${v.width / 2}" ry="${topH}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" />`);
    } else if (s.shape === "ellipse") {
      svgParts.push(`    <ellipse cx="${v.absX + v.width / 2}" cy="${v.absY + v.height / 2}" rx="${v.width / 2}" ry="${v.height / 2}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-width="${strokeWidth}" ${dashAttr} filter="url(#drawio-shadow)"/>`);
    } else {
      svgParts.push(`    <rect x="${v.absX}" y="${v.absY}" width="${v.width}" height="${v.height}" rx="${rx}" ry="${rx}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-width="${strokeWidth}" ${dashAttr} ${isContainer ? "" : 'filter="url(#drawio-shadow)"'}/>`);
    }

    // Text Label
    if (v.value) {
      const rawVal = unescapeEntities(v.value);
      const cleanVal = rawVal.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").trim();
      const lines = cleanVal.split(/\\n|\n|\s{3,}/).filter(Boolean);

      const labelY = isContainer
        ? v.absY + 22
        : (v.absY + v.height / 2 - (lines.length - 1) * 7);

      const textColor = (s.fontColor as string) || "#0f172a";
      const fontWeight = isContainer ? "700" : "600";
      const fontSize = isContainer ? "13" : "11.5";

      svgParts.push(`    <text x="${v.absX + v.width / 2}" y="${labelY}" text-anchor="middle" dominant-baseline="central" fill="${textColor}" font-size="${fontSize}" font-weight="${fontWeight}" letter-spacing="-0.01em">`);

      lines.forEach((line: string, idx: number) => {
        const dy = idx === 0 ? "0" : "15";
        svgParts.push(`      <tspan x="${v.absX + v.width / 2}" dy="${dy}">${escapeXml(line.trim())}</tspan>`);
      });
      svgParts.push(`    </text>`);
    }

    svgParts.push(`  </g>`);
  }

  // Render Edges
  for (const edge of edges) {
    const s = parseStyle(edge.style);
    const source = edge.source ? vertexMap.get(edge.source) : undefined;
    const target = edge.target ? vertexMap.get(edge.target) : undefined;

    let startX = 0, startY = 0, endX = 0, endY = 0;

    if (source && target) {
      const exitX = s.exitX !== undefined ? parseFloat(s.exitX as string) : 0.5;
      const exitY = s.exitY !== undefined ? parseFloat(s.exitY as string) : 0.5;
      const entryX = s.entryX !== undefined ? parseFloat(s.entryX as string) : 0.5;
      const entryY = s.entryY !== undefined ? parseFloat(s.entryY as string) : 0.5;

      startX = source.absX + source.width * exitX;
      startY = source.absY + source.height * exitY;
      endX = target.absX + target.width * entryX;
      endY = target.absY + target.height * entryY;
    } else if (edge.points && edge.points.length >= 2) {
      startX = edge.points[0].x;
      startY = edge.points[0].y;
      endX = edge.points[edge.points.length - 1].x;
      endY = edge.points[edge.points.length - 1].y;
    }

    if (startX === 0 && startY === 0 && endX === 0 && endY === 0) continue;

    const stroke = (s.strokeColor as string) || "#2563eb";
    const strokeWidth = s.strokeWidth ? parseFloat(s.strokeWidth as string) : 2;
    const isDashed = s.dashed === "1";
    const dashAttr = isDashed ? 'stroke-dasharray="5 3"' : "";

    const pathSegments = [`M ${startX} ${startY}`];
    let midX = (startX + endX) / 2;
    let midY = (startY + endY) / 2;

    if (edge.points && edge.points.length > 0) {
      for (const pt of edge.points) {
        pathSegments.push(`L ${pt.x} ${pt.y}`);
      }
      const midPt = edge.points[Math.floor(edge.points.length / 2)];
      midX = midPt.x;
      midY = midPt.y;
    }
    pathSegments.push(`L ${endX} ${endY}`);

    const markerId = stroke.includes("10b981") || stroke.includes("82b366")
      ? "drawio-arrow-emerald"
      : (stroke.includes("64748b") || stroke.includes("b85450") ? "drawio-arrow-slate" : "drawio-arrow");

    svgParts.push(`  <!-- Edge: ${escapeXml(edge.id)} -->`);
    svgParts.push(`  <g id="edge-${escapeXml(edge.id)}" class="drawio-edge">`);
    svgParts.push(`    <path d="${pathSegments.join(" ")}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" ${dashAttr} marker-end="url(#${markerId})"/>`);

    // Edge Label Badge
    if (edge.value) {
      const rawVal = unescapeEntities(edge.value);
      const cleanVal = rawVal.replace(/<[^>]+>/g, "").trim();
      const textLen = cleanVal.length * 6.5 + 14;
      svgParts.push(`    <rect x="${midX - textLen / 2}" y="${midY - 10}" width="${textLen}" height="18" rx="4" fill="#ffffff" stroke="${stroke}" stroke-width="1" filter="url(#drawio-shadow)"/>`);
      svgParts.push(`    <text x="${midX}" y="${midY}" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="600" fill="#1e293b">${escapeXml(cleanVal)}</text>`);
    }

    svgParts.push(`  </g>`);
  }

  svgParts.push(`</svg>`);
  return svgParts.join("\n");
  } catch {
    return "";
  }
}

export function isSvgCode(code: string, language?: string): boolean {
  if (!code || typeof code !== "string") return false;
  const lang = (language || "").trim().toLowerCase();
  if (lang === "svg" || lang === "drawio") return true;

  const trimmed = code.trim();

  // Draw.io XML format
  if (isDrawioXml(trimmed)) {
    return true;
  }

  // Check if it's xml or html containing an <svg element
  if (lang === "xml" || lang === "html" || lang === "" || lang === "bash") {
    if (/<svg[\s>]/i.test(trimmed) && /<\/svg>/i.test(trimmed)) {
      return true;
    }
  }

  // Any code that starts with <svg ... or <?xml ... <svg ...
  if (/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(trimmed) && /<\/svg>/i.test(trimmed)) {
    return true;
  }

  return false;
}

export function sanitizeSvg(svgString: string): string {
  if (!svgString || typeof svgString !== "string") return "";

  let cleaned = svgString.trim();

  // If the input is Draw.io XML, convert it to SVG first
  if (isDrawioXml(cleaned) && !/<svg[\s>]/i.test(cleaned)) {
    cleaned = convertDrawioToSvg(cleaned);
  }

  // Pre-strip <script> tags to avoid DOM parser quirks across test and runtime engines
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  cleaned = cleaned.replace(/<script\b[^>]*\/>/gi, "");

  const purifier = getPurifier();
  if (purifier && typeof purifier.sanitize === "function") {
    try {
      const sanitized = purifier.sanitize(cleaned, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["foreignObject", "script", "iframe", "object", "embed"],
        FORBID_ATTR: [
          "onbegin", "onend", "onrepeat",
          "onload", "onerror", "onclick", "onmouseover", "onfocus", "onblur"
        ],
        ADD_TAGS: [
          "svg", "g", "defs", "marker", "filter", "feDropShadow",
          "feGaussianBlur", "feOffset", "feBlend", "feMerge", "feMergeNode",
          "rect", "path", "circle", "ellipse", "line", "polyline",
          "polygon", "text", "tspan", "title", "desc", "use",
          "linearGradient", "radialGradient", "stop", "style", "pattern",
          "clipPath", "mask", "symbol", "image"
        ],
        ADD_ATTR: [
          "viewBox", "xmlns", "xmlns:xlink", "version", "width", "height",
          "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap",
          "stroke-linejoin", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy",
          "r", "rx", "ry", "points", "font-family", "font-size", "font-weight",
          "text-anchor", "transform", "opacity", "fill-opacity", "stroke-opacity",
          "offset", "stop-color", "stop-opacity", "id", "class", "style",
          "marker-end", "marker-start", "marker-mid", "refX", "refY",
          "markerWidth", "markerHeight", "orient", "patternUnits", "gradientUnits",
          "clip-path", "mask"
        ],
        RETURN_TRUSTED_TYPE: false
      });
      if (sanitized && sanitized.trim().length > 0) {
        return sanitized.trim();
      }
    } catch (err) {
      console.warn("[sanitizeSvg] DOMPurify sanitize warning, using fallback:", err);
    }
  }

  // Fallback regex sanitizer if DOMPurify is not available or returned empty
  cleaned = cleaned.replace(/<foreignObject\b[^<]*(?:(?!<\/foreignObject>)<[^<]*)*<\/foreignObject>/gi, "");
  cleaned = cleaned.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  cleaned = cleaned.replace(/(href|xlink:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, "$1=\"#\"");
  cleaned = cleaned.replace(/(href|xlink:href|src)\s*=\s*(?:"data:text\/html[^"]*"|'data:text\/html[^']*')/gi, "$1=\"#\"");
  return cleaned.trim();
}

export function wrapRawSvgInMarkdown(content: string): string {
  if (!content || typeof content !== "string") return "";

  // Split by code fences ```...```
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts
    .map((part) => {
      if (part.startsWith("```")) {
        return part;
      }

      // In non-code-fence text, wrap raw SVG
      let text = part.replace(
        /((?:<\?xml\b[^>]*\?>\s*)?(?:<!DOCTYPE\b[^>]*>\s*)?<svg\b[^>]*>[\s\S]*?<\/svg>)/gi,
        (match) => `\n\`\`\`svg\n${match.trim()}\n\`\`\`\n`
      );

      // Wrap raw <mxfile> ... </mxfile> or <mxGraphModel> ... </mxGraphModel> if present outside code fences
      text = text.replace(
        /(<(?:mxfile|mxGraphModel|diagram)\b[\s\S]*?<\/(?:mxfile|mxGraphModel|diagram)>)/gi,
        (match) => `\n\`\`\`xml\n${match.trim()}\n\`\`\`\n`
      );

      return text;
    })
    .join("");
}

export function isSvgFilePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  // Strip query parameters and hash
  const cleanPath = filePath.split("?")[0].split("#")[0].trim().toLowerCase();
  return (
    cleanPath.endsWith(".svg") ||
    cleanPath.endsWith(".drawio") ||
    cleanPath.endsWith(".drawio.xml")
  );
}

export function resolveSvgUrl(src: string): string {
  if (!src || typeof src !== "string") return "";
  const trimmed = src.trim();

  // If data URI or http/https or already /api/ route, return as-is
  if (
    trimmed.startsWith("data:") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("/api/")
  ) {
    return trimmed;
  }

  // Strip leading slash or relative prefix
  const clean = trimmed.replace(/^\.?\//, "");
  return `/api/files?path=${encodeURIComponent(clean)}`;
}

export interface ExtractedSvgItem {
  id: string;
  title: string;
  code?: string;
  url?: string;
  isDrawio?: boolean;
}

/**
 * Extracts all SVG and Draw.io diagrams generated or retrieved by tool traces in a chat message.
 */
export function extractSvgsFromMessage(message: {
  id: string;
  content: string;
  traces?: Array<{
    tool: string;
    args?: Record<string, any>;
    result?: any;
  }>;
}): ExtractedSvgItem[] {
  const svgs: ExtractedSvgItem[] = [];
  const seenKeys = new Set<string>();

  if (!message.traces || !Array.isArray(message.traces)) {
    return svgs;
  }

  for (let i = 0; i < message.traces.length; i++) {
    const trace = message.traces[i];
    const pathArg = (trace.args?.path || trace.args?.file || trace.args?.filename || "") as string;
    const contentArg = (trace.args?.content || trace.args?.code || "") as string;
    const isPathSvg = pathArg ? isSvgFilePath(pathArg) : false;

    // Check stdout / result output
    let stdoutSvg = "";
    try {
      if (trace.result?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(trace.result.content[0].text);
          stdoutSvg = parsed.content || parsed.stdout || parsed.output || (typeof parsed === "string" ? parsed : "");
        } catch {
          stdoutSvg = trace.result.content[0].text;
        }
      } else if (typeof trace.result === "string") {
        stdoutSvg = trace.result;
      }
    } catch {
      stdoutSvg = "";
    }

    if (stdoutSvg && (stdoutSvg.includes("<svg") || isSvgCode(stdoutSvg))) {
      if (/^\s*\d+\s*\|/m.test(stdoutSvg)) {
        stdoutSvg = stdoutSvg.replace(/^\s*\d+\s*\|\s*/gm, "");
      }
    } else {
      stdoutSvg = "";
    }

    let code: string | undefined = undefined;
    if (contentArg && (isSvgCode(contentArg) || isPathSvg)) {
      code = contentArg;
    } else if (stdoutSvg && isSvgCode(stdoutSvg)) {
      code = stdoutSvg;
    }

    if (code || isPathSvg) {
      const title = pathArg ? pathArg.split(/[/\\]/).pop() || pathArg : `${trace.tool} Vector Graphic`;
      const key = pathArg || (code ? code.slice(0, 100) : `trace-${i}`);

      const alreadyInContent = code && code.length > 30 && message.content.includes(code.slice(0, 50));

      if (!seenKeys.has(key) && !alreadyInContent) {
        seenKeys.add(key);
        if (pathArg) seenKeys.add(pathArg);
        if (code) seenKeys.add(code.slice(0, 100));

        svgs.push({
          id: `${message.id}-trace-${i}`,
          title: title || "Vector Graphic",
          code,
          url: pathArg ? resolveSvgUrl(pathArg) : undefined,
          isDrawio: isDrawioXml(code || "") || (pathArg ? pathArg.includes(".drawio") : false)
        });
      }
    }
  }

  return svgs;
}
