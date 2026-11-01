# CloudySuite

As close as you can get to Google, on Cloudflare, with your own domains.

CloudySuite is an open source workspace for small organisations. One technical person deploys it to the organisation's Cloudflare account. Everyone else signs in and uses clean, fast apps for mail, calendar, and storage.

**Status:** early scaffold. The repository has one Worker, the hostname router, placeholder pages, and a mailbox that stores raw messages. The product features do not exist yet, so this README describes the intended product.

## Who it is for

CloudySuite is for small companies and open source teams of about 2 to 100 people that do not yet have a cloud suite. One technical person deploys it. The people who use it every day do not need technical knowledge. We follow Apple's "it just works" philosophy.

One deployment serves one organisation. That organisation can use several email domains and aliases. Two organisations use two deployments in separate Cloudflare accounts, so they share no data.

## Apps

Each app has its own subdomain on the organisation's primary domain.

| Address                | Purpose                                     | Replaces                 | Release |
| ---------------------- | ------------------------------------------- | ------------------------ | ------- |
| `auth.example.com`     | Organisation, accounts, and email addresses | Google Admin and Account | First   |
| `mail.example.com`     | Mailboxes                                   | Gmail                    | First   |
| `calendar.example.com` | Calendars, also synced over CalDAV          | Google Calendar          | Later   |
| `storage.example.com`  | Files, also synced over WebDAV              | Google Drive             | Later   |

Later ideas include a password manager, docs, and sheets.

### Turn an app off

Every deployment contains every released app. An admin can turn each app off for the whole organisation, for example when the organisation keeps another mail provider.

- A person who opens a turned-off app sees a page that says an admin turned it off. The app also leaves the app switcher.
- The hostname router makes this check on the server for every request, so hiding the link is never the only protection.
- Turning an app off deletes nothing. Turning it back on restores everything.
- Inbound mail still reaches the mailbox while Mail is off, because a bounced message cannot be recovered later.
- Auth cannot be turned off, because admins use it to turn the other apps back on.

D1 stores the setting as one row for each app that can be turned off, and a missing row means the app is on:

```ts
type ToggleableApp = "mail";
type AppSetting = { app: ToggleableApp; enabled: boolean };
```

The `APPS` registry in `src/routing.ts` defines `ToggleableApp`, so the type grows when Calendar and Storage ship.

## First release

The first release contains Auth and Mail. Mail must be good enough to replace Gmail for daily use before work on the other apps starts.

### Deployment

You need a domain on Cloudflare DNS and the Workers Paid plan. The wizard links to the Cloudflare guide for each if you do not have them. You do not need Bun, Wrangler, or any other local tool.

1. Click the **Deploy to Cloudflare** button. It creates the Worker and its storage, and applies the database migrations.
2. Open the Worker's URL to start the first-run wizard.
3. Create an API token from the wizard's link, which pre-fills the token form, and paste the token into the wizard.
4. Choose your domain and where your apps should live. The wizard checks the domain's DNS and explains its recommendation.
5. The wizard enables Email Routing and Email Sending, points the catch-all rule at the Worker, attaches the `auth` and `mail` hostnames, and generates the sign-in secret.
6. Create the first admin account, which also gets a personal mailbox. The wizard then sends you to `auth.<app domain>`.

The wizard calls the Cloudflare API from the Worker. It does not store the token: the token stays in the browser tab, and each call sends it again.

Only someone who holds a token for the Worker's account can finish setup, so a stranger who finds a new deployment's URL cannot claim the admin account. Every call proves two things with the pasted token:

- **The token's account owns this Worker.** The Worker reads its running version id from its `version_metadata` binding, and Cloudflare must confirm that version exists on a script in the token's account. Cloudflare generates that id, so nobody can recreate it in another account. The check reads the id on every call, so it still holds after setting a secret starts a new version. This is also how the Worker learns its own script name.
- **The token can change this Worker.** Read access alone is not enough, so the wizard reads `.../script-settings` and sends the same values back in a `PATCH`, which changes nothing but needs Workers Scripts Edit. If Cloudflare returns no settings to send back, the proof fails and the wizard writes nothing.

