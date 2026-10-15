/**
 * Robust clipboard copy utility.
 *
 * In secure contexts (HTTPS or localhost), uses `navigator.clipboard.writeText(text)`.
 * In non-secure contexts (such as LAN HTTP like http://192.168.50.254/) or when
 * clipboard permissions are denied/throw, falls back to a hidden textarea with
 * `document.execCommand('copy')`.
 *
 * Returns true if the copy succeeded, false otherwise.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  // 1. Try modern navigator.clipboard if available
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to textarea execCommand fallback
    }
  }

  // 2. Fallback via hidden textarea and document.execCommand('copy')
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    // Avoid scrolling, shifting layout, or triggering virtual keyboards
    textArea.style.position = "fixed";
    textArea.style.top = "-9999px";
    textArea.style.left = "-9999px";
    textArea.style.opacity = "0";
    textArea.setAttribute("readonly", "");
    document.body.appendChild(textArea);
    if (typeof textArea.focus === "function") {
      textArea.focus();
    }
    textArea.select();
    textArea.setSelectionRange(0, text.length);

    const successful = document.execCommand("copy");
    document.body.removeChild(textArea);
    return Boolean(successful);
  } catch {
    return false;
  }
}
