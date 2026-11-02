# GKUC SiteOps progress log

This file is append-only. Every material implementation, investigation, decision, data migration, deployment, test result or unresolved issue must receive a new dated entry. Do not rewrite historical entries. Link to the responsible code and documentation.

## Entry template

```md
## YYYY-MM-DD — concise title

- Decision / request:
- Changed:
- Data or deployment action:
- Validation:
- Open items / limits:
```

## 2026-11-02 — payroll rules made explicit and editable

- Decision / request: Replace inconsistent manual payroll treatment with transparent dated rules effective 2026-01-01. Keep OT and late independent. Apply the same rule values to GKUC Construction and GKUC Readymix, while retaining company-scoped policies and payroll runs.
- Changed: Added exact-minute OT, category/type 30/31-minute thresholds, 07:00 morning-OT cutoff, category-based late rates, a 15-minute late grace, actual-hours short-day pay, monthly 25-day 1.5× basic-rate premium, policy editing API/UI, and focused tests.
- Data or deployment action: No production policy or payroll was written in this repository session. After deployment, save a dated policy for each company through People → Payroll settings using the 2026-01-01 default.
- Validation: `node --test test/hr-payroll-rules.test.js test/attendance-payroll.test.js` from `backend/` passed. `npm run build --prefix frontend` passed.
- Open items / limits: The companies have matching values but remain separate effective-dated policies. Confirm any future requirement to centralize them into one shared policy record before changing data ownership.

## 2026-11-02 — durable agent documentation and handoff rules

- Decision / request: A new AI agent must be able to safely understand the architecture, durable product decisions, payroll specification and documentation workflow without relying on chat history.
- Changed: Added root `AGENTS.md`, tool-specific entrypoints for Codex/OpenAI/Claude/Cursor, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, and `docs/PAYROLL.md`. The root instructions require a documentation update and a new append-only progress entry with every material change.
- Data or deployment action: Documentation-only change; no application database or production service was changed.
- Validation: Verified tracked-exception paths, repository status and whitespace with `git diff --check`.
- Open items / limits: Generated documents under `docs/` remain ignored. Only the three hand-authored Markdown guides are tracked exceptions.
