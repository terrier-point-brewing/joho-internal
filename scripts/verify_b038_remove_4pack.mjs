// Verify the removal of B-038's erroneous 2026-07-20 4-pack canning (transfer f64c1511).
// Run BEFORE and AFTER applying 20260807_remove_b038_erroneous_4pack_canning.sql.
//   node scripts/verify_b038_remove_4pack.mjs
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const s = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const TRANSFER = 'f64c1511-e1aa-4878-a0db-d2a4807640b3';
const COLD = 'bd833054-f73d-47df-a11b-744f88cc6530';
const SCHED = '95f675a7-92d3-4fd8-8158-2aa4a732db14';
const ITEMS = {
  '8921dfe9-c8e5-404a-bdfc-ddae4888fca1': '16oz Blank (container)',
  'fe7d0cea-fc17-42d8-8c81-845655031189': 'Aluminum lid',
  'a03e321d-87a5-4cb6-b086-b9310485cdc6': 'Fortnight Pumpkin Ale Label',
  'e5c18bd1-e682-4e97-8a3f-284dd155be7c': '4-Pack (Black) paktech',
};

const pass = [];
const check = (label, ok, detail) => { pass.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`); };

const { data: xfer } = await s.from('batch_transfers').select('id').eq('id', TRANSFER).maybeSingle();
check('transfer f64c1511 removed', !xfer);

const { data: cold } = await s.from('cold_storage_inventory').select('id').eq('id', COLD).maybeSingle();
check('cold_storage row bd833054 (180 units) removed', !cold);

const { data: adj } = await s.from('packaging_stock_adjustments').select('id').eq('batch_transfer_id', TRANSFER);
check('packaging_stock_adjustments for f64c1511 removed', (adj || []).length === 0, `${(adj || []).length} rows`);

const { data: sched } = await s.from('batch_schedule_entries').select('actual_start, actual_end').eq('id', SCHED).maybeSingle();
check('canning schedule 95f675a7 reverted to planned', sched && !sched.actual_start && !sched.actual_end,
  `actual_start=${sched?.actual_start}`);

const { data: pkg } = await s.from('packaging_items').select('id, name, stock_quantity').in('id', Object.keys(ITEMS));
console.log('\nPackaging stock (expected after: container 4107, lid 12325, label -768, paktech 1850):');
for (const p of pkg || []) console.log(`  ${ITEMS[p.id].padEnd(30)} = ${p.stock_quantity}`);

// Remaining B-038 canning cold storage should be: 30 CBC Pumpkin Reaper + 32 Fortnight case (kegging 24 separate)
const { data: remaining } = await s.from('cold_storage_inventory')
  .select('variation_id, quantity_on_hand, source_transfer_id')
  .eq('batch_id', '22a9408a-c4e1-4169-8978-b4b06fb1b86f');
console.log('\nRemaining B-038 cold_storage rows:');
for (const r of remaining || []) console.log(`  variation ${r.variation_id} = ${r.quantity_on_hand}`);

console.log(`\n${pass.every(Boolean) ? '✅ ALL PASS' : '❌ SOME FAILED'}`);
