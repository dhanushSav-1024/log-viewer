use axum::{
    Router,
    extract::State,
    http::{Method, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post},
};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    env,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
};
use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub time: String,
    pub level: String,
    pub message: String,
    #[serde(default)]
    pub logger: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub lineno: String,
}
#[derive(Debug, Deserialize)]
pub struct IncomingLog {
    pub time: Option<String>,
    pub level: Option<String>,
    pub message: Option<String>,
    pub logger: Option<String>,
    pub filename: Option<String>,
    pub lineno: Option<serde_json::Value>, // accept int or string
}
#[derive(Serialize)]
pub struct LogsResponse {
    pub logs: Vec<LogEntry>,
    pub total: usize,
}
#[derive(Serialize)]
pub struct StatusResponse {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug)]
pub struct AppState {
    logs: Mutex<VecDeque<LogEntry>>,
    max_logs: usize,
}

impl AppState {
    pub fn new(max_logs: usize) -> Self {
        Self {
            logs: Mutex::new(VecDeque::with_capacity(max_logs)),
            max_logs,
        }
    }
    pub fn push(&self, entry: LogEntry) {
        let mut guard = self.logs.lock().expect("log mutex poisoned");
        if guard.len() >= self.max_logs {
            guard.pop_front();
        }
        guard.push_back(entry);
    }
    pub fn snapshot(&self) -> Vec<LogEntry> {
        let guard = self.logs.lock().expect("log mutex poisoned");
        guard.iter().cloned().collect()
    }
    pub fn clear(&self) {
        let mut guard = self.logs.lock().expect("log mutex poisoned");
        guard.clear();
    }
}

type SharedState = Arc<AppState>;
async fn handle_get_logs(State(state): State<SharedState>) -> impl IntoResponse {
    let logs = state.snapshot();
    let total = logs.len();
    Json(LogsResponse { logs, total })
}
async fn handle_post_log(
    State(state): State<SharedState>,
    body: axum::extract::Json<IncomingLog>,
) -> impl IntoResponse {
    let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let lineno = match &body.lineno {
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => String::new(),
    };

    let entry = LogEntry {
        time: body.time.clone().unwrap_or(now),
        level: body.level.clone().unwrap_or_else(|| "INFO".into()),
        message: body.message.clone().unwrap_or_default(),
        logger: body.logger.clone().unwrap_or_default(),
        filename: body.filename.clone().unwrap_or_default(),
        lineno,
    };

    state.push(entry);
    (
        StatusCode::OK,
        Json(StatusResponse {
            status: "success",
            message: None,
        }),
    )
}
async fn handle_clear(State(state): State<SharedState>) -> impl IntoResponse {
    state.clear();
    (
        StatusCode::OK,
        Json(StatusResponse {
            status: "success",
            message: None,
        }),
    )
}
async fn handle_not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(StatusResponse {
            status: "error",
            message: Some("not found".into()),
        }),
    )
}

fn build_router(state: SharedState, static_dir: PathBuf) -> Router {
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any)
        .allow_origin(Any);
    let api = Router::new()
        .route("/logs", get(handle_get_logs))
        .route("/log", post(handle_post_log))
        .route("/clear", post(handle_clear))
        .fallback(handle_not_found)
        .with_state(state);
    let static_service = ServeDir::new(&static_dir).append_index_html_on_directories(true);

    Router::new()
        .nest("/api", api)
        .fallback_service(static_service)
        .layer(cors)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();
    let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port: u16 = env::var("PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse()
        .expect("PORT must be a valid u16");
    let static_dir = PathBuf::from(env::var("STATIC_DIR").unwrap_or_else(|_| "./static".into()));
    let max_logs: usize = env::var("MAX_LOGS")
        .unwrap_or_else(|_| "1000".into())
        .parse()
        .expect("MAX_LOGS must be a positive integer");
    if !static_dir.exists() {
        warn!(
            "Static directory '{}' does not exist — create it and add index.html",
            static_dir.display()
        );
    }

    let state = Arc::new(AppState::new(max_logs));
    let router = build_router(state, static_dir.clone());

    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .expect("Invalid HOST:PORT combination");
    println!("{}", "=".repeat(60));
    println!("  STREAMWATCH — Log Viewer Server");
    println!("{}", "=".repeat(60));
    println!("  Listening on  http://{}", addr);
    println!("  Static files  {}", static_dir.display());
    println!("  Max log buffer  {} entries", max_logs);
    println!();
    println!("  POST logs to  http://{}/api/log", addr);
    println!("{}", "=".repeat(60));

    info!("Binding to {}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");

    axum::serve(listener, router).await.expect("Server error");
}
