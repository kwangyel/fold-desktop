import { useEffect } from "react";
import { startAgentNotifications } from "../lib/agentNotifications";

/**
 * Mount point for the OS-level agent signals (notifications + dock badge).
 * Renders nothing; it just keeps the store subscriptions alive for the life of
 * the app. Mounted once — see `CenterPane`.
 */
export default function AgentNotifications() {
  useEffect(() => startAgentNotifications(), []);
  return null;
}
