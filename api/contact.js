const { createClient } = require("@libsql/client");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const LOGO_PATH = path.join(__dirname, "..", "assets", "img", "logo-round_final.png");
const LOGO_CONTENT_ID = "beartooth-logo";

let logoBase64;

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS contact_submissions (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    overall_status TEXT NOT NULL DEFAULT 'stored',
    internal_email_status TEXT NOT NULL DEFAULT 'pending',
    internal_email_id TEXT,
    confirmation_email_status TEXT NOT NULL DEFAULT 'pending',
    confirmation_email_id TEXT,
    delivery_error TEXT
  )
`;

const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS contact_submissions_created_at_idx
    ON contact_submissions (created_at)
`;

const FIELD_LIMITS = {
  name: 120,
  email: 254,
  subject: 180,
  message: 5000,
};

let database;
let tableReady;

const RECAPTCHA_VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const RECAPTCHA_MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
const RECAPTCHA_EXPECTED_ACTION = "contact";

function getClientIp(request) {
  const forwarded = request.headers && request.headers["x-forwarded-for"];

  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }

  return (
    (request.socket && request.socket.remoteAddress) ||
    (request.connection && request.connection.remoteAddress) ||
    undefined
  );
}

// Verifies the invisible reCAPTCHA v3 token. Returns { ok: true } when the
// captcha passes, or when it is not configured (so local dev keeps working).
async function verifyCaptcha(token, remoteIp) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;

  if (!secret) {
    return { ok: true, skipped: true };
  }

  if (!token) {
    return { ok: false, error: "Captcha verification failed. Please try again." };
  }

  const params = new URLSearchParams({ secret, response: token });

  if (remoteIp) {
    params.set("remoteip", remoteIp);
  }

  let data = {};

  try {
    const response = await fetch(RECAPTCHA_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    data = await response.json();
  } catch (error) {
    console.error("reCAPTCHA verification request failed", { error: error.message });
    return { ok: false, error: "Captcha verification failed. Please try again." };
  }

  if (!data.success) {
    return { ok: false, error: "Captcha verification failed. Please try again." };
  }

  if (data.action && data.action !== RECAPTCHA_EXPECTED_ACTION) {
    return { ok: false, error: "Captcha verification failed. Please try again." };
  }

  if (typeof data.score === "number" && data.score < RECAPTCHA_MIN_SCORE) {
    return { ok: false, error: "Your submission looked automated. Please try again." };
  }

  return { ok: true };
}

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getDatabase() {
  if (!database) {
    database = createClient({
      url: getRequiredEnv("TURSO_DATABASE_URL"),
      authToken: getRequiredEnv("TURSO_AUTH_TOKEN"),
    });
  }

  return database;
}

