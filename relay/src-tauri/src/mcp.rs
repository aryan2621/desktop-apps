use crate::{
    oauth,
    store::{self, Server},
};
use rmcp::{
    service::RunningService,
    transport::{
        auth::AuthClient, streamable_http_client::StreamableHttpClientTransportConfig,
        StreamableHttpClientTransport, TokioChildProcess,
    },
    RoleClient, ServiceExt,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{ChildStderr, Command},
    sync::Mutex,
};

pub const CLOSED: &str = "The server's connection closed. Reconnect it from Servers.";
pub type Connection = Arc<RunningService<RoleClient, ()>>;
/// The tail of a stdio server's stderr; always empty for HTTP servers.
pub type Log = Arc<std::sync::Mutex<String>>;
#[derive(Clone)]
pub struct Session {
    pub conn: Connection,
    pub log: Log,
    /// Connected with a saved sign-in, which Sign out removes.
    pub signed_in: bool,
}
#[derive(Default)]
pub struct Sessions(pub Mutex<HashMap<String, Session>>);

/// The PATH a terminal would have. Apps opened from Finder get only /usr/bin:/bin, so servers
/// launched with npx, uvx, node or anything from Homebrew/nvm would not be found without this.
pub fn shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = std::process::Command::new(shell);
        cmd.args(["-ilc", "printf '__RELAY_PATH__%s__RELAY_PATH__' \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(cmd.output());
        });
        let from_shell = rx
            .recv_timeout(Duration::from_secs(5))
            .ok()
            .and_then(|o| o.ok())
            .and_then(|o| {
                let out = String::from_utf8_lossy(&o.stdout).into_owned();
                out.split("__RELAY_PATH__").nth(1).map(str::to_owned)
            })
            .unwrap_or_default();
        let current = std::env::var("PATH").unwrap_or_default();
        let fallback = [
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".into(),
            format!("{home}/.local/bin"),
            format!("{home}/.cargo/bin"),
            format!("{home}/.bun/bin"),
        ];
        let mut dirs: Vec<String> = vec![];
        for d in from_shell
            .split(':')
            .chain(current.split(':'))
            .map(str::to_owned)
            .chain(fallback)
        {
            if !d.is_empty() && !dirs.contains(&d) {
                dirs.push(d);
            }
        }
        dirs.join(":")
    })
}

/// Keeps the last few KB of a server's stderr so startup failures can say what went wrong.
fn collect_stderr(stderr: Option<ChildStderr>) -> Log {
    let log = Arc::new(std::sync::Mutex::new(String::new()));
    if let Some(mut stderr) = stderr {
        let log = log.clone();
        // Keep reading for the whole session: a full stderr pipe would block the server.
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n @ 1..) = stderr.read(&mut buf).await {
                let mut l = log.lock().unwrap();
                l.push_str(&String::from_utf8_lossy(&buf[..n]));
                if l.len() > 4000 {
                    let mut cut = l.len() - 4000;
                    while !l.is_char_boundary(cut) {
                        cut += 1;
                    }
                    l.drain(..cut);
                }
            }
        });
    }
    log
}

