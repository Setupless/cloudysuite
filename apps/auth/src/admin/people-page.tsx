import { formatBytes } from "@cloudysuite/transfer";
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
  changeMyFilesLimit,
  changeRole,
  handOverDrive,
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
import type { DriveToClaim } from "./handover";
import {
  handedOverName,
  needsRecipient,
  SPACE_KINDS,
  type SpaceKind,
} from "./handover-text";
import type { InviteRow, PersonRow } from "./people";
import { type LimitKey, StorageLimitForm } from "./storage-limit-form";

type PeopleView = {
  youId: UserId;
  people: PersonRow[];
  invites: InviteRow[];
  emailDomains: string[];
  drivesToClaim: DriveToClaim[];
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
    return run("invite", async () => {
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
            pending={pending !== null}
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
  const { pending, error, run } = useAction<"resend" | "cancel">();
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
          pending={pending === "resend"}
          disabled={pending !== null}
          onClick={() =>
            run("resend", async () => {
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
          pending={pending === "cancel"}
          disabled={pending !== null}
          onClick={() =>
            run("cancel", async () => {
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

type ActionKey = "reset" | "promote" | "demote" | "suspend" | "resume";

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
};

const countOf = (count: number, thing: string) =>
  count === 1 ? `a ${thing}` : `${count} ${thing}s`;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// How the removal dialog speaks of each kind, in the order it lists them.
const SPACE_WORDS: Record<
  SpaceKind,
  {
    plural: string;
    team: string;
    arrives: (name: string, recipient: string) => string;
  }
> = {
  files: {
    plural: "files",
    team: "team folder",
    arrives: (name, recipient) =>
      `Their My files arrives for ${recipient} as a new team folder called "${handedOverName("files", name)}", and ${recipient} manages it.`,
  },
  calendars: {
    plural: "calendars",
    team: "team calendar",
    arrives: (name, recipient) =>
      `Their calendar arrives for ${recipient} as a new team calendar called "${handedOverName("calendars", name)}", with all its events, and ${recipient} manages it.`,
  },
  boards: {
    plural: "tasks",
    team: "team board",
    arrives: (name, recipient) =>
      `Their private tasks arrive for ${recipient} on a new team board called "${handedOverName("boards", name)}", and ${recipient} manages it.`,
  },
};

const listed = (items: string[]) =>
  items.length <= 2
    ? items.join(" and ")
    : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;

function handOverText({ name, toHand }: PersonRow, recipient: string): string {
  return SPACE_KINDS.flatMap((kind) => {
    const { personal, aloneIn } = toHand[kind];
    const { team, arrives } = SPACE_WORDS[kind];
    return [
      personal && arrives(name, recipient),
      aloneIn > 0 &&
        `${sentence(countOf(aloneIn, team))} only ${name} was on ${aloneIn === 1 ? "goes" : "go"} to ${recipient} as well.`,
    ];
  })
    .filter(Boolean)
    .join(" ");
}

function managedAloneText({ name, toHand }: PersonRow): string | null {
  const managed = SPACE_KINDS.filter((kind) => toHand[kind].managedAlone > 0);
  if (managed.length === 0) return null;
  const total = managed.reduce(
    (sum, kind) => sum + toHand[kind].managedAlone,
    0,
  );
  const what = listed(
    managed.map((kind) =>
      countOf(toHand[kind].managedAlone, SPACE_WORDS[kind].team),
    ),
  );
  return `${sentence(what)} ${name} managed alone ${total === 1 ? "stays with the people on it" : "stay with the people on them"}, and one of them becomes the manager.`;
}

function RecipientField({
  label = "Who receives their files",
  value,
  people,
  disabled,
  onChange,
}: {
  label?: string;
  value: string;
  people: readonly PersonRow[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <SelectField
      label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Choose someone</option>
      {people.map((other) => (
        <option key={other.id} value={other.id}>
          {other.name}
        </option>
      ))}
    </SelectField>
  );
}

function RemoveDialog({
  person,
  others,
  onClose,
}: {
  person: PersonRow;
  others: readonly PersonRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [recipientId, setRecipientId] = useState("");
  const kindsToHand = SPACE_KINDS.filter((kind) =>
    needsRecipient(person.toHand[kind]),
  );
  const mustChoose = kindsToHand.length > 0;
  const what = listed(kindsToHand.map((kind) => SPACE_WORDS[kind].plural));
  const stayWithTheirPeople = managedAloneText(person);
  const recipient =
    others.find((other) => other.id === recipientId)?.name ??
    "the person you choose";
  return (
    <Modal
      title={`Remove ${person.name}?`}
      busy={pending !== null}
      onClose={onClose}
    >
      <p className="text-sm text-secondary">
        {person.name}'s account goes away, and they lose access to every
        mailbox. No mail is deleted: their mailbox stays, and you can give
        someone else access under Email addresses.
      </p>
      {mustChoose && (
        <>
          <RecipientField
            label={`Who receives their ${what}`}
            value={recipientId}
            people={others}
            disabled={pending !== null}
            onChange={setRecipientId}
          />
          <p className="text-sm text-secondary">
            None of their {what} are deleted, and you don't get to see them
            unless you choose yourself. {handOverText(person, recipient)}
          </p>
        </>
      )}
      {stayWithTheirPeople && (
        <p className="text-sm text-secondary">{stayWithTheirPeople}</p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="quiet" disabled={pending !== null} onClick={onClose}>
          Go back
        </Button>
        <Button
          variant="danger"
          pending={pending !== null}
          disabled={mustChoose && recipientId === ""}
          onClick={() =>
            run("remove", async () => {
              const outcome = await removeMember({
                data: { userId: person.id, recipientId: recipientId || null },
              });
              if (!outcome.ok) return outcome.message;
              await router.invalidate();
              onClose();
            })
          }
        >
          Remove
        </Button>
      </div>
    </Modal>
  );
}

function PersonActions({
  person,
  others,
}: {
  person: PersonRow;
  others: readonly PersonRow[];
}) {
  const router = useRouter();
  const { pending, error, run } = useAction<ActionKey>();
  const [confirming, setConfirming] = useState<ActionKey | null>(null);
  const [removing, setRemoving] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const keys: ActionKey[] = [
    "reset",
    person.role === "admin" ? "demote" : "promote",
    person.suspended ? "resume" : "suspend",
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
        <Button variant="danger" onClick={() => setRemoving(true)}>
          Remove
        </Button>
      </div>
      {removing && (
        <RemoveDialog
          person={person}
          others={others}
          onClose={() => setRemoving(false)}
        />
      )}
      {action && (
        <Modal
          title={action.title(person.name)}
          busy={pending !== null}
          onClose={() => setConfirming(null)}
        >
          <p className="text-sm text-secondary">{action.body(person.name)}</p>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button
              variant="quiet"
              disabled={pending !== null}
              onClick={() => setConfirming(null)}
            >
              Go back
            </Button>
            <Button
              variant={action.danger ? "danger" : "action"}
              pending={pending === confirming}
              onClick={() =>
                run(confirming, async () => {
                  const outcome = await action.run(person.id);
                  if (!outcome.ok) return outcome.message;
                  await router.invalidate();
                  if (outcome.link) setLink(outcome.link);
                  setConfirming(null);
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

function myFilesText({ myFiles }: PersonRow): string {
  const used = `My files: ${formatBytes(myFiles?.usedBytes ?? 0)} used`;
  return myFiles?.limitBytes
    ? `${used} of the ${formatBytes(myFiles.limitBytes)} limit`
    : `${used}, no limit`;
}

function MyFilesLimit({ person }: { person: PersonRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="flex-1 text-sm text-secondary">{myFilesText(person)}</p>
      <Button variant="quiet" onClick={() => setOpen(true)}>
        {(person.myFiles?.limitBytes ?? null) === null
          ? "Set limit"
          : "Change limit"}
      </Button>
      {open && (
        <MyFilesLimitDialog person={person} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function MyFilesLimitDialog({
  person,
  onClose,
}: {
  person: PersonRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const limit = useAction<LimitKey>();
  return (
    <Modal
      title={`My files limit for ${person.name}`}
      busy={limit.pending !== null}
      onClose={onClose}
    >
      <p className="text-sm text-secondary">
        This limits what {person.name} can keep in My files. Team folders count
        only towards the organisation's limit.
      </p>
      <StorageLimitForm
        action={limit}
        label="Limit for My files, in GB"
        limitBytes={person.myFiles?.limitBytes ?? null}
        onChange={async (next) => {
          const outcome = await changeMyFilesLimit({
            data: { userId: person.id, limitBytes: next },
          });
          if (!outcome.ok) return outcome.message;
          await router.invalidate();
          onClose();
          return null;
        }}
      />
    </Modal>
  );
}

function PersonItem({
  person,
  isYou,
  others,
}: {
  person: PersonRow;
  isYou: boolean;
  others: readonly PersonRow[];
}) {
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
      <MyFilesLimit person={person} />
      {!isYou && <PersonActions person={person} others={others} />}
    </li>
  );
}

function ClaimItem({
  drive,
  people,
}: {
  drive: DriveToClaim;
  people: readonly PersonRow[];
}) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [recipientId, setRecipientId] = useState("");
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <p className="font-medium">
        {drive.kind === "personal"
          ? "My files of someone who was removed"
          : drive.name}
      </p>
      <p className="text-sm text-secondary">
        {drive.fileCount === 1 ? "1 file" : `${drive.fileCount} files`}
      </p>
      <RecipientField
        value={recipientId}
        people={people}
        disabled={pending !== null}
        onChange={setRecipientId}
      />
      {error && <Notice tone="danger">{error}</Notice>}
      <div>
        <Button
          variant="action"
          pending={pending !== null}
          disabled={recipientId === ""}
          onClick={() =>
            run("hand-over", async () => {
              const outcome = await handOverDrive({
                data: { driveId: drive.id, recipientId },
              });
              if (!outcome.ok) return outcome.message;
              await router.invalidate();
            })
          }
        >
          Hand over
        </Button>
      </div>
    </li>
  );
}

export function PeoplePage({ view }: { view: PeopleView }) {
  const active = view.people.filter((person) => !person.suspended);
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
      {view.drivesToClaim.length > 0 && (
        <Section
          title="Files waiting for someone"
          description="These belonged to people removed before files could be handed over. Nobody can open them until you choose who receives them, and nothing is deleted."
        >
          <ul className="flex flex-col divide-y divide-line">
            {view.drivesToClaim.map((drive) => (
              <ClaimItem key={drive.id} drive={drive} people={active} />
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
              others={active.filter((other) => other.id !== person.id)}
            />
          ))}
        </ul>
      </Section>
    </AdminPage>
  );
}
