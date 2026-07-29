import "./DiffView.css";

const MOCK_DIFF_LINES = [
  "--- a/src/components/RightPane.tsx",
  "+++ b/src/components/RightPane.tsx",
  "@@ -1,28 +1,52 @@",
  "-import { useState } from \"react\";",
  "-",
  "-const MOCK_TABS = [\"Terminal 1\", \"Terminal 2\", \"Diff\"];",
  "+import { useState } from \"react\";",
  "+import FileExplorer from \"./FileExplorer\";",
  "+import ChangesList from \"./ChangesList\";",
  "+import TerminalPanel from \"./TerminalPanel\";",
  " ",
  " export default function RightPane() {",
  "-  const [active, setActive] = useState(0);",
  "+  const [activeTab, setActiveTab] = useState<TopTab>(\"explorer\");",
  " ",
  "   return (",
  "     <section className=\"right\">",
  "-      <div className=\"tabbar\">",
  "+      <div className=\"right-pane-top\">",
  "         ...",
  "       </div>",
  "-      <div className=\"pane-body\">",
  "-        xterm.js terminal will mount here",
  "+      <div className=\"right-pane-bottom\">",
  "+        <TerminalPanel />",
  "       </div>",
  "     </section>",
  "   );",
  " }",
];

export default function DiffView() {
  return (
    <div className="diff-view">
      <div className="diff-view-header">
        <span className="diff-file">src/components/RightPane.tsx</span>
      </div>
      <pre className="diff-content">
        {MOCK_DIFF_LINES.map((line, i) => {
          let className = "diff-line";
          if (line.startsWith("+") && !line.startsWith("+++")) className += " diff-add";
          else if (line.startsWith("-") && !line.startsWith("---")) className += " diff-del";
          else if (line.startsWith("@")) className += " diff-hunk";
          else if (line.startsWith("---") || line.startsWith("+++")) className += " diff-meta";

          return (
            <span key={i} className={className}>
              {line}
              {"\n"}
            </span>
          );
        })}
      </pre>
    </div>
  );
}
