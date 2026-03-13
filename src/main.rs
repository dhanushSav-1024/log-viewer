use std::{net::SocketAddr, sync::Arc};

use chrono::Local;
use log::warn;
use log_view::{
    AppState, IncomingLog, LogEntry, LogsResponse, StatusResponse, StatusResponseLoging,
};
use rust_embed::RustEmbed;

use axum::response::sse::{Event, KeepAlive, Sse};
use axum::{
    Router,
    extract::State,
    http::{Method, StatusCode, Uri, header},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
};
use std::convert::Infallible;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
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
            let bytes: Vec<u8> = file.data.into_owned();
            (StatusCode::OK, [(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        None => match StaticAssets::get("index.html") {
            Some(file) => {
                let bytes: Vec<u8> = file.data.into_owned();
                (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "text/html; charset=utf-8".to_string())],
                    bytes,
                )
                    .into_response()
            }
            None => (StatusCode::NOT_FOUND, "404 — not found").into_response(),
        },
    }
}

type SharedState = Arc<AppState>;
async fn sse_logs(
    State(state): State<SharedState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| {
        match msg {
            Ok(entry) => {
                let json = serde_json::to_string(&entry).unwrap_or_default();
                Some(Ok(Event::default().data(json)))
            }
            Err(_) => None, // lagged, skip
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}
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

async fn sender_status(State(state): State<SharedState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "connected": state.is_sender_connected()
    }))
}

async fn change_logging(State(state): State<SharedState>) -> impl IntoResponse {
    let new_logging = state.toggle_logging();
    (
        StatusCode::OK,
        Json(StatusResponseLoging {
            status: "success",
            logging: new_logging,
        }),
    )
}

async fn logging_status(State(state): State<SharedState>) -> impl IntoResponse {
    let logging = state.options.lock().unwrap().logging;
    (
        StatusCode::OK,
        Json(serde_json::json!({ "logging": logging })),
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

fn build_router(state: SharedState, tcp_mode: bool) -> Router {
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any)
        .allow_origin(Any);

    let mut api = Router::new()
        .route("/logs", get(handle_get_logs))
        .route("/stream", get(sse_logs))
        .route("/clear", post(handle_clear))
        .route("/change_logging", post(change_logging))
        .route("/logging_status", get(logging_status))
        .route("/sender_status", get(sender_status))
        .fallback(handle_not_found);

    if tcp_mode {
        api = api.route("/log", post(handle_post_log));
    }

    Router::new()
        .nest("/api", api.with_state(state))
        .fallback(serve_static)
        .layer(cors)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let state = Arc::new(AppState::new());

    let state_watch = Arc::clone(&state);
    tokio::spawn(async move {
        let mut was_connected = false;
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
            let now_connected = state_watch.is_sender_connected();
            if was_connected && !now_connected {
                warn!("[SENDER] disconnected");
            }
            was_connected = now_connected;
        }
    });

    let (host, port, max_logs, udp_port) = {
        let opts = state.options.lock().expect("options poisoned");
        (opts.host.clone(), opts.port, opts.max_logs, opts.udp_port)
    };

    if let Some(udp_port) = udp_port {
        let udp_addr = format!("{}:{}", host, udp_port);
        let state_udp = Arc::clone(&state);

        tokio::spawn(async move {
            let socket = tokio::net::UdpSocket::bind(&udp_addr)
                .await
                .expect("Failed to bind UDP socket");

            info!("UDP listener on {}", udp_addr);
            println!("  UDP logs at    udp://{}", udp_addr);

            let mut buf = vec![0u8; 65_535];
            loop {
                match socket.recv_from(&mut buf).await {
                    Err(e) => {
                        warn!("[UDP] recv error: {e}");
                    }
                    Ok((len, peer)) => {
                        let slice = &buf[..len];
                        match serde_json::from_slice::<IncomingLog>(slice) {
                            Err(e) => {
                                warn!("[UDP] bad JSON from {peer}: {e}");
                            }
                            Ok(incoming) => {
                                let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                                let lineno = match &incoming.lineno {
                                    Some(serde_json::Value::Number(n)) => n.to_string(),
                                    Some(serde_json::Value::String(s)) => s.clone(),
                                    _ => String::new(),
                                };
                                let entry = LogEntry {
                                    time: incoming.time.unwrap_or(now),
                                    level: incoming.level.unwrap_or_else(|| "INFO".into()),
                                    message: incoming.message.unwrap_or_default(),
                                    logger: incoming.logger.unwrap_or_default(),
                                    filename: incoming.filename.unwrap_or_default(),
                                    lineno,
                                };
                                state_udp.push(entry);
                            }
                        }
                    }
                }
            }
        });
    }

    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .expect("Invalid --ip / --port combination");

    let router = build_router(state, udp_port.is_none());

    println!("{}", "=".repeat(60));
    println!("  log-view — Log Viewer Server");
    println!("{}", "=".repeat(60));
    println!("  Listening on   http://{}", addr);
    println!("  Static assets  embedded in binary");
    println!("  Max log buffer {} entries", max_logs);
    println!();
    println!("  POST logs to   http://{}/api/log", addr);
    println!("{}", "=".repeat(60));

    info!("Binding to {}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");

    axum::serve(listener, router).await.expect("Server error");
}
