import { ScheduleScreen } from "@cloudysuite/calendar";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/calendar/schedule")({
  component: ScheduleScreen,
});
