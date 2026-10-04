//! Sign-in for HTTP servers that use MCP's OAuth: the browser signs in, a one-time local address
//! receives the answer, and the tokens (renewed automatically) live in the Keychain.
use crate::store::{self, Server};
use rmcp::transport::auth::{
    AuthError, AuthorizationCallback, AuthorizationManager, AuthorizationMetadata,
    AuthorizationRequest, AuthorizationSession, CredentialStore, StoredCredentials,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

/// Returned by connect when the server wants a sign-in; the UI offers one instead of an error.
pub const SIGN_IN_REQUIRED: &str = "SIGN_IN_REQUIRED";

/// What the Keychain holds per server. The metadata is kept so reconnecting and renewing tokens
/// don't depend on discovering the sign-in service again.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Saved {
    credentials: Option<StoredCredentials>,
    metadata: Option<AuthorizationMetadata>,
    #[serde(default)]
    client: Option<Registration>,
}
/// Relay's registration with a sign-in service, reused so signing in again doesn't register
/// again (services rate-limit that). Its return address includes the port, so that's kept too.
#[derive(Clone, Serialize, Deserialize)]
struct Registration {
    client_id: String,
    port: u16,
    authorization_endpoint: String,
}
fn account(id: &str) -> String {
    format!("oauth:{id}")
}
async fn read(id: &str) -> Result<Saved, String> {
    let account = account(id);
    let raw = tokio::task::spawn_blocking(move || store::secret(&account))
        .await
        .map_err(|e| e.to_string())??;
    if raw.is_empty() {
        return Ok(Saved::default());
    }
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}
async fn write(id: &str, saved: &Saved) -> Result<(), String> {
    let account = account(id);
    let raw = serde_json::to_string(saved).map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || store::put_secret(&account, &raw))
        .await
        .map_err(|e| e.to_string())?
}
pub async fn sign_out(id: &str) -> Result<(), String> {
    let account = account(id);
    tokio::task::spawn_blocking(move || store::put_secret(&account, ""))
        .await
        .map_err(|e| e.to_string())?
}

/// Tokens are read on every request to the server, so they're kept in memory after the first
/// Keychain read: macOS may ask for permission on each read.
struct Keychain {
    id: String,
    cache: tokio::sync::Mutex<Option<Saved>>,
}
impl Keychain {
    fn new(id: &str, saved: Option<Saved>) -> Self {
        Self {
            id: id.into(),
            cache: tokio::sync::Mutex::new(saved),
        }
    }
}
#[async_trait::async_trait]
impl CredentialStore for Keychain {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        let mut cache = self.cache.lock().await;
        if cache.is_none() {
            *cache = Some(
                read(&self.id)
                    .await
                    .map_err(AuthError::CredentialStoreError)?,
            );
        }
        Ok(cache.as_ref().and_then(|s| s.credentials.clone()))
    }
    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let mut cache = self.cache.lock().await;
        let mut saved = match cache.take() {
            Some(s) => s,
            None => read(&self.id)
                .await
                .map_err(AuthError::CredentialStoreError)?,
        };
        saved.credentials = Some(credentials);
        write(&self.id, &saved)
            .await
            .map_err(AuthError::CredentialStoreError)?;
        *cache = Some(saved);
        Ok(())
    }
    async fn clear(&self) -> Result<(), AuthError> {
        let mut cache = self.cache.lock().await;
        sign_out(&self.id)
            .await
            .map_err(AuthError::CredentialStoreError)?;
        *cache = Some(Saved::default());
        Ok(())
    }
}

/// The sign-in to send with requests, when this server has one saved.
pub async fn saved_sign_in(s: &Server) -> Result<Option<AuthorizationManager>, String> {
    let saved = read(&s.id).await?;
    let store = Keychain::new(&s.id, Some(saved.clone()));
    let (Some(credentials), Some(metadata)) = (saved.credentials, saved.metadata) else {
        return Ok(None);
    };
    if credentials.token_response.is_none() {
        return Ok(None);
    }
    let mut manager = AuthorizationManager::new(s.url.as_str())
        .await
        .map_err(|e| e.to_string())?;
    manager.set_metadata(metadata);
    manager.set_credential_store(store);
    Ok(manager
        .initialize_from_store()
        .await
        .map_err(|e| e.to_string())?
        .then_some(manager))
}

/// The server's `WWW-Authenticate` challenge, which says where its sign-in service is.
async fn challenge(url: &str) -> Result<Option<String>, String> {
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .json(&serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"Relay","version":env!("CARGO_PKG_VERSION")}}}))
        .send()
        .await
        .map_err(|e| format!("Could not reach the server: {e}"))?;
    Ok(response
        .headers()
        .get("www-authenticate")
        .and_then(|v| v.to_str().ok())
        .map(String::from))
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>Relay</title><body style=\"font:16px -apple-system,sans-serif;padding:48px;color:#333\">";