Until both proofs pass, the caller could be anyone, so errors from Cloudflare reach them only as a plain message. After that, the wizard shows Cloudflare's own words.

Each wizard step checks the current state in Cloudflare, applies the change through the API, and checks again. If the API cannot complete a step, the wizard shows the exact action to take, a link to that Cloudflare dashboard page, and a link to the Cloudflare docs. The admin completes the action and clicks **Check again**, so the wizard never assumes that a manual step worked. The wizard never deletes a DNS record, so existing MX records and conflicting hostnames are always manual steps.

The wizard never replaces mail routing that is in use without asking. If an enabled catch-all rule forwards mail, deletes it, or sends it to another Worker, the wizard says so in plain language and waits. The server replaces the rule only when the request repeats the description the person saw, so a rule that changed in the meantime is shown again. A disabled rule carries no mail, so the wizard replaces it without asking.

The catch-all goes live before the first admin's address exists. Until setup finishes, the Worker rejects mail for every address at the domain, so a sender gets a bounce saying there is no mailbox there, and no message is lost silently.

The primary domain is stored last, in one atomic batch with the admin's user, password, mailbox, address, and access. The database allows one primary domain, so when two people finish at once, exactly one wins and the other leaves nothing behind. Until then, the router keeps every hostname on `/setup` and nobody can sign in, so an interrupted setup can always resume. Afterwards the router sends `/setup` away on an app hostname and treats the `workers.dev` hostname as unknown, so nobody can run the wizard again.

#### App domain and email domain

These are separate, and either may be the zone apex:

| Domain       | What it is                                                     | Stored as                                   |
| ------------ | -------------------------------------------------------------- | ------------------------------------------- |
| App domain   | Parent of `auth.` and `mail.`, and the session cookie's domain | The `domains` row with `is_primary = 1`     |
| Email domain | What follows `@` in addresses                                  | A `domains` row, used by `addresses.domain` |

The session cookie covers the app domain and every site under it, so whoever runs any site there could read a signed-in person's cookie. The wizard scans the zone's DNS and custom domains for that reason. A name counts as CloudySuite's own only when Cloudflare says it is a custom domain attached to this Worker, and anything else counts as another site, even `auth` or `mail`:

- With no other hosted site, the app domain is the apex, such as `auth.example.com`.
- With other sites, such as a third-party `www`, the wizard explains the risk and recommends a parent such as `suite.example.com`. Apps become `auth.suite.example.com`, and email stays `@example.com`.

The email domain is always the zone apex, because Email Routing's catch-all rule works only there.

### Updates

The Deploy button copies the repository, so a deployment has no link back to this one. Security patches, such as Better Auth fixes, reach a deployment only when its admin applies them.

- The admin screen compares the running version with the latest GitHub release and links to these steps.
- The admin applies the update by hand. CloudySuite never changes itself.

The Deploy button puts the copy in your GitHub or GitLab account and connects it to Cloudflare, so a push to the copy's `main` branch deploys it and applies any database migrations. Updating means replacing the copy's files with a release's files.

**Updating needs a terminal with Git.** GitHub's web page cannot merge a release into the copy, because the copy and this repository share no history, so there is no pull request to open. A terminal in the browser, such as GitHub Codespaces, would also work, but we have not tried it.

Git's own merge does not suit this. With no shared history, Git has no common ancestor, so every file that differs is a conflict, and files the release deleted stay in your copy. These steps copy the release's files instead, and each update works the same way, however many you have skipped.

1. Read the release notes, and note the release's tag, such as `v1.2.3`.
2. Replace your copy's files with the release's:

   ```sh
   git clone <your copy's URL> cloudysuite
   cd cloudysuite
   git fetch --no-tags https://github.com/Setupless/cloudysuite.git tag v1.2.3
   git read-tree -u --reset v1.2.3
   ```

