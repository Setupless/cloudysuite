import { Button, TextField } from "@cloudysuite/ui";
import {
  type Icon,
  IconAlertTriangle,
  IconCircle,
  IconCircleCheck,
  IconCircleX,
  IconCloud,
  IconExternalLink,
  IconKey,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type Claim,
  type ClaimResponse,
  type DomainChoice,
  type DomainPlan,
  type FinishResponse,
  type ManualGuide,
  PASSWORD_LENGTH,
  type ScanResponse,
  type SetupError,
  type SetupRequest,
  type SetupResult,
  STEP_IDS,
  type StepId,
  type StepMode,
  type StepResponse,
  type StepResult,
  type ZoneScan,
  type ZoneSummary,
} from "./model";
import { TOKEN_PERMISSIONS, tokenFormUrl } from "./token-link";
import { isAppLabel } from "./validate";

const STEP_TEXT: Record<StepId, { title: string; description: string }> = {
  "email-routing": {
    title: "Receive mail",
    description: "Turns on Cloudflare Email Routing for your domain.",
  },
  "email-sending": {
    title: "Send mail",
    description:
      "Turns on Cloudflare Email Sending, so your messages can leave your domain.",
  },
  "catch-all": {
    title: "Bring mail to CloudySuite",
    description:
      "Sends mail for every address at your domain to CloudySuite. If a catch-all rule is already in use, we ask you first.",
  },
  "app-hostnames": {
    title: "Give your apps their addresses",
    description: "Attaches the Auth and Mail web addresses to CloudySuite.",
  },
  "auth-secret": {
    title: "Protect sign-in",
    description:
      "Creates a secret key that keeps sign-ins safe. It stays inside Cloudflare.",
  },
};

const GUIDES = {
  domain:
    "https://developers.cloudflare.com/fundamentals/manage-domains/add-site/",
  plan: "https://developers.cloudflare.com/workers/platform/pricing/",
};

type CallOutcome<Body> = SetupResult<Body> | { ok: "finished" };

// The token goes in the request body, because URLs end up in logs and history.
async function call<Body>(request: SetupRequest): Promise<CallOutcome<Body>> {
  let response: Response;
  try {
    response = await fetch("/setup/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      redirect: "manual",
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "unexpected",
        message:
          "We couldn't reach CloudySuite. Check your connection and try again.",
      },
    };
  }
  // The router answers this way once a primary domain is stored.
  if (response.type === "opaqueredirect" || response.status === 404)
    return { ok: "finished" };
  const body = (await response
    .json()
    .catch(() => null)) as SetupResult<Body> | null;
  if (!body || typeof body.ok !== "boolean" || (!body.ok && !body.error)) {
    return {
      ok: false,
      error: {
        code: "unexpected",
        message: "Something went wrong on our side. Try again.",
      },
    };
  }
  if (!body.ok && body.error.code === "already-finished")
    return { ok: "finished" };
  return body;
}

type Stage =
  | { name: "token" }
  | { name: "domain"; claim: Claim; zones: ZoneSummary[] }
  | { name: "steps"; claim: Claim; choice: DomainChoice }
  | { name: "admin"; claim: Claim; choice: DomainChoice; plan: DomainPlan }
  | { name: "finished"; authUrl: string | null; created: boolean };

const STAGE_NUMBER: Record<Stage["name"], number> = {
  token: 1,
  domain: 2,
  steps: 3,
  admin: 4,
  finished: 4,
};

