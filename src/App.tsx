import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FolderInfo {
  name: string; path: string; file_count: number; folder_count: number; size_kb: number;
}
interface ProcessOptions {
  respect_gitignore: boolean; skip_default_ignores: boolean;
  include_token_count: boolean; max_file_size_kb: number;
}
interface ProcessResult {
  output_path: string; file_count: number; folder_count: number;
  skipped_binary: number; skipped_ignored: number; token_estimate: number; total_size_kb: number;
}
interface LicenseStatus {
  is_pro: boolean; key: string | null; machine_id: string; bundle_count: number;
  free_file_limit: number; free_output_kb_limit: number; free_bundle_limit: number;
}
type AppState = "idle" | "loaded" | "processing" | "done" | "error";
type Modal = null | "license" | "limit" | "activating";
interface LimitError { type: "bundles" | "files" | "size"; value?: number; }

// ─── GitHub types ─────────────────────────────────────────────────────────────

interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  updated_at: string;
}

interface TreeNode {
  name: string;
  path: string;        // full path from repo root
  type: "dir" | "file";
  children?: TreeNode[];
  expanded?: boolean;
}

type GhState = "disconnected" | "connecting" | "connected" | "fetching";

// ─── Constants ────────────────────────────────────────────────────────────────

const SITE_URL = "https://codext-web.vercel.app";
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 20;

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Core state ──
  const [state, setState] = useState<AppState>("idle");
  const [folderInfo, setFolderInfo] = useState<FolderInfo | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [error, setError] = useState<string>("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadDismissed, setDownloadDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [limitError, setLimitError] = useState<LimitError | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseMsg, setLicenseMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [activating, setActivating] = useState(false);
  const [pollStatus, setPollStatus] = useState<"idle" | "polling" | "success" | "timeout">("idle");
  const [pollAttempts, setPollAttempts] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [options, setOptions] = useState<ProcessOptions>({
    respect_gitignore: true, skip_default_ignores: true,
    include_token_count: true, max_file_size_kb: 500,
  });

  // ── GitHub state ──
  const [ghState, setGhState] = useState<GhState>("disconnected");
  const [ghUser, setGhUser] = useState<{ login: string; avatar_url: string } | null>(null);
  const [ghToken, setGhToken] = useState<string | null>(null);
  const [ghRepos, setGhRepos] = useState<GhRepo[]>([]);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);
  const [repoTrees, setRepoTrees] = useState<Record<string, TreeNode[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [cloning, setCloning] = useState<string | null>(null);

  // ── Feature flags ──
  const [structureOnly, setStructureOnly] = useState(false);
  const [pickFolders, setPickFolders] = useState(false);

  // ── Folder picker state ──
  const [folderPickerFolders, setFolderPickerFolders] = useState<
    { path: string; name: string; depth: number; excluded: boolean; children?: any[]; expanded: boolean }[]
  >([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [rememberExclusions, setRememberExclusions] = useState(false);
  const [savedExclusions, setSavedExclusions] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("codext_exclusions") ?? "[]"); } catch { return []; }
  });


  // ── On mount ──
  useEffect(() => {
    const init = async () => {
      try {
        const status = await invoke<LicenseStatus>("get_license_status");
        setLicense(status);
        if (!status.is_pro) {
          invoke<{ is_pro: boolean; key: string | null; method: string }>("check_license_remote")
            .then(r => { if (r.is_pro) refreshLicense(); })
            .catch(() => {});
        }
        // Restore saved GitHub token
        try {
          const saved = await invoke<string | null>("get_github_token");
          if (saved) {
            setGhToken(saved);
            fetchGhUser(saved);
          }
        } catch (_) {}
      } catch (e) { console.error("Init error:", e); }
    };
    init();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ─── License helpers ──────────────────────────────────────────────────────

  const refreshLicense = async () => {
    const l = await invoke<LicenseStatus>("get_license_status");
    setLicense(l);
    return l;
  };

  const startPolling = (machineId: string) => {
    setPollStatus("polling"); setPollAttempts(0);
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++; setPollAttempts(attempts);
      try {
        const r = await invoke<{ is_pro: boolean; key: string | null; method: string }>("check_license_remote");
        if (r.is_pro && r.key) {
          clearInterval(pollRef.current!);
          await refreshLicense();
          setPollStatus("success"); setModal(null);
          setTimeout(() => setPollStatus("idle"), 4000);
        }
      } catch (_) {}
      if (attempts >= POLL_MAX_ATTEMPTS) { clearInterval(pollRef.current!); setPollStatus("timeout"); }
    }, POLL_INTERVAL_MS);
  };

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setPollStatus("idle");
  };

  const handleGetPro = async () => {
    setLicenseMsg(null);
    try {
      const machineId = license?.machine_id ?? await invoke<string>("get_machine_id");
      await openUrl(`${SITE_URL}/buy?mid=${encodeURIComponent(machineId)}`);
      setModal("activating"); startPolling(machineId);
    } catch (e) {
      setLicenseMsg({ type: "err", text: "Could not open browser. Please visit codext-web.vercel.app/buy" });
    }
  };

  const handleActivate = async () => {
    setActivating(true); setLicenseMsg(null);
    try {
      const status = await invoke<LicenseStatus>("activate_license", { key: licenseKey });
      setLicense(status);
      setLicenseMsg({ type: "ok", text: "License activated! You now have full Pro access." });
      setLicenseKey(""); stopPolling();
      setTimeout(() => setModal(null), 1800);
    } catch (e) { setLicenseMsg({ type: "err", text: String(e) }); }
    finally { setActivating(false); }
  };

  const handleDeactivate = async () => {
    await invoke("deactivate_license"); await refreshLicense();
    setLicenseMsg({ type: "ok", text: "License removed from this device." });
  };

  // ─── Folder helpers ───────────────────────────────────────────────────────

  const loadFolder = useCallback(async (path: string) => {
    setError("");
    try {
      const info = await invoke<FolderInfo>("get_folder_info", { folderPath: path });
      setFolderInfo(info); setState("loaded");
    } catch (e) { setError(String(e)); setState("error"); }
  }, []);

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select your project folder" });
      if (selected && typeof selected === "string") await loadFolder(selected);
    } catch (e) { setError(String(e)); setState("error"); }
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(false); };

  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenPromise = win.onDragDropEvent((event) => {
      if (event.payload.type === "over") setIsDragOver(true);
      else if (event.payload.type === "cancel") setIsDragOver(false);
      else if (event.payload.type === "drop") {
        setIsDragOver(false);
        const paths = event.payload.paths;
        if (paths && paths.length > 0) loadFolder(paths[0]);
      }
    });
    return () => { unlistenPromise.then(fn => fn()); };
  }, [loadFolder]);

  const handleProcess = async () => {
    if (!folderInfo) return;
    if (pickFolders) { await openFolderPicker(); return; }
    await runBundle();
  };

  const handleOpen = async () => {
    if (!result) return;
    try { await invoke("open_file", { path: result.output_path }); } catch (e) { console.error(e); }
  };

  const handleSaveAs = async () => {
    if (!result) return;
    try {
      const filename = result.output_path.split(/[\\/]/).pop() ?? "codext_output.txt";
      const dest = await save({ title: "Save As", defaultPath: filename, filters: [{ name: "Text Files", extensions: ["txt"] }] });
      if (dest) await invoke("save_file_as", { sourcePath: result.output_path, destPath: dest });
    } catch (e) { console.error(e); }
  };

  const handleCopy = async () => {
    if (!result) return;
    try {
      const content = await invoke<string>("read_output_file", { path: result.output_path });
      await navigator.clipboard.writeText(content);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch (e) { console.error(e); }
  };

  const handleReset = () => {
    setState("idle"); setFolderInfo(null); setResult(null); setError(""); setProgress(0);
  };

  // ─── GitHub helpers ───────────────────────────────────────────────────────

  const fetchGhUser = async (token: string) => {
    try {
      setGhState("fetching");
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
      });
      if (!res.ok) { setGhState("disconnected"); setGhToken(null); return; }
      const user = await res.json();
      setGhUser({ login: user.login, avatar_url: user.avatar_url });
      await fetchGhRepos(token);
      setGhState("connected");
    } catch (_) { setGhState("disconnected"); }
  };

  const fetchGhRepos = async (token: string) => {
    const res = await fetch("https://api.github.com/user/repos?sort=updated&per_page=30&affiliation=owner,collaborator", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
    });
    if (!res.ok) return;
    const repos: GhRepo[] = await res.json();
    setGhRepos(repos);
  };

  const handleConnectGitHub = async () => {
    setGhState("connecting");
    try {
      await openUrl(`${SITE_URL}/auth/github`);

      let settled = false;

      const settle = async (token: string) => {
        if (settled) return;
        settled = true;
        if (pollId) clearInterval(pollId);
        setGhToken(token);
        await invoke("store_github_token", { token });
        fetchGhUser(token);
      };

      // Path A — Tauri deep-link event (works in production after install)
      const unlisten = await listen<string>("github-token-received", async (event) => {
        unlisten();
        await settle(event.payload);
      });

      // Path B — poll the file on disk (works in dev / cargo run)
      // Rust writes the token via store_github_token when the deep link fires,
      // OR the user can paste it manually via the web page copy button.
      let pollId: ReturnType<typeof setInterval>;
      pollId = setInterval(async () => {
        try {
          const token = await invoke<string | null>("get_github_token");
          if (token) { unlisten(); await settle(token); }
        } catch (_) {}
      }, 2000);

      // Give up after 5 minutes
      setTimeout(() => {
        if (!settled) {
          settled = true;
          clearInterval(pollId);
          unlisten();
          setGhState("disconnected");
        }
      }, 300_000);

    } catch (_) { setGhState("disconnected"); }
  };

  const handleSyncRepos = async () => {
    if (!ghToken) return;
    setGhState("fetching");
    await fetchGhRepos(ghToken);
    setGhState("connected");
  };

  const handleDisconnect = async () => {
    try { await invoke("store_github_token", { token: null }); } catch (_) {}
    setGhToken(null); setGhUser(null); setGhRepos([]);
    setExpandedRepo(null); setRepoTrees({}); setSelectedDir(null);
    setGhState("disconnected");
  };

  const handleToggleRepo = async (repo: GhRepo) => {
    const key = repo.full_name;
    // Always select the repo root when clicking the repo row
    setSelectedDir(`${key}::__root__`);
    if (expandedRepo === key) { setExpandedRepo(null); return; }
    setExpandedRepo(key);
    if (repoTrees[key]) return;
    if (!ghToken) return;
    try {
      const res = await fetch(
        `https://api.github.com/repos/${key}/contents/`,
        { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } }
      );
      if (!res.ok) return;
      const items = await res.json();
      const nodes: TreeNode[] = (items as any[])
        .map((i: any) => ({ name: i.name, path: i.path, type: i.type === "dir" ? "dir" : "file" }))
        .sort((a: TreeNode, b: TreeNode) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === "dir" ? -1 : 1;
        });
      setRepoTrees(prev => ({ ...prev, [key]: nodes }));
    } catch (_) {}
  };

  const handleToggleDir = async (repoKey: string, node: TreeNode) => {
    const dirKey = `${repoKey}::${node.path}`;
    const newExpanded = new Set(expandedDirs);
    if (newExpanded.has(dirKey)) { newExpanded.delete(dirKey); setExpandedDirs(newExpanded); return; }
    newExpanded.add(dirKey);
    setExpandedDirs(newExpanded);

    // Fetch children if not loaded
    const parentTree = repoTrees[repoKey];
    if (!parentTree || !ghToken) return;
    const existing = findNode(parentTree, node.path);
    if (existing?.children) return; // already fetched

    try {
      const res = await fetch(
        `https://api.github.com/repos/${repoKey}/contents/${node.path}`,
        { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } }
      );
      if (!res.ok) return;
      const items = await res.json();
      const children: TreeNode[] = (items as any[])
        .map((i: any) => ({ name: i.name, path: i.path, type: i.type === "dir" ? "dir" : "file" }))
        .sort((a: TreeNode, b: TreeNode) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === "dir" ? -1 : 1;
        });
      setRepoTrees(prev => ({
        ...prev,
        [repoKey]: insertChildren(prev[repoKey], node.path, children)
      }));
    } catch (_) {}
  };

  const findNode = (nodes: TreeNode[], path: string): TreeNode | null => {
    for (const n of nodes) {
      if (n.path === path) return n;
      if (n.children) { const found = findNode(n.children, path); if (found) return found; }
    }
    return null;
  };

  const insertChildren = (nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] =>
    nodes.map(n => n.path === path
      ? { ...n, children }
      : n.children ? { ...n, children: insertChildren(n.children, path, children) } : n
    );

  const handleSelectDir = (repoKey: string, node: TreeNode) => {
    setSelectedDir(`${repoKey}::${node.path}`);
  };

  const handleCloneAndLoad = async () => {
    if (!selectedDir || !ghToken) return;
    const colonIdx = selectedDir.indexOf("::");
    const repoKey = selectedDir.slice(0, colonIdx);
    const dirPath = selectedDir.slice(colonIdx + 2);
    const repo = ghRepos.find(r => r.full_name === repoKey);
    if (!repo) return;
    setCloning(repoKey);
    try {
      const localPath = await invoke<string>("github_clone_repo", {
        cloneUrl: repo.clone_url,
        token: ghToken,
        subPath: dirPath === "__root__" ? "" : dirPath,
      });
      setCloning(null);
      await loadFolder(localPath);
    } catch (e) {
      setCloning(null);
      setError(`Clone failed: ${String(e)}`);
      setState("error");
    }
  };

  // ── Folder picker helpers ─────────────────────────────────────────────────

  const DEFAULT_IGNORED = new Set([
    "node_modules",".git","dist","build",".next","target","__pycache__",
    ".cache","coverage",".nyc_output","vendor",".venv","venv","env",".env",
    ".idea",".vscode","out",".turbo",".parcel-cache","storybook-static",
    ".svelte-kit","elm-stuff",".dart_tool"
  ]);

  interface PickerFolder {
    path: string; name: string; depth: number;
    included: boolean; expanded: boolean; children: PickerFolder[];
    autoExcluded: boolean; // greyed out — already skipped by options
  }

  const buildPickerTree = (basePath: string): PickerFolder[] => {
    // We'll scan the local filesystem via the folderInfo path
    // Since we only have JS, we pass folder scanning to Rust via a new invoke,
    // but for now build from the path list we get after loadFolder.
    // The actual scan is done when the user hits "Bundle" — we list subdirs.
    return [];
  };

  const openFolderPicker = async () => {
    if (!folderInfo) return;
    try {
      const dirs = await invoke<{ path: string; name: string; depth: number }[]>(
        "list_top_level_dirs", { folderPath: folderInfo.path }
      );
      const init = dirs.map(d => ({
        ...d,
        included: !savedExclusions.includes(d.path),
        expanded: false,
        children: [],
        autoExcluded:
          (options.skip_default_ignores && DEFAULT_IGNORED.has(d.name)),
      }));
      setFolderPickerFolders(init as any);
      setFolderPickerOpen(true);
    } catch (_) {}
  };

  const proceedBundle = async () => {
    setFolderPickerOpen(false);
    const collectExcluded = (nodes: any[]): string[] =>
      nodes.flatMap((f: any) => [
        ...(!f.included && !f.autoExcluded ? [f.path] : []),
        ...(f.children ? collectExcluded(f.children) : []),
      ]);
    const excl = collectExcluded(folderPickerFolders as any[]);
    if (rememberExclusions) {
      localStorage.setItem("codext_exclusions", JSON.stringify(excl));
      setSavedExclusions(excl);
    }
    await runBundle();
  };

  const runBundle = async () => {
    if (!folderInfo) return;
    setState("processing"); setProgress(0);
    let p = 0;
    const interval = setInterval(() => {
      p += Math.random() * 8; if (p > 90) { p = 90; clearInterval(interval); }
      setProgress(Math.floor(p));
    }, 120);
    const extraExclusions = (folderPickerFolders as any[])
      .filter((f: any) => !f.included && !f.autoExcluded)
      .map((f: any) => f.path);
    try {
      const res = await invoke<ProcessResult>("process_folder", {
        folderPath: folderInfo.path,
        options: { ...options, structure_only: structureOnly },
        extraExclusions,
      });
      clearInterval(interval); setProgress(100);
      setResult(res); setState("done"); setDownloadDismissed(false);
      await refreshLicense();
    } catch (e) {
      clearInterval(interval); setProgress(0);
      const msg = String(e);
      if (msg.startsWith("FREE_LIMIT:")) {
        const parts = msg.split(":");
        setLimitError({ type: parts[1] as LimitError["type"], value: parts[2] ? parseFloat(parts[2]) : undefined });
        setModal("limit"); setState("loaded");
      } else { setError(msg); setState("error"); }
    }
  };

  // ─── Derived ──────────────────────────────────────────────────────────────

  const isPro = license?.is_pro ?? false;
  const bundlesLeft = license ? Math.max(0, license.free_bundle_limit - license.bundle_count) : 0;
  const filename = result?.output_path.split(/[\\/]/).pop() ?? "";
  const selRepoKey = selectedDir ? selectedDir.slice(0, selectedDir.indexOf("::")) : null;
  const selPath = selectedDir ? selectedDir.slice(selectedDir.indexOf("::") + 2) : null;
  const selDisplayName = selPath === "__root__"
    ? selRepoKey?.split("/")[1] ?? ""
    : selPath ?? "";

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="app">

      {/* ── Success toast ── */}
      {pollStatus === "success" && (
        <div className="toast-success">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3"/>
            <path d="M4.5 7l2 2 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Pro activated automatically!
        </div>
      )}

      {/* ── Header ── */}
      <header className="header">
        <div className="header-left">
          <div className="logo"><span className="logo-bracket">[</span>CODEXT<span className="logo-bracket">]</span></div>
          <p className="tagline">Context Bundler — flatten any codebase into a single .txt</p>
        </div>
        <div className="header-right">
          {isPro ? (
            <button className="badge-pro" onClick={() => { setLicenseMsg(null); setModal("license"); }}>
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M5.5 1L6.8 4H10L7.3 6.1L8.3 9.3L5.5 7.4L2.7 9.3L3.7 6.1L1 4H4.2L5.5 1Z" fill="currentColor"/>
              </svg>
              PRO
            </button>
          ) : (
            <button className="badge-free" onClick={() => { setLicenseMsg(null); setModal("license"); }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              {bundlesLeft} left · Get Pro
            </button>
          )}
        </div>
      </header>

      {/* ── Body: sidebar + main ── */}
      <div className="body-layout">

        {/* ════ LEFT SIDEBAR ════ */}
        <aside className="sidebar">

          {/* Sidebar header */}
          <div className="sb-header">
            <span className="sb-title">Repositories</span>
            {ghState === "connected" && ghUser && (
              <div className="sb-user">
                <img src={ghUser.avatar_url} className="sb-avatar" alt={ghUser.login}/>
                <span className="sb-username">{ghUser.login}</span>
              </div>
            )}
          </div>

          {/* Connect / Sync button */}
          <div className="sb-action-wrap">
            {ghState === "disconnected" && (
              <button className="sb-connect-btn" onClick={handleConnectGitHub}>
                {/* GitHub mark */}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
                Connect GitHub
              </button>
            )}
            {ghState === "connecting" && (
              <div className="sb-connecting">
                <div className="sb-spinner"/>
                <span>Waiting for auth…</span>
              </div>
            )}
            {ghState === "connecting" && (
              <div className="sb-manual-token">
                <p className="sb-manual-label">Not redirecting? Paste token:</p>
                <div className="sb-manual-row">
                  <input
                    className="sb-token-input"
                    placeholder="ghp_xxxxxxxxxxxx"
                    id="gh-token-input"
                  />
                  <button
                    className="sb-token-submit"
                    onClick={async () => {
                      const input = document.getElementById("gh-token-input") as HTMLInputElement;
                      const token = input?.value?.trim();
                      if (!token) return;
                      await invoke("store_github_token", { token });
                      setGhToken(token);
                      fetchGhUser(token);
                    }}
                  >Go</button>
                </div>
              </div>
            )}
            {ghState === "fetching" && (
              <div className="sb-connecting">
                <div className="sb-spinner"/>
                <span>Loading repos…</span>
              </div>
            )}
            {ghState === "connected" && (
              <div className="sb-connected-actions">
                <button className="sb-sync-btn" onClick={handleSyncRepos}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M10.5 6A4.5 4.5 0 112.3 3.3M1.5 1v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Fetch latest
                </button>
                <button className="sb-disconnect-btn" onClick={handleDisconnect} title="Disconnect">
                  <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                    <path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            )}
          </div>

          {/* Repo list */}
          <div className="sb-repo-list">
            {ghState === "disconnected" && (
              <div className="sb-empty">
                <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor" style={{opacity:.18,marginBottom:8}}>
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
                <p>Connect GitHub to browse<br/>your repositories here</p>
              </div>
            )}

            {ghState === "connected" && ghRepos.map(repo => (
              <div key={repo.id} className="sb-repo">
                {/* Repo row */}
                <button
                  className={`sb-repo-row ${expandedRepo === repo.full_name ? "sb-repo-row--open" : ""}`}
                  onClick={() => handleToggleRepo(repo)}
                >
                  <span className="sb-arrow">
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
                      style={{ transform: expandedRepo === repo.full_name ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s" }}>
                      <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{flexShrink:0,color:"var(--text-3)"}}>
                    <path d="M2 4a1 1 0 011-1h2.5l1.5 1.5H11a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.2"/>
                  </svg>
                  <span className="sb-repo-name">{repo.name}</span>
                  {repo.private && <span className="sb-private-tag">private</span>}
                </button>

                {/* Tree */}
                {expandedRepo === repo.full_name && repoTrees[repo.full_name] && (
                  <div className="sb-tree">
                    {repoTrees[repo.full_name].map(node => (
                      <TreeNodeRow
                        key={node.path}
                        node={node}
                        repoKey={repo.full_name}
                        depth={0}
                        expandedDirs={expandedDirs}
                        selectedDir={selectedDir}
                        onToggleDir={handleToggleDir}
                        onSelectDir={handleSelectDir}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Bundle selected dir CTA */}
          {selectedDir && (
            <div className="sb-bundle-cta">
              <div className="sb-selected-info">
                <svg width="11" height="11" viewBox="0 0 14 14" fill="none" style={{color:"var(--accent)",flexShrink:0}}>
                  <path d="M2 4a1 1 0 011-1h2.5l1.5 1.5H11a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.4"/>
                </svg>
                <span className="sb-selected-name">{selDisplayName}</span>
              </div>
              <button
                className="sb-bundle-btn"
                onClick={handleCloneAndLoad}
                disabled={!!cloning}
              >
                {cloning ? (
                  <><div className="sb-spinner sb-spinner--sm"/>Cloning…</>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                      <path d="M7 1v9M7 10l-4-4M7 10l4-4M2 13h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    Clone &amp; Bundle
                  </>
                )}
              </button>
            </div>
          )}

        </aside>

        {/* ════ MAIN CONTENT ════ */}
        <main className="main">

          {(state === "idle" || state === "error") && (
            <div className={`drop-zone ${isDragOver ? "drag-over" : ""}`}
              onDragOver={handleDragOver} onDragLeave={handleDragLeave}>
              <div className="drop-icon">
                <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                  <rect x="1" y="1" width="50" height="50" rx="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3"/>
                  <path d="M26 34V18M26 18L20 24M26 18L32 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M16 38h20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.4"/>
                </svg>
              </div>
              <p className="drop-label">Drop your project folder here</p>
              <p className="drop-sub">or</p>
              <button className="btn-browse" onClick={handleBrowse}>Browse folder</button>
              {!isPro && license && (
                <p className="free-note">
                  Free: {bundlesLeft} of {license.free_bundle_limit} bundles · up to {license.free_file_limit} files
                </p>
              )}
              {state === "error" && error && <p className="error-msg">⚠ {error}</p>}
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
                <button className="btn-change" onClick={handleReset}>✕</button>
              </div>
              <div className="stats-row">
                <Stat label="Files" value={folderInfo.file_count} warn={!isPro && folderInfo.file_count > (license?.free_file_limit ?? 50)}/>
                <Stat label="Folders" value={folderInfo.folder_count}/>
                <Stat label="Size" value={`${folderInfo.size_kb.toFixed(0)} KB`}/>
              </div>
              {!isPro && folderInfo.file_count > (license?.free_file_limit ?? 50) && (
                <div className="limit-warning">
                  ⚠ {folderInfo.file_count} files — free tier caps at {license?.free_file_limit}.{" "}
                  <button className="inline-upgrade" onClick={() => setModal("license")}>Upgrade to Pro →</button>
                </div>
              )}
              <div className="options-panel">
                <p className="options-title">Options</p>
                <div className="options-grid">
                  <Toggle label="Respect .gitignore" description="Skip files listed in .gitignore"
                    checked={options.respect_gitignore} onChange={v => setOptions({...options, respect_gitignore: v})}/>
                  <Toggle label="Skip defaults" description="Exclude node_modules, .git, dist, build…"
                    checked={options.skip_default_ignores} onChange={v => setOptions({...options, skip_default_ignores: v})}/>
                  <Toggle label="Token count" description="Estimate context window usage"
                    checked={options.include_token_count} onChange={v => setOptions({...options, include_token_count: v})}
                    proOnly={!isPro} onProClick={() => setModal("license")}/>
                  <div className="option-row">
                    <div>
                      <p className="option-label">Max file size</p>
                      <p className="option-desc">Skip files larger than this threshold</p>
                    </div>
                    <div className="size-input-wrap">
                      <input className="size-input" type="number" min={10} max={10000} value={options.max_file_size_kb}
                        onChange={e => setOptions({...options, max_file_size_kb: Number(e.target.value)})}/>
                      <span className="size-unit">KB</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Feature checkboxes — below options, same row style as image ── */}
              <div className="feature-checks">
                <label className="feat-check-row">
                  <input
                    type="checkbox"
                    className="feat-checkbox"
                    checked={structureOnly}
                    onChange={e => setStructureOnly(e.target.checked)}
                  />
                  <div>
                    <span className="feat-check-label">Structure map only</span>
                    {/* <span className="feat-check-desc">Output folder tree without file contents — ideal for planning or sharing layout</span> */}
                  </div>
                </label>
                <label className="feat-check-row">
                  <input
                    type="checkbox"
                    className="feat-checkbox"
                    checked={pickFolders}
                    onChange={e => setPickFolders(e.target.checked)}
                  />
                  <div>
                    <span className="feat-check-label">Choose folders to exclude</span>
                    {/* <span className="feat-check-desc">Review and uncheck folders before bundling</span> */}
                  </div>
                </label>
              </div>

              <button className="btn-process" onClick={handleProcess}>
                {pickFolders ? "Pick folders" : "Bundle to .txt"}
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path d="M9 3l6 6-6 6M3 9h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          )}

          {state === "processing" && (
            <div className="processing-view">
              <div className="processing-label">Bundling your codebase…</div>
              <div className="progress-bar-wrap"><div className="progress-bar-fill" style={{width:`${progress}%`}}/></div>
              <p className="progress-pct">{progress}%</p>
            </div>
          )}

          {/* ── Folder picker — centred modal overlay ── */}
          {folderPickerOpen && (
            <div className="folder-picker-overlay" onClick={e => { if (e.target === e.currentTarget) setFolderPickerOpen(false); }}>
              <div className="folder-picker-card">
                <div className="fp-header">
                  <h2 className="fp-title">Choose folders to exclude</h2>
                  <p className="fp-sub">Uncheck folders you don't want bundled. Greyed entries are already excluded by your options.</p>
                </div>
                <div className="fp-list">
                  {(folderPickerFolders as any[]).map((f: any) => (
                    <FolderPickerRow
                      key={f.path}
                      folder={f}
                      depth={0}
                      onToggle={(path: string) => {
                        const toggleInTree = (nodes: any[]): any[] =>
                          nodes.map((x: any) => x.path === path
                            ? { ...x, included: !x.included }
                            : { ...x, children: x.children ? toggleInTree(x.children) : x.children }
                          );
                        setFolderPickerFolders(prev => toggleInTree(prev as any[]) as any);
                      }}
                      onExpand={async (path: string) => {
                        if (!folderInfo) return;
                        try {
                          const sub = await invoke<{ path: string; name: string; depth: number }[]>(
                            "list_top_level_dirs", { folderPath: `${folderInfo.path}\\${path}` }
                          );
                          const expandInTree = (nodes: any[]): any[] =>
                            nodes.map((x: any) => x.path === path
                              ? { ...x, expanded: !x.expanded, children: x.children?.length
                                  ? x.children  // already fetched, just toggle
                                  : sub.map((s: any) => ({
                                      ...s,
                                      included: !savedExclusions.includes(s.path),
                                      expanded: false, children: [],
                                      autoExcluded: options.skip_default_ignores && DEFAULT_IGNORED.has(s.name),
                                    }))
                                }
                              : { ...x, children: x.children ? expandInTree(x.children) : x.children }
                            );
                          setFolderPickerFolders(prev => expandInTree(prev as any[]) as any);
                        } catch (_) {}
                      }}
                    />
                  ))}
                  {(folderPickerFolders as any[]).length === 0 && (
                    <p className="fp-empty">No subfolders found in this project.</p>
                  )}
                </div>

                <label className="fp-remember">
                  <input
                    type="checkbox"
                    className="feat-checkbox"
                    checked={rememberExclusions}
                    onChange={e => setRememberExclusions(e.target.checked)}
                  />
                  <div className="fp-remember-text">
                    <span className="fp-remember-label">Remember these exclusions</span>
                    <span className="fp-remember-desc">Apply the same folder exclusions automatically on future bundles</span>
                  </div>
                </label>

                <div className="fp-actions">
                  <button className="btn-process" onClick={proceedBundle}>
                    Bundle selected folders
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                      <path d="M9 3l6 6-6 6M3 9h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                  <button className="fp-cancel" onClick={() => setFolderPickerOpen(false)}>Cancel</button>
                </div>
              </div>
            </div>
          )}

          {state === "done" && result && (
            <div className="done-view">
              <div className="done-icon">✓</div>
              <h2 className="done-title">Bundle complete</h2>
              <div className="result-grid">
                <ResultStat label="Files processed" value={result.file_count}/>
                <ResultStat label="Folders" value={result.folder_count}/>
                <ResultStat label="Binary skipped" value={result.skipped_binary}/>
                <ResultStat label="Output size" value={`${result.total_size_kb.toFixed(1)} KB`}/>
                {result.token_estimate > 0 && <ResultStat label="~Tokens" value={result.token_estimate.toLocaleString()} highlight/>}
              </div>
              {result.token_estimate > 0 && <p className="token-note">Context window estimate — varies by model</p>}
              <div className="done-actions">
                <button className="btn-process" onClick={handleReset}>Bundle another folder</button>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ── Download bar ── */}
      {state === "done" && result && !downloadDismissed && (
        <div className="download-bar">
          <div className="download-bar-left">
            <div className="download-file-icon">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="2" y="1" width="11" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M5 6h7M5 9h7M5 12h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity="0.6"/>
              </svg>
            </div>
            <div className="download-info">
              <button className="download-filename" onClick={handleOpen}>{filename}</button>
              <span className="download-size">{result.total_size_kb.toFixed(1)} KB · Click to open</span>
            </div>
          </div>
          <div className="download-bar-right">
            <button className="download-action-btn" onClick={handleCopy} title={copied ? "Copied!" : "Copy to clipboard"}
              style={copied ? {borderColor:"var(--accent)",color:"var(--accent)"} : {}}>
              {copied ? (
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <path d="M2.5 7.5l3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <rect x="5" y="1" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                  <path d="M10 4H2.5A1.5 1.5 0 001 5.5v8A1.5 1.5 0 002.5 15H10a1.5 1.5 0 001.5-1.5v-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
              )}
            </button>
            <div className="download-divider"/>
            <button className="download-action-btn" onClick={handleSaveAs} title="Save as…">
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <path d="M7.5 10V2M7.5 10L4.5 7M7.5 10L10.5 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 13h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
            <div className="download-divider"/>
            <button className="download-close-btn" onClick={() => setDownloadDismissed(true)}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* <footer className="footer">
        <span>CODEXT v0.1.0</span>
        <span className="footer-dot">·</span>
        <span>{isPro ? "Pro License Active" : `Free — ${bundlesLeft} bundles left`}</span>
      </footer> */}

      {/* ════ MODALS ════ */}

      {modal === "activating" && (
        <div className="modal-overlay" onClick={() => {}}>
          <div className="modal modal--activating" onClick={e => e.stopPropagation()}>
            {pollStatus !== "timeout" ? (
              <>
                <div className="activating-spinner">
                  <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
                    <circle cx="26" cy="26" r="22" stroke="#1e1e1e" strokeWidth="2"/>
                    <circle cx="26" cy="26" r="22" stroke="var(--accent)" strokeWidth="2"
                      strokeDasharray="138" strokeDashoffset="100" strokeLinecap="round"
                      style={{transformOrigin:"center",animation:"spin 1.2s linear infinite"}}/>
                  </svg>
                </div>
                <h2 className="modal-title" style={{textAlign:"center"}}>Waiting for payment…</h2>
                <p className="modal-sub" style={{textAlign:"center"}}>
                  Complete your purchase in the browser.<br/>
                  This will unlock automatically the moment payment is confirmed.
                </p>
                <div className="poll-dots">
                  {Array.from({length: 5}).map((_, i) => (
                    <div key={i} className={`poll-dot ${i < Math.min(pollAttempts, 5) ? "poll-dot--active" : ""}`}/>
                  ))}
                </div>
                <p style={{textAlign:"center", fontSize:"10px", color:"var(--text-3)", fontFamily:"var(--font-mono)"}}>
                  Checking every {POLL_INTERVAL_MS/1000}s · {POLL_MAX_ATTEMPTS - pollAttempts} checks remaining
                </p>
                <div className="modal-divider"/>
                <p className="activate-label" style={{textAlign:"center"}}>Already have a key?</p>
                <div className="activate-row">
                  <input className="license-input" placeholder="CODEXT-XXXX-XXXX-XXXX-XXXX"
                    value={licenseKey} onChange={e => setLicenseKey(e.target.value.toUpperCase())}
                    onKeyDown={e => e.key === "Enter" && handleActivate()}/>
                  <button className="btn-activate" onClick={handleActivate} disabled={activating || !licenseKey.trim()}>
                    {activating ? "…" : "Activate"}
                  </button>
                </div>
                {licenseMsg && <p className={`license-msg ${licenseMsg.type}`}>{licenseMsg.text}</p>}
                <button className="btn-cancel-poll" onClick={() => { stopPolling(); setModal(null); }}>
                  Cancel — I'll activate later
                </button>
              </>
            ) : (
              <>
                <h2 className="modal-title" style={{textAlign:"center"}}>Timed out</h2>
                <p className="modal-sub" style={{textAlign:"center"}}>
                  Didn't detect a payment. Check your email for your license key and paste it below.
                </p>
                <div className="activate-row" style={{marginTop:"8px"}}>
                  <input className="license-input" placeholder="CODEXT-XXXX-XXXX-XXXX-XXXX"
                    value={licenseKey} onChange={e => setLicenseKey(e.target.value.toUpperCase())}
                    onKeyDown={e => e.key === "Enter" && handleActivate()}/>
                  <button className="btn-activate" onClick={handleActivate} disabled={activating || !licenseKey.trim()}>
                    {activating ? "…" : "Activate"}
                  </button>
                </div>
                {licenseMsg && <p className={`license-msg ${licenseMsg.type}`}>{licenseMsg.text}</p>}
                <button className="btn-cancel-poll" onClick={() => setModal(null)}>Close</button>
              </>
            )}
          </div>
        </div>
      )}

      {modal === "license" && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setModal(null)}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1 1l11 11M12 1L1 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
            {isPro ? (
              <>
                <div className="modal-pro-badge">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1.5l1.8 4.3H14L10.3 8.6 11.7 13 7 10.4 2.3 13l1.4-4.4L0 5.8h5.2L7 1.5z" fill="currentColor"/></svg>
                  PRO LICENSE ACTIVE
                </div>
                <h2 className="modal-title">You're all set</h2>
                <p className="modal-sub">Unlimited bundles, unlimited files, full token counting.</p>
                {license?.key && (
                  <div className="license-key-display">
                    <span className="license-key-label">License key</span>
                    <span className="license-key-value">{license.key}</span>
                  </div>
                )}
                {license?.machine_id && (
                  <div className="license-key-display" style={{marginTop:"8px"}}>
                    <span className="license-key-label">Device ID</span>
                    <span className="license-key-value" style={{fontSize:"11px",color:"var(--text-2)"}}>{license.machine_id}</span>
                  </div>
                )}
                <button className="btn-deactivate" onClick={handleDeactivate}>Remove license from this device</button>
                {licenseMsg && <p className={`license-msg ${licenseMsg.type}`}>{licenseMsg.text}</p>}
              </>
            ) : (
              <>
                <div className="modal-pricing-header">
                  <h2 className="modal-title">Unlock CODEXT Pro</h2>
                  <p className="modal-sub">One-time · No subscription · Yours forever · Auto-activates instantly.</p>
                </div>
                <div className="pricing-cards">
                  <div className="pricing-card pricing-card--free">
                    <div className="pricing-tier">Free</div>
                    <div className="pricing-price">$0</div>
                    <ul className="pricing-features">
                      <li className="feat-ok">Up to {license?.free_file_limit} files</li>
                      <li className="feat-ok">Up to {license?.free_output_kb_limit} KB output</li>
                      <li className="feat-ok">{license?.free_bundle_limit} bundles total</li>
                      <li className="feat-no">Token counting</li>
                      <li className="feat-no">Unlimited bundles</li>
                    </ul>
                  </div>
                  <div className="pricing-card pricing-card--pro">
                    <div className="pricing-badge-pill">BEST VALUE</div>
                    <div className="pricing-tier">Pro</div>
                    <div className="pricing-price">$12 <span className="pricing-once">one-time</span></div>
                    <ul className="pricing-features">
                      <li className="feat-ok">Unlimited files</li>
                      <li className="feat-ok">Unlimited output</li>
                      <li className="feat-ok">Unlimited bundles</li>
                      <li className="feat-ok">Token counting</li>
                      <li className="feat-ok">Auto-activates instantly</li>
                    </ul>
                    <button className="btn-buy btn-buy--full" onClick={handleGetPro}>
                      Get Pro — $12
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7h10M7 2l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </button>
                  </div>
                </div>
                <div className="license-activate-section">
                  <p className="activate-label">Already have a key?</p>
                  <div className="activate-row">
                    <input className="license-input" placeholder="CODEXT-XXXX-XXXX-XXXX-XXXX"
                      value={licenseKey} onChange={e => setLicenseKey(e.target.value.toUpperCase())}
                      onKeyDown={e => e.key === "Enter" && handleActivate()}/>
                    <button className="btn-activate" onClick={handleActivate} disabled={activating || !licenseKey.trim()}>
                      {activating ? "…" : "Activate"}
                    </button>
                  </div>
                  {licenseMsg && <p className={`license-msg ${licenseMsg.type}`}>{licenseMsg.text}</p>}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {modal === "limit" && limitError && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal modal--limit" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setModal(null)}>
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1 1l11 11M12 1L1 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
            <div className="limit-icon">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                <path d="M20 4L36 34H4L20 4Z" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M20 16v8M20 28v2" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <h2 className="modal-title">Free limit reached</h2>
            <p className="modal-sub limit-detail">
              {limitError.type === "bundles" && `You've used all ${license?.free_bundle_limit} free bundles.`}
              {limitError.type === "files" && `${limitError.value} files detected — free tier caps at ${license?.free_file_limit}.`}
              {limitError.type === "size" && `Output would be ${limitError.value} KB — free tier caps at ${license?.free_output_kb_limit} KB.`}
            </p>
            <div className="limit-upgrade-box">
              <div className="limit-upgrade-price">
                <span className="limit-upgrade-amount">$12</span>
                <span className="limit-upgrade-term">one-time · no subscription</span>
              </div>
              <button className="btn-buy btn-buy--full" onClick={() => { setModal(null); handleGetPro(); }}>
                Get Pro — Unlock everything instantly
              </button>
            </div>
            <div className="limit-activate-inline">
              <p className="activate-label">Have a key already?</p>
              <div className="activate-row">
                <input className="license-input" placeholder="CODEXT-XXXX-XXXX-XXXX-XXXX"
                  value={licenseKey} onChange={e => setLicenseKey(e.target.value.toUpperCase())}
                  onKeyDown={e => e.key === "Enter" && handleActivate()}/>
                <button className="btn-activate" onClick={async () => {
                  await handleActivate();
                  const l = await refreshLicense();
                  if (l.is_pro) setModal(null);
                }} disabled={activating || !licenseKey.trim()}>
                  {activating ? "…" : "Activate"}
                </button>
              </div>
              {licenseMsg && <p className={`license-msg ${licenseMsg.type}`}>{licenseMsg.text}</p>}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={`stat-card ${warn ? "stat-card--warn" : ""}`}>
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

function Toggle({ label, description, checked, onChange, proOnly, onProClick }: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void;
  proOnly?: boolean; onProClick?: () => void;
}) {
  return (
    <div className={`option-row ${proOnly ? "option-row--locked" : ""}`}
      onClick={() => proOnly ? onProClick?.() : onChange(!checked)}>
      <div>
        <p className="option-label">{label}{proOnly && <span className="pro-tag">PRO</span>}</p>
        <p className="option-desc">{description}</p>
      </div>
      <div className={`toggle ${checked && !proOnly ? "toggle--on" : ""} ${proOnly ? "toggle--locked" : ""}`}>
        <div className="toggle-knob"/>
      </div>
    </div>
  );
}

function TreeNodeRow({ node, repoKey, depth, expandedDirs, selectedDir, onToggleDir, onSelectDir }: {
  node: TreeNode;
  repoKey: string;
  depth: number;
  expandedDirs: Set<string>;
  selectedDir: string | null;
  onToggleDir: (repoKey: string, node: TreeNode) => void;
  onSelectDir: (repoKey: string, node: TreeNode) => void;
}) {
  const dirKey = `${repoKey}::${node.path}`;
  const isExpanded = expandedDirs.has(dirKey);
  const isSelected = selectedDir === dirKey;

  if (node.type === "file") {
    return (
      <div className="tree-file" style={{ paddingLeft: 10 + depth * 14 }}>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={{flexShrink:0,color:"var(--text-3)"}}>
          <rect x="2" y="1" width="8" height="10" rx="1" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
        <span className="tree-file-name">{node.name}</span>
      </div>
    );
  }

  return (
    <div>
      <button
        className={`tree-dir ${isSelected ? "tree-dir--selected" : ""}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => { onToggleDir(repoKey, node); onSelectDir(repoKey, node); }}
      >
        <span className="sb-arrow">
          <svg width="7" height="7" viewBox="0 0 8 8" fill="none"
            style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .12s" }}>
            <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" style={{flexShrink:0,color: isSelected ? "var(--accent)" : "var(--text-3)"}}>
          <path d="M2 4a1 1 0 011-1h2.5l1.5 1.5H11a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
        <span className="tree-dir-name">{node.name}</span>
      </button>
      {isExpanded && node.children && (
        <div>
          {node.children.map(child => (
            <TreeNodeRow key={child.path} node={child} repoKey={repoKey} depth={depth + 1}
              expandedDirs={expandedDirs} selectedDir={selectedDir}
              onToggleDir={onToggleDir} onSelectDir={onSelectDir}/>
          ))}
        </div>
      )}
    </div>
  );
}
function FolderPickerRow({ folder, depth, onToggle, onExpand }: {
  folder: any; depth: number;
  onToggle: (path: string) => void;
  onExpand: (path: string) => void;
}) {
  const indent = depth * 18;

  if (folder.autoExcluded) {
    return (
      <div className="fp-row fp-row--auto" style={{ paddingLeft: 16 + indent }}>
        <input type="checkbox" className="feat-checkbox" checked={false} disabled readOnly/>
        <span className="fp-expand-btn" style={{visibility:"hidden"}}/>
        <svg className="fp-folder-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5H12.5A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
        <span className="fp-name">{folder.name}</span>
        <span className="fp-auto-tag">auto-excluded</span>
      </div>
    );
  }

  return (
    <div>
      <div
        className={`fp-row ${!folder.included ? "fp-row--unchecked" : ""}`}
        style={{ paddingLeft: 16 + indent }}
        onClick={() => onToggle(folder.path)}
      >
        <input
          type="checkbox"
          className="feat-checkbox"
          checked={folder.included}
          onChange={() => onToggle(folder.path)}
          onClick={e => e.stopPropagation()}
        />
        <button
          className="fp-expand-btn"
          onClick={e => { e.stopPropagation(); onExpand(folder.path); }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none"
            style={{ transform: folder.expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s" }}>
            <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <svg className="fp-folder-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5H12.5A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
        <span className="fp-name">{folder.name}</span>
      </div>
      {folder.expanded && folder.children?.map((child: any) => (
        <FolderPickerRow key={child.path} folder={child} depth={depth + 1}
          onToggle={onToggle} onExpand={onExpand}/>
      ))}
    </div>
  );
}