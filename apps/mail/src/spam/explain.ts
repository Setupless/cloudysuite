import type { MessageDetail } from "../types";
import { REASON_POINTS, type SpamReason } from "./types";

const WORDS: {
  [Kind in SpamReason["kind"]]: (
    reason: Extract<SpamReason, { kind: Kind }>,
  ) => string;
} = {
  blocked: ({ entry }) => `${entry} is on this mailbox's block list.`,
  senderCheckFailed: () =>
    "This message failed the sender checks, and the sender's domain says mail that fails them isn't really theirs.",
  senderCheckUnproved: () =>
    "It couldn't show that it really came from the domain it says it's from.",
  serverNotAllowed: () =>
    "It came from a mail server the sender's domain doesn't allow.",
  serverNotListed: () =>
    "It came from a mail server the sender's domain doesn't fully trust.",
  signatureBroken: () =>
    "Its digital signature didn't match, so it may have been changed on the way.",
  nameShowsOtherAddress: ({ shown }) =>
    `The sender's name shows ${shown}, but it came from a different address.`,
  replyGoesElsewhere: ({ domain }) =>
    `Replies would go to ${domain}, not to the sender.`,
  linkShowsOtherSite: ({ shown, actual }) =>
    `A link shows ${shown} but really goes to ${actual}.`,
  runnableAttachment: ({ filename }) =>
    `It has a file that can run programs on your device: ${filename}.`,
  firstContact: () =>
    "This mailbox hasn't exchanged mail with this sender before.",
  shouting: () => "Its subject is all in capitals.",
  learnedSpam: () =>
    "It looks like messages that were marked as spam in this mailbox.",
  learnedReal: () => "It looks like messages that were marked as not spam.",
  replyToSent: () => "It's a reply to mail sent from this mailbox.",
  allowNotProved: ({ entry }) =>
    `${entry} is on the allow list, but this message couldn't prove it came from them.`,
  markedRealNotProved: ({ address }) =>
    `Mail from ${address} was marked as not spam, but this message couldn't prove it came from them.`,
  movedByRule: () => "A rule in this mailbox moved this here.",
  opinion: ({ why }) => why,
};

const say = <Kind extends SpamReason["kind"]>(
  reason: Extract<SpamReason, { kind: Kind }>,
) => WORDS[reason.kind as Kind](reason);

// One more reason at most, and only one strong enough to say something about this
// message. Being new to this mailbox is true of most senders.
const MIN_POINTS_TO_ADD = 2;

// Strongest reason first, and a line a person will read, not a report. A reason about
// a trusted sender leads when there is one, because it answers the question that
// person has.
export function whyInSpam(
  message: Pick<MessageDetail, "spam" | "spamTraining">,
): string {
  if (message.spamTraining === "spam") {
    return "Someone using this mailbox marked this as spam.";
  }
  // A sign of real mail is never why a message is in Spam.
  const reasons = (message.spam?.reasons ?? []).filter(
    (reason) => REASON_POINTS[reason.kind] >= 0,
  );
  if (reasons.length === 0) return "This message was moved here.";
  const rank = (reason: SpamReason) =>
    reason.kind === "allowNotProved" || reason.kind === "markedRealNotProved"
      ? Infinity
      : REASON_POINTS[reason.kind];
  const [first, second] = reasons.toSorted((a, b) => rank(b) - rank(a));
  return [
    first!,
    ...(second && rank(second) >= MIN_POINTS_TO_ADD ? [second] : []),
  ]
    .map(say)
    .join(" ");
}
