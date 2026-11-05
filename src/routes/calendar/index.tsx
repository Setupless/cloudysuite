import { TodayScreen } from "@cloudysuite/calendar";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/calendar/")({
  component: TodayScreen,
});
