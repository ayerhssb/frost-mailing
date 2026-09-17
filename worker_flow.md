# Frost Mass Mail App - Background Worker Documentation (`frost-worker-main`)

This document provides a detailed breakdown of the background daemon service in the Frost Mass Mail system. It explains the execution flow, key scheduling algorithms, email threading systems, inbox check mechanisms, and deployment instructions.

---

## 🛠️ Technology Stack

The worker runs as a headless, concurrent background daemon:

1. **Runtime**: **Node.js** running native ES Modules (`"type": "module"` in `package.json`).
2. **Language**: **TypeScript** (compiled via `tsc` to JavaScript in the `dist` folder).
3. **Database ORM**: **Prisma Client 7.2.0**
   - Synced with the same database schema as the frontend application.
4. **Email Dispatcher**: **Nodemailer 7.0.12**
   - Integrates with user-supplied custom SMTP settings on the fly.
5. **Inbox Reader**: **Imap-simple 5.1.0** and **Mailparser 3.9.1**
   - Establishes IMAP secure connections to check for incoming replies and delivery status reports (bounces).
6. **Object Storage**: **AWS S3 Client SDK**
   - Downloads attachments from Cloudflare R2 on-demand and transforms them into memory buffers for email transport.

---

## 🚀 Starting Point & Entry Files

If you want to trace the worker code, start here:

1. **`src/index.ts`**
   - The entire worker logic is defined here. The `main()` function launches an infinite loop that calls the email queue processor and inbox monitor sequentially, pausing for 30 seconds before repeating:
     ```typescript
     async function main() {
       console.log('[Worker] Service started.');
       while (true) {
         await processEmailQueue();
         await checkRepliesAndBounces();
         await new Promise((resolve) => setTimeout(resolve, 30000));
       }
     }
     ```
2. **`src/lib/utils.ts`**
   - Contains all timezone adjustment utilities, weekend offset rules, and streams-to-buffer converters.
3. **`src/lib/r2.ts`**
   - Sets up the S3 client instance pointing to Cloudflare R2.

---

## 💎 Worker Features & Internal Mechanisms

The worker executes two main workflows: **Email Queue Processing** and **IMAP Reply/Bounce Tracking**.

### 1. Email Queue Processor (`processEmailQueue`)
- **Query**: Every 30 seconds, it queries `EmailLog` records in PostgreSQL with:
  - `status: SCHEDULED`
  - `scheduledAt <= Now`
  - Campaign `status: ACTIVE`
  - User has valid SMTP password configured.
- **Looping**: For each matching log, it runs `processSingleLog()`:
  - Updates the log status to `PROCESSING` to lock the record.
  - Replaces variable tags in the template:
    - `{{ firstName }}` -> Extracts the first word of the contact's name.
    - `{{ name }}`, `{{ email }}` -> Contact fields.
    - `{{ company }}` or `{{ companyName }}` -> Associated company name.
  - **Email Threading Logic**:
    - If the sequence step is 1, it sends a new email.
    - If the sequence step is > 1 (e.g., Step 2 follow-up), it looks up the Step 1 `EmailLog` record that was successfully `SENT`.
    - It retrieves the sent email's `messageId`.
    - It sets Nodemailer's **`inReplyTo`** and **`references`** headers to that `messageId` and prepends **`Re: `** to the subject. This groups the follow-up email in the recipient's existing inbox thread.
  - **Attachments**: Downloads the target files from Cloudflare R2 bucket (`uploads/...`) as streams, converts them into `Buffer`s, and appends them to Nodemailer.
  - **SMTP Dispatch**: Spins up a custom Nodemailer transporter using the sender's SMTP settings. Sends the mail, records the new `messageId`, and updates the database log status to `SENT`.
  - **Next-Step Scheduler**: Calls `scheduleNextEmail()` to query if there is a next step in the campaign sequence. If yes, it calculates the future date using the delay value and preference rules and inserts a new `SCHEDULED` log.

### 2. Timezone-Aware Scheduling (`src/lib/utils.ts`)
- **Rules**: Emails must respect the sender's timezone, their preferred dispatch hour (e.g. `09:00`), and whether weekend sending is allowed.
- **Algorithm**:
  1. Add the delay (in days) to the current send timestamp.
  2. Map the local send time to the sender's timezone (using `Intl.DateTimeFormat` offset calculations).
  3. If the calculated time has already passed for that day, push it to the next day.
  4. If `sendOnWeekends` is `false` and the target date falls on a Saturday or Sunday, shift the date to the upcoming Monday.
  5. Convert the final timestamp back to UTC and save it in the database.

### 3. Inbox reply & Bounce Tracker (`checkRepliesAndBounces`)
- **Query**: Fetches all users with custom IMAP settings configured.
- **IMAP Connection**: Connects to the user's inbox folder (`INBOX`) and searches for emails received in the last hour.
- **Bounce Scanner**:
  - Checks if the sender is a known delivery daemon (`mailer-daemon`, `postmaster`, etc.) or if the subject indicates undeliverability.
  - Parses the bounce body using regular expressions to extract email addresses.
  - Cross-references these emails against campaign contacts. If a match is found, marks the contact status as `BOUNCED` and deletes all pending follow-up `EmailLog` records.
- **Reply Scanner**:
  - Matches incoming emails to campaign contacts:
    - **Method 1**: Inspects the `in-reply-to` header to see if it matches the `messageId` of a sent email in `EmailLog`.
    - **Method 2 (Fallback)**: Matches the sender's email directly with a campaign contact.
  - If a reply is found:
    1. Updates the contact status to `REPLIED`.
    2. Deletes all future `SCHEDULED` follow-up emails for this contact.
    3. If the user's preference `stopAllCompanyMailsOnReply` is `true`, it finds all other contacts under the same `CompanyId` in that campaign and updates their status to `STOPPED`, canceling their scheduled emails.

---

## ⚙️ How to Run the Worker

Follow these instructions to run the background worker locally:

### 1. Environment Configuration
Create a `.env` file inside `d:\frost mass mail app\frost-worker-main\frost-worker-main\`:

```env
# Database connection string (must target the same DB as the frontend)
DATABASE_URL="postgresql://username:password@localhost:5432/frost_db?schema=public"

# Cloudflare R2 / S3 Credentials (must match the frontend R2 bucket)
R2_ACCOUNT_ID="your-cloudflare-account-id"
R2_ACCESS_KEY_ID="your-r2-access-key-id"
R2_SECRET_ACCESS_KEY="your-r2-secret-access-key"
R2_BUCKET_NAME="your-bucket-name"
```

### 2. Installation and Build
Open your terminal in `d:\frost mass mail app\frost-worker-main\frost-worker-main` and run:

```powershell
# Install dependencies
npm install

# Generate the Prisma database client
npx prisma generate

# Compile TypeScript to JavaScript
npm run build

# Start the worker
npm start
```

For development, you can run the TypeScript code directly without compiling:
```powershell
npx tsx src/index.ts
```

The console will output logs showing queue checks and IMAP scans.
