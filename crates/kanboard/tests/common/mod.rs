//! Shared helpers for the kanboard tests.
//!
//! Each integration test binary uses a subset of these helpers, so dead-code
//! analysis across binaries would otherwise flag the rest.
#![allow(dead_code)]

use kanboard::commands::{self, Common};
use kanboard::model::{Actor, ChainGate, Priority, Status, Task};
use kanboard::store::{Layout, Project};
use serde_json::Value;
use std::path::PathBuf;
use tempfile::TempDir;

pub struct Fixture {
    pub _home: TempDir,
    pub _root: TempDir,
    pub layout: Layout,
    pub project: Project,
    pub common: Common,
}

impl Fixture {
    pub fn new() -> Fixture {
        let home = TempDir::new().expect("home");
        let root = TempDir::new().expect("root");
        let layout = Layout::with_home(home.path());
        let project = Project::create(&layout, root.path(), Some("Fixture"), Some("FIX")).expect("project");
        Fixture {
            _home: home,
            _root: root,
            layout,
            project,
            common: Common::new(Actor::User, ChainGate::InReview),
        }
    }

    pub fn root(&self) -> PathBuf {
        self._root.path().to_path_buf()
    }

    pub fn add(&self, title: &str) -> Task {
        self.add_with(title, Status::Backlog, Priority::None, &[])
    }

    pub fn add_with(&self, title: &str, status: Status, priority: Priority, after: &[String]) -> Task {
        let value = commands::add(
            &self.layout,
            self.project.clone(),
            &self.common,
            title,
            Some("body"),
            Some(status),
            priority,
            after,
        )
        .expect("add");
        task_from(&value)
    }

    pub fn tasks(&self) -> Vec<Task> {
        let board = kanboard::board::Board::open(&self.layout, self.project.clone()).expect("board");
        board.tasks().expect("tasks")
    }

    pub fn list_json(&self) -> Value {
        commands::list(&self.layout, self.project.clone(), ChainGate::InReview, None, false).expect("list")
    }

    pub fn move_to(&self, id: &str, to: Status) -> Value {
        commands::move_task(&self.layout, self.project.clone(), &self.common, id, to, None).expect("move")
    }

    pub fn claim_next(&self, session: &str, pid: u32) -> Value {
        let host = commands::hostname();
        let args = commands::ClaimArgs {
            session,
            pid,
            host: &host,
            mode: kanboard::model::RunMode::Direct,
        };
        commands::claim_next(
            &self.layout,
            self.project.clone(),
            ChainGate::InReview,
            &args,
            self.common.now,
        )
        .expect("claim")
    }
}

pub fn task_from(value: &Value) -> Task {
    serde_json::from_value(value.clone()).expect("task json")
}

pub fn id_of(value: &Value) -> String {
    value
        .get("id")
        .and_then(|id| id.as_str())
        .expect("id in payload")
        .to_string()
}

pub fn claimed_id(value: &Value) -> Option<String> {
    let task = value.get("task")?;
    if task.is_null() {
        return None;
    }
    task.get("id")?.as_str().map(|id| id.to_string())
}

pub fn write_task_file(fixture: &Fixture, name: &str, contents: &str) -> PathBuf {
    let dir = fixture.layout.tasks_dir(&fixture.project.slug);
    std::fs::create_dir_all(&dir).expect("tasks dir");
    let path = dir.join(format!("{name}.md"));
    std::fs::write(&path, contents).expect("write task");
    path
}

pub const VALID_TASK: &str = "---
id: FIX-900
title: Hand written
status: todo
priority: none
order: 1000
deps: []
labels: []
created: 2026-09-24T10:00:00Z
updated: 2026-09-24T10:00:00Z
run:
---

Body text.

## Activity
- 2026-09-24T10:00:00Z [user] created
";

// ─── daemon + HTTP helpers (used by tests/daemon.rs) ────────────────────────

