//! Google sign-in (only when the user uploads) and uploads to YouTube and Google Drive.
//!
//! Sign-in follows Google's flow for desktop apps: the system browser opens Google's consent
//! page, Google redirects back to a one-off server on 127.0.0.1, and the code is exchanged using
//! PKCE. The refresh token lives in the macOS Keychain; access tokens only in memory. Uploads use
//! Google's resumable protocol, streaming the exported file from disk in chunks.
//!
//! The OAuth client comes from the user's own Google Cloud project (a "Desktop app" client), so
//! no shared secret ships with Capturita. Its Client ID and Client Secret are entered in Settings
//! and kept in the Keychain next to the refresh token.

use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, LOCATION, RANGE};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const YOUTUBE_SCOPE: &str = "https://www.googleapis.com/auth/youtube.upload";
const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const IDENTITY_SCOPES: [&str; 2] = ["openid", "email"];
const KEYCHAIN_SERVICE: &str = "com.capturita.app.google";
const KEYCHAIN_ACCOUNT: &str = "refresh-token";
const KEYCHAIN_CLIENT: &str = "oauth-client";
/// Where the client used to be configured; imported into the Keychain once, then removed.
const LEGACY_CLIENT_FILE: &str = "google-client.json";
const ACCOUNT_FILE: &str = "google-account.json";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Resumable uploads need chunks in multiples of 256 KiB.
const CHUNK: u64 = 32 * 256 * 1024;
const MAX_RETRIES: u32 = 4;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Destination {
    Youtube,
    Drive,
}

