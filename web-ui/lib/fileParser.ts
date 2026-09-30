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
  const isImage =
    type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(name);

  // If Image: extract raw base64 for vision models
  if (isImage) {
    const rawBase64 = base64Data.replace(/^data:image\/[a-zA-Z+]+;base64,/, "");
    return {
      name,
      type,
      size,
      isImage: true,
      rawBase64
    };
  }

  const cleanBase64 = base64Data.replace(/^data:[a-zA-Z0-9\/-]+;base64,/, "");
  const buffer = Buffer.from(cleanBase64, "base64");

  // If PDF
  if (type === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    try {
      const pdfModule = await import("pdf-parse");
      if (typeof pdfModule === "function") {
        const data = await (pdfModule as any)(buffer);
        return {
          name,
          type,
          size,
          textContent: data.text
        };
      } else if (pdfModule.PDFParse) {
        const parser = new (pdfModule.PDFParse as any)({ data: buffer });
        await parser.load();
        const text = await parser.getText();
        return {
          name,
          type,
          size,
          textContent: text
        };
      }
    } catch (err: any) {
      console.warn(`[FileParser] Error parsing PDF ${name}:`, err.message);
      return {
        name,
        type,
        size,
        textContent: `[Error reading PDF ${name}: ${err.message}]`
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
        textContent: result.value
      };
    } catch (err: any) {
      console.warn(`[FileParser] Error parsing DOCX ${name}:`, err.message);
      return {
        name,
        type,
        size,
        textContent: `[Error reading DOCX ${name}: ${err.message}]`
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
      textContent
    };
  } catch {
    return {
      name,
      type,
      size,
      textContent: `[Binary document ${name} attached]`
    };
  }
}
