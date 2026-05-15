import express, { Request, Response } from 'express';
import * as http from 'http';

const app = express();
app.use(express.json());

let balances: Record<string, Record<string, number>> = {};
let referenceCounter = 1;
let simulateTimeout = false;
let failNextN = 0;

function resetState() {
  balances = {
    'emp-001': { 'loc-us-pto': 10, 'loc-us-sick': 5 },
    'emp-002': { 'loc-us-pto': 15, 'loc-us-sick': 3 },
    'emp-003': { 'loc-us-pto': 2, 'loc-us-sick': 5 },
  };
  referenceCounter = 1;
  simulateTimeout = false;
  failNextN = 0;
}

resetState();

// ── Balance queries ──────────────────────────────────────────────────────────

app.get('/hcm/balances/batch', (_req: Request, res: Response) => {
  const timestamp = new Date().toISOString();
  const records = [];
  for (const [employeeId, locations] of Object.entries(balances)) {
    for (const [locationId, balanceDays] of Object.entries(locations)) {
      records.push({ employeeId, locationId, balanceDays, timestamp });
    }
  }
  res.json(records);
});

app.get('/hcm/balances/:employeeId/:locationId', (req: Request, res: Response) => {
  const { employeeId, locationId } = req.params;
  const bal = balances[employeeId]?.[locationId];
  if (bal === undefined) return res.status(404).json({ error: 'Not found' });
  res.json({ employeeId, locationId, balanceDays: bal, timestamp: new Date().toISOString() });
});

// ── Time-off submission ──────────────────────────────────────────────────────

app.post('/hcm/time-off', (req: Request, res: Response) => {
  if (simulateTimeout) {
    // Never respond — caller will hit its timeout
    return;
  }

  if (failNextN > 0) {
    failNextN--;
    return res.status(500).json({ error: 'Internal HCM error (simulated)' });
  }

  const { employeeId, locationId, days } = req.body;

  if (!balances[employeeId] || balances[employeeId][locationId] === undefined) {
    return res.status(422).json({ error: 'Invalid employee/location combination' });
  }

  const current = balances[employeeId][locationId];
  if (current < days) {
    return res.status(422).json({ error: `Insufficient balance: ${current} available, ${days} requested` });
  }

  balances[employeeId][locationId] = parseFloat((current - days).toFixed(2));

  res.status(201).json({
    referenceId: `hcm-ref-${referenceCounter++}`,
    employeeId,
    locationId,
    daysDeducted: days,
    newBalance: balances[employeeId][locationId],
  });
});

// Silent failure: returns 200 with no referenceId — tests the double-gate guard
app.post('/hcm/time-off/silent-fail', (_req: Request, res: Response) => {
  res.status(200).json({});
});

// ── HCM-driven balance events ────────────────────────────────────────────────

// Simulate a work-anniversary bonus or year-start refresh
app.post('/hcm/balances/anniversary', (req: Request, res: Response) => {
  const { employeeId, locationId, bonusDays } = req.body;
  if (!balances[employeeId]) balances[employeeId] = {};
  balances[employeeId][locationId] = parseFloat(
    ((balances[employeeId][locationId] ?? 0) + bonusDays).toFixed(2),
  );
  res.json({
    employeeId,
    locationId,
    balanceDays: balances[employeeId][locationId],
    timestamp: new Date().toISOString(),
  });
});

// Seed an arbitrary balance (used in tests)
app.post('/hcm/balances/seed', (req: Request, res: Response) => {
  const { employeeId, locationId, balanceDays } = req.body;
  if (!balances[employeeId]) balances[employeeId] = {};
  balances[employeeId][locationId] = balanceDays;
  res.json({ ok: true });
});

// ── Test control endpoints ───────────────────────────────────────────────────

app.post('/test/reset', (_req: Request, res: Response) => {
  resetState();
  res.json({ ok: true });
});

app.post('/test/simulate-timeout', (_req: Request, res: Response) => {
  simulateTimeout = true;
  res.json({ ok: true });
});

app.post('/test/fail-next', (req: Request, res: Response) => {
  failNextN = req.body.count ?? 1;
  res.json({ ok: true, failNextN });
});

app.get('/test/balances', (_req: Request, res: Response) => {
  res.json(balances);
});

// ── Server lifecycle ─────────────────────────────────────────────────────────

export function createApp() {
  return app;
}

export function startServer(port: number = 3001): http.Server {
  const server = app.listen(port, () => {
    console.log(`Mock HCM server listening on port ${port}`);
  });
  return server;
}

if (require.main === module) {
  startServer(Number(process.env.HCM_PORT) || 3001);
}
