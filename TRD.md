# Technical Requirement Document
## Time-Off Microservice — ReadyOn × HCM Sync Engine

**Version:** 1.0  
**Date:** 2026-05-13  
**Author:** AI-Assisted Architecture

---

## 1. Problem Statement

ReadyOn's time-off module needs to remain in sync with an external Human Capital Management (HCM) system that is the authoritative source of truth for employment data. Two hard constraints define the problem space:

1. **ReadyOn does not own the data.** The HCM can mutate balances at any time (work anniversaries, year-end resets, manual HR adjustments) without notifying ReadyOn synchronously.
2. **ReadyOn must still provide instant UX.** Employees expect sub-second feedback on balance checks and request submissions, making a pure pass-through to the HCM unacceptable.

The result is a **distributed cache consistency problem**: ReadyOn maintains a local replica of HCM balances that must stay accurate despite external writes, network failures, and concurrent in-flight requests.

---

## 2. Goals & Non-Goals

### Goals
- Maintain a locally-readable balance cache per `(employeeId, locationId)`.
- Guarantee that approved time-off requests are reflected correctly in the HCM.
- Reconcile HCM-driven balance changes via periodic batch import.
- Be defensive against HCM unreliability (downtime, missing error responses).
- Prevent double-spend via optimistic concurrency control.

### Non-Goals
- Real-time push notifications to employees about balance changes.
- Multi-tenancy or customer-level isolation (assumed handled upstream).
- Replacing or wrapping the HCM's approval workflow UI.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   ReadyOn Frontend                       │
└────────────────────────┬────────────────────────────────┘
                         │ REST
┌────────────────────────▼────────────────────────────────┐
│              Time-Off Microservice (NestJS)              │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Balance    │  │  Request     │  │  Sync Engine   │  │
│  │  Module     │  │  Module      │  │  Module        │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                │                   │           │
│  ┌──────▼────────────────▼───────────────────▼────────┐  │
│  │              SQLite (TypeORM)                       │  │
│  └─────────────────────────────────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │              HCM Adapter (HTTP Client)               │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────┘
                          │ HTTP