async function ensureTable() {
  if (!tableReady) {
    tableReady = (async () => {
      await getDatabase().execute(TABLE_SQL);
      await getDatabase().execute(INDEX_SQL);
    })().catch((error) => {
      tableReady = undefined;
      throw error;
    });
  }

  await tableReady;
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

function parseBody(body) {
  if (!body) {
    return {};
  }

  if (typeof body === "string" || Buffer.isBuffer(body)) {
    return Object.fromEntries(new URLSearchParams(body.toString()).entries());
  }

  return body;
}

function normalize(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function hasUnsafeControlCharacters(value) {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

function validateForm(body) {
  const values = {
    name: normalize(body.name),
    email: normalize(body.email),
    subject: normalize(body.subject),
    message: normalize(body.message),
  };

  for (const [field, value] of Object.entries(values)) {
    if (!value) {
      return { error: `The ${field} field is required.` };
    }

    if (value.length > FIELD_LIMITS[field]) {
      return { error: `The ${field} field is too long.` };
    }

    if (hasUnsafeControlCharacters(value)) {
      return { error: "The form contains invalid characters." };
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    return { error: "Please enter a valid email address." };
  }

  if (/[\r\n]/.test(values.subject)) {
    return { error: "The subject must be a single line." };
  }

  return { values };
}

function escapeHtml(value) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}

function formatHtmlText(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function getSiteUrl() {
  return (process.env.PUBLIC_SITE_URL || "https://beartoothconstruction.com").replace(
    /\/+$/,
    ""
  );
}

function getLogoAttachment() {
  if (!logoBase64) {
    logoBase64 = fs.readFileSync(LOGO_PATH).toString("base64");
  }

  return {
    filename: "beartooth-logo.png",
    content: logoBase64,
    content_type: "image/png",
    content_id: LOGO_CONTENT_ID,
  };
}

function getRecipients() {
  return (process.env.CONTACT_RECIPIENTS || "cjheiny76@yahoo.com,bret@schrader.co")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

function getFromAddress() {
  return process.env.CONTACT_FROM_EMAIL || "forms@fastgrowth.top";
}

function emailLayout({ preview, title, content }) {
  const siteUrl = getSiteUrl();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f7f7f7;color:#252525;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(preview)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f7f7f7;">
      <tr>
        <td align="center" style="padding:28px 12px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #eaeaea;">
            <tr>
              <td style="padding:24px 28px;background-color:#252525;border-top:6px solid #ffc925;">
                <a href="${escapeHtml(siteUrl)}" style="text-decoration:none;">
                  <img src="cid:${LOGO_CONTENT_ID}" width="153" alt="Beartooth Construction" style="display:block;width:153px;max-width:100%;height:auto;border:0;">
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:34px 28px 12px;">
                <h1 style="margin:0;color:#252525;font-size:26px;line-height:1.25;font-weight:700;">${escapeHtml(title)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 34px;">
                ${content}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px;background-color:#252525;color:#ffffff;font-size:12px;line-height:1.6;">
                <strong style="color:#ffc925;">Beartooth Construction</strong><br>
                1628 Carlisle Rd, Traverse City, MI 49696<br>
                <a href="tel:+12315908144" style="color:#ffffff;text-decoration:none;">+1 (231) 590-8144</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildInternalEmail(values) {
  const subject = escapeHtml(values.subject);
  const content = `
    <p style="margin:0 0 22px;color:#555555;font-size:16px;line-height:1.6;">A new message was submitted through the Beartooth Construction website.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:0 0 24px;">
      <tr>
        <td style="padding:11px 12px;background-color:#f7f7f7;color:#777777;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;width:30%;">Name</td>
        <td style="padding:11px 12px;border-bottom:1px solid #eeeeee;font-size:15px;">${escapeHtml(values.name)}</td>
      </tr>
      <tr>
        <td style="padding:11px 12px;background-color:#f7f7f7;color:#777777;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Email</td>
        <td style="padding:11px 12px;border-bottom:1px solid #eeeeee;font-size:15px;"><a href="mailto:${escapeHtml(values.email)}" style="color:#252525;">${escapeHtml(values.email)}</a></td>
      </tr>
      <tr>
        <td style="padding:11px 12px;background-color:#f7f7f7;color:#777777;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Subject</td>
        <td style="padding:11px 12px;border-bottom:1px solid #eeeeee;font-size:15px;">${subject}</td>
      </tr>
    </table>
    <div style="margin:0;padding:18px;border-left:4px solid #ffc925;background-color:#fffaf0;color:#252525;font-size:15px;line-height:1.7;word-break:break-word;">${formatHtmlText(values.message)}</div>
    <p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:#777777;">Reply directly to this email to respond to ${escapeHtml(values.name)}.</p>`;

  return {
    subject: `New contact request: ${values.subject}`,
    html: emailLayout({
      preview: `New contact request from ${values.name}`,
      title: "New Contact Request",
      content,
    }),
    text: [
      "New Contact Request",
      "",
      "A new message was submitted through the Beartooth Construction website.",
      "",
      `Name: ${values.name}`,
      `Email: ${values.email}`,
      `Subject: ${values.subject}`,
      "",
      values.message,
    ].join("\n"),
  };
}

function buildConfirmationEmail(values) {
  const siteUrl = getSiteUrl();
  const content = `
    <p style="margin:0 0 18px;color:#555555;font-size:16px;line-height:1.7;">Hi ${escapeHtml(values.name)},</p>
    <p style="margin:0 0 18px;color:#555555;font-size:16px;line-height:1.7;">Thank you for contacting Beartooth Construction. We have received your message and will be in touch soon.</p>
    <div style="margin:24px 0;padding:18px;border-left:4px solid #ffc925;background-color:#fffaf0;color:#252525;font-size:15px;line-height:1.7;">We appreciate your interest in working with us on your construction project.</div>
    <p style="margin:0;color:#555555;font-size:16px;line-height:1.7;">If you need to add anything to your request, simply reply to this email.</p>
    <p style="margin:26px 0 0;"><a href="${escapeHtml(siteUrl)}" style="display:inline-block;padding:13px 20px;background-color:#ffc925;color:#252525;font-size:13px;font-weight:700;text-decoration:none;letter-spacing:.3px;">VISIT OUR WEBSITE</a></p>`;

  return {
    subject: "Thank you for contacting Beartooth Construction",
    html: emailLayout({
      preview: "We received your message and will be in touch soon.",
      title: "Thank You For Contacting Us",
      content,
    }),
    text: [
      `Hi ${values.name},`,
      "",
      "Thank you for contacting Beartooth Construction. We have received your message and will be in touch soon.",
      "",
      "If you need to add anything to your request, simply reply to this email.",
      "",
      siteUrl,
    ].join("\n"),
  };
}

async function sendResendEmail({ submissionId, type, to, replyTo, email }) {
  const apiKey = getRequiredEnv("RESEND_API_KEY");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `contact-${submissionId}-${type}`,
    },
    body: JSON.stringify({
      from: `Beartooth Construction <${getFromAddress()}>`,
      to,
      reply_to: replyTo,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: [getLogoAttachment()],
    }),
  });

  let responseBody = {};

  try {
    responseBody = await response.json();
  } catch (error) {
    responseBody = {};
  }

  if (!response.ok) {
    throw new Error(
      responseBody.message || `Resend request failed with status ${response.status}.`
    );
  }

  return responseBody.id || null;
}

async function updateSubmission(id, updates) {
  const allowedColumns = new Set([
    "overall_status",
    "internal_email_status",
    "internal_email_id",
    "confirmation_email_status",
    "confirmation_email_id",
    "delivery_error",
  ]);
  const entries = Object.entries(updates).filter(([column]) =>
    allowedColumns.has(column)
  );

  if (!entries.length) {
    return;
  }

  const assignments = entries.map(([column]) => `${column} = ?`);
  const args = entries.map(([, value]) => value);
  assignments.push("updated_at = ?");
  args.push(new Date().toISOString(), id);

  await getDatabase().execute({
    sql: `UPDATE contact_submissions SET ${assignments.join(", ")} WHERE id = ?`,
    args,
  });
}

async function safelyUpdateSubmission(id, updates) {
  try {
    await updateSubmission(id, updates);
  } catch (error) {
    console.error("Unable to update contact submission", {
      submissionId: id,
      error: error.message,
    });
  }
}

async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { ok: false, message: "Method not allowed." });
  }

  const body = parseBody(request.body);

  if (normalize(body.website)) {
    return sendJson(response, 200, { ok: true });
  }

  const captcha = await verifyCaptcha(
    normalize(body.recaptcha_token),
    getClientIp(request)
  );

  if (!captcha.ok) {
    return sendJson(response, 400, { ok: false, message: captcha.error });
  }

  const validation = validateForm(body);

  if (validation.error) {
    return sendJson(response, 400, { ok: false, message: validation.error });
  }

  const values = validation.values;
  const submissionId = randomUUID();

  try {
    await ensureTable();
    await getDatabase().execute({
      sql: `
        INSERT INTO contact_submissions (id, name, email, subject, message)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [
        submissionId,
        values.name,
        values.email,
        values.subject,
        values.message,
      ],
    });
  } catch (error) {
    console.error("Unable to store contact submission", { error: error.message });
    return sendJson(response, 500, {
      ok: false,
      message: "We could not save your message. Please try again.",
    });
  }

  try {
    const internalEmail = buildInternalEmail(values);
    const internalEmailId = await sendResendEmail({
      submissionId,
      type: "internal",
      to: getRecipients(),
      replyTo: values.email,
      email: internalEmail,
    });

    await safelyUpdateSubmission(submissionId, {
      overall_status: "internal_sent",
      internal_email_status: "sent",
      internal_email_id: internalEmailId,
      delivery_error: null,
    });
  } catch (error) {
    await safelyUpdateSubmission(submissionId, {
      overall_status: "failed",
      internal_email_status: "failed",
      delivery_error: `Internal email failed: ${error.message}`,
    });
    console.error("Unable to send internal contact notification", {
      submissionId,
      error: error.message,
    });
    return sendJson(response, 502, {
      ok: false,
      message: "We could not send your message. Please try again.",
    });
  }

  try {
    const confirmationEmail = buildConfirmationEmail(values);
    const confirmationEmailId = await sendResendEmail({
      submissionId,
      type: "confirmation",
      to: [values.email],
      replyTo: process.env.CONTACT_REPLY_TO || "cjheiny76@yahoo.com",
      email: confirmationEmail,
    });

    await safelyUpdateSubmission(submissionId, {
      overall_status: "completed",
      confirmation_email_status: "sent",
      confirmation_email_id: confirmationEmailId,
      delivery_error: null,
    });
  } catch (error) {
    await safelyUpdateSubmission(submissionId, {
      overall_status: "partial",
      confirmation_email_status: "failed",
      delivery_error: `Visitor confirmation failed: ${error.message}`,
    });
    console.error("Unable to send visitor confirmation", {
      submissionId,
      error: error.message,
    });
  }

  return sendJson(response, 200, { ok: true });
}

module.exports = handler;
