# ORBIT Backend Server

Production-grade multi-tenant SaaS API for digital marketing agencies — authentication, RBAC, client portal, task lifecycle, file attachments, Redis caching, and real-time permission resolution.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ (ES modules) |
| Framework | Express 5.2 |
| Database | MongoDB + Mongoose 8 |
| Cache | Redis via ioredis (permissions, rate limiting) |
| File Storage | Cloudflare R2 (S3-compatible) |
| Auth | JWT RS256 per-entity RSA key pairs |
| Authorization | Dynamic RBAC with Redis-cached permissions |
| Email | Nodemailer (SMTP) |
| Security | helmet, rate-limit-redis, bcryptjs 12 rounds, httpOnly cookies, NoSQL sanitizer |

## Quick Start

```bash
npm install
node --env-file .env index.js
```

Redis is optional — the server falls back to in-memory rate limiting and no permission caching if Redis is unavailable.

## Environment Variables

```env
PORT=3001
NODE_ENV=production
FRONTEND_URL=https://your-frontend.com
MONGO_URI=mongodb+srv://...
DB_NAME=orbit
REDIS_URL=redis://localhost:6379
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=orbit-attachments
```

## Architecture

```
orbit-server/
├── index.js                  Entry point, middleware, routes, lifecycle
├── app.js                    Express app factory (testable, no DB/server)
├── vitest.config.js          Test runner configuration
├── tests/
│   ├── setup.js              Global setup (MongoMemoryServer, seeds)
│   ├── helpers.js            Factory functions + auth helpers
│   └── *.test.js             8 test files, 188 tests total
├── db/
│   ├── connectDb.js          MongoDB connection (pooling, events)
│   └── redis.js              Redis client + cache helpers (get/set/del/pattern)
├── models/
│   ├── organization.model.js
│   ├── user.model.js
│   ├── client.model.js
│   ├── invite.model.js
│   ├── task.model.js
│   ├── requirement.model.js
│   ├── plan.model.js
│   ├── permission.model.js
│   └── role.model.js
├── routes/
│   ├── auth.js               Login, register, verify, forgot/reset, logout
│   ├── invite.js             Create, accept, revoke, resend invites
│   ├── user.js               Update, delete members, profile
│   ├── client.js             CRUD + archive + invite flow
│   ├── task.js               CRUD + lifecycle + file attachments
│   ├── client-portal.js      Client-facing portal endpoints
│   ├── role.js               RBAC role CRUD + assign
│   ├── permission.js         List platform permissions
│   └── requirement.js        Client requirements CRUD
├── middleware/
│   ├── auth.js               JWT verify + auto-refresh + permission resolution
│   └── permission.js         Permission gate
└── lib/
    ├── auth.js               Token generation, cookie helpers
    ├── crypto.js             SHA-256 token hashing
    ├── email.js              Email templates (invite, reset, client)
    ├── helpers.js            Shared DRY helpers (login, email check, name resolve)
    ├── multerConfig.js       File upload config (50MB, MIME whitelist)
    ├── storage.js            Cloudflare R2 (upload, delete, presigned URLs)
    ├── validate.js           Input validation + sanitization
    ├── plans.js              Plan definitions + default plan helper
    ├── permissions.js        15 permission keys (seed data)
    ├── roles.js              System roles + 5 default templates
    └── clientGuard.js        Plan-based client limit enforcement
```

## Entity Types

| Entity | Auth | Access |
|--------|------|--------|
| Organization | JWT RS256 (own key pair) | Full workspace control |
| User | JWT RS256 (own key pair) | RBAC-gated workspace access |
| Client | JWT RS256 (own key pair) | Portal only, fixed capabilities |

Each entity stores its own RSA 2048-bit key pair. Login resolves entity type automatically (Organization → User → Client).

## Authentication

```
Login → accessToken (15min) + refreshToken (2h or 7d) → httpOnly cookies
Middleware: verify → expired? auto-refresh → resolve entity → attach permissions
Logout: clear cookies + invalidate refresh token in DB
```

## RBAC

```
Platform Permissions (15 keys, seeded) → Organization Roles (custom) → Users
```

OWNER bypasses all checks. Clients bypass RBAC entirely.

### 15 Permission Keys

`PAGE_DASHBOARD` `PAGE_TASKS` `PAGE_CLIENTS` `PAGE_SETTINGS` `TASK_CREATE` `TASK_EDIT` `TASK_DELETE` `TASK_VIEW_ALL` `TASK_MOVE_OWN` `TASK_REVIEW` `TASK_SEND_TO_CLIENT` `TASK_CLIENT_DECISION` `CLIENT_MANAGE` `USER_INVITE` `ROLE_MANAGE`

