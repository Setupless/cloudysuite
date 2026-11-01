import { expect, test } from "bun:test";
import { emailDomainNames, parseAddress } from "./addresses";

test("one domain doing both jobs is an email domain", () => {
  expect(emailDomainNames([{ name: "example.com", isPrimary: true }])).toEqual([
    "example.com",
  ]);
});

test("an app domain under an email domain isn't offered for addresses", () => {
  expect(
    emailDomainNames([
      { name: "suite.example.com", isPrimary: true },
      { name: "example.com", isPrimary: false },
    ]),
  ).toEqual(["example.com"]);
});

test("the app domain stays first when it also takes email", () => {
  expect(
    emailDomainNames([
      { name: "acme.org", isPrimary: false },
      { name: "example.com", isPrimary: true },
    ]),
  ).toEqual(["example.com", "acme.org"]);
});

test("addresses are stored lowercase", () => {
  expect(parseAddress(" Maya.Chen@Example.COM ")).toEqual({
    address: "maya.chen@example.com",
    domain: "example.com",
  });
});

test.each([
  "maya",
  "@example.com",
  "maya@",
  "a b@example.com",
  "a..b@example.com",
  ".a@example.com",
  "a.@example.com",
  "a@b@example.com",
])("%s isn't a valid address", (raw) => {
  expect(parseAddress(raw)).toBeNull();
});
