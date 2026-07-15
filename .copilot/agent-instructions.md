Copilot Agent Instructions (short)

Overview
- Short, machine-friendly guidance for Copilot or automated agents operating on this repository.

Key rules
- Operate only within namespace scope unless the user explicitly grants cluster-wide access.
- Do not attempt interactive re-authentication for gke-gcloud-auth-plugin; document or request user action instead.
- Keep README.md, PLAN.md, and agent instructions in sync with behavior, setup, resource support, logging, and operational workflow changes.
- When in doubt, ask the user one focused question.

Startup checklist for changes requiring runtime validation
1. Run `go run .` in the repository root and confirm backend exposes /api/contexts, /api/version, /sse, and /logs endpoints.
2. Run `npm run dev` in /web and open the frontend.
3. For release workflow changes, keep `kube-watch selfupdate` aligned with GoReleaser asset naming and checksums.
4. Run relevant checks: prefer `go test -race ./...` where possible, then from `/web` run `npm run typecheck`, `npm run test:unit`, and `npm run test:e2e`.

Error handling
- Log and surface the exact APIStatus or error message from Kubernetes watches.
- On watch closure, preserve retry behavior and re-list when encountering 410 Gone/Expired.

Files of interest
- watchmgr.go — shared watches, snapshot cache, resume logic
- selfupdate.go — GitHub Release download, checksum verification, and binary replacement
- web/src/App.tsx — SSE handling and UI
- PLAN.md / README.md — runbook and design decisions

When creating PRs
- Include changelog notes and a short reproduction plan for runtime changes.
- Add Go, Vitest, or Playwright coverage for behavior changes where practical.
- Immediately `git add` every newly created file that is intended to be committed, so untracked files cannot be omitted from validation, review, or release changes.
- Check docs for stale setup steps, resource lists, limitations, and troubleshooting guidance before committing.
- For non-trivial direct agent changes, run a pre-commit review pass even when no PR is created. Cover Senior Go/TypeScript, Senior QA, Kubernetes/ops, Security, and Release/docs review lenses. Use the PR template when a PR is created.
- Fix actionable in-scope review findings before committing, re-run relevant validation, and repeat the review/fix/validate loop until no actionable in-scope feedback remains. If any review feedback is not actioned, call it out with the reason.

If you need more context
- Read PLAN.md for architecture and next steps.
- Ask the user which namespaces are allowed before adding cluster-scoped behavior.
