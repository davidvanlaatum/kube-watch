kube-watch — prototype

Overview
- Go backend: discovers kubeconfig contexts, opens watches to clusters/resources and exposes SSE endpoints over HTTPS (self-signed certs in ./certs).
- Node frontend: serves static UI and proxies /api and /sse to the Go backend. Browser tabs show one resource type per cluster; connections are opened lazily.

Quick start (local)
1. Ensure kubectl and gcloud (if using GKE) are installed and kubeconfig has contexts that can authenticate (gke-gcloud-auth-plugin supported by client-go exec plugin).

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

Notes & next steps
- Current implementation is a prototype: watches use dynamic client and basic list-then-watch logic with in-memory resume.
- It supports: pods, deployments, services, jobs, cronjobs, configmaps, secrets, events.
- Improvements: add informer factories, backpressure, per-resource rate limiting, more robust reconnection with resourceVersion resumption and 410 handling, authentication fallback, UI filters.

Troubleshooting & operational notes
- Logs: run the backend interactively with `go run .` to see logs on stdout (recommended). If started with nohup, write logs to a local `*.log` file.

- gke / gcloud auth: contexts that use `gke-gcloud-auth-plugin` require `gcloud` credentials accessible to the Go process. Run `gcloud auth login` (interactive) before starting the backend so the exec plugin can obtain tokens.

- Snapshot cache behavior: the backend maintains an in-memory snapshot per (context,resource,namespace). When a new browser client subscribes it immediately receives the last-known ADDED/MODIFIED objects (so refreshing the page repopulates state). The snapshot is memory-resident and lost when the server restarts.

- Reconnect behavior: watches are namespaced (per-context default namespace) to match RBAC-limited users. The server attempts to resume using resourceVersion when possible; explicit 410 handling (re-list on Gone) is a planned improvement.

Agent / operator instructions
- Start backend interactively:
  go mod tidy
  go run .

- Start frontend for local testing:
  cd web
  npm install
  npm run dev

- To run headless tests (Playwright) use HTTP and ensure GO_BACKEND points to your backend if needed.

If you'd like, I can add CLI flags for log level, snapshot persistence, or multi-namespace selection next.
