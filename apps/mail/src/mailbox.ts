import { DurableObject } from "cloudflare:workers";

export class Mailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        received_at INTEGER NOT NULL
      )
    `);
  }

  async store(raw: ArrayBuffer): Promise<void> {
    const digest = await crypto.subtle.digest("SHA-256", raw);
    const hash = new Uint8Array(digest).toHex();

    // R2 first: a crash before the insert leaves an object that a retry
    // overwrites with the same bytes, and a row never points at nothing.
    await this.env.BUCKET.put(`messages/${hash}`, raw);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO messages (hash, size, received_at) VALUES (?, ?, ?)",
      hash,
      raw.byteLength,
      Date.now(),
    );
  }
}
