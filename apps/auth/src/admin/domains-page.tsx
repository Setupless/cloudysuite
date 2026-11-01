import { Badge, Button, Notice, Section, TextField } from "@cloudysuite/ui";
import {
  IconCheck,
  IconQuestionMark,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { useAction } from "../account/use-action";
import { AdminPage } from "./admin-page";
import type { DnsCheck, DomainChecks } from "./domains";
import { addDomain, checkEmailDomain, type DomainsView } from "./functions";

const ROUTING_URL =
  "https://dash.cloudflare.com/?to=/:account/email-service/routing";
const SENDING_URL =
  "https://dash.cloudflare.com/?to=/:account/email-service/sending";

const CHECK_STATUS: Record<
  DnsCheck,
  { text: string; icon: typeof IconCheck; colour: string }
> = {
  found: { text: "Ready", icon: IconCheck, colour: "text-success" },
  missing: { text: "Not ready yet", icon: IconX, colour: "text-danger" },
  unknown: {
    text: "We couldn't check right now",
    icon: IconQuestionMark,
    colour: "text-secondary",
  },
};

function CheckLine({ label, check }: { label: string; check: DnsCheck }) {
  const { text, icon: Mark, colour } = CHECK_STATUS[check];
  return (
    <li className="flex items-center gap-2 text-sm">
      <Mark size={18} stroke={2} className={colour} aria-hidden />
      <span className="flex-1">{label}</span>
      <span className={colour}>{text}</span>
    </li>
  );
}

function Guide({
  name,
  onCancel,
  onAdded,
}: {
  name: string;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const { pending, error, run } = useAction();
  const [checks, setChecks] = useState<DomainChecks | null>(null);

  const check = () =>
    run(async () => {
      const outcome = await checkEmailDomain({ data: { name } });
      if (!outcome.ok) return outcome.message;
      setChecks(outcome.checks);
    });

  useEffect(() => {
    void check();
  }, [name]);

  const ready = checks?.receiving === "found" && checks.sending === "found";

  return (
    <Section
      title={`Add ${name}`}
      description="These steps happen in your Cloudflare account. CloudySuite doesn't keep a key to your account, so it can't do them for you."
    >
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        <li>
          Make sure {name} is in the Cloudflare account that runs CloudySuite.
          Email needs Cloudflare to manage the domain's DNS.
        </li>
        <li>
          Open{" "}
          <a
            className="text-accent"
            href={ROUTING_URL}
            target="_blank"
            rel="noreferrer"
          >
            Email Routing
          </a>
          , select <strong>Onboard Domain</strong>, choose {name}, then select{" "}
          <strong>Done</strong>.
        </li>
        <li>
          Still in Email Routing, select {name} and open the{" "}
          <strong>Routing Rules</strong> tab. Edit the{" "}
          <strong>Catch-all address</strong> rule, set its action to{" "}
          <strong>Send to a Worker</strong>, choose your CloudySuite Worker, and
          save. Turn the rule on.
        </li>
        <li>
          Open{" "}
          <a
            className="text-accent"
            href={SENDING_URL}
            target="_blank"
            rel="noreferrer"
          >
            Email Sending
          </a>
          , select <strong>Onboard Domain</strong>, choose {name}, then select{" "}
          <strong>Done</strong>.
        </li>
        <li>Wait a few minutes, then select Check again.</li>
      </ol>

      {checks && (
        <ul className="flex flex-col gap-1.5 rounded bg-sidebar p-3">
          <CheckLine
            label="Receiving email (step 2)"
            check={checks.receiving}
          />
          <CheckLine label="Sending email (step 4)" check={checks.sending} />
        </ul>
      )}
      <Notice tone="info">
        We can check steps 2 and 4 from here, but we can't see the catch-all
        rule in step 3. After you add the domain, send a test message to any
        address at {name} to confirm that it arrives.
      </Notice>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="quiet"
          icon={IconRefresh}
          disabled={pending}
          onClick={check}
        >
          Check again
        </Button>
        <Button
          variant="action"
          disabled={pending || !ready}
          onClick={() =>
            run(async () => {
              const outcome = await addDomain({ data: { name } });
              if (!outcome.ok) return outcome.message;
              onAdded();
            })
          }
        >
          Add {name}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Section>
  );
}

export function DomainsPage({
  view,
  adding,
}: {
  view: DomainsView;
  adding: string | null;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const [added, setAdded] = useState<string | null>(null);

  const setAdding = (name: string | null) =>
    navigate({
      to: ".",
      search: name ? { adding: name } : {},
    });

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdded(null);
    void setAdding(
      String(new FormData(event.currentTarget).get("name"))
        .trim()
        .toLowerCase(),
    );
  }

  return (
    <AdminPage
      title="Email domains"
      description="The domains people's email addresses can use."
    >
      <Section title="Your domains">
        <ul className="flex flex-col gap-1.5">
          {view.emailDomains.map((name) => (
            <li key={name} className="flex items-center gap-2">
              <span className="flex-1">{name}</span>
              {name === view.appDomain && <Badge>Also runs your apps</Badge>}
            </li>
          ))}
        </ul>
        {view.appDomain && !view.emailDomains.includes(view.appDomain) && (
          <p className="text-sm text-secondary">
            Your apps run at {view.appDomain}. That's separate from your email
            domains, so it isn't listed here.
          </p>
        )}
        {added && (
          <Notice tone="success">
            {added} is ready to use for new addresses.
          </Notice>
        )}
      </Section>
      {adding ? (
        <Guide
          key={adding}
          name={adding}
          onCancel={() => setAdding(null)}
          onAdded={() => {
            setAdded(adding);
            void setAdding(null).then(() => router.invalidate());
          }}
        />
      ) : (
        <Section
          title="Add an email domain"
          description="After you add a domain, people can have addresses on it."
        >
          <form className="flex flex-col gap-3" onSubmit={start}>
            <TextField
              label="Domain"
              name="name"
              placeholder="example.org"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            <div>
              <Button type="submit" variant="action">
                Show me the steps
              </Button>
            </div>
          </form>
        </Section>
      )}
    </AdminPage>
  );
}
