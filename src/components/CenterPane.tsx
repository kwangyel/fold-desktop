import { useState } from "react";

const MOCK_TABS = ["README.md", "src/main.rs", "src/App.tsx"];

export default function CenterPane() {
  const [active, setActive] = useState(0);

  return (
    <section className="center">
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
        CodeMirror 6 editor will mount here
      </div>
    </section>
  );
}
