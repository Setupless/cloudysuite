import { env } from "cloudflare:workers";
import {
  jevKeyIsSet,
  type JevUsage,
  readJevUsage,
  writeJevKey,
} from "@cloudysuite/jev";
import { isBanned } from "@cloudysuite/access";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  type DriveId,
  type MailboxId,
  type MailboxRole,
  type OrgRole,
  user,
  type UserId,
} from "../../../../src/db/schema";
import type { ToggleableApp } from "../../../../src/routing";
import { readSettings } from "../../../../src/settings";
import { adminOnly } from "../middleware";
import { type Outcome, refuse } from "../outcome";
import { getAuth } from "../server";
import { readRequire2fa } from "../sign-in-methods-store";
import {
  readEmailDomains,
  readDomainRows,
  emailDomainNames,
} from "./addresses";
import {
  addEmailDomain,
  checkDomain,
  type DomainChecks,
  parseDomainName,
  resolveOverHttps,
} from "./domains";
import {
  appointNextManagers,
  claimDrive,
  type DriveToClaim,
  handOver,
  listDrivesToClaim,
  readToHand,
} from "./handover";
import { needsRecipient, SPACE_KINDS } from "./handover-text";
import {
  readDriveId,
  readFlag,
  readJevAcknowledgement,
  readLimitBytes,
  readMailboxId,
  readMailboxRole,
  readOrgRole,
  readRecipientId,
  readText,
  readToggleableApp,
  readUserId,
} from "./input";
import {
  cancelInvite as cancelInviteRow,
  createInvite,
  renewInvite,
  sendInviteEmail,
} from "./invites";
import { saveKey, type SavedKey } from "./jev";
import {
  addAlias as addAliasRow,
  addPersonalMailbox,
  createSharedMailbox as createSharedMailboxRow,
  grantAccess,
  listMailboxes,
  type MailboxesView,
  removeAlias as removeAliasRow,
  revokeAccess,
} from "./mailboxes";
import {
  countPeopleWithoutSecondWay,
  readStorageOverview,
  setAppEnabled,
  setMyFilesLimit,
  setRequire2fa,
  setStorageLimit,
  type StorageOverview,
  TOGGLEABLE_APPS,
} from "./organisation";
import {
  forgetResetLinks,
  type InviteRow,
  listPeople,
  type PersonRow,
} from "./people";
import { issueResetLink } from "./reset";
import {
  createUpdateChecker,
  RUNNING_VERSION,
  type UpdateNotice,
} from "./updates";

export type InviteDelivery = { sent: true } | { sent: false; link: string };

async function deliverInvite(
  { token, email }: { token: string; email: string },
  inviterName: string,
): Promise<InviteDelivery> {
  const { origins } = await getAuth(getRequest());
  const link = `${origins.auth}/invite/${token}`;
  const [from] = await readEmailDomains(env.DB);
  const sent =
    from !== undefined &&
    (await sendInviteEmail(env.EMAIL, {
      to: email,
      from: `no-reply@${from}`,
      inviterName,
      link,
    }));
  return sent ? { sent: true } : { sent: false, link };
}

// People.

export const getPeople = createServerFn({ method: "GET" })
  .middleware([adminOnly])
  .handler(
    async ({
      context,
    }): Promise<{
      youId: UserId;
      people: PersonRow[];
      invites: InviteRow[];
      emailDomains: string[];
      drivesToClaim: DriveToClaim[];
    }> => {
      const [view, emailDomains, drivesToClaim] = await Promise.all([
        listPeople(env.DB),
        readEmailDomains(env.DB),
        listDrivesToClaim(env.DB),
      ]);
      return { youId: context.admin.id, ...view, emailDomains, drivesToClaim };
    },
  );

