import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveScrypt(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, derived) => error ? reject(error) : resolve(derived));
  });
}

export function normalizeUsername(value: unknown) {
  const username = String(value || "").trim();
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new Error("管理员用户名需为 3 至 40 位字母、数字或 . _ -");
  return username;
}

export function validatePassword(value: unknown) {
  const password = String(value || "");
  if (password.length < 6 || password.length > 128) throw new Error("管理员密码需为 6 至 128 位");
  return password;
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = await deriveScrypt(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, saltValue, expectedValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltValue || !expectedValue) return false;
  const expected = Buffer.from(expectedValue, "base64url");
  const actual = await deriveScrypt(password, Buffer.from(saltValue, "base64url"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function loadOrCreatePepper(dataDirectory: string) {
  const envPepper = process.env.PANELARK_CDK_PEPPER?.trim();
  if (envPepper) return Buffer.from(envPepper, "utf8");
  const secretPath = path.join(dataDirectory, "panelark.secret");
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath);
  const secret = randomBytes(32);
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

export function hashCdk(code: string, pepper: Buffer) {
  return createHmac("sha256", pepper).update(normalizeCdk(code)).digest("hex");
}

export function normalizeCdk(code: unknown) {
  return String(code || "").trim().toUpperCase().replace(/\s+/g, "");
}

export function safeEqualString(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  for (const pair of (header || "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    cookies[decodeURIComponent(pair.slice(0, separator).trim())] = decodeURIComponent(pair.slice(separator + 1).trim());
  }
  return cookies;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateCdkCode() {
  const bytes = randomBytes(12);
  const body = Array.from(bytes, value => ALPHABET[value % ALPHABET.length]).join("");
  return `PAK-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(bytes = 20) {
  const input = randomBytes(bytes);
  let bits = "";
  for (const value of input) bits += value.toString(2).padStart(8, "0");
  let output = "";
  for (let index = 0; index < bits.length; index += 5) {
    output += BASE32_ALPHABET[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  }
  return output;
}

function decodeBase32(value: string) {
  let bits = "";
  for (const character of value.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("2FA 密钥格式无效");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secret: string, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 30_000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

export function verifyTotp(code: unknown, secret: string, timestamp = Date.now()) {
  const normalized = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  return [-1, 0, 1].some(window => safeEqualString(normalized, totpCode(secret, timestamp + window * 30_000)));
}
