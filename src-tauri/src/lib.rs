use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProcessOptions {
    pub respect_gitignore: bool,
    pub skip_default_ignores: bool,
    pub include_token_count: bool,
    pub max_file_size_kb: u64,
}

impl Default for ProcessOptions {
    fn default() -> Self {
        Self {
            respect_gitignore: true,
            skip_default_ignores: true,
            include_token_count: true,
            max_file_size_kb: 500,
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ProcessResult {
    pub output_path: String,
    pub file_count: usize,
    pub folder_count: usize,
    pub skipped_binary: usize,
    pub skipped_ignored: usize,
    pub token_estimate: usize,
    pub total_size_kb: f64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct FolderInfo {
    pub name: String,
    pub path: String,
    pub file_count: usize,
    pub folder_count: usize,
    pub size_kb: f64,
}

fn default_ignored_dirs() -> HashSet<&'static str> {
    let mut s = HashSet::new();
    for d in ["node_modules",".git","dist","build",".next","target",
              "__pycache__",".cache","coverage",".nyc_output","vendor",
              ".venv","venv","env",".env",".idea",".vscode","out",
              ".turbo",".parcel-cache","storybook-static",".svelte-kit",
              "elm-stuff",".dart_tool"] {
        s.insert(d);
    }
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

fn estimate_tokens(text: &str) -> usize {
    (text.len() as f64 / 4.0).ceil() as usize
}

fn read_gitignore(folder_path: &Path) -> Vec<String> {
    let gitignore = folder_path.join(".gitignore");
    if let Ok(content) = fs::read_to_string(&gitignore) {
        content.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect()
    } else { vec![] }
}

fn is_gitignored(path: &Path, root: &Path, patterns: &[String]) -> bool {
    let relative = match path.strip_prefix(root) { Ok(r) => r, Err(_) => return false };
    let rel_str = relative.to_string_lossy();
    for pattern in patterns {
        let clean = pattern.trim_start_matches('/').trim_end_matches('/');
        if rel_str.contains(clean) { return true; }
    }
    false
}

struct TreeNode {
    name: String,
    is_dir: bool,
    children: Vec<TreeNode>,
    depth: usize,
}

fn build_tree(path: &Path, depth: usize, ignored_dirs: &HashSet<&str>, gitignore_patterns: &[String], root: &Path, opts: &ProcessOptions) -> TreeNode {
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let is_dir = path.is_dir();
    let mut children = vec![];
    if is_dir {
        if let Ok(entries) = fs::read_dir(path) {
            let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
            paths.sort_by(|a, b| match (a.is_dir(), b.is_dir()) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.file_name().cmp(&b.file_name()),
            });
            for child_path in paths {
                let child_name = child_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                if opts.skip_default_ignores && child_path.is_dir() && ignored_dirs.contains(child_name.as_str()) { continue; }
                if opts.respect_gitignore && is_gitignored(&child_path, root, gitignore_patterns) { continue; }
                children.push(build_tree(&child_path, depth + 1, ignored_dirs, gitignore_patterns, root, opts));
            }
        }
    }
    TreeNode { name, is_dir, children, depth }
}

fn render_tree_visual(node: &TreeNode, prefix: &str, is_last: bool) -> String {
    let connector = if is_last { "└── " } else { "├── " };
    let icon = if node.is_dir { "📁 " } else { "" };
    let mut result = format!("{}{}{}{}\n", prefix, connector, icon, node.name);
    if node.is_dir {
        let child_prefix = format!("{}{}   ", prefix, if is_last { " " } else { "│" });
        let len = node.children.len();
        for (i, child) in node.children.iter().enumerate() {
            result.push_str(&render_tree_visual(child, &child_prefix, i == len - 1));
        }
    }
    result
}

fn get_flat_structure(node: &TreeNode, path_so_far: &str) -> Vec<String> {
    let current = if path_so_far.is_empty() { node.name.clone() } else { format!("{} / {}", path_so_far, node.name) };
    let mut result = vec![current.clone()];
    if node.is_dir {
        for child in &node.children { result.extend(get_flat_structure(child, &current)); }
    }
    result
}

fn render_content_block(node: &TreeNode, full_path: &Path, depth: usize, binary_count: &mut usize, file_count: &mut usize, folder_count: &mut usize, all_content: &mut String, opts: &ProcessOptions) {
    let separator = "\n= = = = = = = = = = = = = = = = = = = = = = = =\n";
    let indent = "  ".repeat(depth);
    if node.is_dir {
        *folder_count += 1;
        all_content.push_str(&format!("\n{}📁 {}/\n", indent, node.name));
        all_content.push_str(separator);
        for child in &node.children {
            render_content_block(child, &full_path.join(&child.name), depth + 1, binary_count, file_count, folder_count, all_content, opts);
        }
    } else {
        *file_count += 1;
        let ext = full_path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let size_ok = fs::metadata(full_path).map(|m| m.len() <= opts.max_file_size_kb * 1024).unwrap_or(false);
        let is_text = is_text_extension(&ext) || ext.is_empty();
        all_content.push_str(&format!("\n{}📄 {}\n", indent, node.name));
        if !is_text || !size_ok {
            if !is_text {
                *binary_count += 1;
                all_content.push_str(&format!("{}[Binary file — content not included]\n", indent));
            } else {
                all_content.push_str(&format!("{}[File too large — skipped ({} KB max)]\n", indent, opts.max_file_size_kb));
            }
        } else {
            match fs::read(full_path) {
                Ok(bytes) => {
                    let text = match String::from_utf8(bytes.clone()) {
                        Ok(s) => s,
                        Err(_) => {
                            let (cow, _, had_errors) = encoding_rs::WINDOWS_1252.decode(&bytes);
                            if !had_errors { cow.into_owned() } else {
                                *binary_count += 1;
                                all_content.push_str(&format!("{}[Could not decode file content]\n", indent));
                                all_content.push_str(separator);
                                return;
                            }
                        }
                    };
                    all_content.push_str(&format!("```\n{}\n```\n", text));
                }
                Err(_) => { all_content.push_str(&format!("{}[Could not read file]\n", indent)); }
            }
        }
        all_content.push_str(separator);
    }
}

fn count_files_folders(node: &TreeNode) -> (usize, usize) {
    if !node.is_dir { return (1, 0); }
    let mut files = 0; let mut folders = 1;
    for child in &node.children { let (f, d) = count_files_folders(child); files += f; folders += d; }
    (files, folders)
}

fn chrono_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{} (unix timestamp)", d.as_secs()))
        .unwrap_or_else(|_| "unknown".to_string())
}

pub mod commands {
    use super::*;

    #[tauri::command]
    pub fn get_folder_info(folder_path: String) -> Result<FolderInfo, String> {
        let path = Path::new(&folder_path);
        if !path.exists() || !path.is_dir() { return Err("Invalid folder path".to_string()); }
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let mut file_count = 0; let mut folder_count = 0usize; let mut total_size: u64 = 0;
        for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                file_count += 1;
                total_size += entry.metadata().map(|m| m.len()).unwrap_or(0);
            } else if entry.file_type().is_dir() && entry.path() != path {
                folder_count += 1;
            }
        }
        Ok(FolderInfo { name, path: folder_path, file_count, folder_count, size_kb: total_size as f64 / 1024.0 })
    }

