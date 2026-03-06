use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, sync::Mutex};

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
