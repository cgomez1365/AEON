/**
 * The install boot proof runs the block's handlers even when an operator
 * account exists.
 *
 * Store builders B1 and B3 (2026-09-23): with an account present, the proof's
 * private host applied the operator's route guard, every probe answered 401,
 * and 401 counts as "booted and enforcing" — so a block whose every route
 * threw still passed, as long as its routes declared auth. The proof also gave
 * blocks no storage, so a block that writes passed and failed its first real
 * write. Drives the REAL proof over REAL staging with a fixture account.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-proof-account-'));
process.env.VAULT_PATH = path.join(TMP, 'Vault');
process.env.AEON_SECRETS_DIR = path.join(TMP, 'secrets');
process.env.AEON_DB_DIR = path.join(TMP, 'db');

const require = createRequire(import.meta.url);
const sessions = require('../src/kernel/server-utils/sessionValidator.cjs');
const { scaffold } = require('../src/kernel/blockScaffold.cjs');
const { bootProof } = require('../src/kernel/bootProof.cjs');
const { STAGING_DIR, ensureStagingDir } = require('../src/kernel/staging.cjs');

const ID = 'bootproof_account_fixture';
const dir = () => path.join(STAGING_DIR, ID);

function stage(apiSource) {
  const payload = scaffold({ id: ID, api: true }).payload;
  payload.manifest.routes = [{ method: 'GET', path: `/api/${ID}/status`, auth: true }];
  payload.files = payload.files.map((f) => (f.path.startsWith('api/') ? { ...f, content: apiSource } : f));
  fs.rmSync(dir(), { recursive: true, force: true });
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), 'block.manifest.json'), JSON.stringify(payload.manifest, null, 2));
  for (const f of payload.files) {
    fs.mkdirSync(path.dirname(path.join(dir(), f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir(), f.path), f.content);
  }
}

beforeAll(() => {
  ensureStagingDir();
  const salt = crypto.randomBytes(16).toString('hex');
  sessions.saveUser({
    username: 'operator', displayName: 'Operator', role: 'operator', salt,
    passHash: crypto.scryptSync('Fixture-Pass-1', salt, 64).toString('hex'),
    failedAttempts: 0, lockedUntil: 0, createdAt: new Date().toISOString(), sessions: {},
  });
  expect(sessions.hasAccount()).toBe(true);
});
afterEach(() => fs.rmSync(dir(), { recursive: true, force: true }));
afterAll(() => {
  delete process.env.VAULT_PATH; delete process.env.AEON_DB_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('with an operator account present', () => {
  it('a route that throws is still refused (it used to read as a 401 and pass)', async () => {
    stage(`const e=require('express');module.exports=function(d){const r=e.Router();r.get('/${ID}/status',()=>{throw new Error('boom')});return r;};`);
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.probes[0].status).toBe(500);
    expect(r.ok).toBe(false);
  });

  it('a handler\'s own 404 ("no record with that id") is an answer, not a missing route', async () => {
    // hr_arsenal's employees/get answers 404 for an unknown id; once the proof
    // ran handlers, reading every 404 as "no route" refused a correct block.
    stage(`const e=require('express');module.exports=function(d){const r=e.Router();r.get('/${ID}/status',(q,s)=>s.status(404).json({ok:false,error:'There is no record with that id.'}));return r;};`);
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('a declared route nothing serves is still a missing route', async () => {
    stage(`const e=require('express');module.exports=function(d){const r=e.Router();r.get('/${ID}/other',(q,s)=>s.json({ok:true}));return r;};`);
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/declared in the manifest but no route answered/);
  });

  it('a block that writes finds its own storage, and the handler really runs', async () => {
    stage(`const e=require('express');module.exports=function(d){const r=e.Router();r.get('/${ID}/status',(q,s)=>{d.blockStorage.writeJSON('probe.json',{n:1});s.json({ok:true,read:d.blockStorage.readJSON('probe.json')});});return r;};`);
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.errors).toEqual([]);
    expect(r.probes[0].status).toBe(200);
    expect(r.ok).toBe(true);
  });
});