export const inviteMember = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator(
    (input: { email: string; role: OrgRole; mailboxAddress: string }) => ({
      email: readText(input, "email"),
      role: readOrgRole(input),
      mailboxAddress: readText(input, "mailboxAddress"),
    }),
  )
  .handler(async ({ data, context }): Promise<Outcome<InviteDelivery>> => {
    const created = await createInvite(env.DB, {
      email: data.email,
      role: data.role,
      mailboxAddress: data.mailboxAddress || null,
      invitedBy: context.admin.id,
    });
    if (!created.ok) return created;
    return { ok: true, ...(await deliverInvite(created, context.admin.name)) };
  });

export const resendInvite = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { id: string }) => ({ id: readText(input, "id") }))
  .handler(async ({ data, context }): Promise<Outcome<InviteDelivery>> => {
    const renewed = await renewInvite(env.DB, data.id);
    if (!renewed.ok) return renewed;
    return { ok: true, ...(await deliverInvite(renewed, context.admin.name)) };
  });

export const cancelInvite = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { id: string }) => ({ id: readText(input, "id") }))
  .handler(async ({ data }): Promise<void> => {
    await cancelInviteRow(env.DB, data.id);
  });

const NOT_YOURSELF = refuse(
  "You can't do this to your own account. Ask another admin.",
);
const PERSON_GONE = refuse(
  "That person no longer has an account. Reload the page to see the latest list.",
);

async function personExists(userId: UserId): Promise<boolean> {
  const rows = await drizzle(env.DB)
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId));
  return rows.length > 0;
}

export const resetSignIn = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { userId: string }) => ({ userId: readUserId(input) }))
  .handler(async ({ data, context }): Promise<Outcome<{ link: string }>> => {
    if (data.userId === context.admin.id) return NOT_YOURSELF;
    if (!(await personExists(data.userId))) return PERSON_GONE;
    const { origins } = await getAuth(getRequest());
    const token = await issueResetLink(env.DB, data.userId);
    return { ok: true, link: `${origins.auth}/reset/${token}` };
  });

export const changeRole = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { userId: string; role: OrgRole }) => ({
    userId: readUserId(input),
    role: readOrgRole(input),
  }))
  .handler(async ({ data, context }): Promise<Outcome> => {
    if (data.userId === context.admin.id) return NOT_YOURSELF;
    if (!(await personExists(data.userId))) return PERSON_GONE;
    const request = getRequest();
    const { auth } = await getAuth(request);
    await auth.api.setRole({
      headers: request.headers,
      body: { userId: data.userId, role: data.role },
    });
    return { ok: true };
  });

export const suspendMember = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { userId: string }) => ({ userId: readUserId(input) }))
  .handler(async ({ data, context }): Promise<Outcome> => {
    if (data.userId === context.admin.id) return NOT_YOURSELF;
    if (!(await personExists(data.userId))) return PERSON_GONE;
    const request = getRequest();
    const { auth } = await getAuth(request);
    await auth.api.banUser({
      headers: request.headers,
      body: { userId: data.userId },
    });
    return { ok: true };
  });

export const unsuspendMember = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { userId: string }) => ({ userId: readUserId(input) }))
  .handler(async ({ data }): Promise<Outcome> => {
    if (!(await personExists(data.userId))) return PERSON_GONE;
    const request = getRequest();
    const { auth } = await getAuth(request);
    await auth.api.unbanUser({
      headers: request.headers,
      body: { userId: data.userId },
    });
    return { ok: true };
  });

const CHOOSE_RECIPIENT = refuse(
  "Choose who receives their files and calendars before you remove them.",
);
const RECIPIENT_CANT = refuse(
  "That person can't take these over right now. Choose someone else.",
);

async function recipientIsReady(userId: UserId): Promise<boolean> {
  const [row] = await drizzle(env.DB)
    .select({ banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, userId));
  return row !== undefined && !isBanned(row);
}

