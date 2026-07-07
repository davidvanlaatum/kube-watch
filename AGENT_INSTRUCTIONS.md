Agent Instructions for kube-watch

Purpose
- Provide concise, actionable guidance for automated agents and humans acting as agents to develop, test, and operate the kube-watch project.

Agent Persona
- Conservative: prefer asking for clarification over guessing.
- Privilege-aware: do not request or assume cluster-wide credentials. Operate only in namespaces declared in kubeconfig.
- Observable: log important steps, errors, and assumptions.

Primary Objectives
1. Ensure the Go backend reliably lists and watches namespaced Kubernetes resources and provides an in-memory snapshot for new subscribers.
2. Keep the Node frontend simple: connect to SSE, render a "top" view, and handle reconnects/fresh snapshots.
3. Add robust 410 Gone handling, CLI flags (port, log-level, persist-cache), and tests (Playwright + unit tests) as requested.

What agents may do
- Modify code under /go and /web to fix bugs and add features per the project plan.
- Run local builds, linters, and targeted tests. Use existing npm/go test scripts; do not add new global tools unnecessarily.
- Create or update documentation (README.md, PLAN.md, AGENT_INSTRUCTIONS.md).

What agents must not do
- Commit secrets (tokens, service account keys, credentials) into the repository.
- Assume interactive auth is available for gke-gcloud-auth-plugin; prefer documenting required manual steps or adding support for non-interactive service accounts.
- Make destructive infra changes or publish Docker images without explicit approval.

Runbook (dev/test)
- Start backend: cd go && go run .
- Start frontend (dev): cd web && npm install && npm run dev (or node server.js)
- Use FORCE_HTTP=true for headless/Playwright tests when TLS is unavailable.
- Check logs: go server stdout and web/server logs; tail them for debugging.

Testing guidance
- Add a Playwright test that runs with FORCE_HTTP and validates: initial snapshot delivered, ADDED/MODIFIED/DELETED flow, reconnect behavior.
- Keep tests targeted and fast.

Escalation & Questions
- If unclear about namespaces to watch, ask the user which namespaces are permitted.
- If gke plugin fails due to expired gcloud credentials, request the user to run `gcloud auth login` or provide a non-interactive token path.

Pull requests & commits
- Make small, reviewable changes. Use descriptive commit messages. Include Co-authored-by trailer for Copilot commits when requested.

Contact points
- Provide logs, failing test output, and steps to reproduce with any bug report.

Security
- Never exfiltrate kubeconfig or secrets. When debugging, redact sensitive fields.

Notes
- Prefer conservative changes that preserve current behavior. When adding persistence or new flags, make them opt-in behind flags.
