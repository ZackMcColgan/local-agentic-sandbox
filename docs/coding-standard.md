# Coding Standard — Functional First

This standard governs all new and refactored code in this repository. Every change is
expected to follow it, and every work brief cites it.

## The style

The codebase is written as **clean function calls**: small pure functions composed by thin
orchestrators. If a piece of logic cannot be tested by calling it with inputs and checking
the output, it is not finished.

## Rules

1. **Pure by default.** A function takes explicit inputs and returns a value. It does not
   read or write module-level mutable state, globals, the filesystem, the network, the
   clock, or randomness unless that effect IS its stated job.
2. **Effects at the edges.** I/O, disk, network, timers, and environment access live in thin
   orchestrator layers (route handlers, stores, the supervisor loop, the bridge). They gather
   data, call pure functions to decide, then act on the decision.
3. **Dependencies are parameters.** Anything a function needs is passed in — including
   functions (the seam pattern: a dispatch function, a generate function, a clock). No
   reaching into imports' internals or singletons from logic code.
4. **No new logic classes.** Classes only where a framework contract demands one (e.g. a
   checkpoint saver base class), kept thin and wrapped by functions. Workers and engines are
   orchestrators, not state silos.
5. **Immutability by default.** Do not mutate arguments; return new values. A shared cache
   must be explicit, size-capped, and owned by exactly one module that exposes it through
   functions.
6. **One responsibility per module, small files.** New logic goes in a module, never added
   to a god file (the eight named in the refactor plan) except one-line wiring. A file
   growing past ~600 lines needs its split named in the PR body.
7. **Tests call code.** Behavioral tests invoke the function and assert on outputs and
   observable effects. Source-text scraping tests are permitted ONLY for hygiene guards
   (banned names/patterns) and structural invariants (e.g. settings zone order), and must
   be labeled as guards, not behavior tests. When a refactor extracts a seam that scraping
   tests covered, the same PR replaces them with real call tests.
8. **Tests first.** A new function lands with its test in the same commit. A bug fix starts
   with the failing test. No existing test is weakened, skipped, or deleted.
9. **Errors are data.** Return result objects where the surrounding code does; never swallow
   an error silently. A failure the caller cannot see is a defect.
10. **Names say what the thing does.** Verbs for functions, nouns for data. No codenames,
    no tool or builder names, no abbreviations that hide meaning.

## Verify contract (every change)

- Targeted tests for the touched modules pass; `tsc --noEmit` is clean.
- `npm run test:gate` passes; the full `npm run test` passes before push.
- The PR body states which functions were added or extracted and how each is tested.