/// Waits for the browser to come back to the local address, and returns the URL it opened.
async fn callback(v4: TcpListener, v6: Option<TcpListener>) -> Result<String, String> {
    loop {
        let accepted = match &v6 {
            Some(v6) => tokio::select! { r = v4.accept() => r, r = v6.accept() => r },
            None => v4.accept().await,
        };
        let (mut stream, _) = accepted.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let mut len = 0;
        while len < buf.len() {
            match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf[len..])).await {
                Ok(Ok(n @ 1..)) => len += n,
                _ => break,
            }
            if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let request = String::from_utf8_lossy(&buf[..len]);
        let path = request.split_whitespace().nth(1).unwrap_or_default();
        if !path.starts_with("/callback") {
            let _ = stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        }
        let url = format!("http://localhost{path}");
        let error = reqwest::Url::parse(&url).ok().and_then(|u| {
            let get = |k: &str| {
                u.query_pairs()
                    .find(|(n, _)| n == k)
                    .map(|(_, v)| v.into_owned())
            };
            get("error").map(|e| get("error_description").unwrap_or(e))
        });
        let body = match &error {
            Some(e) => format!(
                "{PAGE}<h2>Sign-in didn't finish</h2><p>{}</p>",
                e.replace('<', "&lt;")
            ),
            None => format!(
                "{PAGE}<h2>Signed in</h2><p>You can close this tab and go back to Relay.</p>"
            ),
        };
        let _ = stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await;
        return match error {
            Some(e) => Err(format!("Sign-in didn't finish: {e}")),
            None => Ok(url),
        };
    }
}

/// Opens the server's sign-in page in the browser and saves the tokens once it comes back.
pub async fn sign_in(s: &Server, cancel: oneshot::Receiver<()>) -> Result<(), String> {
    let failed = |e: AuthError| {
        let e = e.to_string();
        if e.contains("429") {
            "The server's sign-in service is turning away new sign-ins from your network for now. Wait a few minutes, then try again.".into()
        } else {
            format!("Sign-in failed: {e}")
        }
    };
    let challenge = challenge(&s.url).await?;
    let mut manager = AuthorizationManager::new(s.url.as_str())
        .await
        .map_err(failed)?;
    manager.set_credential_store(Keychain::new(&s.id, None));
    let metadata = manager
        .resolve_metadata_from_challenge(challenge.as_deref())
        .await
        .map_err(failed)?
        .metadata;
    manager.set_metadata(metadata.clone());
    // "localhost", not 127.0.0.1: some sign-in services (Clappia) accept only that name. The
    // browser may resolve it to either address, so listen on both.
    let saved_client = read(&s.id)
        .await?
        .client
        .filter(|c| c.authorization_endpoint == metadata.authorization_endpoint);
    let reused = match &saved_client {
        Some(c) => TcpListener::bind(("127.0.0.1", c.port)).await.ok(),
        None => None,
    };
    let (v4, client) = match reused {
        Some(v4) => (v4, saved_client),
        None => (
            TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|e| e.to_string())?,
            None,
        ),
    };
    let port = v4.local_addr().map_err(|e| e.to_string())?.port();
    let v6 = TcpListener::bind(("::1", port)).await.ok();
    let redirect = format!("http://localhost:{port}/callback");
    let mut request = AuthorizationRequest::new(&redirect).with_client_name("Relay");
    if let Some(c) = &client {
        request = request.with_preregistered_client(&c.client_id);
    }
    if let Some(c) = challenge {
        request = request.with_challenge(c);
    }
    let session = AuthorizationSession::new(manager, request)
        .await
        .map_err(|(_, e)| failed(e))?;
    if client.is_none() {
        let client_id = session.get_credentials().await.map_err(failed)?.0;
        let mut saved = read(&s.id).await?;
        saved.client = Some(Registration {
            client_id,
            port,
            authorization_endpoint: metadata.authorization_endpoint.clone(),
        });
        write(&s.id, &saved).await?;
    }
    let auth_url = session.get_authorization_url();
    if !auth_url.starts_with("https://") && !auth_url.starts_with("http://") {
        return Err("The server's sign-in page isn't a web address.".into());
    }
    std::process::Command::new("open")
        .arg(auth_url)
        .status()
        .map_err(|e| format!("Could not open the browser: {e}"))?;
    let url = tokio::select! {
        r = tokio::time::timeout(Duration::from_secs(300), callback(v4, v6)) => {
            r.map_err(|_| "Sign-in timed out. Try again.".to_string())?
        }
        _ = cancel => return Err("Sign-in cancelled.".into()),
    };
    let finished = async {
        let cb = AuthorizationCallback::from_redirect_url(&url?).map_err(failed)?;
        session
            .handle_callback_with_issuer(&cb.code, &cb.csrf_token, cb.issuer.as_deref())
            .await
            .map_err(failed)
    }
    .await;
    if let Err(e) = finished {
        // The service may have dropped the registration; register afresh next time.
        let mut saved = read(&s.id).await?;
        saved.client = None;
        write(&s.id, &saved).await?;
        return Err(e);
    }
    let mut saved = read(&s.id).await?;
    saved.metadata = Some(metadata);
    write(&s.id, &saved).await
}
