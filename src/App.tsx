import { useCallback, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar from "./components/Sidebar";
import CenterPane from "./components/CenterPane";
import RightPane from "./components/RightPane";
import LoginScreen from "./components/LoginScreen";
import { setupAppMenu } from "./lib/appMenu";
import { useAuthStore } from "./store/authStore";
import "./App.css";

const appWindow = getCurrentWindow();

export default function App() {
  const authStatus = useAuthStore((s) => s.status);
  const initAuth = useAuthStore((s) => s.init);

  useEffect(() => {
    void setupAppMenu();
    void initAuth();
  }, [initAuth]);

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

  return (
    <div className="app">
      <div className="titlebar">
        <div
          className="titlebar-drag"
          data-tauri-drag-region
          onMouseDown={handleTitlebarMouseDown}
        />
      </div>
      {authStatus === "signedIn" ? (
        <div className="workspace">
          <Sidebar />
          <CenterPane />
          <RightPane />
        </div>
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
