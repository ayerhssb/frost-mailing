import prisma from './lib/prisma.js';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { CampaignStatus, EmailLogStatus, Status } from './generated/prisma/client.js';
import imaps from 'imap-simple';
import { getNextScheduleTime, streamToBuffer } from './lib/utils.js';
import type { Campaign, Company, Contact, EmailLog, EmailSettings, Preferences, Template, User } from './generated/prisma/client.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from './lib/r2.js';

dotenv.config();

async function processEmailQueue() {
  console.log('[Worker] Checking for scheduled emails...');
  console.log(new Date());
  try {
    const logs = await prisma.emailLog.findMany({
      where: {
        status: EmailLogStatus.SCHEDULED,
        scheduledAt: {
          lte: new Date(),
        },
        campaign: {
          status: CampaignStatus.ACTIVE,
          user: {
            emailSettings: {
              smtpPassword: {
                not: null
              }
            }
          }
        }
      },
      include: {
        campaign: {
          include: {
            user: {
              include: {
                emailSettings: true,
                preferences: true,
              },
            },
          },
        },
        template: true,
        contact: {
          include: {
            company: true
          }
        },
      },
    });

    if (logs.length === 0) {
      console.log('No emails to send.');
      return;
    }

    console.log(`[Worker] Found ${logs.length} emails to send.`);

    for (const log of logs) {
      await processSingleLog(log);
    }
  } catch (error) {
    console.error('[Worker] Error processing queue:', error);
  }
}

async function processSingleLog(log: EmailLog & {
  campaign: Campaign & { user: User & { emailSettings: EmailSettings, preferences: Preferences | null } },
  template: Template | null,
  contact: (Contact & { company: Company }) | null
}) {
  const { campaign, template, contact, sequence } = log;
  const user = campaign.user;
  const emailSettings = user.emailSettings;

  if (!template) {
    console.error(`[Worker] Template deleted or missing for log ${log.id}. Marking as FAILED.`);
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: EmailLogStatus.FAILED, errorMessage: 'Template not found.' },
    });
    return;
  }

  if (!contact) {
    console.error(`[Worker] Contact missing for log ${log.id}. Marking as FAILED.`);
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: EmailLogStatus.FAILED, errorMessage: 'Contact not found.' },
    });
    return;
  }

  try {
    // Update status to PROCESSING
    await prisma.emailLog.update({
      where: { id: log.id },
      data: { status: EmailLogStatus.PROCESSING }
    });

    // Prepare email content
    let subject = replaceVariables(template.subject, contact);
    const body = replaceVariables(template.body, contact);

    // Threading logic
    let inReplyTo: string | undefined;
    let references: string | undefined;

    if (sequence > 1) {
      const firstLog = await prisma.emailLog.findFirst({
        where: {
          campaignId: campaign.id,
          contactId: contact.id,
          sequence: 1,
          status: EmailLogStatus.SENT
        },
        include: {
          template: true
        }
      });

      if (firstLog && firstLog.messageId && firstLog.template) {
        console.log(`[Worker] Threading email (Seq: ${sequence}) to ${firstLog.messageId}`);
        inReplyTo = firstLog.messageId;
        references = firstLog.messageId;

        // Use original subject with Re: prefix
        const originalSubject = replaceVariables(firstLog.template.subject, contact);
        subject = `Re: ${originalSubject}`;
      } else {
        console.warn(`[Worker] Could not find first email for threading (Seq: ${sequence}). Sending as new thread.`);
      }
    }

    // Setup transporter
    const transporter = nodemailer.createTransport({
      host: emailSettings.smtpHost || "smtp.gmail.com",
      port: emailSettings.smtpPort || 587,
      secure: emailSettings.smtpPort === 465,
      auth: {
        user: emailSettings.smtpUser || emailSettings.fromEmail || user.email,
        pass: emailSettings.smtpPassword || "",
      },
    });

    const attachments = await Promise.all(
      template.attachments.map(async (attKey) => {
        const command = new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: `uploads/${attKey}`,
        });

        const response = await s3Client.send(command);
        const buffer = await streamToBuffer(response.Body);

        return {
          filename: attKey.split('/').pop() || 'attachment',
          content: buffer,
        };
      })
    );

    const info = await transporter.sendMail({
      from: `"${emailSettings.fromName || user.name}" <${emailSettings.fromEmail || user.email}>`,
      to: contact.email,
      subject: subject,
      html: body,
      inReplyTo: inReplyTo,
      references: references,
      attachments: attachments
    });

    console.log(`[Worker] Email sent: ${info.messageId} (Log ID: ${log.id})`);

    // Update log to SENT
    const updatedLog = await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: EmailLogStatus.SENT,
        sentAt: new Date(),
        messageId: info.messageId,
      },
    });

    // Schedule next email in sequence
    const preferences = user.preferences || { mailSendingTime: "09:00", sendOnWeekends: false, timezone: "Asia/Kolkata" };
    await scheduleNextEmail(campaign.id, contact.id, sequence, preferences, updatedLog.sentAt || new Date());

  } catch (error: any) {
    console.error(`[Worker] Failed to send email (Log ID: ${log.id}):`, error);
    await prisma.emailLog.update({
      where: { id: log.id },
      data: {
        status: EmailLogStatus.FAILED,
        errorMessage: error.message || 'Unknown error',
        retryCount: { increment: 1 },
      },
    });
    await prisma.contact.update({
      where: { id: contact.id },
      data: { status: Status.FAILED },
    });
  }
}