// Handing over comes first and is one transaction. If removing the account then fails,
// choosing Remove again finds the files and calendars already handed over and finishes
// the job.
export const removeMember = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { userId: string; recipientId: string | null }) => ({
    userId: readUserId(input),
    recipientId: input.recipientId === null ? null : readRecipientId(input),
  }))
  .handler(async ({ data, context }): Promise<Outcome> => {
    if (data.userId === context.admin.id) return NOT_YOURSELF;
    const [person] = await drizzle(env.DB)
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, data.userId));
    if (!person) return PERSON_GONE;

    const toHand = (await readToHand(env.DB)).get(data.userId);
    if (toHand && SPACE_KINDS.some((kind) => needsRecipient(toHand[kind]))) {
      if (!data.recipientId) return CHOOSE_RECIPIENT;
    }
    if (data.recipientId === data.userId) return RECIPIENT_CANT;
    if (data.recipientId) {
      if (!(await recipientIsReady(data.recipientId))) return RECIPIENT_CANT;
      await handOver(env.DB, data.userId, person.name, data.recipientId);
    } else {
      await appointNextManagers(env.DB, data.userId);
    }
    const request = getRequest();
    const { auth } = await getAuth(request);
    await auth.api.removeUser({
      headers: request.headers,
      body: { userId: data.userId },
    });
    await forgetResetLinks(env.DB, data.userId);
    return { ok: true };
  });

export const changeMyFilesLimit = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { userId: string; limitBytes: number | null }) => ({
    userId: readUserId(input),
    limitBytes: readLimitBytes(input),
  }))
  .handler(async ({ data }): Promise<Outcome> => {
    if (!(await personExists(data.userId))) return PERSON_GONE;
    await setMyFilesLimit(env.DB, data.userId, data.limitBytes);
    return { ok: true };
  });

// Files from someone removed before an admin could choose who receives them.
export const handOverDrive = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { driveId: string; recipientId: string }) => ({
    driveId: readDriveId(input),
    recipientId: readRecipientId(input),
  }))
  .handler(async ({ data }): Promise<Outcome> => {
    if (!(await recipientIsReady(data.recipientId))) return RECIPIENT_CANT;
    await claimDrive(env.DB, data.driveId as DriveId, data.recipientId);
    return { ok: true };
  });

// Organisation.

export type OrganisationView = {
  require2fa: boolean;
  peopleWithoutSecondWay: number;
  apps: { id: ToggleableApp; enabled: boolean }[];
  runningVersion: string;
  jev: { keySet: boolean; usage: JevUsage };
  storage: StorageOverview;
};

export const getOrganisation = createServerFn({ method: "GET" })
  .middleware([adminOnly])
  .handler(async (): Promise<OrganisationView> => {
    const [
      require2fa,
      peopleWithoutSecondWay,
      settings,
      keySet,
      usage,
      storage,
    ] = await Promise.all([
      readRequire2fa(env.DB),
      countPeopleWithoutSecondWay(env.DB),
      readSettings(env.DB),
      jevKeyIsSet(env.DB),
      readJevUsage(env.DB, Date.now()),
      readStorageOverview(env.DB),
    ]);
    return {
      require2fa,
      peopleWithoutSecondWay,
      apps: TOGGLEABLE_APPS.map((id) => ({
        id,
        enabled: !settings.disabled.has(id),
      })),
      runningVersion: RUNNING_VERSION,
      jev: { keySet, usage },
      storage,
    };
  });

export const changeRequire2fa = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { require2fa: boolean }) => ({
    require2fa: readFlag(input, "require2fa"),
  }))
  .handler(async ({ data }): Promise<void> => {
    await setRequire2fa(env.DB, data.require2fa);
  });

export const changeAppEnabled = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { app: string; enabled: boolean }) => ({
    app: readToggleableApp(input),
    enabled: readFlag(input, "enabled"),
  }))
  .handler(async ({ data }): Promise<void> => {
    await setAppEnabled(env.DB, data.app, data.enabled);
  });

export const changeStorageLimit = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { limitBytes: number | null }) => ({
    limitBytes: readLimitBytes(input),
  }))
  .handler(async ({ data }): Promise<void> => {
    await setStorageLimit(env.DB, data.limitBytes);
  });

