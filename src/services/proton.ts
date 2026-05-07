// Proton SMTP transport (smtp.protonmail.ch:587, STARTTLS, address + token).
//
// Pool config: 1 connection, 1 message/sec — Proton throttles aggressively
// and a single sequential connection trivially stays under the 300/hour cap.
//
// `From:` is forced to the authenticated owner address (Proton's anti-spoof
// rewrites it anyway). `Reply-To:` is the SL `reverse_alias_address`, which
// is what closes the loop.

import nodemailer, { type Transporter } from "nodemailer";
import type { Logger } from "../lib/log.js";

export interface ProtonConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  ownerEmail: string;
  logger?: Logger;
}

export interface OwnerNotification {
  visitorFirstName: string;
  visitorLastName: string;
  visitorPrettyAlias: string;
  reverseAliasAddress: string;
  subject?: string;
  message: string;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
}

export interface ProtonMailerLike {
  send(input: OwnerNotification): Promise<SendResult>;
  close(): Promise<void>;
}

export class ProtonMailer implements ProtonMailerLike {
  private readonly transport: Transporter;
  private readonly cfg: ProtonConfig;

  constructor(cfg: ProtonConfig, transport?: Transporter) {
    this.cfg = cfg;
    this.transport = transport ?? nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: false, // STARTTLS upgrade on 587
      requireTLS: true,
      auth: { user: cfg.user, pass: cfg.pass },
      pool: true,
      maxConnections: 1,
      rateLimit: 1, // 1 message per rateDelta (default 1s)
      tls: { minVersion: "TLSv1.2" },
    });
  }

  async send(input: OwnerNotification): Promise<SendResult> {
    const subject = input.subject?.trim() || `Contact form: ${input.visitorFirstName} ${input.visitorLastName}`.trim();
    const fullName = `${input.visitorFirstName} ${input.visitorLastName}`.trim();

    const text = renderText(input, fullName);
    const html = renderHtml(input, fullName);

    const info = await this.transport.sendMail({
      from: this.cfg.ownerEmail, // Proton rewrites to authenticated address regardless
      to: this.cfg.ownerEmail,
      replyTo: input.reverseAliasAddress, // SL reverse alias — Reply routes back to visitor
      subject,
      text,
      html,
      headers: {
        "X-Alias-Pretty": input.visitorPrettyAlias,
        "X-Postern-Source": "contact-form",
      },
    });

    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
    };
  }

  async close(): Promise<void> {
    this.transport.close();
  }
}

function renderText(input: OwnerNotification, fullName: string): string {
  return [
    `New contact form submission`,
    ``,
    `From:    ${fullName}`,
    `Alias:   ${input.visitorPrettyAlias}`,
    ``,
    `--`,
    input.message,
    `--`,
    ``,
    `Hit Reply in Proton — your response is routed via SimpleLogin (${input.reverseAliasAddress}).`,
    `Proton will rewrite the From: to your own address; that's expected (anti-spoofing), not a bug.`,
    `Delete the alias in SimpleLogin to permanently block this sender.`,
  ].join("\n");
}

function renderHtml(input: OwnerNotification, fullName: string): string {
  const safeName = escapeHtml(fullName);
  const safePretty = escapeHtml(input.visitorPrettyAlias);
  const safeReverse = escapeHtml(input.reverseAliasAddress);
  const safeMessage = escapeHtml(input.message).replace(/\n/g, "<br>");
  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5">
<h2 style="margin:0 0 12px 0">New contact form submission</h2>
<table style="border-collapse:collapse;margin-bottom:16px">
  <tr><td style="padding:2px 12px 2px 0;color:#666">From</td><td><strong>${safeName}</strong></td></tr>
  <tr><td style="padding:2px 12px 2px 0;color:#666">Alias</td><td><code>${safePretty}</code></td></tr>
</table>
<blockquote style="border-left:3px solid #ddd;padding:8px 16px;margin:0 0 16px 0;color:#222">
${safeMessage}
</blockquote>
<p style="font-size:12px;color:#666">
Hit <strong>Reply</strong> in Proton — your response is routed via SimpleLogin
(<code>${safeReverse}</code>). Proton will rewrite the <code>From:</code> to your own
address; that's expected (anti-spoofing), not a bug. Delete the alias in
SimpleLogin to permanently block this sender.
</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