### Default Role Templates (per org)

| Role | Scope |
|------|-------|
| OWNER (system) | All 15 permissions |
| MEMBER (system) | Dashboard + tasks (move own) |
| Manager | All task + client + settings + invite |
| Editor | Tasks (create, edit, view all, review) + clients |
| Social Media Manager | Tasks (create, edit, move, send, client decision) |
| Graphic Designer | Dashboard + tasks (move own) |
| Secretary | Tasks + clients + settings + invite (no review/send) |

## Task Lifecycle

```
TODO → DOING → READY_FOR_REVIEW → SENT_TO_CLIENT → DONE
                     │                    │
                     └──── REVISION ◄─────┘
                              │
                              └→ DOING (rework)
```

| From | To | Permission |
|------|----|-----------|
| TODO | DOING | assignee |
| DOING | READY_FOR_REVIEW | assignee |
| READY_FOR_REVIEW | SENT_TO_CLIENT | TASK_SEND_TO_CLIENT |
| READY_FOR_REVIEW | REVISION | TASK_REVIEW |
| SENT_TO_CLIENT | DONE | TASK_CLIENT_DECISION |
| SENT_TO_CLIENT | REVISION | TASK_CLIENT_DECISION |
| REVISION | DOING | assignee |

Every move appends to `history[]`: `{ from, to, by, byName, note, at }`.

Visibility: OWNER or TASK_VIEW_ALL sees all tasks; others see assigned/created only.

### Requirement ↔ Task Auto-Sync

- Any linked task starts → requirement moves to IN_PROGRESS
- All linked tasks DONE → requirement moves to COMPLETED
- A DONE task gets REVISION → requirement reverts to IN_PROGRESS
- CLOSED requirements skip auto-sync

### File Attachments (R2)

Two contexts: `reference` (create/edit) and `deliverable` (move/submit).

- Key pattern: `{orgId}/{taskId}/{uuid}-{filename}`
- Presigned URLs (1h expiry), no public access
- 50MB max per file, 10 files per upload
- Auto-cleanup on task deletion

## Client Portal

- Dashboard (stats), Requirements (create/comment/track), Tasks (approve/reject)
- Invite flow: team creates client → email sent (48h token) → client sets password → JWT session

## API Endpoints

All routes use POST with JSON body.

### Auth — `/api/auth`

| Route | Auth | Description |
|-------|------|-------------|
| /register | — | Create org + bootstrap roles |
| /login | — | Login (auto-detects entity type) |
| /verify | Cookie | Refresh session |
| /logout | Cookie | Clear session |
| /forgot-password | — | Send reset email |
| /reset-password | — | Reset with token |

### Invites — `/api/invites`

| Route | Permission | Description |
|-------|------------|-------------|
| / | USER_INVITE | Create invite |
| /accept | — | Accept + create user |
| /revoke | USER_INVITE | Revoke pending |
| /delete | USER_INVITE | Delete record |
| /resend | USER_INVITE | Resend email |
| /users | Auth | List users + pending |

### Users — `/api/users`

| Route | Auth | Description |
|-------|------|-------------|
| /update | Owner | Edit member |
| /delete | Owner | Remove member |
| /profile | Auth | Update own profile |

### Clients — `/api/clients`

| Route | Permission | Description |
|-------|------------|-------------|
| / | CLIENT_MANAGE | Create (plan-limited) |
| /list | Auth | List + plan usage |
| /update | CLIENT_MANAGE | Rename/archive/reactivate |
| /resend-invite | CLIENT_MANAGE | Resend invite |
| /requirements | Auth | List client requirements |

### Tasks — `/api/tasks`

| Route | Permission | Description |
|-------|------------|-------------|
| / | TASK_CREATE | Create + link requirement |
| /list | PAGE_TASKS | List (visibility-filtered) |
| /detail | PAGE_TASKS | Full task + history + attachments |
| /update | TASK_EDIT | Edit details |
| /move | varies | Transition status |
| /delete | TASK_DELETE | Delete + cleanup R2 |
| /upload | PAGE_TASKS | Upload files (multipart) |
| /attachment | PAGE_TASKS | Get presigned URL |
| /attachment/delete | TASK_EDIT | Remove attachment |

### Client Portal — `/api/client-portal`

