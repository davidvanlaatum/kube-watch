## Summary

-

## Validation

- [ ] `go test -race ./...`
- [ ] `go build -o kube-watch .`
- [ ] Web checks, if frontend changed: `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`, `npm run build`

## Review checklist

- [ ] Senior Go/TypeScript review: Go concurrency, context/cancellation, channel lifecycle, locking, error handling, and client-go watch behavior; TypeScript/React hook dependencies, EventSource lifecycle, browser routing, UI state consistency, and error handling.
- [ ] Senior QA review: regression coverage, deterministic tests, browser behavior, SSE/log reconnect scenarios, and edge cases.
- [ ] Kubernetes/ops review: kubeconfig loading, namespace/RBAC assumptions, GKE exec plugin behavior, resourceVersion/re-list semantics, and operational logs.
- [ ] Security review: no credential exposure, safe self-update/download behavior, checksum validation, TLS/auth implications, and secret redaction.
- [ ] Release/docs review: GoReleaser assets, version/self-update behavior, README/PLAN/agent instruction updates, and install/upgrade notes.

## Review follow-up

- [ ] Actionable in-scope review findings were fixed, relevant validation was re-run, and review/fix/validate was repeated until no actionable in-scope feedback remained.
- [ ] Any review feedback not actioned is listed here with the reason:
