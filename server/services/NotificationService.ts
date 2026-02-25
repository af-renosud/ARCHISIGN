import crypto from "crypto";
import { sendEmail, getGmailProfile } from "../gmail";
import { downloadFile } from "../fileStorage";
import { storage } from "../storage";
import { buildSigningLink } from "./SecurityService";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface EmailSettings {
  registrationLine: string;
  footerText: string;
  firmName: string;
  invitationBody: string;
  otpBody: string;
  completionBody: string;
  subjectPrefix: string;
}

export async function loadEmailSettings(): Promise<EmailSettings> {
  const allSettings = await storage.getAllSettings();
  const map: Record<string, string> = {};
  for (const s of allSettings) {
    map[s.key] = s.value;
  }
  return {
    registrationLine: map["email_registration_line"] || "INSCRIPTION \u00C0 L\u2019ORDRE DES ARCHITECTES OCCITANIE S24348",
    footerText: map["email_footer_text"] || "Powered by Archisign",
    firmName: map["firm_name"] || "Archisign",
    invitationBody: map["email_invitation_body"] || "You have been invited to review and sign the following document.",
    otpBody: map["email_otp_body"] || "Please use the verification code below to access the document. This code expires in 10 minutes.",
    completionBody: map["email_completion_body"] || "All parties have completed signing the document. The signed document is now available for download.",
    subjectPrefix: map["email_invitation_subject_prefix"] || "Signature Required:",
  };
}

