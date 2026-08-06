#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const repository = require('./repository');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function arg(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function historicalId(companyId, oldId) {
  const bytes = crypto.createHash('sha256').update(companyId + ':' + oldId).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function containsSensitiveFields(raw) {
  const banned = /^(prompt|completion|response|content|file|filename|path|api_?key|credential|password)$/i;
  return Object.keys(raw || {}).some((key) => banned.test(key));
}

async function importFlat(pool, options) {
  if (!options || !UUID_PATTERN.test(String(options.companyId || ''))) {
    throw new Error('companyId must be a UUID');
  }
  const company = await pool.query('SELECT id FROM companies WHERE id=$1', [options.companyId]);
  if (!company.rowCount) throw new Error('company does not exist');
  const owner = await pool.query(
    'SELECT user_id FROM managers WHERE company_id=$1 ORDER BY created_at,id LIMIT 1', [options.companyId]
  );
  if (!owner.rowCount) throw new Error('company has no manager owner');
  const ownerUserId = owner.rows[0].user_id;
  const eventsDir = path.join(path.resolve(options.dataDir), 'events');
  const files = fs.readdirSync(eventsDir).filter((name) => name.endsWith('.jsonl')).sort();
  const rawEvents = [];
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(eventsDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line);
      if (containsSensitiveFields(raw)) throw new Error('flat-file event contains a forbidden sensitive field');
      rawEvents.push(raw);
    }
  }
  const client = await pool.connect();
  let imported = 0, duplicates = 0;
  try {
    await client.query('BEGIN');
    const devices = new Map();
    for (const raw of rawEvents) {
      if (raw.device_id != null && !['string', 'number'].includes(typeof raw.device_id)) {
        throw new Error('flat-file device_id must be a string or number');
      }
      const oldId = String(raw.device_id || 'historical-device');
      if (!oldId.trim() || oldId.length > 512) throw new Error('flat-file device_id is invalid');
      if (!devices.has(oldId)) {
        const id = historicalId(options.companyId, oldId);
        await client.query(
          `INSERT INTO devices(id, company_id, owner_user_id, label, platform, credential_hash, revoked_at)
           VALUES ($1,$2,$3,$4,$5,NULL,now()) ON CONFLICT (id) DO NOTHING`,
          [id, options.companyId, ownerUserId, String(raw.device_label || oldId).slice(0, 120), 'historical']
        );
        devices.set(oldId, id);
      }
      const device = { id: devices.get(oldId), companyId: options.companyId, ownerUserId };
      const checked = repository.sanitizeEvent(raw, device);
      if (!checked.event) throw new Error('flat-file event failed validation: ' + checked.reason);
      const e = checked.event;
      const cost = repository.eventPricing(e.model, e.pricingModel, e.tokens);
      const inserted = await client.query(
        `INSERT INTO usage_events(company_id,owner_user_id,event_id,device_id,harness,provider,model,pricing_model,occurred_at,tokens,source,
                                  pricing_status,pricing_amount,pricing_flat_amount,pricing_catalogue_version,pricing_unpriced_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (device_id,event_id) DO NOTHING RETURNING event_id`,
        [e.companyId,e.ownerUserId,e.eventId,e.deviceId,e.harness,e.provider,e.model,e.pricingModel,e.occurredAt,
          JSON.stringify(e.tokens),e.source,cost.status,cost.amount,cost.flatAmount,cost.version,cost.unpricedModel]
      );
      if (inserted.rowCount) imported++; else duplicates++;
    }
    await client.query('COMMIT');
    return { imported, duplicates, historicalDevices: devices.size };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

if (require.main === module) {
  (async () => {
    const dataDir = arg('data-dir');
    const companyId = arg('company-id');
    if (!dataDir || !companyId) throw new Error('usage: node server/import-flat.js --data-dir DIR --company-id UUID');
    const pool = repository.createPool();
    try {
      await repository.migrate(pool);
      const result = await importFlat(pool, { dataDir, companyId });
      console.log('Imported ' + result.imported + ' events (' + result.duplicates + ' duplicates) from '
        + result.historicalDevices + ' historical devices; imported devices remain revoked until re-enrolled');
    } finally { await pool.end(); }
  })().catch((err) => { console.error(err.message || 'import failed'); process.exit(1); });
}

module.exports = { importFlat, historicalId, containsSensitiveFields };
