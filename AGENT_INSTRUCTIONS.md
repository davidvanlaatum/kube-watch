Agent Instructions for kube-watch

Purpose
- Provide concise, actionable guidance for automated agents and humans acting as agents to develop, test, and operate the kube-watch project.

Agent Persona
- Conservative: prefer asking for clarification over guessing.
- Privilege-aware: do not request or assume cluster-wide credentials. Operate only in namespaces declared in kubeconfig.
- Observable: log important steps, errors, and assumptions.

Primary Objectives
1. Ensure the Go backend reliably lists and watches namespaced Kubernetes resources and provides an in-memory snapshot for new subscribers.
2. Keep the Vite + React frontend simple: connect to SSE, render a "top" view, and handle reconnects/fresh snapshots.
3. Support resource details including YAML, events, and Pod/Deployment logs while maintaining Go, Vitest, and Playwright test coverage.

What agents may do
- Modify Go code in the repository root and frontend code under /web to fix bugs and add features per the project plan.
- Run local builds, linters, and targeted tests. Use existing npm/go test scripts; do not add new global tools unnecessarily.
- Create or update documentation (README.md, PLAN.md, AGENT_INSTRUCTIONS.md).
- Keep documentation current whenever behavior, setup, architecture, resource support, logging, or operational workflows change.

What agents must not do
- Commit secrets (tokens, service account keys, credentials) into the repository.
- Assume interactive auth is available for gke-gcloud-auth-plugin; prefer documenting required manual steps or adding support for non-interactive service accounts.
- Make destructive infra changes or publish Docker images without explicit approval.

Runbook (dev/test)
- Start backend: go run .
- Start frontend (dev): cd web && npm install && npm run dev
- Use the Vite dev server for browser/headless testing; it proxies API/SSE/log requests to the Go backend.
- Check backend structured slog output on stdout; Vite dev server logs are available from `npm run dev`.
- Kubeconfig loading should use client-go default loading rules so `$KUBECONFIG` multi-file setups match kubectl behavior.
- Pod/Deployment log streaming uses `/logs/{context}/{resource}/{namespace}/{name}` and should preserve multiple-container behavior with container tabs.
- Table filtering is client-side; keep name/status/label filters and resource-specific quick toggles consistent with displayed table semantics.
- Release builds inject version metadata through GoReleaser ldflags; keep `/api/version` and the UI update notice working when changing release config.
- `kube-watch selfupdate` downloads GitHub Release assets, verifies `checksums.txt`, and replaces the current executable on macOS/Linux; Windows updates are manual archive replacement. Keep this flow tested when release asset naming changes.
- Use the [release number policy](PLAN.md#release-number-policy) to choose a candidate `vMAJOR.MINOR.PATCH` tag from externally observable behavior, not from the size of the diff alone or from dependency versions. Before choosing the exact version, creating a release PR, creating a tag, or pushing a tag, confirm the version and release scope with the operator; do not infer authorization from completed review or passing CI.
- Releases are created by pushing semantic version tags shaped as `vX.Y.Z`; the tag workflow validates the project and runs GoReleaser. The repository must protect `v*` tags and require approval on the release environment, and the tag must point to the exact reviewed `main` commit. Publish only after the operator explicitly authorizes that exact release action.
- Run checks before committing runtime changes: prefer `go test -race ./...` where possible, then from `/web` run `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`, and relevant builds.
- Go coverage is reported in CI with pull-request comments and a provisional 30% threshold, and the badge is updated through the dedicated coverage Gist. Treat coverage reductions in changed areas as review findings even while the aggregate threshold is intentionally low. Frontend coverage is a separate task.
- Go lint findings are currently informational while the existing baseline is cleaned up; do not add new findings in changed code.

Testing guidance
- Add Vitest tests for component logic and Playwright tests for user-visible browser behavior.
- Use mocked API/SSE streams for deterministic UI tests unless the task specifically requires a real cluster.
- Keep tests targeted and fast.

Escalation & Questions
- If unclear about namespaces to watch, ask the user which namespaces are permitted.
- If gke plugin fails due to expired gcloud credentials, request the user to run `gcloud auth login` or provide a non-interactive token path.

Pull requests & commits
- Make small, reviewable changes. Use descriptive commit messages. Include Co-authored-by trailer for Copilot commits when requested.
- Start implementation from an up-to-date `main` and use a focused feature branch; do not commit directly to `main` unless explicitly requested.
- Immediately `git add` every newly created file that is intended to be committed, so untracked files cannot be omitted from validation, review, or release changes.
- Before committing, check README.md, PLAN.md, and agent instructions for stale setup steps, resource lists, limitations, or troubleshooting guidance.
- For non-trivial direct agent changes, run a pre-commit review pass even when no PR is created. Cover these lenses: Senior Go/TypeScript (Go concurrency, locking, channels, watch lifecycle; TypeScript/React hook dependencies, EventSource lifecycle, browser routing, UI state consistency, and error handling), Senior QA (regression coverage, browser/SSE/log behavior), Kubernetes/ops (RBAC, kubeconfig, GKE exec plugin, resourceVersion semantics), Security (credentials, self-update, TLS, redaction), and Release/docs (GoReleaser, versions, install/upgrade docs). Use the PR template when a PR is created.
- Fix actionable in-scope review findings before committing, re-run relevant validation, and repeat the review/fix/validate loop until no actionable in-scope feedback remains. If any review feedback is not actioned, call it out with the reason.
- Keep pull requests draft until required validation and review feedback are complete; mark them ready only after the latest commit has passing CI.

Contact points
- Provide logs, failing test output, and steps to reproduce with any bug report.

Security
- Never exfiltrate kubeconfig or secrets. When debugging, redact sensitive fields.
- kube-watch intentionally displays Kubernetes Secret `data` and `stringData` in the local details YAML when the active kubeconfig user is authorized to read them. Do not treat this as a bug by default; document any review concern as an accepted local/operator-use risk unless the change broadens access, persists secrets, logs them, or sends them outside the local browser/backend session.

Notes
- Prefer conservative changes that preserve current behavior. When adding persistence or new flags, make them opt-in behind flags.