impl Destination {
    fn scope(self) -> &'static str {
        match self {
            Destination::Youtube => YOUTUBE_SCOPE,
            Destination::Drive => DRIVE_SCOPE,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct ClientConfig {
    client_id: String,
    client_secret: String,
}

/// Accepts both the file Google's console downloads (`{"installed": {...}}`) and a flat object.
#[derive(Deserialize)]
struct ClientFile {
    installed: Option<ClientConfig>,
    #[serde(flatten)]
    flat: Option<ClientConfig>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    email: String,
    scopes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    configured: bool,
    /// The start and end of the Client ID, to recognise which one is saved.
    client_id_preview: String,
    account: Option<Account>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
    scope: Option<String>,
    id_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    destination: Destination,
    path: String,
    title: String,
    description: String,
    /// YouTube only: "private", "unlisted" or "public".
    privacy: Option<String>,
}

#[derive(Serialize)]
pub struct UploadResult {
    id: String,
    url: String,
}

#[derive(Default)]
pub struct Google {
    access: Mutex<Option<(String, Instant)>>,
    cancel: AtomicBool,
    http: reqwest::Client,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn client_config(app: &AppHandle) -> Result<ClientConfig, String> {
    if let Ok(bytes) = security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_CLIENT) {
        return serde_json::from_slice(&bytes).map_err(|e| format!("The saved Google client isn't valid: {e}"));
    }
    import_legacy_client(app).ok_or_else(|| "Add your Google Client ID and Client Secret in Settings → Google first.".into())
}

/// Moves a client from the old google-client.json into the Keychain, so the secret isn't left in a file.
fn import_legacy_client(app: &AppHandle) -> Option<ClientConfig> {
    let path = config_dir(app).ok()?.join(LEGACY_CLIENT_FILE);
    let file: ClientFile = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    let client = file.installed.or(file.flat)?;
    save_client(&client).ok()?;
    let _ = std::fs::remove_file(path);
    Some(client)
}

fn save_client(client: &ClientConfig) -> Result<(), String> {
    let bytes = serde_json::to_vec(client).map_err(|e| e.to_string())?;
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_CLIENT, &bytes).map_err(|e| format!("Couldn't save to the Keychain: {e}"))
}

fn preview(client_id: &str) -> String {
    let id = client_id.trim_end_matches(".apps.googleusercontent.com");
    if id.len() <= 12 {
        return id.to_string();
    }
    format!("{}…{}", &id[..6], &id[id.len() - 4..])
}

fn load_account(app: &AppHandle) -> Option<Account> {
    let text = std::fs::read_to_string(config_dir(app).ok()?.join(ACCOUNT_FILE)).ok()?;
    let account: Account = serde_json::from_str(&text).ok()?;
    // The account file is only meaningful while its refresh token is still in the Keychain.
    security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()?;
    Some(account)
}

fn save_account(app: &AppHandle, account: &Account) -> Result<(), String> {
    let text = serde_json::to_string_pretty(account).map_err(|e| e.to_string())?;
    std::fs::write(config_dir(app)?.join(ACCOUNT_FILE), text).map_err(|e| e.to_string())
}

fn forget_account(app: &AppHandle, google: &Google) {
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if let Ok(dir) = config_dir(app) {
        let _ = std::fs::remove_file(dir.join(ACCOUNT_FILE));
    }
    *google.access.lock().unwrap() = None;
}

/// URL-safe random string from the OS's secure random source.
fn random_token(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buffer))
        .map_err(|e| format!("No secure random source: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

/// The email from Google's ID token (received straight from Google over TLS, so not re-verified).
fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()?;
    claims.get("email")?.as_str().map(str::to_string)
}

impl Google {
    async fn access_token(&self, app: &AppHandle) -> Result<String, String> {
        if let Some((token, expires)) = self.access.lock().unwrap().clone() {
            if Instant::now() + Duration::from_secs(60) < expires {
                return Ok(token);
            }
        }
        let client = client_config(app)?;
        let refresh = security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .map_err(|_| "Sign in with Google first".to_string())?;
        let refresh = String::from_utf8(refresh).map_err(|e| e.to_string())?;
        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("client_id", client.client_id.as_str()),
                ("client_secret", client.client_secret.as_str()),
                ("refresh_token", refresh.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
            .map_err(|e| format!("Couldn't reach Google: {e}"))?;
        if response.status() == StatusCode::BAD_REQUEST || response.status() == StatusCode::UNAUTHORIZED {
            // The user revoked access, or the token expired: Google ends sign-ins after 7 days
            // while a project is in Testing.
            forget_account(app, self);
            return Err("Google signed you out. Upload again to sign back in. If this happens every week, publish your Google project (Settings → Google, step 4).".into());
        }
        let token: TokenResponse = response.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        *self.access.lock().unwrap() = Some((token.access_token.clone(), Instant::now() + Duration::from_secs(token.expires_in)));
        Ok(token.access_token)
    }

    async fn sign_in(&self, app: &AppHandle, destination: Destination) -> Result<Account, String> {
        let client = client_config(app)?;
        let previous = load_account(app).unwrap_or_default();
        let mut scopes: Vec<String> = IDENTITY_SCOPES.iter().map(|s| s.to_string()).collect();
        for scope in previous.scopes.iter().map(String::as_str).chain([destination.scope()]) {
            if !scopes.iter().any(|s| s == scope) {
                scopes.push(scope.to_string());
            }
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());
        let verifier = random_token(48)?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random_token(16)?;
        let url = Url::parse_with_params(
            AUTH_URL,
            &[
                ("client_id", client.client_id.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("response_type", "code"),
                ("scope", scopes.join(" ").as_str()),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
                ("state", state.as_str()),
                ("access_type", "offline"),
                ("prompt", "consent"),
                ("include_granted_scopes", "true"),
            ],
        )
        .map_err(|e| e.to_string())?;
        app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;

        let code = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_code(listener, &state))
            .await
            .map_err(|_| "Google sign-in timed out. Try again.".to_string())??;

        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("client_id", client.client_id.as_str()),
                ("client_secret", client.client_secret.as_str()),
                ("code", code.as_str()),
                ("code_verifier", verifier.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|e| format!("Couldn't reach Google: {e}"))?;
        if !response.status().is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(sign_in_error(&body));
        }
        let token: TokenResponse = response.json().await.map_err(|e| e.to_string())?;
        if let Some(refresh) = &token.refresh_token {
            security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, refresh.as_bytes())
                .map_err(|e| format!("Couldn't save the sign-in to the Keychain: {e}"))?;
        }
        *self.access.lock().unwrap() = Some((token.access_token.clone(), Instant::now() + Duration::from_secs(token.expires_in)));

        let granted: Vec<String> = token.scope.as_deref().unwrap_or_default().split_whitespace().map(str::to_string).collect();
        if !granted.iter().any(|s| s == destination.scope()) {
            return Err("Capturita needs the upload permission. Sign in again and keep the upload box ticked.".into());
        }
        let account = Account {
            email: token.id_token.as_deref().and_then(email_from_id_token).unwrap_or(previous.email),
            scopes: granted,
        };
        save_account(app, &account)?;
        Ok(account)
    }

    async fn upload(&self, app: &AppHandle, request: UploadRequest) -> Result<UploadResult, String> {
        self.cancel.store(false, Ordering::SeqCst);
        let size = tokio::fs::metadata(&request.path).await.map_err(|e| e.to_string())?.len();
        if size == 0 {
            return Err("The exported file is empty".into());
        }

        let (start_url, metadata) = match request.destination {
            Destination::Youtube => (
                "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
                json!({
                    "snippet": { "title": request.title, "description": request.description, "categoryId": "28" },
                    "status": { "privacyStatus": request.privacy.as_deref().unwrap_or("private"), "selfDeclaredMadeForKids": false },
                }),
            ),
            Destination::Drive => (
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink",
                json!({ "name": format!("{}.mp4", request.title), "mimeType": "video/mp4", "description": request.description }),
            ),
        };
        let response = self
            .http
            .post(start_url)
            .bearer_auth(self.access_token(app).await?)
            .header("X-Upload-Content-Type", "video/mp4")
            .header("X-Upload-Content-Length", size)
            .json(&metadata)
            .send()
            .await
            .map_err(|e| format!("Couldn't reach Google: {e}"))?;
        if !response.status().is_success() {
            return Err(google_error(response).await);
        }
        let session = response
            .headers()
            .get(LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or("Google didn't start the upload")?
            .to_string();

        let mut file = tokio::fs::File::open(&request.path).await.map_err(|e| e.to_string())?;
        let mut offset = 0u64;
        let mut retries = 0;
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                let _ = self.http.delete(&session).send().await;
                return Err("Upload cancelled".into());
            }
            let length = CHUNK.min(size - offset);
            let mut chunk = vec![0u8; length as usize];
            file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
            file.read_exact(&mut chunk).await.map_err(|e| e.to_string())?;

            let sent = self
                .http
                .put(&session)
                .bearer_auth(self.access_token(app).await?)
                .header(CONTENT_LENGTH, length)
                .header(CONTENT_RANGE, format!("bytes {}-{}/{}", offset, offset + length - 1, size))
                .body(chunk)
                .send()
                .await;

            let response = match sent {
                Ok(response) => response,
                Err(error) => {
                    // Network trouble: ask Google how much it has, then carry on from there.
                    retries += 1;
                    if retries > MAX_RETRIES {
                        return Err(format!("Upload failed: {error}"));
                    }
                    tokio::time::sleep(Duration::from_secs(2u64.pow(retries))).await;
                    offset = self.received(&session, size).await.unwrap_or(offset);
                    continue;
                }
            };

            match response.status().as_u16() {
                200 | 201 => {
                    let body: Value = response.json().await.map_err(|e| e.to_string())?;
                    let id = body.get("id").and_then(Value::as_str).ok_or("Google didn't return the uploaded file")?.to_string();
                    let _ = app.emit("upload-progress", json!({ "sent": size, "total": size }));
                    let url = match request.destination {
                        Destination::Youtube => format!("https://youtu.be/{id}"),
                        Destination::Drive => body
                            .get("webViewLink")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("https://drive.google.com/file/d/{id}/view")),
                    };
                    return Ok(UploadResult { id, url });
                }
                308 => {
                    retries = 0;
                    offset = next_offset(response.headers().get(RANGE));
                    let _ = app.emit("upload-progress", json!({ "sent": offset, "total": size }));
                }
                401 => {
                    // Access token expired mid-upload: refresh and resend this chunk.
                    *self.access.lock().unwrap() = None;
                    retries += 1;
                    if retries > MAX_RETRIES {
                        return Err(google_error(response).await);
                    }
                }
                500..=599 => {
                    retries += 1;
                    if retries > MAX_RETRIES {
                        return Err(google_error(response).await);
                    }
                    tokio::time::sleep(Duration::from_secs(2u64.pow(retries))).await;
                    offset = self.received(&session, size).await.unwrap_or(offset);
                }
                _ => return Err(google_error(response).await),
            }
        }
    }

    /// How many bytes Google has stored for an interrupted upload.
    async fn received(&self, session: &str, size: u64) -> Option<u64> {
        let response = self
            .http
            .put(session)
            .header(CONTENT_LENGTH, 0)
            .header(CONTENT_RANGE, format!("bytes */{size}"))
            .send()
            .await
            .ok()?;
        (response.status().as_u16() == 308).then(|| next_offset(response.headers().get(RANGE)))
    }
}

