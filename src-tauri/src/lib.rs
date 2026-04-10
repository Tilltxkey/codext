use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// ─── License & Machine ID ─────────────────────────────────────────────────────

const FREE_FILE_LIMIT: usize = 50;
const FREE_OUTPUT_KB_LIMIT: f64 = 200.0;
const FREE_BUNDLE_LIMIT: u32 = 3;
const LICENSE_FILE: &str = "license.key";
const MACHINE_ID_FILE: &str = "machine.id";
const SUPABASE_URL: &str = "https://sodsohcocrthfrkhknhi.supabase.co";
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNvZHNvaGNvY3J0aGZya2hrbmhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNzc4NTYsImV4cCI6MjA5MDc1Mzg1Nn0.XgYEbwlL-jHZGX12vZcC82a0r5nKva4H1H8_FNCQrlc";

/// Generate a stable machine fingerprint from hardware identifiers.
/// On Windows: uses MachineGuid from registry + volume serial.
/// Falls back to a random UUID stored on disk if hardware query fails.
fn generate_machine_id() -> String {
    #[cfg(target_os = "windows")]
    {
        // Try reading MachineGuid from Windows registry
        use std::process::Command;
        let output = Command::new("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid"
            ])
            .output();
        if let Ok(out) = output {
            let guid = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if guid.len() > 10 {
                // Hash it so we never expose raw registry data
                return sha256_short(&guid);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let output = Command::new("system_profiler")
            .args(["SPHardwareDataType"])
            .output();
        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if line.contains("Hardware UUID") {
                    if let Some(uuid) = line.split(':').nth(1) {
                        return sha256_short(uuid.trim());
                    }
                }
            }
        }
    }
    // Fallback: persistent random ID
    let path = get_codext_dir().join(MACHINE_ID_FILE);
    if let Ok(id) = fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if id.len() > 8 { return id; }
    }
    let id = generate_random_id();
    let _ = fs::write(&path, &id);
    id
}

fn sha256_short(input: &str) -> String {
    // Simple djb2-like hash for non-cryptographic fingerprint
    // In production add sha2 crate for real SHA256
    let mut h: u64 = 5381;
    for b in input.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u64);
    }
    format!("mid_{:016x}", h)
}

fn generate_random_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let pid = std::process::id();
    format!("mid_{:016x}{:08x}", t as u64, pid)
}

fn get_codext_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("CODEXT");
    fs::create_dir_all(&dir).ok();
    dir
}

fn get_license_path() -> PathBuf { get_codext_dir().join(LICENSE_FILE) }

fn get_bundle_count_path() -> PathBuf { get_codext_dir().join("bundle_count") }

const GITHUB_TOKEN_FILE: &str = "github.token";
fn get_github_token_path() -> PathBuf { get_codext_dir().join(GITHUB_TOKEN_FILE) }

fn get_clones_dir() -> PathBuf {
    let d = get_codext_dir().join("clones");
    fs::create_dir_all(&d).ok();
    d
}

fn load_license() -> Option<String> {
    fs::read_to_string(get_license_path()).ok().map(|s| s.trim().to_string())
}

fn save_license(key: &str) {
    let _ = fs::write(get_license_path(), key.trim());
}

