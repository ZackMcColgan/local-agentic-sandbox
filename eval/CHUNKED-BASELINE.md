# Chunked Baseline Protocol (`pr-coding` in Job Mode)

This protocol exercises the sandbox's own job-chunking machinery (task threads, handoff persistence, and automatic continuation) using the `pr-coding` golden task as an end-to-end regression.

## Command

```bash
node eval/run.mjs --mode job --task pr-coding --chunk-rounds 8
```

Optional flags:
- `--sandbox-url <url>` (defaults to `http://127.0.0.1:3000`)

## Pass Criteria

A run of `pr-coding` in `--mode job --chunk-rounds 8` **PASSES** if and only if all of the following hold:

1. **Deliverable completed**: The job finishes its deliverable (`retryAfter.mjs` implementation).
2. **Chunk boundaries banked**: Every chunk boundary (`round >= maxRounds`) is banked with a git commit and runlog entry before pausing.
3. **Supervisor-readable handoff**: Each chunk handoff is written to the location where the supervisor reads it.
4. **Autonomous continuation**: Continuations fire automatically without human intervention until the job reaches a terminal state.
5. **Grade parity**: The hidden-test grade (`eval/graders/pr-coding.mjs`) equals the uninterrupted endpoint baseline grade.
