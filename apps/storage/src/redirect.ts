import { redirect } from "@tanstack/react-router";
import { getDirectory } from "./functions";

// A person's My files is made on first use, not on first look. A page view changes
// nothing, so until something is added this address shows it empty.
export async function redirectToMyDrive(): Promise<void> {
  const { myDriveId } = await getDirectory();
  if (myDriveId) {
    throw redirect({
      to: "/storage/drive/$driveId",
      params: { driveId: myDriveId },
    });
  }
}
