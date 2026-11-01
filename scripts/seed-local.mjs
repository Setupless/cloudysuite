import { $ } from "bun";

const url = await $`portless get cloudysuite`.text();
const { hostname } = new URL(url.trim());
const sql = `INSERT OR REPLACE INTO domains (name, is_primary) VALUES ('${hostname}', 1)`;
await $`wrangler d1 execute DB --local --command ${sql}`;
