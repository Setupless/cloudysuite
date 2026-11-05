import { beforeEach, expect, mock, test } from "bun:test";
import { testWorkerEnv } from "../../../src/db/test-database";
import { createKit, type Kit, signIn } from "../../auth/src/admin/test-kit";

const workers = {
  env: testWorkerEnv as unknown as Record<string, unknown>,
  DurableObject: class {},
};
mock.module("cloudflare:workers", () => workers);
const { requireCalendarUser } = await import("./access");

let kit: Kit;
let cookie: string;

beforeEach(async () => {
  kit = await createKit();
  workers.env.DB = kit.database;
  workers.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
  cookie = (await signIn(kit, "boss@example.com")).headers.get("set-cookie")!;
});

const through = (host: string) =>
  new Request(`https://${host}/_serverFn/x`, {
    method: "POST",
    headers: { cookie },
  });

test.each(["calendar.example.com", "mail.example.com"])(
  "with Calendar off, a call through %s is refused in plain words",
  async (host) => {
    expect((await requireCalendarUser(through(host))).id).toBe(kit.admin);

    kit.sqlite.run(
      "INSERT INTO app_settings (app, enabled) VALUES ('calendar', 0)",
    );
    const refused = await requireCalendarUser(through(host)).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(403);
    expect(
      ((await (refused as Response).json()) as { message: string }).message,
    ).toContain("turned Calendar off");
  },
);