| Route | Auth | Description |
|-------|------|-------------|
| /accept-invite | — | Set password + login |
| /dashboard | Client | Stats |
| /requirements | Client | Create requirement |
| /requirements/list | Client | List requirements |
| /requirements/detail | Client | Detail + comments |
| /requirements/comment | Client | Add comment |
| /tasks/list | Client | List tasks |
| /tasks/respond | Client | Approve/reject |
| /tasks/attachment | Client | Get file URL |

### Roles — `/api/roles`

| Route | Permission | Description |
|-------|------------|-------------|
| / | ROLE_MANAGE | Create role |
| /list | Auth | List + user counts |
| /update | ROLE_MANAGE | Update permissions |
| /delete | ROLE_MANAGE | Delete (users → MEMBER) |
| /assign | ROLE_MANAGE | Assign to user |

### Permissions — `/api/permissions`

| Route | Auth | Description |
|-------|------|-------------|
| /list | Auth | All 15 permissions (grouped) |

## Plans

| Plan | Max Active Clients |
|------|--------------------|
| FREE | 3 |
| STARTER | 10 |
| GROWTH | 50 |
| ENTERPRISE | 500 |

Only ACTIVE + INVITED clients count against the limit.


## Redis Usage

| Feature | Key Pattern | TTL |
|---------|-------------|-----|
| Permission cache | `perms:{entityId}` | 5 min |
| Rate limiting | `rl:{prefix}:{ip}` | 15 min |

Cache is invalidated on role update/delete, role assignment, and user role changes. Falls back gracefully if Redis is unavailable.

## Security

| Feature | Implementation |
|---------|---------------|
| HTTP headers | helmet (HSTS, X-Content-Type, CSP disabled) |
| Rate limiting | Redis-backed (fallback: memory), auth 15/15min, API 200/15min |
| NoSQL injection | Custom sanitizer strips `$`-prefixed keys from body, params, and query |
| Password hashing | bcryptjs, 12 rounds |
| Cookies | httpOnly, secure, SameSite strict |
| Token storage | Invite/reset tokens SHA-256 hashed before DB write |
| CORS | Credentials from FRONTEND_URL only |
| Input validation | Centralized in lib/validate.js |

## Startup Sequence

1. Connect MongoDB
2. Connect Redis (optional)
3. Seed Plans (4 tiers)
4. Seed Permissions (15 keys, upsert + cleanup)
5. Bootstrap System Roles (OWNER + MEMBER + 5 templates per org)
6. Start Express on PORT

Graceful shutdown: SIGINT/SIGTERM → close HTTP server → disconnect Redis → disconnect MongoDB.

## Testing

### Stack

