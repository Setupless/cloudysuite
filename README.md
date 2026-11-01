# CloudySuite

As close as you can get to Google, on Cloudflare, with your own domains.

CloudySuite is an open source workspace for small organisations. One technical person deploys it to the organisation's Cloudflare account. Everyone else signs in and uses clean, fast apps for mail, calendar, and storage.

**Status:** not released yet. Auth and Mail are built, and Storage has its first part: team folders, My files, uploading, and downloading. This README describes the intended product and says where something is not built yet.

## Who it is for

CloudySuite is for small companies and open source teams of about 2 to 100 people that do not yet have a cloud suite. One technical person deploys it. The people who use it every day do not need technical knowledge. We follow Apple's "it just works" philosophy.

One deployment serves one organisation. That organisation can use several email domains and aliases. Two organisations use two deployments in separate Cloudflare accounts, so they share no data.

## Apps

Each app has its own subdomain on the organisation's primary domain.

| Address                | Purpose                                     | Replaces                 | Release |
| ---------------------- | ------------------------------------------- | ------------------------ | ------- |
| `auth.example.com`     | Organisation, accounts, and email addresses | Google Admin and Account | First   |
| `mail.example.com`     | Mailboxes                                   | Gmail                    | First   |
| `storage.example.com`  | Files                                       | Google Drive             | First   |
| `calendar.example.com` | Calendars, also synced over CalDAV          | Google Calendar          | Later   |

Later ideas include a password manager, docs, and sheets.

### Turn an app off

Every deployment contains every released app. An admin can turn each app off for the whole organisation, for example when the organisation keeps another mail provider.

- A person who opens a turned-off app sees a page that says an admin turned it off, with a link to Account. The app also leaves the app switcher.
- The hostname router makes this check on the server for every request, so hiding the link is never the only protection.
- Turning an app off deletes nothing. Turning it back on restores everything.
- Inbound mail still reaches the mailbox while Mail is off, because a bounced message cannot be recovered later.
- The only other exception is a `GET` of `/pwa/session` on the Mail host. It returns a user id or a 401 and no mail, so a device can clear saved mail when someone signs out with Mail off.
- Auth cannot be turned off, because admins use it to turn the other apps back on.

D1 stores the setting as one row for each app that can be turned off, and a missing row means the app is on:

```ts
type ToggleableApp = "mail" | "storage";
type AppSetting = { app: ToggleableApp; enabled: boolean };
```

The `APPS` registry in `src/routing.ts` defines `ToggleableApp`, so the type grows when Calendar ships.

## First release

The first release contains Auth, Mail, and Storage, and it waits for all three. Mail was built first, because it had to be good enough to replace Gmail for daily use before work on another app started. Calendar comes after the first release.

### Deployment

You need a domain on Cloudflare DNS and the Workers Paid plan. The wizard links to the Cloudflare guide for each if you do not have them. You do not need Bun, Wrangler, or any other local tool.

1. Click the **Deploy to Cloudflare** button. It creates the Worker and its storage, and applies the database migrations.
2. Open the Worker's URL to start the first-run wizard.
3. Create an API token from the wizard's link, which pre-fills the token form, and paste the token into the wizard.
4. Choose your domain and where your apps should live. The wizard checks the domain's DNS and explains its recommendation.
5. The wizard enables Email Routing and Email Sending, points the catch-all rule at the Worker, attaches the `auth`, `mail`, and `storage` hostnames, and generates the sign-in secret. Turning on Email Sending makes Cloudflare add DNS records to your domain itself: `cf-bounce` MX and SPF, a DKIM key, and `_dmarc` with `v=DMARC1; p=reject;`. That last record tells other mail systems to refuse mail that claims to be from your domain but cannot prove it, so check that any other service sending as your domain signs its mail. The wizard never changes a DMARC record you already have.
6. Create the first admin account, which also gets a personal mailbox. The wizard then sends you to `auth.<app domain>`.

The wizard calls the Cloudflare API from the Worker. It does not store the token: the token stays in the browser tab, and each call sends it again.

Only someone who holds a token for the Worker's account can finish setup, so a stranger who finds a new deployment's URL cannot claim the admin account. Every call proves two things with the pasted token:

