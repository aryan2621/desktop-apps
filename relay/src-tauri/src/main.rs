#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let [_, flag, pid_file, exe, rest @ ..] = args.as_slice() {
        if flag == "--llama-watchdog" {
            relay_lib::llama_watchdog(pid_file, exe, rest);
        }
    }
    if args.iter().any(|a| a == "--example-mcp") {
        relay_lib::example_server();
    } else {
        relay_lib::run();
    }
}
