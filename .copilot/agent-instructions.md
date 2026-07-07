Copilot Agent Instructions (short)

Overview
- Short, machine-friendly guidance for Copilot or automated agents operating on this repository.

Key rules
- Operate only within namespace scope unless the user explicitly grants cluster-wide access.
- Do not attempt interactive re-authentication for gke-gcloud-auth-plugin; document or request user action instead.
- When in doubt, ask the user one focused question.

Startup checklist for changes requiring runtime validation
1. Run `go run .` in /go and confirm backend exposes /api/contexts and /sse endpoints.
2. Run `node server.js` in /web (or npm run dev) and open frontend (FORCE_HTTP=true for tests).
3. Confirm Playwright test (if present) passes with FORCE_HTTP.

Error handling
- Log and surface the exact APIStatus or error message from Kubernetes watches.
- On watch closure, implement exponential backoff and re-list when encountering 410 Gone.

Files of interest
- go/watchmgr.go — shared watches, snapshot cache, resume logic
- web/static/app.js — SSE handling and UI
- PLAN.md / README.md — runbook and design decisions

When creating PRs
- Include changelog notes and a short reproduction plan for runtime changes.
- Add a Playwright or unit test when fixing watch/resume behaviors.

If you need more context
- Read PLAN.md for architecture and next steps.
- Ask the user which namespaces are allowed before adding cluster-scoped behavior.
