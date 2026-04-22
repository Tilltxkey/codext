#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    register_deep_link_scheme();
    codext_lib::run();
}

#[cfg(target_os = "windows")]
fn register_deep_link_scheme() {
    use std::os::windows::process::CommandExt;

    let exe_path = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let exe_str = exe_path.to_string_lossy();
    let command = format!("\"{}\" \"%1\"", exe_str);
    let key = "HKCU\\Software\\Classes\\codext";

    // CREATE_NO_WINDOW (0x08000000) — prevents the flash of console windows
    let flag: u32 = 0x08000000;

    let _ = std::process::Command::new("reg")
        .args(["add", key, "/ve", "/d", "URL:codext Protocol", "/f"])
        .creation_flags(flag)
        .output();
    let _ = std::process::Command::new("reg")
        .args(["add", key, "/v", "URL Protocol", "/d", "", "/f"])
        .creation_flags(flag)
        .output();
    let _ = std::process::Command::new("reg")
        .args(["add", &format!("{}\\shell\\open\\command", key), "/ve", "/d", &command, "/f"])
        .creation_flags(flag)
        .output();
}

#[cfg(not(target_os = "windows"))]
fn register_deep_link_scheme() {}