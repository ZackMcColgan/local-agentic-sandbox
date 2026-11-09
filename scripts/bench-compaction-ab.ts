import { chromium, Browser, Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  checkEngineWatchdog,
  createFreshSession,
  sendPrompt,
  awaitTurnCompletion,
  getCurrentPodRestartCount,
  DEADLINES
} from "../web-ui/tests/e2e-live/helpers.js";

const BASE_URL = process.env.PLAYWRIGHT_LIVE_BASE_URL || "http://192.168.50.254";
const RESULTS_FILE = path.resolve(process.cwd(), "docs/compaction-ab-results.json");
const SCRATCH_DIR = "C:\\AI\\scratch";

export interface BenchmarkProbeResult {
  name: string;
  factType: string;
  expected: string;
  actual: string;
  passed: boolean;
  notes?: string;
}

export interface WorkloadRunRecord {
  runId: string;
  workload: "W1" | "W2" | "W3";
  arm: "A" | "B";
  runNumber: number;
  timestamp: string;
  threadId: string;
  deployedImage: string;
  tokensBefore: number;
  tokensAfter: number;
  retainedRatio: number;
  compactingTurnDurationSec: number;
  totalDurationSec: number;
  escalationFired?: boolean;
  summaryGenerationDurationSec?: number;
  fallbackEvents?: string[];
  digest: string;
  probes: BenchmarkProbeResult[];
  hallucinations: string[];
  podRestartsInitial: number;
  podRestartsFinal: number;
}

function getDeployedImageTag(): string {
  try {
    const out = execSync(
      'kubectl get pod -l app=web-ui -n local-agentic-sandbox -o jsonpath="{.items[0].spec.containers[0].image}"',
      { encoding: "utf8" }
    ).trim();
    return out;
  } catch {
    return "unknown";
  }
}

async function getInAppContextCounter(page: Page): Promise<string> {
  try {
    const pill = page.locator('[data-testid="context-meter-pill"]').first();
    await pill.waitFor({ state: "visible", timeout: 15000 });
    const text = (await pill.innerText()).trim();
    const title = (await pill.getAttribute("title")) || "";
    return `${text} [${title}]`;
  } catch {
    return "unknown";
  }
}

async function getCompactionNoteTokens(page: Page): Promise<{ before: number; after: number; text: string }> {
  try {
    const note = page.locator('[data-testid="compaction-turn-note"]').last();
    await note.waitFor({ state: "visible", timeout: 15000 });
    const text = (await note.innerText()).trim();
    // Format: "History compacted: 100,026 → 54,358 tokens"
    const match = text.match(/([\d,]+)\s*(?:→|->)\s*([\d,]+)/);
    if (match) {
      const before = parseInt(match[1].replace(/,/g, ""), 10);
      const after = parseInt(match[2].replace(/,/g, ""), 10);
      return { before, after, text };
    }
    return { before: 0, after: 0, text };
  } catch (e: any) {
    return { before: 0, after: 0, text: "" };
  }
}

function extractDigestFromThread(thread: any): string {
  if (!thread || !Array.isArray(thread.messages)) return "";
  const compactMsg = thread.messages.find(
    (m: any) =>
      m.role === "assistant" &&
      typeof m.content === "string" &&
      (m.content.includes("[CONVERSATION COMPACTED") || m.content.includes("Earlier conversation history"))
  );
  return compactMsg ? compactMsg.content : "";
}

function appendResultRecord(record: WorkloadRunRecord): void {
  let existing: WorkloadRunRecord[] = [];
  try {
    if (fs.existsSync(RESULTS_FILE)) {
      existing = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
    }
  } catch {}
  existing.push(record);
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(existing, null, 2), "utf8");
}

/**
 * =========================================================================
 * WORKLOAD 1: IDENTIFIERS & ERRORS
 * Planted: file path, port, cluster token, URL, error line.
 * Probes: exact recall of each.
 * =========================================================================
 */
