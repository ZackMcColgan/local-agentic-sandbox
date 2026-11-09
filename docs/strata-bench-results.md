# Strata Speed Benchmark Results (REV 4 — Nov 9, 2026)
**Status**: IN PROGRESS (PARTIAL)  
**Target Architecture**: AMD Radeon RX 9070 XT (gfx1201), 16 GB VRAM | Ryzen 5 7600 (8c/16t), 32 GB RAM  
**Host Environment**: Windows 11 air-gapped sandbox  
**Live Target**: `http://127.0.0.1:8080` (Model: `qwen3.8-flash-next-gyro-gyro-s`)  

---

## Phase 0 — Pre-Update State Capture (Read-Only)
*Captured*: 2026-11-09T08:10:00Z  

- **Installed Strata App Version**: `0.2.7` (Build: `0.1.53`, Python 3.12.15)
- **Installed Strata Engine Version**: `0.1.52` (`0.1.52-windows-x86_64-hip-rx9070`, previous: `0.1.50`)
- **Active Model File**: `Qwen3.8-Flash-Next-Gyro-S-TQ1_0.gguf`
  - Path: `C:\AI\Strata-data\models\gyro-Gyro-S\Qwen3.8-Flash-Next-Gyro-S-TQ1_0.gguf`
  - Size: `58,487,015,808 bytes` (`54.470 GiB`)
