export interface ParsedAttachment {
  name: string;
  type: string;
  size: number;
  isImage?: boolean;
  rawBase64?: string;
  textContent?: string;
}

export async function parseAttachment(
  name: string,
  type: string,
  size: number,
  base64Data: string
): Promise<ParsedAttachment> {
  const isImage = type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(name);

  // If Image: extract raw base64 for vision models
  if (isImage) {
    const rawBase64 = base64Data.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");
    return {
      name,
      type,
      size,
      isImage: true,
      rawBase64,
    };
  }

  const cleanBase64 = base64Data.replace(/^data:[a-zA-Z0-9\/-]+;base64,/, "");
  const buffer = Buffer.from(cleanBase64, "base64");

  // If PDF
  if (type === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    try {
      const pdfModule = await import("pdf-parse");
      if (typeof pdfModule === "function") {
        const data = await (pdfModule as unknown as (buf: Buffer) => Promise<{ text: string }>)(
          buffer
        );
        return {
          name,
          type,
          size,
          textContent: data.text,
        };
      } else if (pdfModule.PDFParse) {
        const ParserCtor = pdfModule.PDFParse as unknown as new (opts: { data: Buffer }) => {
          load: () => Promise<void>;
          getText: () => Promise<string>;
        };
        const parser = new ParserCtor({ data: buffer });
        await parser.load();
        const text = await parser.getText();
        return {
          name,
          type,
          size,
          textContent: text,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[FileParser] Error parsing PDF ${name}:`, msg);
      return {
        name,
        type,
        size,
        textContent: `[Error reading PDF ${name}: ${msg}]`,
      };
    }
  }

  // If Word Document (.docx)
  if (
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.toLowerCase().endsWith(".docx")
  ) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return {
        name,
        type,
        size,
        textContent: result.value,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[FileParser] Error parsing DOCX ${name}:`, msg);
      return {
        name,
        type,
        size,
        textContent: `[Error reading DOCX ${name}: ${msg}]`,
      };
    }
  }

  // Default: Plain text, code, JSON, Markdown, CSV, logs
  try {
    const textContent = buffer.toString("utf-8");
    return {
      name,
      type,
      size,
      textContent,
    };
  } catch {
    return {
      name,
      type,
      size,
      textContent: `[Binary document ${name} attached]`,
    };
  }
}
