import { expect, test } from "bun:test";
import {
  encryptPayload,
  fromBase64Url,
  generateVapidKeys,
  MAX_PLAINTEXT_BYTES,
  toBase64Url,
  vapidAuthorization,
} from "./web-push";

// RFC 8291, Appendix A.
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function ecdhPrivateKey(d: string, publicKey: string) {
  const raw = fromBase64Url(publicKey);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d,
      x: toBase64Url(raw.subarray(1, 33)),
      y: toBase64Url(raw.subarray(33, 65)),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

// Written from RFC 8291 section 3 separately from the code under test, in the
// browser's role, so a round trip proves more than the code agreeing with itself.
async function decryptAsBrowser(
  message: Uint8Array<ArrayBuffer>,
  browserPrivate: CryptoKey,
  browserPublic: Uint8Array<ArrayBuffer>,
  auth: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const salt = message.slice(0, 16);
  const idLength = message[20] as number;
  const serverPublic = message.slice(21, 21 + idLength);
  const ciphertext = message.slice(21 + idLength);
  const derive = async (
    bitsFrom: Uint8Array<ArrayBuffer>,
    saltBytes: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>,
    bytes: number,
  ) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: saltBytes, info },
        await crypto.subtle.importKey("raw", bitsFrom, "HKDF", false, [
          "deriveBits",
        ]),
        bytes * 8,
      ),
    );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey(
          "raw",
          serverPublic,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        ),
      },
      browserPrivate,
      256,
    ),
  );
  const label = new TextEncoder().encode("WebPush: info\0");
  const info = new Uint8Array(label.length + 130);
  info.set(label);
  info.set(browserPublic, label.length);
  info.set(serverPublic, label.length + 65);
  const ikm = await derive(shared, auth, info, 32);
  const text = (value: string) => new TextEncoder().encode(value);
  const key = await derive(
    ikm,
    salt,
    text("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await derive(ikm, salt, text("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]),
      ciphertext,
    ),
  );
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.subarray(0, -1));
}

test("encryption produces RFC 8291's published message, byte for byte", async () => {
  const message = await encryptPayload(
    fromBase64Url(RFC.plaintext),
    { p256dh: fromBase64Url(RFC.uaPublic), auth: fromBase64Url(RFC.auth) },
    fromBase64Url(RFC.salt),
    {
      privateKey: await ecdhPrivateKey(RFC.asPrivate, RFC.asPublic),
      publicKey: fromBase64Url(RFC.asPublic),
    },
  );
  expect(toBase64Url(message)).toBe(RFC.message);
});

test("a browser can read a message encrypted for it, and each one differs", async () => {
  const browser = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const p256dh = new Uint8Array(
    await crypto.subtle.exportKey("raw", browser.publicKey),
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const plaintext = new TextEncoder().encode('{"subject":"Lunch?"}');
  const first = await encryptPayload(plaintext, { p256dh, auth });
  const second = await encryptPayload(plaintext, { p256dh, auth });

  expect(await decryptAsBrowser(first, browser.privateKey, p256dh, auth)).toBe(
    '{"subject":"Lunch?"}',
  );
  expect(toBase64Url(first)).not.toBe(toBase64Url(second));
  expect(new TextDecoder().decode(first)).not.toContain("Lunch");
});

test("a message too long for one record is refused rather than cut", async () => {
  const browser = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const keys = {
    p256dh: new Uint8Array(
      await crypto.subtle.exportKey("raw", browser.publicKey),
    ),
    auth: new Uint8Array(16),
  };
  const longest = await encryptPayload(
    new Uint8Array(MAX_PLAINTEXT_BYTES),
    keys,
  );
  expect(longest.length).toBeLessThanOrEqual(4096);
  await expect(
    encryptPayload(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), keys),
  ).rejects.toThrow();
});

test("the VAPID token verifies against the public key and names one push service", async () => {
  const keys = await generateVapidKeys();
  const now = 1_800_000_000_000;
  const header = await vapidAuthorization(
    "https://fcm.googleapis.com/fcm/send/abc",
    keys,
    "https://mail.example.com",
    now,
  );
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  if (!match) throw new Error(`Unexpected header: ${header}`);
  const [, head, claims, signature, publicKey] = match as unknown as string[];
  expect(publicKey).toBe(keys.publicKey);
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      await crypto.subtle.importKey(
        "raw",
        fromBase64Url(keys.publicKey as string) as Uint8Array<ArrayBuffer>,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      ),
      fromBase64Url(signature as string) as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(`${head}.${claims}`),
    ),
  ).toBe(true);
  const decoded = JSON.parse(
    new TextDecoder().decode(fromBase64Url(claims as string)),
  );
  expect(decoded.aud).toBe("https://fcm.googleapis.com");
  expect(decoded.sub).toBe("https://mail.example.com");
  // RFC 8292 caps a token at 24 hours.
  expect(decoded.exp - now / 1000).toBeLessThanOrEqual(24 * 60 * 60);
  expect(decoded.exp).toBeGreaterThan(now / 1000);
});
