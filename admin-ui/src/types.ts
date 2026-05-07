// Shape of the JSON the backend returns. Kept in sync with src/db/repo.ts
// + src/admin/api.ts. Not generated; manually mirror when fields change.

export type VisitorStatus = "active" | "blocked";

export interface VisitorDTO {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  aliasLocal: string;
  aliasFull: string;
  slAliasId: number;
  slReverseAlias: string;
  status: VisitorStatus;
  createdAt: number;
  lastSeenAt: number;
}

export interface SubmissionDTO {
  id: number;
  visitorId: number;
  message: string;
  ipHashHex: string | null;
  uaHashHex: string | null;
  createdAt: number;
}

export interface AuditEntryDTO {
  id: number;
  event: string;
  visitorId: number | null;
  detail: string | null;
  createdAt: number;
}

export interface FailureSummary {
  event: string;
  count: number;
  lastAt: number;
}

export interface DashboardDTO {
  sendsToday: number;
  cap: number;
  breakerThreshold: number;
  breakerTripped: boolean;
  visitorsActive: number;
  visitorsBlocked: number;
  failures24h: FailureSummary[];
}

export interface PagedResponse<T> {
  rows: T[];
  total: number;
}
