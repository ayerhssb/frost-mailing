# Frost Mass Mail App - Frontend & API Documentation (`frost-app-main`)

This document provides a detailed breakdown of the frontend web application in the Frost Mass Mail system. It is designed to explain every aspect of the codebase, from the entry points and architecture to individual features, implementation specifics, and run instructions.

---

## 🛠️ Technology Stack

The frontend application uses a modern, high-performance stack:

1. **Framework**: **Next.js 16.0.10** (App Router)
   - Utilizes React 19 features (Server Actions, Suspense, and Concurrent rendering).
   - Server-Side Rendering (SSR) and React Server Components (RSC) are used for instant pages and secure data fetching.
2. **Language**: **TypeScript** (strict type safety for parameters, database models, and API states).
3. **Styling**: **Tailwind CSS v4**
   - Direct PostCSS integration (`postcss.config.mjs`) for compile-time utility optimization.
   - Clean dark-mode aesthetic with custom radial gradients and glassmorphism.
4. **Database ORM**: **Prisma 7.2.0**
   - Paired with `@prisma/adapter-pg` and `pg` for native, high-efficiency connection pooling to PostgreSQL.
5. **Authentication**: **Next-Auth 4.24.13** (AuthJS)
   - Google OAuth Provider configuration.
   - Database adapter (`@next-auth/prisma-adapter`) to persist users, accounts, and session tokens directly in PostgreSQL.
6. **Rich Text Editor**: **Tiptap React Editor**
   - Supports rich-text generation for emails, link insertion, placeholders, and formatting.
7. **File Uploads**: **Cloudflare R2 Object Storage** (AWS S3 Client compatible)
   - Presigned upload URL flow to allow secure client-to-cloud uploads bypassing the server.
8. **Utilities**:
   - `PapaParse` for parsing and validation of uploaded lead CSV files.
   - `Framer Motion` for smooth, premium UI transitions and micro-animations.
   - `Sonner` for modern, non-blocking toast notifications.
   - `Lucide React` for a clean, consistent dashboard icon set.

---

## 🚀 Starting Point & Entry Files

If you want to read the app code from the start, follow this path:

1. **`src/app/layout.tsx`**
   - The root layout of the app. It initializes global CSS variables (`globals.css`), wraps the application in the Next-Auth session provider, and mounts the toast notification system (`Sonner`).
2. **`src/app/page.tsx`**
   - The landing page. Contains the marketing hero section, animations, features list, and the "Get Started" / "Start Campaign" CTA links pointing to `/auth/signin` and `/dashboard/campaigns`.
3. **`src/app/api/auth/[...nextauth]/route.ts`** & **`src/lib/auth.ts`**
   - The entry point for authentication. Defines how users login via Google OAuth, sets up the JWT session strategy, and handles lifecycle hooks (like seeding default Gmail settings when a user profile is created).
4. **`src/lib/prisma.ts`**
   - The database client initializer. It uses a caching pattern on `globalThis` to prevent connection leaks during development hot-reloads.

---

## 🎨 Dashboard Page Structure

Inside the `src/app/dashboard` folder, Next.js routes are structured as follows:
- **`dashboard/layout.tsx`**: Renders the persistent desktop sidebar (`Sidebar.tsx`) and mobile navigation bar (`BottomNav.tsx`).
- **`dashboard/campaigns/page.tsx`**: Fetches and lists all outreach campaigns for the logged-in user, aggregating counts of contacts, sent emails, replies, and bounces directly inside the PostgreSQL query.
- **`dashboard/campaigns/new/page.tsx`**: Hosts the multi-step Campaign wizard (`NewCampaignWizard.tsx`) where users import leads and define outreach sequences.
- **`dashboard/campaigns/[id]/page.tsx`**: The campaign detail view (`CampaignDetails.tsx`) displaying status logs, individual lead states, and progress bars.
- **`dashboard/templates/page.tsx`**: CRUD manager for saving reusable email templates.
- **`dashboard/settings/page.tsx`**: Configuration panel for SMTP and IMAP servers, as well as sending window rules (timezone, weekends, start times).

---

## 💎 Features & Functional Flow

### 1. User Onboarding & Auth Flow
- **Flow**: User clicks "Get Started" -> Redirects to NextAuth `/auth/signin` -> User signs in via Google -> NextAuth creates a user record in the DB.
- **Auto-Provisioning**: In `src/lib/auth.ts`, the `createUser` event automatically runs. It seeds the `EmailSettings` table with default values for Gmail (e.g. `smtp.gmail.com:587`, `imap.gmail.com:993`) so the user has a skeleton configuration ready.