    #[tauri::command]
    pub fn process_folder(folder_path: String, output_path: String, options: ProcessOptions) -> Result<ProcessResult, String> {
        let root = Path::new(&folder_path);
        if !root.exists() || !root.is_dir() { return Err("Invalid folder path".to_string()); }

        let ignored_dirs = default_ignored_dirs();
        let gitignore_patterns = if options.respect_gitignore { read_gitignore(root) } else { vec![] };
        let folder_name = root.file_name().unwrap_or_default().to_string_lossy().to_string();
        let tree = build_tree(root, 0, &ignored_dirs, &gitignore_patterns, root, &options);
        let (total_files, total_folders) = count_files_folders(&tree);

        let mut output = String::new();
        output.push_str("╔══════════════════════════════════════════════════════════════╗\n");
        output.push_str("║                        CODEXT OUTPUT                        ║\n");
        output.push_str("╚══════════════════════════════════════════════════════════════╝\n\n");
        output.push_str("━━━ INFO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");
        output.push_str(&format!("  Folder name   : {}\n", folder_name));
        output.push_str(&format!("  Full path     : {}\n", folder_path));
        output.push_str(&format!("  File count    : {}\n", total_files));
        output.push_str(&format!("  Folder count  : {}\n", total_folders));
        output.push_str(&format!("  Generated on  : {}\n", chrono_now()));
        output.push_str(&format!("  Options       : gitignore={}, skip_defaults={}, max_size={}KB\n\n",
            options.respect_gitignore, options.skip_default_ignores, options.max_file_size_kb));

        output.push_str("━━━ STRUCTURE TREE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");
        output.push_str(&format!("📁 {}/\n", folder_name));
        let children_len = tree.children.len();
        for (i, child) in tree.children.iter().enumerate() {
            output.push_str(&render_tree_visual(child, "", i == children_len - 1));
        }
        output.push('\n');

        output.push_str("━━━ FLAT STRUCTURE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");
        for item in get_flat_structure(&tree, "") { output.push_str(&format!("  {}\n", item)); }
        output.push('\n');

        output.push_str("━━━ CONTENT LAYOUT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
        let mut binary_count = 0usize; let mut file_count = 0usize; let mut folder_count_actual = 0usize;
        let mut content_block = String::new();
        render_content_block(&tree, root, 0, &mut binary_count, &mut file_count, &mut folder_count_actual, &mut content_block, &options);
        output.push_str(&content_block);

        let token_estimate = if options.include_token_count { estimate_tokens(&output) } else { 0 };
        if options.include_token_count {
            output = output.replacen(
                &format!("  Options       : gitignore={}, skip_defaults={}, max_size={}KB\n\n",
                    options.respect_gitignore, options.skip_default_ignores, options.max_file_size_kb),
                &format!("  Options       : gitignore={}, skip_defaults={}, max_size={}KB\n  Token estimate: ~{} tokens\n\n",
                    options.respect_gitignore, options.skip_default_ignores, options.max_file_size_kb, token_estimate),
                1);
            output.push_str(&format!("\n━━━ TOKEN ESTIMATE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  Approximate token count : {:>10}\n  (Estimated at 4 chars/token — actual may vary by model)\n\n", token_estimate));
        }

        fs::write(Path::new(&output_path), &output).map_err(|e| e.to_string())?;
        Ok(ProcessResult {
            output_path, file_count, folder_count: folder_count_actual,
            skipped_binary: binary_count, skipped_ignored: 0,
            token_estimate, total_size_kb: output.len() as f64 / 1024.0,
        })
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_folder_info,
            commands::process_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}