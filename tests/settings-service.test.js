import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const settings = require('../services/settings.js');
const express = require('express');
const mountSettingsApi = require('../src/blocks/settings/api/settings.js');

describe('Settings credential stores', () => {
  let tempDir;
  let previousMasterKey;
  let server;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-settings-test-'));
    previousMasterKey = process.env.AEON_VAULT_MASTER_KEY;
    process.env.AEON_VAULT_MASTER_KEY = 'test-only-master-key';
  });

  afterEach(() => {
    if (server) server.close();
    if (previousMasterKey === undefined) delete process.env.AEON_VAULT_MASTER_KEY;
    else process.env.AEON_VAULT_MASTER_KEY = previousMasterKey;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates the requested Supabase and Firebase Web Config schemas', () => {
    expect(() => settings.validateSupabaseConfig({
      url: 'http://project.supabase.co',
      anonKey: 'a'.repeat(40),
    })).toThrow(/HTTPS/);
    expect(() => settings.validateFirebaseConfig({
      private_key: 'private',
      projectId: 'project',
    })).toThrow(/service-account/);

    expect(settings.validateSupabaseConfig({
      url: 'https://project.supabase.co/',
      anonKey: 'a'.repeat(40),
    }).url).toBe('https://project.supabase.co');
    expect(settings.validateFirebaseConfig({
      apiKey: 'public-web-key',
      authDomain: 'project.firebaseapp.com',
      projectId: 'project-id',
      appId: '1:123:web:abc',
    }).projectId).toBe('project-id');
  });

  it('encrypts cloud credentials and returns metadata without raw keys', () => {
    const file = path.join(tempDir, 'Vault', 'blocks', 'security', 'cloud_credentials.json');
    const store = settings.createCloudCredentialStore({ file });
    const secret = 'anon-secret-value-that-is-long-enough';
    const metadata = store.save('supabase', {
      url: 'https://project.supabase.co',
      anonKey: secret,
    });
    const raw = fs.readFileSync(file, 'utf8');

    expect(raw).not.toContain(secret);
    expect(metadata.active).toEqual(['supabase']);
    expect(metadata.supabase).toMatchObject({
      configured: true,
      source: 'vault',
      projectId: 'project',
      hasAnonKey: true,
    });
    expect(JSON.stringify(metadata)).not.toContain(secret);
  });

  it('encrypts provider keys and hydrates runtime memory without exposing values', () => {
    const file = path.join(tempDir, 'Vault', 'blocks', 'security', 'provider_credentials.json');
    const store = settings.createProviderCredentialStore({ file });
    const target = {};
    store.save({ GROQ_API_KEY: 'gsk_test_secret' });

    expect(fs.readFileSync(file, 'utf8')).not.toContain('gsk_test_secret');
    expect(store.metadata()).toEqual({ GROQ_API_KEY: 'vault' });
    expect(store.hydrate(target)).toEqual(['GROQ_API_KEY']);
    expect(target.GROQ_API_KEY).toBe('gsk_test_secret');
  });

  // ── BO3: credential stores fail closed on an unreadable file ──────────────

  it('a missing file initializes a new store, but an unreadable file blocks writes', () => {
    const file = path.join(tempDir, 'Vault', 'blocks', 'security', 'cloud_credentials.json');
    const store = settings.createCloudCredentialStore({ file });

    // Missing → initializes normally.
    store.save('supabase', { url: 'https://a.supabase.co', anonKey: 'a'.repeat(40) });
    store.save('firebase', {
      apiKey: 'firebase-web-key', authDomain: 'p.firebaseapp.com', projectId: 'proj', appId: '1:1:web:a',
    });
    const original = fs.readFileSync(file);

    // Corrupt the ciphertext (flip the stored blob to malformed JSON).
    fs.writeFileSync(file, '{ this is not valid json ');
    const corrupted = fs.readFileSync(file);

    expect(() => store.save('supabase', { url: 'https://b.supabase.co', anonKey: 'b'.repeat(40) }))
      .toThrow(/unreadable/);
    expect(() => store.remove('firebase')).toThrow(/unreadable/);
    // Original (corrupt) bytes are preserved — no destructive overwrite.
    expect(fs.readFileSync(file)).toEqual(corrupted);
    expect(store.metadata()).toMatchObject({ active: [], unreadable: true });
    void original;
  });

  it('a wrong master key rejects save/remove and preserves the original ciphertext', () => {
    const file = path.join(tempDir, 'Vault', 'blocks', 'security', 'cloud_credentials.json');
    const store = settings.createCloudCredentialStore({ file });
    store.save('supabase', { url: 'https://a.supabase.co', anonKey: 'a'.repeat(40) });
    store.save('firebase', {
      apiKey: 'firebase-web-key', authDomain: 'p.firebaseapp.com', projectId: 'proj', appId: '1:1:web:a',
    });
    const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

    // Rotate the master key out from under the sealed file → GCM auth fails.
    process.env.AEON_VAULT_MASTER_KEY = 'a-different-master-key';
    expect(() => store.save('supabase', { url: 'https://c.supabase.co', anonKey: 'c'.repeat(40) }))
      .toThrow(/unreadable/);
    expect(() => store.remove('supabase')).toThrow(/unreadable/);

    const afterHash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect(afterHash).toBe(beforeHash);

    // With the correct key restored, the store reads and mutates normally again.
    process.env.AEON_VAULT_MASTER_KEY = 'test-only-master-key';
    expect(store.credentials('supabase')).toMatchObject({ url: 'https://a.supabase.co' });
    const meta = store.remove('firebase');
    expect(meta.active).toEqual(['supabase']);
  });

  it('an invalid authentication tag rejects a provider-store save and preserves bytes', () => {
    const file = path.join(tempDir, 'Vault', 'blocks', 'security', 'provider_credentials.json');
    const store = settings.createProviderCredentialStore({ file });
    store.save({ GROQ_API_KEY: 'gsk_original' });

    // Tamper with the sealed ciphertext — GCM tag no longer authenticates.
    const blob = JSON.parse(fs.readFileSync(file, 'utf8'));
    blob.data = `${blob.data.slice(0, -2)}${blob.data.slice(-2) === 'ff' ? '00' : 'ff'}`;
    fs.writeFileSync(file, JSON.stringify(blob, null, 2));
    const tampered = fs.readFileSync(file);

    expect(() => store.save({ OPENAI_API_KEY: 'sk_new' })).toThrow(/unreadable/);
    expect(fs.readFileSync(file)).toEqual(tampered);
    expect(store.hydrate({})).toEqual([]); // read path yields nothing, does not wipe
  });

  it('removing one provider leaves the others intact', () => {
    const file = path.join(tempDir, 'Vault', 'blocks', 'security', 'cloud_credentials.json');
    const store = settings.createCloudCredentialStore({ file });
    store.save('supabase', { url: 'https://a.supabase.co', anonKey: 'a'.repeat(40) });
    store.save('firebase', {
      apiKey: 'firebase-web-key', authDomain: 'p.firebaseapp.com', projectId: 'proj', appId: '1:1:web:a',
    });

    store.remove('supabase');
    expect(store.credentials('supabase')).toBeNull();
    expect(store.credentials('firebase')).toMatchObject({ projectId: 'proj' });
    expect(store.metadata().active).toEqual(['firebase']);
  });

  it('removes credential-shaped fields from settings responses', () => {
    expect(settings.sanitizeSettings({
      models: { chat: { provider: 'groq' } },
      apiKey: 'secret',
      nested: { refreshToken: 'secret', label: 'safe' },
    })).toEqual({
      models: { chat: { provider: 'groq' } },
      nested: { label: 'safe' },
    });
  });

  it('persists cloud config through POST /api/settings and returns detection metadata only', async () => {
    const cloudCredentials = settings.createCloudCredentialStore({
      file: path.join(tempDir, 'Vault', 'blocks', 'security', 'cloud_credentials.json'),
    });
    const providerCredentials = settings.createProviderCredentialStore({
      file: path.join(tempDir, 'Vault', 'blocks', 'security', 'provider_credentials.json'),
    });
    const app = express();
    app.use(express.json());
    mountSettingsApi(app, { cloudCredentials, providerCredentials, supabase: null });
    server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const secret = 'anon-secret-value-that-is-long-enough';

    const saved = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cloudProvider: {
          provider: 'supabase',
          config: { url: 'https://project.supabase.co', anonKey: secret },
        },
      }),
    });
    expect(saved.status).toBe(200);

    const firebaseSaved = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cloudProvider: {
          provider: 'firebase',
          config: {
            apiKey: 'firebase-public-web-key',
            authDomain: 'project.firebaseapp.com',
            projectId: 'firebase-project',
            appId: '1:123:web:abc',
          },
        },
      }),
    });
    expect(firebaseSaved.status).toBe(200);

    const response = await fetch(`${base}/api/settings`);
    const body = await response.json();
    expect(body.cloudProviders.active).toEqual(['supabase', 'firebase']);
    expect(body.cloudProviders.supabase.projectId).toBe('project');
    expect(body.cloudProviders.firebase.projectId).toBe('firebase-project');
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain('firebase-public-web-key');
  });
});
