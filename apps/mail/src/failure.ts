export class MailFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly appOff = false,
  ) {
    super(message);
  }
}

// Offline, and this device has no saved copy. Trying again at once cannot help.
export class NotSavedOnDevice extends MailFailure {
  constructor(message: string) {
    super(0, message);
  }
}
