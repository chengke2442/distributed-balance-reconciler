# distributed-balance-reconciler

A high-integrity synchronization engine built with NestJS and SQLite. This service bridges the gap between ReadyOn's user interface and an external Human Capital Management (HCM) system, ensuring that employee time-off balances are always accurate, even when updated by external events.

## Architecture

The service utilizes a **Reliable Cache with Synchronous Write-Through** pattern:

- **Read:** Employee balances are served from the local SQLite database for sub-millisecond latency.
- **Write:** Time-off requests are validated locally first, then synchronously committed to the HCM.
- **Reconcile:** A periodic batch process pulls the full corpus from the HCM to resolve discrepancies (e.g., work anniversaries or manual HR adjustments).

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | NestJS (Node.js) |
| Database | SQLite with TypeORM (per-employee, per-location partitioning) |
| Testing | Jest (Unit, Integration, and E2E with Mock HCM Servers) |
| Dev Methodology | 100% Agentic Development (AI-orchestrated architecture and testing) |

## Key Challenges & Solutions

### 1. The "Anniversary" Problem

**Challenge:** HCM balances can change independently (e.g., an employee gets a bonus day on their work anniversary).

**Solution:** The `SyncEngine` performs a "Delta Analysis" during batch imports. If the HCM balance differs from the local balance, the HCM (Source of Truth) always wins.

### 2. Distributed Race Conditions

**Challenge:** A user requests leave while a batch sync is in progress.

**Solution:** Implementation of **Optimistic Concurrency Control**. Every balance record includes a version/timestamp to ensure we don't overwrite fresh data with stale batch info.

### 3. Defensive Validation

**Challenge:** The HCM API might be down or return inconsistent errors.

**Solution:** The service implements a **"Double-Gate"** validation. We calculate eligibility locally to provide instant UI feedback, but treat the HCM response as the final authority before "Approving" a request.

## Getting Started

### Prerequisites

- Node.js (v18+)
- npm / yarn

### Installation

```bash
git clone https://github.com/chengke2442/distributed-balance-reconciler.git
cd distributed-balance-reconciler
npm install
```

### Running the Mock HCM Server

To test the synchronization logic, start the included Mock HCM server:

```bash
npm run start:hcm-mock
```

### Running the Microservice

```bash
npm run start:dev
```

## Testing

Integrity is the core of this project. The test suite covers:

- **Unit Tests:** Logic for balance calculations and dimension validation.
- **Integration Tests:** End-to-end flows between ReadyOn and the Mock HCM.
- **Resilience Tests:** Simulating HCM downtime and balance "drift."

```bash
# Run all tests with coverage
npm run test:cov
```
