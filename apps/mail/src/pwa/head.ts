import { APPLE_ICON } from "./manifest";

export const mailHead = () => ({
  meta: [
    { title: "Mail" },
    { name: "apple-mobile-web-app-title", content: "Mail" },
    { name: "mobile-web-app-capable", content: "yes" },
    { name: "apple-mobile-web-app-capable", content: "yes" },
  ],
  links: [
    { rel: "manifest", href: "/manifest.webmanifest" },
    { rel: "apple-touch-icon", href: APPLE_ICON },
  ],
});
