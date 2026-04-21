// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    register_deep_link_scheme();
    codext_lib::run();
}

#[cfg(target_os = "windows")]
fn register_deep_link_scheme() {
    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let exe_str = exe_path.to_string_lossy();
    let command = format!("\"{}\" \"%1\"", exe_str);
    let key = "HKCU\\Software\\Classes\\codext";

    let _ = std::process::Command::new("reg")
        .args(["add", key, "/ve", "/d", "URL:codext Protocol", "/f"])
        .output();
    let _ = std::process::Command::new("reg")
        .args(["add", key, "/v", "URL Protocol", "/d", "", "/f"])
        .output();
    let _ = std::process::Command::new("reg")
        .args(["add", &format!("{}\\shell\\open\\command", key), "/ve", "/d", &command, "/f"])
        .output();
}

#[cfg(not(target_os = "windows"))]
fn register_deep_link_scheme() {}