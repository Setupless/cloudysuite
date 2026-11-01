import { expect, test } from "bun:test";
import { emailFrameDocument, emailFramePolicy } from "./frame-document";

const palette = {
  scheme: "light",
  page: "white",
  text: "black",
  link: "blue",
} as const;

test("a remote image needs the reader's say-so", () => {
  expect(emailFramePolicy(false)).toContain("img-src data:;");
  expect(emailFramePolicy(false)).not.toContain("https:");
  expect(emailFramePolicy(true)).toContain("img-src data: https: http:;");
});

test("nothing but images and inline styles can ever load", () => {
  for (const showing of [false, true]) {
    const policy = emailFramePolicy(showing);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("style-src 'unsafe-inline'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("script-src");
  }
});

test("the policy comes before any mail content", () => {
  const document = emailFrameDocument(
    `<meta http-equiv="Content-Security-Policy" content="default-src *">`,
    false,
    palette,
  );
  const policyAt = document.indexOf("Content-Security-Policy");
  expect(policyAt).toBeGreaterThan(-1);
  expect(policyAt).toBeLessThan(document.indexOf("default-src *"));
  expect(document.indexOf("<base")).toBeLessThan(
    document.indexOf("default-src *"),
  );
});

test("a tag the mail left open has nothing after it to close it", () => {
  const unterminated = "<img src=x onerror=alert(1)//";
  expect(emailFrameDocument(unterminated, false, palette)).toEndWith(
    unterminated,
  );
});
