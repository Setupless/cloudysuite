import { Fragment, type ReactNode } from "react";
import type { Address } from "../types";

// Each part sits in its own <bdi>, so right-to-left letters in a name, or a direction
// control in mail stored before parsing removed them, cannot reorder the text beside it.
export const isolatedList = (parts: ReactNode[]): ReactNode =>
  parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && ", "}
      <bdi>{part}</bdi>
    </Fragment>
  ));

export function FullAddress({ person }: { person: Address }) {
  const name = person.name.trim();
  if (!name) return <bdi>{person.address}</bdi>;
  return (
    <>
      <bdi>{name}</bdi> &lt;<bdi>{person.address}</bdi>&gt;
    </>
  );
}
