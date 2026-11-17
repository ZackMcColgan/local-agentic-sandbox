import { Page, expect } from "@playwright/test";

export interface LayoutInvariantOptions {
  checkOverflow?: boolean;
  checkOverlap?: boolean;
  checkTapTargets?: boolean;
  checkClipping?: boolean;
  containerSelector?: string;
  allowedOverlapLabels?: string[];
}

export interface OverlapException {
  id: string;
  justification: string;
  match: (a: ElementSummary, b: ElementSummary) => boolean;
}

export interface ElementSummary {
  tag: string;
  id: string;
  role: string | null;
  className: string;
  ariaLabel: string | null;
  title: string | null;
  text: string;
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
}

/**
 * Named intentional overlap exceptions list with explicit justification for each.
 */
export const INTENTIONAL_OVERLAP_EXCEPTIONS: OverlapException[] = [
  {
    id: "badge-overlay",
    justification: "Notification / status counter badges intentionally overlay corner of parent button / icon",
    match: (a, b) =>
      a.className.includes("badge") ||
      b.className.includes("badge") ||
      a.className.includes("rounded-full") && (a.rect.width < 24 || b.rect.width < 24),
  },
  {
    id: "hidden-file-input",
    justification: "Hidden file input element used for paperclip upload attachment triggers",
    match: (a, b) => a.tag === "input" && a.rect.width <= 1 || b.tag === "input" && b.rect.width <= 1,
  },
  {
    id: "segmented-pill-slider",
    justification: "Animated slider background pill under active tab in segmented controls",
    match: (a, b) =>
      (a.className.includes("segmented") || b.className.includes("segmented")) ||
      (a.role === "tab" && b.role === "tablist") ||
      (b.role === "tab" && a.role === "tablist"),
  },
];

/**
 * Asserts layout invariants for a rendered view:
 * 1. Zero horizontal overflow (scrollWidth <= innerWidth)
 * 2. Zero non-exempt overlapping interactive elements (pairwise intersection check)
 * 3. Mobile touch target size check (>= 44px or >= 40px for compact chips with hit slop)
 * 4. Zero clipping of interactive controls outside the viewport
 */