3. Your copy's `wrangler.jsonc` now holds the release's version, which names the release's own resources. Run `git diff --cached HEAD -- wrangler.jsonc`. Lines starting with `-` are your copy's, and lines starting with `+` are the release's.
   - Put back your own `name`, `database_name`, `database_id`, and `bucket_name` by editing `wrangler.jsonc`.
   - Keep every other `+` line, including a binding that the release added, such as a new `kv_namespaces` entry. Cloudflare's [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/) creates a new D1, R2, or KV resource for a binding with no ID when it deploys, and shows the ID in the dashboard only. The release notes say if a release needs anything more. We have not tried this on a real Deploy button copy.
4. Run `git diff --cached --stat HEAD` to see what changes. This step overwrites any edit you made to your copy's own files, so if you made some, add them back.
5. Run `git add -A`, then `git commit -m "Update to v1.2.3"`, then `git push`. Cloudflare builds and deploys your copy, which takes a few minutes.
6. Open the admin's **Organisation** page and check that the version at the bottom is the new one.

To publish a release, set `RUNNING_VERSION` in `apps/auth/src/admin/updates.ts` and tag that commit with the same version.

### Email domains

The app domain and email domains are separate ideas. The app domain, stored as the primary row in `domains`, is where the apps run. An email domain is one that addresses can use. They are often the same domain. When the app domain is a subdomain of another stored domain, such as `suite.example.com` under `example.com`, only the parent is an email domain, so nobody gets an address at the app domain.

An admin adds another email domain by following a guide in their Cloudflare account, because CloudySuite does not store a token. **Check again** looks up the domain's public DNS records over HTTPS, and the domain is saved only once the records for receiving and sending exist. DNS cannot show the catch-all rule that sends mail to the Worker, so the guide says so and asks the admin to send a test message afterwards.

### Simplicity goal

