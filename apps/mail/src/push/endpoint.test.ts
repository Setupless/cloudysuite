import { expect, test } from "bun:test";
import { parsePushEndpoint } from "./endpoint";

test.each([
  "https://fcm.googleapis.com/fcm/send/abc",
  "https://jmt17.google.com/fcm/send/abc",
  "https://updates.push.services.mozilla.com/wpush/v2/abc",
  "https://web.push.apple.com/QGuQyavXutnMH",
  "https://wns2-bl2p.notify.windows.com/w/?token=abc",
])("accepts a browser's real push service: %s", (endpoint) => {
  expect(parsePushEndpoint(endpoint)).toBe(endpoint);
});

test.each([
  ["plain http", "http://fcm.googleapis.com/fcm/send/abc"],
  ["loopback", "https://127.0.0.1/x"],
  ["loopback by name", "https://localhost/x"],
  ["IPv6 loopback", "https://[::1]/x"],
  ["a metadata host", "http://169.254.169.254/latest/meta-data/"],
  ["a metadata host over https", "https://169.254.169.254/latest/meta-data/"],
  ["Google's metadata name", "https://metadata.google.internal/x"],
  ["a private address", "https://10.0.0.1/x"],
  ["an address written as a number", "https://2130706433/x"],
  ["some other site", "https://example.com/x"],
  ["a look-alike suffix", "https://fcm.googleapis.com.example.com/x"],
  ["another Google host", "https://accounts.google.com/x"],
  ["a look-alike prefix", "https://evilfcm.googleapis.com/x"],
  ["a look-alike parent", "https://evilpush.apple.com/x"],
  ["the bare parent", "https://notify.windows.com/x"],
  ["credentials in the URL", "https://me:pw@fcm.googleapis.com/x"],
  ["credentials hiding the host", "https://fcm.googleapis.com@example.com/x"],
  ["another port", "https://fcm.googleapis.com:8443/x"],
  ["another scheme", "file:///etc/passwd"],
  ["not a URL", "nonsense"],
  ["an empty string", ""],
  ["a very long URL", `https://fcm.googleapis.com/${"a".repeat(2000)}`],
])("refuses %s", (_name, endpoint) => {
  expect(parsePushEndpoint(endpoint)).toBeNull();
});
