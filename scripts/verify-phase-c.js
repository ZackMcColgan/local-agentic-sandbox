/**
 * Phase C Behavioral Acceptance Experiments 1–5
 * Antigravity Order: Full Gambit Overnight — Phase C Tier 1 user_profile.json
 */
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import assert from "node:assert/strict";

const tsxCmd = path.resolve("web-ui/node_modules/.bin/tsx.cmd");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-c-exp-"));
const profilePath = path.join(tempDir, "user_profile.json");
process.env.USER_PROFILE_PATH = profilePath;

const profileModulePath = path.resolve("web-ui/lib/memory/profile.ts").replace(/\\/g, "/");

function runSnippet(code, env = {}) {
  const runnerFile = path.resolve(`.runner_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(runnerFile, code, "utf8");
  try {
    const out = execSync(`"${tsxCmd}" "${runnerFile}"`, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      encoding: "utf8"
    });
    return out;
  } finally {
    if (fs.existsSync(runnerFile)) {
      try { fs.unlinkSync(runnerFile); } catch (_) {}
    }
  }
}

console.log("[Phase C] Running Behavioral Acceptance Experiments 1–5...");
console.log(`[Phase C] Using temporary profile: ${profilePath}`);

// Experiment 1: Two-session memory
// Session A: user states "only call me Zack" -> recorded
// Session B: new process, same profile -> loads "Zack" unprompted
console.log("\n--- Experiment 1: Two-session memory across isolated processes ---");
const sessionA_Id = "session_A_" + Date.now();
const sessionA_Code = `
import { extractDurablePreferences, recordProfileEntry } from "${profileModulePath}";
const extracted = extractDurablePreferences("Hello, please only call me Zack from now on.", "${sessionA_Id}");
for (const pref of extracted) {
  recordProfileEntry(pref.key, pref.value, { sessionId: "${sessionA_Id}", origin: pref.origin });
}
`;
runSnippet(sessionA_Code, { USER_PROFILE_PATH: profilePath });

// Session B in a completely separate process
const sessionB_Id = "session_B_" + Date.now();
const sessionB_Code = `
import { loadUserProfile, formatProfileForContext } from "${profileModulePath}";
const profile = loadUserProfile();
if (profile.entries["preferred_name"]?.value !== "Zack") {
  console.error("Session B failed to find preferred_name Zack");
  process.exit(1);
}
const context = formatProfileForContext(profile);
if (!context.includes("Always address the user as 'Zack'")) {
  console.error("Session B context does not include Zack");
  process.exit(1);
}
console.log("Session B unprompted memory context verified:", context.trim());
`;
const outB = runSnippet(sessionB_Code, { USER_PROFILE_PATH: profilePath });
console.log(outB.trim());
console.log("✅ Experiment 1 PASSED: Two-session memory retained across isolated processes.");

// Experiment 2: Negative recording (pure chatter session -> profile byte-identical)
console.log("\n--- Experiment 2: Negative recording on chatter ---");
const bytesBefore = fs.readFileSync(profilePath, "utf8");
const chatterQueries = [
  "What is the weather in Seattle?",
  "Tell me a funny joke about Kubernetes",
  "Can you write a regex for email validation?",
  "Thanks, that was very helpful!",
  "npm run build"
];
for (const q of chatterQueries) {
  const chatterCode = `
import { extractDurablePreferences, recordProfileEntry } from "${profileModulePath}";
const extracted = extractDurablePreferences(${JSON.stringify(q)}, "chatter_session");
for (const pref of extracted) {
  recordProfileEntry(pref.key, pref.value, { sessionId: "chatter_session", origin: pref.origin });
}
`;
  runSnippet(chatterCode, { USER_PROFILE_PATH: profilePath });
}
const bytesAfter = fs.readFileSync(profilePath, "utf8");
assert.equal(bytesBefore, bytesAfter, "Profile file MUST remain byte-identical after pure chatter");
console.log("✅ Experiment 2 PASSED: Pure chatter produced 0 mutations; profile is byte-identical.");

// Experiment 3: Corruption resilience (garbage bytes in JSON -> starts, warns, behaves as empty, no crash)
console.log("\n--- Experiment 3: Corruption resilience ---");
const corruptProfilePath = path.join(tempDir, "corrupted_profile.json");
fs.writeFileSync(corruptProfilePath, "!!!MALFORMED_GARBAGE_JSON\x00\x01\x02{bad[syntax", "utf8");
const corruptTestCode = `
import { loadUserProfile, formatProfileForContext } from "${profileModulePath}";
const p = loadUserProfile();
if (p.version !== 1 || Object.keys(p.entries).length !== 0) {
  process.exit(1);
}
const ctx = formatProfileForContext(p);
if (ctx !== "") {
  process.exit(1);
}
console.log("Corrupted profile safely recovered to empty profile without crash.");
`;
const corruptOut = runSnippet(corruptTestCode, { USER_PROFILE_PATH: corruptProfilePath });
console.log(corruptOut.trim());
console.log("✅ Experiment 3 PASSED: Corrupted JSON gracefully handled without crash.");

// Experiment 4: Provenance verified (real ISO timestamp inside window, session id matches)
console.log("\n--- Experiment 4: Provenance verification ---");
const provProfilePath = path.join(tempDir, "provenance_profile.json");
const startWindow = new Date(Date.now() - 2000).toISOString();
const provSessionId = "sess_prov_" + Math.random().toString(36).slice(2);
const provCode = `
import { recordProfileEntry } from "${profileModulePath}";
recordProfileEntry("preferred_language", "typescript", { sessionId: "${provSessionId}", origin: "user-stated" });
`;
runSnippet(provCode, { USER_PROFILE_PATH: provProfilePath });
const endWindow = new Date(Date.now() + 2000).toISOString();
const loadedProv = JSON.parse(fs.readFileSync(provProfilePath, "utf8"));
const entry = loadedProv.entries["preferred_language"];
assert.ok(entry, "Entry must exist");
assert.equal(entry.sourceSessionId, provSessionId, "Session ID must match");
assert.equal(entry.origin, "user-stated", "Origin must be user-stated");
assert.ok(entry.timestamp >= startWindow && entry.timestamp <= endWindow, `Timestamp ${entry.timestamp} must be in window [${startWindow}, ${endWindow}]`);
console.log(`✅ Experiment 4 PASSED: Provenance verified (timestamp: ${entry.timestamp}, session: ${entry.sourceSessionId}).`);

// Experiment 5: Correction history (set P, correct to Q -> reads return Q, history retains P with timestamp)
console.log("\n--- Experiment 5: Correction tracking & history retention ---");
const corrProfilePath = path.join(tempDir, "correction_profile.json");
const pCode = `
import { recordProfileEntry } from "${profileModulePath}";
recordProfileEntry("preferred_name", "Zachary", { sessionId: "sess_p", origin: "user-stated" });
`;
runSnippet(pCode, { USER_PROFILE_PATH: corrProfilePath });

const qCode = `
import { recordProfileEntry } from "${profileModulePath}";
recordProfileEntry("preferred_name", "Zack", { sessionId: "sess_q", origin: "corrected" });
`;
runSnippet(qCode, { USER_PROFILE_PATH: corrProfilePath });

const corrLoaded = JSON.parse(fs.readFileSync(corrProfilePath, "utf8"));
const corrEntry = corrLoaded.entries["preferred_name"];
assert.equal(corrEntry.value, "Zack", "Current value must be Q ('Zack')");
assert.equal(corrEntry.origin, "corrected", "Current origin must be corrected");
assert.equal(corrEntry.sourceSessionId, "sess_q", "Current session ID must be sess_q");
assert.equal(corrEntry.history.length, 1, "History must retain prior value");
assert.equal(corrEntry.history[0].value, "Zachary", "History prior value must be P ('Zachary')");
assert.equal(corrEntry.history[0].sourceSessionId, "sess_p", "History sourceSessionId must be sess_p");
console.log(`✅ Experiment 5 PASSED: Current value 'Zack', prior value 'Zachary' preserved in history.`);

// Cleanup
fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\n=======================================================");
console.log("✅ ALL PHASE C BEHAVIORAL ACCEPTANCE EXPERIMENTS PASSED");
console.log("=======================================================\n");
