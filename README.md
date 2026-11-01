# CloudySuite

As close as you can get to Google, on Cloudflare, with your own domains.

CloudySuite is an open source workspace for small organisations. One technical person deploys it to the organisation's Cloudflare account. Everyone else signs in and uses clean, fast apps for mail, calendar, and storage.

**Status:** planning. This repository contains no application code yet, so this README describes the intended product.

## Apps

Each app has its own subdomain on the organisation's primary domain.

| Address                | Purpose                                     | Replaces                 | Release |
| ---------------------- | ------------------------------------------- | ------------------------ | ------- |
| `auth.example.com`     | Organisation, accounts, and email addresses | Google Admin and Account | First   |
| `mail.example.com`     | Mailboxes                                   | Gmail                    | First   |
| `calendar.example.com` | Calendars, also synced over CalDAV          | Google Calendar          | Later   |
| `storage.example.com`  | Files, also synced over WebDAV              | Google Drive             | Later   |

Later ideas include a password manager, docs, and sheets.

## Who it is for

CloudySuite is for small companies and open source teams of about 2 to 100 people that do not yet have a cloud suite. One technical person deploys it. The people who use it every day do not need technical knowledge. We follow Apple's "it just works" philosophy.

One deployment serves one organisation. That organisation can use several email domains and aliases. Two organisations use two deployments in separate Cloudflare accounts, so they share no data.

## First release

The first release contains Auth and Mail. Mail must be good enough to replace Gmail for daily use before work on the other apps starts.

### Deployment

You need a domain on Cloudflare DNS and the Workers Paid plan. The wizard links to the Cloudflare guide for each if you do not have them. You do not need Bun, Wrangler, or any other local tool.

1. Click the **Deploy to Cloudflare** button. It creates the Worker and its storage, and applies the database migrations.
2. Open the Worker's URL to start the first-run wizard.
3. Create an API token from the wizard's link, which pre-fills the token form, and paste the token into the wizard.
4. Choose your domain. The wizard enables Email Routing and Email Sending, points the catch-all rule at the Worker, and attaches the `auth` and `mail` hostnames.
5. Create the first admin account.

The wizard calls the Cloudflare API from the Worker. It does not store the token. Only someone who holds a token for the Worker's account can finish setup, so a stranger who finds a new deployment's URL cannot claim the admin account.

Each wizard step checks the current state in Cloudflare, applies the change through the API, and checks again. If the API cannot complete a step, the wizard shows the exact action to take, a link to that Cloudflare dashboard page, and a link to the Cloudflare docs. The admin completes the action and clicks **Check again**, so the wizard never assumes that a manual step worked.

### Simplicity goal