- **The token's account owns this Worker.** The Worker reads its running version id from its `version_metadata` binding, and Cloudflare must confirm that version exists on a script in the token's account. Cloudflare generates that id, so nobody can recreate it in another account. The check reads the id on every call, so it still holds after setting a secret starts a new version. This is also how the Worker learns its own script name.
- **The token can change this Worker.** Read access alone is not enough, so the wizard reads `.../script-settings` and sends the same values back in a `PATCH`, which changes nothing but needs Workers Scripts Edit. A run against real Cloudflare confirmed this: the settings were the same afterwards and no new version appeared. If Cloudflare returns no settings to send back, the proof fails and the wizard writes nothing.

Until both proofs pass, the caller could be anyone, so errors from Cloudflare reach them only as a plain message. After that, the wizard shows Cloudflare's own words.

Each wizard step checks the current state in Cloudflare, applies the change through the API, and checks again. If the API cannot complete a step, the wizard shows the exact action to take, a link to that Cloudflare dashboard page, and a link to the Cloudflare docs. The admin completes the action and clicks **Check again**, so the wizard never assumes that a manual step worked. The wizard never deletes a DNS record, so existing MX records and conflicting hostnames are always manual steps.

The wizard never replaces mail routing that is in use without asking. If an enabled catch-all rule forwards mail, deletes it, or sends it to another Worker, the wizard says so in plain language and waits. The server replaces the rule only when the request repeats the description the person saw, so a rule that changed in the meantime is shown again. A disabled rule carries no mail, so the wizard replaces it without asking.

The catch-all goes live before the first admin's address exists. Until setup finishes, the Worker rejects mail for every address at the domain, so a sender gets a bounce saying there is no mailbox there, and no message is lost silently.

The primary domain is stored last, in one atomic batch with the admin's user, password, mailbox, address, and access. The database allows one primary domain, so when two people finish at once, exactly one wins and the other leaves nothing behind. Until then, the router keeps every hostname on `/setup` and nobody can sign in, so an interrupted setup can always resume. Afterwards the router sends `/setup` away on an app hostname and treats the `workers.dev` hostname as unknown, so nobody can run the wizard again.

#### App domain and email domain

These are separate, and either may be the zone apex:

| Domain       | What it is                                                    | Stored as                                   |
| ------------ | ------------------------------------------------------------- | ------------------------------------------- |
| App domain   | Parent of each app's address, and the session cookie's domain | The `domains` row with `is_primary = 1`     |
| Email domain | What follows `@` in addresses                                 | A `domains` row, used by `addresses.domain` |

The session cookie covers the app domain and every site under it, so whoever runs any site there could read a signed-in person's cookie. The wizard scans the zone's DNS and custom domains for that reason. A name counts as CloudySuite's own only when Cloudflare says it is a custom domain attached to this Worker, and anything else counts as another site, even `auth`, `mail`, or `storage`:

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
- A session lasts 60 days and renews when it is used, at most once a day, so each session costs at most one database write a day. Someone who opens Mail now and then stays signed in and keeps getting notifications, which need a live session. Renewal happens on any request that reads the session, including Mail's, and someone unused for 60 days signs in again. A tab nobody is looking at makes no requests, so it can't keep a session alive. The session cookie cache stays off, so a sign-out or reset takes effect at once.
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

How sending behaves, and why:

- **Undo.** Send waits 10 seconds on the server, so closing the tab can't lose the message, and Undo still works after a reload. Undo returns it to a draft.
- **A send is never repeated by guesswork.** A clean refusal says what to do. Only a rate limit retries by itself. If a crash or a lost connection leaves it unclear whether a message went out, the person is told to check with the recipient. A duplicate is worse than asking.
- **A message that can't settle right away never floats over the mail.** A failure, or a wait to retry, sits in a band above the mail, one at a time, with a count of the rest. Only the seconds just after pressing Send float, because they're gone within moments.
- **A queued message is checked again before each attempt.** Minutes can pass between pressing Send and the message going out, including rate-limit retries. If its From address has left the mailbox, the person who pressed Send has lost access or been banned, or Mail was turned off, it doesn't go, and it stays in Drafts with a plain reason. If the directory can't answer, the job waits and tries again, then fails the same way. It never sends without an answer.
- **Drafts are not messages.** They autosave to their own table, so saving can't fill the mailbox and search or Trash never finds half-written mail. In a shared mailbox, the last save wins and that person is told. Moving to another list or conversation closes the editor and keeps the draft, and a short notice offers the way back.
- **Quoted mail stays in the sandboxed reading frame.** A stranger's markup never joins the editor, so a reply can leave the original out but can't edit inside it.
- **A message to your own address appears twice, threaded together: once in Sent and once in the Inbox.** A header on inbound mail is never a reason to drop it, because anyone can copy one. Only byte-identical redelivery counts as a duplicate.
- **Attachments can add up to about 18 MB.** The 25 MiB limit counts the encoded message, and files grow by about a third in email.

