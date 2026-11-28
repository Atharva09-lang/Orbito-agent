# Orbito — AI Personal Assistant

Orbito is a full-stack AI personal assistant that supports conversational memory, cross-conversation context recall, and real-time web search.

## Features

- **Chat:** Interact with the assistant through a conversational interface.
- **Conversations:** Create, open, and delete conversations.
- **Memory:** Extract and persist useful facts and preferences.
- **Past Context Recall:** Retrieve relevant information from previous conversations.
- **Web Search:** Search the web using Tavily when fresh information is needed.
- **Authentication:** Email and password sign-up and sign-in using Neon Auth.
- **Formatted Responses:** Markdown support for lists, code blocks, and tables.
- **API Security:** Authentication checks, request validation, rate limiting, and security headers.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite |
| Backend | Node.js, Express 5 |
| Database | Neon PostgreSQL |
| Authentication | Neon Auth |
| LLM | Groq (GPT-OSS-120B) |
| Web Search | Tavily |
| Validation | Zod |
| Security | Helmet, CORS, Express Rate Limit |
| Markdown | React Markdown, Remark GFM |

## Project Structure

```text
Orbito-agent/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   ├── controllers/
│   │   ├── database/
│   │   ├── middleware/
│   │   ├── repositories/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── tools/
│   │   └── validators/
│   ├── tests/
│   ├── .env.example
│   └── package.json
├── docs/
│   ├── architecture.md
│   └── database-design.md
├── frontend/
│   ├── public/
│   ├── src/
│   └── package.json
├── DESIGN.md
├── README.md
└── package.json
```

## Running Locally

### Prerequisites

- Node.js and npm
- Neon PostgreSQL database
- Neon Auth configuration
- Groq API key
- Tavily API key

### 1. Clone the repository

