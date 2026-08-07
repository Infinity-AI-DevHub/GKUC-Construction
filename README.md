# GKUC SiteOps

Full-stack construction operations product based on the approved proposal. The React client and secured Node API are served as one application with a persistent MySQL database.

## Structure

```text
gkuc-construction/
├── frontend/
│   ├── src/              React application and styles
│   ├── index.html
│   ├── vite.config.js    Development API proxy
│   └── package.json      Frontend dependencies and commands
├── backend/
│   ├── src/              Express API, authentication and MySQL data layer
│   ├── test/             Isolated MySQL integration tests
│   ├── .env.example      Backend environment template
│   └── package.json      Backend dependencies and commands
├── package.json          Workspace orchestration commands
└── pnpm-workspace.yaml
```

## Run locally

```bash
pnpm install
pnpm build
pnpm start
```

Open `http://127.0.0.1:4173/`.

Client review accounts use the temporary password `GKUC@2026`:

| Role | Email |
| --- | --- |
| Owner / Director | `owner@gkuc.lk` |
| Project Manager | `manager@gkuc.lk` |
| Site Supervisor | `supervisor@gkuc.lk` |
| Storekeeper | `store@gkuc.lk` |

Change all passwords before live use.

## Included

- Secure 12-hour sessions and password hashing
- Role-based write permissions
- Persistent MySQL projects, tasks, attendance, materials, fleet, users, notifications, and daily reports
- Transactional stock movements and immutable audit logs
- Server-side validation and consistent API errors
- Responsive operational dashboard
- Production build served by the Node application

## Production build

```bash
pnpm build
pnpm test
```

## MySQL

Copy `backend/.env.example` to `backend/.env` and set the MySQL connection values. The application creates and migrates its tables inside the existing database at startup. The database itself must exist before first start.

```sql
CREATE DATABASE gkuc_siteops CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

For production, create a dedicated MySQL user restricted to `gkuc_siteops`; do not deploy with the MySQL `root` account. Use scheduled `mysqldump --single-transaction` backups and test restoration regularly.

WhatsApp/SMS, email, accounting, cloud file storage, and public hosting require client-owned provider accounts and credentials. They should be configured through environment variables and provider adapters rather than committed to this repository.
