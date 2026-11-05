import { env } from "cloudflare:workers";
import {
  type AccessLevel,
  type DriveId,
  isBanned,
  readOthers,
  type UserId,
} from "@cloudysuite/access";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { driveShares, user } from "../../../src/db/schema";
import { readSettings } from "../../../src/settings";
import { noAccess, openDriveAs, requireStorageUser } from "./access";
import type { DriveClient } from "./client";
import { type People, peopleOf } from "./people-lookup";
import { parseItemName } from "./names";
import {
  addToTeam,
  deleteTeam,
  readDriveKind,
  readTeam,
  removeFromTeam,
  renameTeam,
  setTeamRole,
  type TeamChange,
} from "./team";
import {
  type AccessLabel,
  ITEM_BUSY,
  type ItemShare,
  NO_SUCH_ITEM,
  type Person,
  type ShareResult,
  type SharedLine,
} from "./types";
import {
  type Audience,
  parseAccessInput,
  parseAddMembersInput,
  parseDriveInput,
  parseEveryoneInput,
  parseMemberInput,
  parseMemberRoleInput,
  parseRenameDriveInput,
  parseShareInput,
  parseUnshareInput,
  refusal,
} from "./wire";

const SHARED_SHOWN = 200;
const ONLY_MANAGERS = "Only a manager of this team folder can do that.";
const LAST_MANAGER =
  "A team folder always needs a manager. Make someone else a manager first.";
const NOT_ON_IT = "That person isn't on this team folder any more.";
const NOT_A_PERSON = "We can't find that person. They may have been removed.";

const ACCESS_RANK: Record<AccessLabel | AccessLevel, number> = {
  owner: 0,
  manager: 0,
  edit: 1,
  editor: 1,
  view: 2,
  viewer: 2,
};

export type AccessLine = {
  person: Person;
  access: AccessLabel;
  // Set when a share on this item is what can be changed from here.
  share: AccessLevel | null;
};

export type WhoCanOpen = {
  lines: AccessLine[];
  // Where a share with everyone applies from, if any does.
  everyone: "here" | "above" | null;
  organisation: string;
  canEdit: boolean;
  isTeam: boolean;
  // Being on the drive's list: the only thing that makes someone a manager of it.
  myRole: AccessLabel | null;
};

const asRole = (level: AccessLevel): AccessLabel =>
  level === "edit" ? "editor" : "viewer";

// The drive's list and the item's shares, merged per person so each shows once at the
// strongest they have. A share with someone removed has no person to show.
export const getAccess = createServerFn({ method: "GET" })
  .validator(parseAccessInput)
  .handler(async ({ data }): Promise<WhoCanOpen> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const shares = data.itemId ? await drive.sharesOn(data.itemId) : null;
    if (data.itemId ? !shares : drive.role === null) throw noAccess();

    const here = shares?.here ?? [];
    const above = shares?.above ?? [];
    const personShares = (list: readonly ItemShare[]) =>
      list.flatMap((share) => (share.kind === "person" ? [share] : []));
    const [kind, team, people, { primaryDomain }] = await Promise.all([
      readDriveKind(env.DB, data.driveId),
      readTeam(env.DB, data.driveId),
      peopleOf(
        env.DB,
        personShares([...here, ...above]).map((share) => share.userId),
      ),
      readSettings(env.DB),
    ]);
    const isTeam = kind?.kind === "team";

    const lines = new Map<string, AccessLine>();
    const offer = (line: AccessLine) => {
      const known = lines.get(line.person.id);
      lines.set(
        line.person.id,
        !known || ACCESS_RANK[line.access] < ACCESS_RANK[known.access]
          ? { ...line, share: line.share ?? known?.share ?? null }
          : { ...known, share: known.share ?? line.share },
      );
    };
    for (const { person, role } of team) {
      offer({
        person,
        access: !isTeam && role === "manager" ? "owner" : role,
        share: null,
      });
    }
    for (const share of personShares(above)) {
      const person = people[share.userId];
      if (person) {
        offer({ person, access: asRole(share.level), share: null });
      }
    }
    for (const share of personShares(here)) {
      const person = people[share.userId];
      if (person) {
        offer({ person, access: asRole(share.level), share: share.level });
      }
    }

    const hasEveryone = (list: readonly ItemShare[]) =>
      list.some((share) => share.kind === "organisation");
    return {
      lines: [...lines.values()].sort(
        (a, b) =>
          ACCESS_RANK[a.access] - ACCESS_RANK[b.access] ||
          a.person.name.localeCompare(b.person.name),
      ),
      everyone: hasEveryone(here)
        ? "here"
        : hasEveryone(above)
          ? "above"
          : null,
      organisation: primaryDomain ?? "your organisation",
      canEdit: shares
        ? shares.canEdit
        : drive.role === "manager" || drive.role === "editor",
      isTeam,
      myRole:
        drive.role === null
          ? null
          : !isTeam && drive.role === "manager"
            ? "owner"
            : drive.role,
    };
  });

