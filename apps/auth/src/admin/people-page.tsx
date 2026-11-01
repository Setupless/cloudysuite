import {
  Avatar,
  Badge,
  Button,
  CopyField,
  Modal,
  Notice,
  Section,
  SelectField,
  TextField,
} from "@cloudysuite/ui";
import { IconSend, IconUserPlus } from "@tabler/icons-react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { OrgRole, UserId } from "../../../../src/db/schema";
import { useAction } from "../account/use-action";
import type { Outcome } from "../outcome";
import {
  cancelInvite,
  changeRole,
  inviteMember,
  type InviteDelivery,
  removeMember,
  resendInvite,
  resetSignIn,
  suspendMember,
  unsuspendMember,
} from "./functions";
import { AddressField } from "./address-field";
import { AdminPage } from "./admin-page";
import type { InviteRow, PersonRow } from "./people";

type PeopleView = {
  youId: UserId;
  people: PersonRow[];
  invites: InviteRow[];
  emailDomains: string[];
};

function DeliveryNotice({
  email,
  delivery,
}: {
  email: string;
  delivery: InviteDelivery;
}) {
  if (delivery.sent) {
    return <Notice tone="success">We sent an invite to {email}.</Notice>;
  }
  return (
    <div className="flex flex-col gap-2">
      <Notice tone="danger">
        We couldn't send the email to {email}. Pass them this link yourself. It
        works once and expires in 7 days.
      </Notice>
      <CopyField label="Invite link" value={delivery.link} />
    </div>
  );
}

function InviteForm({ emailDomains }: { emailDomains: string[] }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [result, setResult] = useState<{
    email: string;
    delivery: InviteDelivery;
  } | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const email = String(values.get("email")).trim();
    const local = String(values.get("local") ?? "").trim();
    const domain = String(values.get("domain") ?? "");
    setResult(null);
    return run(async () => {
      const outcome = await inviteMember({
        data: {
          email,
          role: String(values.get("role")) as OrgRole,
          mailboxAddress: local ? `${local}@${domain}` : "",
        },
      });
      if (!outcome.ok) return outcome.message;
      form.reset();
      setResult({ email, delivery: outcome });
      await router.invalidate();
    });
  }

  return (
    <Section
      title="Invite someone"
      description="They'll get a link that works once, and choose their own name and password."
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <TextField
          label="Where to send the invite"
          name="email"
          type="email"
          hint="An address they can read today, such as their personal email."
          required
        />
        {emailDomains.length > 0 && (
          <AddressField
            label="Their new email address (optional)"
            domains={emailDomains}
            hint="This creates a personal mailbox, and becomes the address they sign in with. Leave it blank if they don't need one."
          />
        )}
        <SelectField label="What they can do" name="role" defaultValue="user">
          <option value="user">Member: uses the apps</option>
          <option value="admin">Admin: also manages this organisation</option>
        </SelectField>
        <div>
          <Button
            type="submit"
            variant="action"
            icon={IconUserPlus}
            disabled={pending}
          >
            Send invite
          </Button>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        {result && <DeliveryNotice {...result} />}
      </form>
    </Section>
  );
}

function InviteItem({ invite }: { invite: InviteRow }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [delivery, setDelivery] = useState<InviteDelivery | null>(null);

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{invite.email}</p>
          <p className="truncate text-sm text-secondary">
            {invite.mailboxAddress
              ? `Will sign in as ${invite.mailboxAddress}`
              : "No new mailbox"}
          </p>
        </div>
        {invite.expired && <Badge tone="danger">Expired</Badge>}
        <Button
          variant="quiet"
          icon={IconSend}
          disabled={pending}
          onClick={() =>
            run(async () => {
              const outcome = await resendInvite({ data: { id: invite.id } });
              if (!outcome.ok) return outcome.message;
              setDelivery(outcome);
              await router.invalidate();
            })
          }
        >
          Send again
        </Button>
        <Button
          variant="danger"
          disabled={pending}
          onClick={() =>
            run(async () => {
              await cancelInvite({ data: { id: invite.id } });
              await router.invalidate();
            })
          }
        >
          Cancel invite
        </Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {delivery && <DeliveryNotice email={invite.email} delivery={delivery} />}
    </li>
  );
}

type ActionKey =
  "reset" | "promote" | "demote" | "suspend" | "resume" | "remove";

const ACTIONS: Record<
  ActionKey,
  {
    label: string;
    title: (name: string) => string;
    body: (name: string) => string;
    confirm: string;
    danger: boolean;
    run: (userId: UserId) => Promise<Outcome<{ link?: string }>>;
  }
