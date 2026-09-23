//! Errors. Rule violations name the rule that was broken so the message can be
//! shown to a human or an agent verbatim.

use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A storage/transition/format rule was violated (exit code 1).
    #[error("{0}")]
    Rule(String),
    /// Bad invocation that clap cannot catch (exit code 2).
    #[error("{0}")]
    Usage(String),
    /// Something expected is missing (exit code 1).
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Yaml(String),
    #[error("{0}")]
    Json(String),
    #[error("{0}")]
    Io(String),
}

impl Error {
    pub fn rule(message: impl Into<String>) -> Self {
        Error::Rule(message.into())
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Error::Usage(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Error::NotFound(message.into())
    }

    pub fn exit_code(&self) -> i32 {
        match self {
            Error::Usage(_) => 2,
            _ => 1,
        }
    }

    pub fn is_rule(&self) -> bool {
        matches!(self, Error::Rule(_) | Error::NotFound(_))
    }
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::Io(err.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(err: serde_json::Error) -> Self {
        Error::Json(err.to_string())
    }
}

impl From<serde_norway::Error> for Error {
    fn from(err: serde_norway::Error) -> Self {
        Error::Yaml(err.to_string())
    }
}

/// A validation problem with a 1-based line number inside a task file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub file: String,
    pub line: usize,
    pub message: String,
    pub fixable: bool,
}

impl Problem {
    pub fn new(file: impl fmt::Display, line: usize, message: impl Into<String>) -> Self {
        Problem {
            file: file.to_string(),
            line,
            message: message.into(),
            fixable: false,
        }
    }

    pub fn fixable(mut self, fixable: bool) -> Self {
        self.fixable = fixable;
        self
    }
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {}", self.file, self.line, self.message)
    }
}