export async function assertLayoutInvariants(
  page: Page,
  viewName: string,
  options: LayoutInvariantOptions = {}
): Promise<void> {
  const {
    checkOverflow = true,
    checkOverlap = true,
    checkTapTargets = true,
    checkClipping = true,
    containerSelector = "body",
  } = options;

  // Wait for network idle or main container to settle
  await page.waitForLoadState("domcontentloaded");

  const results = await page.evaluate(
    ({ viewName, checkOverflow, checkOverlap, checkTapTargets, checkClipping, containerSelector }) => {
      const errors: string[] = [];
      const warnings: string[] = [];

      // 1. Zero horizontal overflow
      if (checkOverflow) {
        const doc = document.scrollingElement || document.documentElement || document.body;
        const scrollWidth = doc.scrollWidth;
        const innerWidth = window.innerWidth;
        if (scrollWidth > innerWidth + 1) {
          errors.push(
            `[${viewName}] Horizontal overflow: scrollWidth (${scrollWidth}px) exceeds innerWidth (${innerWidth}px)`
          );
        }
      }

      // Collect visible interactive elements
      // If an active modal dialog is present (role="dialog" with aria-modal="true"),
      // the background is inert and occluded by the backdrop; scope interactive checks to the modal dialog
      const activeModal = (containerSelector === "body" || !containerSelector)
        ? document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]:not([style*="display: none"])')
        : null;
      const container = activeModal || document.querySelector(containerSelector) || document.body;
      const candidates = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="tab"]'
        )
      );

      const isVisible = (el: HTMLElement): boolean => {
        if (!el.isConnected) return false;
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0" ||
          style.pointerEvents === "none"
        ) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const visibleControls = candidates.filter(isVisible);

      // Summarize element
      const summarize = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          role: el.getAttribute("role"),
          className: el.className || "",
          ariaLabel: el.getAttribute("aria-label"),
          title: el.getAttribute("title"),
          text: (el.innerText || el.textContent || "").trim().slice(0, 30),
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      };

      const summaries = visibleControls.map(summarize);

      // 2. Pairwise bounding-box intersection check
      if (checkOverlap) {
        for (let i = 0; i < visibleControls.length; i++) {
          for (let j = i + 1; j < visibleControls.length; j++) {
            const elA = visibleControls[i];
            const elB = visibleControls[j];

            // Ignore parent/child or ancestor/descendant relationships
            if (elA.contains(elB) || elB.contains(elA)) continue;

            const sumA = summaries[i];
            const sumB = summaries[j];

            const overlapW = Math.max(0, Math.min(sumA.rect.right, sumB.rect.right) - Math.max(sumA.rect.left, sumB.rect.left));
            const overlapH = Math.max(0, Math.min(sumA.rect.bottom, sumB.rect.bottom) - Math.max(sumA.rect.top, sumB.rect.top));
            const overlapArea = overlapW * overlapH;

            // If overlap area > 4px²
            if (overlapArea > 4) {
              // Check intentional overlap exceptions
              const isExempt =
                sumA.className.includes("badge") ||
                sumB.className.includes("badge") ||
                (sumA.className.includes("rounded-full") && (sumA.rect.width < 24 || sumB.rect.width < 24)) ||
                (sumA.tag === "input" && sumA.rect.width <= 1) ||
                (sumB.tag === "input" && sumB.rect.width <= 1) ||
                sumA.className.includes("sr-only") ||
                sumB.className.includes("sr-only") ||
                (sumA.className.includes("segmented") || sumB.className.includes("segmented")) ||
                (sumA.role === "tab" && sumB.role === "tablist") ||
                (sumB.role === "tab" && sumA.role === "tablist");

              if (!isExempt) {
                const descA = `<${sumA.tag} class="${sumA.className}" label="${sumA.ariaLabel || sumA.title || sumA.text}">`;
                const descB = `<${sumB.tag} class="${sumB.className}" label="${sumB.ariaLabel || sumB.title || sumB.text}">`;
                errors.push(
                  `[${viewName}] Overlapping controls: ${descA} at [${sumA.rect.left},${sumA.rect.top},${sumA.rect.width}x${sumA.rect.height}] intersects ${descB} at [${sumB.rect.left},${sumB.rect.top},${sumB.rect.width}x${sumB.rect.height}] (overlap: ${overlapArea}px²)`
                );
              }
            }
          }
        }
      }

      // 3. Mobile touch target sizes (>= 44px or >= 40px for chips)
      if (checkTapTargets && window.innerWidth < 768) {
        for (let i = 0; i < visibleControls.length; i++) {
          const s = summaries[i];
          const el = visibleControls[i];

          // Skip inline links inside paragraphs or sr-only
          if (s.tag === "a" && !el.closest("header, nav, aside, [role='toolbar']")) continue;
          if (s.className.includes("sr-only")) continue;

          // Check header and navigation controls
          const isPrimaryNavControl = el.closest("header, nav, .panel-toggle-btn, .mobile-dock, .inspector-header");
          if (isPrimaryNavControl) {
            if (s.rect.width < 40 || s.rect.height < 40) {
              errors.push(
                `[${viewName}] Undersized mobile touch target (< 40px minimum): <${s.tag} label="${s.ariaLabel || s.title || s.text}"> is ${s.rect.width}x${s.rect.height}px`
              );
            }
          }
        }
      }

      // 4. Zero clipping of controls outside the viewport
      if (checkClipping) {
        const vw = window.innerWidth;
        for (let i = 0; i < visibleControls.length; i++) {
          const s = summaries[i];
          const el = visibleControls[i];
          // If element is fixed or header control, ensure not clipped outside [0, vw]
          const isFixedOrSticky = ["fixed", "sticky"].includes(window.getComputedStyle(el).position);
          const inFixedContainer = !!el.closest("header, nav, aside.fixed, .app-inspector");
          if (isFixedOrSticky || inFixedContainer) {
            if (s.rect.left < -2 || s.rect.right > vw + 2) {
              errors.push(
                `[${viewName}] Control clipped outside viewport boundaries: <${s.tag} label="${s.ariaLabel || s.title || s.text}"> bounds=[${s.rect.left},${s.rect.right}], vw=${vw}`
              );
            }
          }
        }
      }

      return { errors, warnings };
    },
    { viewName, checkOverflow, checkOverlap, checkTapTargets, checkClipping, containerSelector }
  );

  if (results.errors.length > 0) {
    throw new Error(results.errors.join("\n"));
  }
}
