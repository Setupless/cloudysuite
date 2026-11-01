export async function ingest(
  env: Env,
  message: { to: string; raw: ArrayBuffer },
): Promise<void> {
  const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(message.to));
  await mailbox.store(message.raw);
}
