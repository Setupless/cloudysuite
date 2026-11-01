const MAX_NAME_LENGTH = 200;

// What a removed person's name becomes on the folder that holds their My files. Kept apart
// from the database code because the dialog says it before it happens.
export const handedOverName = (personName: string) =>
  `${personName.trim().slice(0, MAX_NAME_LENGTH) || "Someone"}'s files`;
