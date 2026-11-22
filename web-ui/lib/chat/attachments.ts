export interface AttachedFileItem {
  id: string;
  name: string;
  type: string;
  size: number;
  previewUrl?: string;
  base64: string;
  isImage: boolean;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    // Check if raster image that benefits from high-performance client-side scaling
    if (
      file.type.startsWith("image/") &&
      !file.type.includes("svg") &&
      typeof window !== "undefined"
    ) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const rawUrl = e.target?.result as string;
        if (!rawUrl) {
          resolve("");
          return;
        }
        const img = new Image();
        img.onload = () => {
          const MAX_DIM = 1600;
          let { width, height } = img;
          if (width > MAX_DIM || height > MAX_DIM) {
            if (width > height) {
              height = Math.round((height * MAX_DIM) / width);
              width = MAX_DIM;
            } else {
              width = Math.round((width * MAX_DIM) / height);
              height = MAX_DIM;
            }
          } else {
            resolve(rawUrl);
            return;
          }

          try {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(img, 0, 0, width, height);
              resolve(canvas.toDataURL("image/jpeg", 0.88));
              return;
            }
          } catch {
            // fallback to original if canvas fails
          }
          resolve(rawUrl);
        };
        img.onerror = () => resolve(rawUrl);
        img.src = rawUrl;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }

    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
}

export function buildAttachedFileItem(params: {
  id: string;
  name: string;
  type: string;
  size: number;
  base64: string;
}): AttachedFileItem {
  const isImage = params.type.startsWith("image/");
  return {
    id: params.id,
    name: params.name,
    type: params.type || "application/octet-stream",
    size: params.size,
    previewUrl: isImage ? params.base64 : undefined,
    base64: params.base64,
    isImage,
  };
}