async function scheduleNextEmail(
  campaignId: string,
  contactId: string,
  currentSequence: number,
  preferences: { mailSendingTime: string, sendOnWeekends: boolean, timezone: string },
  lastSentAt: Date
) {
  const nextSequence = currentSequence + 1;

  // Find the template for the next sequence
  const nextCampaignTemplate = await prisma.campaignTemplate.findFirst({
    where: {
      campaignId: campaignId,
      sequence: nextSequence
    }
  });

  if (!nextCampaignTemplate) {
    return;
  }

  const delayDays = nextCampaignTemplate.delay;

  // Calculate Target Time based on previous sent time + delay, but snap to preference time
  const scheduledAt = getNextScheduleTime(preferences.mailSendingTime, preferences.timezone, preferences.sendOnWeekends, lastSentAt, delayDays);
  console.log(`[Worker] Scheduling next email (Seq: ${nextSequence}) for Contact ${contactId} at ${scheduledAt.toISOString()}`);

  await prisma.emailLog.create({
    data: {
      campaignId: campaignId,
      templateId: nextCampaignTemplate.templateId,
      contactId: contactId,
      sequence: nextSequence,
      status: EmailLogStatus.SCHEDULED,
      scheduledAt: scheduledAt,
    }
  });
}

function replaceVariables(text: string, contact: any): string {
  let result = text;
  result = result.replace(/{{\s*firstName\s*}}/g, contact.name.split(' ')[0]);
  result = result.replace(/{{\s*name\s*}}/g, contact.name);
  result = result.replace(/{{\s*email\s*}}/g, contact.email);
  if (contact.company) {
    result = result.replace(/{{\s*company\s*}}/g, contact.company.name);
    result = result.replace(/{{\s*companyName\s*}}/g, contact.company.name);
  }
  return result;
}

