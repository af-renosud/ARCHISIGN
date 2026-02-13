import { google } from 'googleapis';

let connectionSettings: any;

async function getAccessToken() {
  if (connectionSettings && connectionSettings.settings.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? 'depl ' + process.env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-mail',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('Gmail not connected');
  }
  return accessToken;
}

export async function getUncachableGmailClient() {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export async function sendEmail(to: string, subject: string, body: string, threadId?: string, attachments?: Array<{ filename: string; content: Buffer; mimeType: string }>) {
  const gmail = await getUncachableGmailClient();

  const boundary = 'boundary_' + Date.now();
  let rawParts: string[] = [];

  if (attachments && attachments.length > 0) {
    rawParts.push(
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      `To: ${to}`,
      `Subject: ${subject}`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      body,
    );

    for (const att of attachments) {
      rawParts.push(
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${att.filename}"`,
        '',
        att.content.toString('base64'),
      );
    }
    rawParts.push(`--${boundary}--`);
  } else {
    rawParts.push(
      `Content-Type: text/html; charset=utf-8`,
      `To: ${to}`,
      `Subject: ${subject}`,
      '',
      body,
    );
  }

  const raw = Buffer.from(rawParts.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const params: any = {
    userId: 'me',
    requestBody: { raw },
  };

  if (threadId) {
    params.requestBody.threadId = threadId;
  }

  const result = await gmail.users.messages.send(params);
  return result.data;
}

export async function getGmailProfile() {
  try {
    const gmail = await getUncachableGmailClient();
    const profile = await gmail.users.getProfile({ userId: 'me' });
    return profile.data.emailAddress;
  } catch {
    return null;
  }
}
