// In-memory SimpleLogin double. Implements the same surface area as
// SimpleLoginClient — the route under test calls these methods.
//
// Programmable hooks let individual tests drive specific behaviors:
//   - `expireOnce`: next createCustomAlias rejects with signed_suffix_expired
//   - `failContact`: next createContact throws

import { SimpleLoginError } from "../../src/services/simplelogin.js";

export interface FakeAlias {
  id: number;
  alias: string;
  prefix: string;
  contacts: Array<{ id: number; email: string; reverseAlias: string }>;
  deleted: boolean;
}

export class FakeSimpleLogin {
  ownerDomain = "ownerdomain.com";
  aliases: FakeAlias[] = [];
  optionsCalls = 0;
  createAliasCalls = 0;
  createContactCalls = 0;
  deleteAliasCalls = 0;
  expireOnce = false;
  failContact = false;
  failContactWith: SimpleLoginError | Error | null = null;
  private nextId = 100;
  private nextContactId = 1000;
  private currentSignedSuffix = "valid-suffix-token";

  async options(): Promise<{ signedSuffix: string; prettySuffix: string }> {
    this.optionsCalls++;
    // New token each call so the orchestrator's refetch-on-expiry can be
    // distinguished from a stale cache.
    this.currentSignedSuffix = `signed-${this.optionsCalls}`;
    return { signedSuffix: this.currentSignedSuffix, prettySuffix: `@${this.ownerDomain}` };
  }

  async createCustomAlias(prefix: string, signedSuffix: string): Promise<{ aliasId: number; alias: string }> {
    this.createAliasCalls++;
    if (this.expireOnce) {
      this.expireOnce = false;
      throw new SimpleLoginError("Suffix expired", 410, { error: "signed_suffix expired" }, "signed_suffix_expired");
    }
    if (signedSuffix !== this.currentSignedSuffix) {
      throw new SimpleLoginError("Suffix expired", 410, { error: "signed_suffix expired" }, "signed_suffix_expired");
    }
    const id = this.nextId++;
    const alias = `${prefix}@${this.ownerDomain}`;
    this.aliases.push({ id, alias, prefix, contacts: [], deleted: false });
    return { aliasId: id, alias };
  }

  async createContact(aliasId: number, contact: string): Promise<{ contactId: number; reverseAliasAddress: string }> {
    this.createContactCalls++;
    if (this.failContact) {
      this.failContact = false;
      throw this.failContactWith ?? new Error("contact creation failed");
    }
    const a = this.aliases.find((x) => x.id === aliasId);
    if (!a) throw new SimpleLoginError("alias not found", 404, null);
    const contactId = this.nextContactId++;
    const reverseAlias = `re-${contactId.toString(16)}@${this.ownerDomain}`;
    a.contacts.push({ id: contactId, email: contact, reverseAlias });
    return { contactId, reverseAliasAddress: reverseAlias };
  }

  async deleteAlias(aliasId: number): Promise<void> {
    this.deleteAliasCalls++;
    const a = this.aliases.find((x) => x.id === aliasId);
    if (a) a.deleted = true;
  }

  async close(): Promise<void> {
    /* no-op */
  }
}