fn is_valid_key_format(key: &str) -> bool {
    let key = key.trim();
    if !key.starts_with("CODEXT-") { return false; }
    let parts: Vec<&str> = key.split('-').collect();
    parts.len() == 5 && parts[1..].iter().all(|p| p.len() == 4 && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

fn is_pro() -> bool {
    load_license().map(|k| is_valid_key_format(&k)).unwrap_or(false)
}

fn get_bundle_count() -> u32 {
    fs::read_to_string(get_bundle_count_path())
        .ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

fn increment_bundle_count() {
    let _ = fs::write(get_bundle_count_path(), (get_bundle_count() + 1).to_string());
}

// ─── Supabase HTTP helpers ─────────────────────────────────────────────────────

// Minimal structs matching exactly the fields we SELECT from Supabase
#[derive(Serialize, Deserialize, Debug)]
struct LicenseKeyRow {
    license_key: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct LicenseKeyVisitorRow {
    license_key: String,
    visitor_id: Option<String>,
}

/// Check Supabase for a license bound to this machine_id.
/// Returns the license key if found and active.
fn supabase_check_machine(machine_id: &str) -> Option<String> {
    let url = format!(
        "{}/rest/v1/licenses?visitor_id=eq.{}&is_active=eq.true&select=license_key",
        SUPABASE_URL, urlenccode(machine_id)
    );
    if let Ok(resp) = ureq::get(&url)
        .set("apikey", SUPABASE_ANON_KEY)
        .set("Authorization", &format!("Bearer {}", SUPABASE_ANON_KEY))
        .call()
    {
        if let Ok(rows) = resp.into_json::<Vec<LicenseKeyRow>>() {
            return rows.into_iter().next().map(|r| r.license_key);
        }
    }
    None
}

/// Verify a license key exists and is active in Supabase, and bind it
/// to this machine_id (transfer support — last machine wins).
fn supabase_verify_and_bind(key: &str, machine_id: &str) -> Result<bool, String> {
    // First check the key exists and is active
    let url = format!(
        "{}/rest/v1/licenses?license_key=eq.{}&is_active=eq.true&select=license_key,visitor_id",
        SUPABASE_URL, urlenccode(key)
    );
    let rows = ureq::get(&url)
        .set("apikey", SUPABASE_ANON_KEY)
        .set("Authorization", &format!("Bearer {}", SUPABASE_ANON_KEY))
        .call()
        .map_err(|e| format!("Network error: {}", e))?
        .into_json::<Vec<LicenseKeyVisitorRow>>()
        .map_err(|e| format!("Parse error: {}", e))?;

    if rows.is_empty() {
        return Err("License key not found or inactive.".to_string());
    }

    // Bind this machine_id (handles machine transfer)
    let patch_url = format!(
        "{}/rest/v1/licenses?license_key=eq.{}",
        SUPABASE_URL, urlenccode(key)
    );
    let _ = ureq::patch(&patch_url)
        .set("apikey", SUPABASE_ANON_KEY)
        .set("Authorization", &format!("Bearer {}", SUPABASE_ANON_KEY))
        .set("Content-Type", "application/json")
        .set("Prefer", "return=minimal")
        .send_string(&format!(r#"{{"visitor_id":"{}"}}"#, machine_id));

    Ok(true)
}

fn urlenccode(s: &str) -> String {
    s.chars().map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        _ => format!("%{:02X}", c as u32),
    }).collect()
}

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProcessOptions {
    pub respect_gitignore: bool,
    pub skip_default_ignores: bool,
    pub include_token_count: bool,
    pub max_file_size_kb: u64,
    #[serde(default)]
    pub structure_only: bool,
}

impl Default for ProcessOptions {
    fn default() -> Self {
        Self { respect_gitignore: true, skip_default_ignores: true, include_token_count: true, max_file_size_kb: 500, structure_only: false }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ProcessResult {
    pub output_path: String, pub file_count: usize, pub folder_count: usize,
    pub skipped_binary: usize, pub skipped_ignored: usize,
    pub token_estimate: usize, pub total_size_kb: f64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct FolderInfo {
    pub name: String, pub path: String, pub file_count: usize,
    pub folder_count: usize, pub size_kb: f64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LicenseStatus {
    pub is_pro: bool,
    pub key: Option<String>,
    pub machine_id: String,
    pub bundle_count: u32,
    pub free_file_limit: usize,
    pub free_output_kb_limit: f64,
    pub free_bundle_limit: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LicenseCheckResult {
    pub is_pro: bool,
    pub key: Option<String>,
    pub method: String, // "machine_id" | "cached" | "none"
}

// ─── Core algorithm helpers ───────────────────────────────────────────────────

fn default_ignored_dirs() -> HashSet<&'static str> {
    let mut s = HashSet::new();
    for d in ["node_modules",".git","dist","build",".next","target",
              "__pycache__",".cache","coverage",".nyc_output","vendor",
              ".venv","venv","env",".env",".idea",".vscode","out",
              ".turbo",".parcel-cache","storybook-static",".svelte-kit",
              "elm-stuff",".dart_tool"] { s.insert(d); }
    s
}

fn is_text_extension(ext: &str) -> bool {
    matches!(ext.to_lowercase().as_str(),
        "txt"|"md"|"mdx"|"markdown"|"rs"|"toml"|"lock"|"ts"|"tsx"|"js"|"jsx"|
        "mjs"|"cjs"|"json"|"jsonc"|"json5"|"py"|"pyi"|"pyw"|"html"|"htm"|
        "xhtml"|"css"|"scss"|"sass"|"less"|"styl"|"sh"|"bash"|"zsh"|"fish"|
        "yaml"|"yml"|"xml"|"svg"|"sql"|"graphql"|"gql"|"env"|"gitignore"|
        "gitattributes"|"editorconfig"|"dockerfile"|"containerfile"|"c"|"cpp"|
        "cc"|"h"|"hpp"|"go"|"mod"|"java"|"kt"|"kts"|"swift"|"rb"|"php"|
        "cs"|"fs"|"fsx"|"lua"|"r"|"dart"|"ex"|"exs"|"hs"|"clj"|"cljs"|
        "scala"|"vue"|"svelte"|"astro"|"prisma"|"proto"|"tf"|"tfvars"|
        "ini"|"cfg"|"conf"|"config"|"csv"|"tsv"|"makefile"|"mk"|"log"|
        "zig"|"nim"|"sol"|"plist"
    )
}

fn estimate_tokens(text: &str) -> usize { (text.len() as f64 / 4.0).ceil() as usize }

/// Map a file extension to its Markdown fenced-code language string.
fn get_md_lang(ext: &str) -> &str {
    match ext.to_lowercase().as_str() {
        "rs"                        => "rust",
        "ts" | "tsx"                => "typescript",
        "js" | "jsx" | "mjs"|"cjs" => "javascript",
        "py" | "pyi" | "pyw"        => "python",
        "json"|"jsonc"|"json5"      => "json",
        "html"|"htm"|"xhtml"        => "html",
        "css"                       => "css",
        "scss"                      => "scss",
        "sass"                      => "sass",
        "less"                      => "less",
        "sh"|"bash"|"zsh"|"fish"    => "bash",
        "yaml"|"yml"                => "yaml",
        "toml"                      => "toml",
        "xml"                       => "xml",
        "svg"                       => "svg",
        "sql"                       => "sql",
        "graphql"|"gql"             => "graphql",
        "md"|"mdx"|"markdown"       => "markdown",
        "go"                        => "go",
        "java"                      => "java",
        "kt"|"kts"                  => "kotlin",
        "swift"                     => "swift",
        "rb"                        => "ruby",
        "php"                       => "php",
        "cs"                        => "csharp",
        "cpp"|"cc"|"hpp"            => "cpp",
        "c"|"h"                     => "c",
        "lua"                       => "lua",
        "r"                         => "r",
        "dart"                      => "dart",
        "ex"|"exs"                  => "elixir",
        "hs"                        => "haskell",
        "scala"                     => "scala",
        "vue"                       => "vue",
        "svelte"                    => "svelte",
        "tf"|"tfvars"               => "hcl",
        "proto"                     => "protobuf",
        "sol"                       => "solidity",
        "zig"                       => "zig",
        "dockerfile"|"containerfile"=> "dockerfile",
        _                           => "text",
    }
}

// ─── ID Assignment ────────────────────────────────────────────────────────────

/// A tree node decorated with a stable string ID, e.g. "001", "001_A".
struct IdNode {
    name:     String,
    is_dir:   bool,
    id:       String,
    children: Vec<IdNode>,
}

/// Walk `tree` and assign IDs.
/// Directories get zero-padded numeric IDs ("000", "001", …).
/// Files inside a directory get the parent's numeric ID + a letter suffix
/// ("001_A", "001_B", …).  The root itself gets "000".
fn assign_ids(tree: &TreeNode) -> IdNode {
    let mut dir_counter: u32 = 0;
    assign_ids_inner(tree, &mut dir_counter, None)
}

fn assign_ids_inner(node: &TreeNode, dir_counter: &mut u32, parent_dir_id: Option<&str>) -> IdNode {
    if node.is_dir {
        let id = format!("{:03}", dir_counter);
        *dir_counter += 1;
        let id_clone = id.clone();
        let children = node.children.iter().map(|c| {
            assign_ids_inner(c, dir_counter, Some(&id_clone))
        }).collect();
        IdNode { name: node.name.clone(), is_dir: true, id, children }
    } else {
        // Files: parent_dir_id + letter (A, B, … Z, AA, AB, …)
        // We don't have a per-parent counter here, so we derive the letter
        // from the node's position inside its parent — handled by the caller.
        // Use a placeholder; real letter injected in render_project_map.
        IdNode { name: node.name.clone(), is_dir: false, id: format!("{}_?", parent_dir_id.unwrap_or("000")), children: vec![] }
    }
}

/// Properly assign IDs by iterating children with awareness of sibling index.
fn assign_ids_full(tree: &TreeNode) -> IdNode {
    let root_id = "000".to_string();
    let mut dir_counter: u32 = 1; // root consumed 000
    let children = assign_children(tree, &root_id, &mut dir_counter);
    IdNode { name: tree.name.clone(), is_dir: true, id: root_id, children }
}

fn assign_children(parent: &TreeNode, parent_id: &str, dir_counter: &mut u32) -> Vec<IdNode> {
    let mut file_idx: u32 = 0;
    let mut result = vec![];
    for child in &parent.children {
        if child.is_dir {
            let id = format!("{:03}", dir_counter);
            *dir_counter += 1;
            let sub_children = assign_children(child, &id, dir_counter);
            result.push(IdNode { name: child.name.clone(), is_dir: true, id, children: sub_children });
        } else {
            // Convert index to letter(s): 0→A, 1→B, …, 25→Z, 26→AA …
            let letter = idx_to_letter(file_idx);
            file_idx += 1;
            let id = format!("{}_{}", parent_id, letter);
            result.push(IdNode { name: child.name.clone(), is_dir: false, id, children: vec![] });
        }
    }
    result
}

fn idx_to_letter(mut n: u32) -> String {
    let mut s = String::new();
    loop {
        s.insert(0, (b'A' + (n % 26) as u8) as char);
        if n < 26 { break; }
        n = n / 26 - 1;
    }
    s
}

// ─── New rendering helpers ────────────────────────────────────────────────────

/// Render the PROJECT MAP section: tree view with [ID: …] annotations.
fn render_project_map(node: &IdNode, prefix: &str, is_last: bool, is_root: bool) -> String {
    if is_root {
        let mut r = format!("📁 {}/ [ID: {}]\n", node.name, node.id);
        let len = node.children.len();
        for (i, c) in node.children.iter().enumerate() {
            r.push_str(&render_project_map(c, "", i == len - 1, false));
        }
        return r;
    }
    let connector = if is_last { "└── " } else { "├── " };
    let label = if node.is_dir {
        format!("📁 {}/ [ID: {}]", node.name, node.id)
    } else {
        format!("📄 {} [ID: {}]", node.name, node.id)
    };
    let mut r = format!("{}{}{}\n", prefix, connector, label);
    if node.is_dir {
        let child_prefix = format!("{}{}   ", prefix, if is_last { " " } else { "│" });
        let len = node.children.len();
        for (i, c) in node.children.iter().enumerate() {
            r.push_str(&render_project_map(c, &child_prefix, i == len - 1, false));
        }
    }
    r
}

/// Collect a flat list of (id_node_ref, relative_path) for every file in the tree.
fn collect_files<'a>(node: &'a IdNode, path_so_far: &str, out: &mut Vec<(String, String, String)>) {
    let cur_path = if path_so_far.is_empty() {
        node.name.clone()
    } else {
        format!("{}/{}", path_so_far, node.name)
    };
    if node.is_dir {
        for c in &node.children { collect_files(c, &cur_path, out); }
    } else {
        // (id, relative_path, name)
        out.push((node.id.clone(), cur_path, node.name.clone()));
    }
}

/// Render the FILE REPOSITORY section using tagged blocks.
fn render_file_repository(
    id_tree: &IdNode,
    fs_root: &Path,
    bin: &mut usize,
    fc: &mut usize,
    dc: &mut usize,
    opts: &ProcessOptions,
) -> String {
    let mut files: Vec<(String, String, String)> = vec![];
    collect_files(id_tree, "", &mut files);

    // Count dirs (reuse existing count_ff on original tree — caller already has those counts,
    // but we still need to walk for dc here)
    *dc = count_id_dirs(id_tree);

    let mut out = String::new();
    for (id, rel_path, name) in &files {
        *fc += 1;
        let full = fs_root.join(rel_path.trim_start_matches(&format!("{}/", id_tree.name)));
        let ext = Path::new(name)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let lang = get_md_lang(&ext);
        let size_ok = fs::metadata(&full).map(|m| m.len() <= opts.max_file_size_kb * 1024).unwrap_or(false);
        let is_text = is_text_extension(&ext) || ext.is_empty();

        out.push_str("[FILE_START]\n");
        out.push_str(&format!("ID: {}\n", id));
        out.push_str(&format!("PATH: {}\n", rel_path));
        out.push_str(&format!("EXTENSION: {}\n", if ext.is_empty() { "text".to_string() } else { ext.to_string() }));
        out.push_str("----------------------------------------------------------------\n");

        if !is_text || !size_ok {
            if !is_text {
                *bin += 1;
                out.push_str("[Binary — not included]\n");
            } else {
                out.push_str(&format!("[File too large (>{}KB)]\n", opts.max_file_size_kb));
            }
        } else {
            match fs::read(&full) {
                Ok(bytes) => {
                    let text = match String::from_utf8(bytes.clone()) {
                        Ok(s) => s,
                        Err(_) => {
                            let (cow, _, err) = encoding_rs::WINDOWS_1252.decode(&bytes);
                            if !err {
                                cow.into_owned()
                            } else {
                                *bin += 1;
                                out.push_str("[Cannot decode]\n");
                                out.push_str(&format!("[FILE_END: {}]\n", id));
                                out.push_str("================================================================\n");
                                continue;
                            }
                        }
                    };
                    out.push_str(&format!("```{}\n{}\n```\n", lang, text));
                }
                Err(_) => { out.push_str("[Cannot read]\n"); }
            }
        }
        out.push_str(&format!("[FILE_END: {}]\n", id));
        out.push_str("================================================================\n");
    }
    out
}

fn count_id_dirs(node: &IdNode) -> usize {
    if !node.is_dir { return 0; }
    let mut d = 1;
    for c in &node.children { d += count_id_dirs(c); }
    d
}

/// Walk the entire tree from `root` and collect every .gitignore found,
/// pairing each one with the directory it lives in.
/// This mirrors how git itself works: each .gitignore applies relative to its
/// own directory, not just the repo root.
fn collect_gitignores(root: &Path) -> Vec<(PathBuf, Vec<String>)> {
    let mut result = vec![];
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_name() != ".gitignore" { continue; }
        let dir = entry.path().parent().unwrap_or(root).to_path_buf();
        let patterns: Vec<String> = fs::read_to_string(entry.path())
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect();
        result.push((dir, patterns));
    }
    result
}

/// Check whether `path` should be excluded according to any of the collected
/// gitignore rule sets.
///
/// Fixes three bugs in the old implementation:
///
/// 1. Single-root only — old code only read the top-level .gitignore.
///    Now every nested .gitignore is respected relative to its own dir.
///
/// 2. `.contains()` too loose — a pattern like `env` would match
///    `environment.ts`. Now uses exact segment comparison.
///
/// 3. Wildcards not handled — patterns like `*.env.local` or `*.log`
///    were never matched. Now handled by splitting on `*`.
fn is_gitignored(path: &Path, gitignores: &[(PathBuf, Vec<String>)]) -> bool {
    gitignores.iter().any(|(dir, patterns)| {
        let rel = match path.strip_prefix(dir) {
            Ok(r) => r,
            Err(_) => return false,
        };
        // Use forward slashes for matching (works on Windows too)
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let file_name = path
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default();

        patterns.iter().any(|raw| {
            // Negation patterns are skipped — full negation needs a two-pass approach
            if raw.starts_with('!') { return false; }
            let p = raw.trim_start_matches('/').trim_end_matches('/');

            if p.contains('*') {
                // Glob: split on `*` and check prefix + suffix
                // e.g. `*.env.local` → prefix="" suffix=".env.local"
                let parts: Vec<&str> = p.splitn(2, '*').collect();
                let prefix = parts[0];
                let suffix = if parts.len() > 1 { parts[1] } else { "" };
                // Match against bare filename (most common) or full relative path
                (file_name.starts_with(prefix) && file_name.ends_with(suffix))
                    || (rel_str.starts_with(prefix) && rel_str.ends_with(suffix))
            } else if p.contains('/') {
                // Path pattern: must match from the gitignore's dir
                // e.g. `build/output` or `src/generated/`
                rel_str == p || rel_str.starts_with(&format!("{}/", p))
            } else {
                // Name-only pattern: match exact filename or any path segment.
                // Avoids the old `.contains()` bug where `env` matched `environment.ts`
                file_name == p || rel_str.split('/').any(|seg| seg == p)
            }
        })
    })
}

struct TreeNode { name: String, is_dir: bool, children: Vec<TreeNode>, depth: usize }

fn build_tree(path: &Path, depth: usize, ignored: &HashSet<&str>, gitignores: &[(PathBuf, Vec<String>)], root: &Path, opts: &ProcessOptions) -> TreeNode {
    build_tree_with_extra(path, depth, ignored, gitignores, root, opts, &std::collections::HashSet::new())
}

fn build_tree_with_extra(path: &Path, depth: usize, ignored: &HashSet<&str>, gitignores: &[(PathBuf, Vec<String>)], root: &Path, opts: &ProcessOptions, extra_excl: &std::collections::HashSet<PathBuf>) -> TreeNode {
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let is_dir = path.is_dir();
    let mut children = vec![];
    if is_dir {
        if let Ok(entries) = fs::read_dir(path) {
            let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
            paths.sort_by(|a, b| match (a.is_dir(), b.is_dir()) {
                (true,false) => std::cmp::Ordering::Less, (false,true) => std::cmp::Ordering::Greater,
                _ => a.file_name().cmp(&b.file_name()),
            });
            for cp in paths {
                let cn = cp.file_name().unwrap_or_default().to_string_lossy().to_string();
                if opts.skip_default_ignores && cp.is_dir() && ignored.contains(cn.as_str()) { continue; }
                if opts.respect_gitignore && is_gitignored(&cp, gitignores) { continue; }
                // Skip any path the user manually excluded via the folder picker
                if extra_excl.iter().any(|excl| cp == *excl || cp.starts_with(excl)) { continue; }
                children.push(build_tree_with_extra(&cp, depth+1, ignored, gitignores, root, opts, extra_excl));
            }
        }
    }
    TreeNode { name, is_dir, children, depth }
}

fn render_tree_visual(node: &TreeNode, prefix: &str, is_last: bool) -> String {
    let connector = if is_last { "└── " } else { "├── " };
    let icon = if node.is_dir { "📁 " } else { "" };
    let mut r = format!("{}{}{}{}\n", prefix, connector, icon, node.name);
    if node.is_dir {
        let cp = format!("{}{}   ", prefix, if is_last { " " } else { "│" });
        let len = node.children.len();
        for (i, c) in node.children.iter().enumerate() { r.push_str(&render_tree_visual(c, &cp, i==len-1)); }
    }
    r
}

fn get_flat(node: &TreeNode, so_far: &str) -> Vec<String> {
    let cur = if so_far.is_empty() { node.name.clone() } else { format!("{} / {}", so_far, node.name) };
    let mut r = vec![cur.clone()];
    if node.is_dir { for c in &node.children { r.extend(get_flat(c, &cur)); } }
    r
}

fn render_content(node: &TreeNode, full: &Path, depth: usize, bin: &mut usize, fc: &mut usize, dc: &mut usize, out: &mut String, opts: &ProcessOptions) {
    let sep = "\n= = = = = = = = = = = = = = = = = = = = = = = =\n";
    let ind = "  ".repeat(depth);
    if node.is_dir {
        *dc += 1;
        out.push_str(&format!("\n{}📁 {}/\n", ind, node.name));
        out.push_str(sep);
        for c in &node.children { render_content(c, &full.join(&c.name), depth+1, bin, fc, dc, out, opts); }
    } else {
        *fc += 1;
        let ext = full.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let size_ok = fs::metadata(full).map(|m| m.len() <= opts.max_file_size_kb*1024).unwrap_or(false);
        let is_text = is_text_extension(&ext) || ext.is_empty();
        out.push_str(&format!("\n{}📄 {}\n", ind, node.name));
        if !is_text || !size_ok {
            if !is_text { *bin += 1; out.push_str(&format!("{}[Binary — not included]\n", ind)); }
            else { out.push_str(&format!("{}[File too large (>{}KB)]\n", ind, opts.max_file_size_kb)); }
        } else {
            match fs::read(full) {
                Ok(bytes) => {
                    let text = match String::from_utf8(bytes.clone()) {
                        Ok(s) => s,
                        Err(_) => {
                            let (cow, _, err) = encoding_rs::WINDOWS_1252.decode(&bytes);
                            if !err { cow.into_owned() } else {
                                *bin += 1; out.push_str(&format!("{}[Cannot decode]\n", ind)); out.push_str(sep); return;
                            }
                        }
                    };
                    out.push_str(&format!("```\n{}\n```\n", text));
                }
                Err(_) => { out.push_str(&format!("{}[Cannot read]\n", ind)); }
            }
        }
        out.push_str(sep);
    }
}

fn count_ff(node: &TreeNode) -> (usize, usize) {
    if !node.is_dir { return (1,0); }
    let mut f=0; let mut d=1;
    for c in &node.children { let (cf,cd)=count_ff(c); f+=cf; d+=cd; }
    (f,d)
}

fn get_app_output_dir() -> PathBuf {
    let d = get_codext_dir().join("outputs");
    fs::create_dir_all(&d).ok(); d
}

fn chrono_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{} (unix)", d.as_secs()))
        .unwrap_or_else(|_| "unknown".to_string())
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

pub mod commands {
    use super::*;

    /// Returns the stable machine ID for this device.
    /// Used to pass to the purchase URL so the webhook can bind the license automatically.

    #[tauri::command]
    pub fn read_output_file(path: String) -> Result<String, String> {
        fs::read_to_string(&path).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn get_machine_id() -> String {
        // Load cached or generate
        let path = get_codext_dir().join(MACHINE_ID_FILE);
        if let Ok(cached) = fs::read_to_string(&path) {
            let cached = cached.trim().to_string();
            if cached.len() > 8 { return cached; }
        }
        let id = generate_machine_id();
        let _ = fs::write(&path, &id);
        id
    }

    /// Called at app startup and after purchase.
    /// Checks Supabase for a license bound to this machine_id.
    /// If found, saves it locally and returns Pro status.
    #[tauri::command]
    pub fn check_license_remote() -> LicenseCheckResult {
        // If already cached locally and valid, return immediately
        if let Some(key) = load_license() {
            if is_valid_key_format(&key) {
                return LicenseCheckResult { is_pro: true, key: Some(key), method: "cached".into() };
            }
        }
        // Otherwise query Supabase by machine_id
        let machine_id = get_machine_id_cached();
        if let Some(key) = supabase_check_machine(&machine_id) {
            save_license(&key);
            return LicenseCheckResult { is_pro: true, key: Some(key), method: "machine_id".into() };
        }
        LicenseCheckResult { is_pro: false, key: None, method: "none".into() }
    }

    /// Manual activation: user pastes their key.
    /// Verifies with Supabase and binds to this machine.
    #[tauri::command]
    pub fn activate_license(key: String) -> Result<LicenseStatus, String> {
        let key = key.trim().to_uppercase();
        if !is_valid_key_format(&key) {
            return Err("Invalid key format. Expected: CODEXT-XXXX-XXXX-XXXX-XXXX".to_string());
        }
        let machine_id = get_machine_id_cached();
        supabase_verify_and_bind(&key, &machine_id)?;
        save_license(&key);
        Ok(build_license_status())
    }

    /// Deactivate — removes local cache and unlinks machine_id in Supabase.
    #[tauri::command]
    pub fn deactivate_license() -> Result<(), String> {
        if let Some(key) = load_license() {
            // Unlink machine_id in Supabase
            let patch_url = format!("{}/rest/v1/licenses?license_key=eq.{}", SUPABASE_URL, urlenccode(&key));
            let _ = ureq::patch(&patch_url)
                .set("apikey", SUPABASE_ANON_KEY)
                .set("Authorization", &format!("Bearer {}", SUPABASE_ANON_KEY))
                .set("Content-Type", "application/json")
                .set("Prefer", "return=minimal")
                .send_string(r#"{"visitor_id":null}"#);
        }
        let path = get_license_path();
        if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
        Ok(())
    }

    #[tauri::command]
    pub fn get_license_status() -> LicenseStatus { build_license_status() }

    #[tauri::command]
    pub fn get_folder_info(folder_path: String) -> Result<FolderInfo, String> {
        let path = Path::new(&folder_path);
        if !path.exists() || !path.is_dir() { return Err("Invalid folder path".to_string()); }
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let mut fc=0; let mut dc=0usize; let mut sz:u64=0;
        for e in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
            if e.file_type().is_file() { fc+=1; sz+=e.metadata().map(|m|m.len()).unwrap_or(0); }
            else if e.file_type().is_dir() && e.path()!=path { dc+=1; }
        }
        Ok(FolderInfo { name, path: folder_path, file_count: fc, folder_count: dc, size_kb: sz as f64/1024.0 })
    }

    /// List immediate subdirectories of a folder — used by the folder picker UI.
    #[tauri::command]
    pub fn list_top_level_dirs(folder_path: String) -> Result<Vec<serde_json::Value>, String> {
        let path = Path::new(&folder_path);
        if !path.exists() || !path.is_dir() { return Err("Invalid path".to_string()); }
        let mut dirs = vec![];
        if let Ok(entries) = fs::read_dir(path) {
            let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
            paths.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
            for p in paths {
                if p.is_dir() {
                    let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let rel = p.strip_prefix(path).unwrap_or(&p).to_string_lossy().to_string();
                    dirs.push(serde_json::json!({ "path": rel, "name": name, "depth": 0 }));
                }
            }
        }
        Ok(dirs)
    }

    #[tauri::command]
    pub fn process_folder(folder_path: String, options: ProcessOptions, extra_exclusions: Option<Vec<String>>) -> Result<ProcessResult, String> {
        let root = Path::new(&folder_path);
        if !root.exists() || !root.is_dir() { return Err("Invalid folder path".to_string()); }
        let pro = is_pro();
        if !pro {
            let count = get_bundle_count();
            if count >= FREE_BUNDLE_LIMIT { return Err("FREE_LIMIT:bundles".to_string()); }
        }
        let ignored = default_ignored_dirs();
        let gitignores = if options.respect_gitignore { collect_gitignores(root) } else { vec![] };

        // Build a set of absolute paths the user manually excluded via the picker
        let extra_excl_paths: std::collections::HashSet<PathBuf> = extra_exclusions
            .unwrap_or_default()
            .iter()
            .map(|rel| root.join(rel))
            .collect();

        let fname = root.file_name().unwrap_or_default().to_string_lossy().to_string();
        let tree = build_tree_with_extra(root, 0, &ignored, &gitignores, root, &options, &extra_excl_paths);
        let (total_f, total_d) = count_ff(&tree);
        if !pro && total_f > FREE_FILE_LIMIT { return Err(format!("FREE_LIMIT:files:{}", total_f)); }

        // ── Assign stable IDs to every node ──────────────────────────
        let id_tree = assign_ids_full(&tree);

        let mut output = String::new();

        // ── Global Protocol Header ────────────────────────────────────
        output.push_str("╔══════════════════════════════════════════════════════════════╗\n");
        if options.structure_only {
            output.push_str("║           CODEXT: PROJECT STRUCTURE MAP                      ║\n");
        } else {
            output.push_str("║              CODEXT: UNIVERSAL CODEBASE STREAM               ║\n");
        }
        output.push_str("╚══════════════════════════════════════════════════════════════╝\n\n");
        output.push_str("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
        if options.structure_only {
            output.push_str("CODEXT PROTOCOL:\n");
            output.push_str("1. Use [ID] to locate files and folders in the PROJECT MAP.\n");
            output.push_str("2. Structure-only mode — file contents not included.\n");
        } else {
            output.push_str("CODEXT PROTOCOL:\n");
            output.push_str("1. Use [ID] to track file locations in the PROJECT MAP.\n");
            output.push_str("2. Always return the FULL file content for any requested change.\n");
            output.push_str("3. Use the provided [EXTENSION] for code block syntax.\n");
            output.push_str("4. EXCLUSION RULE: Do NOT include CODEXT metadata (e.g., [FILE_START], ID, PATH, [FILE_END]) inside the code blocks you generate. Output ONLY the raw source code.\n");
        }
        output.push_str("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

        // ── INFO ──────────────────────────────────────────────────────
        output.push_str("━━━ INFO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");
        output.push_str(&format!("  Folder name   : {}\n", fname));
        output.push_str(&format!("  Full path     : {}\n", folder_path));
        output.push_str(&format!("  File count    : {}\n", total_f));
        output.push_str(&format!("  Folder count  : {}\n", total_d));
        output.push_str(&format!("  Generated on  : {}\n", chrono_now()));
        output.push_str(&format!("  Mode          : {}\n", if options.structure_only { "structure-only" } else { "full" }));
        output.push_str(&format!("  Options       : gitignore={}, skip_defaults={}, max_size={}KB\n\n",
            options.respect_gitignore, options.skip_default_ignores, options.max_file_size_kb));

        // ── PROJECT MAP ───────────────────────────────────────────────
        output.push_str("━━━ PROJECT MAP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
        output.push_str(&render_project_map(&id_tree, "", false, true));
        output.push('\n');

        // ── FILE REPOSITORY (skipped in structure-only mode) ──────────
        let mut bin=0usize; let mut fc=0usize; let mut dc_a=0usize;
        if !options.structure_only {
            output.push_str("━━━ FILE REPOSITORY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");
            let repo = render_file_repository(&id_tree, root, &mut bin, &mut fc, &mut dc_a, &options);
            output.push_str(&repo);
        } else {
            // Still count for the result struct
            let _ = count_ff(&tree);
            fc = total_f; dc_a = total_d;
        }

        let out_kb = output.len() as f64 / 1024.0;
        if !pro && out_kb > FREE_OUTPUT_KB_LIMIT { return Err(format!("FREE_LIMIT:size:{:.1}", out_kb)); }

        let token_est = if options.include_token_count && pro { estimate_tokens(&output) } else { 0 };
        if pro && options.include_token_count {
            output = output.replacen(
                &format!("  Options       : gitignore={}, skip_defaults={}, max_size={}KB\n\n",
                    options.respect_gitignore, options.skip_default_ignores, options.max_file_size_kb),
                &format!("  Options       : gitignore={}, skip_defaults={}, max_size={}KB\n  Token estimate: ~{} tokens\n\n",
                    options.respect_gitignore, options.skip_default_ignores, options.max_file_size_kb, token_est),
                1);
            output.push_str(&format!("\n━━━ TOKEN ESTIMATE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  Approximate token count : {:>10}\n  (4 chars/token estimate)\n\n", token_est));
        }

        if !pro { increment_bundle_count(); }

        let out_dir = get_app_output_dir();
        let out_path = out_dir.join(format!("{}_codext.txt", fname));
        fs::write(&out_path, &output).map_err(|e| e.to_string())?;

        Ok(ProcessResult {
            output_path: out_path.to_string_lossy().to_string(),
            file_count: fc, folder_count: dc_a, skipped_binary: bin,
            skipped_ignored: 0, token_estimate: token_est,
            total_size_kb: output.len() as f64/1024.0,
        })
    }

    #[tauri::command]
    pub fn open_file(path: String, _app: tauri::AppHandle) -> Result<(), String> {
        tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn save_file_as(source_path: String, dest_path: String) -> Result<(), String> {
        fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?; Ok(())
    }

    // ─── GitHub commands ──────────────────────────────────────────────────────

    /// Read the stored GitHub OAuth token, if any.
    #[tauri::command]
    pub fn get_github_token() -> Option<String> {
        fs::read_to_string(get_github_token_path())
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    /// Store (or clear) the GitHub OAuth token.
    /// Called by the deep-link handler after OAuth completes, or on disconnect.
    #[tauri::command]
    pub fn store_github_token(token: Option<String>) -> Result<(), String> {
        let path = get_github_token_path();
        match token {
            Some(t) if !t.trim().is_empty() => {
                fs::write(&path, t.trim()).map_err(|e| e.to_string())
            }
            _ => {
                if path.exists() { fs::remove_file(&path).map_err(|e| e.to_string())?; }
                Ok(())
            }
        }
    }

    /// Clone a GitHub repo (shallow, depth 1) into the CODEXT clones directory.
    /// Authenticates via the token embedded in the clone URL.
    /// If `sub_path` is non-empty, returns the path to that subdirectory inside
    /// the clone, so the frontend can pass it straight into `get_folder_info`.
    ///
    /// Clone dir layout: <CODEXT_DIR>/clones/<owner>__<repo>/
    /// Re-cloning the same repo deletes the old clone first to keep disk clean.
    #[tauri::command]
    pub fn github_clone_repo(clone_url: String, token: String, sub_path: String) -> Result<String, String> {
        use std::process::Command;

        // Build an authenticated clone URL:
        // https://TOKEN@github.com/owner/repo.git
        let auth_url = clone_url
            .replace("https://", &format!("https://{}@", token.trim()));

        // Derive a safe directory name from the clone URL
        // e.g. https://github.com/owner/repo.git  →  owner__repo
        let repo_slug = clone_url
            .trim_end_matches(".git")
            .rsplit('/')
            .take(2)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("__");

        let clone_dir = get_clones_dir().join(&repo_slug);

        // Remove stale clone if it exists
        if clone_dir.exists() {
            fs::remove_dir_all(&clone_dir).map_err(|e| format!("Failed to clear old clone: {}", e))?;
        }

        // Run: git clone --depth 1 --single-branch <url> <dir>
        let output = Command::new("git")
            .args([
                "clone",
                "--depth", "1",
                "--single-branch",
                &auth_url,
                &clone_dir.to_string_lossy(),
            ])
            .output()
            .map_err(|e| format!("git not found — make sure Git is installed: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // Strip the token from any error message before surfacing it
            let sanitised = stderr.replace(token.trim(), "***");
            return Err(format!("Clone failed: {}", sanitised.trim()));
        }

        // Resolve the final path — root of repo or a specific subdirectory
        let result_path = if sub_path.trim().is_empty() {
            clone_dir
        } else {
            // Normalise separators and strip leading slashes
            let clean = sub_path.trim().replace('\\', "/").trim_start_matches('/').to_string();
            clone_dir.join(clean)
        };

        if !result_path.exists() || !result_path.is_dir() {
            return Err(format!("Path not found in repo: {}", sub_path));
        }

        Ok(result_path.to_string_lossy().to_string())
    }
} // end pub mod commands

fn get_machine_id_cached() -> String {
    let path = get_codext_dir().join(MACHINE_ID_FILE);
    fs::read_to_string(&path).ok().map(|s| s.trim().to_string())
        .filter(|s| s.len() > 8)
        .unwrap_or_else(|| {
            let id = generate_machine_id();
            let _ = fs::write(&path, &id);
            id
        })
}

fn build_license_status() -> LicenseStatus {
    LicenseStatus {
        is_pro: is_pro(),
        key: load_license(),
        machine_id: get_machine_id_cached(),
        bundle_count: get_bundle_count(),
        free_file_limit: FREE_FILE_LIMIT,
        free_output_kb_limit: FREE_OUTPUT_KB_LIMIT,
        free_bundle_limit: FREE_BUNDLE_LIMIT,
    }
}

use tauri::{Emitter, Listener};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Listen for deep links: codext://auth?token=TOKEN
            let app_handle = app.handle().clone();
            app.listen("deep-link://new-url", move |event: tauri::Event| {
                // event.payload() is a JSON string like ["codext://auth?token=xxx"]
                let raw = event.payload();
                // Strip JSON array wrapper if present: ["url"] → url
                let url = raw
                    .trim()
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .trim_matches('"')
                    .to_string();
                handle_deep_link(&app_handle, &url);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_machine_id,
            commands::check_license_remote,
            commands::activate_license,
            commands::deactivate_license,
            commands::get_license_status,
            commands::get_folder_info,
            commands::list_top_level_dirs,
            commands::process_folder,
            commands::open_file,
            commands::read_output_file,
            commands::save_file_as,
            commands::get_github_token,
            commands::store_github_token,
            commands::github_clone_repo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Parse a deep-link URL and store the GitHub token.
/// codext://auth?token=ghp_xxxx
fn handle_deep_link(app: &tauri::AppHandle, url: &str) {
    let token = url
        .split('?')
        .nth(1)
        .and_then(|qs| {
            qs.split('&').find_map(|pair| {
                let mut kv = pair.splitn(2, '=');
                if kv.next()? == "token" { kv.next().map(|v| v.to_string()) } else { None }
            })
        });

    if let Some(t) = token {
        let token_clean = t.trim().to_string();
        if !token_clean.is_empty() {
            let _ = fs::write(get_github_token_path(), &token_clean);
            let _ = app.emit("github-token-received", token_clean);
        }
    }
}