import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

interface FolderInfo {
  name: string;
  path: string;
  file_count: number;
  folder_count: number;
  size_kb: number;
}

interface ProcessOptions {
  respect_gitignore: boolean;
  skip_default_ignores: boolean;
  include_token_count: boolean;
  max_file_size_kb: number;
}

interface ProcessResult {
  output_path: string;
  file_count: number;
  folder_count: number;
  skipped_binary: number;
  skipped_ignored: number;
  token_estimate: number;
  total_size_kb: number;
}

type AppState = "idle" | "loaded" | "processing" | "done" | "error";

export default function App() {
  const [state, setState] = useState<AppState>("idle");
  const [folderInfo, setFolderInfo] = useState<FolderInfo | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [error, setError] = useState<string>("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [progress, setProgress] = useState(0);
  const [options, setOptions] = useState<ProcessOptions>({
    respect_gitignore: true,
    skip_default_ignores: true,
    include_token_count: true,
    max_file_size_kb: 500,
  });

  const loadFolder = useCallback(async (path: string) => {
    setError("");
    try {
      const info = await invoke<FolderInfo>("get_folder_info", { folderPath: path });
      setFolderInfo(info);
      setState("loaded");
    } catch (e) {
      setError(String(e));
      setState("error");
    }
  }, []);

  const handleBrowse = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select your project folder",
      });
      if (selected && typeof selected === "string") {
        await loadFolder(selected);
      }
    } catch (e) {
      setError(String(e));
      setState("error");
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    // Tauri exposes the real file path on the file object
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const file = files[0] as any;
      // Try multiple path properties Tauri may expose
      const path = file.path ?? file.webkitRelativePath ?? null;
      if (path && path !== "") {
        await loadFolder(path);
      } else {
        // Fallback: open dialog
        await handleBrowse();
      }
    }
  };

  const startProgress = () => {
    setProgress(0);
    let p = 0;
    const interval = setInterval(() => {
      p += Math.random() * 8;
      if (p > 90) { p = 90; clearInterval(interval); }
      setProgress(Math.floor(p));
    }, 120);
    return interval;
  };

  const handleProcess = async () => {
    if (!folderInfo) return;
    setState("processing");
    const interval = startProgress();

    try {
      const outputPath = await save({
        title: "Save CODEXT Output",
        defaultPath: `${folderInfo.name}_codext.txt`,
        filters: [{ name: "Text Files", extensions: ["txt"] }],
      });

      if (!outputPath) {
        clearInterval(interval);
        setProgress(0);
        setState("loaded");
        return;
      }

      const res = await invoke<ProcessResult>("process_folder", {
        folderPath: folderInfo.path,
        outputPath,
        options,
      });

      clearInterval(interval);
      setProgress(100);
      setResult(res);
      setState("done");
    } catch (e) {
      clearInterval(interval);
      setProgress(0);
      setError(String(e));
      setState("error");
    }
  };

  const handleReset = () => {
    setState("idle");
    setFolderInfo(null);
    setResult(null);
    setError("");
    setProgress(0);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <span className="logo-bracket">[</span>CODEXT<span className="logo-bracket">]</span>
        </div>
        <p className="tagline">Context Bundler — flatten any codebase into a single .txt</p>
      </header>

      <main className="main">

        {(state === "idle" || state === "error") && (
          <div
            className={`drop-zone ${isDragOver ? "drag-over" : ""}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="drop-icon">
              <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                <rect x="1" y="1" width="50" height="50" rx="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3"/>
                <path d="M26 34V18M26 18L20 24M26 18L32 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M16 38h20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.4"/>
              </svg>
            </div>
            <p className="drop-label">Drop your project folder here</p>
            <p className="drop-sub">or</p>
            <button className="btn-browse" onClick={handleBrowse}>
              Browse folder
            </button>
            {state === "error" && error && (
              <p className="error-msg">⚠ {error}</p>
            )}
          </div>
        )}

        {state === "loaded" && folderInfo && (
          <div className="loaded-view">
            <div className="folder-card">
              <div className="folder-card-icon">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                  <path d="M4 8a2 2 0 012-2h6l3 3h11a2 2 0 012 2v13a2 2 0 01-2 2H6a2 2 0 01-2-2V8z" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
              </div>
              <div className="folder-card-info">
                <span className="folder-card-name">{folderInfo.name}</span>
                <span className="folder-card-path">{folderInfo.path}</span>
              </div>
              <button className="btn-change" onClick={handleReset} title="Change folder">✕</button>
            </div>

            <div className="stats-row">
              <Stat label="Files" value={folderInfo.file_count} />
              <Stat label="Folders" value={folderInfo.folder_count} />
              <Stat label="Size" value={`${(folderInfo.size_kb / 1024).toFixed(2)} MB`} />
            </div>

            <div className="options-panel">
              <p className="options-title">Options</p>
              <div className="options-grid">
                <Toggle label="Respect .gitignore" description="Skip files listed in .gitignore"
                  checked={options.respect_gitignore}
                  onChange={(v) => setOptions({ ...options, respect_gitignore: v })} />
                <Toggle label="Skip defaults" description="Auto-ignore node_modules, .git, dist…"
                  checked={options.skip_default_ignores}
                  onChange={(v) => setOptions({ ...options, skip_default_ignores: v })} />
                <Toggle label="Token count" description="Estimate token count in output"
                  checked={options.include_token_count}
                  onChange={(v) => setOptions({ ...options, include_token_count: v })} />
                <div className="option-row">
                  <div>
                    <p className="option-label">Max file size</p>
                    <p className="option-desc">Skip files larger than this (KB)</p>
                  </div>
                  <div className="size-input-wrap">
                    <input type="number" className="size-input"
                      value={options.max_file_size_kb} min={10} max={10000}
                      onChange={(e) => setOptions({ ...options, max_file_size_kb: Number(e.target.value) })} />
                    <span className="size-unit">KB</span>
                  </div>
                </div>
              </div>
            </div>

            <button className="btn-process" onClick={handleProcess}>
              Bundle to .txt
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M9 3l6 6-6 6M3 9h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        )}

        {state === "processing" && (
          <div className="processing-view">
            <div className="processing-label">Bundling your codebase…</div>
            <div className="progress-bar-wrap">
              <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="progress-pct">{progress}%</p>
          </div>
        )}

        {state === "done" && result && (
          <div className="done-view">
            <div className="done-icon">✓</div>
            <h2 className="done-title">Bundle complete</h2>
            <p className="done-path">{result.output_path}</p>
            <div className="result-grid">
              <ResultStat label="Files processed" value={result.file_count} />
              <ResultStat label="Folders" value={result.folder_count} />
              <ResultStat label="Binary skipped" value={result.skipped_binary} />
              <ResultStat label="Output size" value={`${result.total_size_kb.toFixed(1)} KB`} />
              {result.token_estimate > 0 && (
                <ResultStat label="~Tokens" value={result.token_estimate.toLocaleString()} highlight />
              )}
            </div>
            {result.token_estimate > 0 && (
              <p className="token-note">Context window usage estimate — actual may vary by model</p>
            )}
            <div className="done-actions">
              <button className="btn-process" onClick={handleReset}>Bundle another folder</button>
            </div>
          </div>
        )}
      </main>

      <footer className="footer">
        <span>CODEXT v0.1.0</span>
        <span className="footer-dot">·</span>
        <span>Rust + Tauri + React</span>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-card">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function ResultStat({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`result-stat ${highlight ? "result-stat--highlight" : ""}`}>
      <span className="result-stat-value">{value}</span>
      <span className="result-stat-label">{label}</span>
    </div>
  );
}

function Toggle({ label, description, checked, onChange }: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="option-row" onClick={() => onChange(!checked)}>
      <div>
        <p className="option-label">{label}</p>
        <p className="option-desc">{description}</p>
      </div>
      <div className={`toggle ${checked ? "toggle--on" : ""}`}>
        <div className="toggle-knob" />
      </div>
    </div>
  );
}