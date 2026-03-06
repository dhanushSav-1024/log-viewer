use std::{net::SocketAddr, sync::Arc};

use chrono::Local;
use clap::Parser;
use log_view::{AppState, IncomingLog, LogEntry, LogsResponse, StatusResponse};
use rust_embed::RustEmbed;

use axum::{
    Router,
    extract::State,
    http::{Method, StatusCode, Uri, header},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[derive(RustEmbed)]
#[folder = "static/"]
struct StaticAssets;
async fn serve_static(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match StaticAssets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string();
            (StatusCode::OK, [(header::CONTENT_TYPE, mime)], file.data).into_response()
        }
        None => match StaticAssets::get("index.html") {
            Some(file) => (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8".to_string())],
                file.data,
            )
                .into_response(),
            None => (StatusCode::NOT_FOUND, "404 — not found").into_response(),
        },
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

fn build_router(state: SharedState) -> Router {
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

    Router::new()
        .nest("/api", api)
        .fallback(serve_static) // all other paths → embedded static/
        .layer(cors)
}

#[derive(Parser, Debug)]
#[command(
    name = "streamwatch",
    about = "StreamWatch — Log Viewer Server",
    version
)]
struct Cli {
    #[arg(short = 'i', long = "ip", default_value = "0.0.0.0")]
    host: String,
    #[arg(short = 'p', long = "port", default_value_t = 8080)]
    port: u16,
    #[arg(short = 'm', long = "max-logs", default_value_t = 1000)]
    max_logs: usize,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cli = Cli::parse();

    let state = Arc::new(AppState::new(cli.max_logs));
    let router = build_router(state);

    let addr: SocketAddr = format!("{}:{}", cli.host, cli.port)
        .parse()
        .expect("Invalid --ip / --port combination");

    println!("{}", "=".repeat(60));
    println!("  STREAMWATCH — Log Viewer Server");
    println!("{}", "=".repeat(60));
    println!("  Listening on   http://{}", addr);
    println!("  Static assets  embedded in binary");
    println!("  Max log buffer {} entries", cli.max_logs);
    println!();
    println!("  POST logs to   http://{}/api/log", addr);
    println!("{}", "=".repeat(60));

    info!("Binding to {}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");

    axum::serve(listener, router).await.expect("Server error");
}