Deploying CloudySuite must take fewer steps and fewer decisions than comparable tools such as [QuickInbox](https://github.com/DivinPrince/quickinbox). That means:

- One mail provider, Cloudflare Email Service, so that the deployer does not choose a provider or follow a separate setup track.
- One Worker, with no queues or other services to configure.
- No terminal commands. Dashboard steps are limited to creating the token and any step the API cannot complete, and the wizard links to and verifies each one.
- No CLI, MCP server, chat integrations, or public API in the first release.

### Auth

- Passkeys are the main way to sign in.
- A password with a TOTP authenticator app is the fallback.
- Admins can reset a member's sign-in and require 2FA for the organisation.

Auth uses [Better Auth](https://www.better-auth.com) with its email and password sign-in and the `twoFactor`, `passkey`, and `admin` plugins. CloudySuite adds lost-device recovery, the organisation's 2FA rule, and the invite flow. Mailbox access stays in CloudySuite's own tables.

We use the latest safe version of Better Auth. That is the newest stable release, not an `rc`, `beta`, or `canary`, where no published [security advisory](https://github.com/better-auth/better-auth/security/advisories) affects the features we use. Before you add another Better Auth plugin, read its advisories. `bun audit` alone is not enough: it reported nothing for CVE-2026-53514, which still applies to the `organization` plugin in current releases unless you change its configuration.

### Mail

Mail includes:

- Sending and receiving, threads, search, and attachments.
- Personal mailboxes, shared mailboxes such as `support@`, and aliases.
- Labels and rules.
- Built-in spam filtering.
- A short undo window after sending.
- An installable PWA with web push and offline reading.

Scheduled send and snooze are not in the first release. Native mail apps such as Apple Mail and Outlook are not supported, because they need IMAP and SMTP servers that run outside Workers.

### Mail import

A user can upload an `.mbox` file, such as a Google Takeout export, into a mailbox they manage. Most target teams have little to migrate, so this is the only import source in the first release, and the first feature to cut if the release slips.

1. The browser splits the file into 10 MB parts and sends them to the Worker, which writes them to R2 as a multipart upload. An interrupted upload can resume. The limit is 100 GB, or 10,000 parts.
2. The mailbox's Durable Object records an import job with a byte offset, then works through the file in small batches on its alarm.
3. Each message goes through `ingest`, the same function that handles inbound mail. Imported messages skip rules, spam filtering, and notifications, and they keep their original dates.
4. Each batch saves its messages and the new offset in one SQLite transaction, so a crash resumes from the last saved batch.
5. A hash of each raw message prevents duplicates if a file is imported twice. The import screen lists any message it cannot read.

New import sources add only a reader that yields raw messages. IMAP is the likely next source, because Workers can open outbound TLS connections. Calendar needs `.ics` import when it ships. Storage needs no importer, because upload and WebDAV already move files in.

### Optional Jev integration

An admin can add a [Jev](https://docs.typesafe.ai/introduction) API key to enable better spam scoring and advanced rule conditions. Mail, spam filtering, and rules all work without a key. The first release has no other AI features.

Jev is a third-party service. When an admin enables it, CloudySuite sends message content to that service, and the admin screen must say so before the key is saved.

## Design

CloudySuite uses the Daylight direction, which is calm, neutral, and familiar, with blue for the next action. A left sidebar holds the app switcher and folders, and Mail has a message list beside a reading pane. [The Daylight prototype](prototypes/look-and-feel/index.html) shows each screen in light and dark, and it is a visual reference only.

Appearance follows the device's light or dark setting by default. Setting `data-theme="light"` or `data-theme="dark"` on the `html` element overrides it.

### Change the palette

Every colour lives in [`src/styles/theme.css`](src/styles/theme.css) as a role, such as `--color-accent`, with a light and a dark value. Tailwind turns each role into classes such as `bg-accent` and `text-secondary`, and the theme removes Tailwind's default colours. Editing this one file recolours the whole product.

1. Edit the values in `src/styles/theme.css`. For a new accent colour, change `--color-accent`, `--color-on-accent`, and `--color-selected`.
2. Run `bun scripts/check-theme.mjs`.

The script fails if a text and background pair is below the WCAG AA contrast ratio of 4.5, if a role is missing, or if a file in `src` contains a colour value outside the theme file. It does not catch a misspelled class: `bg-acent` builds without an error and renders no colour.

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

## Tech stack

We build around the TanStack libraries, so that the product is fast for end users and pleasant for developers. We use RC's under the thought that by the time we release, they will more than likely be stable.

- TanStack Start, Query, Form, Hotkeys, and DB
- Tailwind CSS v4
- Drizzle RC
- Bun as the package manager, script runner, and formatter (`bun fmt`)
- oxc for linting
- Tabler icons

Bun is a development tool here. Production code runs on the Workers runtime, so it cannot use Bun-specific APIs.

## Open questions

- Which wizard steps work through the API with one token, which permissions does that token need, and which steps need a guide instead?
- How do updates reach a deployment? The Deploy button copies the repository into the deployer's GitHub account, and Better Auth security patches must reach every copy.
- What does built-in spam filtering use when no Jev key is set?
- What are Jev's API, pricing, and data-retention terms?

## License

AGPL-3.0. Anyone can self-host CloudySuite. Anyone who runs a modified hosted copy must share their changes.