| Tool | Purpose |
|------|---------|
| [vitest](https://vitest.dev/) | Test runner — fast, ESM-native, globals mode |
| [supertest](https://github.com/ladjs/supertest) | HTTP assertions against Express app |
| [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server) | In-memory MongoDB for isolated, repeatable tests |
| [@vitest/coverage-v8](https://vitest.dev/guide/coverage) | V8-based code coverage |

### Why This Stack

- **vitest** — native ESM support (no Babel needed), compatible with the project's `"type": "module"`, fast watch mode, built-in globals
- **mongodb-memory-server** — each test run gets a fresh MongoDB instance, no external database needed, no data pollution between CI runs
- **supertest** — full HTTP integration testing through the Express middleware stack (cookies, headers, auth, error handling)
- **Redis not required** — all cache functions gracefully return `null` when Redis is unavailable, so tests run without a Redis server

### Running Tests

```bash
# Run all tests once
npm test

# Run in watch mode (re-runs on file change)
npm run test:watch

# Run with V8 coverage report
npm run test:coverage
```

### Test Architecture

```
orbit-server/
├── app.js                    Express app factory (no DB/server lifecycle)
├── vitest.config.js          Test runner config
└── tests/
    ├── setup.js              Global setup (MongoMemoryServer, seed data)
    ├── helpers.js             Factory functions + auth helpers
    ├── auth.test.js           24 tests — register, login, verify, logout, reset, sanitization
    ├── invite.test.js         26 tests — create, accept, revoke, delete, resend
    ├── user.test.js           18 tests — update, delete, profile
    ├── client.test.js         22 tests — CRUD, archive, invite, plan limits
    ├── task.test.js           33 tests — CRUD, lifecycle, state machine, files
    ├── requirement.test.js    15 tests — list, filter, comment, status
    ├── role.test.js           21 tests — CRUD, assign, defaults, permissions
    └── client-portal.test.js  29 tests — accept, dashboard, requirements, tasks
```

**Total: 188 tests across 8 files covering all 9 route files**

### How It Works

1. **`app.js`** — Extracted `createApp()` factory that builds the Express app with all middleware and routes, without connecting to a database or starting a server. This decouples the app from infrastructure for testability.

2. **`tests/setup.js`** — Global `beforeAll` starts MongoMemoryServer, connects Mongoose, and seeds Plans + Permissions (required for auth and RBAC). Global `afterAll` drops the database and stops the server.

3. **`tests/helpers.js`** — Factory functions that create test entities with valid auth:
   - `createTestOrg()` — organization + owner JWT cookies
   - `createTestUser()` / `createTestUserWithRole()` — members with RBAC roles
   - `createTestClient()` / `createTestClientWithAuth()` — clients with portal JWT
   - `createTestTask()` / `createTestRequirement()` / `createTestInvite()`
   - `agent()` — singleton supertest agent with cookie persistence
   - `cleanDb()` — wipes all collections between tests (called in `beforeEach`)

4. **Sequential execution** — Tests run sequentially (`sequence.concurrent: false`) since they share a single MongoMemoryServer instance per worker.

### Test Coverage by Route

| Route File | Test File | Tests | What's Covered |
|------------|-----------|-------|----------------|
| auth.js | auth.test.js | 24 | Register (validation, duplicate), login (all entity types, invalid), verify, logout, forgot/reset password, NoSQL injection sanitization (body + query), 404 |
| invite.js | invite.test.js | 26 | Create (permission checks, duplicate, plan limits), accept (token validation, invite deletion), revoke, delete, resend, user list |
| user.js | user.test.js | 18 | Update (role change, validation), delete (invite cleanup), profile (name, email, password change) |
| client.js | client.test.js | 22 | Create (permission, plan limit, duplicate), list, update (rename, archive, reactivate), resend-invite, client requirements |
| task.js | task.test.js | 33 | Create (requirement linking), list (visibility rules), detail, update, move (all 7 transitions, invalid transitions, history tracking, requirement auto-sync), delete (requirement unlink) |
| requirement.js | requirement.test.js | 15 | List (pagination, client filter, status filter, search), detail, comment (add, validation), update-status (valid transitions) |
| role.js + permission.js | role.test.js | 21 | Create (validation, duplicate), list (user counts), update (permissions), delete (user reassignment to MEMBER), assign, reset-defaults, permission list (grouping) |
| client-portal.js | client-portal.test.js | 29 | Accept-invite (token validation, password set), dashboard (stats), requirements (create, list, filter, detail, comment), tasks (list, filter, approve/reject with requirement sync) |

### Production Bugs Found During Testing

Two bugs were discovered in [routes/client-portal.js](routes/client-portal.js) and fixed:

1. **`POST /requirements/list`** — `const { status } = req.body` crashed with `TypeError` when no body was sent (Express 5 leaves `req.body` as `undefined` when Content-Type is missing). Fixed to `req.body || {}`.

2. **`POST /tasks/list`** — Same issue with `const { statusFilter } = req.body`. Fixed to `req.body || {}`.

Both were silent 500 errors in production that only surfaced under test conditions (supertest sends POST with no Content-Type when `.send()` is omitted).

### Writing New Tests

```js
import { describe, it, expect, beforeEach } from "vitest";
import { agent, createTestOrg, cleanDb } from "./helpers.js";

describe("My Feature", () => {
  let org, cookies;

  beforeEach(async () => {
    await cleanDb();
    const result = await createTestOrg();
    org = result.org;
    cookies = result.cookies;
  });

  it("should do something", async () => {
    const res = await agent()
      .post("/api/my-route")
      .set("Cookie", cookies)
      .send({ key: "value" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });
});
```

## Design Decisions

- All routes use POST — REST relaxed, everything is JSON body
- Single `/move` endpoint — transitions ARE the workflow
- Three entity types with isolated RSA key pairs
- Clients bypass RBAC — fixed capabilities, own data only
- Permissions platform-owned, roles org-owned
- OWNER always bypasses — prevents lockout
- Requirement auto-sync with linked task progress
- File attachments via Cloudflare R2 with presigned URLs
- Tokens hashed before storage — safe even if DB is compromised
- Custom NoSQL sanitizer — express-mongo-sanitize incompatible with Express 5
- Redis optional — all features degrade gracefully without it