### 2. The Campaign Creator Wizard
- **Path**: `src/components/campaigns/NewCampaignWizard.tsx`
- **Lead Import**: The user uploads a CSV file containing contact leads. The browser parses it using `PapaParse`, ensuring that every row has `name`, `email`, and `company` fields.
- **Sequence Mapping**: The user designs the email flow: Step 1 (Immediate template), Step 2 (Follow-up template after $N$ days delay), Step 3, etc.
- **Creation Transaction**: The client POSTs the campaign payload to `/api/campaigns`. The server processes it inside a **Prisma Database Transaction** (`prisma.$transaction`):
  1. Creates the `Campaign` record.
  2. Identifies all unique company names.
  3. Bulk creates missing `Company` records (`createMany` with `skipDuplicates: true`).
  4. Fetches all company IDs to form a name-to-ID lookup map.
  5. Bulk inserts contacts (`Contact` records) associated with their correct campaigns and companies.
  6. Bulk inserts sequence steps (`CampaignTemplate` records) linking templates, sequence order, and delays.

### 3. Presigned File Uploads (Direct-to-Cloud)
- **Path**: `src/app/actions.ts` (`getUploadUrl`)
- **Security Pattern**: To prevent files passing through Next.js server memory, we use a presigned URL pattern:
  1. The client requests a presigned URL by calling the Server Action `getUploadUrl(fileName, fileType)`.
  2. The server instantiates the AWS S3 Client targeting Cloudflare R2, creates a `PutObjectCommand`, and generates a temporary signed URL valid for 60 seconds.
  3. The client uploads the attachment directly to Cloudflare R2 using a `PUT` request to that signed URL.
  4. The client saves the resulting file key string in the campaign template attachments array.

### 4. Campaign Execution & Launch Flow
- **Path**: `/api/campaigns/[id]/route.ts` (PATCH)
- **Activation**: When a user changes a campaign status to `ACTIVE`, the API:
  1. Pulls sending preferences (timezone, weekend restrictions, sending hour).
  2. Queries all contacts in the campaign whose status is `ACTIVE`.
  3. Resolves what sequence step they should be on. If a contact has no emails sent yet, they are assigned to Step 1.
  4. Calculates the target dispatch date/time using timezone adjustments.
  5. Creates scheduled `EmailLog` records in the database.
- **Draft/Pause**: If status is set to `DRAFT` or `PAUSED`, the API deletes all future logs marked `SCHEDULED` for that campaign.

---

## ⚙️ How to Run the Frontend

Follow these instructions to start the frontend application locally:

### 1. Prerequisites
- **Node.js** v18.0.0 or higher (v20+ recommended).
- **PostgreSQL** instance up and running.
- **Cloudflare R2 Bucket** (or AWS S3 bucket) for storing attachments.
- **Google Cloud Console Project** with OAuth credentials enabled (Redirect URI set to `http://localhost:3000/api/auth/callback/google`).

### 2. Environment Configuration
Create a `.env` file inside `d:\frost mass mail app\frost-app-main\frost-app-main\`:

```env
# Database connection string
DATABASE_URL="postgresql://username:password@localhost:5432/frost_db?schema=public"

# Next Auth Secrets
NEXTAUTH_SECRET="your-random-32-char-string"
NEXTAUTH_URL="http://localhost:3000"

# Google OAuth Credentials
GOOGLE_CLIENT_ID="your-google-oauth-client-id"
GOOGLE_CLIENT_SECRET="your-google-oauth-client-secret"

# Cloudflare R2 / S3 Credentials
R2_ACCOUNT_ID="your-cloudflare-account-id"
R2_ACCESS_KEY_ID="your-r2-access-key-id"
R2_SECRET_ACCESS_KEY="your-r2-secret-access-key"
R2_BUCKET_NAME="your-bucket-name"
```

### 3. Installation and Start
Open your terminal in `d:\frost mass mail app\frost-app-main\frost-app-main` and run:

```powershell
# Install all packages
npm install

# Generate the Prisma client code and sync database schemas
npx prisma generate
npx prisma db push

# Start the local development server
npm run dev
```

Your web app will now be live at **`http://localhost:3000`**.
