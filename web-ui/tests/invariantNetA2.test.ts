import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WEB_UI_ROOT = path.resolve(__dirname, "..");
const chatStreamSrc = fs.readFileSync(path.join(WEB_UI_ROOT, "components", "ChatStream.tsx"), "utf8");
const drawerSrc = fs.readFileSync(path.join(WEB_UI_ROOT, "components", "NavigationDrawer.tsx"), "utf8");

interface DeckControlParityRow {
  control: string;
  queuePattern: RegExp;
  steerPattern: RegExp;
  excuse?: string;
}

const DECK_PARITY_TABLE: DeckControlParityRow[] = [
  {
    control: "per-chip remove",
    queuePattern: /aria-label=\{`Remove queued item \$\{idx \+ 1\}`\}/,
    steerPattern: /aria-label=\{`Remove steer item \$\{idx \+ 1\}`\}/,
  },
  {
    control: "Clear all",
    queuePattern: /data-testid="chat-queue-clear-all"[\s\S]*?Clear all/,
    steerPattern: /data-testid="chat-steer-clear-all"[\s\S]*?Clear all/,
  },
];

test("Phase A2 — Queue deck vs Steer deck parity table", () => {
  for (const row of DECK_PARITY_TABLE) {
    const hasQueue = row.queuePattern.test(chatStreamSrc);
    const hasSteer = row.steerPattern.test(chatStreamSrc);
    if (row.excuse) continue;
    assert.equal(
      hasQueue,
      true,
      `Queue deck missing control "${row.control}"`
    );
    assert.equal(
      hasSteer,
      true,
      `Steer deck missing control "${row.control}"`
    );
  }
});

interface NavParityRow {
  destination: string;
  drawerPattern: RegExp;
  desktopPattern: RegExp;
  excuse?: string;
}

const NAV_PARITY_TABLE: NavParityRow[] = [
  {
    destination: "sessions",
    drawerPattern: /onNavigate\("sessions"\)/,
    desktopPattern: /setActiveView\("sessions"\)|onNavigate\("sessions"\)|"sessions"/,
  },
  {
    destination: "board",
    drawerPattern: /onNavigate\("board"\)/,
    desktopPattern: /Board|setActiveView\("board"\)|"board"/,
  },
  {
    destination: "projects",
    drawerPattern: /onNavigate\("projects"\)/,
    desktopPattern: /Open Projects|setActiveView\("projects"\)/,
  },
  {
    destination: "builds",
    drawerPattern: /onNavigate\("builds"\)/,
    desktopPattern: /Builds|setActiveView\("builds"\)/,
  },
  {
    destination: "morning-report",
    drawerPattern: /onNavigate\("morning-report"\)/,
    desktopPattern: /Morning Report|morning-report/,
    excuse: "Desktop accesses Morning Report via NavigationDrawer or /morning-report route",
  },
  {
    destination: "skills",
    drawerPattern: /onNavigate\("skills"\)/,
    desktopPattern: /Skills|setActiveView\("skills"\)/,
    excuse: "Desktop accesses Skills via NavigationDrawer",
  },
  {
    destination: "settings",
    drawerPattern: /onNavigate\("settings"\)/,
    desktopPattern: /Settings|setShowSettings|setActiveView\("settings"\)/,
  },
  {
    destination: "security",
    drawerPattern: /onNavigate\("security"\)/,
    desktopPattern: /Security|Traces|setActiveView\("security"\)/,
    excuse: "Security/Traces is accessed via Settings/Traces",
  },
];

test("Phase A2 — Mobile drawer nav vs Desktop nav destination parity table", () => {
  for (const row of NAV_PARITY_TABLE) {
    const inDrawer = row.drawerPattern.test(drawerSrc);
    const inDesktop = row.desktopPattern.test(chatStreamSrc);
    if (row.excuse) continue;
    assert.equal(
      inDrawer,
      true,
      `Mobile NavigationDrawer missing destination "${row.destination}"`
    );
    assert.equal(
      inDesktop,
      true,
      `Desktop ChatStream nav missing destination "${row.destination}"`
    );
  }
});
