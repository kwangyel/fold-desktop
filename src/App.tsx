import { useCallback, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar from "./components/Sidebar";
import CenterPane from "./components/CenterPane";
import RightPane from "./components/RightPane";
import { setupAppMenu } from "./lib/appMenu";
import "./App.css";

const appWindow = getCurrentWindow();

export default function App() {
  useEffect(() => {
    void setupAppMenu();
  }, []);

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
      <div className="workspace">
        <Sidebar />
        <CenterPane />
        <RightPane />
      </div>
    </div>
  );
}
