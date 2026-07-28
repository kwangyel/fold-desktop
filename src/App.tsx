import Sidebar from "./components/Sidebar";
import CenterPane from "./components/CenterPane";
import RightPane from "./components/RightPane";
import "./App.css";

export default function App() {
  return (
    <div className="app">
      <div className="titlebar" />
      <div className="workspace">
        <Sidebar />
        <CenterPane />
        <RightPane />
      </div>
    </div>
  );
}
