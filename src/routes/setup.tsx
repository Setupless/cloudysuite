import { Page } from "@cloudysuite/ui";
import { IconSettings } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/setup")({ component: Setup });

function Setup() {
  return (
    <Page icon={IconSettings} title="Setup isn't finished">
      CloudySuite isn't ready to use yet. Ask the person who installed it for
      your organisation to finish setting it up.
    </Page>
  );
}
