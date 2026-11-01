// Web push by hand with WebCrypto, as the README decides: RFC 8291 encrypts the
// message for one browser, and RFC 8292 (VAPID) signs the request to its push service.

export type PushKeys = {
  // The browser's P-256 public key, uncompressed, and its 16-byte auth secret.
  p256dh: Uint8Array;
  auth: Uint8Array;
};

export type VapidKeys = { publicKey: string; privateKey: string };

// An encrypted record holds one padding delimiter and a 16-byte tag, and RFC 8291
// sets this as the record size every push service must accept.
export const RECORD_SIZE = 4096;
const HEADER_BYTES = 86;
const TAG_AND_DELIMITER_BYTES = 17;
export const MAX_PLAINTEXT_BYTES =
  RECORD_SIZE - HEADER_BYTES - TAG_AND_DELIMITER_BYTES;

const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;

export const toBase64Url = (bytes: Uint8Array): string =>
  bytes.toBase64({ alphabet: "base64url", omitPadding: true });

export const fromBase64Url = (text: string): Uint8Array =>
  Uint8Array.fromBase64(text, { alphabet: "base64url" });

const utf8 = (text: string) => new TextEncoder().encode(text);

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", concat(ikm), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: concat(salt), info: concat(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

const importEcdhPublic = (raw: Uint8Array) =>
  crypto.subtle.importKey(
    "raw",
    concat(raw),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

export type EphemeralKey = { privateKey: CryptoKey; publicKey: Uint8Array };

async function newEphemeralKey(): Promise<EphemeralKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    ),
  };
}

// The `salt` and `ephemeral` arguments exist for RFC 8291's published test vector.
// Reusing either for a second message would break the encryption.
export async function encryptPayload(
  plaintext: Uint8Array,
  browser: PushKeys,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
  ephemeral?: EphemeralKey,
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error("A push message can't be this long.");
  }
  const server = ephemeral ?? (await newEphemeralKey());
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: await importEcdhPublic(browser.p256dh) },
      server.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    browser.auth,
    shared,
    concat(utf8("WebPush: info\0"), browser.p256dh, server.publicKey),
    32,
  );
  const contentKey = await hkdf(
    salt,
    ikm,
    utf8("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey(
    "raw",
    concat(contentKey),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: concat(nonce) },
      key,
      concat(plaintext, new Uint8Array([2])),
    ),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
  return concat(
    salt,
    recordSize,
    new Uint8Array([server.publicKey.length]),
    server.publicKey,
    ciphertext,
  );
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const { d } = (await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  )) as JsonWebKey;
  return {
    publicKey: toBase64Url(new Uint8Array(raw)),
    privateKey: d as string,
  };
}

function signingJwk({ publicKey, privateKey }: VapidKeys): JsonWebKey {
  const raw = fromBase64Url(publicKey);
  return {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(raw.subarray(1, 33)),
    y: toBase64Url(raw.subarray(33, 65)),
    d: privateKey,
  };
}

// The token names the push service it is for, so it is no use against any other.
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  contact: string,
  now: number,
): Promise<string> {
  const encode = (value: object) => toBase64Url(utf8(JSON.stringify(value)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + VAPID_LIFETIME_SECONDS,
    sub: contact,
  })}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    signingJwk(keys),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(unsigned),
  );
  return `vapid t=${unsigned}.${toBase64Url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}
