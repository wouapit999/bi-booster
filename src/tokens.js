// AES-GCM encryption for social platform tokens stored in Neon.
// The key is derived from the TOKEN_ENCRYPTION_KEY Worker secret.

const keyCache = new Map();

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function getKey(env) {
  const secret = env.TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new Error('TOKEN_ENCRYPTION_KEY must be set to at least 32 characters');
  if (!keyCache.has(secret)) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    keyCache.set(secret, await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return keyCache.get(secret);
}

export function encryptionConfigured(env) {
  return typeof env.TOKEN_ENCRYPTION_KEY === 'string' && env.TOKEN_ENCRYPTION_KEY.length >= 32;
}

export async function encryptToken(env, value) {
  if (!value) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(env), new TextEncoder().encode(value));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

export async function decryptToken(env, value) {
  if (!value) return '';
  const [iv, cipher] = value.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await getKey(env), fromBase64(cipher));
  return new TextDecoder().decode(plain);
}
