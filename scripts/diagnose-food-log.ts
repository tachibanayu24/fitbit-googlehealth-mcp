#!/usr/bin/env tsx
/**
 * Probe Fitbit's /1/user/-/foods/log.json nutritional-value key naming.
 *
 * Reads an access_token from /tmp/diag/at.txt (populated by
 * `wrangler kv key get --remote --binding=TOKENS access_token`),
 * posts three test food entries on a date that doesn't collide with
 * real data, then reads back the stored nutritionalValues to confirm
 * which payload shape Fitbit actually accepts. Finally deletes the
 * test entries.
 *
 * Extend this file whenever the Fitbit food-log API changes shape again.
 */
import { readFileSync } from 'node:fs';

const FITBIT_BASE = 'https://api.fitbit.com';
const accessToken = readFileSync('/tmp/diag/at.txt', 'utf-8').trim();
const TEST_DATE = '2026-04-23';
const UNIT_SERVING = 304;
const MEAL_ANYTIME = 7;

type Pattern = {
  name: string;
  form: Record<string, string | number>;
};

const stamp = Date.now().toString(36);

// Round 1 established: protein = "protein", fat = "totalFat", fiber = "dietaryFiber".
// "carbs" didn't respond to any of those aliases; sodium/sugar weren't tested.
// Round 2 probes the remaining keys in isolation.
const patterns: Pattern[] = [
  {
    name: 'E_carbohydrates',
    form: {
      foodName: `MCP_DIAG_E_${stamp}`,
      mealTypeId: MEAL_ANYTIME,
      unitId: UNIT_SERVING,
      amount: 1,
      date: TEST_DATE,
      calories: 100,
      protein: 10,
      totalFat: 5,
      dietaryFiber: 2,
      carbohydrates: 20,
      sodium: 150,
      sugars: 3,
    },
  },
  {
    name: 'F_totalCarbohydrate',
    form: {
      foodName: `MCP_DIAG_F_${stamp}`,
      mealTypeId: MEAL_ANYTIME,
      unitId: UNIT_SERVING,
      amount: 1,
      date: TEST_DATE,
      calories: 200,
      protein: 20,
      totalFat: 8,
      dietaryFiber: 3,
      totalCarbohydrate: 30,
      sodium: 200,
      sugar: 4,
    },
  },
  {
    name: 'G_carbs_alt',
    form: {
      foodName: `MCP_DIAG_G_${stamp}`,
      mealTypeId: MEAL_ANYTIME,
      unitId: UNIT_SERVING,
      amount: 1,
      date: TEST_DATE,
      calories: 300,
      protein: 30,
      totalFat: 10,
      carbsGrams: 40,
      totalSugars: 5,
      totalSodium: 250,
    },
  },
];

async function callFitbit(opts: {
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  form?: Record<string, string | number>;
}): Promise<{ status: number; body: string }> {
  const url = new URL(opts.path, FITBIT_BASE);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  let body: BodyInit | undefined;
  if (opts.form) {
    const f = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) f.set(k, String(v));
    body = f;
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(url, { method: opts.method ?? 'GET', headers, body });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function main(): Promise<void> {
  console.log(`Probing foodLog nutritional payload on ${TEST_DATE}`);
  console.log('='.repeat(60));
  const logIds: Array<{ name: string; id: number }> = [];

  for (const p of patterns) {
    console.log(`\n--- POST pattern ${p.name} ---`);
    const keys = Object.keys(p.form).filter(
      (k) => !['foodName', 'mealTypeId', 'unitId', 'amount', 'date', 'calories'].includes(k),
    );
    console.log(`  nutrient keys sent: ${keys.join(', ')}`);
    const { status, body } = await callFitbit({
      path: '/1/user/-/foods/log.json',
      method: 'POST',
      form: p.form,
    });
    if (status !== 201) {
      console.log(`  ✗ HTTP ${status}`);
      console.log(`  body: ${body.slice(0, 400)}`);
      continue;
    }
    const entry = JSON.parse(body).foodLog;
    console.log(`  ✓ logId=${entry.logId}`);
    console.log(`  Fitbit echo nutritionalValues: ${JSON.stringify(entry.nutritionalValues)}`);
    logIds.push({ name: p.name, id: entry.logId });
  }

  console.log(`\n--- GET /foods/log/date/${TEST_DATE} ---`);
  const { status: gs, body: gb } = await callFitbit({
    path: `/1/user/-/foods/log/date/${TEST_DATE}.json`,
  });
  if (gs === 200) {
    const foodLog = JSON.parse(gb);
    for (const food of foodLog.foods ?? []) {
      const name = food.loggedFood?.name ?? '';
      if (!name.startsWith('MCP_DIAG_')) continue;
      console.log(`  ${name}:`);
      console.log(`    loggedFood.calories: ${food.loggedFood?.calories}`);
      console.log(`    nutritionalValues:  ${JSON.stringify(food.nutritionalValues)}`);
    }
  } else {
    console.log(`  ✗ HTTP ${gs}: ${gb.slice(0, 200)}`);
  }

  console.log('\n--- cleanup ---');
  for (const { name, id } of logIds) {
    const { status } = await callFitbit({
      path: `/1/user/-/foods/log/${id}.json`,
      method: 'DELETE',
    });
    console.log(`  DELETE ${name} (${id}) → ${status}`);
  }

  console.log('\nDone.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
