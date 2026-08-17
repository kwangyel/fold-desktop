import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./git";

export interface LinearStatus {
  authenticated: boolean;
  userName: string | null;
  userEmail: string | null;
  organizationName: string | null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  stateName: string | null;
  stateType: string | null;
  stateColor: string | null;
  teamKey: string | null;
  teamName: string | null;
  assigneeName: string | null;
  priorityLabel: string | null;
}

const DISCONNECTED: LinearStatus = {
  authenticated: false,
  userName: null,
  userEmail: null,
  organizationName: null,
};

/** Current Linear OAuth state. */
export async function linearStatus(): Promise<LinearStatus> {
  if (!isTauri()) return DISCONNECTED;
  return invoke<LinearStatus>("linear_status");
}

/** Open Linear in the browser and complete PKCE OAuth. */
export async function linearConnect(): Promise<LinearStatus> {
  if (!isTauri()) {
    throw new Error("Linear connection requires the Tauri desktop app.");
  }
  return invoke<LinearStatus>("linear_connect");
}

/** Stop an in-flight Linear browser login. */
export async function linearConnectCancel(): Promise<void> {
  if (!isTauri()) return;
  await invoke("linear_connect_cancel");
}

/** Revoke the saved Linear token and disconnect. */
export async function linearDisconnect(): Promise<LinearStatus> {
  if (!isTauri()) return DISCONNECTED;
  return invoke<LinearStatus>("linear_disconnect");
}

/** Assigned open issues when `query` is empty; otherwise search Linear. */
export async function linearListIssues(
  query?: string,
  first?: number,
): Promise<LinearIssue[]> {
  if (!isTauri()) return [];
  return invoke<LinearIssue[]>("linear_list_issues", {
    query: query?.trim() || null,
    first: first ?? null,
  });
}

/** Fetch one issue by UUID or identifier (`KIN-25`). */
export async function linearGetIssue(id: string): Promise<LinearIssue | null> {
  if (!isTauri()) return null;
  return invoke<LinearIssue | null>("linear_get_issue", { id });
}

/** Move a Linear issue to its team's completed workflow state. */
export async function linearCloseIssue(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("linear_close_issue", { id });
}
