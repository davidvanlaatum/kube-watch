kube-watch — prototype

Overview
- Go backend: discovers kubeconfig contexts, opens watches to clusters/resources and exposes SSE endpoints over HTTPS (self-signed certs in ./certs).
- Vite + React frontend: proxies /api, /sse, and /logs during development and is embedded into the Go binary from web/dist for production.
- Pod and Deployment details include a Logs tab that tails all containers, defaults to the last 200 lines, and live-follows new log lines.
- Released binaries include build-time version metadata and the UI checks GitHub for newer releases.
- Resource tables include client-side filters for name, status, labels, and resource-specific quick toggles such as pod restarts and readiness.

Quick start (local)
1. Ensure kubectl and gcloud (if using GKE) are installed and kubeconfig has contexts that can authenticate (gke-gcloud-auth-plugin supported by client-go exec plugin). Kubeconfig loading follows client-go/kubectl-style defaults, including `$KUBECONFIG` with multiple files and fallback to `~/.kube/config`.

2. Start Go backend (it will generate self-signed certs in ./certs):
   go mod tidy
   go run .

3. In another shell, start the Vite dev server:
   cd web
   npm install
   npm run dev

4. Open http://localhost:5173. Vite will proxy API and SSE to the Go backend at https://localhost:9443.

Production build:
   cd web
   npm run build
   cd ..
   go build -o kube-watch .

Tests:
   go test ./...
   cd web
   npm ci
   npm run typecheck
   npm run test:unit
   npx playwright install chromium
   npm run test:e2e

CI:
- GitHub Actions runs on pushes to `main` and pull requests.
- CI runs Go tests, web type-checking, Vitest unit tests, Playwright Chromium tests, the Vite production build, and the final Go binary build with embedded web assets.

Release build:
- Pushing a tag that matches `vX.X.X` runs GitHub Actions with GoReleaser.
- GoReleaser runs `npm ci --prefix web` and `npm run build --prefix web` before compiling so released binaries embed the production UI from `web/dist`.
- GoReleaser injects version, commit, and build date into the binary. The UI reads `/api/version` and links to the latest GitHub Release when a newer version is available.
- Release artifacts are built for Linux, macOS, and Windows on amd64 and arm64, with checksums uploaded to the GitHub Release.

Notes & next steps
- Current implementation is a prototype: watches use dynamic client and basic list-then-watch logic with in-memory resume.
- It supports: pods, deployments, statefulsets, replicasets, services, jobs, cronjobs, horizontal pod autoscalers, configmaps, secrets, serviceaccounts, poddisruptionbudgets, networkpolicies, events.
- Logs are supported for pods and deployments. Pod logs stream every container in the selected pod. Deployment logs watch all currently matching pods, start following new matching pods, stop following removed pods, and group output by container name with pod-name prefixes.
- Improvements: add informer factories, backpressure, per-resource rate limiting, authentication fallback, UI filters, and optional persisted snapshots.

Troubleshooting & operational notes
- Logs: run the backend interactively with `go run .` to see structured slog output on stdout (recommended). Watch/subscription open/close, forbidden access, and reconnect conditions are logged with cluster, namespace, and resource fields.

- gke / gcloud auth: contexts that use `gke-gcloud-auth-plugin` require `gcloud` credentials accessible to the Go process. Run `gcloud auth login` (interactive) before starting the backend so the exec plugin can obtain tokens.

- kubeconfig loading: the backend uses client-go default loading rules, so it honors `$KUBECONFIG` including multiple files separated by the OS path-list separator (`:` on macOS/Linux) and falls back to `~/.kube/config`.

- Snapshot cache behavior: the backend maintains an in-memory snapshot per (context,resource,namespace). When a new browser client subscribes it immediately receives the last-known ADDED/MODIFIED objects (so refreshing the page repopulates state). The snapshot is memory-resident and lost when the server restarts.

- Reconnect behavior: watches are namespaced (per-context default namespace) to match RBAC-limited users. The server attempts to resume using resourceVersion when possible and re-lists on 410/Expired. Forbidden list/watch failures are treated as terminal for that subscription and surfaced to the UI.

- Log streaming: `/logs/{context}/{resource}/{namespace}/{name}?tailLines=200` streams Server-Sent Events for pod/deployment logs. The UI lets you change `tailLines` up to 5000 and keeps following live output.

Agent / operator instructions
- Start backend interactively:
  go mod tidy
  go run .

- Start frontend for local testing:
  cd web
  npm install
  npm run dev

- Playwright tests start the Vite dev server automatically and mock API/SSE responses for deterministic UI coverage.

Next planned improvements include CLI flags for log level, snapshot persistence, and multi-namespace selection.
