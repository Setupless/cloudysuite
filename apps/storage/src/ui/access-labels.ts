import type { AccessLabel } from "../types";

export const ACCESS_LABELS: Record<AccessLabel, string> = {
  owner: "Owner",
  manager: "Manager",
  editor: "Can edit",
  viewer: "Can view",
};
