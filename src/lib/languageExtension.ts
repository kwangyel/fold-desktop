import { StreamLanguage } from "@codemirror/language";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { less } from "@codemirror/lang-less";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sass } from "@codemirror/lang-sass";
import { sql } from "@codemirror/lang-sql";
import { vue } from "@codemirror/lang-vue";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { csharp, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import type { Extension } from "@codemirror/state";
import type { StreamParser } from "@codemirror/language";

function streamLanguage(mode: StreamParser<unknown>): Extension {
  return StreamLanguage.define(mode);
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
}

function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

export function languageExtensionForPath(path: string): Extension {
  const name = basename(path);
  const ext = extension(path);

  switch (name) {
    case "dockerfile":
    case "containerfile":
      return streamLanguage(dockerFile);
    case "makefile":
    case "gnumakefile":
      return streamLanguage(shell);
    case "cmakelists.txt":
      return streamLanguage(cmake);
    case "gemfile":
    case "rakefile":
    case "podfile":
    case "vagrantfile":
      return streamLanguage(ruby);
    case "cargo.toml":
    case "pyproject.toml":
    case "pipfile":
      return streamLanguage(toml);
  }

  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
    case "es6":
    case "esm":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "vue":
      return vue();
    case "json":
    case "json5":
    case "jsonc":
      return json();
    case "md":
    case "mdx":
    case "markdown":
    case "mdown":
    case "mkd":
    case "rst":
      return markdown();
    case "py":
    case "pyw":
    case "pyi":
    case "pyx":
      return python();
    case "rs":
      return rust();
    case "go":
      return go();
    case "java":
    case "jsp":
    case "gradle":
      return java();
    case "kt":
    case "kts":
      return streamLanguage(kotlin);
    case "cs":
    case "csx":
    case "csproj":
      return streamLanguage(csharp);
    case "php":
    case "phtml":
    case "phps":
      return php();
    case "rb":
    case "rake":
    case "erb":
    case "ru":
    case "gemspec":
      return streamLanguage(ruby);
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
    case "hxx":
    case "inl":
    case "ipp":
      return cpp();
    case "css":
    case "pcss":
    case "postcss":
      return css();
    case "scss":
      return sass();
    case "sass":
      return sass({ indented: true });
    case "less":
      return less();
    case "html":
    case "htm":
    case "xhtml":
      return html();
    case "xml":
    case "xsl":
    case "xslt":
    case "xsd":
    case "dtd":
    case "rng":
    case "rss":
    case "atom":
    case "wsdl":
    case "plist":
    case "svg":
      return xml();
    case "yaml":
    case "yml":
      return yaml();
    case "toml":
      return streamLanguage(toml);
    case "sql":
    case "mysql":
    case "pgsql":
    case "psql":
    case "ddl":
    case "dml":
    case "sqlite":
      return sql();
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ksh":
    case "csh":
    case "tcsh":
    case "bat":
    case "cmd":
      return streamLanguage(shell);
    case "ps1":
    case "psm1":
    case "psc1":
    case "psd1":
      return streamLanguage(powerShell);
    case "swift":
      return streamLanguage(swift);
    case "lua":
      return streamLanguage(lua);
    case "cmake":
      return streamLanguage(cmake);
    default:
      return [];
  }
}