/// The byte after the last one Google has, from a `Range: bytes=0-N` header (none means 0).
fn next_offset(range: Option<&reqwest::header::HeaderValue>) -> u64 {
    range
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit('-').next())
        .and_then(|n| n.parse::<u64>().ok())
        .map_or(0, |last| last + 1)
}

async fn google_error(response: reqwest::Response) -> String {
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let message = body
        .pointer("/error/message")
        .or_else(|| body.pointer("/error_description"))
        .and_then(Value::as_str)
        .unwrap_or("unknown error");
    let text = body.to_string();
    // The mistakes people make while setting up their Google project, in words they can act on.
    if text.contains("SERVICE_DISABLED") || text.contains("accessNotConfigured") {
        let api = if message.contains("Drive") { "Google Drive API" } else { "YouTube Data API v3" };
        return format!("The {api} isn't turned on in your Google project. Turn it on (Settings → Google, step 2), wait a minute, and try again.");
    }
    if text.contains("youtubeSignupRequired") {
        return "This Google account has no YouTube channel yet. Create one at youtube.com, then upload again.".into();
    }
    if text.contains("quotaExceeded") || text.contains("uploadLimitExceeded") {
        return "Google's daily upload limit for your project is used up. Try again tomorrow, or upload the MP4 in YouTube Studio.".into();
    }
    format!("Google returned {status}: {message}")
}