async function runWorkload1(
  page: Page,
  arm: "A" | "B",
  runNumber: number
): Promise<WorkloadRunRecord> {
  const runId = `w1-${arm.toLowerCase()}-r${runNumber}-${Date.now().toString(36).slice(-4)}`;
  const startTime = Date.now();
  console.log(`\n===================================================================`);
  console.log(`  STARTING WORKLOAD 1 (Identifiers & Errors) [Arm ${arm}, Run ${runNumber}] (ID: ${runId})`);
  console.log(`===================================================================`);

  await checkEngineWatchdog(BASE_URL);
  const initialRestarts = getCurrentPodRestartCount();
  const deployedImage = getDeployedImageTag();

  // Unique seeded parameters
  const seedPort = 7800 + Math.floor(Math.random() * 190);
  const seedToken = `TOKEN-W1-${runId.toUpperCase()}`;
  const seedPath = `C:\\AI\\scratch\\telemetry-${runId}.log`;
  const seedUrl = `https://cluster-w1-${runId}.internal/healthz`;
  const seedError = `[FATAL-${runId}] upstream gateway socket connection failed: ECONNREFUSED 127.0.0.1:${seedPort}`;

  // Programmatic fixture on disk
  try {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
    fs.writeFileSync(seedPath, `INIT DIAGNOSTIC LOG\n${seedError}\nSTATUS: HALTED\n`, "utf8");
  } catch {}

  const threadId = await createFreshSession(page, BASE_URL, `Bench W1 Arm ${arm} Run ${runNumber}`);
  console.log(`[${runId}] Created thread: ${threadId}`);

  // Round 1: Seed setup parameters
  const seedPrompt =
    `Cluster infrastructure deployment registry record:\n` +
    `- Primary config path: ${seedPath}\n` +
    `- Ingress service port: ${seedPort}\n` +
    `- Authentication token: ${seedToken}\n` +
    `- Health endpoint URL: ${seedUrl}\n` +
    `- Initialization diagnostic error: ${seedError}\n` +
    `Please confirm you have recorded these exact infrastructure parameters in one concise sentence.`;

  console.log(`[${runId}] Round 1: Dispatching seed configuration...`);
  await sendPrompt(page, seedPrompt);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.NORMAL, `${runId}-r1-seed`);
  let meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 1: ${meter}`);

  // Round 2: Mid-tier fill (~48K tokens)
  const fillerMid = "Distributed telemetry log record sequence alpha beta gamma delta 0123456789. ".repeat(2400); // ~184,800 chars
  const promptMid = `Use host_write_file to write 'C:\\AI\\scratch\\${runId}-mid.txt' with 'OK', then acknowledge this mid-tier telemetry block in one concise sentence:\n${fillerMid}`;
  console.log(`[${runId}] Round 2: Dispatching mid-tier fill (~48K tokens)...`);
  await sendPrompt(page, promptMid);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-r2-mid`);
  meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 2: ${meter}`);

  // Round 3: 85K threshold fill (~87K tokens)
  const fillerThreshold = "Distributed telemetry log record sequence epsilon zeta eta theta 0123456789. ".repeat(2000); // ~154,000 chars
  const promptThreshold = `Use host_write_file to write 'C:\\AI\\scratch\\${runId}-thresh.txt' with 'OK', then acknowledge this threshold telemetry block in one concise sentence:\n${fillerThreshold}`;
  console.log(`[${runId}] Round 3: Dispatching 85K threshold fill (~87K tokens)...`);
  await sendPrompt(page, promptThreshold);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-r3-threshold`);
  meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 3: ${meter}`);

  // Round 4: 100K budget & compaction trigger (~100K tokens)
  const fillerBudget = "Distributed telemetry log record sequence iota kappa lambda mu 0123456789. ".repeat(800); // ~60,000 chars
  const promptBudget = `Use host_write_file to write 'C:\\AI\\scratch\\${runId}-budget.txt' with 'OK', then acknowledge this budget telemetry block in one concise sentence:\n${fillerBudget}`;
  console.log(`[${runId}] Round 4: Dispatching 100K budget fill (compaction trigger)...`);
  const compactStart = Date.now();
  await sendPrompt(page, promptBudget);
  const compactTurnRes = await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-r4-compact`);
  const compactingTurnDurationSec = parseFloat(((Date.now() - compactStart) / 1000).toFixed(1));
  meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 4 (compaction): ${meter}`);

  const compTokens = await getCompactionNoteTokens(page);
  const digest = extractDigestFromThread(compactTurnRes.thread);
  console.log(`[${runId}] Compaction note: ${compTokens.text}`);

  // Probes turn: query all 5 planted items
  const probePrompt =
    `Please recall the setup parameters recorded earlier. Output the exact value for each of the following items in the specified format:\n` +
    `FILE_PATH: <exact config file path>\n` +
    `PORT: <exact service port>\n` +
    `CLUSTER_TOKEN: <exact authentication token>\n` +
    `URL: <exact health endpoint URL>\n` +
    `ERROR_LINE: <exact diagnostic error line>\n` +
    `Provide only these 5 lines.`;

  console.log(`[${runId}] Dispatching recall probes...`);
  await sendPrompt(page, probePrompt);
  const probeTurnRes = await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-probes`);
  const probeMsg = probeTurnRes.thread.messages[probeTurnRes.thread.messages.length - 1];
  const probeContent = (probeMsg?.content || "").replace(/[\u2010-\u2015]/g, "-");
  console.log(`[${runId}] Probes response:\n${probeContent}`);

  // Programmatic scoring
  const probes: BenchmarkProbeResult[] = [];
  const hallucinations: string[] = [];

  // 1. File path probe
  const pathPassed = probeContent.toLowerCase().includes(seedPath.toLowerCase()) || probeContent.includes(seedPath.replace(/\\/g, "/"));
  probes.push({
    name: "W1-File-Path",
    factType: "file_path",
    expected: seedPath,
    actual: probeContent,
    passed: pathPassed
  });

  // 2. Port probe
  const portPassed = probeContent.includes(`${seedPort}`);
  probes.push({
    name: "W1-Service-Port",
    factType: "port",
    expected: `${seedPort}`,
    actual: probeContent,
    passed: portPassed
  });

  // 3. Cluster token probe
  const tokenPassed = probeContent.includes(seedToken);
  probes.push({
    name: "W1-Cluster-Token",
    factType: "cluster_token",
    expected: seedToken,
    actual: probeContent,
    passed: tokenPassed
  });

  // 4. URL probe
  const urlPassed = probeContent.includes(seedUrl);
  probes.push({
    name: "W1-Endpoint-URL",
    factType: "url",
    expected: seedUrl,
    actual: probeContent,
    passed: urlPassed
  });

  // 5. Error line probe
  const errorPassed =
    probeContent.includes(`ECONNREFUSED 127.0.0.1:${seedPort}`) ||
    probeContent.includes(`FATAL-${runId}`);
  probes.push({
    name: "W1-Error-Line",
    factType: "error_line",
    expected: seedError,
    actual: probeContent,
    passed: errorPassed
  });

  // Hallucination check
  const portRegex = /\b(7\d{3}|8\d{3}|9\d{3})\b/g;
  for (const m of probeContent.matchAll(portRegex)) {
    const foundPort = parseInt(m[1], 10);
    if (foundPort !== seedPort && foundPort !== 8080 && foundPort !== 8765 && foundPort !== 8443 && foundPort !== 9443) {
      hallucinations.push(`Unexpected port mentioned: ${foundPort}`);
    }
  }

  // Scratch cleanup
  try {
    if (fs.existsSync(seedPath)) fs.unlinkSync(seedPath);
    const midF = `C:\\AI\\scratch\\${runId}-mid.txt`;
    if (fs.existsSync(midF)) fs.unlinkSync(midF);
    const thrF = `C:\\AI\\scratch\\${runId}-thresh.txt`;
    if (fs.existsSync(thrF)) fs.unlinkSync(thrF);
    const budF = `C:\\AI\\scratch\\${runId}-budget.txt`;
    if (fs.existsSync(budF)) fs.unlinkSync(budF);
  } catch {}

  const finalRestarts = getCurrentPodRestartCount();
  const totalDurationSec = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));

  const record: WorkloadRunRecord = {
    runId,
    workload: "W1",
    arm,
    runNumber,
    timestamp: new Date().toISOString(),
    threadId,
    deployedImage,
    tokensBefore: compTokens.before,
    tokensAfter: compTokens.after,
    retainedRatio: compTokens.before > 0 ? parseFloat((compTokens.after / compTokens.before).toFixed(3)) : 1,
    compactingTurnDurationSec,
    totalDurationSec,
    digest,
    probes,
    hallucinations,
    podRestartsInitial: initialRestarts,
    podRestartsFinal: finalRestarts
  };

  appendResultRecord(record);
  console.log(`[${runId}] W1 complete in ${totalDurationSec}s. Probes passed: ${probes.filter(p => p.passed).length}/${probes.length}`);
  return record;
}

