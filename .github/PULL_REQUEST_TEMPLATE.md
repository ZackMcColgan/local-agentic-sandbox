## Summary

Describe the change and the board item it closes (e.g. `Closes #120`).

## Briefed Scope

List the full scope from the brief. A job is finished only when its briefed scope
is executed — opening a PR is not done.

## Verification

- [ ] `npm run test:gate` run and green (change-aware gate, scoped to touched files)
- [ ] `npm run format:check` green
- [ ] `npm run lint` green with zero warnings
- [ ] `npx tsc --noEmit -p web-ui/tsconfig.json` green
- [ ] Target branch is `develop` (never commit to `develop` directly, never merge to `main`)
- [ ] No agent/tool brand names in repo files or commit messages
- [ ] No personal information committed to repo files
- [ ] UI work checked on the phone (owner acceptance is final; green tests do not prove the screen is right)

## Notes and Assumptions

Record any decisions made from the brief and anything left BLOCKED with the exact
error.

## Dependency / Security Notes

If this PR touches dependencies, container images, egress, or the host-bridge
approval gate, call it out explicitly — those surfaces are security boundaries.