> = {
  reset: {
    label: "Reset sign-in",
    title: (name) => `Reset sign-in for ${name}?`,
    body: (name) =>
      `This removes ${name}'s passkeys, authenticator app, and password, and signs them out everywhere. You'll get a one-time link to pass to them, and they'll choose a new password with it. Their mail isn't affected.`,
    confirm: "Reset sign-in",
    danger: true,
    run: (userId) => resetSignIn({ data: { userId } }),
  },
  promote: {
    label: "Make admin",
    title: (name) => `Make ${name} an admin?`,
    body: (name) =>
      `${name} will be able to manage people, addresses, domains, and these settings.`,
    confirm: "Make admin",
    danger: false,
    run: (userId) => changeRole({ data: { userId, role: "admin" } }),
  },
  demote: {
    label: "Make member",
    title: (name) => `Make ${name} a member?`,
    body: (name) => `${name} will no longer be able to open these admin pages.`,
    confirm: "Make member",
    danger: false,
    run: (userId) => changeRole({ data: { userId, role: "user" } }),
  },
  suspend: {
    label: "Suspend",
    title: (name) => `Suspend ${name}?`,
    body: (name) =>
      `${name} will be signed out and can't sign in until you bring them back. Nothing is deleted, and their mailbox keeps receiving mail.`,
    confirm: "Suspend",
    danger: true,
    run: (userId) => suspendMember({ data: { userId } }),
  },
  resume: {
    label: "Bring back",
    title: (name) => `Bring back ${name}?`,
    body: (name) => `${name} will be able to sign in again.`,
    confirm: "Bring back",
    danger: false,
    run: (userId) => unsuspendMember({ data: { userId } }),
  },
  remove: {
    label: "Remove",
    title: (name) => `Remove ${name}?`,
    body: (name) =>
      `${name}'s account goes away, and they lose access to every mailbox. No mail is deleted: their mailbox stays, and you can give someone else access under Email addresses.`,
    confirm: "Remove",
    danger: true,
    run: (userId) => removeMember({ data: { userId } }),
  },
};

function PersonActions({ person }: { person: PersonRow }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [confirming, setConfirming] = useState<ActionKey | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const keys: ActionKey[] = [
    "reset",
    person.role === "admin" ? "demote" : "promote",
    person.suspended ? "resume" : "suspend",
    "remove",
  ];
  const action = confirming && ACTIONS[confirming];

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {keys.map((key) => (
          <Button
            key={key}
            variant={ACTIONS[key].danger ? "danger" : "quiet"}
            onClick={() => setConfirming(key)}
          >
            {ACTIONS[key].label}
          </Button>
        ))}
      </div>
      {action && (
        <Modal
          title={action.title(person.name)}
          onClose={() => setConfirming(null)}
        >
          <p className="text-sm text-secondary">{action.body(person.name)}</p>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button variant="quiet" onClick={() => setConfirming(null)}>
              Go back
            </Button>
            <Button
              variant={action.danger ? "danger" : "action"}
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const outcome = await action.run(person.id);
                  if (!outcome.ok) return outcome.message;
                  if (outcome.link) setLink(outcome.link);
                  setConfirming(null);
                  await router.invalidate();
                })
              }
            >
              {action.confirm}
            </Button>
          </div>
        </Modal>
      )}
      {link && (
        <Modal
          title={`Pass this link to ${person.name}`}
          onClose={() => setLink(null)}
        >
          <p className="text-sm text-secondary">
            {person.name} is signed out, and their old sign-in has been removed.
            They open this link to choose a new password. It works once and
            expires in 3 days. We won't show it again, so copy it now.
          </p>
          <CopyField label="One-time link" value={link} />
          <div className="flex justify-end">
            <Button variant="action" onClick={() => setLink(null)}>
              Done
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function PersonItem({ person, isYou }: { person: PersonRow; isYou: boolean }) {
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar person={person} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {person.name}
            {isYou && <span className="text-secondary"> (you)</span>}
          </p>
          <p className="truncate text-sm text-secondary">{person.email}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {person.role === "admin" && <Badge>Admin</Badge>}
          {person.suspended && <Badge tone="danger">Suspended</Badge>}
          {!person.hasSecondWay && <Badge>Password only</Badge>}
        </div>
      </div>
      {!isYou && <PersonActions person={person} />}
    </li>
  );
}

export function PeoplePage({ view }: { view: PeopleView }) {
  return (
    <AdminPage
      title="People"
      description="Everyone in your organisation, and who has been invited."
    >
      <InviteForm emailDomains={view.emailDomains} />
      {view.invites.length > 0 && (
        <Section title="Waiting to join">
          <ul className="flex flex-col divide-y divide-line">
            {view.invites.map((invite) => (
              <InviteItem key={invite.id} invite={invite} />
            ))}
          </ul>
        </Section>
      )}
      <Section title="Members">
        <ul className="flex flex-col divide-y divide-line">
          {view.people.map((person) => (
            <PersonItem
              key={person.id}
              person={person}
              isYou={person.id === view.youId}
            />
          ))}
        </ul>
      </Section>
    </AdminPage>
  );
}
