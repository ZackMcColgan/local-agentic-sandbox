import { test, expect, Route } from "@playwright/test";
import { setupStubbedEngineRoutes } from "./helpers/mockEngine";

/**
 * Board #59: single-emerald accent + dark-mode contrast floor audit.
 * Renders Settings, Board, and Chat at 412px dark mobile and asserts:
 *   1. Zero banned accent color classes (cyan/sky/teal/blue/indigo/violet/purple).
 *   2. Danger Zone heading and disabled engine controls clear the zinc-400
 *      contrast floor on #000 (zinc-400 on #000 = 8.24 contrast).
 */

const MOBILE_412 = { width: 412, height: 915 };

// Contrast of zinc-400 (#a1a1aa) on #000 — the standing dark-mode text floor.
const DARK_TEXT_FLOOR = 8.2;

const BANNED_ACCENT =
  /(?:^|[^a-z0-9-])(?:text|bg|border|ring|ring-offset|from|to|via|fill|stroke|divide|shadow|hover:bg|dark:hover:bg|focus:bg|focus:ring|active:bg)-(?:cyan|sky|teal|blue|indigo|violet|purple)-\d{2,3}\b/;

async function stubSettingsRoutes(page: import("@playwright/test").Page): Promise<void> {
  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/settings/host**", (route) =>
    json(route, { enabled: false, allowlisted: false, lastRun: null })
  );
  await page.route("**/api/settings/memory**", (route) =>
    json(route, { content: "", updatedAt: null })
  );
  await page.route("**/api/settings/notifications**", (route) =>
    json(route, { configured: false, enabled: false, reason: "missing_credentials" })
  );
  await page.route("**/api/settings/self-deploy**", (route) =>
    json(route, { active: false, enabled: false })
  );
}

async function scanBannedAccents(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate((source: string) => {
    const re = new RegExp(source, "g");
    const hits: string[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const cls = typeof el.className === "string" ? el.className : "";
      if (cls && re.test(cls)) {
        re.lastIndex = 0;
        const m = cls.match(re);
        hits.push(`${el.tagName}.${cls.slice(0, 80)} -> ${m?.join(", ")}`);
        re.lastIndex = 0;
      }
    }
    return hits;
  }, BANNED_ACCENT.source);
}

async function openDark412(
  page: import("@playwright/test").Page,
  view: "settings" | "board" | "sessions"
): Promise<void> {
  await page.setViewportSize(MOBILE_412);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/?drawer=open");
  await expect(page.locator('[data-testid="navigation-drawer"]')).toBeVisible();
  const label = view === "sessions" ? "New session" : view === "board" ? "Board" : "Settings";
  await page.locator(`[data-testid="navigation-drawer"] button:has-text("${label}")`).first().click();
  await expect(page.locator("body")).toBeVisible();
}

test.describe("Board #59: 412px dark render audit", () => {
  test("settings view has zero banned accent classes", async ({ page }) => {
    await setupStubbedEngineRoutes(page, { engineRunning: true });
    await stubSettingsRoutes(page);
    await openDark412(page, "settings");
    const hits = await scanBannedAccents(page);
    expect(hits, `banned accents found:\n${hits.join("\n")}`).toEqual([]);
  });

  test("board view has zero banned accent classes", async ({ page }) => {
    await setupStubbedEngineRoutes(page, { engineRunning: true });
    await openDark412(page, "board");
    const hits = await scanBannedAccents(page);
    expect(hits, `banned accents found:\n${hits.join("\n")}`).toEqual([]);
  });

  test("chat view has zero banned accent classes", async ({ page }) => {
    await setupStubbedEngineRoutes(page, { engineRunning: true });
    await openDark412(page, "sessions");
    const hits = await scanBannedAccents(page);
    expect(hits, `banned accents found:\n${hits.join("\n")}`).toEqual([]);
  });

  test("danger zone heading clears the zinc-400 contrast floor on #000", async ({ page }) => {
    await setupStubbedEngineRoutes(page, { engineRunning: false });
    await stubSettingsRoutes(page);
    await openDark412(page, "settings");
    const heading = page.locator("#settings-danger-zone h2").first();
    await expect(heading).toBeVisible();
    const result = await heading.evaluate((el: HTMLElement) => {
      const lum = (rgb: string) => {
        const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return 0;
        const lin = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3]);
      };
      const cs = getComputedStyle(el);
      const bg = getComputedStyle(document.body).backgroundColor;
      const la = lum(cs.color);
      const lb = lum(bg);
      const ratio = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
      return { color: cs.color, bg, ratio };
    });
    // Body is #000 in dark mode; heading text must clear the floor.
    expect(result.bg).toBe("rgb(0, 0, 0)");


    expect(result.ratio).toBeGreaterThanOrEqual(DARK_TEXT_FLOOR);
  });

  test("disabled engine controls clear the contrast floor on #000", async ({ page }) => {
    await setupStubbedEngineRoutes(page, { engineRunning: true });
    await stubSettingsRoutes(page);
    await openDark412(page, "settings");
    const start = page.locator('button[aria-label="Start llama-server"]').first();
    await expect(start).toBeVisible();
    await expect(start).toBeDisabled();
    // transition-all animates the disabled-state background; let it settle before measuring.
    await page.waitForTimeout(400);
    const result = await start.evaluate((el: HTMLElement) => {
      const lum = (rgb: string) => {
        const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return 0;
        const lin = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3]);
      };
      const cs = getComputedStyle(el);

      const la = lum(cs.color);
      const lb = lum(cs.backgroundColor);
      return { color: cs.color, bg: cs.backgroundColor, ratio: (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05) };
    });


    expect(result.ratio).toBeGreaterThanOrEqual(DARK_TEXT_FLOOR);
  });
});



