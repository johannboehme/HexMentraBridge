import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createPrivateKey, sign as cryptoSign } from 'crypto';

export interface DeviceAuthData {
  deviceId: string;
  publicKeyBase64url: string;
  privateKeyPkcs8Base64: string;
  deviceToken?: string;
}

const DEVICE_AUTH_PATH = join(import.meta.dir, '../.device-auth.json');
export const deviceAuth: DeviceAuthData | null =
  existsSync(DEVICE_AUTH_PATH) ? JSON.parse(readFileSync(DEVICE_AUTH_PATH, 'utf8')) : null;

export function buildDeviceAuthPayload(params: {
  deviceId: string; clientId: string; clientMode: string;
  role: string; scopes: string[]; signedAtMs: number; token: string;
  nonce?: string;
}): string {
  return ['v2', params.deviceId, params.clientId, params.clientMode, params.role, params.scopes.join(','), String(params.signedAtMs), params.token, params.nonce ?? ''].join('|');
}

export function signDevicePayload(payload: string): string {
  if (!deviceAuth) throw new Error('No device auth');
  const privDer = Buffer.from(deviceAuth.privateKeyPkcs8Base64, 'base64');
  const privateKey = createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
  return cryptoSign(null, Buffer.from(payload), privateKey).toString('base64url');
}
