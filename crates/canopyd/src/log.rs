use std::io::Write as _;
use std::time::{SystemTime, UNIX_EPOCH};

use canopy_protocol::json::write_json_string;

/// JSON lines on standard error, in the shape of the TypeScript servers' logger: `level`, `time`, `msg` and
/// fields.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Log {
    level: u8,
}

fn rank(level: &str) -> u8 {
    match level {
        "debug" => 0,
        "info" => 1,
        "warn" => 2,
        "error" => 3,
        _ => 4,
    }
}

impl Log {
    pub(crate) fn new(level: &str) -> Log {
        Log { level: rank(level).min(3) }
    }

    fn write(self, level: &str, message: &str, fields: &[(&str, &str)]) {
        if rank(level) < self.level {
            return;
        }
        let time = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
        let mut line = String::from("{\"level\":");
        write_json_string(&mut line, level);
        line.push_str(",\"time\":");
        line.push_str(&time.to_string());
        line.push_str(",\"msg\":");
        write_json_string(&mut line, message);
        for (key, value) in fields {
            line.push(',');
            write_json_string(&mut line, key);
            line.push(':');
            write_json_string(&mut line, value);
        }
        line.push_str("}\n");
        let _ = std::io::stderr().lock().write_all(line.as_bytes());
    }

    pub(crate) fn info(self, message: &str, fields: &[(&str, &str)]) {
        self.write("info", message, fields);
    }

    pub(crate) fn warn(self, message: &str, fields: &[(&str, &str)]) {
        self.write("warn", message, fields);
    }

    pub(crate) fn admin_failure(self, path: Option<&str>, code: canopy_protocol::ErrorCode) {
        let path = path.map_or_else(|| "/admin/v1".to_owned(), |path| format!("/admin/v1/{path}"));
        self.error("admin request failed", &[("path", &path), ("code", code.as_str())]);
    }

    pub(crate) fn error(self, message: &str, fields: &[(&str, &str)]) {
        self.write("error", message, fields);
    }
}
