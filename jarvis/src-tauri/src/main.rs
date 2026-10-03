fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "--ask" {
        if let Err(e) = jarvis_lib::cli_ask(&args[2..].join(" ")) {
            eprintln!("error: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    jarvis_lib::run();
}