export type TeamChoice = {
  id: DriveId;
  name: string;
  colour: number;
  people: number;
};

export type ShareChoices = { people: Person[]; teams: TeamChoice[] };

// A team folder's name is only offered to someone on it.
export const getShareChoices = createServerFn({ method: "GET" }).handler(
  async (): Promise<ShareChoices> => {
    const me = await requireStorageUser(getRequest());
    const [people, teams] = await Promise.all([
      readOthers(env.DB, me.id),
      teamsOf(me.id),
    ]);
    return { people, teams };
  },
);

async function teamsOf(me: UserId): Promise<TeamChoice[]> {
  const db = drizzle(env.DB);
  return db.all<TeamChoice>(
    sql`SELECT drives.id AS id, drives.name AS name, drives.colour AS colour,
          (SELECT count(*) FROM drive_access AS others WHERE others.drive_id = drives.id) AS people
        FROM drive_access JOIN drives ON drives.id = drive_access.drive_id
        WHERE drive_access.user_id = ${me} AND drives.kind = 'team'
        ORDER BY drives.name`,
  );
}

// A team is added as the people on it now, once. Asking through the access check means
// someone can only add a team they're on, and an unknown or suspended person isn't added.
async function peopleIn(audience: Audience, me: UserId): Promise<UserId[]> {
  if (audience.kind === "team") {
    const team = await openDriveAs(me, audience.driveId);
    if (team.role === null) throw noAccess();
    return (await readTeam(env.DB, audience.driveId))
      .map(({ person }) => person.id)
      .filter((id) => id !== me);
  }
  const [row] = await drizzle(env.DB)
    .select({ id: user.id, banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, audience.userId));
  if (!row || isBanned(row)) throw refusal(404, NOT_A_PERSON);
  return [row.id];
}

function answerShare(result: ShareResult): void {
  switch (result.status) {
    case "done":
      return;
    case "noAccess":
      throw noAccess();
    case "gone":
      throw refusal(404, NO_SUCH_ITEM);
    case "busy":
      throw refusal(409, ITEM_BUSY);
  }
}

export const shareItem = createServerFn({ method: "POST" })
  .validator(parseShareInput)
  .handler(async ({ data }): Promise<{ added: number }> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const people = await peopleIn(data.audience, me.id);
    answerShare(await drive.sharePeople(data.itemId, people, data.level));
    return { added: people.length };
  });

export const unshareItem = createServerFn({ method: "POST" })
  .validator(parseUnshareInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    answerShare(await drive.unshare(data.itemId, data.userId));
  });

export const setEveryone = createServerFn({ method: "POST" })
  .validator(parseEveryoneInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    answerShare(await drive.setEveryone(data.itemId, data.on));
  });

export type SharedRow = SharedLine & { driveId: DriveId };

