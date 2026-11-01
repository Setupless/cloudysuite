// R2 ends an error's message with its code, and 10024 means the multipart upload no
// longer exists. An upload that was finished, aborted, or expired by R2 all look alike.
export const isUploadGone = (error: unknown) =>
  String(error).includes("(10024)");
