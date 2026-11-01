// A manifest cannot use a CSS variable, so its colours are read from the theme file
// when the build writes it, and the theme file stays the only place a colour lives.
export function themeColour(themeCss: string, role: string): string {
  const match = new RegExp(`--color-${role}:\\s*([^;]+);`).exec(themeCss);
  const value = match?.[1]?.trim();
  const light = value?.match(/^light-dark\(\s*([^,\s]+)\s*,/)?.[1] ?? value;
  if (!light) throw new Error(`The theme has no --color-${role} role.`);
  return light;
}

export const APP_ICONS = [
  { path: "/icons/icon-192.png", sizes: "192x192", purpose: "any" },
  { path: "/icons/icon-512.png", sizes: "512x512", purpose: "any" },
  { path: "/icons/maskable-512.png", sizes: "512x512", purpose: "maskable" },
] as const;

export const APPLE_ICON = "/icons/apple-touch-icon.png";

export function appManifest(themeCss: string) {
  const page = themeColour(themeCss, "page");
  return {
    id: "/",
    name: "CloudySuite Mail",
    short_name: "Mail",
    description: "Your organisation's mail.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: page,
    background_color: page,
    icons: APP_ICONS.map(({ path, sizes, purpose }) => ({
      src: path,
      sizes,
      type: "image/png",
      purpose,
    })),
  };
}
