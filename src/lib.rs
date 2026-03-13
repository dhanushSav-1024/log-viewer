use clap::Parser;
use log::info;
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, io::Write, path::PathBuf, sync::Mutex, time::Instant};
use tokio::sync::broadcast;

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
    pub lineno: Option<serde_json::Value>,
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
#[derive(Serialize)]
pub struct StatusResponseLoging {
    pub status: &'static str,
    pub logging: bool,
}

#[derive(Parser, Debug)]
#[command(name = "log-view", about = "log-view — Log Viewer Server", version)]
pub struct Cli {
    #[arg(short = 'i', long = "ip", default_value = "0.0.0.0")]
    pub host: String,
    #[arg(short = 'p', long = "port", default_value_t = 8080)]
    pub port: u16,
    #[arg(short = 'm', long = "max-logs", default_value_t = 1000)]
    pub max_logs: usize,
    /// store loges in /home/user/logeg
    #[arg(short = 'l', long = "logging", default_value_t = false)]
    pub logging: bool,
    /// Listen for log entries over UDP on this port (e.g. -u 9000)
    #[arg(short = 'u', long = "udp-port")]
    pub udp_port: Option<u16>,
}

#[derive(Debug)]
pub struct AppState {
    pub logs: Mutex<VecDeque<LogEntry>>,
    pub options: Mutex<Cli>,
    pub log_file: Mutex<Option<std::fs::File>>,
    pub last_seen: Mutex<Option<Instant>>,
    pub tx: broadcast::Sender<LogEntry>,
}

impl AppState {
    pub fn new() -> Self {
        let options = Cli::parse();
        let log_file = if options.logging {
            Some(Self::create_log_file())
        } else {
            None
        };
        let (tx, _) = broadcast::channel(256); // ← add
        Self {
            logs: Mutex::new(VecDeque::with_capacity(options.max_logs)),
            options: Mutex::new(options),
            log_file: Mutex::new(log_file),
            last_seen: Mutex::new(None),
            tx,
        }
    }

    pub fn touch(&self) {
        *self.last_seen.lock().expect("last_seen poisoned") = Some(Instant::now());
    }

    pub fn is_sender_connected(&self) -> bool {
        match *self.last_seen.lock().expect("last_seen poisoned") {
            Some(t) => t.elapsed().as_secs() < 5,
            None => false,
        }
    }

    fn create_log_file() -> std::fs::File {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let dir = PathBuf::from(home).join("log-view");
        std::fs::create_dir_all(&dir).expect("failed to create log dir");
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let path = dir.join(format!("logs-{}.log", timestamp));
        info!("Log file: {}", path.display());
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("failed to open log file")
    }

    pub fn push(&self, entry: LogEntry) {
        let was_connected = self.is_sender_connected();
        self.touch();
        if !was_connected {
            info!("[LOGGER] connected");
        }
        let max = self.options.lock().expect("options poisoned").max_logs;
        let mut guard = self.logs.lock().expect("logs poisoned");
        guard.push_back(entry.clone());
        while guard.len() > max {
            guard.pop_front();
        }
        if let Ok(mut file_guard) = self.log_file.lock() {
            if let Some(ref mut file) = *file_guard {
                if let Some(last) = guard.back() {
                    let _ = writeln!(file, "{}", last.message);
                }
            }
        }
        let _ = self.tx.send(entry);
    }

    pub fn toggle_logging(&self) -> bool {
        let mut options = self.options.lock().expect("options poisoned");
        options.logging = !options.logging;
        let enabled = options.logging;
        drop(options); // release before locking file

        let mut file_guard = self.log_file.lock().expect("file poisoned");
        if enabled {
            *file_guard = Some(Self::create_log_file());
        } else {
            *file_guard = None; // closes the file
        }
        enabled
    }

    pub fn snapshot(&self) -> Vec<LogEntry> {
        let guard = self.logs.lock().expect("log mutex poisoned");
        guard.iter().rev().cloned().collect()
    }

    pub fn clear(&self) {
        let mut guard = self.logs.lock().expect("log mutex poisoned");
        guard.clear();
    }
}