// The index says which drives to ask, and each drive says what is true, so a row that
// outlived its share shows nothing.
export const getSharedWithMe = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ rows: SharedRow[]; people: People }> => {
    const me = await requireStorageUser(getRequest());
    const indexed = await drizzle(env.DB)
      .selectDistinct({ driveId: driveShares.driveId })
      .from(driveShares)
      .where(eq(driveShares.userId, me.id));
    const lists = await Promise.all(
      indexed.map(async ({ driveId }) => {
        const drive = await openDriveAs(me.id, driveId);
        const lines = await drive.sharedWith(SHARED_SHOWN);
        return lines.map((line): SharedRow => ({ ...line, driveId }));
      }),
    );
    const rows = lists
      .flat()
      .sort((a, b) => b.sharedAt - a.sharedAt)
      .slice(0, SHARED_SHOWN);
    return {
      rows,
      people: await peopleOf(
        env.DB,
        rows.flatMap((row) => [row.sharedBy, row.item.createdBy]),
      ),
    };
  },
);

// Team folders.

async function openAsManager(
  me: UserId,
  driveId: DriveId,
): Promise<DriveClient> {
  const drive = await openDriveAs(me, driveId);
  if (drive.role === null) throw noAccess();
  if (drive.role !== "manager") throw refusal(403, ONLY_MANAGERS);
  const kind = await readDriveKind(env.DB, driveId);
  if (kind?.kind !== "team") throw refusal(403, ONLY_MANAGERS);
  return drive;
}

function answerTeamChange(change: TeamChange): void {
  switch (change) {
    case "done":
      return;
    case "lastManager":
      throw refusal(409, LAST_MANAGER);
    case "notOnIt":
      throw refusal(404, NOT_ON_IT);
  }
}

export const addMembers = createServerFn({ method: "POST" })
  .validator(parseAddMembersInput)
  .handler(async ({ data }): Promise<{ added: number }> => {
    const me = await requireStorageUser(getRequest());
    await openAsManager(me.id, data.driveId);
    const people = await peopleIn(data.audience, me.id);
    await addToTeam(env.DB, data.driveId, people, data.role);
    return { added: people.length };
  });

export const changeMemberRole = createServerFn({ method: "POST" })
  .validator(parseMemberRoleInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    await openAsManager(me.id, data.driveId);
    answerTeamChange(
      await setTeamRole(env.DB, data.driveId, data.userId, data.role),
    );
  });

export const removeTeamMember = createServerFn({ method: "POST" })
  .validator(parseMemberInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    await openAsManager(me.id, data.driveId);
    answerTeamChange(await removeFromTeam(env.DB, data.driveId, data.userId));
  });

export const leaveTeamFolder = createServerFn({ method: "POST" })
  .validator(parseDriveInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const kind = await readDriveKind(env.DB, data.driveId);
    if (kind?.kind !== "team") throw noAccess();
    const change = await removeFromTeam(env.DB, data.driveId, me.id);
    if (change === "notOnIt") throw noAccess();
    answerTeamChange(change);
  });

export const renameTeamFolder = createServerFn({ method: "POST" })
  .validator(parseRenameDriveInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    await openAsManager(me.id, data.driveId);
    const parsed = parseItemName(data.name);
    if (!parsed.ok) throw refusal(400, parsed.message);
    await renameTeam(env.DB, data.driveId, parsed.name);
  });

// Closed first, so nothing lands after it's found empty. If D1 then fails, the folder
// opens again. If the Worker dies there, choosing Delete again finishes it, and the D1 row
// is what makes it exist, so nothing is left half gone.
export const deleteTeamFolder = createServerFn({ method: "POST" })
  .validator(parseDriveInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openAsManager(me.id, data.driveId);
    const kind = await readDriveKind(env.DB, data.driveId);
    const closed = await drive.close();
    if (closed.status === "notEmpty") {
      throw refusal(
        409,
        `"${kind?.name ?? "This team folder"}" still has something in it, or in its Trash. Delete everything in it and empty Trash, then try again.`,
      );
    }
    try {
      await deleteTeam(env.DB, data.driveId);
    } catch (error) {
      await drive.reopen();
      throw error;
    }
  });
