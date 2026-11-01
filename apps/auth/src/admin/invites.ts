import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  addresses,
  invites,
  mailboxAccess,
  type MailboxId,
  mailboxes,
  type OrgRole,
  user,
  type UserId,
} from "../../../../src/db/schema";
import type { createAuth } from "../auth";
import { type Outcome, refuse } from "../outcome";
import { hashToken, newToken } from "../tokens";
import { inviteRefusal, type InviteView } from "../welcome/invite-view";
import { checkNewAddress, parseAddress } from "./addresses";

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) {
    return `Your password is too short. Use at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > PASSWORD_MAX) {
    return `Your password is too long. Use at most ${PASSWORD_MAX} characters.`;
  }
  return null;
}

export type NewInvite = {
  email: string;
  role: OrgRole;
  mailboxAddress: string | null;
  invitedBy: UserId;
};

export async function createInvite(
  database: D1Database,
  input: NewInvite,
  now = new Date(),
): Promise<Outcome<{ token: string; email: string }>> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) {
    return refuse("That email address isn't valid. Check it and try again.");
  }
  const db = drizzle(database);
  let mailboxAddress: string | null = null;
  if (input.mailboxAddress) {
    const check = await checkNewAddress(database, input.mailboxAddress);
    if (!check.ok) return check;
    mailboxAddress = check.parsed.address;
    if (mailboxAddress === email) {
      return refuse(
        "We can't deliver an invite to an address that doesn't exist yet. Send it to an address they can already read, such as a personal one.",
      );
    }
  }
  const signInEmail = mailboxAddress ?? email;
  const [existing, pending] = await Promise.all([
    db.select({ id: user.id }).from(user).where(eq(user.email, signInEmail)),
    db
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.email, email), isNull(invites.usedAt))),
  ]);
  if (existing.length > 0) {
    return refuse(`${signInEmail} already has an account.`);
  }
  if (pending.length > 0) {
    return refuse(
      `${email} already has an invite. Use Send again in the list below.`,
    );
  }
  const token = newToken();
  await db.insert(invites).values({
    tokenHash: await hashToken(token),
    email,
    role: input.role,
    mailboxAddress,
    invitedBy: input.invitedBy,
    expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
  });
  return { ok: true, token, email };
}

export async function renewInvite(
  database: D1Database,
  id: string,
  now = new Date(),
): Promise<Outcome<{ token: string; email: string }>> {
  const db = drizzle(database);
  const [current] = await db
    .select({
      mailboxAddress: invites.mailboxAddress,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .where(and(eq(invites.id, id), isNull(invites.usedAt)));
  // An unexpired invite still holds its address. An expired one let go of it,
  // so someone else may have it now.
  if (current?.mailboxAddress && current.expiresAt <= now) {
    const check = await checkNewAddress(
      database,
      current.mailboxAddress,
      undefined,
      now,
    );
    if (!check.ok) {
      return refuse(
        `${current.mailboxAddress} is already taken, so this invite can't be sent again. Cancel it and invite them with a different address.`,
      );
    }
  }
  const token = newToken();
  const [row] = await db
    .update(invites)
    .set({
      tokenHash: await hashToken(token),
      expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
    })
    .where(and(eq(invites.id, id), isNull(invites.usedAt)))
    .returning({ email: invites.email });
  if (!row) return refuse("This invite has already been used or cancelled.");
  return { ok: true, token, email: row.email };
}

export async function cancelInvite(
  database: D1Database,
  id: string,
): Promise<void> {
  await drizzle(database)
    .delete(invites)
    .where(and(eq(invites.id, id), isNull(invites.usedAt)));
}

export async function readInvite(
  database: D1Database,
  token: string,
  now = new Date(),
): Promise<InviteView> {
  const [row] = await drizzle(database)
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, await hashToken(token)));
  if (!row) return { state: "unknown" };
  if (row.usedAt) return { state: "used" };
  if (row.expiresAt <= now) return { state: "expired" };
  return { state: "open", signInEmail: row.mailboxAddress ?? row.email };
}

export async function acceptInvite(
  auth: ReturnType<typeof createAuth>,
  database: D1Database,
  input: { token: string; name: string; password: string },
  now = new Date(),
): Promise<Outcome<{ signInEmail: string }>> {
  const name = input.name.trim();
  if (!name) return refuse("Enter your name.");
  const problem = passwordProblem(input.password);
  if (problem) return refuse(problem);

  const db = drizzle(database);
  // The single atomic step. Of any number of concurrent requests, only one
  // gets a row back, and the rest stop here.
  const [invite] = await db
    .update(invites)
    .set({ usedAt: now })
    .where(
      and(
        eq(invites.tokenHash, await hashToken(input.token)),
        isNull(invites.usedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .returning();
  if (!invite) {
    const view = await readInvite(database, input.token, now);
    return refuse(
      view.state === "open" ? "Please try again." : inviteRefusal(view.state),
    );
  }

  const signInEmail = invite.mailboxAddress ?? invite.email;
  let userId: UserId;
  try {
    const { user: created } = await auth.api.createUser({
      body: {
        email: signInEmail,
        password: input.password,
        name,
        role: invite.role,
        data: { emailVerified: true },
      },
    });
    userId = created.id as UserId;
  } catch {
    // Nothing was created, so the person can still use their link.
    await db
      .update(invites)
      .set({ usedAt: null })
      .where(eq(invites.id, invite.id));
    return refuse(
      `We couldn't create an account for ${signInEmail}. It may already have one, so try signing in, or ask your admin for help.`,
    );
  }

  const parsed = invite.mailboxAddress
    ? parseAddress(invite.mailboxAddress)
    : null;
  if (parsed) {
    try {
      await createPersonalMailbox(database, userId, name, parsed);
    } catch (error) {
      // The account exists, so signing in must still work. An admin can add
      // the mailbox from the Email addresses page.
      console.error("Could not create a personal mailbox.", error);
    }
  }
  return { ok: true, signInEmail };
}

export async function createPersonalMailbox(
  database: D1Database,
  userId: UserId,
  name: string,
  { address, domain }: { address: string; domain: string },
): Promise<MailboxId> {
  const db = drizzle(database);
  const mailboxId = crypto.randomUUID() as MailboxId;
  await db.batch([
    db.insert(mailboxes).values({ id: mailboxId, kind: "personal", name }),
    db
      .insert(addresses)
      .values({ address, domain, mailboxId, kind: "primary" }),
    db.insert(mailboxAccess).values({ mailboxId, userId, role: "manager" }),
  ]);
  return mailboxId;
}

type InviteMail = {
  to: string;
  from: string;
  inviterName: string;
  link: string;
};

export async function sendInviteEmail(
  sender: Pick<SendEmail, "send">,
  { to, from, inviterName, link }: InviteMail,
): Promise<boolean> {
  try {
    await sender.send({
      to,
      from: { name: "CloudySuite", email: from },
      subject: `${inviterName} invited you to CloudySuite`,
      text: [
        `${inviterName} invited you to join your organisation on CloudySuite.`,
        "",
        "Open this link to create your account. It works once and expires in 7 days.",
        "",
        link,
        "",
        "If you weren't expecting this, you can ignore this email.",
      ].join("\n"),
    });
    return true;
  } catch (error) {
    console.error(
      "Could not send an invite.",
      (error as { code?: string }).code ?? "unknown error",
    );
    return false;
  }
}
