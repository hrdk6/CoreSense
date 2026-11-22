import crypto from 'node:crypto';

// ============================================================================
// Password Hashing (scrypt + per-user random salt + constant-time verify)
// ============================================================================
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hexKey] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hexKey, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// ============================================================================
// AES-256-GCM Authenticated Encryption at Rest (for BYOK keys & private secrets)
// ============================================================================
function deriveAesKey(rawKey: string): Buffer {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest();
}

export function encryptSecret(plaintext: string, rawKey: string): string {
  const key = deriveAesKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(ciphertext: string, rawKey: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid encrypted payload format');
  }
  const key = deriveAesKey(rawKey);
  const iv = Buffer.from(parts[1], 'base64');
  const authTag = Buffer.from(parts[2], 'base64');
  const encrypted = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ============================================================================
// Signed HS256 JWT (Zero dependency, separate audience/secret for Customer vs Owner)
// ============================================================================
export interface JwtPayload {
  sub: string;
  aud: 'coresense-customer' | 'coresense-owner';
  role: 'customer' | 'owner_admin';
  jti: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
}

export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'>,
  secret: string,
  expiresInSec = 86400,
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + expiresInSec,
  };
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(fullPayload));
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${base64UrlEncode(sig)}`;
}

export function verifyJwt(
  token: string,
  secret: string,
  expectedAudience: 'coresense-customer' | 'coresense-owner',
): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sigPart] = parts;
    const expectedSig = base64UrlEncode(
      crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest(),
    );
    const a = Buffer.from(sigPart);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const decoded = JSON.parse(base64UrlDecode(body)) as JwtPayload;
    if (decoded.aud !== expectedAudience) return null;
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

// ============================================================================
// One-way Anonymous User Hash (for Owner DAU/WAU/MAU retention without identity)
// ============================================================================
export function createAnonymousUserHash(userId: string, salt: string): string {
  return crypto
    .createHmac('sha256', `anon-telemetry:${salt}`)
    .update(userId)
    .digest('hex')
    .slice(0, 32);
}

// ============================================================================
// RFC 6238 TOTP (6-digit 30s) for Private Owner Console MFA
// ============================================================================
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  const buf = crypto.randomBytes(bytes);
  let bits = '';
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
  let secret = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

function decodeBase32(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx >= 0) bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotpCode(secret: string, timeStepOffset = 0): string {
  const key = decodeBase32(secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + timeStepOffset;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    1_000_000;
  return code.toString().padStart(6, '0');
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const trimmed = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(trimmed)) return false;
  for (const offset of [-1, 0, 1]) {
    if (generateTotpCode(secret, offset) === trimmed) return true;
  }
  return false;
}

// ============================================================================
// Upload Magic-Byte Validation (prevents spoofed executables / malformed files)
// ============================================================================
export function validateUploadedFile(
  buffer: Buffer,
  declaredMime: string,
  filename: string,
): { valid: boolean; detectedKind: 'pdf' | 'image' | 'text' | 'audio' | 'unknown'; reason?: string } {
  if (buffer.length === 0) return { valid: false, detectedKind: 'unknown', reason: 'Empty file.' };
  if (buffer.length > 20 * 1024 * 1024) {
    return { valid: false, detectedKind: 'unknown', reason: 'File exceeds 20 MB limit.' };
  }

  // Reject Windows PE / ELF / Mach-O (32/64/Universal/Fat64) binaries explicitly
  const isPe = buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a; // MZ (EXE/DLL)
  const isElf =
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46; // ELF
  const isMachO =
    buffer.length >= 4 &&
    ((buffer[0] === 0xfe && buffer[1] === 0xed && buffer[2] === 0xfa && (buffer[3] === 0xce || buffer[3] === 0xcf)) ||
      ((buffer[0] === 0xce || buffer[0] === 0xcf) && buffer[1] === 0xfa && buffer[2] === 0xed && buffer[3] === 0xfe) ||
      (buffer[0] === 0xca && buffer[1] === 0xfe && buffer[2] === 0xba && (buffer[3] === 0xbe || buffer[3] === 0xbf)) ||
      ((buffer[0] === 0xbe || buffer[0] === 0xbf) && buffer[1] === 0xba && buffer[2] === 0xfe && buffer[3] === 0xca));
  if (isPe || isElf || isMachO) {
    return { valid: false, detectedKind: 'unknown', reason: 'Executable binaries are not permitted.' };
  }

  // PDF: %PDF-
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { valid: true, detectedKind: 'pdf' };
  }
  // PNG
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { valid: true, detectedKind: 'image' };
  }
  // JPEG
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, detectedKind: 'image' };
  }
  // WebP
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { valid: true, detectedKind: 'image' };
  }
  // WAV / WebM / MP3 audio
  if (
    (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') ||
    (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) ||
    buffer.subarray(0, 3).toString('ascii') === 'ID3'
  ) {
    return { valid: true, detectedKind: 'audio' };
  }
  // Plain text / Markdown / JSON / CSV technical documents
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (
    ['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yaml', 'yml'].includes(ext) ||
    declaredMime.startsWith('text/')
  ) {
    // Reject NUL bytes indicating binary content masquerading as text
    if (!buffer.subarray(0, Math.min(4096, buffer.length)).includes(0x00)) {
      return { valid: true, detectedKind: 'text' };
    }
  }

  return { valid: false, detectedKind: 'unknown', reason: 'Unsupported or mismatched file signature.' };
}