- **Full Launch Line Used by AI-ON**:
  ```powershell
  # Process Invocation:
  "C:\Users\zackm\AppData\Local\Strata\terminal\current\python\python.exe" -m serve.server `
    --engine strata `
    --config "C:\Users\zackm\AppData\Local\Strata\launch\hermes-strata-gyro-64k.json" `
    --host 127.0.0.1 --port 8080 --parallel 1

  # Working Directory:
  C:\Users\zackm\AppData\Local\Strata\terminal\0.1.51
  ```
  **Underlying Engine Flags (from `hermes-strata-gyro-64k.json`)**:
  ```text
  --pack "C:\AI\Strata-data\packs\gyro-gyro-s"
  --native "C:\AI\Strata-data\models\gyro-Gyro-S\Qwen3.8-Flash-Next-Gyro-S-TQ1_0.gguf"
  --ple-gguf "C:\AI\Strata-data\models\gyro-Gyro-S\Qwen3.8-Flash-Next-Gyro-S-TQ1_0.gguf"
  --expert-profile "C:\Users\zackm\AppData\Local\Strata\terminal\0.1.51\data\expert-profile.bin"
  --expert-cache auto
  --prefill auto
  --spec 3
  --spec-min-p 0.6
  --mtp "C:\AI\Strata-data\mtp\rt"
  --max-context 131072
  --kv int8
  --adapt-async 1
  --resident-experts
  --resident-budget-gib 13
  --vision
  --adapt-every 1
  --adapt-swaps 160
  --adapt-decay 0.97
  ```
  **Engine Environment Variables**:
  ```text
  STRATA_RESIDENT_PIN=1
  STRATA_RESIDENT_HEADROOM_GIB=3
  STRATA_ALLOWED_HOSTS=strata-service:8080,host.docker.internal:8080,localhost:8080,127.0.0.1:8080
  ```
- **Drafting Mode in Effect**: MTP active via flags (`--spec 3 --spec-min-p 0.6 --mtp C:\AI\Strata-data\mtp\rt`; draft head over 106,299 tokens, 876 MiB VRAM).
- **KV Mode & Residency**: `--kv int8`, KV-streaming OFF (`--kv-grow is off`), KV fully VRAM resident.
- **Expert Cache Mode & Profile**:
  - Mode: `auto` (allocates 2,602 resident experts in GPU VRAM cache, 6.21 GiB in RAM).
  - Profile File: Present (`C:\Users\zackm\AppData\Local\Strata\terminal\0.1.51\data\expert-profile.bin`, 196,632 bytes, 24,576 ranked pairs).
- **CPU Pool Worker Count**: 7 pool workers (logical processors 2,4,6,8,10,12,14; host on 0).
- **Idle Memory State**:
  - Dedicated VRAM: 9.95 GB used / 16.0 GB total (5,622 MiB free in engine).
  - System RAM: 2.48 GB free / 31.93 GB total (Available commit: 21.3 GB).
- **Setup `--calibrate` Status**: **NEVER RUN** (confirmed via `tuning\recheck.json` pending calibration record and absence of calibration output profiles).

---

## Phase 1 — Pre-Update Baseline (Untouched Install: Strata 0.1.52 / App 0.2.7)
*Captured*: 2026-11-09T08:32:22Z  
*Method*: Byte-identical programmatically generated fixtures, greedy decode (temp=0.0).  
*Time Budgeting*: Trimmed per Owner Order 5 hierarchy to keep matrix ≤15m budget (Code-48K and JSON-48K dropped; 100K generation halved to 300 tokens).

| Cell | Context Tier | Content Type | Prompt Tokens | Gen Tokens | Decode (tok/s) | Prefill (tok/s) | TTFT (s) | Draft Accepted | Total Duration |
|---|---|---|---|---|---|---|---|---|---|
| `prose-4k` | ~4K | Prose Spec | 3,638 | 600 | **23.8** | 136.4 | 26.67s | 78.8% | 51.9s |
| `code-4k` | ~4K | TS Code | 7,418 | 600 | **18.0** | 127.7 | 58.09s | 78.5% | 91.4s |
| `json-4k` | ~4K | JSON Payload | 14,278 | 600 | **16.6** | 136.6 | 104.55s | 84.0% | 140.8s |
| `prose-48k` | ~48K | Prose Spec | 41,338 | 600 | **22.0** | 138.0 | 299.62s | 78.5% | 327.6s |
| `code-48k` | ~48K | TS Code | — | — | *TRIMMED* | — | — | — | — |
| `json-48k` | ~48K | JSON Payload | — | — | *TRIMMED* | — | — | — | — |
| `prose-100k` | ~100K | Prose Spec | 89,490 | 300 | **20.3** | 153.2 | 316.77s | 75.9% | 331.6s |

### Behavioral Fingerprint (Pre-Update Baseline):
- **JSON-vs-Prose Spread @ 4K**: Prose decodes at **23.8 tok/s**, JSON decodes at **16.6 tok/s** (Spread: **-7.2 tok/s** / **-30.3%** slower on structured JSON).
- **Context Scaling**:
  - Decode drops slightly from 23.8 tok/s at 4K to 22.0 tok/s at 48K and 20.3 tok/s at 100K.
  - Prefill throughput scales linearly around **136–153 tok/s**.
  - Draft acceptance remains stable at **75.9% – 84.0%** across all context tiers.

---

## Phase 2 — Update (Strata Engine & Control)
*Completed*: 2026-11-09T08:39:52Z  
*Update Path*: Native `strata.py update --model-config "C:\Users\zackm\AppData\Local\Strata\launch\hermes-strata-gyro-64k.json"` (Feed: `https://github.com/Niko1221/Strata/releases/latest/download`, sequence 122).  
*Package Installed*: `0.1.58 windows-x86_64-hip-rx9070` (571 MB) + Control `0.1.58`.  
*Version Transition*:
- Strata Engine: `0.1.52` -> `0.1.58` (`0.1.58-windows-x86_64-hip-rx9070`, SHA verified, test start passed in 28s).
- Strata Control: `0.1.53` -> `0.1.58`.
- Forced Flag Diff: None (0 changes required; identical JSON configuration accepted without deprecation).

### Verification Gate (Post-Update):
- [x] Engine starts via AI-ON path (`C:\AI\ai-control\AI-ON.ps1 -SkipHermes`): READY in 24.8s (PID 34548).
- [x] GET /slots answers and slot 0 is IDLE (`is_processing: false`, `n_prompt_tokens: 0`, `n_ctx: 131072`).
- [x] Sandbox preflight clean (`local-agentic-sandbox-web-ui:v-dc784c6-mw890nuk`, Host Runner healthy PID 14612 SHA 48d1d212).
- [x] Live platform chat turn verified: `npm run test:e2e:live -- l1-short-flow-copy.spec.ts` passed (1.4m elapsed, 0 pod restarts).

---

## Phase 3 — Post-Update Baseline (Strata 0.1.58 / App 0.2.7)
*Status*: IN PROGRESS