export function SetupWizard() {
  // The token lives only in this state, so closing the page forgets it.
  const [stage, setStage] = useState<Stage>({ name: "token" });
  const onAlreadyFinished = () =>
    setStage({ name: "finished", authUrl: null, created: false });
  return (
    <main className="min-h-dvh bg-page p-6 text-text">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 py-6">
        <header className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-sidebar text-accent">
            <IconCloud size={22} stroke={1.5} aria-hidden />
          </div>
          <div>
            <p className="font-semibold">Set up CloudySuite</p>
            <p className="text-sm text-secondary">
              {stage.name === "finished"
                ? "All done"
                : `Part ${STAGE_NUMBER[stage.name]} of 4`}
            </p>
          </div>
        </header>
        {stage.name === "token" && (
          <TokenStage
            onClaimed={(claim, zones) =>
              setStage({ name: "domain", claim, zones })
            }
            onFinished={onAlreadyFinished}
          />
        )}
        {stage.name === "domain" && (
          <DomainStage
            claim={stage.claim}
            zones={stage.zones}
            onChosen={(choice) =>
              setStage({ name: "steps", claim: stage.claim, choice })
            }
            onFinished={onAlreadyFinished}
          />
        )}
        {stage.name === "steps" && (
          <StepsStage
            claim={stage.claim}
            choice={stage.choice}
            onDone={(plan) =>
              setStage({
                name: "admin",
                claim: stage.claim,
                choice: stage.choice,
                plan,
              })
            }
            onFinished={onAlreadyFinished}
          />
        )}
        {stage.name === "admin" && (
          <AdminStage
            claim={stage.claim}
            choice={stage.choice}
            plan={stage.plan}
            onFinished={(authUrl, created) =>
              setStage({ name: "finished", authUrl, created })
            }
          />
        )}
        {stage.name === "finished" && (
          <FinishedStage authUrl={stage.authUrl} created={stage.created} />
        )}
      </div>
    </main>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-accent underline underline-offset-2"
    >
      {children}
      <IconExternalLink size={14} stroke={1.75} aria-hidden />
    </a>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded border border-line bg-panel p-5">
      {children}
    </section>
  );
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children && <p className="text-secondary">{children}</p>}
    </div>
  );
}

function GuideBox({ guide }: { guide: ManualGuide }) {
  return (
    <div className="flex flex-col gap-2 rounded bg-sidebar p-3 text-sm">
      <p>{guide.action}</p>
      <p className="flex flex-wrap gap-4">
        <Link href={guide.dashboardUrl}>Open Cloudflare</Link>
        <Link href={guide.docsUrl}>Read the guide</Link>
      </p>
    </div>
  );
}

function ErrorBox({ error }: { error: SetupError }) {
  return (
    <div role="alert" className="flex flex-col gap-2 text-sm">
      <p className="text-danger">{error.message}</p>
      {error.guide && <GuideBox guide={error.guide} />}
    </div>
  );
}

function TokenStage({
  onClaimed,
  onFinished,
}: {
  onClaimed: (claim: Claim, zones: ZoneSummary[]) => void;
  onFinished: () => void;
}) {
  const [error, setError] = useState<SetupError | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = String(new FormData(event.currentTarget).get("token")).trim();
    setPending(true);
    setError(null);
    const result = await call<ClaimResponse>({ action: "claim", token });
    setPending(false);
    if (result.ok === "finished") return onFinished();
    if (!result.ok) return setError(result.error);
    onClaimed(
      {
        token,
        accountId: result.worker.accountId,
        scriptName: result.worker.scriptName,
      },
      result.zones,
    );
  }

  const byHand = TOKEN_PERMISSIONS.filter(({ key }) => key === null);

  return (
    <Card>
      <Heading title="Connect your Cloudflare account">
        CloudySuite needs a Cloudflare token to set up your domain. This also
        proves that this copy of CloudySuite is yours.
      </Heading>
      <div className="flex flex-col gap-1 text-sm text-secondary">
        <p>You need two things before you start:</p>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            A domain on Cloudflare.{" "}
            <Link href={GUIDES.domain}>How to add a domain</Link>
          </li>
          <li>
            The Workers Paid plan, for sending mail.{" "}
            <Link href={GUIDES.plan}>About Workers Paid</Link>
          </li>
        </ul>
      </div>
      <ol className="flex list-decimal flex-col gap-3 pl-5">
        <li>
          <div className="flex flex-col gap-2">
            <p>
              Create a token. This link opens Cloudflare with the form partly
              filled in.
            </p>
            <a
              href={tokenFormUrl()}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-2 rounded bg-accent px-4 py-2.5 font-medium text-on-accent outline-accent focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <IconKey size={18} stroke={1.75} aria-hidden />
              Create a token
            </a>
            <div className="text-sm text-secondary">
              <p>The token needs these permissions:</p>
              <ul className="list-disc pl-5">
                {TOKEN_PERMISSIONS.map(({ label, level }) => (
                  <li key={label}>
                    {label}: {level}
                  </li>
                ))}
              </ul>
              {byHand.length > 0 && (
                <p className="mt-2 font-medium text-text">
                  Add {byHand.map(({ label }) => label).join(" and ")} yourself.
                  Cloudflare's form can't fill those in from a link.
                </p>
              )}
            </div>
          </div>
        </li>
        <li>
          <div className="flex flex-col gap-2">
            <p>Paste the token here.</p>
            <form className="flex flex-col gap-3" onSubmit={submit}>
              <TextField
                label="Cloudflare token"
                name="token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                required
              />
              <Button
                type="submit"
                disabled={pending}
                icon={pending ? IconLoader2 : undefined}
              >
                {pending ? "Checking your token" : "Continue"}
              </Button>
            </form>
            <p className="text-sm text-secondary">
              CloudySuite never saves your token. It stays in this page and is
              forgotten when you close it.
            </p>
          </div>
        </li>
      </ol>
      {error && <ErrorBox error={error} />}
    </Card>
  );
}