```bash
git clone https://github.com/Atharva09-lang/minimi-agent.git
cd minimi-agent
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy `backend/.env.example` to `backend/.env` and configure the required values.

Create `frontend/.env`:

```env
VITE_NEON_AUTH_URL=your_neon_auth_url
VITE_API_BASE_URL=http://localhost:5000/api
```

Never commit actual environment files or secret keys.

### 4. Set up the database

Run the SQL script from:

`backend/src/database/schema.sql`

against your Neon PostgreSQL database.

### 5. Start the application

```bash
npm run dev
```

The frontend and backend should start together:

- Frontend: http://localhost:5173
- Backend API: http://localhost:5000

## Testing

Run the mocked backend unit suite without database or external provider access:

```bash
cd backend
npm run test:unit
```

The unit runner preloads `tests/unit/no-external-network.js` before test modules and injects it into Node child processes. It is a test network guard, not a complete network sandbox.

Covered paths:

- `fetch` permits only loopback HTTP URLs and reports only the protocol and host.
- `net.Socket.prototype.connect`, including the standard `http`/`https` client paths, validates literal destinations and custom DNS lookup results. Only `127.0.0.1` and canonical IPv6 `::1` are approved. `localhost` is resolved internally to those addresses instead of trusting hostname resolution.
- `dns.lookup` and `dns.promises.lookup` reject external hostnames before resolution; numeric literals do not themselves perform DNS traffic.
- `dgram` connect/send operations permit only approved loopback destinations.
- Public child-process APIs allow only the current Node executable, inject the guard even when `NODE_OPTIONS` is cleared, and reject shell, native, or alternate executable paths.
- A recorded violation forces a nonzero exit even if the exception is caught, `process.exitCode` is changed, guard exit listeners are removed, another exit listener changes the code again, or `process.exit(0)`/`process.reallyExit(0)` is called. Diagnostics omit URL userinfo, paths, queries, and fragments.

Outside the guard's guarantees are inbound connections, Unix-domain sockets and named pipes, native addons, `process.binding`, raw file descriptors/handles, worker threads given custom `execArgv` that omits the preload, custom `createConnection` or `fetch` dispatcher implementations, code that restores patched built-ins, DNS APIs other than `lookup`, and operating-system networking reached without the patched public APIs. Standard JavaScript HTTP/TCP clients are covered transitively through the socket guard, but this remains a unit-test safety mechanism rather than an OS-level sandbox.

Some unit tests start real ephemeral loopback HTTP servers to exercise Express routes. Their database pools and persistence are mocked, so they are mock-only unit tests, not database-mutating integration tests. Generic Node discovery from `backend` is limited to the same mocked unit tests; integration and localhost HTTP scripts use `.integration.js` names and are not auto-discovered.

The following commands are opt-in and require the approved isolated integration environment. They can perform database or Auth mutations and must never be pointed at production:

```bash
npm run test:integration:ownership
npm run test:integration:http
npm run test:integration:phase1
npm run test:integration:phase1-preservation
npm run test:integration:phase2-lifecycle
npm run test:integration:phase2-repository
npm run test:integration:phase2-fix-regression
npm run test:integration:phase3
```

A complete self-contained serial Phase 1/2/3 run is not currently supported. The phase suites preserve different historical snapshots, Phase 1 generates IDs that Phase 2 does not consume dynamically, and Phase 3 requires additional state plus explicit environment handoff. Run each phase only when its exact prerequisites are already satisfied:

- **Common integration contract:** explicitly set `INTEGRATION_MODE=true`, `DATABASE_URL_POOLED`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`, `TEST_API_URL`, `TEST_NEON_AUTH_URL`, `TEST_AUTH_ORIGIN`, `TEST_COOKIE_FILE`, `TEST_NEON_PROJECT_ID=odd-bread-81511600`, `TEST_NEON_BRANCH_ID=br-lively-tree-bi1z37kh`, `TEST_NEON_DB_HOST=ep-rough-king-bi6v85y5-pooler.c-5.ap-southeast-1.aws.neon.tech`, and `TEST_NEON_AUTH_HOST=ep-rough-king-bi6v85y5.neonauth.c-5.ap-southeast-1.aws.neon.tech`. The Auth URLs must match that same `ep-rough-king-bi6v85y5` endpoint, and `TEST_NEON_AUTH_URL` must match `NEON_AUTH_BASE_URL`. `TEST_COOKIE_FILE` must name the isolated integration jar; Phase 1 requires an existing empty file, and Phase 3 requires the file to exist. `PGOPTIONS` must be unset for every integration suite. Never set the legacy fixture variables `TEST_CONVERSATION_ID` or `TEST_MEMORY_ID`; phase suites reject them. Phase suites also require `DATABASE_URL`, `GROQ_API_KEY`, and `TAVILY_API_KEY` to be unset. Production project `winter-math-54988029`, branch `br-restless-silence-ao5ra3rh`, and Auth endpoint `ep-calm-violet-aophputx` are forbidden.
- **Phase 1 isolation:** requires exactly the two original approved synthetic Auth users, the expected five application tables/four Auth foreign keys, zero conversations/memories/messages/reminders/tool logs, one JWKS key, and an empty integration cookie jar. It creates two replacement users, two conversations, and two memories, writes `phase1-identities.integration.local.json`, and does not clean them up.
- **Phase 1 preservation:** read-only audit requiring `phase2-identities.integration.local.json`, the four fixed original/replacement users plus its two Phase 2 users, 12 sessions including eight original-user sessions, pinned Phase 1 rows, at least five conversations, at least 28 memories, at least one message, zero reminders/tool logs, and one JWKS key.
- **Phase 2 lifecycle:** requires exactly four users/eight sessions, exactly the two pinned Phase 1 conversations and two pinned Phase 1 memories, zero messages/reminders/tool logs, the expected schema, and one JWKS key. It creates two synthetic users, writes `phase2-identities.integration.local.json`, and leaves six users, five conversations, and one failed provenance message.
- **Phase 2 repository:** requires the Phase 2 manifest, six users, the pinned Phase 1 rows, eight original-user sessions, and exactly one failed provenance message matching the manifest run ID and owner.
- **Phase 2 fix regression:** requires the Phase 2 manifest, six users/12 sessions, at least five conversations, at least 33 memories, at least one message, the five known legacy memory IDs, and the pinned original-user/Phase 1 record hashes.
- **Phase 3:** set `TEST_PHASE3_USER_A_ID` and `TEST_PHASE3_USER_B_ID` to the Phase 2 manifest `userAId`/`userBId`. It requires six users/12 sessions, at least eight conversations, at least 75 memories, at least 64 active memories, and at least four messages, plus zero reminders/tool logs. It preserves baseline rows and adds only run-owned memories.
- **Ownership:** set `TEST_MEMORY_OWNERSHIP_USER_A_ID` and `TEST_MEMORY_OWNERSHIP_USER_B_ID` to distinct dedicated synthetic UUIDs matching `userAId`/`userBId` in the fixture manifest. `TEST_MEMORY_OWNERSHIP_FIXTURE_FILE` is optional and defaults to `phase2-identities.integration.local.json`. The suite creates and soft-deletes only its own temporary memory; cleanup failure makes the suite fail.
- **HTTP integration:** requires a separately running localhost API through `TEST_API_URL`. The operator must independently verify that this API is connected to the approved isolated database; client-side environment validation cannot prove the server's database destination. Auth-dependent scripts also require a valid integration cookie jar, while the rate-limit and body-limit probes do not require authentication.

## API Overview

All conversation, message, and memory routes require a valid Neon Auth bearer token.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/conversations` | List conversations |
| POST | `/api/conversations` | Create a conversation |
| GET | `/api/messages/:conversationId` | Fetch conversation messages |
| POST | `/api/messages/:conversationId` | Send a message |
| GET / POST / PATCH / DELETE | `/api/memories` | Manage saved memories |

## Documentation

- **Design Document:** `DESIGN.md`
- **Architecture Notes:** `docs/architecture.md`
- **Database Design:** `docs/database-design.md`
