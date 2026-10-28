# JobsNotifier — WhatsApp Bot

Automated job vacancy and recruitment notification monitoring with scheduled checks and WhatsApp delivery.

JobsNotifier checks a recruitment news website every 30 minutes, detects new **job vacancies, admit cards,
results / answer keys and admissions**, and posts each new item as a separate message to one WhatsApp group.
Items are recorded in a local SQLite database, so nothing is sent twice — also not after a restart.

> **Unofficial WhatsApp client.** Delivery uses [Baileys](https://github.com/WhiskeySockets/Baileys), an
> unofficial WhatsApp Web library, linked to your own WhatsApp account as a *Linked device*. It is not the
> WhatsApp Business API. See [Security and responsible use](#security-and-responsible-use).

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Notification categories](#notification-categories)
- [Architecture and technology](#architecture-and-technology)
- [Prerequisites](#prerequisites)
- [Installation (Windows / any OS with Node.js)](#installation)
- [Configuration](#configuration)
- [Running the bot](#running-the-bot)
- [Scheduler](#scheduler)
- [Docker](#docker)
- [Running on Windows at logon](#running-on-windows-at-logon)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Security and responsible use](#security-and-responsible-use)
- [Limitations](#limitations)
- [Maintainer](#maintainer)
- [License](#license)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)

---

## Features

- **Scheduled checks** every 30 minutes (minute 0 and 30, local time), with no overlapping runs.
- **Four categories**: admit cards, latest jobs, results (incl. answer keys) and admissions.
- **One notification per WhatsApp message.** A single notification is split into labelled parts only if it
  exceeds ~4,000 characters.
- **Persistent deduplication** in SQLite (`node:sqlite`): an item is marked *sent* only after WhatsApp accepted
  it. Sends that may or may not have arrived are marked *uncertain* and are never resent automatically.
- **Two message formats** (`compact`, `detailed`) — see [Message formats](#message-formats).
- **Strict source handling** in the `compact` format: pages are only requested from one exact hostname;
  redirects to other hosts are refused; application/official links are displayed but never fetched.
- **Link safety policy**: shortened links, raw IP addresses, look-alike (punycode) domains, links with hidden
  characters and similar are withheld; links on unfamiliar non-government domains are labelled *unverified*.
- **Dry-run, preview and seed modes** to inspect messages or skip a backlog without sending anything.
- **Bounded retries and timeouts** for page downloads; one failing item does not stop the others.
- **Single-instance lock**, rotating log files, and a health-check command.
- Runs **locally on Windows** (optional start at logon via Task Scheduler) or in **Docker**.

## How it works

```
scheduler (node-cron, */30 * * * *)
   └─ fetch the source homepage
        └─ for each section (admit card, latest job, result, admission):
             take the newest N entries (LIMIT_*)
             skip entries already in the database (key = section + link)
             fetch the post page and build the message (selected MESSAGE_FORMAT)
             send to WP_GROUP via WhatsApp → record as sent / failed / uncertain
```

- `DRY_RUN=true` (or `--dry-run`) builds and prints the messages but sends and records nothing.
- `--seed` records what is currently on the site as already seen, without sending — useful before the first
  live run so an existing backlog is not posted.
- If WhatsApp is not connected, the bot waits up to 2 minutes; unsent items are retried on the next run.

### Message formats

| `MESSAGE_FORMAT` | Source website | Content |
|---|---|---|
| `detailed` | `www.sarkariresult.com` | Full structured notification; cross-checks dates/fees against the notification PDF when it has a text layer |
| `compact` *(default)* | `sarkariresult.com.cm` **only** | Compact notification: title, organisation, vacancies, status, dates, qualification, age, fees, selection and the application link |

## Notification categories

Taken from the homepage sections parsed by the code (`src/source/parse.js`, `src/sarkariresult/homepage.js`):

| Category | Section on the source homepage | Default entries checked per run |
|---|---|---|
| Admit cards | *Admit Card(s)* | 3 (`LIMIT_ADMIT_CARD`) |
| Latest jobs | *Latest Job(s)* | 2 (`LIMIT_LATEST_JOB`) |
| Results / answer keys | *Result(s)* | 3 (`LIMIT_RESULT`) |
| Admissions | *Admission* | 3 (`LIMIT_ADMISSION`) |

## Architecture and technology

| Part | Implementation |
|---|---|
| Runtime | Node.js **≥ 22.13** (ES modules; uses the built-in `node:sqlite`) |
| Scheduling | [`node-cron`](https://www.npmjs.com/package/node-cron) |
| Scraping | [`axios`](https://www.npmjs.com/package/axios) + [`cheerio`](https://www.npmjs.com/package/cheerio) |
| PDF text (detailed format) | [`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist) |
| WhatsApp | [`@whiskeysockets/baileys`](https://www.npmjs.com/package/@whiskeysockets/baileys), QR via `qrcode-terminal` |
| Storage | SQLite file `data/jobs.db` (delivery history + source cache) |
| Configuration | `.env` via [`dotenv`](https://www.npmjs.com/package/dotenv) |
| Tests | Node.js built-in test runner (`node --test`) |

```
index.js            entry point: modes, scheduler, WhatsApp connection, lock, shutdown
src/runner.js       one check cycle: dedup, send, record
src/whatsapp/       WhatsApp client (Baileys): connect, QR login, reconnect policy, sending, groups
src/sarkariresult/  www.sarkariresult.com homepage sections (detailed format)
src/store.js        SQLite schema/migrations, delivery records, cache
src/source/         compact format: strict fetcher, parsers, link policy, templates
src/vacancy/        detailed format: article parser, link classification, PDF cross-check, tasks
src/http.js         HTTP helpers (timeouts, retries, public-address guard)
scripts/            preview, send-one, db inspection, health check, Windows task scripts
test/               automated tests with local HTML fixtures and a mocked sender
```

> `whatsapp-web.js` is listed in `package.json` but is not imported by the code. `link-preview-js` is not
> imported directly either; it is an optional Baileys dependency for link previews.

## Prerequisites

- **Node.js 22.13 or newer** and npm (Docker users: Docker with Compose v2 instead).
- **Git** to clone the repository.
- A **WhatsApp account** on a phone, which is a member of the target group (a secondary number is recommended).
- Internet access to the source website, WhatsApp, and `raw.githubusercontent.com` (Baileys fetches the current
  WhatsApp Web version number at connect time and falls back to a built-in value).

## Installation

The commands below are for Windows PowerShell; on Linux/macOS use the equivalent shell commands
(e.g. `cp` instead of `Copy-Item`).

```powershell
git clone https://github.com/<your-account>/jobsnotifier-whatsapp-bot.git
cd jobsnotifier-whatsapp-bot
npm ci
Copy-Item .env.example .env
```

`whatsapp-web.js` (unused) pulls in Puppeteer, which downloads Chromium during install. To skip that download:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = "true"; npm ci
```

### Link WhatsApp (once)

```powershell
npm run login
```

Scan the QR code with **WhatsApp → Settings → Linked devices → Link a device**. The session is stored in
`auth/` and reused afterwards.

### Find your group ID and configure

```powershell
npm run groups     # lists the groups of the linked account with their IDs (sends nothing)
```

Put the ID (`…@g.us`) into `.env` as `WP_GROUP`, then:

```powershell
npm run check               # Node, dependencies, .env, WP_GROUP, session, .gitignore (prints no secrets)
npm run check -- --online   # also connects and confirms the group is reachable (sends nothing)
```

## Configuration

All settings are read from `.env` (see [`.env.example`](.env.example)). Relative folders are resolved from the
project folder.

| Variable | Default | Description |
|---|---|---|
| `WP_GROUP` | — (required for sending) | WhatsApp group ID, e.g. `120363000000000000@g.us` |
| `DRY_RUN` | `false` | `true` = print messages, never send or record |
| `RUN_ON_START` | `false` | `true` = also run one check immediately after start |
| `MESSAGE_FORMAT` | `compact` | `compact` or `detailed` (any other value falls back to `compact`) |
| `LIMIT_ADMIT_CARD` | `3` | Newest admit-card entries checked per run |
| `LIMIT_LATEST_JOB` | `2` | Newest job entries checked per run |
| `LIMIT_RESULT` | `3` | Newest result entries checked per run |
| `LIMIT_ADMISSION` | `3` | Newest admission entries checked per run |
| `SEND_DELAY_MS` | `3000` | Pause between consecutive WhatsApp messages |
| `AUTH_DIR` | `auth` | WhatsApp session folder |
| `DATA_DIR` | `data` | Database folder (`jobs.db`) |
| `LOG_DIR` | `logs` | Log folder (`bot.log`, rotated at 5 MB, 5 files kept) |
| `WA_LOG_LEVEL` | `silent` | Baileys log level: `silent`, `error`, `warn`, `info`, `debug` |

`TZ` (e.g. `Asia/Kolkata`) is not read by the code, but it sets the process time zone used by the scheduler —
relevant in containers (see [Docker](#docker)).

## Running the bot

| Command | What it does |
|---|---|
| `npm start` | Scheduled bot (sends to `WP_GROUP`) |
| `npm run once` | One live check now, then exit |
| `npm run dry-run` | One check; print messages, send and record nothing (`-- --format=compact` to override the format) |
| `npm run seed` | Mark everything currently on the site as seen, without sending |
| `npm run preview -- <post url>` | Show the message for one post (`--type admitCard\|result\|admission`, `--format=compact`) |
| `npm run send-one -- <post url>` | Preview one post; with `--send --expect <fingerprint>` send exactly that previewed message |
| `npm run test-message` | Send one short test line to the group (database untouched) |
| `npm run login` | Link WhatsApp via QR code |
| `npm run groups` | List groups and IDs (read-only) |
| `npm run db` | Delivery counts and recent records (`-- uncertain`, `-- failed`, `-- requeue <key>\|--all`) |
| `npm run check` | Setup health check |
| `npm test` | Automated tests |

Recommended first start: `npm run dry-run` → (optionally) `npm run seed` → `npm start`.

## Scheduler

The interval is defined in [`src/config.js`](src/config.js):

```js
export const HOURLY_SCHEDULE = "*/30 * * * *";   // every 30 minutes: minute 0 and 30 of every hour
```

- The cron expression uses the **local time zone of the process**.
- `noOverlap` is enabled: if a run is still in progress, the next one is skipped.
- With `RUN_ON_START=false` the first check happens at the next minute 0 or 30 after start.
- The start-up log shows the active expression and the next run, e.g.
  `Scheduler active ("*/30 * * * *", local time). Next check: … 20:30:00`.

To change the interval, edit that constant (and the expectation in `test/infra.test.js`) and restart the bot.

## Docker

The repository includes a [`Dockerfile`](Dockerfile) (Node 22, Debian slim, non-root `node` user, time-zone data)
and a [`compose.yaml`](compose.yaml). Secrets and data are **not** baked into the image (`.dockerignore`); they
are mounted as volumes.

```bash
cp .env.example .env            # set WP_GROUP and other values
mkdir -p auth data logs
sudo chown -R 1000:1000 auth data logs   # the container runs as uid 1000 (node)
docker compose build
```

Link WhatsApp once (interactive, shows the QR code):

```bash
docker compose run --rm -it jobsnotifier node --disable-warning=ExperimentalWarning index.js --login
```

Dry-run, then start:

```bash
docker compose run --rm -T -e DRY_RUN=true jobsnotifier node --disable-warning=ExperimentalWarning index.js --dry-run </dev/null
docker compose up -d
docker compose logs -f jobsnotifier
```

Notes:

- `compose.yaml` sets `TZ: Asia/Kolkata`; change it to your time zone. Without `TZ` a container runs in UTC.
- Run `docker compose run` with `</dev/null` in scripts — otherwise it reads the script's standard input.
- Use `node index.js` as the container command (as in the Dockerfile). `scripts/supervisor.js` is meant for the
  Windows task and exits when it has no parent process, which is the case for a container's main process.
- No ports are needed; the bot only makes outgoing connections.

## Running on Windows at logon

PowerShell scripts in `scripts/` register a Task Scheduler task that starts `scripts/supervisor.js`
(crash restarts with back-off) after you log in. Each script only previews by default:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-task.ps1          # preview
powershell -ExecutionPolicy Bypass -File .\scripts\install-task.ps1 -Apply   # create the task
powershell -ExecutionPolicy Bypass -File .\scripts\stop-bot.ps1              # clean stop
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-task.ps1 -Apply # stop + remove the task
```

The bot runs only while the PC is on, awake, logged in and online.

> Never run two copies with the same `auth/` folder (e.g. Windows and Docker at the same time): WhatsApp keeps
> replacing one connection with the other (code 440), and both copies could send messages.

## Tests

```bash
npm test
```

The suite uses local HTML fixtures with mocked HTTP and WhatsApp calls; it sends no WhatsApp messages.
It covers parsing, message formats, splitting, deduplication across restarts, retries, the scheduler
expression (30-minute steps), the database migration, source-host restrictions, the link policy and the
private-address guard.

## Troubleshooting

| Symptom / log message | Cause and fix |
|---|---|
| `WhatsApp is not linked yet` | Run `npm run login` (Docker: the interactive `--login` command above). |
| `session is no longer valid` (code 401) | The device was unlinked. Stop the bot, move `auth/` aside, run `npm run login`. |
| `Another client opened this WhatsApp session (440)` | Two copies use the same session — stop one. |
| `Another JobsNotifier process … is already running` | Single-instance lock in `data/bot.lock`; stop the other process. |
| `WP_GROUP is missing or invalid` | Set a valid `…@g.us` ID; find it with `npm run groups`. |
| `no items parsed - the site layout may have changed` | The source HTML changed; the parsers need updating. |
| `GET … failed` / `site down` | Network or source unavailable; retried on the next run (no fallback site). |
| Delivery marked `uncertain` | Check the group, then `npm run db -- requeue <key>` if it did not arrive. |
| Checks at unexpected minutes in Docker | Set `TZ` and make sure the image has time-zone data. |
| `node:sqlite` errors | Use Node.js 22.13 or newer. |

Logs: `logs/bot.log` (Windows: `Get-Content logs\bot.log -Tail 50 -Wait -Encoding UTF8`;
Docker: `docker compose logs -f jobsnotifier`).

## Security and responsible use

- **Never commit or share** `.env`, `auth/` (your WhatsApp login), `data/` (database and backups) or `logs/`.
  They are listed in `.gitignore` and `.dockerignore`.
- The `auth/` folder grants access to the linked WhatsApp account. Keep it private; unlink the device from the
  phone if it may have leaked.
- Automated messaging can violate WhatsApp's terms and lead to account restrictions. Use a dedicated number,
  keep the volume low (the defaults send one message per new item, 3 s apart) and only message groups whose
  members expect these alerts.
- Respect the source website's terms of use; the bot requests a small number of pages per run.
- Links in messages come from the source pages and are **not** visited by the compact format. Shortened, IP-based,
  look-alike or malformed links are withheld; unfamiliar non-government domains are marked *unverified*.

## Limitations

- Depends on the current HTML structure of the source websites; layout changes require parser updates.
- Only the newest `LIMIT_*` entries per section are checked each run; more new entries than that between two runs
  (or while the bot is offline) are missed.
- Deduplication is per section + link: an updated post under the same link is not sent again, and the same post
  listed in two sections can be sent once per section.
- Baileys is unofficial; WhatsApp protocol changes can break it until the library is updated.
- `node:sqlite` is still marked experimental in Node.js (the warning is suppressed in the npm scripts).
- The bot only runs while its host is on and online.

## Maintainer

**Divyanshu Verma** — [@divyanshu76](https://github.com/divyanshu76)

## License

No license has been specified yet. Until a license is added, all rights are reserved by the respective authors.

## Contributing

Issues and pull requests are welcome. Please:

1. Keep changes focused and match the existing code style.
2. Add or update tests and run `npm test` before opening a pull request.
3. Never include `.env` values, WhatsApp session files, databases, logs or real group IDs in issues or commits.

## Disclaimer

JobsNotifier relays information published by third-party websites and is not affiliated with any government body
or recruitment agency. Notifications may be incomplete, delayed or incorrect. **Always verify dates, eligibility,
fees and application links against the official notification and the recruiting organisation's website before
applying.**