/// Explains a failed sign-in code exchange (wrong secret, deleted client).
fn sign_in_error(body: &str) -> String {
    if body.contains("invalid_client") || body.contains("unauthorized_client") {
        return "Google didn't accept your Client ID and Client Secret. Check they're from the same Desktop app client, and save them again in Settings → Google.".into();
    }
    format!("Google sign-in failed: {body}")
}

/// Waits for Google's redirect to the loopback server and returns the authorization code.
async fn wait_for_code(listener: tokio::net::TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buffer = vec![0u8; 16 * 1024];
        let read = stream.read(&mut buffer).await.map_err(|e| e.to_string())?;
        let request = String::from_utf8_lossy(&buffer[..read]);
        let path = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("/");
        let Ok(url) = Url::parse(&format!("http://127.0.0.1{path}")) else { continue };
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        // Browsers also ask for /favicon.ico; ignore anything that isn't the redirect.
        if !params.contains_key("code") && !params.contains_key("error") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let (title, result) = if let Some(error) = params.get("error") {
            ("Sign-in cancelled", Err(if error == "access_denied" { "Google sign-in was cancelled".to_string() } else { format!("Google sign-in failed: {error}") }))
        } else if params.get("state").map(String::as_str) != Some(state) {
            ("Sign-in failed", Err("Google sign-in failed a security check. Try again.".to_string()))
        } else {
            ("Signed in", Ok(params["code"].clone()))
        };
        let page = format!(
            "<!doctype html><meta charset=utf-8><title>Capturita</title><body style=\"font-family:-apple-system,sans-serif;background:#0b0b0f;color:#ececf1;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h2>{title}</h2><p style=\"color:#9a9aab\">You can close this tab and go back to Capturita.</p></div></body>"
        );
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len());
        let _ = stream.write_all(response.as_bytes()).await;
        return result;
    }
}

#[tauri::command]
pub fn google_status(app: AppHandle) -> Result<GoogleStatus, String> {
    let client = client_config(&app).ok();
    Ok(GoogleStatus {
        configured: client.is_some(),
        client_id_preview: client.map(|c| preview(&c.client_id)).unwrap_or_default(),
        account: load_account(&app),
    })
}

/// Saves the user's own OAuth client. A different client signs out: its tokens belong to the old one.
#[tauri::command]
pub async fn google_save_client(app: AppHandle, google: State<'_, Google>, client_id: String, client_secret: String) -> Result<(), String> {
    let client = ClientConfig { client_id: client_id.trim().to_string(), client_secret: client_secret.trim().to_string() };
    if !client.client_id.ends_with(".apps.googleusercontent.com") {
        return Err("That doesn't look like a Google Client ID (it ends in .apps.googleusercontent.com).".into());
    }
    if client.client_secret.is_empty() {
        return Err("Enter the Client Secret too.".into());
    }
    if client_config(&app).is_ok_and(|old| old.client_id != client.client_id) {
        forget_account(&app, &google);
    }
    save_client(&client)
}

/// Removes the OAuth client, and with it the Google sign-in.
#[tauri::command]
pub async fn google_remove_client(app: AppHandle, google: State<'_, Google>) -> Result<(), String> {
    forget_account(&app, &google);
    let _ = std::fs::remove_file(config_dir(&app)?.join(LEGACY_CLIENT_FILE));
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_CLIENT);
    Ok(())
}

#[tauri::command]
pub async fn google_sign_in(app: AppHandle, google: State<'_, Google>, destination: Destination) -> Result<Account, String> {
    google.sign_in(&app, destination).await
}

#[tauri::command]
pub async fn google_sign_out(app: AppHandle, google: State<'_, Google>) -> Result<(), String> {
    if let Ok(refresh) = security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        // Also revoke on Google's side so the app loses access, not just this Mac.
        let _ = google.http.post(REVOKE_URL).form(&[("token", String::from_utf8_lossy(&refresh).as_ref())]).send().await;
    }
    forget_account(&app, &google);
    Ok(())
}

#[tauri::command]
pub async fn google_upload(app: AppHandle, google: State<'_, Google>, request: UploadRequest) -> Result<UploadResult, String> {
    let account = load_account(&app).ok_or("Sign in with Google first")?;
    if !account.scopes.iter().any(|s| s == request.destination.scope()) {
        return Err("Sign in with Google first".into());
    }
    google.upload(&app, request).await
}

#[tauri::command]
pub fn google_cancel_upload(google: State<'_, Google>) {
    google.cancel.store(true, Ordering::SeqCst);
}
