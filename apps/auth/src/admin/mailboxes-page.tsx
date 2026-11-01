import {
  Badge,
  Button,
  Notice,
  Section,
  SelectField,
  TextField,
} from "@cloudysuite/ui";
import { IconInbox, IconUsers } from "@tabler/icons-react";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import type { MailboxRole, UserId } from "../../../../src/db/schema";
import { useAction } from "../account/use-action";
import { AddressField } from "./address-field";
import { AdminPage } from "./admin-page";
import {
  addAlias,
  createPersonalMailbox,
  createSharedMailbox,
  grantMailboxAccess,
  removeAlias,
  revokeMailboxAccess,
} from "./functions";
import type { MailboxesView, MailboxRow } from "./mailboxes";

const ROLE_LABEL: Record<MailboxRole, string> = {
  manager: "Manager: can read, send, and import mail",
  member: "Member: can read and send mail",
};

function addressFrom(values: FormData): string {
  return `${String(values.get("local")).trim()}@${String(values.get("domain"))}`;
}

function MailboxCard({
  mailbox,
  people,
  emailDomains,
}: {
  mailbox: MailboxRow;
  people: MailboxesView["people"];
  emailDomains: string[];
}) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const available = people.filter(
    (person) => !mailbox.access.some((a) => a.userId === person.id),
  );

  function addAliasSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const address = addressFrom(new FormData(form));
    return run(async () => {
      const outcome = await addAlias({
        data: { mailboxId: mailbox.id, address },
      });
      if (!outcome.ok) return outcome.message;
      form.reset();
      await router.invalidate();
    });
  }

  function grantSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    return run(async () => {
      const outcome = await grantMailboxAccess({
        data: {
          mailboxId: mailbox.id,
          userId: String(values.get("userId")) as UserId,
          role: String(values.get("role")) as MailboxRole,
        },
      });
      if (!outcome.ok) return outcome.message;
      form.reset();
      await router.invalidate();
    });
  }

  return (
    <Section title={mailbox.name}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{mailbox.kind === "shared" ? "Shared" : "Personal"}</Badge>
        {mailbox.access.length === 0 && (
          <Badge tone="danger">Nobody can open this mailbox</Badge>
        )}
      </div>

      <h3 className="text-sm font-semibold">Addresses</h3>
      <ul className="flex flex-col gap-1">
        {mailbox.addresses.map(({ address, kind }) => (
          <li key={address} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {address}
              {kind === "primary" && (
                <span className="text-secondary"> (main address)</span>
              )}
            </span>
            {kind === "alias" && (
              <Button
                variant="danger"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await removeAlias({ data: { address } });
                    await router.invalidate();
                  })
                }
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {emailDomains.length > 0 && (
        <form className="flex flex-col gap-2" onSubmit={addAliasSubmit}>
          <AddressField
            label="Add another address for this mailbox"
            domains={emailDomains}
            required
          />
          <div>
            <Button type="submit" variant="quiet" disabled={pending}>
              Add address
            </Button>
          </div>
        </form>
      )}

      <h3 className="text-sm font-semibold">Who can open it</h3>
      {mailbox.access.length === 0 && (
        <p className="text-sm text-secondary">
          Its mail is safe and new mail still arrives. Give someone access to
          read it.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {mailbox.access.map((access) => (
          <li key={access.userId} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {access.name}{" "}
              <span className="text-secondary">
                ({access.role === "manager" ? "manager" : "member"})
              </span>
            </span>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  await revokeMailboxAccess({
                    data: { mailboxId: mailbox.id, userId: access.userId },
                  });
                  await router.invalidate();
                })
              }
            >
              Remove access
            </Button>
          </li>
        ))}
      </ul>
      {available.length > 0 && (
        <form className="flex flex-col gap-2" onSubmit={grantSubmit}>
          <SelectField label="Person" name="userId">
            {available.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} ({person.email})
              </option>
            ))}
          </SelectField>
          <SelectField label="Access" name="role" defaultValue="member">
            <option value="member">{ROLE_LABEL.member}</option>
            <option value="manager">{ROLE_LABEL.manager}</option>
          </SelectField>
          <div>
            <Button type="submit" variant="quiet" disabled={pending}>
              Give access
            </Button>
          </div>
        </form>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </Section>
  );
}

function NewMailboxSection({ view }: { view: MailboxesView }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [kind, setKind] = useState<"shared" | "personal">("shared");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const address = addressFrom(values);
    return run(async () => {
      const outcome =
        kind === "shared"
          ? await createSharedMailbox({
              data: { name: String(values.get("name")), address },
            })
          : await createPersonalMailbox({
              data: { userId: String(values.get("userId")), address },
            });
      if (!outcome.ok) return outcome.message;
      form.reset();
      await router.invalidate();
    });
  }

  if (view.emailDomains.length === 0) {
    return (
      <Notice tone="info">
        You don't have an email domain yet. Add one under Email domains, then
        come back here.
      </Notice>
    );
  }
  return (
    <Section
      title="New mailbox"
      description="A shared mailbox, such as support@, can be opened by several people. A personal mailbox belongs to one person."
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div className="flex gap-2">
          <Button
            variant={kind === "shared" ? "action" : "quiet"}
            icon={IconUsers}
            onClick={() => setKind("shared")}
          >
            Shared
          </Button>
          <Button
            variant={kind === "personal" ? "action" : "quiet"}
            icon={IconInbox}
            onClick={() => setKind("personal")}
          >
            Personal
          </Button>
        </div>
        {kind === "shared" ? (
          <TextField label="Name" name="name" placeholder="Support" required />
        ) : (
          <SelectField label="Person" name="userId">
            {view.people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name} ({person.email})
              </option>
            ))}
          </SelectField>
        )}
        <AddressField label="Address" domains={view.emailDomains} required />
        <div>
          <Button type="submit" variant="action" disabled={pending}>
            Create mailbox
          </Button>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Section>
  );
}

export function MailboxesPage({ view }: { view: MailboxesView }) {
  return (
    <AdminPage
      title="Email addresses"
      description="Mailboxes, the addresses that deliver to them, and who can open each one."
    >
      <NewMailboxSection view={view} />
      {view.mailboxes.map((mailbox) => (
        <MailboxCard
          key={mailbox.id}
          mailbox={mailbox}
          people={view.people}
          emailDomains={view.emailDomains}
        />
      ))}
    </AdminPage>
  );
}
