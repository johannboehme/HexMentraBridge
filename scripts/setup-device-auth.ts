#!/usr/bin/env bun
/**
 * One-time setup: generate a keypair for the G1 Bridge and pair it with the Gateway.
 * Saves the keypair to .device-auth.json.
 * Run once: bun scripts/setup-device-auth.ts
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import WebSocket from 'ws';

const ENV_PATH = path.join(import.meta.dir, '../.env');
const AUTH_PATH = path.join(import.meta.dir, '../.device-auth.json');

// Load .env
const envContent = fs.readFileSync(ENV_PATH, 'utf8');
const envVars: Record<string, string> = {};
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  envVars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
}

const GW_URL = envVars['OPENCLAW_WS_URL'] || 'ws://localhost:18789';
const GW_TOKEN = envVars['OPENCLAW_GW_TOKEN'] || '';

// Generate or load keypair
let keyData: any;
if (fs.existsSync(AUTH_PATH)) {
  keyData = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
  console.log(`Using existing keypair, device ID: ${keyData.deviceId}`);
} else {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const pubRaw = pubDer.slice(-32); // last 32 bytes is raw key
  const pubBase64url = pubRaw.toString('base64url');
  const deviceId = crypto.createHash('sha256').update(pubRaw).digest('hex');

  keyData = {
    deviceId,
    publicKeyBase64url: pubBase64url,
    privateKeyPkcs8Base64: privDer.toString('base64'),
  };
  fs.writeFileSync(AUTH_PATH, JSON.stringify(keyData, null, 2));
  console.log(`Generated new keypair, device ID: ${deviceId}`);
}

function signPayload(payload: string, privKeyPkcs8Base64: string): string {
  const privDer = Buffer.from(privKeyPkcs8Base64, 'base64');
  const privateKey = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
  const sig = crypto.sign(null, Buffer.from(payload), privateKey);
  return sig.toString('base64url');
}

function buildPayload(params: {
  deviceId: string, clientId: string, clientMode: string,
  role: string, scopes: string[], signedAtMs: number, token: string
}): string {
  const version = 'v1';
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  return [version, params.deviceId, params.clientId, params.clientMode, params.role, scopes, String(params.signedAtMs), token].join('|');
}

// Connect and attempt to pair
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'cli';
const ROLE = 'operator';
const SCOPES = ['operator.read', 'operator.write'];

const ws = new WebSocket(GW_URL);
let idCounter = 0;
const nextId = () => `setup-${++idCounter}`;

ws.on('open', () => {
  const signedAt = Date.now();
  const payload = buildPayload({
    deviceId: keyData.deviceId,
    clientId: CLIENT_ID,
    clientMode: CLIENT_MODE,
    role: ROLE,
    scopes: SCOPES,
    signedAtMs: signedAt,
    token: GW_TOKEN,
  });
  const signature = signPayload(payload, keyData.privateKeyPkcs8Base64);

  const connId = nextId();
  ws.send(JSON.stringify({
    type: 'req', id: connId, method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: CLIENT_ID, displayName: 'G1 Bridge Setup', version: '0.9.0', platform: 'linux', mode: CLIENT_MODE },
      role: ROLE,
      scopes: SCOPES,
      auth: { token: GW_TOKEN },
      device: {
        id: keyData.deviceId,
        publicKey: keyData.publicKeyBase64url,
        signature,
        signedAt,
      },
    },
  }));

  ws.on('message', (raw: Buffer) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'res' && msg.id === connId) {
      if (msg.ok) {
        const deviceToken = msg.payload?.auth?.deviceToken;
        console.log('Connected successfully!');
        if (deviceToken) {
          keyData.deviceToken = deviceToken;
          keyData.scopes = msg.payload?.auth?.scopes;
          fs.writeFileSync(AUTH_PATH, JSON.stringify(keyData, null, 2));
          console.log('Device token saved:', deviceToken);
          console.log('Scopes:', keyData.scopes);
          ws.close();
          process.exit(0);
        } else {
          console.log('Connected but no device token in response (may need pairing approval)');
          console.log('Response:', JSON.stringify(msg.payload, null, 2));
          ws.close();
          process.exit(0);
        }
      } else {
        const err = msg.error?.message || JSON.stringify(msg.error);
        if (err.includes('NOT_PAIRED') || err.includes('device identity required') || err.includes('pending')) {
          console.log('Device needs pairing approval. Run: openclaw devices approve');
          console.log('Device ID:', keyData.deviceId);
          console.log('Then re-run this script.');
        } else {
          console.error('Connect failed:', err);
        }
        ws.close();
        process.exit(1);
      }
    }
  });
});

ws.on('error', (err: Error) => {
  console.error('WS error:', err.message);
  process.exit(1);
});
