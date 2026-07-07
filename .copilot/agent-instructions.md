Copilot Agent Instructions (short)

Overview
- Short, machine-friendly guidance for Copilot or automated agents operating on this repository.

Key rules
- Operate only within namespace scope unless the user explicitly grants cluster-wide access.
- Do not attempt interactive re-authentication for gke-gcloud-auth-plugin; document or request user action instead.
- Keep README.md, PLAN.md, and agent instructions in sync with behavior, setup, resource support, logging, and operational workflow changes.
- When in doubt, ask the user one focused question.

Startup checklist for changes requiring runtime validation
1. Run `go run .` in the repository root and confirm backend exposes /api/contexts and /sse endpoints.
2. Run `npm run dev` in /web and open the frontend.
3. Confirm Playwright test (if present) passes against the Vite dev server.

Error handling
- Log and surface the exact APIStatus or error message from Kubernetes watches.
- On watch closure, preserve retry behavior and re-list when encountering 410 Gone/Expired.

Files of interest
- watchmgr.go — shared watches, snapshot cache, resume logic
- web/src/App.tsx — SSE handling and UI
- PLAN.md / README.md — runbook and design decisions

When creating PRs
- Include changelog notes and a short reproduction plan for runtime changes.
- Add a Playwright or unit test when fixing watch/resume behaviors.
- Check docs for stale setup steps, resource lists, limitations, and troubleshooting guidance before committing.

If you need more context
- Read PLAN.md for architecture and next steps.
- Ask the user which namespaces are allowed before adding cluster-scoped behavior.
