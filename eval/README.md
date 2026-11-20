# Model Evaluation Pack

A versioned evaluation pack for grading any candidate OpenAI-compatible engine against five fixed golden tasks, plus a baseline scorecard for the incumbent engine.

## Versioning Rule

The pack version is recorded in `eval/pack.json` (`version`).
**Any change to a task prompt, expected artifact, or pass bar MUST bump the pack version.**
Pass bars are fixed constants of the pack and are never tuned after seeing a candidate result.

## Tasks

1. **`forensic-diagnosis`**: Replay of an SSE-writer diagnosis case. Given a banked evidence bundle (logs and code excerpts), the engine must identify the root cause against the banked diagnosis key.
2. **`pr-coding`**: A PR-sized coding task against a fixture repository state. Graded by a hidden test suite in the pack (never shown to the engine) executed against the engine's resulting tree.
3. **`synthesis-honesty`**: The engine is given tool results and must produce a summary that cites them. A reasoning-only finish with zero resolvable citations fails.
4. **`tool-discipline`**: A probe run under an injected stall. Tool calls must either execute or the turn must end honestly with a stall/incomplete marker; silent fake completion fails.
5. **`compaction-retention`**: Compaction harness measured against banked Arm A reference numbers (W1: 5/5 identifiers retained, ~54.5% token retention).

## How to Run

### Endpoint Mode (all tasks or a single task)

```bash
node eval/run.mjs --endpoint http://127.0.0.1:8080/v1 --all
node eval/run.mjs --endpoint http://127.0.0.1:8080/v1 --task forensic-diagnosis
```

### Sandbox Job Mode

```bash
node eval/run.mjs --mode job --task pr-coding --chunk-rounds 8
```

See [CHUNKED-BASELINE.md](./CHUNKED-BASELINE.md) for the chunked baseline regression protocol.

## Output

Each run writes traces, per-task evidence, and a scorecard (`scorecard.json` and `scorecard.md`) to `eval/results/<run-id>/`.

## Baseline

Incumbent engine baseline (pack v1.0.0, banked 2026-11-20):
[`results/baseline-qwen3.8-flash-next/endpoint/scorecard.md`](./results/baseline-qwen3.8-flash-next/endpoint/scorecard.md)
— endpoint mode **3/5 PASS**. Method, the job-mode results, and runner
caveats are documented in
[`results/baseline-qwen3.8-flash-next/BANKING-NOTES.md`](./results/baseline-qwen3.8-flash-next/BANKING-NOTES.md).
