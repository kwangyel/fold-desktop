import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar from "./components/Sidebar";
import CenterPane from "./components/CenterPane";
import RightPane from "./components/RightPane";
import LoginScreen from "./components/LoginScreen";
import ResizeHandle from "./components/ResizeHandle";
import StatusBar from "./components/StatusBar";
import UpdateRequiredScreen from "./components/UpdateRequiredScreen";
import { setupAppMenu } from "./lib/appMenu";
import { useAuthStore } from "./store/authStore";
import { useHarnessStore } from "./store/harnessStore";
import { useContextUsageStore } from "./store/contextUsageStore";
import { useUpdateStore } from "./store/updateStore";
import { usePanelSizes } from "./hooks/usePanelSizes";
import "./App.css";

const appWindow = getCurrentWindow();

export default function App() {
  const authStatus = useAuthStore((s) => s.status);
  const initAuth = useAuthStore((s) => s.init);
  const refreshHarnesses = useHarnessStore((s) => s.refresh);
  const updateStatus = useUpdateStore((s) => s.status);
  const runUpdateCheck = useUpdateStore((s) => s.runCheck);
  const {
    sizes,
    adjustSidebarWidth,
    adjustRightWidth,
    adjustRightTopRatio,
    adjustSidebarTopRatio,
  } = usePanelSizes();
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void setupAppMenu();
    void initAuth();
  }, [initAuth]);

  // Check for app updates on launch, then periodically. A compulsory update
  // flips `updateStatus` to "mandatory" and blocks the app below.
  useEffect(() => {
    void runUpdateCheck();
    const id = setInterval(() => void runUpdateCheck(), 6 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [runUpdateCheck]);

  // Detect already-connected harnesses on sign-in — don't wait for ModelPicker.
  useEffect(() => {
    if (authStatus !== "signedIn") return;
    void refreshHarnesses().then(() => {
      useContextUsageStore.getState().refresh();
    });
  }, [authStatus, refreshHarnesses]);

  const handleTitlebarMouseDown = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;

      if (e.detail === 2) {
        await appWindow.toggleMaximize();
      } else {
        await appWindow.startDragging();
      }
    },
    [],
  );

  const workspaceWidth = () => workspaceRef.current?.clientWidth ?? window.innerWidth;

  const onSidebarDrag = useCallback(
    (dx: number) => {
      adjustSidebarWidth(dx, workspaceWidth());
    },
    [adjustSidebarWidth],
  );

  const onRightDrag = useCallback(
    (dx: number) => {
      // Handle sits on the left edge of the right pane; drag right shrinks it.
      adjustRightWidth(-dx, workspaceWidth());
    },
    [adjustRightWidth],
  );

  return (
    <div className="app">
      <div className="titlebar">
        <div
          className="titlebar-drag"
          data-tauri-drag-region
          onMouseDown={handleTitlebarMouseDown}
        />
      </div>
      {updateStatus === "mandatory" ? (
        <UpdateRequiredScreen />
      ) : authStatus === "signedIn" ? (
        <>
          <div className="workspace" ref={workspaceRef}>
            <Sidebar
              width={sizes.sidebarWidth}
              topRatio={sizes.sidebarTopRatio}
              onSplitDrag={adjustSidebarTopRatio}
            />
            <ResizeHandle orientation="vertical" onDrag={onSidebarDrag} />
            <CenterPane />
            <ResizeHandle orientation="vertical" onDrag={onRightDrag} />
            <RightPane
              width={sizes.rightWidth}
              topRatio={sizes.rightTopRatio}
              onSplitDrag={adjustRightTopRatio}
            />
          </div>
          <StatusBar />
        </>
      ) : authStatus === "loading" ? (
        <div className="workspace app-loading" />
      ) : (
        <div className="workspace">
          <LoginScreen />
        </div>
      )}
    </div>
  );
}
