kube-watch — Project Plan and Agent Instructions

Last updated: 2026-07-07

Overview

kube-watch is a prototype realtime Kubernetes watcher: a Go backend that discovers kubeconfig contexts and exposes per-context resource Server-Sent Events (SSE), and a Vite + React frontend that proxies SSE in dev and renders a live "top"-style view in the browser.

Goals

- Provide a simple, low-friction UI to observe live Kubernetes objects scoped to contexts and namespaces the user can access.
- Support kubeconfig exec plugins (gke-gcloud-auth-plugin) for GKE contexts.
- Be resilient to transient watch failures and reconnect cleanly, delivering a consistent view to clients.

Scope (prototype)

- Namespaced list+watch per context by default (respects RBAC); cluster-wide only if credentials permit.
- Shared watch per (context,resource,namespace) to reduce API pressure.
- In-memory snapshot cache per watch to populate new subscribers after page refresh.
- No persistent storage (cache lost on restart).

Architecture

- Backend (Go)
  - client-go dynamic client + unstructured objects.
  - WatchManager: maintains watchEntry per (context,GVR,namespace). Each entry: dynamic client, result watch loop, lastResourceVersion, in-memory cache of latest ADDED/MODIFIED events, broadcast to subscribers.
  - HTTP(S) server: endpoints
    - /api/contexts => [{name, namespace}, ...]
    - /api/version => build metadata plus latest GitHub release update status
    - /sse/{context}/{resource} => SSE event stream (ADDED/MODIFIED/DELETED + info/error messages)
    - /logs/{context}/{resource}/{namespace}/{name}?tailLines=200 => SSE event stream for pod/deployment logs
    - CLI command `selfupdate` => download latest compatible release, verify checksum, and replace the current binary
  - TLS: self-signed certs in ./certs for local HTTPS.

- Frontend (Vite + React + TypeScript)
  - Vite dev server proxies /api, /sse, and /logs to Go backend.
  - Production build outputs to web/dist and is embedded in the Go binary.

Key design decisions

- Dynamic client + unstructured: supports many resources without generating typed clients.
- Namespaced default: respecting RBAC is a priority; the backend reads context default namespace and watches that namespace. If cluster-list is permitted, cluster-scoped list/watch can be used (previous behavior) but the default avoids Forbidden errors.
- Shared watches: one watch per (context,resource,namespace) reduces duplicate API calls when multiple UI clients connect.
- In-memory snapshot cache: new subscribers receive the latest ADDED/MODIFIED events so UI refresh/population works even if the watch started earlier.
- Kubeconfig loading: client-go default loading rules are used so `$KUBECONFIG` multi-file configs and fallback to `~/.kube/config` behave like kubectl.
- Exec plugin support: clientcmd.NewNonInteractiveDeferredLoadingClientConfig is used so exec plugins (gke-gcloud-auth-plugin) work, but the host must have gcloud and valid credentials (gcloud auth login) for GKE contexts.

Current status (2026-07-07)

- Implemented: context discovery, namespaced list+watch, SSE endpoint, shared WatchManager, in-memory snapshot cache, frontend UI and proxy.
- Working: client-go/kubectl-style kubeconfig loading, contexts listing, stable context ordering, SSE streaming for namespaced resources, immediate snapshot delivery to new subscribers, client-side table filters, Vite dev proxy for local testing, embedded production UI, YAML/details panel with resource-scoped events, Pod/Deployment logs with per-container tabs, build-time version display with GitHub update checks, `selfupdate` release installation, structured slog lifecycle logs.
- CI: GitHub Actions runs Go tests, TypeScript type-checking, Vitest unit tests, Playwright Chromium tests, Vite build, and final Go binary build.
- Known limitations:
  - Snapshot is memory-only (lost on restart).
  - Multi-namespace cluster-wide view is limited when cluster-list is forbidden — current behavior watches the context default namespace.
  - Exec plugin requires interactive gcloud credentials if tokens expired; the backend cannot prompt — run `gcloud auth login` before starting.

Project milestones & plan

1) Stabilize (Immediate, 1-3 days)
   - Add --log-level flag for structured slog output.
   - Ensure clear user-facing SSE info/error messages for additional APIStatus cases.
   - Expand test coverage for watch reconnect/error paths and resource-specific table formatting.

2) UX & functionality (Short-term, 1-2 weeks)
   - Multi-namespace selection UI: allow user to specify additional namespaces to watch for a context (with sensible limits).
   - Row highlight animations, filter/search, counts per namespace.
   - Optionally persist snapshots to disk (small bolt DB) for faster warm-start across restarts (configurable).

3) GKE / Auth & CI (Short-term)
   - Validate gke-gcloud-auth-plugin in CI/workflow runner (ensure gcloud SDK + service account or token is available). Document requirements for CI testing.
   - Add a non-interactive auth path (service-account JSON, or GOOGLE_APPLICATION_CREDENTIALS) for automated/CI runs.

4) Packaging & productionization (Medium-term)
   - Docker images for backend and frontend.
   - Helm chart or k8s manifests to deploy inside a cluster (RBAC role, service account with cluster-wide or namespace-limited perms).
   - Add process manager / systemd unit or container entrypoint logic.

5) Scale & resilience (Long-term)
   - Replace ad-hoc watch loops with shared informer factories when scaling across many contexts/namespaces.
   - Rate limiting, backpressure handling for slow clients, metrics and tracing.

Agent / Operator instructions (runbook)

- Local development (interactive)
  1. Ensure tools: go (1.20+), node/npm, kubectl, (gcloud if using GKE contexts)
  2. Start backend (prefer interactive):
     go mod tidy
     go run .
     # Logs will print to stdout; use this for debugging exec plugin failures and watch errors.
  3. Start frontend dev server:
     cd web
     npm install
     npm run dev
  4. Open UI: http://localhost:5173
  5. For GKE contexts: run `gcloud auth login` before starting backend if your kubeconfig uses gke-gcloud-auth-plugin.

- Headless testing (Playwright)
  - Default Playwright tests start the Vite dev server automatically and mock API/SSE responses.
  - Use a real backend and GKE credentials only for explicit cluster integration tests.

- Debugging tips
  - If SSE stream shows {"error":"namespaced initial list failed: ... exec plugin failed"}: run `gcloud auth login` and restart the backend.
  - To inspect server logs: run backend interactively (go run .) or tail the log file if started with nohup.
  - If events stop: check structured logs for `cluster watch channel closed`, forbidden access, or 410/Expired re-list messages.

Contributing / PR checklist

- Run the backend locally and validate the UI connects and receives initial snapshot.
- Add unit, component, or Playwright tests for non-trivial logic and UI behavior.
- Keep README.md, PLAN.md, and agent instructions current when behavior, setup, resource support, logging, or troubleshooting changes.
- Follow the commit trailer convention when committing: include the Copilot Co-authored-by trailer if changes were assisted by the agent.

Acceptance criteria for completion

- A user with namespace-scoped access can open the UI, select their context, and see a populated list of objects for that namespace immediately after opening the stream.
- On refresh/reopen, the UI receives the cached snapshot and shows current items without waiting for new events.
- For GKE contexts, guidance in docs allows users to obtain tokens (gcloud auth login) and run the backend successfully.

Next actionable items (prioritized)

- Add CLI flags: --log-level, --port, --persist-cache (path).
- Add multi-namespace selection in the UI.
- Add containerization and simple Docker Compose for local integration testing.

Contact / ownership

- Repository owner: local developer (you)
- For changes requested to this plan, update PLAN.md (this file) and open a short PR describing the change.
