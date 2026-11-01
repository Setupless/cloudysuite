# Agent instructions

[README.md](README.md) holds product decisions and their reasons. Read the sections for the area you change. A rule below overrides your defaults and habits.

## Commands

- `bun fmt` formats the code.
- `bun run check` runs every CI check except the PR format check, including the production build and `tsc`.
- `bun run dev` serves `https://auth.cloudysuite.localhost` and `https://mail.cloudysuite.localhost` through portless and Vite. In a linked worktree, the branch name goes before `cloudysuite`, such as `https://auth.my-branch.cloudysuite.localhost`.
- `bun run build && bunx wrangler dev` serves the production build on the Workers runtime. It uses those same hostnames on port 8787 over `http`, such as `http://auth.cloudysuite.localhost:8787`.
- `curl -X POST --data-binary @message.eml 'http://localhost:8787/cdn-cgi/handler/email?from=a@example.org&to=b@localhost'` sends inbound mail to `wrangler dev`.
- `bun run db:generate` writes a migration. `bun run db:migrate:local` applies it, and `bun run db:seed:local` stores this checkout's portless hostname as the primary domain. Run it again after a worktree's branch changes name.
- `PR_BRANCH=<branch> PR_TITLE=<title> bun scripts/check-pr.mjs` runs the PR format check.
- `cp dev.vars.local.example .dev.vars` gives this checkout the local `BETTER_AUTH_SECRET`. `bun run db:seed:user:local <email> <password> [admin|user]` adds a local sign-in.
- `bun test` runs the tests on Bun, not on the Workers runtime.
- `bun scripts/check-theme.mjs` checks the palette and fails on a raw colour or `app.css?url` in `src`, `apps`, or `packages`.

## Git

- Start each change on a new branch from an up-to-date `main`. Never commit to `main`.
- Name the branch `<type>/<short-name>`, and write the PR title as `<type>(<app>): <summary>`, with the scope optional. `scripts/check-pr.mjs` lists the types.
- Keep one change in each PR. Use a separate worktree when another agent works in the same checkout.
- Open a PR with `gh pr create`, state why the change exists and how you tested it, then wait for CI. A red check is your task to fix.
- Merge only when the user asks, with `gh pr merge --squash --delete-branch`.
- Do not bypass a check, push with force to a branch that another person uses, or edit `.github/rulesets` or `.github/workflows` without being asked.

## Stop and ask

Do not guess or build around these. Ask the user first.

- The task conflicts with a rule here or a decision in the README.
- The task touches an item in the README's "Open questions".
- The task needs a dependency outside the README's tech stack, or another Better Auth plugin, Cloudflare service, or Worker. Installing the listed stack does not need approval.
- The task needs a destructive data migration.

## Scope

- The first release contains Auth and Mail only.
- Do not add a CLI, MCP server, chat integration, public API, or AI feature. Jev is the one exception, and every feature must work without a Jev key.
- Do not add IMAP or SMTP servers. They cannot run on Workers.
- Build what the task asks for. Do not add options, abstractions, or fallbacks that no current caller needs.

## Before you write code

- Define the data shape and types first.
- Check a library's API in its installed version or current docs, not from memory. This stack moves quickly and includes release candidates.

## Architecture

- One Worker serves every app and routes by hostname.
- The Worker's config, entry, and TanStack Start routes stay at the repository root, because the Deploy button needs them there. Each app's code goes in `apps/<app>`, and shared code goes in `packages/<name>`.
- Route files in `src/routes/<app>` only render components from `apps/<app>`. `src/router.tsx` adds that prefix from the hostname.
- The hostname router checks that an app is on before it handles any request. Inbound mail still reaches `ingest` when Mail is off.
- Production code runs on Workers, so it cannot use Bun APIs.
- Each mailbox is one SQLite-backed Durable Object. A row can hold 2 MB, so large bodies and attachments go in R2.
- D1 holds domains, users, addresses, and mailbox access.
- Every mailbox read and write goes through one access-check function.
- Every message enters a mailbox through `ingest`, including imports.
- Durable Object alarms handle background work. Do not add Queues or Workflows.
- Make jobs safe to repeat. A retry must not duplicate messages or skip work.

## Auth and security

- Use the latest stable Better Auth release that no published advisory affects for the features we use. Do not use `rc`, `beta`, or `canary` releases of Better Auth.
- Sign-in features are limited to email and password plus the `twoFactor`, `passkey`, and `admin` plugins. `tanstackStartCookies` is allowed because it is a cookie adapter that adds no sign-in method.
- Keep the session cookie cache off.
- A user who loses a device can sign in with another passkey or a TOTP backup code. Otherwise an admin resets their sign-in. Do not add magic links or email recovery.
- Invites use a single-use token sent to the invited address. A matching email string does not prove ownership.
- Read the domain from stored settings, never from the `Host` header.
- Use the Cloudflare API token during setup only. Never store or log it.
- Render email HTML in a sandbox. Treat all message content as hostile.

## UI

- Follow the Daylight direction in the README's Design section. Do not copy code from the design trial it links to.
- Use only the colour roles in `src/styles/theme.css`, through classes such as `bg-accent`. Add or change a colour only in that file.
- Misspelled Tailwind classes build without an error, so check that each class has an effect.
- Load `app.css` with `import "../styles/app.css"` in the root route.
- Use Tabler icons.
- Write UI text for non-technical users. Say what happened and what to do next, with no jargon.

## Code

- Comment only a non-obvious reason that the code cannot show.
- Test behaviour that users can observe, not internals.

## Definition of done

1. Run `bun fmt` and `bun run check`.
2. Run the change, and do not rely on a passing build alone.
   - Run Worker behaviour on the Workers runtime. `vite dev` does not run the inbound `email()` handler.
   - For a page, confirm that the first HTML response links CSS that returns 200, then view the page in light and dark.
3. Open a PR and wait for CI to pass.
4. Report what you ran and the result, and name anything you did not verify. Do not write "verified" or "works" without that evidence.

## Change this file

Add a rule only if an agent would otherwise get it wrong. If a script can enforce a rule, write the script and delete the rule. Keep this file under 100 lines.