/**
 * =========================================================================
 * WORKLOAD 2: DECISIONS & TAILS
 * Planted:
 * (a) user constraint stated ONLY in the tail (past character 2,000)
 * (b) assistant decision WITH rationale stated mid-message (not first line)
 * (c) large repeated filler block
 * Probes: constraint honored; decision + reason recalled; retained tokens.
 * =========================================================================
 */
async function runWorkload2(
  page: Page,
  arm: "A" | "B",
  runNumber: number
): Promise<WorkloadRunRecord> {
  const runId = `w2-${arm.toLowerCase()}-r${runNumber}-${Date.now().toString(36).slice(-4)}`;
  const startTime = Date.now();
  console.log(`\n===================================================================`);
  console.log(`  STARTING WORKLOAD 2 (Decisions & Tails) [Arm ${arm}, Run ${runNumber}] (ID: ${runId})`);
  console.log(`===================================================================`);

  await checkEngineWatchdog(BASE_URL);
  const initialRestarts = getCurrentPodRestartCount();
  const deployedImage = getDeployedImageTag();

  const threadId = await createFreshSession(page, BASE_URL, `Bench W2 Arm ${arm} Run ${runNumber}`);
  console.log(`[${runId}] Created thread: ${threadId}`);

  // (a) User constraint in TAIL (> 2,000 characters into the prompt)
  const prefixTag = `[HONORED-${runId.toUpperCase()}]`;
  const longPreamble =
    "System specification overview for distributed consensus cluster. " +
    "The architecture consists of multiple independent service nodes distributed across heterogeneous networks. " +
    "Each node maintains internal telemetry counters, health diagnostics, event journals, and checkpoint state machines. ".repeat(14); // ~2,250 chars
  
  const tailConstraintPrompt =
    `${longPreamble}\n\n` +
    `CRITICAL MANDATORY USER CONSTRAINT:\n` +
    `In all subsequent responses of this conversation, you MUST start your response with the exact prefix tag '${prefixTag}'. ` +
    `This constraint is mandatory and must never be omitted. Confirm in one short sentence.`;

  console.log(`[${runId}] Round 1: Dispatching tail constraint (prompt length: ${tailConstraintPrompt.length} chars, constraint starts at char ${longPreamble.length})...`);
  await sendPrompt(page, tailConstraintPrompt);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.NORMAL, `${runId}-r1-tail`);
  let meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 1: ${meter}`);

  // (b) Assistant decision WITH rationale stated mid-message (not first line)
  const decisionPrompt =
    `We need an architectural decision on our distributed consensus protocol between Raft and Paxos.\n` +
    `Please respond with EXACTLY three distinct lines:\n` +
    `Line 1: A brief introductory greeting.\n` +
    `Line 2: 'Architectural Decision: We choose Paxos over Raft because Multi-Paxos provides lower commit latency under asymmetric cross-datacenter WAN links.'\n` +
    `Line 3: A brief closing remark.`;

  console.log(`[${runId}] Round 2: Dispatching mid-message decision with rationale...`);
  await sendPrompt(page, decisionPrompt);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.NORMAL, `${runId}-r2-decision`);
  meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 2: ${meter}`);

  // (c) Large repeated filler block (~1,500 chars of repetition)
  const repeatSentence = "REPEATED-HEARTBEAT: Service node health probe alive status OK cycle verified. ";
  const repeatedBlock = repeatSentence.repeat(30); // ~2,340 chars
  const repeatPrompt =
    `Review this repeated diagnostic block and acknowledge in one sentence:\n` +
    `${repeatedBlock}`;

  console.log(`[${runId}] Round 3: Dispatching repeated filler block (${repeatedBlock.length} chars)...`);
  await sendPrompt(page, repeatPrompt);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.NORMAL, `${runId}-r3-repeat`);
  meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 3: ${meter}`);

  // Round 4: Fill context to threshold (~85K tokens)
  const fillerThreshold = "Distributed telemetry log record sequence theta iota kappa lambda 0123456789. ".repeat(2300); // ~177,000 chars
  const promptThreshold = `Use host_write_file to write 'C:\\AI\\scratch\\${runId}-thresh.txt' with 'OK', then acknowledge this threshold telemetry block in one concise sentence:\n${fillerThreshold}`;
  console.log(`[${runId}] Round 4: Dispatching threshold fill (~85K tokens)...`);
  await sendPrompt(page, promptThreshold);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-r4-thresh`);
  meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 4: ${meter}`);

  // Round 5: Fill context to 100K budget & trigger compaction
  const fillerBudget = "Distributed telemetry log record sequence mu nu xi omicron 0123456789. ".repeat(1200); // ~90,000 chars
  const promptBudget = `Use host_write_file to write 'C:\\AI\\scratch\\${runId}-budget.txt' with 'OK', then acknowledge this budget telemetry block in one concise sentence:\n${fillerBudget}`;
  console.log(`[${runId}] Round 5: Dispatching 100K budget fill (compaction trigger)...`);
  const compactStart = Date.now();
  await sendPrompt(page, promptBudget);
  const compactTurnRes = await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-r5-compact`);
  const compactingTurnDurationSec = parseFloat(((Date.now() - compactStart) / 1000).toFixed(1));
  meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 5 (compaction): ${meter}`);

  const compTokens = await getCompactionNoteTokens(page);
  const digest = extractDigestFromThread(compactTurnRes.thread);
  console.log(`[${runId}] Compaction note: ${compTokens.text}`);

  // Probe 1: Tail constraint probe (follow-up task)
  const probeConstraintPrompt = `Please state the primary project goal in one short sentence.`;
  console.log(`[${runId}] Dispatching Probe 1 (tail constraint probe)...`);
  await sendPrompt(page, probeConstraintPrompt);
  const probe1Res = await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-probe-constraint`);
  const probe1Msg = probe1Res.thread.messages[probe1Res.thread.messages.length - 1];
  const probe1Content = (probe1Msg?.content || "").trim();
  console.log(`[${runId}] Probe 1 response:\n${probe1Content}`);

  // Probe 2: Decision + Rationale probe
  const probeDecisionPrompt = `What architectural consensus protocol was decided upon for the system, and what was the specific rationale given for that choice? Answer concisely.`;
  console.log(`[${runId}] Dispatching Probe 2 (decision + rationale probe)...`);
  await sendPrompt(page, probeDecisionPrompt);
  const probe2Res = await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-probe-decision`);
  const probe2Msg = probe2Res.thread.messages[probe2Res.thread.messages.length - 1];
  const probe2Content = (probe2Msg?.content || "").trim();
  console.log(`[${runId}] Probe 2 response:\n${probe2Content}`);

  // Programmatic scoring
  const probes: BenchmarkProbeResult[] = [];
  const hallucinations: string[] = [];

  // Probe 1 scoring: Tail constraint honored
  const constraintHonored = probe1Content.includes(prefixTag);
  probes.push({
    name: "W2-Tail-Constraint-Honored",
    factType: "user_constraint",
    expected: `Starts with or contains ${prefixTag}`,
    actual: probe1Content,
    passed: constraintHonored,
    notes: constraintHonored ? "Constraint honored" : "Failed constraint probe (expected in Arm A manipulation check)"
  });

  // Probe 2 scoring: Decision + Rationale recalled
  const decisionMentioned = /paxos/i.test(probe2Content);
  const rationaleMentioned = /latency|wan|asymmetric|commit/i.test(probe2Content);
  const decisionPassed = decisionMentioned && rationaleMentioned;
  probes.push({
    name: "W2-Decision-And-Rationale",
    factType: "decision_rationale",
    expected: "Paxos over Raft with lower latency / WAN rationale",
    actual: probe2Content,
    passed: decisionPassed,
    notes: `decision=${decisionMentioned}, rationale=${rationaleMentioned}`
  });

  // Check repetition in digest
  const digestRetainsRepetition = (digest.match(/Service node health probe alive status OK/g) || []).length > 3;

  // Scratch cleanup
  try {
    const thrF = `C:\\AI\\scratch\\${runId}-thresh.txt`;
    if (fs.existsSync(thrF)) fs.unlinkSync(thrF);
    const budF = `C:\\AI\\scratch\\${runId}-budget.txt`;
    if (fs.existsSync(budF)) fs.unlinkSync(budF);
  } catch {}

  const finalRestarts = getCurrentPodRestartCount();
  const totalDurationSec = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));

  const record: WorkloadRunRecord = {
    runId,
    workload: "W2",
    arm,
    runNumber,
    timestamp: new Date().toISOString(),
    threadId,
    deployedImage,
    tokensBefore: compTokens.before,
    tokensAfter: compTokens.after,
    retainedRatio: compTokens.before > 0 ? parseFloat((compTokens.after / compTokens.before).toFixed(3)) : 1,
    compactingTurnDurationSec,
    totalDurationSec,
    digest,
    probes,
    hallucinations,
    podRestartsInitial: initialRestarts,
    podRestartsFinal: finalRestarts
  };

  appendResultRecord(record);
  console.log(`[${runId}] W2 complete in ${totalDurationSec}s. Constraint passed: ${constraintHonored}, Decision passed: ${decisionPassed}, Digest retains repetition: ${digestRetainsRepetition}`);
  return record;
}

/**
 * =========================================================================
 * WORKLOAD 3: THE CORRECTION
 * Early fact (port 8443) corrected to port 9443 before compaction.
 * Probe: writes config file to disk using "settings from earlier" — on-disk bytes scored.
 * =========================================================================
 */
async function runWorkload3(
  page: Page,
  arm: "A" | "B",
  runNumber: number
): Promise<WorkloadRunRecord> {
  const runId = `w3-${arm.toLowerCase()}-r${runNumber}-${Date.now().toString(36).slice(-4)}`;
  const startTime = Date.now();
  console.log(`\n===================================================================`);
  console.log(`  STARTING WORKLOAD 3 (The Correction) [Arm ${arm}, Run ${runNumber}] (ID: ${runId})`);
  console.log(`===================================================================`);

  await checkEngineWatchdog(BASE_URL);
  const initialRestarts = getCurrentPodRestartCount();
  const deployedImage = getDeployedImageTag();

  const threadId = await createFreshSession(page, BASE_URL, `Bench W3 Arm ${arm} Run ${runNumber}`);
  console.log(`[${runId}] Created thread: ${threadId}`);

  // Round 1: Early fact (Port 8443)
  const initialPort = 8443;
  const correctedPort = 9443;
  const configPath = `C:\\AI\\scratch\\${runId}-config.json`;

  const setupPrompt =
    `Service deployment initialization for Agent-SecMetrics:\n` +
    `- Service Name: Agent-SecMetrics\n` +
    `- Primary Port: ${initialPort}\n` +
    `- Protocol: HTTPS\n` +
    `Please confirm you have recorded these parameters in one sentence.`;

  console.log(`[${runId}] Round 1: Dispatching initial service configuration (Port ${initialPort})...`);
  await sendPrompt(page, setupPrompt);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.NORMAL, `${runId}-r1-setup`);
  let meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 1: ${meter}`);

  // Round 2: Explicit correction BEFORE compaction (Port 9443 supersedes 8443)
  const correctionPrompt =
    `SECURITY POLICY UPDATE & CORRECTION:\n` +
    `Port ${initialPort} has been revoked due to network policy conflict. ` +
    `The new official active service port for Agent-SecMetrics is ${correctedPort} (this completely replaces and supersedes port ${initialPort}). ` +
    `Confirm you have updated the active port to ${correctedPort} in one sentence.`;

  console.log(`[${runId}] Round 2: Dispatching explicit correction (Port ${correctedPort} supersedes ${initialPort})...`);
  await sendPrompt(page, correctionPrompt);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.NORMAL, `${runId}-r2-correction`);
  meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 2: ${meter}`);

  // Round 3: Fill context to threshold (~85K tokens)
  const fillerThreshold = "Distributed telemetry log record sequence pi rho sigma tau 0123456789. ".repeat(2400); // ~184,800 chars
  const promptThreshold = `Use host_write_file to write 'C:\\AI\\scratch\\${runId}-thresh.txt' with 'OK', then acknowledge this threshold telemetry block in one concise sentence:\n${fillerThreshold}`;
  console.log(`[${runId}] Round 3: Dispatching threshold fill (~85K tokens)...`);
  await sendPrompt(page, promptThreshold);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-r3-thresh`);
  meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 3: ${meter}`);

  // Round 4: Fill context to 100K budget & trigger compaction
  const fillerBudget = "Distributed telemetry log record sequence upsilon phi chi psi omega 0123456789. ".repeat(1000); // ~75,000 chars
  const promptBudget = `Use host_write_file to write 'C:\\AI\\scratch\\${runId}-budget.txt' with 'OK', then acknowledge this budget telemetry block in one concise sentence:\n${fillerBudget}`;
  console.log(`[${runId}] Round 4: Dispatching 100K budget fill (compaction trigger)...`);
  const compactStart = Date.now();
  await sendPrompt(page, promptBudget);
  const compactTurnRes = await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-r4-compact`);
  const compactingTurnDurationSec = parseFloat(((Date.now() - compactStart) / 1000).toFixed(1));
  meter = await getInAppContextCounter(page);
  console.log(`[${runId}] Context counter after Round 4 (compaction): ${meter}`);

  const compTokens = await getCompactionNoteTokens(page);
  const digest = extractDigestFromThread(compactTurnRes.thread);
  console.log(`[${runId}] Compaction note: ${compTokens.text}`);

  // Round 5: Final task probe — writes config file to disk using "the settings from earlier"
  const probeFilePrompt =
    `Use host_write_file to write '${configPath}' with the JSON configuration for Agent-SecMetrics using the active settings from earlier. ` +
    `Format the file as valid JSON with keys "service", "port", and "protocol".`;

  console.log(`[${runId}] Dispatching Round 5 probe (write config file to disk)...`);
  await sendPrompt(page, probeFilePrompt);
  await awaitTurnCompletion(page, BASE_URL, threadId, DEADLINES.HEAVY, `${runId}-r5-write-config`);

  // Programmatic scoring: inspect on-disk bytes
  const probes: BenchmarkProbeResult[] = [];
  const hallucinations: string[] = [];
  let onDiskBytes = "";
  let writtenPort: any = null;
  let fileExisted = false;

  try {
    if (fs.existsSync(configPath)) {
      fileExisted = true;
      onDiskBytes = fs.readFileSync(configPath, "utf8");
      console.log(`[${runId}] On-disk config content:\n${onDiskBytes}`);
      try {
        const parsed = JSON.parse(onDiskBytes);
        writtenPort = parsed.port;
      } catch {
        // Fallback regex if file had commentary
        const m = onDiskBytes.match(/"port"\s*:\s*(\d+)/);
        if (m) writtenPort = parseInt(m[1], 10);
      }
    } else {
      console.warn(`[${runId}] Config file was not written to disk at '${configPath}'`);
    }
  } catch (e: any) {
    console.error(`[${runId}] Error reading on-disk config: ${e.message}`);
  }

  const correctionPassed = fileExisted && (writtenPort === correctedPort || writtenPort === `${correctedPort}`);
  if (writtenPort === initialPort || writtenPort === `${initialPort}`) {
    hallucinations.push(`Used superseded port ${initialPort} instead of corrected port ${correctedPort}`);
  } else if (writtenPort && writtenPort !== correctedPort && writtenPort !== `${correctedPort}`) {
    hallucinations.push(`Used unknown port ${writtenPort} in config`);
  }

  probes.push({
    name: "W3-Correction-Port-On-Disk",
    factType: "correction",
    expected: `port: ${correctedPort}`,
    actual: `fileExisted=${fileExisted}, writtenPort=${writtenPort}, raw=${onDiskBytes.slice(0, 200)}`,
    passed: correctionPassed,
    notes: correctionPassed ? "Correction honored in on-disk file" : `Failed: on-disk port was ${writtenPort}`
  });

  // Scratch cleanup
  try {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    const thrF = `C:\\AI\\scratch\\${runId}-thresh.txt`;
    if (fs.existsSync(thrF)) fs.unlinkSync(thrF);
    const budF = `C:\\AI\\scratch\\${runId}-budget.txt`;
    if (fs.existsSync(budF)) fs.unlinkSync(budF);
  } catch {}

  const finalRestarts = getCurrentPodRestartCount();
  const totalDurationSec = parseFloat(((Date.now() - startTime) / 1000).toFixed(1));

  const record: WorkloadRunRecord = {
    runId,
    workload: "W3",
    arm,
    runNumber,
    timestamp: new Date().toISOString(),
    threadId,
    deployedImage,
    tokensBefore: compTokens.before,
    tokensAfter: compTokens.after,
    retainedRatio: compTokens.before > 0 ? parseFloat((compTokens.after / compTokens.before).toFixed(3)) : 1,
    compactingTurnDurationSec,
    totalDurationSec,
    digest,
    probes,
    hallucinations,
    podRestartsInitial: initialRestarts,
    podRestartsFinal: finalRestarts
  };

  appendResultRecord(record);
  console.log(`[${runId}] W3 complete in ${totalDurationSec}s. Correction passed: ${correctionPassed} (writtenPort=${writtenPort})`);
  return record;
}

