# CloudySuite

As close as you can get to Google, on Cloudflare, with your own domains.

CloudySuite is an open source workspace for small organisations. One technical person deploys it to the organisation's Cloudflare account. Everyone else signs in to clean, fast apps for mail, files, calendars, and tasks.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Setupless/cloudysuite)

## Status

Built, not yet proven. Auth, Mail, Storage, Calendar, and Tasks are in the code and tested locally. No app has handled real mail on a real deployment yet, and the first release waits until one has.

This README describes what is on `main`. Anything planned, unbuilt, or still to check is in [What's next](#whats-next).

## Who it is for

CloudySuite is for small companies and open source teams of about 2 to 100 people that don't yet have a cloud suite. One technical person deploys it. The people who use it every day need no technical knowledge. We follow Apple's "it just works" philosophy.

One deployment serves one organisation, with as many email domains and aliases as it needs. Two organisations use two deployments in separate Cloudflare accounts, so they share no data.

## Apps

Each app has its own subdomain on the organisation's app domain. The first release contains these five.

| Address                | Purpose                                     | Replaces                 |
| ---------------------- | ------------------------------------------- | ------------------------ |
| `auth.example.com`     | Organisation, accounts, and email addresses | Google Admin and Account |
| `mail.example.com`     | Mailboxes                                   | Gmail                    |
| `storage.example.com`  | Files                                       | Google Drive             |
| `calendar.example.com` | Calendars and invitations                   | Google Calendar          |
| `tasks.example.com`    | Team boards and private tasks               | Google Tasks             |

## Deploy

You need a domain on Cloudflare DNS and the Workers Paid plan. The wizard links to Cloudflare's guide for each if you don't have them. You don't need Bun, Wrangler, or any other local tool.

1. Click **Deploy to Cloudflare** above. It copies this repository to your GitHub or GitLab account, creates the Worker and its storage, and applies the database migrations.
2. Open the Worker's URL to start the setup wizard.
3. Create an API token from the wizard's link, which fills in the token form, and paste the token into the wizard.
4. Choose your domain and where the apps live. The wizard checks the domain's DNS and explains its recommendation.
5. The wizard turns on Email Routing and Email Sending, points the catch-all rule at the Worker, attaches a hostname for each app, and generates the sign-in secret.
6. Create the first admin account, which also gets a personal mailbox. The wizard then sends you to `auth.<app domain>`.

Turning on Email Sending makes Cloudflare add DNS records to your domain: `cf-bounce` MX and SPF, a DKIM key, and `_dmarc` with `v=DMARC1; p=reject;`. That DMARC record tells other mail systems to refuse mail that claims to be from your domain but can't prove it. Check that any other service sending as your domain signs its mail. The wizard never changes a DMARC record you already have.

A deployment set up before Storage, Calendar, or Tasks existed has no address for that app, such as `tasks.`, because the wizard runs once. Add each missing one as a custom domain on the Worker in Cloudflare.

### Simplicity goal

Deploying CloudySuite must take fewer steps and decisions than comparable tools such as [QuickInbox](https://github.com/DivinPrince/quickinbox):

- One mail provider, Cloudflare Email Service, so the deployer picks no provider and follows no separate setup track.
- One Worker, with no queues or other services to configure.
- No terminal commands to deploy. Dashboard steps are limited to creating the token and any step the API can't finish, and the wizard links to and checks each one. Updating needs Git, as [Update](#update) explains.

## Update

The Deploy button copies the repository, so a deployment has no link back to this one. Security fixes, such as Better Auth patches, reach a deployment only when its admin applies them. The admin's **Organisation** page compares the running version with the latest GitHub release and links to these steps. CloudySuite never changes itself.

Updating needs a terminal with Git. The copy and this repository share no history, so GitHub's web page has no pull request to offer, and Git's own merge would mark every differing file as a conflict and keep files a release deleted. These steps copy the release's files instead. They work the same however many releases you skipped. A push to the copy's `main` deploys it and applies any database migrations.

1. Read the release notes, and note the release's tag, such as `v1.2.3`.
2. Replace your copy's files with the release's:

   ```sh
   git clone <your copy's URL> cloudysuite
   cd cloudysuite
   git fetch --no-tags https://github.com/Setupless/cloudysuite.git tag v1.2.3
   git read-tree -u --reset v1.2.3
   ```

3. Run `git diff --cached HEAD -- wrangler.jsonc`. Lines starting with `-` are your copy's, and lines starting with `+` are the release's.
   - Put back your own `name`, `database_name`, `database_id`, and `bucket_name`.
   - Keep every other `+` line, including a binding the release added, such as a new `kv_namespaces` entry. Cloudflare's [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/) creates a D1, R2, or KV resource for a binding with no ID when it deploys. The release notes say if a release needs anything more.
4. Run `git diff --cached --stat HEAD` to see what changes. This overwrites any edit you made to your copy's files, so add those back.
5. Run `git add -A`, then `git commit -m "Update to v1.2.3"`, then `git push`. Cloudflare builds and deploys your copy in a few minutes.
6. Check that the version at the bottom of the **Organisation** page is the new one.

To publish a release, set `RUNNING_VERSION` in `apps/auth/src/admin/updates.ts` and tag that commit with the same version.

## Setup wizard

The wizard calls the Cloudflare API from the Worker. It never stores the token. The token stays in the browser tab, and each call sends it again. The token form asks for Workers Scripts Edit, Email Sending Edit, Zone Read, DNS Edit, Zone Settings Edit, and Email Routing Rules Edit, as `apps/auth/src/setup/token-link.ts` lists.

**Only the Worker's owner can finish setup.** Every call proves two things with the pasted token, so a stranger who finds a new deployment's URL can't claim the admin account:

- **The token's account owns this Worker.** The Worker reads its running version id from its `version_metadata` binding, and Cloudflare must confirm that the version exists on a script in the token's account. Cloudflare generates the id, so nobody can recreate it in another account. The check reads the id on every call, so it still holds after setting a secret starts a new version. This is also how the Worker learns its own script name.
- **The token can change this Worker.** Read access isn't enough, so the wizard reads `.../script-settings` and sends the same values back in a `PATCH`. That changes nothing but needs Workers Scripts Edit. A run against real Cloudflare confirmed that the settings stayed the same and no new version appeared. If Cloudflare returns no settings to send back, the proof fails and the wizard writes nothing.

Until both proofs pass, the caller could be anyone, so Cloudflare's errors reach them only as a plain message. After that, the wizard shows Cloudflare's own words.

**Each step checks, applies, and checks again.** If the API can't finish a step, the wizard shows the exact action, a link to that Cloudflare dashboard page, and a link to Cloudflare's docs. The admin does it and clicks **Check again**, so the wizard never assumes a manual step worked. The wizard never deletes a DNS record, so an existing MX record or a conflicting hostname is always a manual step.

**Mail routing in use is never replaced without asking.** If an enabled catch-all rule forwards mail, deletes it, or sends it to another Worker, the wizard says so in plain words and waits. The server replaces the rule only when the request repeats the description the person saw, so a rule that changed meanwhile is shown again. A disabled rule carries no mail, so the wizard replaces it without asking.

**No mail vanishes during setup.** The catch-all goes live before the first admin's address exists. Until setup finishes, the Worker rejects mail for every address at the domain, so a sender gets a bounce saying there is no mailbox there.

**Setup finishes exactly once.** The primary domain is stored last, in one atomic batch with the admin's user, password, mailbox, address, and access. The database allows one primary domain, so when two people finish at once, one wins and the other leaves nothing behind. Until then, the router keeps every hostname on `/setup` and nobody can sign in, so an interrupted setup can resume. Afterwards, the router sends `/setup` away on an app hostname and treats the `workers.dev` hostname as unknown.

## Domains

The app domain and an email domain are separate, and either can be the zone apex. They are often the same domain.

| Domain       | What it is                                                    | Stored as                                   |
| ------------ | ------------------------------------------------------------- | ------------------------------------------- |
| App domain   | Parent of each app's address, and the session cookie's domain | The `domains` row with `is_primary = 1`     |
| Email domain | What follows `@` in addresses                                 | A `domains` row, used by `addresses.domain` |

The session cookie covers the app domain and every site under it, so whoever runs any other site there could read a signed-in person's cookie. The wizard scans the zone's DNS and custom domains for that reason. A name counts as CloudySuite's own only when Cloudflare says it is a custom domain attached to this Worker. Anything else counts as another site, even a name that matches an app, such as `auth` or `tasks`.

- With no other site, the app domain is the apex, as in `auth.example.com`.
- With other sites, such as a third-party `www`, the wizard explains the risk and recommends a parent such as `suite.example.com`. The apps become `auth.suite.example.com`, and email stays `@example.com`.

### Email domains

An email domain is always a zone apex, because Email Routing's catch-all rule works only there. When the app domain is a subdomain of another stored domain, only the parent is an email domain, so nobody gets an address at the app domain.

An admin adds another email domain by following a guide in their Cloudflare account, because CloudySuite stores no token. **Check again** looks up the domain's public DNS records over HTTPS, and saves the domain only once the records for receiving and sending exist. DNS can't show the catch-all rule that sends mail to the Worker, so the guide says so and asks the admin to send a test message.

## Turn an app off

An admin can turn Mail, Storage, Calendar, or Tasks off for the whole organisation, for example when it keeps another mail provider. Auth can't be turned off, because admins use it to turn the others back on. Turning an app off deletes nothing, and turning it back on restores everything.

- Someone who opens a turned-off app sees a page saying an admin turned it off, with a link to Account. The app also leaves the app switcher.
- The hostname router checks on the server for every request, so a hidden link is never the only protection. A server function answers on every app's hostname, so each app's server functions check too. A server function that reaches into another app, such as answering an invitation from Mail, checks both apps.
- A page that was already open stays where it is, and each request it makes is refused in plain words. A redirect would reach it as an answer it can't read. If a refusal stops it opening another of its pages, it loads that address again, and the router sends the browser to the off page.
- A download is a plain link to a response marked as a file, not a link with the `download` attribute. A browser saves whatever answers a `download` link, so it would save the off page as the file.
- Inbound mail still reaches the mailbox while Mail is off, because a bounced message can't be recovered later. The only other exception is a `GET` of `/pwa/session` on the Mail host. It returns a user id or a 401 and no mail, so a device can clear saved mail when someone signs out with Mail off.

D1 stores one row for each app that can be turned off, and a missing row means the app is on. The `APPS` registry in `src/routing.ts` says which apps those are.

## Auth

- Passkeys are the main way to sign in. A password with a TOTP authenticator app is the fallback.
- An admin can require 2FA for the organisation, and a passkey counts as the second factor. Someone with neither a passkey nor an authenticator app is sent to add one and can't use any app until they do. While 2FA is required, a password alone can't sign in to an account that has a passkey but no authenticator app.
- A person can't remove their last way to sign in. While 2FA is required, they also can't remove their last passkey or authenticator app.
- Someone who loses a device signs in with another passkey or a TOTP backup code. Otherwise an admin resets their sign-in. That removes their passkeys, authenticator app, password, and sessions, and gives the admin a one-time link to hand over. CloudySuite never emails the link, because the person's only address may be a mailbox they can't open. There are no magic links and no email recovery.
- An invite is a single-use token sent to the invited address, because a matching email string doesn't prove someone owns the address. A person's sign-in address is their new mailbox address when the invite creates one, and otherwise the address the invite went to.
- A session lasts 60 days and renews when used, at most once a day, so each session costs at most one database write a day. Someone who opens Mail now and then stays signed in and keeps getting notifications, which need a live session. A tab nobody is looking at makes no requests, so it can't keep a session alive. The session cookie cache stays off, so a sign-out or a reset takes effect at once.

Auth uses [Better Auth](https://www.better-auth.com) with email and password sign-in and the `twoFactor`, `passkey`, and `admin` plugins. Its rate limit on sign-in keeps its counts in D1. CloudySuite adds lost-device recovery, the organisation's 2FA rule, and invites. Mailbox access stays in CloudySuite's own tables.

We use the newest stable Better Auth release that no published [security advisory](https://github.com/better-auth/better-auth/security/advisories) affects for the features we use, never an `rc`, `beta`, or `canary`. Read a plugin's advisories before you add it. `bun audit` isn't enough. It reported nothing for CVE-2026-53514, which still applies to the `organization` plugin in current releases unless you change its configuration.

## Mail

Mail has sending and receiving, threads, search, attachments, personal mailboxes, shared mailboxes such as `support@`, aliases, labels, rules, spam filtering, `.mbox` import, and an installable app with notifications and offline reading. A message that carries a calendar invitation shows a card for it, which [Calendar](#invitation-cards-in-mail) describes. Gmail-style keys work in the message list and the reader, and `?` lists them.

Apple Mail, Outlook, and other native mail apps aren't supported, because they need IMAP and SMTP servers, which can't run on Workers.

### Search, labels, and rules

- **Search takes some of Gmail's operators:** `from:`, `to:`, `subject:`, `is:unread`, `is:starred`, `has:attachment`, `in:`, `label:`, `before:`, and `after:`. Anything else, including `-word`, `OR`, and `cc:`, is searched as plain words. An operator with a value it can't use, such as `is:important`, gets a plain message saying what it can search. Results are grouped by conversation, and Spam and Trash are left out unless `in:` names one. Search text is parsed into words and never reaches the index as syntax, so no text can break a search.
- **Labels belong to a mailbox,** so everyone with access sees and manages the same set. A label applies to a whole conversation, and a reply joins its conversation's labels. A label's list leaves out Spam and Trash. Anyone with access can delete a label. That takes it out of any rule that used it, and a rule left with nothing to do turns off.
- **Rules belong to a mailbox.** Its managers edit them and its members can read them. They run on new inbound mail only, never on imported or sent mail, so an import can't re-sort a mailbox's history. Rules run from the top down, every rule that matches applies, and the highest rule that moves a message decides where it goes.
- **A rule can't forward mail,** because that would make a mailbox an open relay. A rule can't delete permanently, because a bad rule must never lose mail. Its strongest action moves mail to Trash.
- **Rules run before spam scoring, and the spam verdict decides the folder.** So a rule's labels and stars still apply to mail filed in Spam. A rule reads a `From` line that anyone can forge, so it must not be a way past the spam filter. A mailbox's allow list is the way to trust a sender.

### Sending

- **Undo.** Send waits 10 seconds on the server, so closing the tab can't lose the message, and Undo still works after a reload. Undo turns it back into a draft.
- **A send is never repeated by guesswork.** A clean refusal says what to do, and only a rate limit retries by itself. If a crash or a lost connection leaves it unclear whether a message went, the person is told to check with the recipient, because a duplicate is worse than asking.
- **A queued message is checked again before each attempt,** because minutes can pass between Send and the message going out. If its From address has left the mailbox, its sender has lost access or been banned, or Mail was turned off, it doesn't go, and it stays in Drafts with a plain reason. If the directory can't answer, the job waits and tries again, then fails the same way. It never sends without an answer. If the attachments can't be read from storage yet, the job waits and tries again in the same way.
- **A message that can't settle at once never floats over the mail.** A failure, or a wait to retry, sits in a band above the mail, one at a time, with a count of the rest. Only the seconds just after Send float, because they're gone within moments.
- **A message to your own address appears twice, threaded together,** once in Sent and once in the Inbox. A header on inbound mail is never a reason to drop it, because anyone can copy one. Only a byte-identical redelivery counts as a duplicate.
- **A message holds up to 50 recipients and 32 attachments, of about 18 MB in total.** The 25 MiB limit counts the encoded message, and files grow by about a third in email.

### Drafts

- **Drafts are not messages.** They autosave to their own table, so saving can't fill the mailbox, and search or Trash never finds half-written mail.
- **A draft exists only once someone adds something:** a recipient, a subject, words, or a file. Opening Write, Reply, or Forward and leaving makes nothing, and neither does taking off a reply's quote or a forwarded file. Emptying a saved draft and leaving removes it, unless someone else saved it since. Moving to another list or conversation closes the editor and keeps the draft, and a short notice offers the way back.
- **No one's words are lost when two people or two devices edit one draft.** Every save, Send, discard, and file change names the draft version it started from, and the server decides in one transaction. On the current version, it writes and moves the version on. On an older one, it leaves that draft alone, puts the words in a new draft beside it, and tells the writer who changed the draft, or that another of their devices or tabs did. This holds online or offline.
- **The new draft is safe to repeat.** Its id comes from the draft's id and the editor's session, so a retry or a later autosave finds it instead of making another, and the editor moves onto it with no reload. A save with nothing new makes no new draft, and two tabs bringing back the same words share one.
- **The new draft keeps what it can.** It keeps the words, recipients, and subject, stays a reply in the same conversation, and copies the quote and the files the person could see. Anything it can't read any more stays out, and the person is told what and what to do. Adding or removing a file moves the draft to a new version too, so a save can't land over files its writer never saw, and a file can't join or leave a colleague's newer version. It follows the person's words to their own draft.
- **Send and Discard follow the same rule.** Send goes out from what is on that person's screen. If the draft moved on, that is their own new draft, and the colleague's stays in Drafts. If someone else already sent it, nothing joins that send, and the words stay on the device with a way to save them as a new draft. Discard removes only that person's draft. A draft that has moved on stays, and so does an emptied one someone has saved since.
- **Quoted mail stays in the sandboxed reading frame.** A stranger's markup never joins the editor, so a reply can leave the original out but can't edit inside it.

### The installable app

Mail installs from its own host as a PWA. The **App and notifications** page in Mail's menu has the install button, and the steps in words for Apple devices, which have no install prompt.

**No person's mail is in Cache Storage.** The service worker saves only the public build and one anonymous page, `/offline-shell`, which renders nothing on the server. Every saved message is in one IndexedDB database, so clearing a device means deleting that database.

- **Pages go to the network first.** With no connection, the service worker serves the anonymous page at the address asked for, and the client loads that address's routes itself. So a new deployment can't leave stale HTML linking a dead stylesheet.
- **Everything else passes straight through** unless it is a hashed build file or a listed public file. That includes sign-in, server functions, and downloads.
- **Updates.** `sw.js` lists the build's exact file names, so any change to them changes it. A new worker installs, takes over, and deletes the old files. A plain file serves `sw.js`, outside the Worker, so a fixed service worker reaches a browser even when an old one answers every request with an error.

**What is saved.** For each mailbox, up to 300 inbox, 100 sent, and 100 archived conversations, each body up to 256 KB, and up to 50 MB in total. Attachments, Spam, Trash, Drafts, and labels aren't saved. Search, label lists, and rules need a connection and say so. Bodies come through the same `renderBody` as reading online, so only sanitized HTML is stored, and it shows in the same sandboxed frame.

**Why a small hand-written store.** TanStack DB's browser persistence needs `@journeyapps/wa-sqlite`, which is outside this stack. Query's persister rewrites one blob holding everything on each save, 15.7 MB in our test against one record here. What decided it is safety. In this store, the check of who owns the device and the write share one transaction, so a tab finishing a refresh can't put the last person's mail back after a sign-out cleared it.

**Offline, actions are refused** in plain words, never queued. Someone who archives a message on a train shouldn't be surprised by what runs when the train arrives. Opening a message offline leaves it unread. Write, Reply, and Forward say they need a connection, and Send is refused. A message already handed to CloudySuite still goes, and Undo comes back with the connection.

**A device is cleared when:**

| What happened                         | What notices                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Signing out                           | The sign-out page sends the browser through Mail's `/device-cleared`            |
| A session ending elsewhere            | The service worker asks who is signed in on each page load, with no page code   |
| A tab left open when a session ends   | Its next call gets a 401, once someone is looking at the tab                    |
| Someone else signing in               | The same check, and the page, comparing against the device's owner              |
| 59 days with no check from the server | Offline, saved mail stops opening, because the session could have ended by then |

Sign-out happens on Account's host, which can't reach Mail's storage, so it passes through `/device-cleared`. That is a plain file, so it also works while Mail is off. Anyone can link to it, so it clears only when the server says nobody is signed in, or when the device's last check is more than 59 days old. That is a session's 60 days less the day a renewal can lag. With no answer from the server, it changes nothing, says so, and offers a button. The button is how someone offline signs out of a shared computer.

Turning Mail off clears nothing, so turning it back on restores the same device. Every Mail request except `/pwa/session` is refused with a mark that tells the device Mail is off, so it keeps its saved mail.

**A tab nobody is looking at makes no requests.** Each request renews the session, so a forgotten background tab would otherwise keep someone signed in forever. Timed refreshes, offline saving, and reconnecting wait until the tab is visible, then catch up at once. A visible tab counts as use, even with nobody at the screen.

**An open tab refreshes on a timer, with no websockets.** The list, the sidebar's counts, and the open conversation refresh every 30 seconds. Drafts and sends in progress refresh every minute, and every 1.5 seconds while a message is going out. Saved mail for offline syncs every 5 minutes. Opening a folder or a conversation asks the server at once, so what it shows is fresh. The refresh is also how a tab finds out its session ended. Its next request gets a 401, the device clears, and the browser goes to Sign in.

**Words that can't be saved stay on the device.** An open draft keeps working offline. What can't reach the server is kept in the same IndexedDB database, with the quote it replied to, so someone can move elsewhere or close the tab, and a band in that mailbox offers it back. When the connection returns, it goes to Drafts, never to Send. Each copy remembers the server version it was written on, so it follows the same rule as any save, and the device forgets it only after the server accepts it. A closing page writes its unsaved words to the device and sends them with a request that outlives the page. Only these unsaved words are kept, not drafts in general and not text someone has cleared. Signing out clears them too, even if they never reached the server.

**A device's copy is treated as hostile,** because anything on the origin can write to IndexedDB. A kept body enters the editor only through a browser-side allow list of what the formatting bar can make. A kept quote is stripped and goes in the sandboxed frame. A row of the wrong shape is ignored.

**Nothing is dropped without saying so.** If the message was sent or discarded elsewhere, the words still become a draft, and the page names what couldn't come along and what to do. That notice stays on the device until someone opens or dismisses it, because a toast can go unread. If someone loses access to a mailbox, their words aren't written to it. A card on every Mail screen says so and lets them copy the text or remove it.

[Privacy](#privacy) says what saved mail means for a lost device.

### Notifications

A person turns notifications on for each device and can turn off any mailbox they share. On iPhone and iPad, notifications work only once Mail is on the Home Screen. Each person can have notifications on 10 devices, and turning them on for an 11th turns them off on the oldest. A notification goes out for inbound mail that lands in the inbox, never for imported mail, sent mail, or Spam. It carries the sender and subject, encrypted so that the push service can't read them.

- **Web push is hand-written** with WebCrypto, RFC 8291 to encrypt and RFC 8292 to sign. A test checks it byte for byte against RFC 8291's published message. The organisation's signing keys are made on first use.
- **Only known push services.** A browser supplies its own endpoint, and the Worker later sends a request to it, so an open list would let anyone signed in aim the Worker at any URL. `apps/mail/src/push/endpoint.ts` lists the hosts. A browser can start using a host the list lacks, as Chromium did with `jmt17.google.com`. It then shows a plain failure, and the fix is one line.
- **Access is checked when sending,** not when queuing, through the one access check. The person also needs a live session somewhere, so someone who signed out everywhere, was reset, or hasn't used CloudySuite for 60 days hears nothing.
- **A flood stays small.** A device gets at most one notification every 30 seconds. The first message after a quiet spell goes at once, and the rest become one summary with no sender or subject. An alarm sends at most 50, and a device only ever owes its newest notice, so the queue can't grow.
- **The pushed text is hostile.** The service worker treats the decrypted message as hostile. A click opens a path built only from checked ids, on Mail's own host.
- **Mail turned off** still stores inbound mail but notifies nobody, then or later.

### Spam filtering

Spam filtering works without a Jev key and adds no dependency.

- Each message gets a score from its SPF, DKIM, and DMARC results and a few simple signals in the message.
- Each mailbox has its own block list and allow list, and learns from the messages its people mark as spam.
- The filter never rejects mail. A message that looks like spam goes to Spam, so a wrong guess loses nothing. Spam shows why each message is there, in plain words, from the reasons stored when it was filed.

How the score works:

- **DMARC decides alone only under an enforcing policy.** A failed DMARC check files a message by itself only when the sender's domain says failing mail isn't theirs, with `quarantine` or `reject`. That includes a mailing list breaking such a domain's check, so some real mail lands in Spam. Under `p=none` or no policy, it is one small sign, because half-set records and mailing lists fail this way all the time. Only Cloudflare's first `Authentication-Results` header is read, because anything below it is the sender's to forge.
- **A program file from a first-time sender is enough on its own.** A program file scores just under the threshold, and a sender the mailbox has never dealt with adds the last point.
- **Every other sign takes several together,** because real mail does each of them. The signs are a name showing another address, replies going to another site, a link whose text names another site, a subject in capitals, and a broken SPF or DKIM result. Only a pass for the `From` domain cancels a failed SPF result. A signature for some other domain says nothing, because anyone can sign for their own domain.
- **A reply to this mailbox counts strongly for a message,** going by a `Message-ID` the mailbox wrote in `In-Reply-To` or `References`. It outweighs several odd signs, but not the block list or an enforcing DMARC policy, because a `Message-ID` can leak.
- **Imported and sent mail skip the filter** and teach it nothing, unless a person marks that mail.

How trust works:

- **An allow list entry and "Not spam" both trust a sender.** That sender's later mail stays out of Spam unless it shows clear signs of forgery. A message that proves its sender always stays out: DMARC passed, or DKIM passed for that domain or a parent of it. A message that can't prove its sender goes to Spam only if DMARC failed under an enforcing policy, the `From` line holds more than one address, or a check failed alongside a misleading link, a name showing another address, or a program file. A misleading link with no failed check gets the normal score, because click tracking looks the same. Everything else stays in the Inbox, including a `p=none` failure, where a forgery and real mail can't be told apart. So a forger who copies a trusted address at a domain that enforces nothing, and writes plain text, reaches the Inbox. We accept that, because real mail in Spam is the worse mistake.
- **"Not spam" trusts one address, for everyone using the mailbox.** What that message's links and name showed, and where they pointed, stop counting against that address, or every issue of a newsletter with broken checks would land back in Spam. Both halves are remembered, because a click-tracking host is shared by many senders. So a link that shows a different site, even through the same tracking host, still counts, and a newsletter whose links name a new site can land back in Spam until someone marks it again. "Mark as spam" takes the trust back, and undoing the mark restores it. "Not spam" doesn't change the block list, so a sender still on it stays in Spam.
- **An allowed domain also covers mail it signs** with DKIM and mail whose `List-Id` is under it, so a mailing list can be allowed. A signature is that domain's word, so a signed post lands in the Inbox whatever its author's domain says about DMARC. `List-Id` is only a claim, so it counts like a `From` line.
- **The block list goes by the `From` line and covers subdomains.** The narrowest entry decides, so one trusted address can sit inside a blocked domain. A shared ending such as `co.uk` can't be listed, going by a short built-in list, not the public suffix list. Anyone with access can read the lists and mark mail. Only a manager can change the lists, because the allow list decides what the whole mailbox sees.

How learning works:

- "Mark as spam" and "Not spam" teach a small word-count model, one per mailbox, in the same transaction as the move. It reads up to 32 K characters and 300 distinct words of a message, holds at most 20,000 hashed words, and forgets the weakest first. Undo, or "Not spam" on a message someone marked, leaves the counts as they were.
- It files nothing as spam until 5 messages are marked as spam, and counts nothing as real until 3 are marked not spam. It files a message only when at least 85% of its words appear in marked mail and they lean clearly towards spam, so it catches repeats of what people marked. One "Not spam" outweighs many marks of the same kind. It never files a sender the mailbox already deals with who proves who they are, unless someone marks that sender as spam.

### Mail import

A person can upload an `.mbox` file, such as a Google Takeout export, into a mailbox they manage. It is the only import source, because most target teams have little to migrate, and it is the first feature to cut if the release slips. Storage needs no importer, because uploading moves files in.

1. The browser sends the file in 10 MB parts, up to 100 GB, and the Worker writes them to R2 as a multipart upload. An interrupted upload can resume.
2. The mailbox's Durable Object records an import job with a byte offset and works through the file in small batches on its alarm.
3. Each message goes through the same parsing and commit as inbound mail, in `apps/mail/src/ingest.ts`. Imported messages go to Archive, marked as read, with their original dates. They skip rules, spam filtering, and notifications.
4. Each batch saves its messages and the new offset in one SQLite transaction, so a crash resumes from the last saved batch.
5. A hash of each raw message prevents duplicates if a file is imported twice. The import screen lists any message it can't read.

How the reader handles a file:

- It reads mboxrd. A line of `>From `, with any number of `>`, loses one `>`. That is exact for mboxrd. For mboxo, it restores every escaped line, at the cost of one `>` on a body line that really began `>From `. Nothing in a file says which format it is.
- A line separates messages only if it starts with `From `, ends in a date, and is followed by a header, so a body line such as `From the desk of` stays in its message.
- A message over 25 MiB is skipped by reading past it, never holding it whole, and listed. So is a final message the file cuts off, because a stored half-message looks whole.
- A mailbox runs one import at a time. An upload with no new part for 3 days is removed.
- Gmail labels in `X-Gmail-Labels` aren't imported, and the screen says so.

A new import source adds only a reader that yields raw messages.

### Optional Jev integration

An admin can add a [Jev](https://docs.typesafe.ai/introduction) API key to improve spam filtering and let a rule match a description, such as "looks like an invoice". Mail, spam filtering, and rules all work without a key, and with no key nothing goes to Jev. CloudySuite has no other AI features.

Jev is a third-party service. With a key, CloudySuite sends message content to it. The Organisation page says so before the key can be saved, and the server refuses a save without the admin's acknowledgement.

- Jev keeps data for as long as it considers necessary, with no fixed period, and offers zero retention to enterprise customers. Read the [privacy policy](https://typesafe.ai/legal/privacy-policy) before you turn it on.
- Jev charges $0.042 per million input tokens, as of November 2026. The Organisation page shows this month's checks, tokens, and checks that couldn't finish.
- CloudySuite calls `POST https://api.typesafe.ai/v1/systemone` with a plain `fetch` and the key as a bearer token, using the `jev-latest` alias and `noul` questions, with no SDK. It uses an alias because a copy of CloudySuite never updates itself, and a retired version would quietly end every check.
- Saving a key checks it with `GET /v1/models`, which spends no tokens. A key Jev refuses with a 401 isn't saved. After any other failure, the key is saved and the screen says it couldn't be checked. The key is stored in D1 and never returned to a browser.

**What is sent.** For one inbound message, one request holds exactly this:

- `state`: the sender's name (200 characters at most), the sender's address (320), the subject (500), and the first 6,000 characters of the readable text.
- `questions`: CloudySuite's fixed spam question, if asked, and the words of each rule description being asked.

Attachments, recipients, other headers, and the rest of the text are never sent. Imported and sent mail is never sent. A request has no `assets`, so Jev reads no images.

**When it is sent.** The check runs in `ingest` before the commit, with a 2-second limit that covers reading the answer. It runs there so a person sees a message land once, in the place it stays. A check afterwards would show mail in the Inbox and then take it away. Any failure, including a timeout, a `429`, a `529`, or an answer that fails the strict parser, leaves the message as the built-in filter judged it, and stores it. Failures aren't retried, because a delivery can't wait.

A question is asked only when its answer could change something:

- The spam question goes only for a score of 4 to 9, where the answer's 6 points could reach the threshold of 10.
- Mail already filed in Spam isn't sent at all, even for a rule, so "Not spam" brings it back without a label that rule might have added.
- A rule's description is asked only if the rule's other conditions leave it open. In a mailbox with a rule that has only a description, every new message outside Spam goes to Jev.

**How far an answer counts.** An answer is a probability, and a yes needs 0.9 for spam and 0.8 for a description. Those bars haven't been tuned on real answers yet.

- A yes adds 6 points and never subtracts any, so the model alone never files a message and never takes one out of Spam. Spam's reason says only "The optional message check flagged this as likely spam." No words from the model reach a screen.
- It never counts for a sender on the allow list or marked "Not spam", for a reply to this mailbox, or for a message the mailbox's marks say looks real.
- A description that fits does only what its rule already does, and the spam verdict still decides the folder.

**What it can't defend against.** A message's text only ever goes in `state`, and the questions are the same whatever a message says. That doesn't stop a model from being talked into an answer, and CloudySuite can't tell when it has been. What limits the damage is what an answer can do:

- A sender who talks the model into "not spam" gets the built-in result, the same as with no key.
- One who talks it into "spam" files only their own message.
- One who talks it into "fits" can make their own message take a rule's action, such as archive, label, star, or Trash. Avoid rules that hide mail on a description alone if that would matter.
- A sender can spend the organisation's tokens, because each message to a mailbox with a description is a check. Each check is bounded, but a flood has no monthly cap, so set a spending limit in the Jev account if Jev offers one.

**Safe to repeat.** A redelivered message is found by its hash before anything is asked, so it makes no call. A delivery that asked and then died leaves a claim in the mailbox. Its retry spends nothing and files the message on the built-in result. Two copies arriving together ask once.

**Rule descriptions.** Only a mailbox's managers write them. A mailbox can have 5 different descriptions across its rules, of up to 200 characters each, and one message makes one call however many it needs. Without a key, a rule with a description is paused as a whole, because its conditions were written to work together. The Rules page says so, and offers descriptions only while a key is set. While a key is set but a check fails, a description doesn't match, and the rule's other conditions still count.

## Storage

Storage replaces Google Drive. A person lands on Home, which shows their team folders, recent files, and recent attachments from their mail, with **See all** for the full Recent page. Inside a folder, a table lists what is there. A panel describes the chosen file or, with nothing chosen, the folder. One click opens a folder. One click on a file chooses it, and another lets it go. Files can be dropped on a folder's page or on Home, which puts them in My files. A dropped folder is refused.

### Team folders and access

- **A team folder is its own member list,** like a shared mailbox, so there are no organisation-wide teams to keep in step. Anyone signed in can create one and becomes its Manager, so sharing never waits for an admin. A Manager adds and removes people, and sets each to Can view, Can edit, or Manager. A team folder always has a Manager, so the last one can't leave or step down. A Manager can rename it, and delete it once it and its Trash are empty.
- **Each person has My files,** where the screen shows them as Owner. It is made on first use, not on first look, because no `GET` request changes a person's data. Making a folder, uploading, moving something in, or saving a mail attachment makes it, and so does an admin giving the person a limit. The database allows one for each person, so two tabs can't make two.
- **Access is the highest of a person's role on the drive and any share above the item.** Can view can open, preview, and download. It can't upload, make a folder, rename, move in or out, delete, restore, delete forever, or share. The Drive object refuses these itself, in the same call that would do the work, so a hidden button is only a courtesy. A Can view member who is also given Can edit through a share can edit what that share covers.
- **One access check.** `checkDriveAccess` is the only thing that issues a drive's grant and says who someone is to the drive. Every call then tells the Drive object who is asking, and `reachOf` in the object decides what that person reaches, walking up from the item. A person not on a drive gets the same answer for an item out of reach as for one that doesn't exist. Alarm work doesn't open a drive again, because it only finishes what was already approved.

### Sharing

- **Anyone with Can edit can share, and a share covers everything inside,** including what's added later. Moving something out of a shared folder ends what it got from that folder. The person sharing picks Can view or Can edit. The default is Can view for a share and Can edit for a team folder member.
- **Someone reaching a folder through a share browses it with the normal table.** The path above it stops at what they can reach, so they never see the name of a folder above.
- **Sharing with a team adds the people on it now, once.** A team is only a team folder's list, and nothing keeps a share in step with it, so someone who joins later isn't added. The dialog says so. A person can only add a team folder they're on.
- **"Everyone at" the organisation is always Can view, and needs the link.** It doesn't list the item for everyone or put it on anyone's Shared with me. Copy link gives a normal address that needs signing in and access. The name shown is the primary domain, because no organisation name is stored.
- **No links for people outside the organisation.** A link that works without signing in would be the one way into a file with no access check behind it.
- **Shared with me lists what was shared directly with a person,** with who shared it and when. A file link opens a page of its own, because someone who can reach one file can't open the folder around it.
- **The Drive object is the truth for shares, and D1 says only where to look.** A share has to change in one transaction with the items it covers, so deleting something forever can't leave a share behind. D1's `drive_shares` holds the person, drive, and item of each share, so Shared with me knows which objects to ask. It holds no names and grants nothing. The page shows what the object says now, so a row left by a failed write shows nothing and opens nothing. The object queues each change in the same transaction, and its alarm retries a failure.
- **A share in Trash stays, and reaches nothing** until the item is restored. Deleting forever removes the share. Moving something to another drive ends its shares and those of everything inside, and the move dialog says so. Someone who reached an item through Can edit can undo their own delete, but can't see Trash or delete forever, because Trash belongs to the people on the drive.

### Search and Starred

- **Search finds names across everything a person can reach,** meaning their drives plus what's shared with them directly and everything inside it. It doesn't look inside files, and leaves out Trash. What's shared with everyone isn't searchable, because that opens only for someone holding the link.
- **Each word must start a word in the name,** in any order, whatever the case or accents. Chinese and Japanese names have no spaces, so they match only from the start of a run of characters. Search takes Google Drive's operators: `type:` for a kind of file or `type:folder`, `owner:` for who added it, with `owner:me`, `is:starred`, `after:` and `before:` for the day it last changed in the reader's time zone, and quotes for words in order. A file's kind comes from the same table as its icon, and a known extension outranks the stored type, which can lie.
- **Results show where each thing is,** most recently changed first, up to 50 for each drive and 100 in all. Drives are asked five at a time, and asking stops after 5 seconds. If any drive failed or hadn't answered, a note says some folders couldn't be searched. A move never lists an item twice, and can leave it out for the moment it is between drives.
- **A star is private and needs only access,** so Can view can star. Starred lists them across drives. An item in Trash leaves the list and returns on restore. Losing access takes it off without an error. A star belongs to the drive it was made in, so it stays through a move within the drive and is lost in a move to another drive.

### Limits

- **Limits are an organisation total, plus an optional limit per person for My files,** both set by an admin. There is no default, so until an admin sets one nothing is refused and the sidebar shows only the amount used. A team folder counts only towards the organisation total. A limit below what's stored stops new uploads and deletes nothing.
- **A finished file can't take storage past a limit.** When a file finishes, its Drive object runs one D1 statement that writes the drive's new total only if both limits still allow it. D1 runs statements one at a time, so of several files finishing together, those that fit are stored and the rest are refused. This write comes before the file is recorded, so D1's totals are never behind on bytes being added. A file finishing at the moment an admin sets the first limit may have read that there was none, so it can pass. Parts of unfinished uploads aren't counted, because they aren't files yet. D1's totals can be briefly too high after a crash, a removal, or during a move, which can refuse a file that fits until the figure is corrected. They are never too low.
- **An upload is checked when it starts and when it finishes.** The check at the start tells someone early, before they send anything. Uploads in progress hold no space, so an unfinished one can't block a file that fits. The cost is that a file can be sent in full and refused at the end, if other files took the space meanwhile. Its data goes at once, through the sweep that removes stopped uploads. With a limit set, a D1 failure at the end leaves the file waiting and the tray retrying. With none, the file is stored and the totals catch up.
- **A move into My files must fit that person's limit,** and is refused before anything moves. Moving doesn't grow the organisation, so its limit never refuses a move. The receiver adds the bytes to its D1 figure before it adds its rows, and the sender's figure drops only once its rows are gone. Subtracting first would let an upload past a full limit if the move then failed, so D1 can be too high but never too low. For the seconds a move takes, the organisation's total counts those bytes on both sides, so an upload near a full organisation limit can be refused for that moment. Restoring from Trash adds nothing, because bytes in Trash still count. A file someone uploads or moves into another person's My files, including through a share, counts towards that person's limit.

### Files, Trash, and moves

- **Each drive is one SQLite-backed Durable Object.** A drive is a team folder or a person's My files. The object holds names and details, and the bytes go to R2 through the Worker, so a large file never holds up anyone else using the drive. The object keeps the truth for its bytes and file count and writes the totals to D1 after each change, as absolute values that are safe to write twice. Team folder cards and the sidebar read D1 only, so Home wakes only the drives it needs for Recent and move notes.
- **Previews are limited to PNG, JPEG, WebP, and GIF, up to 5 MB.** `storage.` shares the session cookie's domain, so an HTML or SVG file shown inline would be a script running with the signed-in person's session. The preview route refuses every other type and sends `nosniff` and a `sandbox` policy. Everything else downloads and shows a type icon.
- **Names.** A new folder with a taken name is refused. An upload keeps both, as `Report (2).pdf`, because a person dropping files shouldn't be stopped. Rename and move refuse a taken name, because the person can choose again. Restore keeps both, because refusing would leave the item stuck in Trash. Each folder holds one item for each name, ignoring case.
- **Renaming needs sight of the folder around the item.** Someone who reaches an item only through a share on it can't rename it, because a refused name would tell them what else is in a folder they can't open.
- **Trash belongs to each drive and shows as one flat list** of the 200 most recently deleted items. Deleting a folder takes what is in it, and it comes back as one unit. A deleted item frees its name. If its folder is gone, it returns to the top of its drive and the page says so. Bytes in Trash count towards the amount used until they are deleted forever, because R2 still holds them. They leave a team folder's file count, Recent, and listings at once, and downloading one gives a plain 404.
- **Trash empties itself after 30 days.** Delete forever, Empty Trash, and the 30 days all go through one path. Each small batch removes rows and queues their R2 objects in one transaction, so the alarm picks up after a crash without losing or leaving a file. Empty Trash covers every drive where the person has Can edit or is a Manager, including what others deleted, and its confirmation says so.
- **A move between drives keeps the bytes where they are.** The new drive's row points at the same R2 object. The two objects can't share a transaction, so for a moment both hold a row for one object. Both rows stay locked through that moment. The sender locks its rows, the receiver adds locked rows, the sender removes its own, and only then does the receiver unlock. A locked row can't be renamed, moved, deleted, or shared by anyone, including through a share, so at most one drive can delete the bytes at each step. Taking a share away still works at once, because shares don't travel with a move. Each repeat of a step changes nothing. A refusal unlocks the sender at once. If the receiver never answers, the sender gives up after an hour, unlocks, and keeps the file, and the alarm keeps telling the receiver to drop its locked rows, which go without touching R2. A folder of more than 2,000 items is refused, because it must fit in one call.
- **A locked folder refuses restores, new folders, and moves into it** for now, with a request to try again in a minute. An upload finishing into it keeps trying by itself.
- **A move that doesn't happen says so.** A refusal while the person waits shows in the move dialog. A later refusal or give-up leaves a note for them at the top of every Storage page until they choose OK. Nobody else sees it, and if they can no longer open the item, the note leaves out its name. The note is written in the transaction that unlocks the item, so a retry can't lose it or write it twice. D1's `drive_move_notices` says which drives hold a note for a person, with no names.
- **An upload whose folder went to Trash lands at the drive's root,** so the file isn't lost with the folder. If the folder was deleted forever or moved to another drive, the upload stops and says so.

### Uploads

Uploads use the same 10 MB parts as [Mail import](#mail-import), up to 100 GB, three parts at a time.

- If the connection drops, the upload retries with a growing delay, and the tray says it is waiting. Parts already stored are never sent again.
- After a reload, choosing the same file in the same folder carries on. A match needs the folder, name, size, person, modified time, and a hash of the first and last 1 MiB of the file. So an edited copy starts over, unless the edit changes neither the modified time nor the start or end of the file.
- Stopping the upload in the tray keeps what was stored, so choosing the file again carries on.
- An upload with no new part for 3 days is removed, and any unfinished upload is removed 7 days after it started, before R2's own clean-up drops it.
- A finished file takes its upload's id, so finishing twice changes nothing.

### Attachments from your mail

Home lists the newest 5 attachments across every mailbox a person can reach, each with a button that saves a copy to My files.

- **What it leaves out.** Spam, Trash, drafts, and inline images such as signature logos. Only Inbox, Sent, and Archive count, so a folder added later stays out until someone decides otherwise.
- **When it's hidden.** Mail is off, the person has no mailboxes or attachments, or reading mail fails. Home's first HTML doesn't wait for this section, and a failure can't break Home. Nothing from mail shows inline in Storage. Names and senders are plain text with hidden characters removed.
- **A save is a normal upload** in the Worker, one 10 MB part at a time, so the bytes pass through neither Durable Object and every upload rule applies. A name an upload would refuse is cleaned rather than refused, because nobody can be asked for another.
- **Access is checked by id when saving,** and again for each part. Someone removed from a shared mailbox can't save from it, and an attachment moved to Spam or Trash can't be saved.
- **What's stored.** D1's `saved_mail_attachments` holds a row for each save, with the person, mailbox, message, attachment, and copy ids, and no name, sender, or content. It makes a double click or a retry store one file, and shows the row as saved after a reload. It is in D1 because reading mail must not write to the mailbox.
- **A saved copy is a separate file.** It stays in My files when the mail is deleted or the person loses access to the mailbox, and follows Storage's rules from then on.

### Removing a person

Removing a person hands over their files, calendars, and boards, and deletes none. The admin chooses who receives them.

- Their My files becomes a team folder named after them, managed by that person, with no per-person limit. A team folder only they were on goes to the same person.
- A team folder they managed alone but shared with others stays with those people, so nobody new sees its files. The person there longest with Can edit becomes Manager, or the person there longest if everyone left has Can view.
- Handing over is one D1 transaction, before the account goes, so choosing Remove again after a failure finishes the job. Files from someone removed before handover existed wait on the People page for an admin to choose someone. Admins can't browse files otherwise.
- [Calendar](#personal-and-team-calendars) and [Tasks](#private-tasks-and-team-boards) say what happens to their calendars and boards.

## Calendar

Calendar replaces Google Calendar. A person lands on Overview, and Schedule holds the full calendar. The sidebar holds Overview, Schedule, the list of calendars with a checkbox to show or hide each one, and New team calendar. Each calendar on the list opens its settings.

### Overview and Schedule

- **Overview shows what's next.** It shows the next event today, with how long until it starts, who's coming, and who hasn't replied. With nothing left today, it names the first event tomorrow. Today's all-day events sit in the heading. A This week strip shows Monday to Sunday as dots, with each day linking to Day view. Rest of today folds finished events into "N finished earlier", and Tomorrow and Invitations follow.
- **Invitations on Overview are the unanswered invitations in the person's own calendar,** however they arrived. Overview doesn't scan mailboxes, so the section works with Mail off, and it shows even when the rest of Overview can't load.
- **New event works on Overview too,** starting at the next half hour. After a save, a note names the day the event first happens, with Show in Schedule. That day can come after the start, because a weekday repeat that starts on a Saturday first happens on the Monday. Without the note, an event beyond tomorrow would seem to vanish.
- **Schedule has Day, Week, and Month.** In Week and Month, an event opens in a small card beside it, so the grid keeps its width, and Open details goes to Day view with the full panel. In Month, clicking a day opens it in Day view. Clicking an empty slot in Day or Week starts a new event there. Overlapping events sit side by side.
- **The toolbar has Go to today, previous and next, and a date title that opens a month picker.** There is no mini month in the sidebar, because the title picker does the same job without taking room from the calendar list.
- **Overview and Schedule also show the person's own tasks due,** as [Tasks in Calendar](#tasks-in-calendar) describes.
- **Unanswered invitations show dashed.** Events answered No and cancelled events are struck through.
- **Keys.** N starts a new event and / goes to search, in Schedule and on Overview. Esc closes a dialog anywhere. In Schedule, T goes to today, D, W, and M switch views, the arrows move to the previous or next period, and Esc closes the open card, panel, or month picker.
- **Search finds events by title, place, and notes,** across the calendars the person can see and hasn't hidden, past and future. Each word must start a word, in any order, whatever the case or accents, as in [Storage](#search-and-starred). Calendar has no operators or quoted phrases, so anything typed is read as plain words. Events still to come show first, soonest first, then past events, newest first. A repeating event shows once, at its next date, or its last if the series has ended. Calendars are asked five at a time for up to 5 seconds, and a note says if any couldn't be searched. A result opens in Day view.
- **A hidden calendar stays hidden for that person on every device,** because it is a flag on their own `calendar_access` row. It is left out of Schedule, search, and Overview, except that unanswered invitations always show on Overview, so none can be missed.

### Personal and team calendars

- **Each person has one personal calendar, which only they see.** It is made on first use, not on first look, like My files. Any first change makes it, such as an event, an invitation, an import, a new colour, or hiding it. The database allows one for each person. It can't be deleted, because invitations land there.
- **A team calendar is its own member list,** like a team folder, with the same roles. Anyone signed in can make one and becomes its Manager. A Manager adds and removes people, sets each to Can view, Can edit, or Manager, renames the calendar, changes its colour, and deletes it. The last Manager can't leave or step down. Everyone on it sees who else is. Deleting it removes its events and cancels everyone's copies, so the confirmation counts them.
- **Can view is read-only, on the server.** The Calendar object refuses adding, changing, or deleting an event itself, so a hidden button is only a courtesy.
- **A calendar's colour is one of the six team colours,** the `avatar-1` to `avatar-6` roles. A personal calendar starts as `avatar-4`, and its person can change it. New team calendars cycle through the other five, because in the design concept a blue personal calendar was hard to tell from a blue team calendar beside it.
- **One access check.** `checkCalendarAccess` is the only thing that issues a calendar's grant. Every read and write goes through it.
- **Each calendar is one SQLite-backed Durable Object** that holds its events. D1 holds `calendars` and `calendar_access` and nothing about events, so an event's title, time, and people live in one place.
- **One event shows once.** If a person sees a team calendar and is also invited to one of its events, it shows once, as their own copy with their answer. The copy names the calendar and UID it follows, and that pair is what is matched.
- **Removing a person hands over their personal calendar.** It becomes a team calendar named after them, such as "Sam Rivera's calendar", managed by the person the admin chose for their files, in the same D1 transaction. It takes the next team colour. A team calendar they managed alone is handed over like a [team folder](#removing-a-person). Events they organised stay in other people's calendars with their name as organiser, and anyone with Can edit on the team calendar can still change them.

### Events

- **An event has a title, a day, a start and an end or all day, a repeat, a place, notes, and people.** An event can span several days, and shows as one bar across them.
- **A repeat is Every day, Every weekday, Every week, Every fortnight, Every month, or Every year,** and ends never, on a day, or after a number of times. A repeat with no dates, such as every weekday from a Saturday to the Sunday, or one whose every date was removed on its own, isn't saved. The dialog asks for the nearest end of the same kind that gives it a date, or a last date when that would be more than 999 times.
- **Changing or deleting a repeat asks "Only this one", "This and later ones", or "All of them".** "This and later ones" ends the old series the day before the chosen date and starts a new one with a new UID, so earlier dates stay as they were and people invited get an update and a new invitation. A count-limited series splits without adding dates. A date removed or changed on its own moves as far as the rest and keeps its own changes. Only what the person changed in the dialog spreads to the other dates. When the chosen date moves to another day, the new series moves to that day too, unless the old series still has a date on or after it. Then only the chosen date moves.
- **A repeat rule from outside that the dialog can't show is kept as written** and shown read-only. A rule is checked before ical.js works out its dates, because some rules make ical.js loop forever. One that fails the check shows only its first date, and the import summary or the invitation says so.
- **Dates are worked out only for the range on screen,** at most 1,000 in one range, so a huge series can't stall a page. Overview says when a week has too many events to show.
- **A timed event keeps its own time zone and shows in the viewer's.** A weekly 9:00 meeting in Sydney stays at 9:00 in Sydney across a daylight-saving change. **An all-day event is a date,** so a holiday on the 25th is on the 25th everywhere.
- **The person who makes an event is its organiser.** Anyone with Can edit on a team calendar can change or delete its events. A change goes out from the organiser's address with a higher sequence, whoever made it, because other calendar apps trust updates only from the organiser. If the organiser was removed or has no personal mailbox, changes still reach people inside the organisation, but not outside, and the dialog says so. Each event keeps its organiser's name after they're removed.
- **Notes and places are plain text.** Only `https` links in them are clickable, and each opens in a new tab with no referrer. An invitation from outside writes these fields, so they are treated as hostile.

### Invitations

- **Anyone in the directory can be invited, and so can any email address,** up to 100 people an event. Typing a colleague's primary address or an alias of their personal mailbox invites that colleague.
- **A colleague gets the event straight in their personal calendar,** made then if needed, unanswered and dashed, so it's there before they open their mail.
- **Everyone invited who has an email address gets an iMIP email of their own.** iMIP is the standard way calendars send invitations by email, so any mail app can answer. Each email has the text/calendar part that Outlook and Gmail answer from, and the same event attached as `invite.ics`. One email per person lets each answer for themselves and stays inside Cloudflare's 50-recipient limit. A colleague with no personal mailbox gets the event but no email.
- **Invitations and replies go from the primary address of the sender's personal mailbox,** the organiser's for an invitation and the answering person's for a reply, because a shared mailbox belongs to no one person. Without a personal mailbox, someone can invite colleagues but not outside addresses, and the dialog says why and offers no addresses.
- **Calendar sends its own invitation emails** through the same Cloudflare sending as Mail, from a queue in the calendar's object, run by its alarm. An editor of a team calendar must be able to send from the organiser's address without the organiser's mailbox, so no mailbox's access check is loosened. These emails skip the 10-second undo and leave no draft and no Sent copy. The event's People list is the record of who was invited. A copy sent inside the organisation arrives through `ingest` like any inbound mail.
- **[Mail's sending rules](#sending) apply to this queue.** Each email is written from the event as it is when it goes. Before each attempt, it checks that Calendar and Mail are on, that the person who made the change can still edit the calendar, or still owns it for a reply, that they aren't banned, and that the address still belongs to its personal mailbox. Cancellations from a deleted team calendar skip only the edit check, because its Manager was checked when deleting it.
- **A rate limit or a directory that can't answer retries by itself,** up to three times over about 13 minutes, then the email is refused. Nothing is resent by guesswork. If it's unclear whether an email went, the People list says to check with that person. An email that didn't go shows as "Not sent to" and the person's name, with what happened and Try again. Someone taken off the list stays under "Taken off the list" until their cancellation goes. A deleted event's failed cancellations show in the calendar's settings under "Cancellations not sent". A retry checks first whether the email already went. Emails queued when Calendar is turned off don't go, and show as "Not sent to" with Try again once it is back on.
- **Calling off one date sends a cancellation for that date alone,** with `METHOD:CANCEL` and that date's `RECURRENCE-ID`, per RFC 5546. Someone who never got the event, or whose email waits behind another change, gets the whole event as it is then.
- **With Mail off, invitations inside the organisation still work.** The dialog says people outside won't get an email, and offers no addresses.
- **Answering is Yes, Maybe, or No,** from the card, the panel, Overview, or the card in Mail. An answer inside the organisation goes straight to the calendar that holds the event, which each copy records. An organiser outside gets an iMIP reply email. When Mail is off or the person has no personal mailbox, the buttons say the organiser won't be told.
- **The People list shows the organiser and everyone's answer,** with "No reply yet" for outside addresses, and the card sums them up. Overview's next event says who's going and who hasn't replied.
- **Changes and cancellations reach every copy.** A cancelled event or date stays on the copy, marked cancelled, with Remove from my calendar, so someone sees it was called off rather than finding it gone. Who's invited can change for this and later dates or for all of them, not for one date. Someone taken off finds their copy cancelled. Someone put back gets every date back and is asked again, though an answer still on its way to the organiser stays.
- **An invitation copy can't be edited or deleted** unless the person can also edit the organiser's calendar, in which case Edit and Delete change the organiser's event. Otherwise they can answer it or remove it, and removing a repeating copy asks how far. The organiser's event is the one everyone follows, so a change made in one copy would leave the others out of step.
- **A copy is never added twice.** The UID names the event, with the `RECURRENCE-ID` for one date of a repeat, and the sequence says which version is newer. A copy no newer than the one held changes nothing, so mail arriving again changes nothing. Each change in Calendar takes a sequence higher than any the event holds. An import keeps each file's own sequences, and a series at the same sequence with more dates called off counts as newer.
- **A colleague's copy is named by the calendar it came from and the UID together,** because anyone can import a file with any UID. So one calendar's copy never replaces another's.
- **A removed event stays removed.** Removing keeps its UID and sequence, so neither the same invitation nor a newer version brings it back. The one exception is a copy from outside that came without proof, which the organiser's own proven invitation replaces, as the next section says. No change from the organiser brings back a removed date, not even moving every date to a new time, because a removed date is kept by its day in the event's time zone. Moving every date to another day brings it back on its new day. Add to my calendar in Mail overrides a removal, because that is the person's choice too.
- **Copies and answers inside the organisation go from each object's queue,** which retries at least once an hour until it goes and drops a delivery to someone removed from the organisation. While Calendar is off, the queue waits.

### Invitations from outside

- **An email to a person's own address that carries an iCalendar invitation adds the event to their personal calendar,** unanswered, and lists it in Overview's Invitations. That covers Google, Outlook, and any app that sends iMIP.
- **Some mail adds nothing.** Mail to a shared mailbox adds nothing, because the mailbox belongs to no one person. Mail in Spam adds nothing, including mail moved there before Calendar reads it. Mail a rule sorts elsewhere still adds the invitation. Imported mail adds nothing, because import brings in history. Mail that arrives while Calendar is off adds nothing. A colleague's invitation email adds nothing beside the copy their calendar already sent. A new invitation needs no proof of its sender, so one from a stranger that reaches the Inbox is added.
- **Invitations don't catch up later.** Marking mail Not spam, or turning Calendar back on, adds nothing by itself, so nobody is handed a pile of old events. The card in Mail offers Add to my calendar instead.
- **While Mail is off, an invitation still reaches Calendar,** because inbound mail still reaches `ingest`. While Calendar is off, updates, cancellations, and replies change nothing, and the emails still arrive as mail.
- **An update or cancellation counts only from the organiser's own address, with proof for that address's domain.** Anyone can write an organiser's address into an invitation, and proof of the domain alone would let anyone on gmail.com forge an update for another Gmail user. The proof is Mail's stored check from [Spam filtering](#spam-filtering): DMARC passed, or DKIM passed for that domain or a parent of it. A reply works the same way with the attendee's address, and updates only that attendee's answer. A reply in Spam changes nothing. Mail that doesn't count stays an ordinary email.
- **A reply finds its event by UID,** first in the organiser's personal calendar, then in the team calendars where the organiser can edit, five at a time. If none holds it, the reply stays an ordinary email.
- **A copy from outside is named by its organiser's address and the UID together.** Anyone invited knows the UID and could send an invitation with it. A forgery naming someone else as organiser shows beside the real one. The organiser's own proven invitation or cancellation replaces a copy that came without proof, whatever sequence it named, even once the person removed it.
- **The person shows in People by their own name from the directory,** never a name the sender chose.
- **Mail hands each such message to Calendar from its own queue** once the message is stored, a few at a time, so Calendar can't lose mail and a flood only slows other mail briefly. Mail gives up after 30 tries, about a day, and leaves the email as it came. Only the first three calendar parts of an email are read, each up to 256 KB and 200 events, and only the first 20 events are added, changed, or answered.
- **Answering an invitation from outside sends a reply email** from the person's own address through the calendar's email queue.

### Invitation cards in Mail

A message that carries an invitation, update, cancellation, or reply shows a card above it, on Mail's own page, outside the message's sandboxed frame. The card reads the person's own calendar, whichever mailbox the message is in, and shows the event as the calendar holds it, or as the email gives it. It shows what, when, where, who organised it, and Join. It covers the first event an email carries, read within the hand-off's limits.

- An invitation in the calendar has Yes, Maybe, and No, which answer as Calendar does.
- An invitation that isn't in the calendar, such as from a shared mailbox, imported mail, or mail that came while Calendar was off, has Add to my calendar. That overrides a removal, adds the email's version unanswered, and changes nothing when pressed again. An email that covers only some dates of a repeat has no Add to my calendar. A colleague's removed invitation comes back only from an email the sender check confirms. One that never reached the calendar offers nothing to add, because the copy follows the organiser's calendar.
- An update says when the calendar holds a later version, or that the sender couldn't be confirmed.
- A cancellation of the whole event says whether the calendar marks it cancelled, with Remove from my calendar while it is there. A cancellation of some dates says whether the calendar marks that date cancelled, and has no Remove button.
- A reply says who answered and how, and whether the answer is in the calendar.
- With Calendar off, the card shows the email's details, says Calendar is off, and has no buttons, and Calendar refuses the card's actions.

Mail stores its sender check with each message as it arrives, because the check needs facts about the From lines that aren't kept.

### Join buttons

- **An event shows "Join Google Meet", "Join Microsoft Teams", "Join Zoom", or "Join Webex"** when it carries an `https` link on that service's own host: `meet.google.com`, `teams.microsoft.com`, `teams.live.com`, `zoom.us` or `*.zoom.us`, or `webex.com` or `*.webex.com`. Any other link gets no button, so an invitation can't dress up an address as "Join". A look-alike host, a port other than 443, or a name before the host, as in `https://meet.google.com@evil.com`, gets none either.
- **The link comes from the conference field first, then the place, then the notes.** The conference field is Google's `X-GOOGLE-CONFERENCE` or Outlook's `X-MICROSOFT-SKYPETEAMSMEETINGURL`, falling back to `X-MICROSOFT-ONLINEMEETINGEXTERNALLINK`. It leads because meeting services put the link there, not because it can be trusted. The exact-host check is what protects people.
- **The button shows in the card, the panel, and Overview's next event.** The panel prints the address under it only for a conference link, since the place and notes already show theirs. A cancelled event or date has no Join button and is never Overview's next event.
- **No Google or Microsoft account or API is needed.** People can paste a meeting link into Where for their own events.

### Import

Anyone who can edit a calendar can import a `.ics` file into it from its settings, of up to 4 MB and 10,000 events. The summary says what was added, updated, left as it was, and skipped and why.

An event already there, matched by UID, is updated rather than copied, under the same sequence rule as invitations. So importing the same file twice changes nothing, and an older file can't undo a later change. Import can't change what the person couldn't change by hand, so an invitation copy stays as it is. An event with the same UID as an invitation is added beside it as the person's own, because a copy is named by where it came from. An imported event keeps its conference link.

## Tasks

Tasks replaces Google Tasks and simple team to-do boards, and should feel like Reminders made for a team. A person lands on My tasks. A team board lists its tasks in three sections, and a task opens in a panel beside the list. The layout was chosen from a throwaway concept with three layouts, compared by three reviewers on different models and a judge.

### My tasks and boards

- **My tasks lists a person's open work across every board,** meaning the open tasks assigned to them on team boards plus their private tasks. It groups them as Overdue, Today, Tomorrow, Later this week, Later, and No date, soonest first. Later this week runs through Sunday, the week Calendar's Overview uses. A task in progress says Doing. Tasks done today fold into "N done today", with Show.
- **My tasks asks each board the person is on,** five at a time, and stops asking after 5 seconds, as Calendar's search does. If a board couldn't be read, a note says so.
- **A board lists its tasks as Doing, then To do, then Done.** Doing comes first so a long To do list never pushes work in progress out of sight. Each section shows the soonest due first, and undated tasks last. Done is folded into "N done", with Show, most recently done first. A board has no columns, because no other app in the suite uses them, and a list reads the same on a phone.
- **A done task stays.** It never clears itself, it folds away, and search still finds it. Only Delete removes a task.
- **The circle beside a task marks it done,** with Undo, and choosing it again sets the task back to To do. The panel's To do, Doing, and Done control changes the status. Nothing shows only on hover, because a phone has no hover.
- **New task, or N, starts a row at the top of the list.** It offers Today, Tomorrow, or a date, and on a team board someone to assign. On My tasks the new task is private. On a team board it starts as "Nobody yet", so adding a task for the team doesn't quietly make it yours. No text in a title is read as a date, so a title is never cut short. There is one way to add a task, like Calendar's one New event.
- **The panel is 300 pixels wide, like Calendar's, and fills the screen on a phone.** It edits the title, the status, the assignee, the due date, the board, the notes, and the checklist in place. While it's open, My tasks drops everything beside its list, so the list keeps its width.
- **The sidebar holds My tasks, then Team boards, then New team board.** On a phone it's the shell's usual menu.
- **Keys.** N starts a new task, / goes to search, and Esc closes the panel or a dialog, or leaves the search box.
- **An empty page says what to do next,** such as "Ben has no tasks on Marketing", or on a new board, "Add the first task with New task".

### A task

- **A task has a title, a status, one assignee or nobody, a due date or none, notes, and a checklist.** The status is To do, Doing, or Done on every board. A board can't add or rename them, so no board needs setting up.
- **A due date is a date, not a time,** like an all-day event, so it's the same day in every time zone. Overdue and Today follow the viewer's device date.
- **A task doesn't repeat.** Calendar handles things that happen on a schedule.
- **Notes are plain text.** Only `https` links in them are clickable, and each opens in a new tab with no referrer.
- **A title holds up to 200 characters, notes up to 10,000, and a checklist up to 50 items of up to 200 characters each.** The server refuses more in plain words.
- **Each task keeps the names of the person who added it and the person it's assigned to,** so both still show after either is removed.
- **Delete has Undo for 10 seconds,** like Mail's undo send. The board's alarm then deletes the task for good.
- **A task holds no files.** See [Open questions](#open-questions).

### Private tasks and team boards

- **Each person has private tasks, which only they see.** They live on the person's own board, made on first use, like My files, because no `GET` request changes a person's data. The database allows one for each person, so two tabs can't make two. A private task has no assignee, and its Board row moves it onto a team board.
- **A team board is its own member list,** like a team folder or a team calendar, with the same roles, so there are no organisation-wide teams to keep in step. Anyone signed in can make one and becomes its Manager. A Manager adds and removes people, sets each to Can view, Can edit, or Manager, renames the board, changes its colour, and deletes it, and the confirmation says how many tasks go with it. The last Manager can't leave or step down.
- **A board's colour is one of the six team colours.** New boards cycle through the five that aren't a personal calendar's `avatar-4`, as team calendars do.
- **Can view is read-only, on the server, with one exception.** It sees every task. It can't add, change, move, or delete one, except that it can change the status of a task assigned to it, so people can tick off their own work. The Board object makes this check in the same call that does the work, so a hidden button is only a courtesy.
- **Anyone with Can edit can assign a task to anyone on the board, Can view included.** The picker, search, and filters list the board's members first, then everyone else in the organisation.
- **Only a Manager adds someone to a board while assigning,** because only a Manager adds members anywhere in the suite. A Manager who picks someone from outside is asked "Add Ben Hart to Marketing?". Add and assign adds them with Can edit, the team folder default, then assigns them. Anyone else is told "Ask a Marketing manager to add Ben."
- **Someone taken off a board, or who leaves it, keeps their tasks there.** Each shows their name and "No longer on Marketing", so the team sees who had it and anyone with Can edit can reassign it. It leaves their My tasks, because they can't open the board.
- **One access check.** `checkBoardAccess` is the only thing that issues a board's grant, and every read and write goes through it. The alarm deletes for good, and unlocks or drops a moved copy, without asking again, because it only finishes what was already approved. Handing a copy to the new board checks the mover's access there again.
- **Each board is one SQLite-backed Durable Object** that holds its tasks and checklists. D1 holds `boards` and `board_access` and nothing about tasks, so a task's title, notes, and people live in one place.
- **Removing a person hands over their private tasks.** Their own board becomes a team board named after them, such as "Sam Rivera's tasks", managed by the person the admin chose for their files. A team board they managed alone is handed over like a team calendar. Both happen in the same D1 transaction as the files.

### Moving a task

- **A move needs Can edit on both boards, and works like [Storage's move between drives](#files-trash-and-moves).** Two board objects can't share a transaction, so both copies stay locked through the moment both boards hold the task. The sender locks its task, the receiver adds a locked copy, the sender deletes its own, and only then does the receiver unlock. A locked task can't be changed, moved, or deleted.
- **Each move has its own id, and the receiver remembers it,** so repeating a step changes nothing, and a late repeat can't bring back a task that has moved on. The sender's alarm asks again every minute. A refusal, such as a deleted board or lost Can edit, unlocks the sender at once. If the receiver hasn't confirmed after an hour, the sender unlocks and keeps the task, and its alarm keeps telling the receiver to drop its locked copy for that move. Once the receiver has confirmed and the sender has deleted its copy, the sender never gives up, because only that copy is left.
- **A task never shows twice.** It shows on the board it's leaving as "Moving to …", until that board lets it go, then on the new board once its copy unlocks. For the moment between, it shows on neither. My tasks and search follow the same rule.
- **An assignee who isn't on the new board doesn't go with the task,** and the dialog says so first. A task moved to private tasks always arrives with nobody assigned.
- **A move that doesn't happen says so.** A later refusal or give-up leaves a note for the mover at the top of every Tasks page until they choose OK. D1's `board_move_notices` says which boards hold one.

### Search

- **Search finds tasks by title and notes** on every board the person is on, private and done tasks included, on a page of its own as in Calendar. Matching works like [Storage's](#search-and-starred) words, with no operators. Results come under Still to do, soonest due first, then Done, most recently done first, each with its board or "Only you". It shows up to 50 tasks for each board and 100 in all, and says when there are more. Boards are asked five at a time for up to 5 seconds, and a note says if any couldn't be searched.
- **A result opens on its board with the panel.** A private task opens on My tasks, or on the person's own board once it was done before today, because My tasks no longer lists it.
- **Search also lists up to 8 people in each of its two groups, never with how many tasks they have,** because that would show a colleague's workload. Nobody suspended is listed. From a board, it lists the board's members, then others, and choosing someone shows only their tasks there, in a chip that clears it. From anywhere else, it lists the people the searcher shares a board with, then everyone else, and choosing someone lists their open tasks on those shared boards.

### The assignment email

- **Someone assigned a task by someone else gets an email.** It goes from the primary address of the assigner's personal mailbox, the address people know them by. It names the task, the board, and the due date, with Open task, and leaves out the notes. If either person has no personal mailbox, there's no address to send from or to, so the assignment stands and the panel says the person wasn't emailed.
- **It waits in the board object's own queue until Undo has passed,** then goes through the same Cloudflare sending that Calendar uses. Before each attempt, it checks that Tasks and Mail are on, that the task is still assigned to that person on that board, that they can still open the board, that the assigner can still edit it and isn't banned, and that the address still belongs to the assigner's personal mailbox. So a task reassigned or moved within those 10 seconds sends nothing.
- **Nobody gets an email about a task they assigned themselves,** and there is no daily summary.
- **A rate limit or a directory that can't answer retries by itself,** up to three times over about 13 minutes, then the email is refused. Nothing is resent by guesswork. A refused email leaves the assignment as it is, and the panel says "Ben Hart wasn't emailed", with the reason and Try again. If it's unclear whether the email went, it says "Ben Hart may not have been emailed".
- **These emails leave no draft and no Sent copy.** A copy to someone inside the organisation arrives through `ingest` like any inbound mail.

### Tasks in Calendar

- **Calendar's Overview has a Tasks due section** with the person's own open tasks that are overdue, due today, or due tomorrow, soonest first, and Open in Tasks. Ticking one there marks it done in Tasks, with Undo, under the board's own rules.
- **Schedule shows the person's own open tasks due in the days on screen,** in the all-day row of their due day.
- **A task is never stored as an event.** Calendar asks the boards each time, so a task lives in one place. If a board can't be reached, a note says some tasks may be missing.
- **Both are hidden while Tasks is off,** and ticking checks that Tasks is on, because a server function answers on every app's hostname.
- **Only the person's own tasks show,** never a colleague's, because showing when someone is busy is an [open question](#open-questions).

## Privacy

CloudySuite relies on Cloudflare's encryption at rest. Cloudflare and the organisation's admins are inside the trust boundary, and CloudySuite isn't end-to-end encrypted. In exchange, server-side search and rules work with no extra steps.

**Saved mail on a device isn't encrypted by CloudySuite.** For offline reading, Mail keeps up to 50 MB of recent mail for each mailbox in the browser, along with any words that couldn't be saved yet. Anyone who can get into that device and read the browser's files can read them.

**A device kept offline can show its saved mail for up to 59 days,** even after the person signed out elsewhere or an admin removed their access. It can't find out until it next connects, and then it clears itself.

**If a device is lost,** an admin should reset that person's sign-in straight away, which protects everything on the server. The device can't be erased until it next comes online and opens Mail, so until then only its own lock protects the saved mail. Ask people to keep a passcode or password on any device they use for Mail.

Jev is outside the trust boundary. With no key, no message content goes to it. With a key, [Optional Jev integration](#optional-jev-integration) lists what is sent and when.

## Cloudflare limits and costs

These limits come from Cloudflare's docs and shape the product:

- Sending to any recipient needs the Workers Paid plan. It includes 3,000 outbound emails a month, then costs $0.35 per 1,000.
- New accounts start with a low daily sending quota that Cloudflare raises over time.
- A message can be at most 25 MiB, inbound or outbound, including attachments. Inbound mail is rejected over that size, and for an address with no mailbox.
- A message can have at most 50 recipients across to, cc, and bcc.
- Cloudflare generates each outgoing `Message-ID`, and its docs don't say whether the `messageId` that `send()` returns is the same value. Threading works either way, as [`threading-headers.ts`](apps/mail/src/compose/threading-headers.ts) explains.
- A SQLite-backed Durable Object stores up to 10 GB, and a row holds up to 2 MB, so large bodies, attachments, and files go in R2.

## Design

CloudySuite uses the Daylight direction. It is calm, neutral, and familiar, with blue for the next action. A left sidebar holds the app switcher and each app's places, and Mail has a message list beside a reading pane. [The design trial](https://github.com/Setupless/cloudysuite/blob/17574a1/prototypes/look-and-feel/index.html) shows Daylight and the three rejected directions on each screen, in light and dark. It is no longer in the repository, so open that revision for visual reference only.

Appearance follows the device's light or dark setting. Setting `data-theme="light"` or `data-theme="dark"` on the `html` element overrides it.

### Change the palette

Every colour lives in [`src/styles/theme.css`](src/styles/theme.css) as a role, such as `--color-accent`, with a light and a dark value. Tailwind turns each role into classes such as `bg-accent` and `text-secondary`, and the theme removes Tailwind's default colours. Editing this one file recolours the product.

1. Edit the values in `src/styles/theme.css`. For a new accent, change `--color-accent`, `--color-on-accent`, and `--color-selected`.
2. Run `bun scripts/check-theme.mjs`.
3. If the accent changed, run `bun scripts/generate-app-icons.mjs`. Mail's app icons are images, so a test fails until they match the theme. The build reads the manifest's colours from the theme.

The script fails if a text and background pair is below the WCAG AA contrast ratio of 4.5, if a role is missing, or if a file in `src`, `apps`, or `packages` has a colour value outside the theme file or loads `app.css?url`. It doesn't catch a misspelled class. `bg-acent` builds with no error and renders no colour.

### Load the stylesheet

Import `src/styles/app.css` in the root route with `import "../styles/app.css"`. Don't use `app.css?url` with a `head()` link. In our test, the server and client builds then disagreed on the file name, the first HTML linked a stylesheet that returned 404, and the page stayed unstyled until JavaScript ran.

## Architecture

- **One Worker serves every app and routes by hostname,** because the Deploy button doesn't deploy several Workers from one repository together. Its Durable Object classes are `Mailbox`, `Drive`, `Calendar`, and `Board`, and it needs no queues or other services.
- **Each mailbox, drive, calendar, and board is one SQLite-backed Durable Object.** Large bodies, attachments, and files go in R2.
- **D1 holds the directory and the indexes into the objects.** That means domains, the Better Auth tables, mailboxes, addresses, mailbox access, invites, organisation and app settings, Jev usage, push subscriptions, drives, drive access, calendars, calendar access, boards, and board access. It also holds `saved_mail_attachments`, `drive_shares`, `drive_move_notices`, and `board_move_notices`, which point into objects but hold no content. [`src/db/schema.ts`](src/db/schema.ts) is the full list.
- **Every mailbox, drive, calendar, or board read and write goes through one access check,** because several people can share one.
- **Background work runs on Durable Object alarms,** and every job is safe to repeat.
- **A page starts loading before the click lands.** Resting the pointer on a link loads its code and data, and a click starts the data request as the navigation starts. So a route's `beforeLoad` and `loader` only read. A progress bar shows after 150 ms, and a skeleton over the old page after 400 ms.
- **The Worker uses Smart Placement,** because one page load makes several D1 queries in a row, and running near the database saves a long trip on each.

The repository is a Bun workspace that builds into the one Worker:

| Path                  | Contents                                                                     |
| --------------------- | ---------------------------------------------------------------------------- |
| Repository root       | Wrangler, Vite, and Drizzle config, `build` and `deploy` scripts, migrations |
| `src`                 | Worker entry, hostname routing, every route file, the D1 schema, and theme   |
| `apps/<app>`          | One app's UI and server code: `auth`, `mail`, `storage`, `calendar`, `tasks` |
| `packages/access`     | The access checks for mailboxes, drives, calendars, and boards               |
| `packages/app-email`  | The raw emails Calendar and Tasks send, and who may send them                |
| `packages/jev`        | The Jev client, key, and usage                                               |
| `packages/object-sql` | Durable Object SQLite access and migrations, with a Bun test driver          |
| `packages/search`     | Search words and asking several objects at once                              |
| `packages/transfer`   | Multipart upload, download headers, and byte sizes                           |
| `packages/ui`         | The shell, toasts, links, and shared components                              |

The Deploy button treats a subdirectory as [the root of the new repository](https://developers.cloudflare.com/workers/platform/deploy-buttons/), and the app inside must be fully isolated. A Worker in `apps/worker` would lose its workspace siblings, so the Worker stays at the root and the button points at the root. A real Deploy button run accepted this layout.

## Develop

[AGENTS.md](AGENTS.md) lists the everyday commands. One Worker routes every app by hostname, and agents work in parallel worktrees, so each checkout needs its own stable app hostnames without port numbers. [portless](https://github.com/vercel-labs/portless) provides them.

1. Run `cp dev.vars.local.example .dev.vars` once in each checkout to get the local sign-in secret. A deployment doesn't use this file, because the wizard generates its secret.
2. Run `bun run db:migrate:local`, `bun run db:seed:local`, and `bun run db:seed:user:local <email> <password> [admin|user]`.
3. Run `bun run dev`. The first run asks for `sudo` to bind port 443 and trust a local certificate. It starts the proxy with wildcard routing, because every app shares one Vite server.

A proxy already running without wildcard routing returns a portless 404 for every app. Run `bunx portless proxy stop`, then start again. `bunx vite dev` skips portless and serves the same hostnames on port 5173.

Bun runs the tools and `bun test`, but production code runs on the Workers runtime. A passing `bun test` doesn't prove behaviour that depends on the runtime, such as Durable Objects or the `email()` handler, so run that under `wrangler dev` too.

### Try the wizard locally

The fake API in `apps/auth/scripts/fake-cloudflare.ts` runs the setup wizard without a Cloudflare account.

1. Remove `.wrangler/state`, then write `CLOUDYSUITE_LOCAL_CLOUDFLARE_API=http://127.0.0.1:8799/client/v4` as the only line in `.dev.vars`.
2. Run `bun apps/auth/scripts/fake-cloudflare.ts`, then `bun run build`, `bun run db:migrate:local`, and `bunx wrangler dev`.
3. Open `http://localhost:8787` and paste `owner-token-owner-token-owner-token`. The script also has a stranger's token, a read-only token, and `no-workers-token-no-workers-token`, which can see no Workers.
4. When the wizard waits for its new secret, restart `wrangler dev`. A real Worker restarts by itself.

To try the Jev check without a key, add `CLOUDYSUITE_LOCAL_JEV_API=http://localhost:9911` to `.dev.vars`, run `bun apps/mail/scripts/fake-jev.mjs`, then save any key on the Organisation page. The script says how to make it fail. Both variables are ignored unless they name a loopback address, and they come from the environment, so a request can't set them.

### Git and CI

`main` is what the Deploy button copies, so it must always be deployable. Work happens on short-lived branches that merge through a PR. A `develop` branch would add a second state to keep healthy, and deployers would never see it.

A ruleset on `main` blocks direct pushes, force pushes, and deletion. It requires a PR, a passing `check` job on an up-to-date branch, resolved review threads, and linear history. Squash is the only merge method, so each PR becomes one commit and its title becomes the commit subject. No approving review is needed while one person maintains the project. [`.github/rulesets/main.json`](.github/rulesets/main.json) defines the ruleset. GitHub Free applies rulesets only to public repositories, so this repository must stay public or move to a paid plan.

The `check` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `bun run check` on every PR and every push to `main`. On a PR, it also checks the format of the branch name and the title.

## Tech stack

We build around the TanStack libraries, so the product is fast for the people using it and pleasant to work on. We accept release candidates and pre-1.0 releases, because we expect them to be stable before our first release. Better Auth is the exception, as [Auth](#auth) explains.

- TanStack Start, Router, Query, and Hotkeys, on React 19. TanStack DB and Form aren't used. Mail reads through Query, and no form needed more than React state.
- Vite, with Cloudflare's Vite plugin, and Wrangler.
- Tailwind CSS v4.
- Drizzle, on its release candidate.
- Better Auth and `@better-auth/passkey`, on the latest safe stable release.
- Bun as the package manager, workspace manager, script runner, test runner, and formatter.
- oxlint for linting, and TypeScript.
- Tabler icons.
- postal-mime, to parse raw messages. A hand-written MIME parser is error-prone, and this one runs on Workers.
- ical.js, to read and write iCalendar for invitations, repeats, and import. It has no dependencies and runs on Workers. Version 2.2.1 parsed an invitation, listed a weekly repeat's dates, and wrote the event back out under `wrangler dev`. It is MPL-2.0, which an AGPL-3.0 project can use.
- portless for named local URLs. It needs Node 24 or later and is a development tool only.

Some pieces are hand-written instead of added as a dependency:

- Web push, with WebCrypto.
- The IndexedDB store for offline mail, because [its check of who owns the device shares a transaction with each write](#the-installable-app).
- The QR code for setting up an authenticator app, because a setup key must not leave the browser for an image service.

## What's next

### Checks before the first release

None of these has been confirmed yet.

- Confirm on a real deployment that all five apps work, including sending and receiving real mail and invitations.
- Confirm with Cloudflare that Email Service allows person-to-person mailbox mail. Its [FAQ](https://developers.cloudflare.com/email-service/reference/faq/) answers "Can I use Email Service for marketing emails?" with "No. Email Service supports transactional email only." It doesn't say whether mailbox mail is allowed.
- Confirm that every wizard step runs against real Cloudflare with one token. Each step applies through the API in the code, but not every step has run for real.
- Confirm that web push works on Safari and an iPhone. iPhone web push needs the app on the Home Screen first.
- Confirm that Cloudflare's Email Service sends Calendar's raw message to an outside address as written, and Gmail, Outlook, and Apple Mail offer their answer buttons. Its structured form can only attach files, not add a text/calendar part. Locally, `wrangler dev` writes each raw message to a `.eml` file instead of sending it.
- Confirm that real Google and Outlook invitation emails put the organiser's own address in `From` and pass the [sender check](#invitations-from-outside), so their updates and replies count.
- Confirm that a real Outlook invitation carries the Teams link in `X-MICROSOFT-SKYPETEAMSMEETINGURL`. That name comes from a public, redacted invitation that Exchange sent to an outside address, and the FairEmail, Evolution, and DavMail clients read it. Exchange also writes `X-MICROSOFT-ONLINEMEETINGEXTERNALLINK`, which is often empty, and `X-MICROSOFT-ONLINEMEETINGCONFLINK`, which holds a `sip:` address and no web link.
- Confirm that the update steps work on a real Deploy button copy, including automatic provisioning of a new binding. A terminal in the browser, such as GitHub Codespaces, might also work, but nobody has tried it.
- Tune Jev's bars of 0.9 for spam and 0.8 for a description on real answers.

### Known gaps

- An event from an imported file, an invitation from outside, or Add to my calendar is still added when it leaves out every one of its own dates, so it shows none.
- A Mail import upload is removed after 3 days with no new part, but has no 7-day cap from its start like Storage's. An import resumed over more than 7 days could lose its upload to R2's own clean-up. This comes from reading the code and hasn't been tested.

### Not built yet

- Calendar reminders.
- Handing over the calendars of someone removed before handover existed. Their files can already be handed over from the People page.
- Importing Gmail labels from `X-Gmail-Labels`.

A control appears only once its feature works, so none of these has a button.

### After the first release

- WebDAV for Storage. Each folder already holds one item for each name, ignoring case, so every item has one path. WebDAV clients can't use a passkey, so it needs app passwords, which the [sign-in features](#auth) don't include yet.
- IMAP as the next import source, because Workers can open outbound TLS connections.
- Scheduled send and snooze.
- Attaching Storage files to events.
- Repeating tasks, custom task statuses or columns, and reminders or any Tasks email other than the assignment email.
- Later apps, such as a password manager, docs, and sheets.

### Not planned

- IMAP and SMTP servers, and so native mail apps. They can't run on Workers.
- Links that work without signing in, in Storage or Calendar, because they would have no access check behind them.
- A CLI, MCP server, chat integrations, public API, or AI features other than the optional Jev check.

### Open questions

- Should an admin be able to turn an app off for one person or group? Today an app is on or off for the whole organisation.
- Should calendars sync to phones? CalDAV clients sign in with a plain password, so phone sync needs app passwords, which the [sign-in features](#auth) don't allow yet. Calendar has no "Add to your phone" until this is decided.
- Should people see when a colleague is free? Showing someone's busy times is a privacy decision the owner hasn't made, so Calendar has no "who's free" view.
- Should a task be able to hold a Storage file? Attaching one would let a task open a file that Storage hasn't shared with everyone on the board, which goes around Storage's one access check. Tasks holds no files until this is decided.

## License

AGPL-3.0. Anyone can self-host CloudySuite. Anyone who runs a modified hosted copy must share their changes.
