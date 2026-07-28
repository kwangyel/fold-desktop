import { useState } from "react";

const MOCK_TABS = ["Terminal 1", "Terminal 2", "Diff"];

export default function RightPane() {
  const [active, setActive] = useState(0);

  return (
    <section className="right">
      <div className="tabbar">
        {MOCK_TABS.map((t, i) => (
          <div
            key={t}
            className={`tab ${i === active ? "active" : ""}`}
            onClick={() => setActive(i)}
          >
            <span>{t}</span>
            <span className="close">×</span>
          </div>
        ))}
        <div className="tab-add">+</div>
      </div>
      <div className="pane-body">
        xterm.js terminal will mount here
      </div>
    </section>
  );
}