┌─────────────────────────▼───────────────────────────────┐
│                External HCM System                       │
│         (Workday / SAP or Mock in tests)                 │
└──────────────────────────────────────────────────────────┘
```

### Pattern: Reliable Cache with Synchronous Write-Through

| Operation | Behavior |
|-----------|----------|
| **Read** | Served from local SQLite. No HCM call. |
| **Write** (time-off request) | Validated locally → submitted to HCM → confirmed locally. Fails atomically if HCM rejects. |
| **Reconcile** | Scheduled batch pull from HCM. Delta analysis applied with conflict detection. |

---

## 4. Data Model

### 4.1 `balance`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `employee_id` | VARCHAR | Employee identifier |
| `location_id` | VARCHAR | Location/leave-type identifier |
| `balance_days` | DECIMAL(10,2) | Current available balance |
| `version` | INTEGER | Optimistic lock counter, increments on every write |
| `last_hcm_sync_at` | DATETIME | Timestamp of last HCM-sourced update |
| `updated_at` | DATETIME | Timestamp of last local update |

**Unique constraint:** `(employee_id, location_id)`

### 4.2 `time_off_request`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Request identifier |
| `employee_id` | VARCHAR | Employee making the request |
| `location_id` | VARCHAR | Leave type / location |
| `days_requested` | DECIMAL(10,2) | Number of days |
| `status` | ENUM | `PENDING` → `APPROVED` / `REJECTED` |
| `hcm_reference_id` | VARCHAR | ID returned by HCM on approval |
| `hcm_error` | TEXT | Raw HCM error if rejected |
| `balance_version_at_request` | INTEGER | `balance.version` snapshot when request was created |
| `created_at` | DATETIME | |
| `updated_at` | DATETIME | |

### 4.3 `sync_log`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | |
| `sync_type` | ENUM | `BATCH` / `REALTIME` |
| `status` | ENUM | `STARTED` / `COMPLETED` / `FAILED` |
| `records_processed` | INTEGER | |
| `records_updated` | INTEGER | |
| `records_skipped` | INTEGER | Skipped due to version conflict |
| `error_detail` | TEXT | |
| `started_at` | DATETIME | |
| `completed_at` | DATETIME | |

---

## 5. API Specification

### 5.1 Balance Endpoints

#### `GET /balances/:employeeId/:locationId`
Returns the current local balance for a given employee and location.

**Response 200:**
```json
{
  "employeeId": "emp-123",
  "locationId": "loc-us-pto",
  "balanceDays": 8.5,
  "version": 14,
  "lastHcmSyncAt": "2026-05-12T10:00:00Z"
}
```

**Response 404:** Employee/location pair not found in local cache.

---

#### `POST /sync/realtime`
Receives a realtime push from the HCM for a single balance update. Applies the update if it is not superseded by a more recent local write.

**Request Body:**
```json
{
  "employeeId": "emp-123",
  "locationId": "loc-us-pto",
  "balanceDays": 11.0,
  "hcmTimestamp": "2026-05-13T09:00:00Z"
}
```

**Response 200:** Update applied or skipped (with reason).

---

### 5.2 Time-Off Request Endpoints

#### `POST /requests`
Creates and attempts to approve a time-off request via the "Double-Gate" flow.

**Request Body:**
```json
{
  "employeeId": "emp-123",
  "locationId": "loc-us-pto",
  "daysRequested": 2.0
}
```

**Flow:**
1. Local gate — check `balance_days >= days_requested`. Return `400` immediately if not.
2. Create request record with `status = PENDING`.
3. Submit to HCM realtime API.
4. On HCM success: decrement local balance (version++), set `status = APPROVED`.
5. On HCM failure: set `status = REJECTED`, store `hcm_error`.

**Response 201 (Approved):**
```json
{
  "requestId": "req-abc",
  "status": "APPROVED",
  "hcmReferenceId": "hcm-ref-789",
  "newBalance": 6.5
}
```

**Response 422 (Rejected by HCM):**
```json
{
  "requestId": "req-abc",
  "status": "REJECTED",
  "reason": "Insufficient balance per HCM"
}
```

---

#### `GET /requests/:requestId`
Returns the current state of a time-off request.

---

### 5.3 Sync Endpoints

#### `POST /sync/batch`
Triggers a full batch reconciliation from the HCM. Intended to be called by a scheduler (cron) or by a webhook from the HCM.

**Response 202:** Sync started asynchronously.

#### `GET /sync/status`
Returns the status of the most recent batch sync.

---

## 6. Key Design Decisions

### 6.1 Optimistic Concurrency Control

Every `balance` row carries a `version` integer. Writers follow this protocol:

```
UPDATE balance
SET balance_days = ?, version = version + 1, updated_at = NOW()
WHERE employee_id = ? AND location_id = ? AND version = ?  ← expected version
```

If the `WHERE` matches 0 rows, a concurrent write happened. The caller retries or returns a conflict error.

During batch sync, the engine compares `last_hcm_sync_at` against the HCM payload timestamp:
- If `hcm_timestamp > last_hcm_sync_at` → apply and increment version.
- If `hcm_timestamp <= last_hcm_sync_at` → **skip** (a realtime update or user request is more recent).

This ensures a batch sync never silently overwrites a fresher write.

---

### 6.2 The "Double-Gate" Validation

The HCM is the source of truth, but it may not always return clear errors. The service therefore performs validation at two layers:

| Gate | Location | Purpose |
|------|----------|---------|
| **Gate 1** | Local SQLite | Instant feedback to the user. Rejects obvious under-balance cases without a network call. |
| **Gate 2** | HCM API | Authoritative check. Even if Gate 1 passes, the HCM response is final. |

If Gate 2 fails silently (HCM returns 200 with no confirmation), we treat it as a rejection and do not commit the balance deduction.

---

### 6.3 Batch Delta Analysis

When the HCM batch endpoint delivers the full corpus, the sync engine processes it as follows:

```
for each (employeeId, locationId, hcmBalance, hcmTimestamp) in batch:
    local = SELECT * FROM balance WHERE employee_id = ? AND location_id = ?
    if local does not exist:
        INSERT new record
    else if hcmTimestamp > local.last_hcm_sync_at:
        if hcmBalance != local.balance_days:
            log drift event
        UPDATE balance SET balance_days = hcmBalance, version = version + 1,
               last_hcm_sync_at = hcmTimestamp
    else:
        skip (local is more recent)
