export type TokenPermission = {
  label: string;
  level: "Read" | "Edit";
  // Null means Cloudflare publishes no short key and no id is confirmed yet, so
  // the form cannot fill it in and the wizard asks the person to add it by hand.
  key: string | null;
  type: "read" | "edit";
};

// Short keys are from Cloudflare's token template docs. The docs do not list
// the two email groups, which need a permission group id instead.
export const TOKEN_PERMISSIONS: readonly TokenPermission[] = [
  {
    label: "Workers Scripts",
    level: "Edit",
    key: "workers_scripts",
    type: "edit",
  },
  { label: "Zone", level: "Read", key: "zone", type: "read" },
  { label: "DNS", level: "Edit", key: "dns", type: "edit" },
  { label: "Zone Settings", level: "Edit", key: "zone_settings", type: "edit" },
  { label: "Email Routing Rules", level: "Edit", key: null, type: "edit" },
  { label: "Email Sending", level: "Edit", key: null, type: "edit" },
];

export function tokenFormUrl(): string {
  const filled = TOKEN_PERMISSIONS.flatMap(({ key, type }) =>
    key ? [{ key, type }] : [],
  );
  const keys = encodeURIComponent(JSON.stringify(filled));
  const name = encodeURIComponent("CloudySuite setup");
  return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${keys}&name=${name}`;
}