Deploying CloudySuite must take fewer steps and fewer decisions than comparable tools such as [QuickInbox](https://github.com/DivinPrince/quickinbox). That means:

- One mail provider, Cloudflare Email Service, so that the deployer does not choose a provider or follow a separate setup track.
- One Worker, with no queues or other services to configure.
- No terminal commands to deploy. Updating needs Git, as the Updates section says. Dashboard steps are limited to creating the token and any step the API cannot complete, and the wizard links to and verifies each one.
- No CLI, MCP server, chat integrations, or public API in the first release.

### Auth

- Passkeys are the main way to sign in.
- A password with a TOTP authenticator app is the fallback.
- Admins can reset a member's sign-in and require 2FA for the organisation.
- Under the 2FA rule, a passkey counts as the second factor. A person with neither a passkey nor an authenticator app is sent to add one and cannot use any app until they do. A password alone cannot sign in to an account that has only a passkey.
- Resetting a sign-in removes the member's passkeys, authenticator app, password, and sessions, then gives the admin a one-time link to hand over. CloudySuite never emails it, because the member's only address may be a mailbox they cannot open.
- A person's sign-in address is their new mailbox address when the invite creates one, and otherwise the address the invite went to.

Auth uses [Better Auth](https://www.better-auth.com) with its email and password sign-in and the `twoFactor`, `passkey`, and `admin` plugins. CloudySuite adds lost-device recovery, the organisation's 2FA rule, and the invite flow. Mailbox access stays in CloudySuite's own tables.

We use the latest safe version of Better Auth. That is the newest stable release, not an `rc`, `beta`, or `canary`, where no published [security advisory](https://github.com/better-auth/better-auth/security/advisories) affects the features we use. Before you add another Better Auth plugin, read its advisories. `bun audit` alone is not enough: it reported nothing for CVE-2026-53514, which still applies to the `organization` plugin in current releases unless you change its configuration.

### Mail

Mail includes:

- Sending and receiving, threads, search, and attachments.
- Personal mailboxes, shared mailboxes such as `support@`, and aliases.
- Labels and rules.
- Built-in spam filtering, which works without a key (see [Spam filtering](#spam-filtering)).
- A short undo window after sending.
- An installable PWA with web push and offline reading.

Search, labels, and rules work like this:

- **Search** takes Gmail's operators, such as `from:` and `in:trash`, and groups results by conversation. It leaves out Spam and Trash until asked. Search text is parsed into words and never reaches the index as syntax, so no text can cause an error.
- **Labels** belong to a mailbox, so everyone with access sees and manages the same set. A label applies to a whole conversation, and a reply joins the labels of its conversation. A label's list leaves out Spam and Trash, because that mail has been put out of the way. Anyone with access can delete a label, even though only managers edit rules: the deletion takes the label out of any rule that used it, and a rule left with nothing to do turns off.
- **Rules** belong to a mailbox: its managers edit them, and its members can read them. They run on new inbound mail only, never on imported or sent mail, so an import can't re-sort a mailbox's history. Rules run from the top down, every rule that matches applies, and the highest rule that moves a message decides where it goes.
- A rule can't forward mail, because that would make a mailbox an open relay. A rule can't delete permanently, because a bad rule must never lose mail. Its strongest action moves mail to Trash.
- Rules run before spam scoring, and the spam verdict has the last word on the folder. A rule reads a `From` line that anyone can forge, so it must not be a way past the spam filter. A mailbox's allow list is the deliberate way to trust a sender.

Scheduled send and snooze are not in the first release. Native mail apps such as Apple Mail and Outlook are not supported, because they need IMAP and SMTP servers that run outside Workers.

### Spam filtering

Spam filtering works without a Jev key and adds no dependency.

- Each message gets a score from its SPF, DKIM, and DMARC results and a few simple signals in the message.
- Each mailbox has its own block list and allow list.
- Each mailbox learns from the messages its users mark as spam.
- CloudySuite never rejects mail. A message that looks like spam goes to the Spam folder, so a wrong guess loses nothing.

### Mail import

A user can upload an `.mbox` file, such as a Google Takeout export, into a mailbox they manage. Most target teams have little to migrate, so this is the only import source in the first release, and the first feature to cut if the release slips.

1. The browser splits the file into 10 MB parts and sends them to the Worker, which writes them to R2 as a multipart upload. An interrupted upload can resume. The limit is 100 GB, or 10,000 parts.
2. The mailbox's Durable Object records an import job with a byte offset, then works through the file in small batches on its alarm.
3. Each message goes through `ingest`, the same function that handles inbound mail. Imported messages skip rules, spam filtering, and notifications, and they keep their original dates.
4. Each batch saves its messages and the new offset in one SQLite transaction, so a crash resumes from the last saved batch.
5. A hash of each raw message prevents duplicates if a file is imported twice. The import screen lists any message it cannot read.

Some details of how this works:

- The reader treats a file as mboxrd: a line of `>From `, with any number of `>`, loses one `>`. That is exact for mboxrd, and for mboxo it restores every escaped line, at the cost of one `>` on a body line that really began `>From `. Nothing in a file says which format it is.
- A line separates messages only if it starts with `From `, ends in a date, and is followed by a header, so a body line such as `From the desk of` stays in its message.
- A message over the 25 MiB limit is skipped by reading past it, never holding it whole, and listed. So is a final message that the file cuts off, because an export can be downloaded again but a stored half-message looks whole.
- A mailbox runs one import at a time. An upload with no new part for 3 days is removed, ahead of R2's own 7-day clean-up, which would otherwise leave the job pointing at nothing.
- Gmail labels in `X-Gmail-Labels` are not imported yet, and the screen says so.

New import sources add only a reader that yields raw messages. IMAP is the likely next source, because Workers can open outbound TLS connections. Calendar needs `.ics` import when it ships. Storage needs no importer, because upload and WebDAV already move files in.

### Optional Jev integration

An admin can add a [Jev](https://docs.typesafe.ai/introduction) API key to enable better spam scoring and advanced rule conditions. Mail, spam filtering, and rules all work without a key. The first release has no other AI features.

Jev is a third-party service. When an admin enables it, CloudySuite sends message content to that service, and the admin screen must say so before the key is saved.

- CloudySuite calls `POST https://api.typesafe.ai/v1/systemone` with a plain `fetch` and the admin's key as a bearer token. It adds no SDK.
- Jev charges $0.042 per million input tokens, as of November 2026.
- Jev has no fixed retention period. Zero retention is for enterprise customers only. Read the [privacy policy](https://typesafe.ai/legal/privacy-policy) before you enable it.

## Design

CloudySuite uses the Daylight direction, which is calm, neutral, and familiar, with blue for the next action. A left sidebar holds the app switcher and folders, and Mail has a message list beside a reading pane. [The design trial](https://github.com/Setupless/cloudysuite/blob/17574a1/prototypes/look-and-feel/index.html) shows Daylight and the three rejected directions on each screen, in light and dark. It is no longer in the repository, so open that revision for visual reference only.

Appearance follows the device's light or dark setting by default. Setting `data-theme="light"` or `data-theme="dark"` on the `html` element overrides it.

### Change the palette

Every colour lives in [`src/styles/theme.css`](src/styles/theme.css) as a role, such as `--color-accent`, with a light and a dark value. Tailwind turns each role into classes such as `bg-accent` and `text-secondary`, and the theme removes Tailwind's default colours. Editing this one file recolours the whole product.

1. Edit the values in `src/styles/theme.css`. For a new accent colour, change `--color-accent`, `--color-on-accent`, and `--color-selected`.
2. Run `bun scripts/check-theme.mjs`.

The script fails if a text and background pair is below the WCAG AA contrast ratio of 4.5, if a role is missing, or if a file in `src`, `apps`, or `packages` contains a colour value outside the theme file. It does not catch a misspelled class: `bg-acent` builds without an error and renders no colour.

### Load the stylesheet

Import `src/styles/app.css` in the root route with `import "../styles/app.css"`. Do not use `app.css?url` with a `head()` link. In our test, the server and client builds then disagreed on the file name, the first HTML linked a stylesheet that returned 404, and the page stayed unstyled until JavaScript ran.

## Privacy

CloudySuite relies on Cloudflare's encryption at rest. Cloudflare and the organisation's admins are inside the trust boundary, and CloudySuite is not end-to-end encrypted. In exchange, server-side search and rules work without extra steps.

## Cloudflare limits and costs

These limits come from the Cloudflare docs and shape the product:

- Sending to arbitrary recipients requires the Workers Paid plan. It includes 3,000 outbound emails per month, then costs $0.35 per 1,000.
- New accounts start with a low daily sending quota that Cloudflare raises over time.
- Messages have a 25 MiB limit, inbound and outbound, including attachments.
- A message can have at most 50 recipients across to, cc, and bcc.
- A SQLite-backed Durable Object can store up to 10 GB, and a single row can hold up to 2 MB, so large message bodies go in R2.

## Technical direction

- One Worker serves every app and routes by hostname, because the Deploy button does not deploy several Workers from one repository together.
- Each mailbox is one SQLite-backed Durable Object. Attachments go in R2. D1 holds the organisation directory: domains, users, addresses, and mailbox access.
- The rule that every mailbox query checks the signed-in user's access lives in one place, because several people can share a mailbox.

### Repository layout

The repository is a Bun workspace monorepo that builds into the one Worker:

| Path              | Contents                                                     |
| ----------------- | ------------------------------------------------------------ |
| Repository root   | Wrangler config, `build` and `deploy` scripts, D1 migrations |
| `src`             | Worker entry, hostname routing, every route file, and theme  |
| `apps/<app>`      | The UI and server code of one app, such as `apps/mail`       |
| `packages/<name>` | Code that two or more apps share                             |

The Deploy button treats a subdirectory as [the root of the new repository](https://developers.cloudflare.com/workers/platform/deploy-buttons/), and the app inside must be fully isolated. A Worker in `apps/worker` would lose its workspace siblings, so the Worker stays at the root and the button points at the root. The first scaffold must prove this layout with a real Deploy button run.

### Local development

One Worker routes every app by hostname, and agents run in parallel worktrees. Each checkout needs its own stable app hostnames, without port numbers. [portless](https://github.com/vercel-labs/portless) provides them.

The first `bun run dev` asks for `sudo` to bind port 443 and trust a local certificate. It starts the proxy with wildcard routing, because `auth` and `mail` share one Vite server.

A proxy that is already running without wildcard routing returns a portless 404 for both apps. Run `bunx portless proxy stop`, then start again.

`bunx vite dev` skips portless and serves the same hostnames on port 5173.

To try the setup wizard without a Cloudflare account, use the fake API in `apps/auth/scripts/fake-cloudflare.ts`:

1. Remove `.wrangler/state`, then write `CLOUDYSUITE_LOCAL_CLOUDFLARE_API=http://127.0.0.1:8799/client/v4` as the only line in `.dev.vars`.
2. Run `bun apps/auth/scripts/fake-cloudflare.ts`, then `bun run build`, `bun run db:migrate:local`, and `bunx wrangler dev`.
3. Open `http://localhost:8787` and paste `owner-token-owner-token-owner-token`. The script also has a stranger's token and a read-only token.
4. When the wizard waits for its new secret, restart `wrangler dev`. A real Worker restarts by itself.

The wizard ignores that variable unless it names a loopback address, so it cannot send a token elsewhere. It comes from the environment, so a request cannot set it.

Sign-in needs a secret. Run `cp dev.vars.local.example .dev.vars` once in each checkout, then `bun run db:migrate:local`, `bun run db:seed:local`, and `bun run db:seed:user:local <email> <password>` to get an account. A deployment does not use this file: the setup wizard generates its secret.

## Git and CI

`main` is what the Deploy button copies, so it must always be deployable. We use one long-lived branch, `main`, and short-lived branches that merge through a PR. A `develop` branch would add a second state to keep healthy, and deployers would never see it.

A ruleset on `main` blocks direct pushes, force pushes, and deletion. It requires a PR, a passing `check` job, and resolved review threads. Squash is the only merge method, so each PR becomes one commit on `main`, and the PR title becomes the commit subject. The ruleset needs no approving review while one person maintains the project. [`.github/rulesets/main.json`](.github/rulesets/main.json) defines the ruleset.

GitHub Free applies rulesets only to public repositories, so this repository must stay public or move to a paid plan.

The `check` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `bun run check` and checks the format of the branch name and the PR title.

## Tech stack

We build around the TanStack libraries, so that the product is fast for end users and pleasant for developers. We accept release candidates because we expect them to be stable before our first release. Better Auth is the exception, as [Auth](#auth) explains.

- TanStack Start, Query, Form, Hotkeys, and DB
- Tailwind CSS v4
- Drizzle RC
- Better Auth, on its latest safe stable release
- Bun as the package manager, workspace manager, script runner, test runner (`bun test`), and formatter (`bun fmt`)
- oxc for linting
- Tabler icons
- postal-mime, to parse raw messages. Writing a MIME parser by hand is error-prone, and this one runs on Workers.
- Web push uses WebCrypto, with no library.
- portless for named local development URLs. It needs Node 24 or later and is a development tool only.

Bun is a development tool here. Production code runs on the Workers runtime, so it cannot use Bun-specific APIs. `bun test` also runs on Bun, so a passing test does not prove behaviour that depends on the Workers runtime, such as Durable Objects or the `email()` handler. Run that behaviour on the Workers runtime as well.

## Open questions

- Which wizard steps work through the API with one token, which permissions does that token need, and which steps need a guide instead?
- Does Cloudflare allow person-to-person mailbox mail on Email Service? Its [FAQ](https://developers.cloudflare.com/email-service/reference/faq/) answers "Can I use Email Service for marketing emails?" with "No. Email Service supports transactional email only." It does not say whether mailbox mail is allowed. Confirm with Cloudflare before the public release.
- Should an admin also be able to turn an app off for one person or group? The first release turns an app off for the whole organisation.

## License

AGPL-3.0. Anyone can self-host CloudySuite. Anyone who runs a modified hosted copy must share their changes.
