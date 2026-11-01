import { Page } from "@cloudysuite/ui";
import { IconPower } from "@tabler/icons-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";

export const Route = createFileRoute("/off")({ component: Off });

function Off() {
  const { hostname } = new URL(useRouter().origin);
  const label = hostname.split(".")[0] ?? "";
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  return (
    <Page icon={IconPower} title={`${name} is turned off`}>
      {`An admin turned ${name} off for your organisation. Nothing has been deleted. Ask your admin to turn it back on if you need it.`}
    </Page>
  );
}
