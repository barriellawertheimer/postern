import type { AdminMail, OwnerNotification, ProtonMailerLike, SendResult } from "../../src/services/proton.js";

export class FakeMailer implements ProtonMailerLike {
  sent: OwnerNotification[] = [];
  adminSent: AdminMail[] = [];
  failNext = false;
  failNextAdmin = false;

  async send(input: OwnerNotification): Promise<SendResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("smtp error");
    }
    this.sent.push(input);
    return { messageId: `<${this.sent.length}@test>`, accepted: ["owner@test"] };
  }

  async sendAdminMail(input: AdminMail): Promise<SendResult> {
    if (this.failNextAdmin) {
      this.failNextAdmin = false;
      throw new Error("smtp admin error");
    }
    this.adminSent.push(input);
    return { messageId: `<admin-${this.adminSent.length}@test>`, accepted: ["owner@test"] };
  }

  async close(): Promise<void> {
    /* no-op */
  }
}
