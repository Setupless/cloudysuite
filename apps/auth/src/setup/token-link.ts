export type TokenPermission = {
  label: string;
  level: "Read" | "Edit";
  // A short key from Cloudflare's token template docs, or a permission group id
  // for the groups those docs don't name. The same link can mix the two.
  key: string;
  type: "read" | "edit";
  // The link can't set this. The person chooses it in Cloudflare's form.
  scope: "account" | "zone";
};

export const TOKEN_PERMISSIONS: readonly TokenPermission[] = [
  {
    label: "Workers Scripts",
    level: "Edit",
    key: "workers_scripts",
    type: "edit",
    scope: "account",
  },
  {
    label: "Email Sending",
    level: "Edit",
    key: "5df633d6b41c42bcaf5b4a62b9d14b64",
    type: "edit",
    scope: "account",
  },
  { label: "Zone", level: "Read", key: "zone", type: "read", scope: "zone" },
  { label: "DNS", level: "Edit", key: "dns", type: "edit", scope: "zone" },
  {
    label: "Zone Settings",
    level: "Edit",
    key: "zone_settings",
    type: "edit",
    scope: "zone",
  },
  {
    label: "Email Routing Rules",
    level: "Edit",
    key: "79b3ec0d10ce4148a8f8bdc0cc5f97f2",
    type: "edit",
    scope: "zone",
  },
];

export function tokenFormUrl(): string {
  const filled = TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type }));
  const keys = encodeURIComponent(JSON.stringify(filled));
  const name = encodeURIComponent("CloudySuite setup");
  return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${keys}&name=${name}`;
}
