import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, quarantineCorruptFile } from "../fsAtomic";
import { resolveBoardDir } from "./boardStore";
import type { GateVerdict, ReviewerTurnState } from "./reviewerGate";

export type { GateVerdict, ReviewerTurnState };

export const AGREEMENT_LEDGER_FILENAME = "reviewer-agreement-ledger.json";

export interface AgreementLedgerEntry {
  prNumber: number;
  headSha: string;
  reviewerVerdict: GateVerdict;
  /** How the reviewer turn concluded (#137). Abstentions carry their turn state. */
  turnState?: ReviewerTurnState;
  driverVerdict: GateVerdict | null;
  agreed: boolean | null;
  reason?: string;
  /** Wall-clock engine minutes spent evaluating this PR (HO-7). */
  engineMinutes?: number;
  recordedAt: string;
  updatedAt: string;
}

export interface AgreementEscapeCase {
  prNumber: number;
  headSha: string;
  reviewerVerdict: "PASS";
  driverVerdict: "FAIL";
  reason: string;
  recordedAt: string;
}

export interface PersistentAgreementLedger {
  entries: AgreementLedgerEntry[];
  escapes: AgreementEscapeCase[];
  totalPrs: number;
  agreements: number;
  agreementRate: number;
  stage3Eligible: boolean;
  updatedAt: string;
}

export function isValidGateVerdict(value: unknown): value is GateVerdict {
  return value === "PASS" || value === "FAIL" || value === "NO_VERDICT";
}

/** #137: a NO_VERDICT entry is an abstention, not a concluded verdict. */
function isAbstention(reviewerVerdict: GateVerdict): boolean {
  return reviewerVerdict === "NO_VERDICT";
}

function emptyLedger(nowIso: string = new Date(0).toISOString()): PersistentAgreementLedger {
  return {
    entries: [],
    escapes: [],
    totalPrs: 0,
    agreements: 0,
    agreementRate: 0,
    stage3Eligible: false,
    updatedAt: nowIso,
  };
}

function recomputeLedger(
  entries: AgreementLedgerEntry[],
  nowIso: string = new Date().toISOString()
): PersistentAgreementLedger {
  // #137: abstained (NO_VERDICT) reviewer turns are excluded from the
  // agreement-rate denominator; only concluded reviewer verdicts pair with a
  // driver verdict.
  const audited = entries.filter(
    (entry) => entry.driverVerdict !== null && !isAbstention(entry.reviewerVerdict)
  );
  const totalPrs = audited.length;
  const agreements = audited.filter((entry) => entry.agreed === true).length;
  const agreementRate = totalPrs > 0 ? agreements / totalPrs : 0;

  const escapes: AgreementEscapeCase[] = audited
    .filter((entry) => entry.reviewerVerdict === "PASS" && entry.driverVerdict === "FAIL")
    .map((entry) => ({
      prNumber: entry.prNumber,
      headSha: entry.headSha,
      reviewerVerdict: "PASS" as const,
      driverVerdict: "FAIL" as const,
      reason: entry.reason ?? "Driver blocked PR that reviewer passed",
      recordedAt: entry.updatedAt,
    }));

  const stage3Eligible = totalPrs >= 10 && agreementRate >= 0.95 && escapes.length === 0;

  return {
    entries,
    escapes,
    totalPrs,
    agreements,
    agreementRate,
    stage3Eligible,
    updatedAt: nowIso,
  };
}

export class AgreementLedgerStore {
  private readonly boardDir: string;
  private readonly ledgerPath: string;

  constructor(boardDir?: string) {
    this.boardDir = boardDir || resolveBoardDir();
    if (!fs.existsSync(this.boardDir)) {
      fs.mkdirSync(this.boardDir, { recursive: true, mode: 0o770 });
    }
    this.ledgerPath = path.join(this.boardDir, AGREEMENT_LEDGER_FILENAME);
  }

  getFilePath(): string {
    return this.ledgerPath;
  }

