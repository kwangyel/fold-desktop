import { useEffect, useState } from "react";
import { setDismissedVersion, shouldShowOptionalPrompt } from "../lib/updatePrompt";
import { useUpdateStore } from "../store/updateStore";
import UpdateDialog from "./UpdateDialog";

/**
 * Shows the optional-update dialog when a non-compulsory update is available
 * and the user hasn't already deferred that version. Mandatory updates are
 * handled by the blocking UpdateRequiredScreen in App.tsx, not here.
 */
export default function UpdatePromptWatcher() {
  const status = useUpdateStore((s) => s.status);
  const latest = useUpdateStore((s) => s.latest);
  const phase = useUpdateStore((s) => s.phase);
  const [closed, setClosed] = useState(false);

  // A newer version arriving re-opens the prompt.
  useEffect(() => {
    setClosed(false);
  }, [latest]);

  const installing = phase === "downloading" || phase === "installing";
  const show =
    status === "optional" &&
    !closed &&
    (installing || shouldShowOptionalPrompt(latest));

  if (!show) return null;

  return (
    <UpdateDialog
      onClose={() => {
        if (latest) setDismissedVersion(latest);
        setClosed(true);
      }}
    />
  );
}
