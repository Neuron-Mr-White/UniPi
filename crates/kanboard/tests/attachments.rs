//! Attachments: CLI attach + list, HTTP upload/serve, safe headers, traversal,
//! size limit, and the `attachments` field on task JSON.

mod common;

use common::{Daemon, Fixture, cli, http, http_bytes};
use kanboard::model::{Priority, Status};

const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

fn header(headers: &[(String, String)], name: &str) -> String {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
        .unwrap_or_default()
}

#[test]
fn cli_attach_stores_the_file_and_logs_a_comment_that_embeds_it() {
    let fixture = Fixture::new();
    let task = fixture.add_with("with a screenshot", Status::Todo, Priority::None, &[]);
    let file = fixture.root().join("Screen Shot 1.png");
    std::fs::write(&file, PNG).unwrap();

    let out = cli(
        &fixture,
        &[
            "attach",
            &task.id,
            file.to_str().unwrap(),
            "--note",
            "the broken header",
            "--json",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let payload: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let attachment = &payload["attachment"];
    assert_eq!(attachment["kind"], "image");
    assert_eq!(attachment["mime"], "image/png");
    assert_eq!(attachment["original"], "Screen-Shot-1.png");
    let reference = attachment["ref"].as_str().unwrap();
    assert!(
        reference.starts_with(&format!("att:{}/", task.id)),
        "{reference}"
    );
    assert_eq!(
        attachment["markdown"],
        format!("![Screen-Shot-1.png]({reference})")
    );
    assert_eq!(
        std::fs::read(attachment["path"].as_str().unwrap()).unwrap(),
        PNG
    );

    // The comment carries the note and the embed, and survives the file round-trip.
    let last = payload["activity"].as_array().unwrap().last().unwrap()["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        last,
        format!("the broken header\n![Screen-Shot-1.png]({reference})")
    );
    let reread = fixture
        .tasks()
        .into_iter()
        .find(|t| t.id == task.id)
        .unwrap();
    assert_eq!(reread.activity.last().unwrap().text, last);
    assert_eq!(payload["attachments"].as_array().unwrap().len(), 1);

    // Attaching identical bytes again reuses the stored file.
    let again = cli(
        &fixture,
        &["attach", &task.id, file.to_str().unwrap(), "--json"],
    );
    assert!(again.status.success());
    let listed = cli(&fixture, &["attachments", &task.id, "--json"]);
    let items: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
    assert_eq!(
        items.as_array().unwrap().len(),
        1,
        "same content is stored once"
    );

    // validate stays clean with a multi-line attachment comment.
    let validate = cli(&fixture, &["validate"]);
    assert!(
        validate.status.success(),
        "{}",
        String::from_utf8_lossy(&validate.stdout)
    );
}

#[test]
fn http_upload_then_serve_with_safe_headers() {
    let fixture = Fixture::new();
    let task = fixture.add_with("upload target", Status::Todo, Priority::None, &[]);
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    let (status, _, body) = http_bytes(
        daemon.port,
        "POST",
        &format!(
            "/api/tasks/{slug}/{}/attachments?name=crash%20log.txt",
            task.id
        ),
        b"panic at line 42\n",
        &[],
    )
    .unwrap();
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let uploaded: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(uploaded["kind"], "text");
    assert_eq!(
        uploaded["markdown"],
        format!("[crash-log.txt]({})", uploaded["ref"].as_str().unwrap())
    );

    // Upload alone logs nothing — the UI posts the comment separately.
    let shown = http(
        daemon.port,
        "GET",
        &format!("/api/tasks/{slug}/{}", task.id),
        None,
    )
    .unwrap()
    .json();
    assert!(
        !shown["activity"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["text"].as_str().unwrap_or("").contains("att:"))
    );
    assert_eq!(shown["attachments"].as_array().unwrap().len(), 1);

    let name = uploaded["name"].as_str().unwrap();
    let (status, headers, bytes) = http_bytes(
        daemon.port,
        "GET",
        &format!("/api/files/{slug}/{}/{name}", task.id),
        b"",
        &[],
    )
    .unwrap();
    assert_eq!(status, 200);
    assert_eq!(bytes, b"panic at line 42\n");
    assert_eq!(
        header(&headers, "content-type"),
        "text/plain; charset=utf-8"
    );
    assert_eq!(header(&headers, "x-content-type-options"), "nosniff");
    assert!(header(&headers, "content-security-policy").contains("sandbox"));
    assert!(header(&headers, "content-disposition").starts_with("inline"));

    // An HTML upload is never served as HTML.
    let (_, _, body) = http_bytes(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/attachments?name=evil.html", task.id),
        b"<script>alert(1)</script>",
        &[],
    )
    .unwrap();
    let evil: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(evil["kind"], "file");
    let (_, headers, _) = http_bytes(
        daemon.port,
        "GET",
        &format!(
            "/api/files/{slug}/{}/{}",
            task.id,
            evil["name"].as_str().unwrap()
        ),
        b"",
        &[],
    )
    .unwrap();
    assert!(header(&headers, "content-disposition").starts_with("attachment"));
    assert!(header(&headers, "content-security-policy").contains("sandbox"));
}

#[test]
fn traversal_unknown_task_and_oversize_are_refused() {
    let fixture = Fixture::new();
    let task = fixture.add_with("guarded", Status::Todo, Priority::None, &[]);
    let daemon = Daemon::start(&fixture, &["--idle-secs", "120"]);
    let slug = &fixture.project.slug;

    for path in [
        format!("/api/files/{slug}/{}/..%2F..%2Fproject.json", task.id),
        format!("/api/files/{slug}/..%2F{}/x", task.id),
        format!("/api/files/{slug}/{}/.hidden", task.id),
        format!("/api/files/nope/{}/x", task.id),
    ] {
        let (status, _, _) = http_bytes(daemon.port, "GET", &path, b"", &[]).unwrap();
        assert_eq!(status, 404, "{path}");
    }

    let (status, _, _) = http_bytes(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/NOPE-1/attachments?name=a.txt"),
        b"x",
        &[],
    )
    .unwrap();
    assert_eq!(status, 404);

    let big = vec![0u8; kanboard::attachments::MAX_BYTES + 4096];
    let (status, _, _) = http_bytes(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/attachments?name=big.bin", task.id),
        &big,
        &[],
    )
    .unwrap();
    assert!(
        status == 413 || status == 0,
        "oversized upload refused (got {status})"
    );

    // Cross-site uploads are refused like every other POST.
    let (status, _, _) = http_bytes(
        daemon.port,
        "POST",
        &format!("/api/tasks/{slug}/{}/attachments?name=a.txt", task.id),
        b"x",
        &[("origin", "https://evil.example")],
    )
    .unwrap();
    assert_eq!(status, 403);
}

#[test]
fn remote_bind_requires_the_token_for_files() {
    let fixture = Fixture::new();
    let task = fixture.add_with("remote", Status::Todo, Priority::None, &[]);
    let file = fixture.root().join("a.png");
    std::fs::write(&file, PNG).unwrap();
    let out = cli(
        &fixture,
        &["attach", &task.id, file.to_str().unwrap(), "--json"],
    );
    let payload: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let name = payload["attachment"]["name"].as_str().unwrap().to_string();

    let daemon = Daemon::start(&fixture, &["--idle-secs", "120", "--host", "0.0.0.0"]);
    let path = format!("/api/files/{}/{}/{name}", fixture.project.slug, task.id);
    let (status, _, _) = http_bytes(daemon.port, "GET", &path, b"", &[]).unwrap();
    assert_eq!(status, 401);
    let info: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture.layout.home.join("daemon.json")).unwrap(),
    )
    .unwrap();
    let auth = format!("Bearer {}", info["token"].as_str().unwrap());
    let (status, _, bytes) =
        http_bytes(daemon.port, "GET", &path, b"", &[("authorization", &auth)]).unwrap();
    assert_eq!(status, 200);
    assert_eq!(bytes, PNG);
}