Scheduled send and snooze are not in the first release. Native mail apps such as Apple Mail and Outlook are not supported, because they need IMAP and SMTP servers that run outside Workers.

### The installable app

Mail installs from its own host as a PWA. The **App and notifications** page in Mail's menu holds the install button, and on Apple devices, which have no install prompt, the steps in words.

**The rule that shapes everything: no person's mail is in Cache Storage.** The service worker saves only the public build and one anonymous page, `/offline-shell`, which renders nothing on the server. Pages that hold mail are never saved. Every saved message is in one IndexedDB database, so clearing a device means deleting that database, and there is nothing else to track.

- **Pages** go to the network first. With no connection, the service worker serves the anonymous page at the address asked for, and the client loads that address's routes itself. A new deployment therefore cannot leave stale HTML linking a dead stylesheet.
- **Everything else** that is not a hashed build file or a listed public file passes straight through, including sign-in, server functions, and downloads.
- **Updates.** `sw.js` lists the build's exact file names, so any change to them changes it. A new worker installs, takes over, and deletes the old files. A plain file serves it, outside the Worker, so a fixed worker reaches a browser even when an old one answers every request with an error. The browser checks `sw.js` itself on each page load, with no page code involved.

**What is saved:** for each mailbox, up to 300 inbox, 100 sent, and 100 archived conversations, each body up to 256 KB, and up to 50 MB in total. Attachments, Spam, Trash, Drafts, and labels are not saved. Search, label lists, and rules need a connection, and say so when there is none. Bodies come through the same `renderBody` as reading online, so only sanitized HTML is ever stored, and it shows in the same sandboxed frame.

**Why a small hand-written store.** TanStack DB's browser persistence needs `@journeyapps/wa-sqlite`, a dependency outside this stack, and uses SQLite rather than IndexedDB. Query's persister rewrites one blob holding everything on each save, 15.7 MB in our test against one record here. The speed gap was small, 14 ms against under 1 ms. What decided it is safety: here, the check of who owns the device and the write share one transaction, so a tab finishing a refresh cannot put the last person's mail back after a sign-out cleared it.

**While offline, actions are refused** in plain words, never queued. Someone who archives a message on a train should not be surprised by what runs when the train arrives. Opening a message offline leaves it unread.

**A device is cleared when:**

| What happened                         | What notices                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Signing out                           | The sign-out page sends the browser through Mail's `/device-cleared`            |
| A session ending elsewhere            | The service worker asks who is signed in on each page load, with no page code   |
| A tab left open when a session ends   | Its next call gets a 401, once someone is looking at the tab                    |
| Someone else signing in               | The same check, and the page, comparing against the device's owner              |
| 59 days with no check from the server | Offline, saved mail stops opening, because the session could have ended by then |

Sign-out happens on Account's host, which cannot reach Mail's storage, so it has to pass through Mail's. `/device-cleared` is a plain file, so this also works while Mail is off.

Anyone can link to `/device-cleared`, so opening it never clears anything for a person who might still be signed in. It clears only when the server says nobody is signed in, or when the device's own last check is past the 59 days, which is a session's 60 days less the day a renewal can lag. With no answer from the server, it changes nothing, says so, and offers a button. That button is how someone offline signs out of a shared computer.

Turning Mail off clears nothing, so turning it back on restores the same device. Sign-out and a session ending elsewhere still clear it, because a `GET` of `/pwa/session` is the one Mail request that gets an answer while Mail is off. It returns a person's id or a 401, and no mail.

**A tab nobody is looking at makes no requests.** Each request renews the session, so a forgotten background tab would otherwise keep someone signed in forever. Timed refreshes, saving mail for offline, and reconnecting all wait until the tab is visible again, then catch up at once. A visible tab counts as use, even with nobody at the screen.