```

The entire batch is wrapped in a SQLite transaction. If any row fails, the transaction rolls back and a `FAILED` sync log is written.

---

### 6.4 HCM Downtime Handling

The HCM adapter implements:
- **Timeout:** 5 seconds per request.
- **Retry:** 3 attempts with exponential backoff (1s, 2s, 4s) for transient errors (5xx, network timeout).
- **Circuit behaviour:** After retries are exhausted, the request is rejected and the balance is not deducted. No optimistic local-only approval.

Rationale: approving a request locally without HCM confirmation risks double-spend if the HCM later rejects it. It is safer to surface a temporary error to the user than to create an inconsistency.

---

## 7. Alternatives Considered

### A. Pure Pass-Through (No Local Cache)
Every read and write goes directly to the HCM.

- **Pro:** Always perfectly consistent.
- **Con:** HCM latency (~200–500ms) is added to every UI interaction. HCM downtime makes the UI completely non-functional.
- **Decision:** Rejected. Unacceptable UX and availability risk.

### B. Eventual Consistency with Local Approval
Approve time-off locally and sync to HCM asynchronously via a queue.

- **Pro:** Completely insulates the user from HCM latency.
- **Con:** The user can see "Approved" while the HCM later rejects it. Requires a reversal flow, which is complex and confusing.
- **Decision:** Rejected. The UX of a reversed approval is worse than a slightly slower submission.

### C. Event Sourcing / Outbox Pattern
Write all changes to an outbox table and a background worker syncs to HCM.

- **Pro:** Decouples write latency from HCM; resilient to HCM downtime.
- **Con:** Significantly more infrastructure complexity. Same reversal risk as Option B.
- **Decision:** Rejected for V1. Could be reconsidered if HCM SLA degrades.

### D. Chosen: Synchronous Write-Through with Local Read Cache
Submit to HCM synchronously on write; read from local cache; batch reconcile periodically.

- **Pro:** Consistent approval semantics, fast reads, handles HCM-driven balance changes.
- **Con:** Time-off submission latency includes HCM round-trip (~200–500ms). Acceptable for a one-time action.
- **Decision:** Adopted.

---

## 8. Test Strategy

### 8.1 Unit Tests
- Balance calculation: can/cannot deduct given various balance states.
- Delta analysis logic: HCM-wins, local-wins, new record insertion.
- Optimistic lock: conflict detection when expected version mismatches.
- Request status transitions: valid vs. invalid state changes.

### 8.2 Integration Tests (against Mock HCM)
- Happy path: create request → HCM approves → balance decremented.
- HCM rejection: balance not decremented, request marked REJECTED.
- Realtime sync: HCM posts anniversary bonus → local balance updated.
- Batch sync: full corpus applied, drift resolved correctly.
- Concurrent request: two simultaneous requests against the same balance; only one approved.

### 8.3 Resilience Tests
- HCM timeout: request fails cleanly, balance unchanged.
- HCM 500 with retry: success on third attempt.
- Stale batch: batch import with old timestamps does not overwrite fresh local writes.
- Mid-batch failure: transaction rolls back, sync log records FAILED.
- Gate 1 under-balance: rejects before any HCM call.
- Gate 2 silent failure: HCM returns 200 with no confirmation body; treated as rejection.

---

## 9. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Balance read latency | < 10ms (local SQLite) |
| Request submission latency | < 600ms (includes HCM round-trip) |
| Batch sync throughput | ≥ 1,000 records/second |
| HCM call timeout | 5 seconds |
| Test coverage | ≥ 80% line coverage |

---

## 10. Open Questions

1. **Batch trigger mechanism:** Does the HCM call our `/sync/batch` webhook, or do we poll? Assumed: we schedule a cron internally; HCM can also push.
2. **Partial balance deductions:** Are fractional days (e.g., half-day) supported? Assumed yes — `DECIMAL(10,2)`.
3. **Request cancellation:** Can an approved request be cancelled? Out of scope for V1.
4. **Authentication:** Service-to-service auth between ReadyOn and HCM assumed handled by infrastructure (mTLS / API key in headers). Not modelled in this service.
