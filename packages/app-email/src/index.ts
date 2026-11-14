export { chunked } from "./chunked";
export {
  CRLF,
  domainOf,
  type EmailPerson,
  escapeHtml,
  headerText,
  mailbox,
  multipart,
  oneLine,
  part,
} from "./mime";
export { readSendingFacts, type SendingFacts } from "./senders";

// The binding takes one raw message to one address. That's one email per person, which
// also keeps inside the service's limit of 50 recipients a message.
export type EmailPort = {
  send(message: { from: string; to: string; raw: string }): Promise<unknown>;
};
