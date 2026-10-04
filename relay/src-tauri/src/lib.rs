mod ai;
mod example;
pub fn example_server() {
    example::serve();
}
pub fn llama_watchdog(pid_file: &str, exe: &str, args: &[String]) -> ! {
    models::watchdog(pid_file, exe, args)
}
mod mcp;
mod models;
mod oauth;
mod store;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use tauri::Manager;
use tokio::sync::Mutex;

async fn connection(sessions: &mcp::Sessions, id: &str) -> Result<mcp::Connection, String> {
    sessions
        .0
        .lock()
        .await
        .get(id)
        .map(|s| s.conn.clone())
        .ok_or_else(|| "Connect this server first.".into())
}

#[derive(Default)]
struct Workspace(Mutex<store::Config>);
#[derive(Default)]
struct Requests(Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>);
/// Sign-ins waiting on the browser, by server id.
#[derive(Default)]
struct SignIns(Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>);

#[tauri::command]
async fn load_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, Workspace>,
) -> Result<Value, String> {
    let cfg = store::load(&app)?;
    *state.0.lock().await = cfg.clone();
    // Do not trigger Keychain prompts on startup. Credentials are read only when used or updated.
    Ok(json!(cfg))
}
#[tauri::command]
async fn save_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, Workspace>,
    sessions: tauri::State<'_, mcp::Sessions>,
    mut server: store::Server,
    secrets: BTreeMap<String, String>,
) -> Result<store::Server, String> {
    store::validate_server(&server)?;
    if server.id.is_empty() {
        server.id = uuid::Uuid::new_v4().to_string();
    }
    let mut saved = store::server_secrets(&server.id)?;
    for (k, v) in secrets {
        if !v.is_empty() {
            saved.insert(k, v);
        }
    }
    saved.retain(|k, _| {
        server.headers.iter().any(|n| k == &format!("header:{n}"))
            || server.env.iter().any(|n| k == &format!("env:{n}"))
    });
    if !saved.is_empty() {
        store::put_secret(
            &format!("server:{}", server.id),
            &serde_json::to_string(&saved).map_err(|e| e.to_string())?,
        )?;
    } else {
        store::put_secret(&format!("server:{}", server.id), "")?;
    }
    let mut cfg = state.0.lock().await;
    // A sign-in belongs to the address it was made for.
    if let Some(old) = cfg.servers.iter().find(|s| s.id == server.id) {
        if old.url != server.url || server.transport != "http" {
            oauth::sign_out(&server.id).await?;
        }
    }
    let mut next = cfg.clone();
    next.servers.retain(|s| s.id != server.id);
    next.servers.push(server.clone());
    store::save(&app, &next)?;
    *cfg = next;
    if let Some(c) = sessions.0.lock().await.remove(&server.id) {
        c.conn.cancellation_token().cancel();
    }
    Ok(server)
}
#[tauri::command]
async fn delete_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, Workspace>,
    sessions: tauri::State<'_, mcp::Sessions>,
    id: String,
) -> Result<(), String> {
    let mut cfg = state.0.lock().await;
    let mut next = cfg.clone();
    next.servers.retain(|s| s.id != id);
    next.tests.retain(|t| t.server_id != id);
    store::put_secret(&format!("server:{id}"), "")?;
    oauth::sign_out(&id).await?;
    store::save(&app, &next)?;
    *cfg = next;
    if let Some(c) = sessions.0.lock().await.remove(&id) {
        c.conn.cancellation_token().cancel();
    }
    Ok(())
}
#[tauri::command]
async fn connect_server(
    state: tauri::State<'_, Workspace>,
    sessions: tauri::State<'_, mcp::Sessions>,
    id: String,
) -> Result<Value, String> {
    let server = state
        .0
        .lock()
        .await
        .servers
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or("Server not found")?;
    let secrets = store::server_secrets(&id)?;
    if let Some(old) = sessions.0.lock().await.remove(&id) {
        old.conn.cancellation_token().cancel();
    }
    // Don't hold the sessions lock while connecting: other servers stay usable meanwhile.
    let result = async {
        let c = mcp::connect_with(&server, secrets.clone()).await?;
        let mut info =
            tokio::time::timeout(std::time::Duration::from_secs(30), mcp::inspect(&c.conn))
                .await
                .map_err(|_| "Tool discovery timed out")??;
        info["signedIn"] = json!(c.signed_in);
        if let Some(old) = sessions.0.lock().await.insert(id, c) {
            old.conn.cancellation_token().cancel();
        }
        Ok(info)
    }
    .await;
    result.map_err(|e: String| {
        secrets
            .values()
            .filter(|v| !v.is_empty())
            .fold(e, |e, s| e.replace(s, "[redacted]"))
    })
}
#[tauri::command]
async fn sign_in_server(
    state: tauri::State<'_, Workspace>,
    sign_ins: tauri::State<'_, SignIns>,
    id: String,
) -> Result<(), String> {
    let server = state
        .0
        .lock()
        .await
        .servers
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or("Server not found")?;
    if server.transport != "http" {
        return Err("Only HTTP servers sign in.".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Starting again replaces a sign-in left waiting in the browser.
    if let Some(old) = sign_ins.0.lock().await.insert(id.clone(), tx) {
        let _ = old.send(());
    }
    let result = oauth::sign_in(&server, rx).await;
    sign_ins.0.lock().await.remove(&id);
    result
}
#[tauri::command]
async fn cancel_sign_in(sign_ins: tauri::State<'_, SignIns>, id: String) -> Result<(), String> {
    if let Some(tx) = sign_ins.0.lock().await.remove(&id) {
        let _ = tx.send(());
    }
    Ok(())
}
#[tauri::command]
async fn sign_out_server(
    sessions: tauri::State<'_, mcp::Sessions>,
    id: String,
) -> Result<(), String> {
    oauth::sign_out(&id).await?;
    if let Some(c) = sessions.0.lock().await.remove(&id) {
        c.conn.cancellation_token().cancel();
    }
    Ok(())
}
#[tauri::command]
async fn disconnect_server(
    sessions: tauri::State<'_, mcp::Sessions>,
    id: String,
) -> Result<(), String> {
    if let Some(c) = sessions.0.lock().await.remove(&id) {
        c.conn.cancellation_token().cancel();
    }
    Ok(())
}
#[tauri::command]
async fn call_tool(
    sessions: tauri::State<'_, mcp::Sessions>,
    id: String,
    name: String,
    arguments: Value,
) -> Result<Value, String> {
    let c = connection(&sessions, &id).await?;
    let result = mcp::call(&c, name, arguments).await;
    if result.is_err() && c.is_closed() {
        sessions.0.lock().await.remove(&id);
        return Err(mcp::CLOSED.into());
    }
    result
}
#[tauri::command]
async fn server_catalog(
    sessions: tauri::State<'_, mcp::Sessions>,
    id: String,
    kind: String,
) -> Result<Value, String> {
    let c = connection(&sessions, &id).await?;
    // Asking a server for something it doesn't advertise is an error, not an empty list.
    let advertised = c
        .peer_info()
        .and_then(|i| serde_json::to_value(&i.capabilities).ok())
        .is_some_and(|caps| caps[kind.as_str()].is_object());
    if !advertised {
        return Ok(json!([]));
    }
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        match kind.as_str() {
            "resources" => {
                serde_json::to_value(c.list_all_resources().await.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            }
            "prompts" => {
                serde_json::to_value(c.list_all_prompts().await.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            }
            _ => Err("Unknown catalog".into()),
        }
    })
    .await
    .map_err(|_| "Discovery timed out")?
}
#[tauri::command]
async fn read_resource(
    sessions: tauri::State<'_, mcp::Sessions>,
    id: String,
    uri: String,
) -> Result<Value, String> {
    let c = connection(&sessions, &id).await?;
    let p = serde_json::from_value(json!({"uri":uri})).map_err(|e| e.to_string())?;
    let r = tokio::time::timeout(std::time::Duration::from_secs(30), c.read_resource(p))
        .await
        .map_err(|_| "Read timed out")?
        .map_err(|e| e.to_string())?;
    serde_json::to_value(r).map_err(|e| e.to_string())
}
#[tauri::command]
async fn get_prompt(
    sessions: tauri::State<'_, mcp::Sessions>,
    id: String,
    name: String,
    arguments: Value,
) -> Result<Value, String> {
    let c = connection(&sessions, &id).await?;
    let p = serde_json::from_value(json!({"name":name,"arguments":arguments}))
        .map_err(|e| e.to_string())?;
    let r = tokio::time::timeout(std::time::Duration::from_secs(30), c.get_prompt(p))
        .await
        .map_err(|_| "Prompt timed out")?
        .map_err(|e| e.to_string())?;
    serde_json::to_value(r).map_err(|e| e.to_string())
}
#[tauri::command]
async fn save_provider(
    app: tauri::AppHandle,
    state: tauri::State<'_, Workspace>,
    provider: store::Provider,
    key: Option<String>,
) -> Result<(), String> {
    if !["openai", "gemini", "claude", "local"].contains(&provider.id.as_str()) {
        return Err("Unknown provider".into());
    }
    if let Some(key) = key {
        store::put_secret(&format!("provider:{}", provider.id), key.trim())?;
    }
    let mut cfg = state.0.lock().await;
    let mut next = cfg.clone();
    next.providers.retain(|p| p.id != provider.id);
    next.providers.push(provider);
    store::save(&app, &next)?;
    *cfg = next;
    Ok(())
}
#[tauri::command]
async fn ai_step(
    app: tauri::AppHandle,
    state: tauri::State<'_, Workspace>,
    runtime: tauri::State<'_, models::Runtime>,
    requests: tauri::State<'_, Requests>,
    request_id: String,
    provider_id: String,
    history: Vec<Value>,
    input: String,
    results: Vec<ai::ToolOutput>,
    tools: Vec<ai::ToolDef>,
) -> Result<ai::Step, String> {
    let mut p = state
        .0
        .lock()
        .await
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .cloned()
        .ok_or("Set up this model first.")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    requests.0.lock().await.insert(request_id.clone(), tx);
    let operation = async {
        let local_token = if p.id == "local" {
            let (url, token) = models::start(&app, &runtime, &p.model).await?;
            p.base_url = url;
            Some(token)
        } else {
            None
        };
        ai::step(p, history, input, results, tools, local_token).await
    };
    let result = tokio::select! { r=operation=>r, _=rx=>Err("Generation cancelled.".into()) };
    requests.0.lock().await.remove(&request_id);
    result
}
#[tauri::command]
async fn cancel_request(requests: tauri::State<'_, Requests>, id: String) -> Result<(), String> {
    if let Some(tx) = requests.0.lock().await.remove(&id) {
        let _ = tx.send(());
    }
    Ok(())
}
#[tauri::command]
async fn save_test(
    app: tauri::AppHandle,
    state: tauri::State<'_, Workspace>,
    mut test: store::TestCase,
) -> Result<store::TestCase, String> {
    if !test.arguments.is_object() {
        return Err("Arguments must be an object".into());
    }
    if test.id.is_empty() {
        test.id = uuid::Uuid::new_v4().to_string();
    }
    let mut cfg = state.0.lock().await;
    let mut next = cfg.clone();
    next.tests.retain(|t| t.id != test.id);
    next.tests.push(test.clone());
    store::save(&app, &next)?;
    *cfg = next;
    Ok(test)
}
#[tauri::command]
async fn delete_test(
    app: tauri::AppHandle,
    state: tauri::State<'_, Workspace>,
    id: String,
) -> Result<(), String> {
    let mut cfg = state.0.lock().await;
    let mut next = cfg.clone();
    next.tests.retain(|t| t.id != id);
    store::save(&app, &next)?;
    *cfg = next;
    Ok(())
}

#[tauri::command]
async fn add_example(
    app: tauri::AppHandle,
    state: tauri::State<'_, Workspace>,
) -> Result<store::Server, String> {
    let server = store::Server {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Relay example".into(),
        transport: "stdio".into(),
        command: std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned(),
        args: vec!["--example-mcp".into()],
        ..Default::default()
    };
    let mut cfg = state.0.lock().await;
    let mut next = cfg.clone();
    next.servers.push(server.clone());
    store::save(&app, &next)?;
    *cfg = next;
    Ok(server)
}

#[tauri::command]
async fn server_log(
    sessions: tauri::State<'_, mcp::Sessions>,
    id: String,
) -> Result<String, String> {
    let log = sessions
        .0
        .lock()
        .await
        .get(&id)
        .map(|s| s.log.clone())
        .ok_or("Connect this server first.")?;
    let text = log.lock().unwrap().clone();
    Ok(text)
}

pub fn run() {
    // Look up the terminal's PATH now so the first stdio connection doesn't wait for it.
    std::thread::spawn(mcp::shell_path);
    tauri::Builder::default()
        .manage(Workspace::default())
        .manage(mcp::Sessions::default())
        .manage(models::Runtime::default())
        .manage(Requests::default())
        .manage(SignIns::default())
        .invoke_handler(tauri::generate_handler![
            add_example,
            load_workspace,
            save_server,
            delete_server,
            connect_server,
            disconnect_server,
            sign_in_server,
            cancel_sign_in,
            sign_out_server,
            call_tool,
            server_catalog,
            read_resource,
            get_prompt,
            save_provider,
            ai_step,
            cancel_request,
            save_test,
            delete_test,
            server_log,
            models::model_catalog,
            models::warm_model,
            models::download_model,
            models::cancel_download,
            models::stop_model,
            models::delete_model
        ])
        .setup(|app| {
            models::stop_leftover(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not build Relay")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                // The watchdog stops the model server once this pipe closes, and also if this
                // lock is busy now: the pipe closes anyway when the app exits.
                if let Ok(mut processes) = app.state::<models::Runtime>().process.try_lock() {
                    if let Some((_, _, child, _)) = processes.as_mut() {
                        drop(child.stdin.take());
                    }
                }
                if let Ok(connections) = app.state::<mcp::Sessions>().0.try_lock() {
                    for c in connections.values() {
                        c.conn.cancellation_token().cancel();
                    }
                }
            }
        });
}
