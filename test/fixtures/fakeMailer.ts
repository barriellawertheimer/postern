import type { OwnerNotification, ProtonMailerLike, SendResult } from "../../src/services/proton.js";

export class FakeMailer implements ProtonMailerLike {
  sent: OwnerNotification[] = [];
  failNext = false;

  async send(input: OwnerNotification): Promise<SendResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("smtp error");
    }
    this.sent.push(input);
    return { messageId: `<${this.sent.length}@test>`, accepted: ["owner@test"] };
  }

  async close(): Promise<void> {
    /* no-op */
  }
}