async function checkRepliesAndBounces() {
  console.log('[Worker] Checking for replies and bounces...');
  try {
    // Get all users with email settings
    const users = await prisma.user.findMany({
      where: {
        emailSettings: {
          isNot: null
        }
      },
      include: {
        emailSettings: true,
        preferences: true
      }
    });

    // Process each user
    for (const user of users) {
      if (!user.emailSettings || !user.emailSettings.imapUser || !user.emailSettings.imapPassword) continue;

      // Connect to IMAP server
      const config: imaps.ImapSimpleOptions = {
        imap: {
          user: user.emailSettings.imapUser,
          password: user.emailSettings.imapPassword,
          host: user.emailSettings.imapHost,
          port: user.emailSettings.imapPort,
          tls: user.emailSettings.imapPort === 993,
          tlsOptions: { rejectUnauthorized: false },
          authTimeout: 3000
        }
      };

      try {
        const connection = await imaps.connect(config);
        await connection.openBox('INBOX');

        // Fetch messages from last 1 hour
        const searchCriteria = [['SINCE', new Date()]];
        const fetchOptions = {
          bodies: ['HEADER', 'TEXT'],
          markSeen: false
        };

        const messages = await connection.search(searchCriteria, fetchOptions);

        const bounceSenders = ['mailer-daemon', 'postmaster', 'bounce', 'delivery-status', 'microsoftoutlook', 'no-reply'];

        // Process each message
        for (const message of messages) {
          const headerPart = message.parts.find((p: any) => p.which === 'HEADER');
          if (!headerPart || !headerPart.body.from) continue;

          // Filter by Time (Last 1 hour)
          const dateHeader = headerPart.body.date ? headerPart.body.date[0] : null;
          if (!dateHeader) continue;

          const emailDate = new Date(dateHeader);
          const now = new Date();
          // 1 hour = 60 * 60 * 1000 = 3600000
          if (now.getTime() - emailDate.getTime() > 3600000) {
            continue;
          }

          // Get sender email
          const fromHeader = headerPart.body.from[0];
          const fromEmailMatch = /<(.+)>/.exec(fromHeader);
          const fromEmail = (fromEmailMatch ? fromEmailMatch[1] : fromHeader).toLowerCase().replace(/['"<>]+/g, '').trim();

          console.log(`[Worker] Processing recent email from ${fromEmail}`);

          // --- BOUNCE DETECTION ---
          let isBounce = bounceSenders.some(sender => fromEmail.includes(sender));

          const subject = headerPart.body.subject ? headerPart.body.subject[0] : '';
          if (!isBounce && (subject.toLowerCase().includes('undeliverable') || subject.toLowerCase().includes('delivery status notification'))) {
            isBounce = true;
          }

          if (isBounce) {
            console.log(`[Worker] Potential bounce detected from ${fromEmail}.`);
            const textPart = message.parts.find((p: any) => p.which === 'TEXT');

            if (textPart) {
              const bodyContent = textPart.body;
              const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
              const currentOwnerEmail = user.emailSettings.imapUser.toLowerCase();

              const foundEmails = (bodyContent.match(emailRegex) || [])
                .map((e: string) => e.toLowerCase())
                .filter((e: string) => e !== fromEmail && e !== currentOwnerEmail);

              if (foundEmails.length > 0) {
                const bouncedContacts = await prisma.contact.findMany({
                  where: {
                    email: { in: foundEmails },
                    userId: user.id
                  }
                });

                for (const bouncedContact of bouncedContacts) {
                  if (bouncedContact.status === Status.BOUNCED) {
                    console.log(`[Worker] Contact ${bouncedContact.email} already marked BOUNCED. Skipping.`);
                    continue;
                  }

                  console.log(`[Worker] BOUNCE CONFIRMED for ${bouncedContact.email}. Updating status.`);

                  await prisma.contact.update({
                    where: { id: bouncedContact.id },
                    data: { status: Status.BOUNCED }
                  });

                  await prisma.emailLog.deleteMany({
                    where: {
                      contactId: bouncedContact.id,
                      status: EmailLogStatus.SCHEDULED
                    }
                  });
                }
              }
            }
            continue;
          }

          // --- REPLY DETECTION ---

          let matchedContacts: (Contact & { companyId: string | null })[] = [];

          // 1. Try matching via In-Reply-To header (Most accurate)
          const inReplyTo = headerPart.body['in-reply-to'] ? headerPart.body['in-reply-to'][0] : null;

          if (inReplyTo) {
            const originalLog = await prisma.emailLog.findFirst({
              where: { messageId: inReplyTo },
              include: { contact: true }
            });

            if (originalLog && originalLog.contact) {
              console.log(`[Worker] Match via In-Reply-To for Log ${originalLog.id}`);
              matchedContacts.push(originalLog.contact);
            }
          }

          // 2. Fallback to From Email matching if no ID match found
          if (matchedContacts.length === 0) {
            const contacts = await prisma.contact.findMany({
              where: {
                email: fromEmail,
                userId: user.id
              }
            });
            matchedContacts = contacts;
          }

          // Process matched contacts
          for (const contact of matchedContacts) {
            if (contact.status === Status.REPLIED || contact.status === Status.BOUNCED || contact.status === Status.RESPONDED_BACK) {
              console.log(`[Worker] Contact ${contact.email} already handled (Status: ${contact.status}). Skipping.`);
              continue;
            }

            console.log(`[Worker] Match found! Updating contact ${contact.email} to REPLIED.`);

            await prisma.contact.update({
              where: { id: contact.id },
              data: { status: Status.REPLIED }
            });

            if ((user.preferences?.stopAllCompanyMailsOnReply ?? true) && contact.companyId) {
              await prisma.contact.updateMany({
                where: {
                  companyId: contact.companyId,
                  id: { not: contact.id },
                  status: Status.ACTIVE,
                  userId: user.id
                },
                data: { status: Status.STOPPED }
              });
              console.log(`[Worker] Stopped active contacts for company ${contact.companyId}`);
            }

            const deletedInfo = await prisma.emailLog.deleteMany({
              where: {
                contactId: contact.id,
                status: EmailLogStatus.SCHEDULED
              }
            });
            console.log(`[Worker] Deleted ${deletedInfo.count} scheduled emails for ${contact.email}`);
          }
        }

        connection.end();
      } catch (err) {
        console.error(`[Worker] IMAP Error for user ${user.email}:`, err);
      }
    }
  } catch (error) {
    console.error('[Worker] Error checking replies:', error);
  }
}

async function main() {
  console.log('[Worker] Service started.');
  while (true) {
    await processEmailQueue();
    await checkRepliesAndBounces();
    // Check every 30 seconds
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
}

main().catch((e) => {
  console.error('[Worker] Fatal error:', e);
  process.exit(1);
});