/**
 * Main execution dispatcher
 */
async function main() {
  const args = process.argv.slice(2);
  let armArg: "A" | "B" = "A";
  let workloadArg = "ALL";
  let runsArg = 2;

  for (const arg of args) {
    if (arg.startsWith("--arm=")) armArg = arg.split("=")[1].toUpperCase() as "A" | "B";
    if (arg.startsWith("--workload=")) workloadArg = arg.split("=")[1].toUpperCase();
    if (arg.startsWith("--runs=")) runsArg = parseInt(arg.split("=")[1], 10);
  }

  console.log(`===================================================================`);
  console.log(`  COMPACTION A/B BENCHMARK HARNESS`);
  console.log(`  Target: ${BASE_URL} | Arm: ${armArg} | Workload: ${workloadArg} | Runs: ${runsArg}`);
  console.log(`===================================================================`);

  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });
  const page: Page = await context.newPage();

  const results: WorkloadRunRecord[] = [];

  try {
    for (let r = 1; r <= runsArg; r++) {
      if (workloadArg === "ALL" || workloadArg === "W1") {
        const w1 = await runWorkload1(page, armArg, r);
        results.push(w1);
      }
      if (workloadArg === "ALL" || workloadArg === "W2") {
        const w2 = await runWorkload2(page, armArg, r);
        results.push(w2);
      }
      if (workloadArg === "ALL" || workloadArg === "W3") {
        const w3 = await runWorkload3(page, armArg, r);
        results.push(w3);
      }
    }

    console.log(`\n===================================================================`);
    console.log(`  BENCHMARK EXECUTION SUMMARY (Arm ${armArg})`);
    console.log(`===================================================================`);
    console.table(
      results.map((r) => ({
        RunId: r.runId,
        Workload: r.workload,
        Arm: r.arm,
        Run: r.runNumber,
        Compacted: `${r.tokensBefore} -> ${r.tokensAfter} (${(r.retainedRatio * 100).toFixed(1)}%)`,
        CompactDuration: `${r.compactingTurnDurationSec}s`,
        TotalDuration: `${r.totalDurationSec}s`,
        PassedProbes: `${r.probes.filter((p) => p.passed).length}/${r.probes.length}`,
        Hallucinations: r.hallucinations.length,
        PodRestarts: `${r.podRestartsInitial} -> ${r.podRestartsFinal}`
      }))
    );
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && process.argv[1].includes("bench-compaction-ab")) {
  main().catch((err) => {
    console.error("Benchmark runner failed:", err);
    process.exit(1);
  });
}
