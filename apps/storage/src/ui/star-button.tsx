import type { DriveId } from "@cloudysuite/access";
import { useToast } from "@cloudysuite/ui";
import { IconStar, IconStarFilled } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { call, starIdsQuery, storageKeys } from "../queries";
import { setStarred } from "../search-functions";
import type { ItemId } from "../types";

export function StarButton({
  driveId,
  item,
}: {
  driveId: DriveId;
  item: { id: ItemId; name: string };
}) {
  const client = useQueryClient();
  const toast = useToast();
  const { data: starIds } = useQuery(starIdsQuery(driveId));
  const starred = starIds?.includes(item.id) ?? false;
  const key = storageKeys.starIds(driveId);

  const toggle = async () => {
    const on = !starred;
    await client.cancelQueries({ queryKey: key });
    client.setQueryData<ItemId[]>(key, (ids = []) =>
      on ? [...ids, item.id] : ids.filter((id) => id !== item.id),
    );
    try {
      await call(() => setStarred({ data: { driveId, itemId: item.id, on } }));
    } catch (error) {
      toast({
        message: `We couldn't change the star on ${item.name}. ${(error as Error).message}`,
      });
    }
    await Promise.all([
      client.invalidateQueries({ queryKey: key }),
      client.invalidateQueries({ queryKey: storageKeys.starred }),
    ]);
  };

  const Icon = starred ? IconStarFilled : IconStar;
  return (
    <button
      type="button"
      aria-pressed={starred}
      aria-label={`Star ${item.name}`}
      title={starred ? "Remove star" : "Add star"}
      onClick={() => void toggle()}
      className={`flex size-7 flex-none cursor-pointer items-center justify-center rounded outline-accent hover:bg-selected focus-visible:outline-2 ${starred ? "text-accent" : "text-secondary"}`}
    >
      <Icon size={16} stroke={1.75} aria-hidden />
    </button>
  );
}
