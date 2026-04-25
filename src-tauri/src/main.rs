#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    register_deep_link_scheme();
    codext_lib::run();
}

#[cfg(target_os = "windows")]
fn register_deep_link_scheme() {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x08000000;

    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let exe_str = exe_path.to_string_lossy();
    let command = format!("\"{}\" \"%1\"", exe_str);
    let key = "HKCU\\Software\\Classes\\codext";
    let cmd_key = format!("{}\\shell\\open\\command", key);

    // Check silently if already registered with the correct path
    let already = std::process::Command::new("reg")
        .args(["query", &cmd_key, "/ve"])
        .creation_flags(NO_WINDOW)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(exe_str.as_ref()))
        .unwrap_or(false);

    if already { return; }

    // Write registry entries — all hidden, no terminal
    let _ = std::process::Command::new("reg")
        .args(["add", key, "/ve", "/d", "URL:codext Protocol", "/f"])
        .creation_flags(NO_WINDOW).output();
    let _ = std::process::Command::new("reg")
        .args(["add", key, "/v", "URL Protocol", "/d", "", "/f"])
        .creation_flags(NO_WINDOW).output();
    let _ = std::process::Command::new("reg")
        .args(["add", &cmd_key, "/ve", "/d", &command, "/f"])
        .creation_flags(NO_WINDOW).output();
}

#[cfg(not(target_os = "windows"))]
fn register_deep_link_scheme() {}