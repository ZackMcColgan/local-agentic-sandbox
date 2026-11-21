import fs from "node:fs";
import path from "node:path";
import { resolveBoardDir } from "./boardStore";
import type { GateVerdict } from "./reviewerGate";

export type { GateVerdict };

export const AGREEMENT_LEDGER_FILENAME = "reviewer-agreement-ledger.json";

export interface AgreementLedgerEntry {
  prNumber: number;
  headSha: string;
  reviewerVerdict: GateVerdict;
  driverVerdict: GateVerdict | null;
  agreed: boolean | null;
  reason?: string;
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
  return value === "PASS" || value === "FAIL";
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
  const audited = entries.filter((entry) => entry.driverVerdict !== null);
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
          driverVerdict: entry.driverVerdict,
          agreed:
            entry.driverVerdict === null ? null : entry.reviewerVerdict === entry.driverVerdict,
          ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
          recordedAt:
            typeof entry.recordedAt === "string" ? entry.recordedAt : new Date(0).toISOString(),
          updatedAt:
            typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
        }));
      return recomputeLedger(
        entries,
        typeof parsed?.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
      );
    } catch {
      return emptyLedger();
    }
  }

  private write(ledger: PersistentAgreementLedger): void {
    if (!fs.existsSync(this.boardDir)) {
      fs.mkdirSync(this.boardDir, { recursive: true, mode: 0o770 });
    }
    fs.writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2), {
      encoding: "utf8",
      mode: 0o660,
    });
  }

  recordShadowVerdict(input: {
    prNumber: number;
    headSha: string;
    reviewerVerdict: GateVerdict;
  }): PersistentAgreementLedger {
    const current = this.read();
    const nowIso = new Date().toISOString();
    const entries = [...current.entries];
    const existingIndex = entries.findIndex((e) => e.prNumber === input.prNumber);

    if (existingIndex >= 0) {
      const prev = entries[existingIndex];
      const sameHead = prev.headSha === input.headSha;
      const driverVerdict = sameHead ? prev.driverVerdict : null;
      entries[existingIndex] = {
        ...prev,
        headSha: input.headSha,
        reviewerVerdict: input.reviewerVerdict,
        driverVerdict,
        agreed: driverVerdict === null ? null : input.reviewerVerdict === driverVerdict,
        updatedAt: nowIso,
      };
    } else {
      entries.push({
        prNumber: input.prNumber,
        headSha: input.headSha,
        reviewerVerdict: input.reviewerVerdict,
        driverVerdict: null,
        agreed: null,
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
    const existingIndex = entries.findIndex((e) => e.prNumber === input.prNumber);
    if (existingIndex < 0) {
      return null;
    }

    const nowIso = new Date().toISOString();
    const prev = entries[existingIndex];
    entries[existingIndex] = {
      ...prev,
      headSha: input.headSha ?? prev.headSha,
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