const Radio = ({
  name,
  checked,
  onChange,
  disabled,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  children: ReactNode;
}) => (
  <label
    className={`flex items-start gap-3 rounded border p-3 ${checked ? "border-accent bg-selected" : "border-line"} ${disabled ? "opacity-60" : "cursor-pointer"}`}
  >
    <input
      type="radio"
      name={name}
      className="mt-1 accent-accent"
      checked={checked}
      onChange={onChange}
      disabled={disabled}
    />
    <span className="flex flex-col gap-1">{children}</span>
  </label>
);

function DomainStage({
  claim,
  zones,
  onChosen,
  onFinished,
}: {
  claim: Claim;
  zones: ZoneSummary[];
  onChosen: (choice: DomainChoice) => void;
  onFinished: () => void;
}) {
  const [zone, setZone] = useState<ZoneSummary | null>(null);
  const [scan, setScan] = useState<ZoneScan | null>(null);
  const [useParent, setUseParent] = useState(false);
  const [label, setLabel] = useState("suite");
  const [error, setError] = useState<SetupError | null>(null);
  const [pending, setPending] = useState(false);
  const latestZone = useRef<string | null>(null);

  async function chooseZone(next: ZoneSummary) {
    latestZone.current = next.id;
    setZone(next);
    setScan(null);
    setError(null);
    setPending(true);
    const result = await call<ScanResponse>({
      action: "scan",
      claim,
      zoneId: next.id,
    });
    // The person may have picked another domain while this one was loading.
    if (latestZone.current !== next.id) return;
    setPending(false);
    if (result.ok === "finished") return onFinished();
    if (!result.ok) return setError(result.error);
    setScan(result.scan);
    const start =
      result.scan.resumedLabel !== undefined
        ? result.scan.resumedLabel
        : result.scan.recommendedLabel;
    setUseParent(start !== null);
    setLabel(start ?? "suite");
  }

  const labelOk = !useParent || isAppLabel(label);

  return (
    <Card>
      <Heading title="Choose your domain">
        Your email addresses will end in this domain.
      </Heading>
      <div className="flex flex-col gap-2">
        {zones.map((item) => (
          <Radio
            key={item.id}
            name="zone"
            checked={zone?.id === item.id}
            disabled={!item.active}
            onChange={() => chooseZone(item)}
          >
            <span className="font-medium">{item.name}</span>
            {!item.active && (
              <span className="text-sm text-secondary">
                Cloudflare is still waiting for this domain to move over. Finish
                that first.
              </span>
            )}
          </Radio>
        ))}
      </div>
      {pending && (
        <p className="text-sm text-secondary">
          Looking at this domain's settings…
        </p>
      )}
      {zone && scan && (
        <div className="flex flex-col gap-3">
          {scan.externalMx.length > 0 && (
            <div className="flex gap-2 rounded bg-sidebar p-3 text-sm">
              <IconAlertTriangle
                size={18}
                stroke={1.75}
                className="shrink-0 text-danger"
                aria-hidden
              />
              <p>
                Mail for {zone.name} currently goes to{" "}
                {scan.externalMx.join(", ")}. Moving to CloudySuite means mail
                stops going there. The next part shows you how, and nothing
                changes until you do it.
              </p>
            </div>
          )}
          {scan.hostedHosts.length > 0 && (
            <div className="flex flex-col gap-1 text-sm">
              <p className="font-medium">
                We found other sites on this domain:
              </p>
              <p className="text-secondary">{scan.hostedHosts.join(", ")}</p>
              <p>
                When someone signs in, their browser keeps a sign-in pass that
                it also sends to every site under the same address. If apps sit
                directly on {zone.name}, whoever runs those sites could use that
                pass to act as your people. A separate address keeps it away
                from them. Your email stays @{zone.name} either way.
              </p>
            </div>
          )}
          <p className="font-medium">Where should your apps live?</p>
          <Radio
            name="address"
            checked={useParent}
            onChange={() => {
              setUseParent(true);
            }}
          >
            <span className="font-medium">
              A separate address
              {scan.hostedHosts.length > 0 ? " (recommended)" : ""}
            </span>
            <span className="text-sm text-secondary">
              auth.{label}.{zone.name} and mail.{label}.{zone.name}
            </span>
          </Radio>
          {useParent && (
            <TextField
              label="Address name"
              value={label}
              onChange={(event) =>
                setLabel(event.target.value.trim().toLowerCase())
              }
            />
          )}
          {!labelOk && (
            <p role="alert" className="text-sm text-danger">
              Use lowercase letters, numbers, and hyphens. It can't be "auth" or
              "mail".
            </p>
          )}
          <Radio
            name="address"
            checked={!useParent}
            onChange={() => {
              setUseParent(false);
            }}
          >
            <span className="font-medium">
              Directly on {zone.name}
              {scan.hostedHosts.length === 0 ? " (recommended)" : ""}
            </span>
            <span className="text-sm text-secondary">
              auth.{zone.name} and mail.{zone.name}
              {scan.hostedHosts.length > 0
                ? ". The other sites could use sign-in passes."
                : ""}
            </span>
          </Radio>
          <Button
            disabled={!labelOk}
            onClick={() =>
              onChosen({ zoneId: zone.id, appLabel: useParent ? label : null })
            }
          >
            Continue
          </Button>
        </div>
      )}
      {error && <ErrorBox error={error} />}
    </Card>
  );
}