**An open tab refreshes every 30 seconds, with no websockets.** That covers the list, the sidebar's counts, and the open conversation, which is three requests every 30 seconds, plus one a minute for drafts and sends in progress: 7 requests a minute for each visible tab, and about 3,400 in an 8-hour day. A list scrolled past its first page costs one more request a page. Opening a folder or a conversation asks the server straight away, so what it shows is fresh even if the timer hasn't fired. The same refresh is how a tab finds out that its session has ended: its next request gets a 401, the device clears, and the browser goes to Sign in.

**Writing needs a connection.** Offline, Write, Reply, and Forward say so and open nothing, and Send is refused and never queued. A draft already open stays on screen and saves when the connection returns, but it is never sent then. A message already handed to CloudySuite still goes, and Undo comes back with the connection. Drafts are not saved on the device.

[Privacy](#privacy) says what saved mail means for a lost device.

### Notifications

A person turns notifications on for each device and can turn off any mailbox they share. A notification goes out for inbound mail that lands in the inbox, and never for imported mail, sent mail, or Spam. It carries the sender and subject, encrypted so that the push service cannot read them.

- **Web push is hand-written** with WebCrypto: RFC 8291 to encrypt and RFC 8292 to sign. A test checks it against RFC 8291's published message, byte for byte. The organisation's signing keys are made once, on first use.
- **Only known push services.** A browser supplies its own endpoint and the Worker later sends a request to it, so an open list would let anyone signed in aim the Worker at any URL. `apps/mail/src/push/endpoint.ts` lists the hosts. Chromium handed out `jmt17.google.com` on 2026-11-01, which Google's documents do not name, so a browser could start using a host this list lacks. It then shows a plain failure, and the fix is one line.
- **Access is checked when sending,** not when queuing, through the one access check. A person also needs a live session somewhere, so someone who signed out everywhere or was reset hears nothing, and neither does someone who has not used CloudySuite on any device for 60 days, because their session has ended.
- **A flood stays small.** A device gets at most one notification every 30 seconds. The first message after a quiet spell goes at once, and the rest become one summary with no sender or subject. An alarm sends at most 50, and a device only ever owes its newest notice, so the queue cannot grow.
- **Hostile text.** The service worker treats the decrypted message as hostile. A click opens a path built only from checked ids, on Mail's own host.
- **Mail turned off** still stores inbound mail but tells nobody, then or later.

**Not tested on Safari or an iPhone.** iPhone web push needs the app installed on the Home Screen first, and a real-device check is owed before release.

### Spam filtering

Spam filtering works without a Jev key and adds no dependency.

- Each message gets a score from its SPF, DKIM, and DMARC results and a few simple signals in the message.
- Each mailbox has its own block list and allow list.
- Each mailbox learns from the messages its users mark as spam.
- CloudySuite never rejects mail. A message that looks like spam goes to the Spam folder, so a wrong guess loses nothing.

Some details of how this works:

- A failed DMARC check decides alone only when the sender's domain says failing mail isn't theirs, with a policy of `quarantine` or `reject`. This includes a mailing list that breaks such a domain's check, so some real mail lands in Spam this way. With `p=none` or no stated policy it is one small sign, because half-set records and mailing lists fail this way all the time and Cloudflare turns mail away only when the policy says to. Cloudflare's first `Authentication-Results` header is the only one read, because anything below it is the sender's to forge.
- Every other signal is something real mail also does, so it takes several together: a name showing another address, replies going to another site, a link whose text names another site, a program file from a stranger, a subject in capitals, and a broken SPF or DKIM result. Only a pass for the `From` domain cancels a failed SPF result. A signature for some other domain says nothing, because anyone can sign for their own domain.
- A reply to mail this mailbox sent counts strongly for a message, going by a `Message-ID` this mailbox wrote in its `In-Reply-To` or `References`. It outweighs several odd signs. It doesn't outweigh the block list or an enforcing DMARC policy, because a `Message-ID` can leak.
- With an optional Jev key, the built-in score can get one more signal for mail it's unsure about. See [Optional Jev integration](#optional-jev-integration).
- Spam shows why a message is there, in plain words, from the reasons stored when it was filed.
- Rules run first, so their labels and stars still apply, and the verdict has the last word on the folder. Imported and sent mail skip the filter and teach it nothing, unless a person marks that mail themselves.
- An allow list entry and "Not spam" both mean a person trusts a sender, so that sender's later mail stays out of Spam unless the message shows clear signs of forgery. A message that proves its sender always stays out: DMARC passed, which means aligned with the `From` domain by definition, or DKIM passed for that domain or a parent of it. A message that can't prove its sender goes to Spam only with one of these:
  - DMARC failed under a `quarantine` or `reject` policy, or the `From` line holds more than one address.
  - A check failed, and there is also a misleading link, a name showing another address, or a program file.

  A misleading link with no failed check gets the normal score instead, because click tracking looks the same. Everything else stays in the Inbox, including a `p=none` failure, where a forgery and real mail can't be told apart. So a forger who copies a trusted address at a domain that enforces nothing, and writes plain text, reaches the Inbox. We accept that, because real mail in Spam is the worse mistake.

- "Not spam" trusts that one address, for everyone using the mailbox. What that message's links and name showed, and where they really pointed, stop counting as evidence for that one address, or every issue of a newsletter with broken checks would land back in Spam. Both halves are remembered, because a click-tracking host is shared by many senders and a From line is easy to forge. So a link that shows a different site, even through the same tracking host, still counts, and a newsletter whose links name a new site can land back in Spam until someone marks it again. "Mark as spam" takes the trust back, and undoing the mark restores it. The block list isn't changed by "Not spam", so a sender still on it stays in Spam.
- An allowed domain also covers mail it signs with DKIM and mail whose `List-Id` is under it, so a mailing list can be allowed. A signature is that domain's word, so a signed post lands in the Inbox whatever its author's domain says about DMARC. `List-Id` is only a claim anyone can write, so it is treated like a `From` line.
- The block list goes by the `From` line and covers subdomains. The narrowest entry decides, so one trusted address can sit inside a blocked domain. A shared ending such as `co.uk` can't be listed, because it covers unrelated companies. That comes from a short list, not the public suffix list, so a rarer shared ending can still be entered. Anyone with access can read the lists and mark mail. Only a manager can change the lists, because the allow list decides what the whole mailbox sees.
- "Mark as spam" and "Not spam" teach a small word-count model, one per mailbox, in the same transaction as the move. It reads the first 32 KB of a message, holds at most 20,000 hashed words, and forgets the weakest first. Undo, or "Not spam" on a message someone marked, leaves the counts as they were before. It stays off until 5 messages are marked as spam, or 3 as not spam.
- The model files a message only when at least 85% of its words are in the marked mail and they lean clearly towards spam, so it catches repeats of what people marked and little else. One "Not spam" outweighs many marks of the same kind. It never files a sender this mailbox already deals with who proves who they are, unless someone marks that sender as spam.

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

New import sources add only a reader that yields raw messages. IMAP is the likely next source, because Workers can open outbound TLS connections. Calendar needs `.ics` import when it ships. Storage needs no importer, because uploading moves files in, and WebDAV will too once it is built.

### Optional Jev integration

An admin can add a [Jev](https://docs.typesafe.ai/introduction) API key to improve spam filtering and let a rule match a description, such as "looks like an invoice". Mail, spam filtering, and rules all work without a key, and with no key nothing goes to Jev. The first release has no other AI features.

Jev is a third-party service. When an admin adds a key, CloudySuite sends message content to that service. The Organisation page says so before the key can be saved, and the server refuses a save without the admin's acknowledgement.

- Jev keeps data for as long as it considers necessary, with no fixed period, and offers zero retention to enterprise customers. Read the [privacy policy](https://typesafe.ai/legal/privacy-policy) before you enable it.
- Jev charges $0.042 per million input tokens, as of November 2026. The Organisation page shows how many messages were checked this month, the tokens used, and how many checks couldn't finish.
- CloudySuite calls `POST https://api.typesafe.ai/v1/systemone` with a plain `fetch` and the admin's key as a bearer token, using the `jev-latest` alias and `noul` questions. It adds no SDK. An alias, because a copy of CloudySuite never updates itself and a retired version would quietly end every check.
- Saving a key checks it with `GET /v1/models`, which spends no tokens. A key Jev rejects isn't saved. A key that can't be checked right now is saved, and the screen says so. The key is stored in D1 and never returned to any browser. The screen only says that one is set.

**What is sent.** For one inbound message, one request, holding exactly this:

- `state`: the sender's name (200 characters at most), the sender's address (320), the subject (500), and the first 6,000 characters of the readable text.
- `questions`: CloudySuite's fixed spam question, if it's being asked, and the words of each rule description being asked.

Attachments, recipients, other headers, and the rest of the text are never sent. Imported and sent mail is never sent. Jev reads no images, because a request has no `assets`.

**When it is sent.** The check runs in `ingest` before the commit, with a 2-second limit that also covers reading the answer. It runs there because a person then sees a message land once, in the place it stays. A check afterwards would show mail in the Inbox and take it away, and it would have to reapply rules that have already run. Jev's docs say most calls take about 100 ms. Any failure, including a timeout, a `429`, a `529`, or a response that fails the strict parser, leaves the message as the built-in filter would judge it, and the message is stored. Failures are not retried, because a delivery can't wait.

A question is asked only when its answer could change something:

- The spam question goes only for mail with a score of 4 to 9, where the answer's 6 points could reach the threshold of 10.
- Mail the filter has already filed in Spam isn't sent at all, even for a rule, so "Not spam" brings it back without a label that rule might have added.
- A rule's description is asked only if the rule's other conditions leave it open. So in a mailbox with a rule that has only a description, every new message that isn't already in Spam goes to Jev.

**How far the answer counts.** An answer is one number, a probability, and a yes needs 0.9 for spam and 0.8 for a description. Those bars haven't been tuned on real answers yet.

- A yes adds 6 points and never subtracts any, so the model alone never files a message and can never take one out of Spam. Spam reasons say only "The optional message check flagged this as likely spam." No words from the model reach a screen.
- It never counts for a sender on the allow list or marked "Not spam", for a reply to mail this mailbox sent, or for a message the mailbox's marks say looks real. Real mail in Spam is the worst mistake this filter can make.
- A description that fits does only what its rule already does, and the spam verdict still has the last word on the folder. A rule can't forward mail or delete it permanently.

**What it can't defend against.** A message is hostile, so its text only ever goes in `state`, and the questions are the same whatever a message says. That doesn't stop a model from being talked into an answer, and CloudySuite can't tell when it has been. What limits the damage is what an answer can do:

- A sender who talks the model into "not spam" gets the built-in result, the same as with no key.
- One who talks it into "spam" only files their own message.
- One who talks it into "fits" can make their own message take a rule's action. They can get it archived, labelled, or starred, or moved to Trash if the rule does that. So avoid rules that hide mail on a description alone if that would matter.
- A sender can also spend the organisation's tokens, because each message they send to a mailbox with a description is a check. Each check is bounded and a flood has no monthly cap, so set a spending limit in the Jev account if Jev offers one.

**Safe to repeat.** A redelivered message is found by its hash before anything is asked, so it makes no call and can't change where a person put it. A delivery that asked and then died leaves a claim in the mailbox. Its retry spends nothing and files the message on the built-in result, because the paid answer went with the attempt. Two copies arriving together ask once.

**Rule descriptions.** Only a mailbox's managers can write them. A mailbox can have 5 different descriptions across its rules, of up to 200 characters each, and one message makes one call however many it needs. Without a key, a rule with a description is paused as a whole, even if it matches on "any" condition, because its conditions were written to work together. The Rules page says so, the option is offered only while a key is set, and removing the description or adding a key brings the rule back. While a key is set but a check fails, a description doesn't match and the rule's other conditions still count.

### Storage

Storage replaces Google Drive. A person lands on Home, which shows their team folders and recent files. Inside a folder, a table lists what is there, and a panel describes the chosen file or, with nothing chosen, the folder itself. One click opens a folder. One click on a file chooses it, and another click lets it go.

**Built so far:** team folders, subfolders, My files, uploading with resume, downloading, and previews of pictures.

**Not built yet:** adding people to a folder, sharing, Shared with me, rename, move, delete, Trash, search, starring, storage limits, WebDAV, and the row of mail attachments on Home. A control appears only once it works, so none of these has a button yet.

- **A team folder is its own member list,** like a shared mailbox. There are no teams across the organisation to keep in step. Anyone signed in can create a team folder and becomes its manager, so sharing files never has to wait for an admin. Until adding people is built, only its creator can open a team folder.
- **My files is made on first use, not on first look.** Viewing the page changes nothing, because no `GET` request changes a person's data. The first upload or folder makes it, and the database allows one for each person, so two tabs can't make two.
- **No links for people outside the organisation.** A link that works without signing in would be the one way into a file with no access check behind it. Sharing will offer people added by hand, and everyone in the organisation.
- **WebDAV comes after the first release.** Each folder holds one item for each name, ignoring case, so every item already has one path. WebDAV clients can't use a passkey, so it needs app passwords, which [the sign-in features](#auth) don't include yet.
- **Limits will be an organisation total, plus an optional limit per person for My files,** both set by an admin. Neither is built, and there is no default, so the sidebar shows only the amount used.
- **Each drive is one SQLite-backed Durable Object.** A drive is a team folder or a person's My files. The object holds the names and details, and the bytes go in R2 through the Worker, so a large file never holds up anyone else using the drive. Each object keeps the truth for its bytes and file count, and writes the totals to D1 after each change. Team folder cards and the sidebar read D1 only, so opening Home wakes no object except for Recent, which asks each drive the person can open that holds files. The totals are absolute values, so writing them twice changes nothing. A failed write leaves a flag, and the object's alarm tries again.
- **Previews are limited to PNG, JPEG, WebP, and GIF, up to 5 MB.** `storage.` shares the session cookie's domain, so an HTML or SVG file shown inline would be a script running with the signed-in person's session, whatever type the upload claimed. The preview route refuses every other type, and sends `nosniff` and a `sandbox` policy, so a page calling itself a PNG can't run either. Everything else downloads, and shows a type icon.
- **A taken name.** A new folder with a taken name is refused in plain words. An upload keeps both, as `Report (2).pdf`, because a person dropping files shouldn't be stopped or lose either copy.
- **Removing a person deletes no files.** Their My files stays and still counts towards the amount used, but nobody can open it, or a team folder only they were on, until a way to hand those over is built. The removal dialog says so.

Uploads split a file into the same 10 MB parts as [Mail import](#mail-import), up to 100 GB.

- If the connection drops, the upload retries with a growing delay and the tray says it is waiting. Parts already stored are never sent again.
- After a reload, choosing the same file in the same folder carries on where it stopped. A match needs the folder, name, size, and person, plus a hash of the start and end of the file and its modified time. So a different file with the same name and size, or an edited copy of the first, starts over instead of joining the first one's parts. An edit that changes neither the modified time nor the start or end of the file would go unnoticed.
- Closing the tray stops the upload. What was stored stays, so choosing the file again carries on.
- An upload with no new part for 3 days is removed, ahead of R2's own 7-day clean-up.
- A finished file takes its upload's id, so finishing twice finds the file and changes nothing. If a crash came after R2 joined the parts, the retry checks the stored file's size.

A deployment set up before Storage existed has no `storage.` address, because the wizard runs only once. Add it as a custom domain on the Worker in Cloudflare.

## Design

CloudySuite uses the Daylight direction, which is calm, neutral, and familiar, with blue for the next action. A left sidebar holds the app switcher and folders, and Mail has a message list beside a reading pane. [The design trial](https://github.com/Setupless/cloudysuite/blob/17574a1/prototypes/look-and-feel/index.html) shows Daylight and the three rejected directions on each screen, in light and dark. It is no longer in the repository, so open that revision for visual reference only.

Appearance follows the device's light or dark setting by default. Setting `data-theme="light"` or `data-theme="dark"` on the `html` element overrides it.

### Change the palette

Every colour lives in [`src/styles/theme.css`](src/styles/theme.css) as a role, such as `--color-accent`, with a light and a dark value. Tailwind turns each role into classes such as `bg-accent` and `text-secondary`, and the theme removes Tailwind's default colours. Editing this one file recolours the whole product.

1. Edit the values in `src/styles/theme.css`. For a new accent colour, change `--color-accent`, `--color-on-accent`, and `--color-selected`.
2. Run `bun scripts/check-theme.mjs`.
3. If the accent changed, run `bun scripts/generate-app-icons.mjs`. Mail's app icons are images, so a test fails until they match the theme. The manifest's colours are read from the theme when the build writes it.

The script fails if a text and background pair is below the WCAG AA contrast ratio of 4.5, if a role is missing, or if a file in `src`, `apps`, or `packages` contains a colour value outside the theme file. It does not catch a misspelled class: `bg-acent` builds without an error and renders no colour.

### Load the stylesheet

Import `src/styles/app.css` in the root route with `import "../styles/app.css"`. Do not use `app.css?url` with a `head()` link. In our test, the server and client builds then disagreed on the file name, the first HTML linked a stylesheet that returned 404, and the page stayed unstyled until JavaScript ran.

## Privacy

CloudySuite relies on Cloudflare's encryption at rest. Cloudflare and the organisation's admins are inside the trust boundary, and CloudySuite is not end-to-end encrypted. In exchange, server-side search and rules work without extra steps.

**Saved mail on a device is not encrypted by CloudySuite.** So people can read offline, Mail keeps up to 50 MB of recent mail in the browser. Anyone who can get into that device and read the browser's files can read it.

**A device kept offline can show its saved mail for up to 59 days,** even after the person signed out on another device or an admin removed their access. It can't find out until it next connects, and then it clears itself. After 59 days with no connection, it stops showing saved mail.

**If a device is lost,** an admin should reset that person's sign-in straight away, which protects everything on the server. An admin can't erase the device remotely until it next comes online and opens Mail, so until then only the device's own lock protects the saved mail. Ask people to keep a passcode or password on any device they use for Mail.

Jev is outside that boundary. With no key, no message content leaves Cloudflare for it. With a key, what is sent and when is listed in [Optional Jev integration](#optional-jev-integration).

## Cloudflare limits and costs

These limits come from the Cloudflare docs and shape the product:

- Sending to arbitrary recipients requires the Workers Paid plan. It includes 3,000 outbound emails per month, then costs $0.35 per 1,000.
- New accounts start with a low daily sending quota that Cloudflare raises over time.
- Messages have a 25 MiB limit, inbound and outbound, including attachments.
- Cloudflare generates each outgoing `Message-ID`, and its docs don't say whether the `messageId` that `send()` returns is the same value. Threading works either way: see [`threading-headers.ts`](apps/mail/src/compose/threading-headers.ts).
- A message can have at most 50 recipients across to, cc, and bcc.
- A SQLite-backed Durable Object can store up to 10 GB, and a single row can hold up to 2 MB, so large message bodies go in R2.

## Technical direction

- One Worker serves every app and routes by hostname, because the Deploy button does not deploy several Workers from one repository together.
- Each mailbox and each drive is one SQLite-backed Durable Object. Attachments and files go in R2. D1 holds the organisation directory: domains, users, addresses, mailbox access, drives, and drive access.
- The rule that every mailbox or drive query checks the signed-in user's access lives in one place, because several people can share one.

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

The first `bun run dev` asks for `sudo` to bind port 443 and trust a local certificate. It starts the proxy with wildcard routing, because every app shares one Vite server.

A proxy that is already running without wildcard routing returns a portless 404 for every app. Run `bunx portless proxy stop`, then start again.

`bunx vite dev` skips portless and serves the same hostnames on port 5173.

To try the setup wizard without a Cloudflare account, use the fake API in `apps/auth/scripts/fake-cloudflare.ts`:

1. Remove `.wrangler/state`, then write `CLOUDYSUITE_LOCAL_CLOUDFLARE_API=http://127.0.0.1:8799/client/v4` as the only line in `.dev.vars`.
2. Run `bun apps/auth/scripts/fake-cloudflare.ts`, then `bun run build`, `bun run db:migrate:local`, and `bunx wrangler dev`.
3. Open `http://localhost:8787` and paste `owner-token-owner-token-owner-token`. The script also has a stranger's token, a read-only token, and `no-workers-token-no-workers-token`, which can see no Workers.
4. When the wizard waits for its new secret, restart `wrangler dev`. A real Worker restarts by itself.

The wizard ignores that variable unless it names a loopback address, so it cannot send a token elsewhere. It comes from the environment, so a request cannot set it.

To try the Jev check without a key, add `CLOUDYSUITE_LOCAL_JEV_API=http://localhost:9911` to `.dev.vars`, run `bun apps/mail/scripts/fake-jev.mjs`, then save any key on the Organisation page. The script says how to make it fail. Like the wizard's variable, this one is ignored unless it names a loopback address.

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