pub async fn connect_with(
    s: &Server,
    secrets: BTreeMap<String, String>,
) -> Result<Session, String> {
    store::validate_server(s)?;
    let signed_in;
    let connection = if s.transport == "stdio" {
        // The example server is this app itself; resolve it now so it survives the app moving.
        let program = if s.args == ["--example-mcp"] {
            std::env::current_exe().map_err(|e| e.to_string())?
        } else {
            s.command.trim().into()
        };
        let path = tokio::task::spawn_blocking(shell_path)
            .await
            .map_err(|e| e.to_string())?;
        let mut command = Command::new(&program);
        command.args(&s.args).env("PATH", path).kill_on_drop(true);
        if !s.cwd.is_empty() {
            command.current_dir(&s.cwd);
        }
        for name in &s.env {
            if let Some(v) = secrets.get(&format!("env:{name}")) {
                command.env(name, v);
            }
        }
        let (transport, stderr) = TokioChildProcess::builder(command)
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound if !s.cwd.is_empty() && !std::path::Path::new(&s.cwd).is_dir() => {
                    format!("Working directory {} does not exist.", s.cwd)
                }
                std::io::ErrorKind::NotFound => format!(
                    "Could not find \"{}\". Check the name, or use its full path (run `which {}` in Terminal).",
                    program.display(),
                    program.display()
                ),
                std::io::ErrorKind::PermissionDenied => {
                    format!("\"{}\" is not executable.", program.display())
                }
                _ => format!("Could not start server: {e}"),
            })?;
        let log = collect_stderr(stderr);
        let started = tokio::time::timeout(Duration::from_secs(60), ().serve(transport)).await;
        let failure = match started {
            Ok(Ok(c)) => {
                return Ok(Session {
                    conn: Arc::new(c),
                    log,
                    signed_in: false,
                })
            }
            Ok(Err(e)) => format!("The server stopped before it finished starting ({e})."),
            Err(_) => "The server did not answer within 60 seconds.".into(),
        };
        // Give the dying process a moment to flush its error output.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let output = log.lock().unwrap().trim().to_string();
        return Err(if output.is_empty() {
            format!("{failure} It printed nothing; check that this command runs an MCP server over stdio.")
        } else {
            format!("{failure} Its output:\n{output}")
        });
    } else {
        let mut headers = HashMap::new();
        for name in &s.headers {
            if let Some(value) = secrets.get(&format!("header:{name}")) {
                headers.insert(
                    reqwest::header::HeaderName::from_bytes(name.as_bytes())
                        .map_err(|_| "Invalid header name")?,
                    reqwest::header::HeaderValue::from_str(value)
                        .map_err(|_| "Invalid header value")?,
                );
            }
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        let has_auth_header = headers.contains_key(&reqwest::header::AUTHORIZATION);
        let config = StreamableHttpClientTransportConfig::with_uri(s.url.clone())
            .custom_headers(headers)
            .reinit_on_expired_session(false);
        let sign_in = oauth::saved_sign_in(s).await?;
        signed_in = sign_in.is_some();
        let started = match sign_in {
            Some(auth) => {
                let transport = StreamableHttpClientTransport::with_client(
                    AuthClient::new(client, auth),
                    config,
                );
                tokio::time::timeout(Duration::from_secs(30), ().serve(transport)).await
            }
            None => {
                let transport = StreamableHttpClientTransport::with_client(client, config);
                tokio::time::timeout(Duration::from_secs(30), ().serve(transport)).await
            }
        };
        match started.map_err(|_| "Connection timed out.")? {
            Ok(c) => c,
            Err(e) if e.auth_challenge().is_some() && !has_auth_header => {
                return Err(oauth::SIGN_IN_REQUIRED.into())
            }
            Err(e) if e.auth_challenge().is_some() => {
                return Err("The server rejected the Authorization header (401). Check its value, or remove it to sign in instead.".into())
            }
            Err(e) => return Err(format!("Connection failed: {e}.")),
        }
    };
    Ok(Session {
        conn: Arc::new(connection),
        log: Log::default(),
        signed_in,
    })
}

pub async fn inspect(c: &Connection) -> Result<Value, String> {
    let info = c.peer_info();
    let caps = serde_json::to_value(&info).unwrap_or_default();
    let tools = if caps["capabilities"]["tools"].is_object() {
        serde_json::to_value(c.list_all_tools().await.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        json!([])
    };
    Ok(json!({"info": info, "tools": tools}))
}
pub async fn call(c: &Connection, name: String, arguments: Value) -> Result<Value, String> {
    if !arguments.is_object() {
        return Err("Tool arguments must be a JSON object.".into());
    }
    let params = serde_json::from_value(json!({"name":name,"arguments":arguments}))
        .map_err(|e| format!("Invalid call: {e}"))?;
    let result = tokio::time::timeout(Duration::from_secs(90), c.call_tool(params)).await.map_err(|_| "Tool call timed out. Its server-side effects may still have occurred; inspect before retrying.")?.map_err(|e| e.to_string())?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}
