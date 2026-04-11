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
  path: string;
  type: "dir" | "file";
  children?: TreeNode[];
  expanded?: boolean;
}

type GhState = "disconnected" | "connecting" | "connected" | "fetching";

// ─── Recent folders ───────────────────────────────────────────────────────────

interface RecentFolder {
  path: string;
  name: string;
  lastUsed: number; // unix ms
}

const RECENT_MAX = 5;
const RECENT_KEY = "codext_recent_folders";

function loadRecents(): RecentFolder[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
}

function saveRecents(list: RecentFolder[]) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

function pushRecent(path: string, name: string) {
  const existing = loadRecents().filter(r => r.path !== path);
  const updated = [{ path, name, lastUsed: Date.now() }, ...existing].slice(0, RECENT_MAX);
  saveRecents(updated);
  return updated;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SITE_URL = "https://codext-web.vercel.app";
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 20;
// Free tier threshold — badge only appears when this many bundles or fewer remain
const BADGE_WARN_THRESHOLD = 3;

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
  const [ghError, setGhError] = useState<string | null>(null);
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
  const [optionsOpen, setOptionsOpen] = useState(false);

  // ── Folder picker state ──
  const [folderPickerFolders, setFolderPickerFolders] = useState<
    { path: string; name: string; depth: number; excluded: boolean; children?: any[]; expanded: boolean }[]
  >([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [rememberExclusions, setRememberExclusions] = useState(false);
  const [savedExclusions, setSavedExclusions] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("codext_exclusions") ?? "[]"); } catch { return []; }
  });

  // ── Recent folders state ──
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>(loadRecents);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  // ── Update state ──
  const [updateAvailable, setUpdateAvailable] = useState<{ current: string; next: string; notes: string[] } | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const updateRef = useRef<HTMLDivElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);

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
        try {
          const saved = await invoke<string | null>("get_github_token");
          if (saved) { setGhToken(saved); fetchGhUser(saved); }
        } catch (_) {}
      } catch (e) { console.error("Init error:", e); }
    };
    init();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Close history dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
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
      setFolderInfo(info);
      setState("loaded");
      // Save to recents
      const updated = pushRecent(path, info.name);
      setRecentFolders(updated);
    } catch (e) { setError(String(e)); setState("error"); }
  }, []);

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select your project folder" });
      if (selected && typeof selected === "string") await loadFolder(selected);
    } catch (e) { setError(String(e)); setState("error"); }
  };

  const handleOpenRecent = async (recent: RecentFolder) => {
    setHistoryOpen(false);
    await loadFolder(recent.path);
  };

  const handleRemoveRecent = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    const updated = recentFolders.filter(r => r.path !== path);
    setRecentFolders(updated);
    saveRecents(updated);
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

  const handlePasteToken = async (token: string) => {
    if (!token) return;
    setGhError(null);
    await invoke("store_github_token", { token });
    setGhToken(token);
    await fetchGhUser(token);
    if (tokenInputRef.current) tokenInputRef.current.value = "";
  };

  const fetchGhUser = async (token: string) => {
    setGhError(null);
    try {
      setGhState("fetching");
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setGhError(`Auth failed (${res.status}): ${body.message ?? "bad token"}`);
        setGhState("disconnected"); setGhToken(null); return;
      }
      const user = await res.json();
      setGhUser({ login: user.login, avatar_url: user.avatar_url });
      const reposRes = await fetch("https://api.github.com/user/repos?sort=updated&per_page=50", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
      });
      if (!reposRes.ok) {
        const body = await reposRes.json().catch(() => ({}));
        setGhError(`Repos failed (${reposRes.status}): ${body.message ?? "unknown"}`);
        setGhState("disconnected"); setGhToken(null); return;
      }
      const repos = await reposRes.json();
      setGhRepos(Array.isArray(repos) ? repos : []);
      setGhState("connected");
    } catch (e) {
      setGhError(`Network error: ${String(e)}`);
      setGhState("disconnected");
    }
  };

  const handleConnectGitHub = async () => {
    setGhState("connecting");
    try { await openUrl(`${SITE_URL}/auth/github`); } catch { setGhState("disconnected"); }
  };

  const handleSyncRepos = async () => {
    if (!ghToken) return;
    setGhState("fetching");
    await fetchGhUser(ghToken);
  };

  const handleDisconnect = async () => {
    try { await invoke("store_github_token", { token: null }); } catch {}
    setGhState("disconnected"); setGhToken(null); setGhUser(null); setGhRepos([]);
    setExpandedRepo(null); setRepoTrees({}); setSelectedDir(null);
  };

  const handleToggleRepo = async (repo: GhRepo) => {
    if (expandedRepo === repo.full_name) { setExpandedRepo(null); return; }
    setExpandedRepo(repo.full_name);
    if (repoTrees[repo.full_name]) return;
    try {
      const tree = await fetch(`https://api.github.com/repos/${repo.full_name}/git/trees/HEAD?recursive=1`, {
        headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" }
      }).then(r => r.json());
      const nodes = buildTree(tree.tree ?? []);
      setRepoTrees(prev => ({ ...prev, [repo.full_name]: nodes }));
    } catch {}
  };

  const handleToggleDir = (repoKey: string, node: TreeNode) => {
    const key = `${repoKey}::${node.path}`;
    setExpandedDirs(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  };

  const handleSelectDir = (repoKey: string, node: TreeNode) => {
    const key = `${repoKey}::${node.path}`;
    setSelectedDir(prev => prev === key ? null : key);
  };

  const handleSelectRepoRoot = (repo: GhRepo) => {
    const key = `${repo.full_name}::__root__`;
    setSelectedDir(prev => prev === key ? null : key);
  };

  const handleCloneAndLoad = async () => {
    if (!selectedDir || !ghToken) return;
    const repoKey = selectedDir.slice(0, selectedDir.indexOf("::"));
    const dirPath = selectedDir.slice(selectedDir.indexOf("::") + 2);
    const repo = ghRepos.find(r => r.full_name === repoKey);
    if (!repo) return;
    setCloning(selectedDir);
    try {
      const clonedPath = await invoke<string>("github_clone_repo", {
        cloneUrl: repo.clone_url,
        token: ghToken ?? "",
        subPath: dirPath === "__root__" ? "" : dirPath,
      });
      await loadFolder(clonedPath);
    } catch (e) { setError(String(e)); setState("error"); }
    finally { setCloning(null); }
  };

  // ─── Folder picker helpers ────────────────────────────────────────────────

  const DEFAULT_IGNORED = new Set([
    "node_modules",".git","dist","build",".next","out","coverage",
    ".turbo",".cache","__pycache__",".pytest_cache","target","vendor",
  ]);

  const openFolderPicker = async () => {
    if (!folderInfo) return;
    try {
      const dirs = await invoke<{ path: string; name: string; depth: number }[]>(
        "list_top_level_dirs", { folderPath: folderInfo.path }
      );
      setFolderPickerFolders(dirs.map(d => ({
        ...d,
        included: !savedExclusions.includes(d.path),
        expanded: false,
        children: [],
        autoExcluded: options.skip_default_ignores && DEFAULT_IGNORED.has(d.name),
      })));
      setFolderPickerOpen(true);
    } catch (e) { console.error(e); }
  };

  const proceedBundle = async () => {
    setFolderPickerOpen(false);
    const excluded = (folderPickerFolders as any[])
      .filter((f: any) => !f.included && !f.autoExcluded)
      .map((f: any) => f.path);
    if (rememberExclusions) {
      setSavedExclusions(excluded);
      localStorage.setItem("codext_exclusions", JSON.stringify(excluded));
    }
    await runBundle(excluded);
  };

  // ─── Bundle runner ────────────────────────────────────────────────────────

  const runBundle = async (excludedFolders: string[] = []) => {
    if (!folderInfo) return;
    setState("processing"); setProgress(0);
    const interval = setInterval(() => setProgress(p => Math.min(p + Math.random() * 8, 90)), 300);
    try {
      const res = await invoke<ProcessResult>("process_folder", {
        folderPath: folderInfo.path,
        options: { ...options, structure_only: structureOnly },
        extraExclusions: excludedFolders,
      });
      clearInterval(interval); setProgress(100);
      setTimeout(() => {
        setResult(res); setState("done"); setDownloadDismissed(false);
      }, 200);
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
  // Badge is only shown when ≤ BADGE_WARN_THRESHOLD bundles remain (or on process attempt)
  const showFreeBadge = !isPro && license !== null && bundlesLeft <= BADGE_WARN_THRESHOLD;
  const filename = result?.output_path.split(/[\\/]/).pop() ?? "";
  const selRepoKey = selectedDir ? selectedDir.slice(0, selectedDir.indexOf("::")) : null;
  const selPath = selectedDir ? selectedDir.slice(selectedDir.indexOf("::") + 2) : null;
  const selDisplayName = selPath === "__root__"
    ? selRepoKey?.split("/")[1] ?? ""
    : selPath ?? "";

  // Relative time label for recents
  const relativeTime = (ms: number) => {
    const diff = Date.now() - ms;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  };

  // Smart size formatter — input is always KB from backend
  const formatSize = (kb: number) => {
    if (kb < 1024) return `${kb.toFixed(0)} KB`;
    if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
    return `${(kb / (1024 * 1024)).toFixed(2)} GB`;
  };

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

        {/* ── Left: logo ── */}
        <div className="header-logo">
          <svg className="logo-mark" width="26" height="20" viewBox="0 0 377 294" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M13.5 288.3V11.7H65.7V32.4H37.2V267.3H65.7V288.3H13.5Z" fill="#DCFF00"/>
            <path d="M365.7 288.3H313.5V267.3H342V32.4H313.5V11.7H365.7V288.3Z" fill="#DCFF00"/>
            <rect x="86.6344" y="120.332" width="25" height="150" rx="4" transform="rotate(-60 86.6344 120.332)" fill="#DCFF00"/>
            <rect x="99.5" y="195.651" width="25" height="150" rx="4" transform="rotate(-120 99.5 195.651)" fill="#DCFF00"/>
            <rect x="146" y="72" width="25" height="150" rx="4" fill="#DCFF00"/>
          </svg>
          <span className="logo">CODEXT</span>
        </div>

        {/* ── Spacer ── */}
        <div className="header-spacer" />

        {/* ── Right: icon actions + license badge ── */}
        <div className="header-right">

          {/* Recent folders */}
          <div className="history-wrap" ref={historyRef}>
            <button
              className={`h-icon-btn ${historyOpen ? "h-icon-btn--active" : ""}`}
              onClick={() => setHistoryOpen(o => !o)}
              title="Recent folders"
            >
              <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M7 4v3.2l2 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            {historyOpen && (
              <div className="history-dropdown history-dropdown--right">
                <div className="history-dropdown-header">
                  <span>Recent folders</span>
                  {recentFolders.length > 0 && (
                    <button className="history-clear-all" onClick={() => {
                      setRecentFolders([]); saveRecents([]); setHistoryOpen(false);
                    }}>Clear all</button>
                  )}
                </div>
                {recentFolders.length === 0 ? (
                  <div className="history-empty">
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" style={{opacity:.2,marginBottom:4}}>
                      <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.3"/>
                      <path d="M10 6v4.5l2.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    No recent folders yet
                  </div>
                ) : (
                  <div className="history-list">
                    {recentFolders.map(r => (
                      <button key={r.path} className="history-item" onClick={() => handleOpenRecent(r)}>
                        <div className="history-item-icon">
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5H12.5A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z" stroke="currentColor" strokeWidth="1.2"/>
                          </svg>
                        </div>
                        <div className="history-item-info">
                          <span className="history-item-name">{r.name}</span>
                          <span className="history-item-path">{r.path}</span>
                        </div>
                        <span className="history-item-time">{relativeTime(r.lastUsed)}</span>
                        <span
                          className="history-item-remove"
                          role="button"
                          onClick={(e) => handleRemoveRecent(e, r.path)}
                          title="Remove"
                        >
                          <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                            <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                          </svg>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Browse folder */}
          <button className="h-icon-btn" onClick={handleBrowse} title="Browse folder">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5H12.5A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M8 8v4M8 8L6 10M8 8l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          <div className="h-divider" />

          {/* Update button — only when available */}
          {updateAvailable && (
            <div className="h-update-wrap" ref={updateRef}>
              <button
                className={`h-icon-btn h-icon-btn--update ${updateOpen ? "h-icon-btn--active" : ""}`}
                onClick={() => setUpdateOpen(o => !o)}
                title={`v${updateAvailable.next} available`}
              >
                <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
                  <path d="M12 7A5 5 0 112.5 4.5M2 2v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span className="h-update-dot" />
              </button>

              {updateOpen && (
                <div className="update-dropdown">
                  <div className="upd-header">
                    <span className="upd-title">Update available</span>
                    <span className="upd-new-badge">NEW</span>
                  </div>
                  <div className="upd-body">
                    <div className="upd-version-row">
                      <span className="upd-v-current">{updateAvailable.current}</span>
                      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" style={{color:"var(--text-3)"}}>
                        <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <span className="upd-v-next">{updateAvailable.next}</span>
                    </div>
                    {updateAvailable.notes.length > 0 && (
                      <ul className="upd-notes">
                        {updateAvailable.notes.map((note, i) => (
                          <li key={i} className="upd-note-item">
                            <span className="upd-note-dot">·</span>
                            <span>{note}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button className="upd-download-btn" onClick={() => openUrl(`${SITE_URL}/downloads/latest`)}>
                      <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                        <path d="M7 1v9M7 10l-4-4M7 10l4-4M2 13h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      Download {updateAvailable.next}
                    </button>
                    <button className="upd-skip-btn" onClick={() => setUpdateOpen(false)}>
                      Skip this version
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* License badge — Pro always, free only when ≤3 left */}
          {isPro ? (
            <button className="badge-pro" onClick={() => { setLicenseMsg(null); setModal("license"); }}>
              <svg width="10" height="10" viewBox="0 0 11 11" fill="none">
                <path d="M5.5 1L6.8 4H10L7.3 6.1L8.3 9.3L5.5 7.4L2.7 9.3L3.7 6.1L1 4H4.2L5.5 1Z" fill="currentColor"/>
              </svg>
              PRO
            </button>
          ) : showFreeBadge ? (
            <button className="badge-free badge-free--warn" onClick={() => { setLicenseMsg(null); setModal("license"); }}>
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              {bundlesLeft === 0 ? "No bundles left" : `${bundlesLeft} left`} · Get Pro
            </button>
          ) : null}

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
              <>
                <button className="sb-connect-btn" onClick={handleConnectGitHub}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                  </svg>
                  Connect GitHub
                </button>
                <div className="sb-manual-token">
                  <p className="sb-manual-label">Or paste a token directly:</p>
                  <div className="sb-manual-row">
                    <input
                      ref={tokenInputRef}
                      className="sb-token-input"
                      placeholder="ghp_xxxxxxxxxxxx"
                      onKeyDown={e => { if (e.key === "Enter") handlePasteToken((e.target as HTMLInputElement).value.trim()); }}
                    />
                    <button
                      className="sb-token-submit"
                      onClick={() => handlePasteToken(tokenInputRef.current?.value.trim() ?? "")}
                    >Go</button>
                  </div>
                </div>
              </>
            )}
            {ghState === "connecting" && (
              <>
                <div className="sb-connecting">
                  <div className="sb-spinner"/>
                  <span>Waiting for auth…</span>
                </div>
                <div className="sb-manual-token">
                  <p className="sb-manual-label">Or paste a token directly:</p>
                  <div className="sb-manual-row">
                    <input
                      ref={tokenInputRef}
                      className="sb-token-input"
                      placeholder="ghp_xxxxxxxxxxxx"
                      onKeyDown={e => { if (e.key === "Enter") handlePasteToken((e.target as HTMLInputElement).value.trim()); }}
                    />
                    <button
                      className="sb-token-submit"
                      onClick={() => handlePasteToken(tokenInputRef.current?.value.trim() ?? "")}
                    >Go</button>
                  </div>
                </div>
              </>
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
                {ghError
                  ? <p className="sb-gh-error">{ghError}</p>
                  : <p>Connect GitHub to browse<br/>your repositories here</p>
                }
              </div>
            )}

            {ghState === "connected" && ghRepos.map(repo => (
              <div key={repo.id} className="sb-repo">
                <button
                  className={`sb-repo-row${expandedRepo === repo.full_name ? " sb-repo-row--open" : ""}`}
                  onClick={() => handleToggleRepo(repo)}
                >
                  <span className="tree-arrow" style={{ transform: expandedRepo === repo.full_name ? "rotate(90deg)" : "rotate(0deg)" }}>
                    <svg width="6" height="6" viewBox="0 0 6 6" fill="none">
                      <path d="M1 1l4 2-4 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                  <span className="sb-repo-name">{repo.name}</span>
                  {repo.private && <span className="sb-private-tag">private</span>}
                </button>

                {expandedRepo === repo.full_name && repoTrees[repo.full_name] && (
                  <div className="sb-tree">
                    {/* Root — selectable, no indent line above it */}
                    <button
                      className={`tree-dir tree-dir--root${selectedDir === `${repo.full_name}::__root__` ? " tree-dir--selected" : ""}`}
                      style={{ paddingLeft: 8 }}
                      onClick={() => handleSelectRepoRoot(repo)}
                    >
                      <span className="tree-arrow" style={{ visibility: "hidden" }}>
                        <svg width="6" height="6" viewBox="0 0 6 6" fill="none">
                          <path d="M1 1l4 2-4 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </span>
                      <span className="tree-dir-name" style={{ color: selectedDir === `${repo.full_name}::__root__` ? "var(--accent)" : undefined }}>
                        / (root)
                      </span>
                    </button>
                    {/* All top-level nodes share one indent line */}
                    <div className="tree-children-wrap" style={{ marginLeft: 14 }}>
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
                  </div>
                )}
              </div>
            ))}
          </div>

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
                <Stat label="Size" value={formatSize(folderInfo.size_kb)}/>
              </div>
              {!isPro && folderInfo.file_count > (license?.free_file_limit ?? 50) && (
                <div className="limit-warning">
                  ⚠ {folderInfo.file_count} files — free tier caps at {license?.free_file_limit}.{" "}
                  <button className="inline-upgrade" onClick={() => setModal("license")}>Upgrade to Pro →</button>
                </div>
              )}
              <div className="options-panel">
                <button className="options-toggle" onClick={() => setOptionsOpen(o => !o)}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                    style={{transform: optionsOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s", flexShrink: 0}}>
                    <path d="M3 1l5 5-5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Options
                </button>
                {optionsOpen && (
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
                )}
              </div>

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
                                  ? x.children
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
                <ResultStat label="Output size" value={formatSize(result.total_size_kb)}/>
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
              <span className="download-size">{formatSize(result.total_size_kb)} · Click to open</span>
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
  // Each depth level = 12px. Indent lines sit at depth*12 + 6 (centred on the arrow).
  const BASE = 8;
  const STEP = 12;
  const rowIndent = BASE + depth * STEP;

  if (node.type === "file") {
    return (
      <div className="tree-file" style={{ paddingLeft: rowIndent + 16 }}>
        <span className="tree-bullet" />
        <span className="tree-file-name">{node.name}</span>
      </div>
    );
  }

  return (
    <div className="tree-dir-wrap">
      <button
        className={`tree-dir${isSelected ? " tree-dir--selected" : ""}`}
        style={{ paddingLeft: rowIndent }}
        onClick={() => { onToggleDir(repoKey, node); onSelectDir(repoKey, node); }}
      >
        <span className="tree-arrow" style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}>
          <svg width="6" height="6" viewBox="0 0 6 6" fill="none">
            <path d="M1 1l4 2-4 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
        <span className="tree-dir-name">{node.name}</span>
      </button>
      {isExpanded && node.children && (
        <div className="tree-children-wrap" style={{ marginLeft: rowIndent + 6 }}>
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

// ─── GitHub tree builder ──────────────────────────────────────────────────────

function buildTree(flatItems: { path: string; type: string }[]): TreeNode[] {
  const root: TreeNode[] = [];
  const map: Record<string, TreeNode> = {};

  for (const item of flatItems) {
    const parts = item.path.split("/");
    const name = parts[parts.length - 1];
    const node: TreeNode = {
      name,
      path: item.path,
      type: item.type === "tree" ? "dir" : "file",
      children: item.type === "tree" ? [] : undefined,
    };
    map[item.path] = node;

    if (parts.length === 1) {
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      if (map[parentPath]?.children) {
        map[parentPath].children!.push(node);
      }
    }
  }
  return root;
}