type StepView = StepResult | { state: "working" } | { state: "unknown" };

const STATE_ICON: Record<
  StepView["state"],
  { icon: Icon; className: string; label: string }
> = {
  done: { icon: IconCircleCheck, className: "text-success", label: "Done" },
  missing: {
    icon: IconCircle,
    className: "text-secondary",
    label: "Not done yet",
  },
  "needs-action": {
    icon: IconAlertTriangle,
    className: "text-danger",
    label: "Needs you",
  },
  "needs-confirmation": {
    icon: IconAlertTriangle,
    className: "text-danger",
    label: "Needs your decision",
  },
  failed: { icon: IconCircleX, className: "text-danger", label: "Didn't work" },
  working: {
    icon: IconLoader2,
    className: "animate-spin text-accent",
    label: "Working",
  },
  unknown: { icon: IconCircle, className: "text-secondary", label: "Checking" },
};

const RETRY_MS = 5000;
const MAX_RETRIES = 12;

function StepsStage({
  claim,
  choice,
  onDone,
  onFinished,
}: {
  claim: Claim;
  choice: DomainChoice;
  onDone: (plan: DomainPlan) => void;
  onFinished: () => void;
}) {
  const [views, setViews] = useState<Record<StepId, StepView>>(
    () =>
      Object.fromEntries(
        STEP_IDS.map((id) => [id, { state: "unknown" }]),
      ) as Record<StepId, StepView>,
  );
  const [plan, setPlan] = useState<DomainPlan | null>(null);
  const [error, setError] = useState<SetupError | null>(null);
  const [busy, setBusy] = useState(true);
  const retries = useRef(0);

  async function callStep(
    stepId: StepId,
    mode: StepMode,
    confirmReplace?: string,
  ): Promise<StepResult | null> {
    setViews((current) => ({ ...current, [stepId]: { state: "working" } }));
    const outcome = await call<StepResponse>({
      action: "step",
      claim,
      choice,
      stepId,
      mode,
      confirmReplace,
    });
    if (outcome.ok === "finished") {
      onFinished();
      return null;
    }
    if (!outcome.ok) {
      setError(outcome.error);
      setViews((current) => ({ ...current, [stepId]: { state: "unknown" } }));
      return null;
    }
    setPlan(outcome.plan);
    setViews((current) => ({ ...current, [stepId]: outcome.result }));
    return outcome.result;
  }

  async function checkAll() {
    setBusy(true);
    setError(null);
    for (const stepId of STEP_IDS) {
      const result = await callStep(stepId, "check");
      if (!result) break;
    }
    setBusy(false);
  }

  async function runFrom(
    mode: StepMode,
    ids: readonly StepId[],
    confirmed?: { stepId: StepId; current: string },
  ) {
    setBusy(true);
    setError(null);
    for (const stepId of ids) {
      if (mode === "run" && views[stepId].state === "done") continue;
      const result = await callStep(
        stepId,
        mode,
        confirmed?.stepId === stepId ? confirmed.current : undefined,
      );
      if (result?.state !== "done") break;
    }
    setBusy(false);
  }

  useEffect(() => {
    void checkAll();
  }, []);

  const waiting = STEP_IDS.find((id) => {
    const view = views[id];
    return view.state === "needs-action" && view.retry;
  });

  useEffect(() => {
    if (!waiting || busy || retries.current >= MAX_RETRIES) return;
    retries.current++;
    const timer = setTimeout(() => void runFrom("check", [waiting]), RETRY_MS);
    return () => clearTimeout(timer);
  });

  const allDone = STEP_IDS.every((id) => views[id].state === "done");
  const anyLeft = STEP_IDS.some((id) => views[id].state === "missing");

  return (
    <Card>
      <Heading title="Connect your domain">
        {plan
          ? `Email at ${plan.emailDomain}, apps at auth.${plan.appDomain} and mail.${plan.appDomain}.`
          : "Checking what's already in place."}
      </Heading>
      <ul className="flex flex-col gap-3">
        {STEP_IDS.map((id) => (
          <StepRow
            key={id}
            id={id}
            view={views[id]}
            busy={busy}
            onCheckAgain={() => {
              retries.current = 0;
              return runFrom("check", [id]);
            }}
            onConfirm={(current) =>
              runFrom("run", STEP_IDS, { stepId: id, current })
            }
          />
        ))}
      </ul>
      {error && <ErrorBox error={error} />}
      {anyLeft && !allDone && (
        <Button disabled={busy} onClick={() => runFrom("run", STEP_IDS)}>
          Set up my domain
        </Button>
      )}
      {allDone && plan && (
        <Button disabled={busy} onClick={() => onDone(plan)}>
          Continue
        </Button>
      )}
      {error && !busy && (
        <Button variant="secondary" icon={IconRefresh} onClick={checkAll}>
          Check again
        </Button>
      )}
    </Card>
  );
}