  read(): PersistentAgreementLedger {
    if (!fs.existsSync(this.ledgerPath)) {
      return emptyLedger();
    }
    try {
      const raw = fs.readFileSync(this.ledgerPath, "utf8");
      if (!raw.trim()) return emptyLedger();
      const parsed = JSON.parse(raw) as Partial<PersistentAgreementLedger>;
      const rawEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const entries: AgreementLedgerEntry[] = rawEntries
        .filter(
          (entry): entry is AgreementLedgerEntry =>
            Boolean(entry) &&
            typeof entry.prNumber === "number" &&
            typeof entry.headSha === "string" &&
            isValidGateVerdict(entry.reviewerVerdict) &&
            (entry.driverVerdict === null || isValidGateVerdict(entry.driverVerdict))
        )
        .map((entry) => ({
          prNumber: entry.prNumber,
          headSha: entry.headSha,
          reviewerVerdict: entry.reviewerVerdict,
          ...(typeof entry.turnState === "string" ? { turnState: entry.turnState } : {}),
          driverVerdict: entry.driverVerdict,
          agreed:
            entry.driverVerdict === null ? null : entry.reviewerVerdict === entry.driverVerdict,
          ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
          ...(typeof entry.engineMinutes === "number" && Number.isFinite(entry.engineMinutes)
            ? { engineMinutes: entry.engineMinutes }
            : {}),
          recordedAt:
            typeof entry.recordedAt === "string" ? entry.recordedAt : new Date(0).toISOString(),
          updatedAt:
            typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
        }));
      return recomputeLedger(
        entries,
        typeof parsed?.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
      );
    } catch (err) {
      quarantineCorruptFile(
        this.ledgerPath,
        err instanceof Error ? err.message : "corrupt agreement ledger JSON"
      );
      return emptyLedger();
    }
  }

  private write(ledger: PersistentAgreementLedger): void {
    atomicWriteFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2), 0o660);
  }

  recordShadowVerdict(input: {
    prNumber: number;
    headSha: string;
    reviewerVerdict: GateVerdict;
    turnState?: ReviewerTurnState;
    reason?: string;
    engineMinutes?: number;
  }): PersistentAgreementLedger {
    const current = this.read();
    const nowIso = new Date().toISOString();
    const entries = [...current.entries];
    // HO-9: Key entries by (prNumber, headSha) so new commits on a PR do not overwrite prior SHA verdicts.
    const existingIndex = entries.findIndex(
      (e) => e.prNumber === input.prNumber && e.headSha === input.headSha
    );

    if (existingIndex >= 0) {
      const prev = entries[existingIndex];
      const driverVerdict = prev.driverVerdict;
      // #137: a later completed verdict supersedes an earlier abstention, but a
      // later abstention must never overwrite an earlier concluded verdict.
      const reviewerVerdict =
        input.reviewerVerdict === "NO_VERDICT" && !isAbstention(prev.reviewerVerdict)
          ? prev.reviewerVerdict
          : input.reviewerVerdict;
      const turnState =
        input.reviewerVerdict === "NO_VERDICT" && !isAbstention(prev.reviewerVerdict)
          ? prev.turnState
          : input.turnState;
      entries[existingIndex] = {
        ...prev,
        headSha: input.headSha,
        reviewerVerdict,
        ...(turnState !== undefined ? { turnState } : {}),
        driverVerdict,
        agreed: driverVerdict === null ? null : reviewerVerdict === driverVerdict,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.engineMinutes !== undefined ? { engineMinutes: input.engineMinutes } : {}),
        updatedAt: nowIso,
      };
    } else {
      entries.push({
        prNumber: input.prNumber,
        headSha: input.headSha,
        reviewerVerdict: input.reviewerVerdict,
        ...(input.turnState !== undefined ? { turnState: input.turnState } : {}),
        driverVerdict: null,
        agreed: null,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.engineMinutes !== undefined ? { engineMinutes: input.engineMinutes } : {}),
        recordedAt: nowIso,
        updatedAt: nowIso,
      });
    }

    const next = recomputeLedger(entries, nowIso);
    this.write(next);
    return next;
  }

  recordDriverVerdict(input: {
    prNumber: number;
    headSha?: string;
    driverVerdict: GateVerdict;
    reason?: string;
  }): PersistentAgreementLedger | null {
    const current = this.read();
    const entries = [...current.entries];
    let existingIndex = -1;
    if (typeof input.headSha === "string" && input.headSha.trim()) {
      const targetSha = input.headSha.trim();
      existingIndex = entries.findIndex(
        (e) => e.prNumber === input.prNumber && e.headSha === targetSha
      );
      if (existingIndex < 0) {
        const anyForPr = entries.find((e) => e.prNumber === input.prNumber);
        if (anyForPr) {
          throw new Error(
            `headSha mismatch for PR #${input.prNumber}: expected '${anyForPr.headSha}', got '${targetSha}'`
          );
        }
        return null;
      }
    } else {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].prNumber === input.prNumber) {
          existingIndex = i;
          break;
        }
      }
      if (existingIndex < 0) {
        return null;
      }
    }

    const nowIso = new Date().toISOString();
    const prev = entries[existingIndex];
    entries[existingIndex] = {
      ...prev,
      headSha: prev.headSha,
      driverVerdict: input.driverVerdict,
      agreed: prev.reviewerVerdict === input.driverVerdict,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      updatedAt: nowIso,
    };

    const next = recomputeLedger(entries, nowIso);
    this.write(next);
    return next;
  }
}

export function getAgreementLedgerStore(boardDir?: string): AgreementLedgerStore {
  return new AgreementLedgerStore(boardDir);
}
