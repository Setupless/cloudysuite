import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  type SearchAnswer,
  searchDrives,
  starredAcrossDrives,
  type StarredRow,
} from "./across-drives";
import { noAccess, openDriveAs, requireStorageUser } from "./access";
import { type People, peopleOf } from "./people-lookup";
import { type ItemId, NO_SUCH_ITEM } from "./types";
import {
  parseDriveInput,
  parseSearchInput,
  parseStarInput,
  refusal,
} from "./wire";

export const searchEverything = createServerFn({ method: "GET" })
  .validator(parseSearchInput)
  .handler(async ({ data }): Promise<SearchAnswer & { people: People }> => {
    const me = await requireStorageUser(getRequest());
    const answer = await searchDrives(
      env.DB,
      me.id,
      (driveId) => openDriveAs(me.id, driveId),
      data.text,
    );
    return {
      ...answer,
      people: await peopleOf(
        env.DB,
        answer.rows.map((row) => row.item.createdBy),
      ),
    };
  });

export const getStarred = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    rows: StarredRow[];
    incomplete: boolean;
    people: People;
  }> => {
    const me = await requireStorageUser(getRequest());
    const answer = await starredAcrossDrives(env.DB, me.id, (driveId) =>
      openDriveAs(me.id, driveId),
    );
    return {
      ...answer,
      people: await peopleOf(
        env.DB,
        answer.rows.map((row) => row.item.createdBy),
      ),
    };
  },
);

export const getStarIds = createServerFn({ method: "GET" })
  .validator(parseDriveInput)
  .handler(async ({ data }): Promise<ItemId[]> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    return drive.starIds();
  });

export const setStarred = createServerFn({ method: "POST" })
  .validator(parseStarInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const result = await drive.setStar(data.itemId, data.on);
    switch (result.status) {
      case "done":
        return;
      case "noAccess":
        throw noAccess();
      case "gone":
        throw refusal(404, NO_SUCH_ITEM);
    }
  });