function StepRow({
  id,
  view,
  busy,
  onCheckAgain,
  onConfirm,
}: {
  id: StepId;
  view: StepView;
  busy: boolean;
  onCheckAgain: () => void;
  onConfirm: (current: string) => void;
}) {
  const { title, description } = STEP_TEXT[id];
  const { icon: StateIcon, className, label } = STATE_ICON[view.state];
  return (
    <li className="flex gap-3">
      <StateIcon
        size={22}
        stroke={1.75}
        className={`mt-0.5 shrink-0 ${className}`}
        aria-label={label}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <p className="font-medium">{title}</p>
          <p className="text-sm text-secondary">
            {view.state === "done" || view.state === "missing"
              ? view.detail
              : description}
          </p>
        </div>
        {view.state === "needs-action" && <GuideBox guide={view.guide} />}
        {view.state === "needs-confirmation" && (
          <div className="flex flex-col gap-2 rounded bg-sidebar p-3 text-sm">
            <p>{view.current}</p>
            <p>
              If you replace this rule, that stops and this mail comes to
              CloudySuite instead. To keep the rule, stop here. It stays as it
              is until you choose.
            </p>
            <div>
              <Button disabled={busy} onClick={() => onConfirm(view.current)}>
                Replace this rule
              </Button>
            </div>
          </div>
        )}
        {view.state === "failed" && (
          <p role="alert" className="text-sm text-danger">
            {view.message} Your earlier steps are safe, so you can try this one
            again.
          </p>
        )}
        {(view.state === "needs-action" ||
          view.state === "needs-confirmation" ||
          view.state === "failed") && (
          <div>
            <Button
              variant="secondary"
              icon={IconRefresh}
              disabled={busy}
              onClick={onCheckAgain}
            >
              Check again
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function AdminStage({
  claim,
  choice,
  plan,
  onFinished,
}: {
  claim: Claim;
  choice: DomainChoice;
  plan: DomainPlan;
  onFinished: (authUrl: string | null, created: boolean) => void;
}) {
  const [error, setError] = useState<SetupError | null>(null);
  const [pending, setPending] = useState(false);
  const [local, setLocal] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await call<FinishResponse>({
      action: "finish",
      claim,
      choice,
      admin: {
        name: String(form.get("name")),
        email: String(form.get("email")),
        password: String(form.get("password")),
        mailboxLocalPart: String(form.get("local")),
      },
    });
    setPending(false);
    if (result.ok === "finished")
      return onFinished(`https://auth.${plan.appDomain}/`, false);
    if (!result.ok) return setError(result.error);
    onFinished(result.authUrl, true);
  }

  return (
    <Card>
      <Heading title="Create your admin account">
        You'll use this account to run CloudySuite and invite everyone else.
      </Heading>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <TextField
          label="Your name"
          name="name"
          autoComplete="name"
          required
          maxLength={100}
        />
        <TextField
          label="Email to sign in with"
          name="email"
          type="email"
          autoComplete="username"
          required
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_LENGTH.min}
          maxLength={PASSWORD_LENGTH.max}
        />
        <TextField
          label={`Your email address at ${plan.emailDomain}`}
          name="local"
          required
          value={local}
          onChange={(event) =>
            setLocal(event.target.value.trim().toLowerCase())
          }
          placeholder="you"
        />
        <p className="text-sm text-secondary">
          {local ? `Your mailbox will be ${local}@${plan.emailDomain}. ` : ""}
          Passwords need at least {PASSWORD_LENGTH.min} characters. Nobody can
          sign up by themselves: after this, people join only when an admin
          invites them.
        </p>
        <Button
          type="submit"
          disabled={pending}
          icon={pending ? IconLoader2 : undefined}
        >
          {pending ? "Finishing setup" : "Finish setup"}
        </Button>
      </form>
      {error && <ErrorBox error={error} />}
    </Card>
  );
}

function FinishedStage({
  authUrl,
  created,
}: {
  authUrl: string | null;
  created: boolean;
}) {
  return (
    <Card>
      <Heading title="CloudySuite is ready">
        {created
          ? "Sign in with the account you just made. A new address can take a few minutes to start working, so if the page doesn't open, wait and try again."
          : "Setup was already finished, so this didn't create an account. If you don't have one yet, ask the person who finished setup to invite you."}
      </Heading>
      {authUrl && (
        <a
          href={authUrl}
          className="flex items-center justify-center gap-2 rounded bg-accent px-4 py-2.5 font-medium text-on-accent outline-accent focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Go to {new URL(authUrl).host}
        </a>
      )}
      <p className="text-sm text-secondary">
        You can delete the Cloudflare token now. CloudySuite didn't keep it and
        doesn't need it again.
      </p>
    </Card>
  );
}