// The key goes in and is never sent back. getOrganisation says only that one is set.
export const saveJevKey = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { key: string; acknowledged: true }) => ({
    key: readText(input, "key"),
    acknowledged: readJevAcknowledgement(input),
  }))
  .handler(({ data }): Promise<Outcome<SavedKey>> => {
    const { CLOUDYSUITE_LOCAL_JEV_API: override } = env as {
      CLOUDYSUITE_LOCAL_JEV_API?: string;
    };
    return saveKey(env.DB, data, override, (url, init) => fetch(url, init));
  });

export const removeJevKey = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .handler(async (): Promise<void> => {
    await writeJevKey(env.DB, null);
  });

const readUpdateNotice = createUpdateChecker(RUNNING_VERSION, (url, init) =>
  fetch(url, init),
);

export const getUpdateNotice = createServerFn({ method: "GET" })
  .middleware([adminOnly])
  .handler((): Promise<UpdateNotice> => readUpdateNotice());

// Email domains.

export type DomainsView = {
  appDomain: string | null;
  emailDomains: string[];
};

export const getDomains = createServerFn({ method: "GET" })
  .middleware([adminOnly])
  .handler(async (): Promise<DomainsView> => {
    const rows = await readDomainRows(env.DB);
    return {
      appDomain: rows.find((row) => row.isPrimary)?.name ?? null,
      emailDomains: emailDomainNames(rows),
    };
  });

export const checkEmailDomain = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { name: string }) => ({ name: readText(input, "name") }))
  .handler(async ({ data }): Promise<Outcome<{ checks: DomainChecks }>> => {
    const name = parseDomainName(data.name);
    if (!name)
      return refuse("That isn't a valid domain. It looks like example.com.");
    return { ok: true, checks: await checkDomain(name, resolveOverHttps) };
  });

export const addDomain = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { name: string }) => ({ name: readText(input, "name") }))
  .handler(({ data }): Promise<Outcome> =>
    addEmailDomain(env.DB, data.name, resolveOverHttps),
  );

// Addresses and mailboxes.

export const getMailboxes = createServerFn({ method: "GET" })
  .middleware([adminOnly])
  .handler((): Promise<MailboxesView> => listMailboxes(env.DB));

export const createSharedMailbox = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { name: string; address: string }) => ({
    name: readText(input, "name"),
    address: readText(input, "address"),
  }))
  .handler(({ data }): Promise<Outcome> =>
    createSharedMailboxRow(env.DB, data),
  );

export const createPersonalMailbox = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { userId: string; address: string }) => ({
    userId: readUserId(input),
    address: readText(input, "address"),
  }))
  .handler(({ data }): Promise<Outcome> => addPersonalMailbox(env.DB, data));

export const addAlias = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { mailboxId: MailboxId; address: string }) => ({
    mailboxId: readMailboxId(input),
    address: readText(input, "address"),
  }))
  .handler(({ data }): Promise<Outcome> => addAliasRow(env.DB, data));

export const removeAlias = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { address: string }) => ({
    address: readText(input, "address"),
  }))
  .handler(async ({ data }): Promise<void> => {
    await removeAliasRow(env.DB, data.address);
  });

export const grantMailboxAccess = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator(
    (input: { mailboxId: MailboxId; userId: UserId; role: MailboxRole }) => ({
      mailboxId: readMailboxId(input),
      userId: readUserId(input),
      role: readMailboxRole(input),
    }),
  )
  .handler(({ data }): Promise<Outcome> => grantAccess(env.DB, data));

export const revokeMailboxAccess = createServerFn({ method: "POST" })
  .middleware([adminOnly])
  .validator((input: { mailboxId: MailboxId; userId: UserId }) => ({
    mailboxId: readMailboxId(input),
    userId: readUserId(input),
  }))
  .handler(async ({ data }): Promise<void> => {
    await revokeAccess(env.DB, data);
  });
