# GKUC SiteOps — agent operating guide

Read this document, [README.md](README.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DECISIONS.md](docs/DECISIONS.md), [docs/PAYROLL.md](docs/PAYROLL.md), and [PROGRESS.md](PROGRESS.md) before changing this repository. `PROGRESS.md` is append-only and is the current handoff record.

## Product and safety boundary

GKUC SiteOps is a real internal construction-operations system for GKUC Construction and GKUC Readymix. It contains payroll, attendance, finance, supplier, employee and document records. Treat business calculations and database writes as high-impact.

- Do not deploy, restart PM2, alter a remote database, edit production `.env`, upload documents, or run destructive SQL unless the user explicitly asks for that external action.
- Do not expose credentials, tokens, private document URLs, database passwords, or production data in logs or replies.
- Do not replace, reset, delete, or overwrite unrelated work in a dirty tree. Check `git status --short` before editing.
- Preserve auditability. Prefer a reversible archive/status transition to destructive deletion. Payroll policies are archived with `archive_key`; historical policy, payroll, OT and claim records must remain readable.
- Existing approved or paid payroll must never be recalculated by a new policy. New rules affect future runs and explicitly regenerated Draft runs only.

## Required working practice

1. Inspect the existing route, calculation library, schema and frontend contract before changing a workflow.
2. Make the smallest coherent backend, frontend, validation and test change. Never create a frontend-only feature that cannot persist.
3. Run focused tests from `backend/` with Node 20 when possible:

   ```bash
   PATH=/Users/thinuladamsith/.nvm/versions/node/v20.12.2/bin:$PATH node --test test/<relevant>.test.js
   ```

4. Run `npm run build --prefix frontend` for frontend changes. API tests use a fixed test port and must not run in parallel.
5. Update the relevant documents and append a dated entry to `PROGRESS.md` in the same change set. Record what changed, why, validation run, and any known limit or decision still open.
6. In the final handoff, state exactly what was changed, validation actually run, and whether anything was deployed or written to a live database. Never imply a local code change was deployed.

## Documentation contract

- `PROGRESS.md` is append-only. Never rewrite earlier entries. Add a new dated section for every material code, data, workflow or decision change.
- Update `docs/PAYROLL.md` whenever payroll rules, rates, dates, calculations, policy storage, UI labels, or test coverage changes.
- Update `docs/ARCHITECTURE.md` whenever modules, routes, persistence, integrations, authorization or deployment behavior changes.
- Keep this file concise and cross-link instead of duplicating detailed rules. Tool-specific instruction files must point back here.

## Payroll non-negotiables

The authoritative current payroll rules are in `docs/PAYROLL.md`. Important implementation constraints:

- Rules are effective-dated per payroll company in `payroll_policies`; use the policy effective on each work date, not merely the policy on period end.
- The agreed new rule set begins **2026-01-01**. It must be saved for each payroll company through People → Payroll settings. The app has no authorization to silently write a live company policy from source code.
- Payroll policy edits are audited. They may affect future calculations and regenerated Draft runs; saved payslip snapshots remain unchanged.
- OT, late deductions, short-day earnings, work-day 1.5× premiums, allowances, EPF/ETF and salary advances have separate roles. Do not double charge the same time.
- Salary calculations must use saved inputs and persist their calculation detail. Exports and payslips must read saved payroll details, never current attendance or current policy values.

## Repository map

- `backend/src/index.js`: Express application composition and startup.
- `backend/src/schema.js`: idempotent MySQL schema and migration helpers. Additive migrations only; guard every new column/index/foreign key.
- `backend/src/routes/`: authenticated API routers. `payroll.js` owns policies, payroll generation, drafts and payslip data.
- `backend/src/lib/`: payroll calculations, attendance calculation, authorization, storage, documents, exports and other shared behavior.
- `backend/test/`: Node tests. Run from `backend/`.
- `frontend/src/pages/`: page/module UI. `People.jsx` owns payroll settings UI.
- `frontend/src/api.js`: authenticated API wrapper and shared formatting.
- `frontend/src/ui.jsx`: shared form/table/modal primitives.

## General application decisions

- Stack: React 19 + Vite frontend; Express 4 + Node ESM backend; MySQL via `mysql2`; Zod request validation; no ORM.
- Server-side authorization is mandatory: the UI can hide actions but routes must use `auth`, `permit`, validation, company scope and audit logging.
- The application supports two payroll companies. Employee pay company determines which employees appear in a company payroll; payroll runs, policies and totals are company-scoped.
- People, materials and vehicles are shared where the product indicates. Never infer cross-company finance access without checking route scope.
- Uploads use the configured storage driver. Storage access errors and provider configuration must be diagnosed separately from application bugs.
- Avoid mocks for production behavior. Use real API contracts and persistence.

## Tool-specific copies

The following are intentionally short pointers to avoid conflicting instructions:

- `.codex/AGENTS.md`
- `.openai/AGENTS.md`
- `.claude/CLAUDE.md`
- `.cursor/rules/gkuc-siteops.mdc`