export function wrapEmail(bodyContent: string, baseUrl: string, emailCfg: EmailSettings): string {
  const firmLogoUrl = `${baseUrl}/logo.png`;
  const platformLogoUrl = `${baseUrl}/archisign-platform-logo.png`;
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
      <div style="text-align: center; padding: 24px 0 16px 0; border-bottom: 1px solid #e2e8f0;">
        <img src="${firmLogoUrl}" alt="${emailCfg.firmName}" style="max-height: 48px; border-radius: 50%;" />
      </div>
      <div style="padding: 24px;">
        ${bodyContent}
      </div>
      <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center;">
        <p style="color: #94a3b8; font-size: 11px; margin: 0 0 8px 0;">${emailCfg.registrationLine}</p>
        <div style="margin: 8px 0 4px 0;">
          <img src="${platformLogoUrl}" alt="Archisign" style="height: 20px; opacity: 0.6;" />
        </div>
        <p style="color: #b0b8c4; font-size: 10px; margin: 0;">${emailCfg.footerText}</p>
      </div>
    </div>
  `;
}

const WEBHOOK_MAX_ATTEMPTS = 3;
const WEBHOOK_BACKOFF_MS = [1000, 3000];

function signPayload(body: string): string | null {
  const secret = process.env.ARCHISIGN_WEBHOOK_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export async function dispatchWebhook(webhookUrl: string, payload: any): Promise<boolean> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature) {
    headers["x-archisign-signature"] = signature;
  }

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        if (attempt > 1) {
          console.log(`[Webhook] Delivered on attempt ${attempt} to ${webhookUrl}`);
        }
        return true;
      }

      if (response.status >= 500) {
        console.error(`[Webhook] Attempt ${attempt}/${WEBHOOK_MAX_ATTEMPTS} returned ${response.status} from ${webhookUrl}`);
      } else {
        console.error(`[Webhook] Non-retryable ${response.status} from ${webhookUrl}: ${response.statusText}`);
        return false;
      }
    } catch (err: any) {
      console.error(`[Webhook] Attempt ${attempt}/${WEBHOOK_MAX_ATTEMPTS} network error for ${webhookUrl}: ${err.message}`);
    }

    if (attempt < WEBHOOK_MAX_ATTEMPTS) {
      const delay = WEBHOOK_BACKOFF_MS[attempt - 1] || 3000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  console.error(`[Webhook] All ${WEBHOOK_MAX_ATTEMPTS} attempts exhausted for ${webhookUrl}`);
  return false;
}

interface SignerInfo {
  email: string;
  fullName: string;
  accessToken: string;
}

interface EnvelopeInfo {
  id: number;
  subject: string;
  externalRef: string | null;
  message?: string | null;
  gmailThreadId: string | null;
}

export async function sendSigningInvitation(
  signer: SignerInfo,
  envelope: EnvelopeInfo,
  baseUrl: string,
  emailCfg: EmailSettings,
): Promise<{ threadId?: string }> {
  const signingUrl = buildSigningLink(baseUrl, signer.accessToken);
  const htmlBody = wrapEmail(`
      <h2 style="color: #1e40af; margin-top: 0;">Document Ready for Signing</h2>
      <p>Dear ${escapeHtml(signer.fullName)},</p>
      <p>${emailCfg.invitationBody}</p>
      <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 4px 0;"><strong>Subject:</strong> ${escapeHtml(envelope.subject)}</p>
        ${envelope.externalRef ? `<p style="margin: 4px 0;"><strong>Reference:</strong> ${escapeHtml(envelope.externalRef)}</p>` : ""}
        ${envelope.message ? `<p style="margin: 12px 0 4px 0; white-space: pre-line;">${escapeHtml(envelope.message)}</p>` : ""}
      </div>
      <p>Please click the button below to verify your identity and review the document:</p>
      <a href="${signingUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Review & Sign Document</a>
      <p style="margin-top: 24px; color: #64748b; font-size: 12px;">This is a secure link. Do not share it with anyone.</p>
  `, baseUrl, emailCfg);

  const result = await sendEmail(
    signer.email,
    `[${emailCfg.firmName}] ${emailCfg.subjectPrefix} ${envelope.subject}`,
    htmlBody,
  );

  return { threadId: result.threadId ?? undefined };
}

export async function sendResendInvitation(
  signer: SignerInfo,
  envelope: EnvelopeInfo,
  baseUrl: string,
  emailCfg: EmailSettings,
): Promise<void> {
  const signingUrl = buildSigningLink(baseUrl, signer.accessToken);
  const htmlBody = wrapEmail(`
      <h2 style="color: #1e40af; margin-top: 0;">Reminder: Document Awaiting Your Signature</h2>
      <p>Dear ${escapeHtml(signer.fullName)},</p>
      <p>This is a reminder that a document is still awaiting your signature.</p>
      <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 4px 0;"><strong>Subject:</strong> ${escapeHtml(envelope.subject)}</p>
        ${envelope.externalRef ? `<p style="margin: 4px 0;"><strong>Reference:</strong> ${escapeHtml(envelope.externalRef)}</p>` : ""}
      </div>
      <p>Please click the button below to verify your identity and review the document:</p>
      <a href="${signingUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Review & Sign Document</a>
      <p style="margin-top: 24px; color: #64748b; font-size: 12px;">This is a secure link. Do not share it with anyone.</p>
  `, baseUrl, emailCfg);

  await sendEmail(
    signer.email,
    `[${emailCfg.firmName}] Reminder: ${emailCfg.subjectPrefix} ${envelope.subject}`,
    htmlBody,
    envelope.gmailThreadId || undefined,
  );
}

export async function sendReplyNotification(
  signer: SignerInfo,
  envelope: EnvelopeInfo,
  message: string,
  baseUrl: string,
  emailCfg: EmailSettings,
): Promise<void> {
  const htmlBody = wrapEmail(`
      <h3 style="color: #1e40af; margin-top: 0;">Response from Architect</h3>
      <p>Dear ${escapeHtml(signer.fullName)},</p>
      <p>Regarding: <strong>${escapeHtml(envelope.subject)}</strong></p>
      <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0; white-space: pre-wrap;">${escapeHtml(message)}</div>
      <p>You may continue to <a href="${buildSigningLink(baseUrl, signer.accessToken)}">review and sign the document</a>.</p>
  `, baseUrl, emailCfg);

  await sendEmail(
    signer.email,
    `Re: [${emailCfg.firmName}] ${envelope.subject}`,
    htmlBody,
    envelope.gmailThreadId || undefined,
  );
}

export async function sendOtpEmail(
  signer: SignerInfo,
  envelopeSubject: string,
  otp: string,
  baseUrl: string,
  emailCfg: EmailSettings,
): Promise<void> {
  await sendEmail(
    signer.email,
    `[${emailCfg.firmName}] Your verification code: ${otp}`,
    wrapEmail(`
      <h2 style="color: #1e40af; margin-top: 0;">Verification Code</h2>
      <p>Dear ${escapeHtml(signer.fullName)},</p>
      <p>${emailCfg.otpBody}</p>
      <p>Your verification code for signing "${escapeHtml(envelopeSubject)}" is:</p>
      <div style="background: #f8fafc; border-radius: 8px; padding: 24px; margin: 16px 0; text-align: center;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1e40af;">${otp}</span>
      </div>
      <p style="color: #64748b; font-size: 12px;">If you did not request this code, please ignore this email.</p>
    `, baseUrl, emailCfg),
  );
}

export async function sendQueryNotification(
  signer: { fullName: string; email: string },
  envelope: EnvelopeInfo,
  message: string,
  firmEmail: string,
  baseUrl: string,
  emailCfg: EmailSettings,
): Promise<void> {
  await sendEmail(
    firmEmail,
    `[${emailCfg.firmName} Query] ${envelope.subject} - from ${signer.fullName}`,
    wrapEmail(`
      <h2 style="color: #dc2626; margin-top: 0;">Clarification Request</h2>
      <div style="background: #fef2f2; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 4px 0;"><strong>Document:</strong> ${escapeHtml(envelope.subject)}</p>
        <p style="margin: 4px 0;"><strong>From:</strong> ${escapeHtml(signer.fullName)} (${escapeHtml(signer.email)})</p>
        ${envelope.externalRef ? `<p style="margin: 4px 0;"><strong>Reference:</strong> ${escapeHtml(envelope.externalRef)}</p>` : ""}
      </div>
      <h3>Query:</h3>
      <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin: 16px 0; white-space: pre-wrap;">${escapeHtml(message)}</div>
      <p style="color: #64748b; font-size: 12px;">Reply to this email or respond through the ${emailCfg.firmName} admin panel.</p>
    `, baseUrl, emailCfg),
    envelope.gmailThreadId || undefined,
  );
}

interface CompletionSigner {
  email: string;
  fullName: string;
  accessToken: string;
}

export async function sendCompletionNotifications(
  envelope: EnvelopeInfo & { signedPdfUrl: string | null },
  signers: CompletionSigner[],
  baseUrl: string,
  emailCfg: EmailSettings,
): Promise<void> {
  const firmEmail = await getGmailProfile();

  let signedPdfAttachment: { filename: string; content: Buffer; mimeType: string } | null = null;
  if (envelope.signedPdfUrl) {
    try {
      const signedFile = await downloadFile(envelope.signedPdfUrl);
      if (signedFile) {
        signedPdfAttachment = {
          filename: `signed_${envelope.subject.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`,
          content: Buffer.from(signedFile.data),
          mimeType: "application/pdf",
        };
      }
    } catch (dlErr) {
      console.error("Failed to download signed PDF for email attachment:", dlErr);
    }
  }

  for (const s of signers) {
    try {
      const downloadUrl = `${baseUrl}/api/sign/${s.accessToken}/download`;
      await sendEmail(
        s.email,
        `[${emailCfg.firmName}] Document signed: ${envelope.subject}`,
        wrapEmail(`
          <h2 style="color: #16a34a; margin-top: 0;">Document Successfully Signed</h2>
          <p>Dear ${escapeHtml(s.fullName)},</p>
          <p>${emailCfg.completionBody}</p>
          ${envelope.externalRef ? `<p><strong>Reference:</strong> ${escapeHtml(envelope.externalRef)}</p>` : ""}
          <p>A signed copy of the document is attached to this email. You can also download it using the link below:</p>
          <p style="margin: 16px 0;"><a href="${downloadUrl}" style="display: inline-block; padding: 10px 24px; background-color: #16a34a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">Download Signed Document</a></p>
        `, baseUrl, emailCfg),
        envelope.gmailThreadId || undefined,
        signedPdfAttachment ? [signedPdfAttachment] : undefined,
      );
    } catch (err) {
      console.error(`Failed to send signed notification to ${s.email}:`, err);
    }
  }

  if (firmEmail) {
    try {
      await sendEmail(
        firmEmail,
        `[${emailCfg.firmName}] All signatures complete: ${envelope.subject}`,
        wrapEmail(`
          <h2 style="color: #16a34a; margin-top: 0;">All Signatures Collected</h2>
          <p>${emailCfg.completionBody}</p>
          ${envelope.externalRef ? `<p><strong>Reference:</strong> ${escapeHtml(envelope.externalRef)}</p>` : ""}
          <p>Signers: ${signers.map(s => escapeHtml(s.fullName)).join(", ")}</p>
        `, baseUrl, emailCfg),
        envelope.gmailThreadId || undefined,
      );
    } catch (err) {
      console.error("Failed to send completion notification:", err);
    }
  }
}

export { getGmailProfile };
