import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  pre({ children }) {
    return <pre className="md-pre">{children}</pre>;
  },
  code({ className, children, ...props }) {
    const isBlock = Boolean(className);
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="md-inline-code" {...props}>
        {children}
      </code>
    );
  },
  a({ href, children, ...props }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

export default function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="assistant-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
