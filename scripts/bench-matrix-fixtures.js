const fs = require('fs');
const path = require('path');

const OUT_DIR = 'D:\\AI\\orchestrator-scratch\\matrix-prompts';
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

// 1. Prose blocks
const proseParagraph = `The distributed consensus engine provides strict serializability, high-throughput log replication, and Byzantine fault tolerance across heterogeneous cloud and bare-metal nodes. When a state transition occurs, each replica computes the cryptographically verifiable digest of the transaction stream and broadcasts its threshold signature to the cluster leader. The gossip transport protocol operates over multiplexed QUIC streams with adaptive congestion control, ensuring sub-millisecond p99 latencies even during high network variance. Failure detection employs an accrual heartbeat model with exponential decay, dynamically adapting suspicion thresholds to background network jitter. When a partition is identified, the minority quorum immediately halts external state mutations and transitions to read-only speculative snapshot queries, preventing split-brain divergence. `;

function makeProse(targetChars) {
  let res = "System Architecture Specification Document:\n\n";
  while (res.length < targetChars) {
    res += proseParagraph;
  }
  res += "\n\nTask: Analyze the architectural invariants and synthesize the system design in detail.";
  return res;
}

// 2. Code blocks
const codeSnippet = `
interface ClusterNodeState {
  id: string;
  epoch: number;
  term: number;
  status: 'LEADER' | 'FOLLOWER' | 'CANDIDATE';
  peers: Map<string, { lastHeartbeat: number; matchIndex: number; nextIndex: number }>;
}

export class RaftConsensusManager {
  private state: ClusterNodeState;
  private log: Array<{ index: number; term: number; command: Uint8Array }>;

  constructor(nodeId: string, initialPeers: string[]) {
    this.state = {
      id: nodeId,
      epoch: 1,
      term: 0,
      status: 'FOLLOWER',
      peers: new Map(initialPeers.map(p => [p, { lastHeartbeat: Date.now(), matchIndex: 0, nextIndex: 1 }]))
    };
    this.log = [];
  }

  public async appendEntries(term: number, leaderId: string, prevIndex: number, entries: Uint8Array[]): Promise<boolean> {
    if (term < this.state.term) return false;
    this.state.term = term;
    this.state.status = 'FOLLOWER';
    return true;
  }
}
`;

function makeCode(targetChars) {
  let res = "// Distributed Consensus Implementation\n\n";
  while (res.length < targetChars) {
    res += codeSnippet;
  }
  res += "\n// Task: Refactor the cluster state management methods for lock-free concurrency.\n";
  return res;
}

// 3. JSON blocks
function makeJson(targetChars) {
  const records = [];
  let currentLen = 50;
  let idx = 1;
  while (currentLen < targetChars) {
    const item = {
      nodeId: `node-sg-${idx}`,
      cluster: "prod-omega-us-east",
      role: idx % 3 === 0 ? "leader" : "replica",
      metrics: {
        cpuUsagePct: 42.5 + (idx % 20),
        memoryAllocatedBytes: 1024 * 1024 * 1024 * 8,
        activeStreams: 128 + idx,
        p99LatencyMs: 1.45 + (idx % 5) * 0.1
      },
      tags: ["consensus", "telemetry", "low-latency", "geo-replicated"]
    };
    records.push(item);
    currentLen += JSON.stringify(item).length + 2;
    idx++;
  }
  return JSON.stringify({ clusterManifest: records, totalRecords: records.length, generatedAt: "2026-11-09T00:00:00Z" }, null, 2) + "\n\nTask: Parse and summarize the telemetry metrics for the abnormal cluster nodes.";
}

// Generate files accurately scaled to token budgets (~2.5 chars/tok for JSON, ~3.2 chars/tok for Code, ~4.0 chars/tok for Prose):
// ~4K: 16K prose, 13K code, 11K json
// ~48K: 195K prose, 155K code, 125K json
// ~100K: 395K prose
console.log('Generating benchmark fixtures in:', OUT_DIR);

fs.writeFileSync(path.join(OUT_DIR, 'prose-4k.txt'), makeProse(16000));
fs.writeFileSync(path.join(OUT_DIR, 'code-4k.txt'), makeCode(13000));
fs.writeFileSync(path.join(OUT_DIR, 'json-4k.txt'), makeJson(11000));

fs.writeFileSync(path.join(OUT_DIR, 'prose-48k.txt'), makeProse(195000));
fs.writeFileSync(path.join(OUT_DIR, 'code-48k.txt'), makeCode(155000));
fs.writeFileSync(path.join(OUT_DIR, 'json-48k.txt'), makeJson(125000));

fs.writeFileSync(path.join(OUT_DIR, 'prose-100k.txt'), makeProse(395000));

console.log('All fixtures created successfully:');
for (const f of fs.readdirSync(OUT_DIR)) {
  const stat = fs.statSync(path.join(OUT_DIR, f));
  console.log(` - ${f}: ${stat.size} bytes`);
}