use serde_json::Value as JsonValue;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_unipi-kanboard")
}

/// Run the CLI against this fixture's home.
pub fn cli(fixture: &Fixture, args: &[&str]) -> std::process::Output {
    Command::new(bin())
        .args(args)
        .env("UNIPI_KANBOARD_HOME", fixture.layout.home.as_os_str())
        .env("UNIPI_KANBOARD_PROJECT", &fixture.project.slug)
        .current_dir(fixture.root())
        .output()
        .expect("run unipi-kanboard")
}

/// A `serve` child process pointed at this fixture's home.
pub struct Daemon {
    pub child: Child,
    pub port: u16,
}

impl Daemon {
    /// Spawn `serve` and wait until `/api/health` answers.
    pub fn start(fixture: &Fixture, extra: &[&str]) -> Daemon {
        let mut args = vec!["serve", "--port", "0"];
        args.extend_from_slice(extra);
        let child = Command::new(bin())
            .args(&args)
            .env("UNIPI_KANBOARD_HOME", fixture.layout.home.as_os_str())
            .env("UNIPI_KANBOARD_PROJECT", &fixture.project.slug)
            .current_dir(fixture.root())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn serve");

        let deadline = Instant::now() + Duration::from_secs(20);
        let info_path = fixture.layout.home.join("daemon.json");
        let mut child = child;
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(&info_path)
                && let Ok(info) = serde_json::from_str::<JsonValue>(&text)
                && let Some(port) = info.get("port").and_then(|port| port.as_u64())
            {
                let port = port as u16;
                // A remote bind is token-gated: the health probe needs it too.
                let token = info.get("token").and_then(|token| token.as_str()).unwrap_or("");
                let auth = format!("Bearer {token}");
                let extra: Vec<(&str, &str)> =
                    if token.is_empty() { Vec::new() } else { vec![("authorization", &auth)] };
                if let Ok(response) = http_with_headers(port, "GET", "/api/health", None, &extra)
                    && response.status == 200
                {
                    return Daemon { child, port };
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        panic!("daemon did not become healthy");
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    /// Raw response headers, lower-cased names.
    pub headers: Vec<(String, String)>,
}

/// A response header by (lower-case) name.
pub fn response_header(response: &HttpResponse, name: &str) -> Option<String> {
    response
        .headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
}

impl HttpResponse {
    pub fn json(&self) -> JsonValue {
        serde_json::from_str(&self.body).unwrap_or(JsonValue::Null)
    }
}

/// Minimal HTTP/1.1 client: one request, `Connection: close`, read to EOF.
pub fn http(port: u16, method: &str, path: &str, body: Option<&str>) -> std::io::Result<HttpResponse> {
    http_with_headers(port, method, path, body, &[])
}

/// Same, with extra request headers.
pub fn http_with_headers(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    extra: &[(&str, &str)],
) -> std::io::Result<HttpResponse> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let payload = body.unwrap_or("");
    let mut headers = String::new();
    for (name, value) in extra {
        headers.push_str(&format!("{name}: {value}\r\n"));
    }
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\
         content-type: application/json\r\ncontent-length: {}\r\n{headers}\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes())?;
    stream.flush()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let head = text.split_once("\r\n\r\n").map(|(head, _)| head).unwrap_or("");
    let headers: Vec<(String, String)> = head
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    Ok(HttpResponse { status, body, headers })
}

/// Read SSE frames for `seconds`, returning the raw lines that arrived.
pub fn read_sse(port: u16, path: &str, seconds: u64) -> Vec<String> {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return Vec::new();
    };
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return Vec::new();
    }
    let _ = stream.flush();
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut lines = Vec::new();
    let mut buffer = String::new();
    while Instant::now() < deadline {
        buffer.clear();
        match reader.read_line(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {
                let line = buffer.trim_end().to_string();
                if !line.is_empty() {
                    lines.push(line);
                }
            }
            Err(_) => continue,
        }
    }
    lines
}
